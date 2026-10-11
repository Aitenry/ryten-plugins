/**
 * 真机验证（**会真的调一次大模型，花钱**）：拿**真库副本里的真数据**跑一次完整的 AI 画像，
 * 看真模型回的话能不能被解析成结构化画像。
 *
 * 为什么非要跑这一条（假模型工装验不了的三件事）：
 *  1. **提示词对真模型管不管用**——「只回一个 JSON 对象」这条纪律，假模型是照着剧本回的，
 *     真模型可能带围栏、带客套、甚至回一段散文；
 *  2. **它写的东西有没有依据**——材料里给了这个人的真实弹幕原话，提示词要求「引用必须逐字」，
 *     真回话里引用的句子必须真的出现在材料里（幻觉最直观的检验）；
 *  3. **真实的 token 用量**——就是成本：材料多大、回话多大、一次花多少。
 *
 * 全是真代码：真 PGlite（副本）、真 mapper、真证据打包、真解析、真落库；模型走**真的**
 * LangChain ChatModel。只有「宿主那层取供应商配置」的桩是工装写的（真宿主里那一段要 electron
 * 的 app/electron-store 才能解密），它按**和宿主逐字相同的算法**解密 api_key：
 * PBKDF2(`hostname:username:userData`, 'ryten-bench-provider-salt-v1', 600000, 32, sha512)。
 *
 * ⚠️ PGlite 没有跨进程锁：**必须先退出 RytenBench**，然后对**副本**跑：
 *   Copy-Item "$env:APPDATA\ryten-bench\RytenBenchDB" "$env:TEMP\rbdb-copy" -Recurse
 *   node plugins/douyin-link/spike/ai-portrait-live.mjs "$env:TEMP\rbdb-copy"            # 先看清单
 *   node plugins/douyin-link/spike/ai-portrait-live.mjs "$env:TEMP\rbdb-copy" --live     # 真调一次
 *   node plugins/douyin-link/spike/ai-portrait-live.mjs "$env:TEMP\rbdb-copy" --live --user=2450167593701709
 *
 * 不加 `--live` 时**只打印将要发出去的材料**（不调模型、不花钱），用来先看成本。
 */
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../../../')
const PLUGIN = join(HERE, '..')
const HOST_NODE_MODULES = 'E:\\Development-Warehouse\\github\\ryten-bench\\node_modules'

const args = process.argv.slice(2)
const live = args.includes('--live')
const dbDir = (args.find((arg) => !arg.startsWith('--')) ?? process.env.DY_DB_DIR ?? '').replace(/^\/([A-Za-z]:)/, '$1')
const wantUser = (args.find((arg) => arg.startsWith('--user=')) ?? '').replace('--user=', '')
const wantProvider = Number((args.find((arg) => arg.startsWith('--provider=')) ?? '').replace('--provider=', '')) || 0

function resolvePglite() {
  const candidates = [
    process.env.RB_PGLITE,
    join(HOST_NODE_MODULES, '@electric-sql', 'pglite', 'dist', 'index.js')
  ]
  for (const path of candidates) if (path && existsSync(path)) return path
  console.error('找不到 @electric-sql/pglite，可用 RB_PGLITE=<dist/index.js 路径> 指定')
  process.exit(2)
}
const pglitePath = resolvePglite()

if (!dbDir || !existsSync(join(dbDir, 'PG_VERSION'))) {
  console.error('用法：node ai-portrait-live.mjs <PGlite 数据目录副本> [--live] [--user=<id>] [--provider=<id>]')
  process.exit(2)
}

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : `\n       ${detail}`}`)
}
const has = (label, haystack, needle) =>
  check(label, String(haystack).includes(needle), `找不到：${JSON.stringify(needle)}`)

const workDir = mkdtempSync(join(tmpdir(), 'douyin-ai-live-'))
writeFileSync(join(workDir, 'package.json'), '{ "type": "module" }\n', 'utf8')

/* ----------------------------------------------------- 宿主桩：真库 + 真配置 */

writeFileSync(
  join(workDir, 'orm.mjs'),
  `import { drizzle } from 'drizzle-orm/pglite'\n` +
    `import { PGlite } from '@electric-sql/pglite'\n` +
    `let client = null\nlet orm = null\n` +
    `export async function withOrm(_op, fn) {\n` +
    `  if (!client) { client = new PGlite(process.env.DY_PGLITE_DIR); orm = drizzle(client) }\n` +
    `  return fn(orm)\n` +
    `}\n` +
    `export async function rawQuery(sql, params) { return client.query(sql, params) }\n` +
    `export async function closeOrm() { await client.close() }\n`,
  'utf8'
)
writeFileSync(
  join(workDir, 'pglite-shim.mjs'),
  `const mod = await import(process.env.DY_PGLITE_URL)\n` +
    `export const PGlite = mod.PGlite\nexport const types = mod.types\nexport default mod\n`,
  'utf8'
)
/**
 * 宿主的供应商表：**真行**（从真库里 select 出来），api_key 用与宿主同一个算法解密。
 * 只做形状映射（行 → LlmProviderConfig），不做任何编造。
 */
writeFileSync(
  join(workDir, 'provider-mapper.mjs'),
  `export async function getEnabledProviders() {\n` +
    `  return (globalThis.__DY_PROVIDERS__ || []).filter((p) => p.is_enabled)\n` +
    `}\n` +
    `export async function getDefaultProvider() {\n` +
    `  const all = await getEnabledProviders()\n` +
    `  return all.find((p) => p.is_default) ?? null\n` +
    `}\n` +
    `export async function getProviderById(id) { return (await getEnabledProviders()).find((p) => p.id === id) ?? null }\n`,
  'utf8'
)
/**
 * 宿主的模型服务：用**真的 LangChain ChatModel**（宿主也是这么建的：同一套字段）。
 * 只覆盖 openai 兼容 / anthropic / deepseek 三家（真库里的供应商多半就是这几家）。
 */
writeFileSync(
  join(workDir, 'provider-service.mjs'),
  `export function getProviderService() {\n` +
    `  return {\n` +
    `    async createModel(providerId) {\n` +
    `      const all = globalThis.__DY_PROVIDERS__ || []\n` +
    `      const config = all.find((p) => p.id === providerId)\n` +
    `      if (!config) throw new Error('工装：没找到供应商 ' + providerId)\n` +
    `      globalThis.__DY_USED_PROVIDER__ = config.id\n` +
    `      const kind = String(config.provider || '').toLowerCase()\n` +
    `      const base = { model: config.model, apiKey: config.api_key, streaming: true, maxRetries: 0 }\n` +
    `      if (kind === 'anthropic' || (config.extra_config && config.extra_config.api_format === 'anthropic')) {\n` +
    `        const mod = await import(process.env.DY_LANGCHAIN_ANTHROPIC)\n` +
    `        return new mod.ChatAnthropic({ ...base, ...(config.base_url ? { anthropicApiUrl: config.base_url } : {}) })\n` +
    `      }\n` +
    `      const mod = await import(process.env.DY_LANGCHAIN_OPENAI)\n` +
    `      return new mod.ChatOpenAI({ ...base, ...(config.base_url ? { configuration: { baseURL: config.base_url } } : {}) })\n` +
    `    },\n` +
    `    async getConfig(providerId) {\n` +
    `      const config = (globalThis.__DY_PROVIDERS__ || []).find((p) => p.id === providerId)\n` +
    `      if (!config) throw new Error('工装：没找到供应商 ' + providerId)\n` +
    `      return config\n` +
    `    },\n` +
    `    clearCache() {}\n` +
    `  }\n` +
    `}\n`,
  'utf8'
)
writeFileSync(
  join(workDir, 'i18n.mjs'),
  `export function getMainLanguage() { return process.env.DY_LANG || 'zh-CN' }\n` +
    `export function mainFormat(t) { return String(t) }\nexport function mainPlural(o) { return String(o) }\nexport function mainMessages() { return {} }\n`,
  'utf8'
)
writeFileSync(
  join(workDir, 'safe-send.mjs'),
  `export function safeSend(_wc, channel, payload) { globalThis.__DOUYIN_SEND__?.(channel, payload) }\n`,
  'utf8'
)
writeFileSync(
  join(workDir, 'electron.mjs'),
  `export const BrowserWindow = { getAllWindows: () => [{ isDestroyed: () => false, webContents: { id: 1 } }] }\n` +
    `export const app = { getPath: () => process.env.DY_USER_DATA || process.cwd(), isReady: () => true, getAppPath: () => process.cwd() }\n`,
  'utf8'
)
writeFileSync(join(workDir, 'log.mjs'), `export default { info() {}, warn() {}, error() {}, debug() {} }\n`, 'utf8')

const outfile = join(workDir, 'bundle.mjs')
await build({
  stdin: {
    contents:
      `export * as portrait from './portrait'\n` +
      `export { rawQuery, closeOrm } from '@host/main/database/orm'\n`,
    loader: 'ts',
    resolveDir: join(PLUGIN, 'main')
  },
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
  nodePaths: [join(ROOT, 'node_modules')],
  plugins: [
    {
      name: 'douyin-ai-live',
      setup(api) {
        api.onResolve({ filter: /^@host\/main\/database\/orm$/ }, () => ({ path: join(workDir, 'orm.mjs') }))
        api.onResolve({ filter: /^@electric-sql\/pglite$/ }, () => ({ path: join(workDir, 'pglite-shim.mjs') }))
        api.onResolve({ filter: /^@host\/main\/database\/mapper\/provider$/ }, () => ({
          path: join(workDir, 'provider-mapper.mjs')
        }))
        api.onResolve({ filter: /^@host\/main\/provider\/service$/ }, () => ({
          path: join(workDir, 'provider-service.mjs')
        }))
        api.onResolve({ filter: /^@host\/main\/i18n$/ }, () => ({ path: join(workDir, 'i18n.mjs') }))
        api.onResolve({ filter: /^@host\/main\/safe-send$/ }, () => ({ path: join(workDir, 'safe-send.mjs') }))
        api.onResolve({ filter: /^electron$/ }, () => ({ path: join(workDir, 'electron.mjs') }))
        api.onResolve({ filter: /^electron-log$/ }, () => ({ path: join(workDir, 'log.mjs') }))
        return null
      }
    }
  ]
})

process.env.DY_PGLITE_URL = pathToFileURL(pglitePath).href
process.env.DY_PGLITE_DIR = dbDir
process.env.DY_LANGCHAIN_OPENAI = pathToFileURL(join(HOST_NODE_MODULES, '@langchain', 'openai', 'dist', 'index.js')).href
process.env.DY_LANGCHAIN_ANTHROPIC = pathToFileURL(
  join(HOST_NODE_MODULES, '@langchain', 'anthropic', 'dist', 'index.js')
).href

/* ------------------------------------------------------- 真库里的供应商配置 */

/**
 * 与宿主 `src/main/crypto/provider-key.ts` **逐字相同**的密钥派生与解密。
 * 指纹 = `hostname:username:userData`（宿主用 electron 的 app.getPath('userData')，就是 `%APPDATA%\ryten-bench`）。
 */
function decryptApiKey(encryptedBase64, userDataPath) {
  const fingerprint = `${hostname()}:${userInfo().username}:${userDataPath}`
  const key = pbkdf2Sync(fingerprint, 'ryten-bench-provider-salt-v1', 600000, 32, 'sha512')
  const combined = Buffer.from(encryptedBase64, 'base64')
  const iv = combined.subarray(0, 16)
  const authTag = combined.subarray(16, 32)
  const ciphertext = combined.subarray(32)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

const bundle = await import(pathToFileURL(outfile).href)
const { portrait, rawQuery, closeOrm } = bundle
const userDataPath = process.env.APPDATA ? join(process.env.APPDATA, 'ryten-bench') : ''
const rows = (
  await rawQuery(
    `select id, name, provider, base_url, model, api_key_encrypted, is_default, is_enabled, extra_config, max_tokens
     from llm_providers order by sort_order desc, id asc`
  )
).rows

console.log(`真库副本：${dbDir}`)
console.log(`供应商 ${rows.length} 个：`)
globalThis.__DY_PROVIDERS__ = rows.map((row) => {
  let apiKey = ''
  try {
    apiKey = row.api_key_encrypted ? decryptApiKey(row.api_key_encrypted, userDataPath) : ''
  } catch (error) {
    apiKey = ''
    console.log(`  · ${row.id} ${row.name}：**密钥解密失败**（${error.message}）`)
  }
  console.log(
    `  · ${row.id} ${row.name} [${row.provider}] model=${row.model} 密钥=${apiKey ? `已解密(${apiKey.length} 字符)` : '没有/解不开'} 默认=${row.is_default} 启用=${row.is_enabled === false ? '否' : '是'}`
  )
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    base_url: row.base_url,
    model: row.model,
    api_key: apiKey,
    is_default: row.is_default === true,
    is_enabled: row.is_enabled !== false,
    extra_config: row.extra_config ? JSON.parse(row.extra_config) : null,
    max_tokens: row.max_tokens
  }
})

const usable = globalThis.__DY_PROVIDERS__.filter((item) => item.is_enabled && item.api_key)
check('真库里至少有一个可用的供应商（密钥解密成功）', usable.length > 0, `${usable.length} 个可用`)

/** 挑一个供应商：`--provider` 指定 > 宿主默认 > 第一个可用的 */
const chosen = wantProvider
  ? usable.find((item) => item.id === wantProvider)
  : (usable.find((item) => item.is_default) ?? usable[0])
if (!chosen) {
  console.error('没有可用的供应商，退出（--provider=<id> 可以指定）')
  await closeOrm()
  rmSync(workDir, { recursive: true, force: true })
  process.exit(2)
}
console.log(`\n本次用：${chosen.id} ${chosen.name} · ${chosen.model}`)

/* ------------------------------------------------------------------ 挑一个人 */

const top = wantUser
  ? { user_id: wantUser }
  : (
      await rawQuery(
        `select user_id, count(*)::int as n from douyin_link_messages
         where kind = 'chat' and user_id <> '' group by user_id order by n desc limit 1`
      )
    ).rows[0]
if (!top) {
  console.error('真库里没有弹幕记录')
  await closeOrm()
  rmSync(workDir, { recursive: true, force: true })
  process.exit(2)
}
const chatCount = (
  await rawQuery(`select count(*)::int as n from douyin_link_messages where kind = 'chat' and user_id = $dy$${top.user_id}$dy$`)
).rows[0].n
console.log(`本次画像对象：${top.user_id}（库里有 ${chatCount} 条弹幕）`)

/* ------------------------------------------------------------------ 跑一次 */

const sent = []
globalThis.__DOUYIN_SEND__ = (channel, payload) => sent.push({ channel, payload })
globalThis.__DY_LIVE_MODE__ = live ? '1' : '0'

if (!live) {
  // 干跑：把材料打出来看（不调模型）。这里只借 `getUserPortrait`/状态读一次，材料由提示词工装拼。
  console.log('\n（干跑模式：不调模型。想看真材料请加 --live，材料内容会随回话一起打出来）')
  const state = await portrait.aiPortraitState({ userId: top.user_id, settings: { portraitProviderId: chosen.id } })
  console.log(`  缓存里已有画像：${state.portrait ? `第 ${state.portrait.version} 版（${state.portrait.model}）` : '没有'}`)
  console.log(`  当前数据侧：互动 ${state.current.interactions} 条 · 指纹 ${state.current.fingerprint}`)
  console.log(`  可选模型清单：${state.models.map((m) => `${m.id}:${m.model}`).join(' / ') || '（空）'}`)
  console.log(`  清单里有没有泄露 api_key：${JSON.stringify(state.models).includes(chosen.api_key) ? '**有（事故）**' : '没有'}`)
  await closeOrm()
  rmSync(workDir, { recursive: true, force: true })
  process.exit(failures === 0 ? 0 : 1)
}

console.log('\n=== 真调一次模型（会花钱）===')
const started = Date.now()
const result = await portrait.generateAiPortrait({
  userId: top.user_id,
  webRid: '',
  profile: null,
  settings: { portraitProviderId: chosen.id },
  force: true
})
const elapsed = Date.now() - started
check('生成成功', result.ok === true, JSON.stringify(result).slice(0, 400))
if (!result.ok) {
  await closeOrm()
  rmSync(workDir, { recursive: true, force: true })
  process.exit(1)
}

const report = result.portrait?.report ?? null
const raw = result.portrait?.raw ?? ''
console.log(`\n耗时 ${(elapsed / 1000).toFixed(1)}s · token ${result.portrait?.inputTokens}/${result.portrait?.outputTokens} · 回话 ${raw.length} 字符`)
console.log(`流式增量 ${sent.filter((entry) => entry.channel === 'plugin:douyin-link:portrait').length} 条（界面就是靠它边收边渲染）`)
check('真模型按结构化 JSON 回了（不是散文）', report !== null, `原文开头：${raw.slice(0, 200)}`)
if (report) {
  console.log('\n—— 模型写的画像 ——')
  console.log(`${report.persona}｜${report.headline}`)
  console.log(report.overview)
  for (const section of report.sections) {
    console.log(`\n【${section.title}】`)
    for (const item of section.items) console.log(`  · ${item}`)
  }
  if (report.evidence.length > 0) {
    console.log('\n【关键证据】')
    for (const item of report.evidence) console.log(`  「${item.quote}」 —— ${item.note}`)
  }
  if (report.suggestions.length > 0) {
    console.log('\n【维护建议】')
    for (const item of report.suggestions) console.log(`  · ${item}`)
  }
  if (report.caveats.length > 0) {
    console.log('\n【数据局限】')
    for (const item of report.caveats) console.log(`  · ${item}`)
  }

  console.log('\n=== 回话质量（这几条是提示词纪律在真模型上到底有没有用）===')
  check('类型名不为空', report.persona.length > 0)
  check('一句话画像不为空', report.headline.length > 0)
  check('总览不为空', report.overview.length > 0)
  check('分节至少 3 节', report.sections.length >= 3, `实际 ${report.sections.length}`)
  check('有局限说明（模型如实交代样本）', report.caveats.length >= 1)
  check('有维护建议', report.suggestions.length >= 1)
  // 引用必须逐字来自真弹幕（拿真库里的弹幕去核对，不看材料文本本身）
  const danmaku = (
    await rawQuery(
      `select content from douyin_link_messages where kind = 'chat' and user_id = $dy$${top.user_id}$dy$ and content <> ''`
    )
  ).rows.map((row) => String(row.content).trim())
  let checkedQuotes = 0
  let verbatim = 0
  for (const item of report.evidence) {
    const quote = item.quote.replace(/[「」""'']/g, '').trim()
    if (quote.length < 4) continue
    checkedQuotes += 1
    if (danmaku.some((line) => line.includes(quote) || quote.includes(line))) verbatim += 1
    else console.log(`  （这条引用在真弹幕里找不到逐字来源：${quote.slice(0, 30)}）`)
  }
  check(
    `引用的原话真的来自他的弹幕（${verbatim}/${checkedQuotes} 条对得上）`,
    checkedQuotes === 0 || verbatim / checkedQuotes >= 0.5,
    '要求至少一半引用能在真弹幕里找到逐字来源'
  )
  check('token 用量有回报（成本可核算）', (result.portrait?.inputTokens ?? 0) > 0 || (result.portrait?.outputTokens ?? 0) > 0, '供应商没回 usage 时为 0，也如实记录')
}

console.log('\n=== 落库（缓存）===')
const state = await portrait.aiPortraitState({ userId: top.user_id, settings: { portraitProviderId: chosen.id } })
check('重开能直接读到这一版（不用再花钱）', state.portrait?.version === result.portrait?.version)
check('库里标了结构化', state.portrait?.report !== null)
check('写清了用哪个模型', state.portrait?.model === chosen.model, `${state.portrait?.model} vs ${chosen.model}`)
console.log(`  第 ${state.portrait?.version} 版 · ${state.portrait?.providerName} / ${state.portrait?.model} · 基于 ${state.portrait?.interactions} 条互动`)

await closeOrm()
rmSync(workDir, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项未通过`}`)
process.exit(failures === 0 ? 0 : 1)
