/**
 * 主进程 Cookie 口径自检（dev-only，不参与打包）：把**真产物** `dist/douyin-link/main.cjs`
 * 装进 Node，走**真的 IPC 通道** `plugin:douyin-link:settings-set`，断言：
 *
 * - 6071 字符的登录态 cookie 原样进内存、原样落盘（`plugin-state/douyin-link.json`）；
 * - 真撞上限（12 KiB）时才截断，并且**必须留下一条 warn 日志**（说明截了多少、丢了什么）；
 * - 渲染层那次归一化也一样（`normalizeSettings` 走的是同一个上限函数）。
 *
 * 为什么要连主进程一起验：2026-10-10 的事故里，渲染层与主进程**各写了一个 4096**，
 * 只验一头会漏掉另一头；而「诊断日志有没有真的打出来」正是上一次事故里没验的那一环
 * （代码里写了 `logger.warn`，真跑起来一条都没有）。
 *
 * 宿主桥在这里用 `globalThis.__RB_HOST_RESOLVE__` 顶掉（产物就是用这个钩子取宿主模块的），
 * `ctx.effect` 不执行（那会去连数据库），其余都是真产物代码。
 *
 * 跑法（先构建）：
 *   npm run build
 *   node plugins/douyin-link/spike/cookie-main-check.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const bundlePath = join(ROOT, 'dist/douyin-link/main.cjs')
if (!existsSync(bundlePath)) {
  console.error('先跑 npm run build（找不到 dist/douyin-link/main.cjs）')
  process.exit(2)
}

const require_ = createRequire(pathToFileURL(join(ROOT, 'package.json')).href)
const workDir = mkdtempSync(join(tmpdir(), 'douyin-cookie-main-'))
const userData = join(workDir, 'userData')

/* --------------------------------------------------------------- 宿主桥的桩 */

/** 日志探针：把每一条日志记下来——「写了 warn」和「warn 真被调用」是两回事 */
const logs = []
const logSink = (...args) => logs.push(args.map((arg) => String(arg)).join(' '))
const logger = { info: logSink, warn: logSink, error: logSink, debug: logSink, verbose: logSink, silly: logSink }

const electronStub = {
  app: { getPath: () => userData },
  net: {
    fetch: async () => {
      throw new Error('probe: 不该走到网络')
    }
  },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {}
}

/** 插件自己的 db 模块走 `@host/main/database/orm`；这里给个空壳（本次不碰数据库） */
const ormStub = {
  withOrm: async (_op, fn) => (typeof fn === 'function' ? fn({}) : [])
}

const hostModules = {
  electron: electronStub,
  'electron-log': { default: logger, ...logger },
  'drizzle-orm': require_('drizzle-orm'),
  'drizzle-orm/pg-core': require_('drizzle-orm/pg-core'),
  '@langchain/core/tools': require_('@langchain/core/tools'),
  'zod/v4': require_('zod/v4'),
  '@host/main/database/orm': ormStub,
  '@host/main/safe-send': { safeSend: () => {}, isSenderAlive: () => false },
  '@host/main/i18n': { t: (key) => key, default: { t: (key) => key } },
  '@host/main/plugins/contributions': { PLUGIN_PURGE: 'plugin:purge' },
  '@host/main/plugins/app-hooks': { APP_BEFORE_QUIT: 'app:before-quit' },
  '@host/main/plugins/tool-contract': { HARNESS_TOOL_CONTRIBUTION: 'harness:tool' }
}
const unknown = new Set()
globalThis.__RB_HOST_RESOLVE__ = (spec) => {
  if (spec in hostModules) return hostModules[spec]
  // 宿主还给了别的模块（主题/文件对话框之类）：给个空壳，别让装载期炸掉；
  // 但记下来，跑完打出来——「悄悄多依赖了宿主一个模块」是要被看见的。
  unknown.add(spec)
  return {}
}

const plugin = require_(bundlePath)

/* ---------------------------------------------------------- 装进一个假宿主上下文 */

const handlers = {}
let effects = 0
plugin.install({
  /** 不执行：`initAnalyzer` 那段会去读数据库、恢复房间清单，与本次要验的东西无关 */
  effect: () => {
    effects += 1
    return () => {}
  },
  registerEvent: () => {},
  registerIpc: (map) => Object.assign(handlers, map),
  contribute: () => {}
})

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`
  )
}

const settingsFile = join(userData, 'plugin-state', 'douyin-link.json')
const storedCookie = () => JSON.parse(readFileSync(settingsFile, 'utf8')).douyinCookie
const warnLines = () => logs.filter((line) => line.includes('超过上限'))

/** 照实测那份 6071 字符的形状合成（无真实凭据）：页面小字段在前、登录态字段压在尾部 */
const syntheticCookie = () =>
  [
    'enter_pc_once=1',
    `UIFID=${'b'.repeat(2600)}`,
    `bit_env=${'0'.repeat(2600)}`,
    `sdk_source_info=${'f'.repeat(700)}`,
    'is_staff_user=false',
    'sessionid=1a8d5ecf86914841ab2c20ae2f4a0f49',
    `ttwid=1%7CbDhzRjFnQzmIGSOhiWLnodUqg7ul0x9iwFJLzDkH1p0%7C1791628920%7C${'2'.repeat(64)}`,
    `odin_tt=${'7'.repeat(128)}`
  ].join('; ')

check('插件交出了设置通道', typeof handlers['plugin:douyin-link:settings-set'], 'function')
check('装载期没有自动连库（effect 只登记、不执行）', effects, 1)

/* ------------------------------------------------- 1. 一份真实长度的 cookie：原样留下 */

const long = syntheticCookie()
check(`合成样本长度 > 旧上限（${long.length} 字符）`, long.length > 4096, true)
check('合成样本里登录态字段落在 4096 之后（与实测事故同一形状）', long.indexOf('sessionid=') > 4096, true)

const first = await handlers['plugin:douyin-link:settings-set']({ douyinCookie: long })
check('通道回包的 cookie 就是完整那一行', first.douyinCookie.length, long.length)
check('通道回包的 cookie 逐字相同', first.douyinCookie === long, true)
check('落盘的 cookie 也是完整那一行', storedCookie().length, long.length)
check('落盘的 cookie 逐字相同', storedCookie() === long, true)
check('没截断就不许打截断日志（别拿噪音当诊断）', warnLines().length, 0)

/* --------------------------------- 2. 真撞上限：才截断，而且必须留下一条说实话的日志 */

const huge = `odin_tt=${'9'.repeat(13000)}`
const second = await handlers['plugin:douyin-link:settings-set']({ douyinCookie: huge })
check('超限时截到上限', second.douyinCookie.length, 12288)
check('超限时落盘的也是截断后的那一份', storedCookie().length, 12288)
check('截断留下的是**开头**那一段（砍尾巴）', second.douyinCookie, huge.slice(0, 12288))
check('截断时打出一条 warn', warnLines().length, 1)
check(
  'warn 里说清了原始长度与上限',
  [warnLines()[0]?.includes(`有 ${huge.length} 字符`), warnLines()[0]?.includes('超过上限 12288')],
  [true, true]
)
check('warn 里点出后果（会被当成无效会话）', warnLines()[0]?.includes('ttwid'), true)

/* ------------------------------------------------------------------ 收摊 */

if (unknown.size > 0) console.log(`     装载期还向宿主要了这些模块（本次给的是空壳）：${[...unknown].join(', ')}`)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
