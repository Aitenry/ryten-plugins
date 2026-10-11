/**
 * 「实时列表行首那截人物信息」的主进程侧回归工装（dev-only，不参与打包）。
 *
 * 用户 2026-10-11 的要求：弹幕与进场两种行的前面要显示 **等级 / 消费评分 / 入场次数 / 今天消费**。
 * 四个数里只有第一个（等级）渲染层手上就有，其余三个都得主进程算：
 * - 消费评分 = **本房间累计**，算法与画像里的「消费力」同一套（`shared/score.ts`）；
 * - 入场次数 = **跨全部直播间**合计；
 * - 今日消费 = **跨全部直播间**、本地自然日（`TodaySpend` 账本 + 库里补种）。
 *
 * 这个工装跑**真代码**（真 `AnalyzerHub` + 真 mapper + 真 PGlite + 真画像算法 + 真账本），
 * 只把 electron / 采集器 / 音频泵 / 头像缓存 / 解析器换成桩，断言六件事：
 * 1. 一次 `userBadges` 就把四个数给全（等级取本房间档案、消费评分按本房间累计、入场跨房合计）；
 * 2. **今日消费只算今天**：昨天的礼物不计（同一批数据里放一条两天前的礼物行）；
 * 3. **消费评分与画像同源**：`userAnalysis` 的 `spending` 维度 == `spendScore(累计抖币, 送礼次数)`；
 * 4. `TodaySpend` 账本：落库增量是「加」、库里补种是「以库为准（set）」、换天会清空；
 * 5. 跨房间的入场合计：`enterTotalsByUser` = 该 id 在所有房间的 enter 之和；
 * 6. 新人（库里还没有档案行）退回本场数字，并标 `fromStore = false`。
 *
 * 跑法（仓库根目录；PGlite 从 ryten-bench 找，或用 RB_PGLITE 指定 dist/index.js）：
 *   node plugins/douyin-link/spike/user-badge-check.mjs
 *
 * 写库一律是**内存库**：这个工装不碰任何真数据。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../../../')
const PLUGIN = join(HERE, '..')
const slash = (path) => path.replace(/\\/g, '/')

function resolvePglite() {
  const candidates = [process.env.RB_PGLITE]
  candidates.push('E:\\Development-Warehouse\\github\\ryten-bench\\node_modules\\@electric-sql\\pglite\\dist\\index.js')
  for (const path of candidates) if (path && existsSync(path)) return path
  console.error('找不到 @electric-sql/pglite，可用 RB_PGLITE=<dist/index.js 路径> 指定')
  process.exit(2)
}

const workDir = mkdtempSync(join(tmpdir(), 'douyin-badge-'))
const write = (name, contents) => {
  const path = join(workDir, name)
  writeFileSync(path, contents, 'utf8')
  return path
}

const ormStub = write(
  'orm.mjs',
  `import { drizzle } from 'drizzle-orm/pglite'\n` +
    `import { PGlite } from '@electric-sql/pglite'\n` +
    `let client = null\n` +
    `let orm = null\n` +
    `export async function withOrm(_op, fn) {\n` +
    `  if (!client) { client = new PGlite(); orm = drizzle(client) }\n` +
    `  return fn(orm)\n` +
    `}\n` +
    `export async function rawQuery(sql) { return client.query(sql) }\n` +
    `export async function closeOrm() { await client.close() }\n`
)
const pgliteShim = write(
  'pglite-shim.mjs',
  `const mod = await import(process.env.DY_PGLITE_URL)\n` +
    `export const PGlite = mod.PGlite\n` +
    `export const types = mod.types\n` +
    `export default mod\n`
)
const logStub = write('log.mjs', `export default { info() {}, warn() {}, error() {}, debug() {} }\n`)

/** hub 要的 electron / 采集器 / 音频泵 / 解析器（与 relive-check / identity-merge-check 同款桩） */
const STUBS = {
  electron: `
export const app = { getPath: () => '.' }
export const net = { fetch: async () => { throw new Error('probe: 不该走网络') } }
export class BrowserWindow { static getAllWindows() { return [] } }
export const ipcMain = { handle() {}, on() {} }
export default { app, net, BrowserWindow, ipcMain }
`,
  '@host/main/safe-send': `export const safeSend = () => {}\nexport const isSenderAlive = () => false\n`,
  /*
   * AI 画像（`main/portrait.ts`）也挂在 hub 上，所以打包 hub 就把它一起拉进来了：
   * 这三样只有「真去调大模型」时才用得上，工装给最小桩（**工装里绝不联网、绝不花钱**）。
   */
  '@host/main/i18n': `export const getMainLanguage = () => 'zh-CN'\nexport const mainFormat = (t) => String(t)\nexport const mainPlural = (o) => String(o)\nexport const mainMessages = () => ({})\n`,
  '@host/main/provider/service': `export const getProviderService = () => ({ createModel: async () => { throw new Error('probe: 工装不调模型') }, getConfig: async () => ({ model: '', name: '' }), clearCache() {} })\n`,
  '@host/main/database/mapper/provider': `export const getEnabledProviders = async () => []\nexport const getDefaultProvider = async () => null\nexport const getProviderById = async () => null\n`,
  '../avatar': `export const avatarCache = { dataUrl: () => '', dispose() {} }\n`,
  '../douyin/mystery': `
export async function fetchUserProfile() { return { ok: false, code: 'notFound' } }
export async function revealMysteryProfile() { return { ok: false, code: 'notFound' } }
`,
  '../audio/pump': `export class AudioPump { constructor() {} start() {} stop() {} }\n`,
  '../douyin/push-capture': `
export class DirectPushCapture {
  constructor(target, hooks) { this.target = target; this.hooks = hooks; this.stopped = true }
  get connected() { return false }
  setTarget() {}
  start() {}
  stop() {}
}
`,
  '../douyin/room': `
export class ResolveFailure extends Error {
  constructor(code, detail) { super(detail || code); this.code = code; this.detail = detail }
}
export async function resolveLiveRoom() { throw new ResolveFailure('notLive', '探针：工装不联网') }
export async function enterLiveRoom() { throw new ResolveFailure('notLive', '探针：工装不联网') }
`
}

const outfile = join(workDir, 'bundle.mjs')
await build({
  stdin: {
    contents: `
export { AnalyzerHub } from '${slash(join(PLUGIN, 'main/monitor/hub.ts'))}'
export { TodaySpend } from '${slash(join(PLUGIN, 'main/monitor/today-spend.ts'))}'
export * as mapper from '${slash(join(PLUGIN, 'main/db/mapper.ts'))}'
export { spendScore } from '${slash(join(PLUGIN, 'shared/score.ts'))}'
export { rawQuery, closeOrm } from '@host/main/database/orm'
`,
    loader: 'ts',
    resolveDir: PLUGIN
  },
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'warning',
  nodePaths: [join(ROOT, 'node_modules')],
  plugins: [
    {
      name: 'douyin-badge',
      setup(api) {
        const files = Object.fromEntries(
          Object.entries(STUBS).map(([key, value]) => [key, write(`${key.replace(/[^\w]/g, '_')}.mjs`, value)])
        )
        api.onResolve({ filter: /.*/ }, (args) => {
          if (args.path === '@host/main/database/orm') return { path: ormStub }
          if (args.path === '@electric-sql/pglite') return { path: pgliteShim }
          if (args.path === 'electron-log') return { path: logStub }
          if (files[args.path]) return { path: files[args.path] }
          return null
        })
      }
    }
  ]
})

process.env.DY_PGLITE_URL = pathToFileURL(resolvePglite()).href
const { AnalyzerHub, TodaySpend, mapper, spendScore, rawQuery, closeOrm } = await import(pathToFileURL(outfile).href)

/* ------------------------------------------------------------------ 工具 */

const failures = { count: 0 }
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures.count += 1
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`
  )
}

const ROOM_A = '700000000001'
const ROOM_B = '700000000002'
const U1 = '500000000001' // 两个房间都有档案：本房间 100 抖币，另一个房间 500 抖币
const U2 = '500000000002' // 只在 A 房；今天的礼物不算他的（那条是两天前的）
const NEW = '500000000003' // 还没落库的新人（只有本场数据）

const DAY = 86400000

function localDayStart(at) {
  const offset = -new Date().getTimezoneOffset() * 60000
  return Math.floor((at + offset) / DAY) * DAY - offset
}

let seq = 0
const message = (kind, webRid, userId, diamonds, at) => ({
  webRid,
  sessionId: 1,
  kind,
  userId,
  userName: `用户${userId.slice(-3)}`,
  content: kind === 'gift' ? '小心心' : '你好',
  count: kind === 'gift' ? 1 : 0,
  diamonds,
  toUserId: '',
  toUserName: '',
  orderKey: '',
  giftRecord: kind === 'gift',
  atMs: at
})

const userRow = (webRid, userId, enter, gift, diamonds, honorLevel) => ({
  webRid,
  userId,
  nickname: `用户${userId.slice(-3)}`,
  displayId: '',
  gender: 0,
  signature: '',
  city: '',
  avatar: '',
  following: 0,
  follower: 0,
  honorLevel,
  fansClubLevel: 0,
  badges: [],
  secUid: '',
  delta: { chat: 0, enter, like: 0, follow: 0, gift, diamonds },
  firstSeen: Date.now() - DAY,
  lastSeen: Date.now()
})

async function main() {
  const hub = new AnalyzerHub()
  await hub.init({ resumeOnStart: false })

  /* ---------------------------------------------------------- 种数据 */
  const today = localDayStart(Date.now())
  await mapper.insertMessages([
    // 今天：U1 在 B 房送 200 抖币（跨房间的「今日消费」要认；U1 在 A 房没有今天的礼物）
    message('gift', ROOM_B, U1, 200, today + 3600_000),
    // 两天前：U2 送 999 抖币 —— **不算今天**
    message('gift', ROOM_A, U2, 999, today - 2 * DAY + 3600_000)
  ])
  await mapper.upsertUserDeltas([
    userRow(ROOM_A, U1, 2, 1, 100, 12),
    userRow(ROOM_B, U1, 3, 2, 500, 14),
    userRow(ROOM_A, U2, 1, 1, 999, 6)
  ])

  /* ------------------------------------------- 1. 四个数一次给全（U1） */
  console.log('=== 1. userBadges（U1：本房间 A 房）===')
  const [badge] = await hub.userBadges(ROOM_A, [U1])
  console.log(
    `  ${JSON.stringify({ 等级: badge.honorLevel, 评分: badge.spendScore, 入场: badge.enterTotal, 今日: badge.todayDiamonds, 本房抖币: badge.diamonds })}`
  )
  check('等级取本房间档案行', badge.honorLevel, 12)
  check('消费评分 = spendScore(本房间累计 100, 送礼 1 次)', badge.spendScore, spendScore(100, 1))
  check('入场次数 = 跨房间合计 2 + 3', badge.enterTotal, 5)
  check('今日消费 = 今天在 B 房送的 200', badge.todayDiamonds, 200)
  check('fromStore = true（库里有档案）', badge.fromStore, true)

  /* ------------------------------------- 2. 两天前的礼物不算「今天」 */
  console.log('\n=== 2. 昨天/前天的礼物不算今天（U2）===')
  const [older] = await hub.userBadges(ROOM_A, [U2])
  console.log(`  U2 今日消费 ${older.todayDiamonds}（他在 A 房有一笔两天前的 999）`)
  check('两天前的 999 不计入今日', older.todayDiamonds, 0)

  /* ------------------------------- 3. 消费评分与画像「消费力」同源 */
  console.log('\n=== 3. 消费评分 == 画像的「消费力」维度 ===')
  const analysis = await hub.userAnalysis(U1)
  const spending = analysis.traits.find((trait) => trait.key === 'spending')?.score ?? -1
  // 画像走**跨全部直播间**口径：100 + 500 = 600 抖币、1 + 2 = 3 次送礼
  const expected = spendScore(600, 3)
  console.log(`  画像 spending=${spending} · spendScore(600, 3)=${expected} · facts.monetary=${analysis.facts.monetary}`)
  check('画像消费力 == shared/spendScore（同算法同量级）', spending, expected)
  check('画像的 monetary 也是 600（跨房间累计）', analysis.facts.monetary, 600)

  /* ---------------------------------------- 4. 账本：增量 / 补种 / 换天 */
  console.log('\n=== 4. TodaySpend 账本 ===')
  const ledger = new TodaySpend()
  ledger.roll('2026-10-11')
  ledger.note([
    { kind: 'gift', userId: U1, diamonds: 300 },
    { kind: 'chat', userId: U1, diamonds: 0 },
    { kind: 'gift', userId: U2, diamonds: 0 }
  ])
  check('落库增量是「加」：300', ledger.get(U1), 300)
  check('非礼物行 / 0 价礼物不计', ledger.get(U2), 0)
  ledger.seed(new Map([[U1, 900]]))
  check('库里补种是「以库为准」（set，不累加成 1200）', ledger.get(U1), 900)
  const rolled = ledger.roll('2026-10-12')
  check('换天会清空', [rolled, ledger.get(U1)], [true, 0])

  /* ------------------------------------------ 5. 跨房间入场合计（mapper） */
  console.log('\n=== 5. enterTotalsByUser（跨房间）===')
  const totals = await mapper.enterTotalsByUser([U1, U2, NEW])
  console.log(`  ${JSON.stringify(Object.fromEntries(totals))}`)
  check('U1 = 2 + 3', totals.get(U1), 5)
  check('U2 = 1（只有 A 房）', totals.get(U2), 1)
  check('库里没有的人不出现', totals.has(NEW), false)

  /* ---------------------------------------------- 6. 新人退回本场数字 */
  console.log('\n=== 6. 新人（库里还没有档案行）===')
  const [fresh] = await hub.userBadges(ROOM_A, [NEW])
  console.log(`  ${JSON.stringify({ 等级: fresh.honorLevel, 评分: fresh.spendScore, 入场: fresh.enterTotal, fromStore: fresh.fromStore })}`)
  check('fromStore = false', fresh.fromStore, false)
  check('没有数据时四个数都是 0（不编）', [fresh.honorLevel, fresh.spendScore, fresh.enterTotal, fresh.todayDiamonds], [0, 0, 0, 0])

  hub.dispose()
}

await main()

console.log(`\n=== 小结 ===\n${failures.count === 0 ? '✓ 全部断言通过' : `✗ ${failures.count} 项断言失败`}`)
await closeOrm().catch(() => undefined)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures.count === 0 ? 0 : 1)
