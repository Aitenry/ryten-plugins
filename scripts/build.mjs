/**
 * 把 `plugins/<id>/` 打成可分发的插件包，并生成插件索引 `plugins.json`。
 *
 * 产物（每个插件一个目录 + 一个 zip）：
 *
 *   dist/<id>/plugin.json     清单（由 `manifest.ts` 生成，单一真源）
 *   dist/<id>/main.cjs        主进程入口（CJS，`install(ctx)` 契约）
 *   dist/<id>/renderer.mjs    渲染层入口（ESM，blob import 加载）
 *   dist/<id>/chunk-*.mjs     渲染层按需 chunk（懒加载视图等）
 *   dist/<id>-<version>.zip   上面这些文件打成一个 zip（GitHub Release 资产）
 *   plugins.json              索引：id / 名称 / 版本 / 资产名 / sha256（应用据此下载安装）
 *
 * 关键约束（宿主契约见 RytenBench 的 `src/plugins/PACKAGING.md`）：
 * - **宿主能力一律经宿主运行时取**：源码里的 `@host/main/**`、`@host/shared/**`、
 *   `@host/renderer/**`、`@host/vendor/**` 在打包时被解析成**虚拟模块**——
 *   主进程是 `globalThis.__RB_HOST_RESOLVE__(spec)`，渲染层是 `plugin://host/ui.js?m=<key>` 桥。
 *   插件包因此**不带**宿主模块的第二份实例（PGlite / React / antd / i18n 都是宿主那一份）。
 * - **第三方裸模块**（react/antd/drizzle-orm/langchain…）在主进程侧也交给宿主运行时
 *   （宿主按应用根解析，拿同一实例）；渲染层侧只有 vendor 名单走桥，其余打进包。
 * - Node 内置模块保持 external，运行期由 Node 自己解析。
 * - 渲染层是**多文件**产物：入口 + 按需 chunk，懒加载才不会被内联进入口。
 *
 * 跑法：
 *   node scripts/build.mjs                    # 全部插件，正式产物
 *   node scripts/build.mjs --plugin music     # 只打一个
 *   node scripts/build.mjs --dev              # 不压缩 + inline sourcemap（本地调试）
 *   node scripts/build.mjs --tag v0.1.0       # 同时把 tag 写进 plugins.json（发布用）
 */
import { build } from 'esbuild'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { builtinModules } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = join(ROOT, 'plugins')
const DIST_DIR = join(ROOT, 'dist')

const args = process.argv.slice(2)
const onlyIndex = args.indexOf('--plugin')
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null
const tagIndex = args.indexOf('--tag')
const tag = tagIndex >= 0 ? args[tagIndex + 1] : null
const isDev = args.includes('--dev')

/** 插件 id：`plugins/` 下有 `manifest.ts` 的目录 */
function pluginIds() {
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(PLUGINS_DIR, e.name, 'manifest.ts')))
    .map((e) => e.name)
}

/** 渲染层走宿主 UI 桥的第三方 vendor（必须与宿主 host-ui.ts 的表一致） */
const RENDERER_VENDOR = [
  'react',
  'react-dom',
  'antd',
  '@remixicon/react',
  '@ant-design/icons',
  'dayjs'
]

/** Node 内置模块（含 `node:` 前缀）：保持 external */
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  'node:test',
  'node:sea',
  'node:sqlite'
])

const HOST_MODULE_NS = 'host-runtime'
const cjsHostModule = (spec) =>
  `module.exports = globalThis.__RB_HOST_RESOLVE__(${JSON.stringify(spec)});\n`
const esmHostModule = (spec) => {
  const url = `plugin://host/ui.js?m=${encodeURIComponent(spec)}`
  return (
    `import * as __hostNs from ${JSON.stringify(url)};\n` +
    `export * from ${JSON.stringify(url)};\n` +
    `export default __hostNs.default ?? __hostNs;\n`
  )
}

const isAbsoluteSpec = (spec) => /^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith('/')
const isBare = (spec) => !spec.startsWith('.') && !isAbsoluteSpec(spec) && !spec.startsWith('@host/')

/**
 * 解析插件里的导入：
 * - `@host/**`（宿主运行时 / 宿主 UI 桥 / vendor）→ 虚拟模块，运行期由宿主注入；
 * - 插件内部相对导入 → 打进包；
 * - 其它裸模块：主进程侧交给宿主运行时；渲染层侧只把 vendor 名单换成桥，其余打进包；
 * - `node:*` / Node 内置 → external。
 */
const hostRuntimePlugin = (side) => ({
  name: 'host-runtime',
  setup(build_) {
    build_.onResolve({ filter: /.*/ }, (args_) => {
      const spec = args_.path

      if (NODE_BUILTINS.has(spec)) return { path: spec, external: true }
      if (spec.startsWith('plugin://')) return { path: spec, external: true }
      if (spec.startsWith('@host/')) return { path: spec, namespace: HOST_MODULE_NS }

      if (isBare(spec)) {
        if (side === 'renderer') {
          if (!RENDERER_VENDOR.some((v) => spec === v || spec.startsWith(v + '/'))) return null
          return { path: `@host/vendor/${spec}`, namespace: HOST_MODULE_NS }
        }
        // 主进程：spec 原样交给宿主运行时（宿主按应用根解析，拿同一实例）
        return { path: spec, namespace: HOST_MODULE_NS }
      }

      return null // 插件自己的代码：正常打进包
    })

    build_.onLoad({ filter: /.*/, namespace: HOST_MODULE_NS }, (args_) => ({
      contents: side === 'renderer' ? esmHostModule(args_.path) : cjsHostModule(args_.path),
      loader: 'js'
    }))
  }
})

/**
 * 把多文件渲染产物里的相对说明符绝对化成 `plugin://<id>/<文件>`。
 *
 * 宿主的渲染入口是 `fetch` 下来再以 **blob URL** import 的：blob 模块没有可用的相对基准，
 * `./chunk-x.mjs` 会被解析成 `blob:…/chunk-x.mjs` 而取不到。
 */
function absolutizeChunkSpecifiers(id, outDir) {
  const emitted = new Set(readdirSync(outDir).filter((f) => f.endsWith('.mjs')))
  const REL_SPEC = /(\bfrom\s*|\bimport\s*\(\s*|(?:^|[;}\n])\s*import\s*)(['"])(\.{1,2}\/[^'"]+)\2/gm
  let count = 0
  for (const file of emitted) {
    const full = join(outDir, file)
    const source = readFileSync(full, 'utf-8')
    const next = source.replace(REL_SPEC, (whole, prefix, quote, spec) => {
      const target = relative(outDir, resolve(dirname(full), spec)).replace(/\\/g, '/')
      if (!emitted.has(target)) return whole
      count += 1
      return `${prefix}${quote}plugin://${id}/${target}${quote}`
    })
    if (next !== source) writeFileSync(full, next)
  }
  return count
}

/** 由 manifest.ts 生成 plugin.json（单一真源） */
async function emitManifest(id, outDir) {
  const entry = join(PLUGINS_DIR, id, 'manifest.ts')
  const built = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
  const code = built.outputFiles[0].text
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  const mod = await import(dataUrl)
  const manifest = mod.default ?? mod[Object.keys(mod)[0]]
  const json = { ...manifest, entry: { renderer: 'renderer.mjs', main: 'main.cjs' } }
  writeFileSync(join(outDir, 'plugin.json'), JSON.stringify(json, null, 2) + '\n')
  return json
}

/**
 * 编译**插件自己的样式表** `plugin.css`（渲染层用到的 Tailwind 工具类）。
 *
 * 为什么插件必须自带 CSS（2026-09-26 用户反馈「装进应用后内容都变形了」）：
 * 宿主自己的 Tailwind 是**构建期**扫源码生成的，只覆盖随应用分发的内置插件
 * （`src/plugins/**`）。运行期才装进 `userData/plugins/<id>/` 的外部插件源码不在它的
 * 扫描范围里——实测 task-planner / music-player 用到的 124 个类名里 49 个没有规则，
 * `w-[280px]` / `grid-cols-2` / `bottom-full` / `hover:scale-105` 这些布局关键类全缺。
 * 宿主装载插件时会把 `plugin://<id>/plugin.css` 注入 `<head>`（见 RytenBench 的
 * `plugin-host/plugin-css.ts`），所以插件只需要把这份 CSS 打进包。
 *
 * 只取 `theme` + `utilities` 两层，**不含 preflight**：注入到宿主文档里的 base 层
 * 会把宿主的全局样式重置掉（那是宿主自己的事）。
 */
function buildPluginCss(id, outDir) {
  const rendererDir = join(PLUGINS_DIR, id, 'renderer')
  if (!existsSync(rendererDir)) return 0
  const cli = join(ROOT, 'node_modules', '@tailwindcss', 'cli', 'dist', 'index.mjs')
  if (!existsSync(cli)) {
    throw new Error('找不到 @tailwindcss/cli：先跑 npm install（插件自带的 plugin.css 由它编译）')
  }
  const tmpDir = mkdtempSync(join(DIST_DIR, '.css-entry-'))
  const entryCss = join(tmpDir, 'entry.css')
  const out = join(outDir, 'plugin.css')
  writeFileSync(
    entryCss,
    [
      '/* 由 scripts/build.mjs 现写现编：只取 theme + utilities，不含 preflight */',
      "@import 'tailwindcss/theme.css' layer(theme);",
      // source(none) 很关键：否则 Tailwind 会**自动扫描整个项目**（入口文件落在 dist/ 里，
      // 自动检测一路走到仓库根），两个插件会得到同一份「全集」CSS（实测两份 sha256 完全一致）
      "@import 'tailwindcss/utilities.css' layer(utilities) source(none);",
      // 只扫这个插件自己的渲染层源码（绝对路径 + 正斜杠：临时入口不在插件目录里）
      `@source ${JSON.stringify(rendererDir.replace(/\\/g, '/'))};`,
      ''
    ].join('\n')
  )
  const res = spawnSync(process.execPath, [cli, '-i', entryCss, '-o', out, '--minify'], {
    cwd: ROOT,
    encoding: 'utf-8'
  })
  rmSync(tmpDir, { recursive: true, force: true })
  if (res.status !== 0) {
    throw new Error(`Tailwind 编译 plugin.css 失败：${res.stderr || res.stdout || res.error}`)
  }
  return statSync(out).size
}

async function buildPlugin(id) {
  const srcDir = join(PLUGINS_DIR, id)
  const outDir = join(DIST_DIR, id)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const manifest = await emitManifest(id, outDir)

  const mainEntry = join(srcDir, 'main/index.ts')
  if (existsSync(mainEntry)) {
    await build({
      entryPoints: [mainEntry],
      outfile: join(outDir, 'main.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      plugins: [hostRuntimePlugin('main')],
      minify: !isDev,
      sourcemap: isDev ? 'inline' : false,
      logLevel: 'warning'
    })
  }

  const rendererEntry = join(srcDir, 'renderer/plugin.tsx')
  if (existsSync(rendererEntry)) {
    await build({
      entryPoints: { renderer: rendererEntry },
      outdir: outDir,
      entryNames: 'renderer',
      chunkNames: 'chunk-[hash]',
      outExtension: { '.js': '.mjs' },
      bundle: true,
      splitting: true,
      platform: 'browser',
      format: 'esm',
      target: 'chrome120',
      jsx: 'automatic',
      plugins: [hostRuntimePlugin('renderer')],
      loader: { '.css': 'css', '.svg': 'dataurl' },
      minify: !isDev,
      sourcemap: isDev ? 'inline' : false,
      logLevel: 'warning'
    })
    absolutizeChunkSpecifiers(id, outDir)
    buildPluginCss(id, outDir)
  } else {
    // 没有渲染层入口 → 也不需要样式
    buildPluginCss(id, outDir)
  }

  return manifest
}

/**
 * 打 zip（Release 资产）：包内文件在 zip 根目录，解压即可用。
 *
 * **必须是「同样输入 → 同样字节」**（2026-10-08 修）：zip 里每个条目默认带**当前时间**，
 * 于是每次构建的 zip 字节都不同、sha256 也不同。平时看不出来，但一旦同一个 tag 触发了两次
 * 发布（GitHub 的 tag push 事件偶尔会重复/延迟），两次运行会**各传一份资产、各提交一次索引**：
 * 后一次只成功传了资产、卡在提交索引那步失败，索引里留下的是前一次的 sha256，
 * 而 Release 上的资产是后一次的 → 应用按索引下载校验 sha256 **直接失败**（v0.1.13 就是这么坏的）。
 *
 * 固定时间戳（用本地时间构造，免得 CI 的 UTC 与本机 UTC+8 编出不同的 DOS 时间）+
 * 固定文件顺序，让构建可复现：这样无论哪一次运行传的资产，sha256 都对得上索引。
 */
async function zipPlugin(id) {
  const outDir = join(DIST_DIR, id)
  const files = readdirSync(outDir).sort()
  const manifest = JSON.parse(readFileSync(join(outDir, 'plugin.json'), 'utf-8'))
  const fixedDate = new Date(2020, 0, 1, 0, 0, 0)
  const zip = new JSZip()
  for (const file of files) zip.file(file, readFileSync(join(outDir, file)), { date: fixedDate })
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const asset = `${id}-${manifest.version}.zip`
  writeFileSync(join(DIST_DIR, asset), buffer)
  return {
    id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    builtin: false,
    entry: manifest.entry,
    routes: manifest.routes,
    menu: manifest.menu,
    asset,
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex')
  }
}

console.log(`打包插件 → ${relative(ROOT, DIST_DIR)}${isDev ? '（dev：不压缩 + inline sourcemap）' : ''}`)
mkdirSync(DIST_DIR, { recursive: true })
// 全量构建先清干净：插件改名/下线后，旧的 dist/<id>/ 与旧 zip 不该留在产物目录里
if (!only) rmSync(DIST_DIR, { recursive: true, force: true })
mkdirSync(DIST_DIR, { recursive: true })

const ids = only ? [only] : pluginIds()
const index = []
for (const id of ids) {
  try {
    const manifest = await buildPlugin(id)
    const entry = await zipPlugin(id)
    index.push(entry)
    const outDir = join(DIST_DIR, id)
    const chunks = readdirSync(outDir).filter((f) => f.startsWith('chunk-'))
    const size = (f) => (existsSync(join(outDir, f)) ? statSync(join(outDir, f)).size : 0)
    console.log(
      `  ${id.padEnd(8)} v${manifest.version} main=${(size('main.cjs') / 1024).toFixed(1)}KB ` +
        `renderer=${(size('renderer.mjs') / 1024).toFixed(1)}KB chunks=${chunks.length} ` +
        `zip=${(entry.size / 1024).toFixed(1)}KB sha256=${entry.sha256.slice(0, 12)}…`
    )
  } catch (err) {
    console.error(`  ${id} 打包失败：${err.message}`)
    process.exitCode = 1
  }
}

/**
 * 插件索引：应用只认这一份。
 *
 * `plugins.json` 放在仓库根，由发布流程带 tag 生成并提交；应用按里面的
 * `asset` 去 `<repo>/releases/download/<tag>/<asset>` 下载（不需要 GitHub API、不需要 token）。
 */
const indexPath = join(ROOT, 'plugins.json')
const previous = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf-8')) : null
// 全量构建：索引就是本次产物；单插件构建：替换该插件那条，其余沿用上一版索引
const plugins = only
  ? [...(previous?.plugins ?? []).filter((p) => p.id !== only), ...index]
  : index
const indexTag = tag ?? previous?.tag
const payload = { schema: 1, ...(indexTag ? { tag: indexTag } : {}), plugins }
writeFileSync(indexPath, JSON.stringify(payload, null, 2) + '\n')
console.log(
  `  索引已写入 ${relative(ROOT, indexPath)}（${payload.plugins.length} 个插件${payload.tag ? `，tag ${payload.tag}` : ''}）`
)
