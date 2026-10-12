/**
 * 「实时列表行首那截人物信息」的主进程侧回归工装（dev-only，不参与打包）。
 *
 * 用户 2026-10-11 的要求：弹幕与进场两种行的前面要显示 **等级 / 消费评分 / 入场次数 / 今天消费**；
 * 2026-10-14 又改成**按身份两套 + 多账号汇聚**：
 * - 观众 = `消费欲望 · 进场次数 · 今日消费`，主播 = `绩效指标 · 进场次数 · 今日收入`；
 * - **绑定过的多个账号按「这个人」汇聚**（计数求和、等级/时间取极值），从哪个号问都得到同一份数。
 *
 * 四个数里只有第一个（等级）渲染层手上就有，其余都得主进程算：
 * - 消费评分 / 消费欲望 = **本房间累计**（算法见 `shared/score.ts` / `shared/engagement.ts`）；
 * - 入场次数 = **跨全部直播间**合计；
 * - 今日消费 / 今日收入 = **跨全部直播间**、本地自然日（两本 `TodaySpend` 账本 + 库里补种）。
 *
 * 这个工装跑**真代码**（真 `AnalyzerHub` + 真 mapper + 真 PGlite + 真画像算法 + 真账本），
 * 只把 electron / 采集器 / 音频泵 / 头像缓存 / 解析器换成桩，断言八件事：
 * 1. 一次 `userBadges` 就把四个数给全（等级取本房间档案、消费评分按本房间累计、入场跨房合计）；
 * 2. **今日消费只算今天**：昨天的礼物不计（同一批数据里放一条两天前的礼物行）；
 * 3. **消费评分与画像同源**：`userAnalysis` 的 `spending` 维度 == `spendScore(累计抖币, 送礼次数)`；
 * 4. `TodaySpend` 账本：落库增量是「加」、库里补种是「以库为准（set）」、换天会清空；
 * 5. 跨房间的入场合计：`enterTotalsByUser` = 该 id 在所有房间的 enter 之和；
 * 6. 新人（库里还没有档案行）退回本场数字，并标 `fromStore = false`；
 * 7. `消费欲望` / `绩效指标` 两条公式的性质（随时间衰减、随消费/说过变化、稀有金主不被低估）；
 * 8. **多账号汇聚**：M1 与 M2 绑成同一个人之后，等级取最高、抖币与进场求和、从哪个号问都一样。
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
export { consumeDesire, hostPerformance } from '${slash(join(PLUGIN, 'shared/engagement.ts'))}'
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
const { AnalyzerHub, TodaySpend, mapper, spendScore, consumeDesire, hostPerformance, rawQuery, closeOrm } = await import(pathToFileURL(outfile).href)

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
const M1 = '500000000021' // 多账号：同一个人的主号（本房间 700 抖币 / 进场 2 / 等级 5）
const M2 = '500000000022' // 多账号：同一个人的小号（本房间 300 抖币 / 进场 3 / 等级 9）

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
    message('gift', ROOM_A, U2, 999, today - 2 * DAY + 3600_000),
    // 多账号（第 8 节）：M1 与 M2 是**同一个人**的两个号，今天的礼物分别在两个号上
    { ...message('gift', ROOM_A, M1, 700, today + 1800_000), orderKey: 'badge-m1' },
    { ...message('gift', ROOM_A, M2, 300, today + 2400_000), orderKey: 'badge-m2' }
  ])
  await mapper.upsertUserDeltas([
    userRow(ROOM_A, U1, 2, 1, 100, 12),
    userRow(ROOM_B, U1, 3, 2, 500, 14),
    userRow(ROOM_A, U2, 1, 1, 999, 6),
    // 多账号：M1（本房间 700 抖币 / 进场 2 / 等级 5）、M2（本房间 300 抖币 / 进场 3 / 等级 9）
    userRow(ROOM_A, M1, 2, 1, 700, 5),
    userRow(ROOM_A, M2, 3, 2, 300, 9)
  ])
  // 绑定成同一个人（第 8 节要用；绑在**第一次 userBadges 之前**，这样「今日」两本账补种时就认它）
  await mapper.bindAccount(M2, M1)

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

  /* ---------------------------- 7. 消费欲望 / 绩效指标（公式性质 + 接线） */
  console.log('\n=== 7. 消费欲望（观众）/ 绩效指标（主播）===')
  check('观众：身份判定为 viewer', badge.role, 'viewer')
  check('观众：今日收入恒为 0（那是主播口径）', badge.todayReceived, 0)
  check('观众：消费欲望落在 0-100', badge.consumeDesire >= 0 && badge.consumeDesire <= 100, true)
  check('观众：没数据时消费欲望是 0（不编）', fresh.consumeDesire, 0)

  const base = {
    spendScore: 60,
    diamonds: 8000,
    roomVisits: 8,
    enterTotal: 12,
    chatTotal: 40,
    hoursSinceLastSeen: 1,
    activeNow: false
  }
  check(
    '消费欲望随时间衰减：1 小时前 > 3 天前',
    consumeDesire(base) > consumeDesire({ ...base, hoursSinceLastSeen: 72 }),
    true
  )
  check(
    '「此刻还在场」不打折：在场 > 同样时间的衰减值',
    consumeDesire({ ...base, activeNow: true }) > consumeDesire(base),
    true
  )
  check(
    '消费欲望随进场/说话增长',
    consumeDesire({ ...base, activeNow: true, enterTotal: 18, chatTotal: 90 }) >
      consumeDesire({ ...base, activeNow: true, enterTotal: 2, chatTotal: 3 }),
    true
  )
  /*
   * 用户 2026-10-14 的核心诉求：**不常来、不常说话、但一来就消费很多**的人，必须是高欲望。
   * 造两个对照：稀有金主（来 1 次、说 0 句、单次 30000 抖币）vs 常来话痨但一分不花。
   */
  const rareWhale = { spendScore: spendScore(30000, 2), diamonds: 30000, roomVisits: 1, enterTotal: 1, chatTotal: 0, hoursSinceLastSeen: 0, activeNow: true }
  const chattyFree = { spendScore: spendScore(0, 0), diamonds: 0, roomVisits: 0, enterTotal: 30, chatTotal: 200, hoursSinceLastSeen: 0, activeNow: true }
  check('稀有金主（来 1 次、不说话、单次 3 万）算高欲望（≥60）', consumeDesire(rareWhale) >= 60, true)
  check('稀有金主 > 常来话痨但从不花钱', consumeDesire(rareWhale) > consumeDesire(chattyFree), true)
  check('从不花钱的人欲望低（< 40）', consumeDesire(chattyFree) < 40, true)

  check(
    '绩效指标由直播内容构成：有收入 + 有互动 > 全 0',
    hostPerformance({ todayReceived: 5000, sessionChat: 200, audience: 80, sessionEnter: 40, hostOutput: 30 }) >
      hostPerformance({ todayReceived: 0, sessionChat: 0, audience: 0, sessionEnter: 0, hostOutput: 0 }),
    true
  )
  check(
    '绩效指标只看收入（没监控内容）也 > 0',
    hostPerformance({ todayReceived: 8000, sessionChat: 0, audience: 0, sessionEnter: 0, hostOutput: 0 }) > 0,
    true
  )

  /* ------------------------------- 8. 多账号：绑定后所有数按「这个人」汇聚 */
  console.log('\n=== 8. 多账号汇聚（M1 + M2 绑成同一个人）===')
  const [merged] = await hub.userBadges(ROOM_A, [M1])
  console.log(
    `  ${JSON.stringify({ 等级: merged.honorLevel, 送礼抖币: merged.diamonds, 送礼次数: merged.giftCount, 进场: merged.enterTotal, 今日消费: merged.todayDiamonds })}`
  )
  check('等级取最高（5 / 9 → 9）', merged.honorLevel, 9)
  check('送礼抖币求和（700 + 300）', merged.diamonds, 1000)
  check('送礼次数求和（1 + 2）', merged.giftCount, 3)
  check('消费评分按合计算', merged.spendScore, spendScore(1000, 3))
  check('进场次数求和（2 + 3）', merged.enterTotal, 5)
  check('今日消费求和（700 + 300，两个号今天的礼物都算）', merged.todayDiamonds, 1000)
  const [mergedFromOther] = await hub.userBadges(ROOM_A, [M2])
  check(
    '从哪个号问，得到的是同一份数（多账号汇聚）',
    [mergedFromOther.honorLevel, mergedFromOther.diamonds, mergedFromOther.enterTotal, mergedFromOther.todayDiamonds],
    [9, 1000, 5, 1000]
  )
  check(
    '消费欲望也是按汇聚后的数算的',
    merged.consumeDesire,
    mergedFromOther.consumeDesire
  )

  hub.dispose()
}

await main()

console.log(`\n=== 小结 ===\n${failures.count === 0 ? '✓ 全部断言通过' : `✗ ${failures.count} 项断言失败`}`)
await closeOrm().catch(() => undefined)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures.count === 0 ? 0 : 1)
