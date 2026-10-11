/**
 * 匿名身份拆分：**真代码 + 真 PGlite** 的回归工装（dev-only，不参与打包）。
 *
 * 由来（用户 2026-10-12 报障）：「匿名用户，内容监控会重复，这么严重的 bug」
 * ——抖音给所有隐藏身份的人发的 `user.id` 都是共用占位串 `111111`，
 * 于是按 id 聚合的一切都把**互不相干的匿名观众堆成一个人**：档案弹窗的「互动统计」是几个人头的
 * 合计、「历史弹幕」是一条混合时间线、库里的累计成了「13 条弹幕 / 53 次进场」。
 * 真库证据（用户库副本）：房间 `108011161837` 等 4 个房间的 `user_id = '111111'` 的 76 行里，
 * 出现了 `dou2056511` / `dou4546310` / `dou1330533` / `dou3710451` 等十几个不同的马甲名。
 *
 * 这个工装跑**真 `analyzerHub`（真 `identifyBatch`）→ 真 `RoomRecorder` → 真 mapper → 真 PGlite**，
 * 验四件事：
 * 1. **三个人不合并**：三个马甲名不同、但 id 都是 `111111` 的匿名用户各说一句话、各进一次场 →
 *    用户档案、消息流水、在场清单、榜单、分钟桶全部按「三个人」记（改前是**一个人**：3 条弹幕 / 3 次进场）；
 * 2. **同一个人不分裂**：同一个马甲又说一句，仍然落回同一份档案（统计累加而不是新建一行）；
 * 3. **历史数据重排**：把「所有匿名行挤在一个 `111111` 上」的旧库喂给
 *    `mapper.splitAnonymousIdentities()`，断言按马甲散开、统计不丢、**跑第二遍什么都不改**（幂等）；
 * 4. **认不出人的匿名帧**（空名、没有等级）不建档案，但仍然照记消息流水（账号不能凭空合并）。
 *
 * 跑法（仓库根目录）：
 *   node plugins/douyin-link/spike/anon-identity-check.mjs
 * 想对真库副本（只读、不写）额外跑一遍历史重排：
 *   node plugins/douyin-link/spike/anon-identity-check.mjs "$env:TEMP\rbdb-copy"
 *
 * ⚠️ PGlite 没有跨进程锁：这个工装默认只在**内存库**里写；给了副本路径时也只写副本。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../../../')
const PLUGIN = join(HERE, '..')

const sourceDir = process.argv[2] ?? process.env.DY_DB_DIR ?? ''
if (sourceDir && !existsSync(join(sourceDir, 'PG_VERSION'))) {
  console.error(`不是 PGlite 数据目录（缺 PG_VERSION）：${sourceDir}`)
  process.exit(2)
}

function resolvePglite() {
  const candidates = [process.env.RB_PGLITE]
  candidates.push(
    'E:\\Development-Warehouse\\github\\ryten-bench\\node_modules\\@electric-sql\\pglite\\dist\\index.js'
  )
  for (const path of candidates) if (path && existsSync(path)) return path
  console.error('找不到 @electric-sql/pglite，可用 RB_PGLITE=<dist/index.js 路径> 指定')
  process.exit(2)
}

const slash = (path) => path.replace(/\\/g, '/')
const workDir = mkdtempSync(join(tmpdir(), 'douyin-anon-id-'))
/** PGlite 不在插件仓库依赖里：打包时只留一个 shim，运行时按这个变量去 import 真路径 */
process.env.DY_PGLITE_URL = pathToFileURL(resolvePglite()).href

/* ------------------------------------------------ 宿主那层薄封装的替身（只读/写 PGlite） */

const ormStub = join(workDir, 'orm.mjs')
writeFileSync(
  ormStub,
  `import { drizzle } from 'drizzle-orm/pglite'\n` +
    `import { PGlite } from '@electric-sql/pglite'\n` +
    `let client = null\n` +
    `let orm = null\n` +
    `export async function withOrm(_op, fn) {\n` +
    `  if (!client) { const dir = process.env.DY_WRITE_DIR; client = dir ? new PGlite(dir) : new PGlite(); orm = drizzle(client) }\n` +
    `  return fn(orm)\n` +
    `}\n` +
    `export async function rawQuery(sql) { return client.query(sql) }\n` +
    `export async function closeOrm() { if (client) await client.close() }\n`,
  'utf8'
)

/** PGlite 不在插件仓库依赖里：运行时按环境变量去 import 真路径 */
const pgliteShim = join(workDir, 'pglite-shim.mjs')
writeFileSync(
  pgliteShim,
  `const mod = await import(process.env.DY_PGLITE_URL)\n` +
    `export const PGlite = mod.PGlite\n` +
    `export const types = mod.types\n` +
    `export default mod\n`,
  'utf8'
)

/** `electron`：hub 只用 BrowserWindow 广播，工装里没有窗口；`net` 等只是被 import，不会被调用 */
const electronStub = join(workDir, 'electron.mjs')
writeFileSync(
  electronStub,
  `export const BrowserWindow = { getAllWindows: () => [] }\n` +
    `export const app = { getPath: () => process.env.TEMP ?? '.', isPackaged: false }\n` +
    `export const ipcMain = { handle() {}, removeHandler() {} }\n` +
    `export const safeStorage = { isEncryptionAvailable: () => false }\n` +
    `export const net = { request: () => ({ on() {}, end() {}, write() {} }) }\n` +
    `export const session = { fromPartition: () => ({ fetch: async () => ({}) }) }\n` +
    `export default { BrowserWindow, app, ipcMain, safeStorage, net, session }\n`,
  'utf8'
)

/** 其余 `@host/*`：只要**能装载**（本工装不调用它们） */
const hostStub = join(workDir, 'host.mjs')
writeFileSync(
  hostStub,
  `export async function withOrm(_op, fn) { return fn(null) }\n` +
    `export function safeSend() {}\n` +
    `export function isSenderAlive() { return true }\n` +
    `export default new Proxy({}, { get: () => () => undefined })\n`,
  'utf8'
)

/** `electron-log`：`logger.info(...)` 是主进程日志出口，工装里吞掉即可（也避开它的 CJS 动态 require） */
const logStub = join(workDir, 'log.mjs')
writeFileSync(
  logStub,
  `const noop = () => {}\n` +
    `export default { info: noop, warn: noop, error: noop, debug: noop, verbose: noop, transports: { file: {}, console: {} } }\n`,
  'utf8'
)

const outfile = join(workDir, 'bundle.mjs')
await build({
  stdin: {
    contents: `
export { analyzerHub } from '${slash(join(PLUGIN, 'main/monitor/hub.ts'))}'
export * as mapper from '${slash(join(PLUGIN, 'main/db/mapper.ts'))}'
export { schemaReady } from '${slash(join(PLUGIN, 'main/db/ddl.ts'))}'
export * as anon from '${slash(join(PLUGIN, 'shared/anonymous.ts'))}'
export { matchAnonymousCandidate, revealAnonymousProfile } from '${slash(join(PLUGIN, 'main/douyin/anonymous-reveal.ts'))}'
export { closeOrm } from '@host/main/database/orm'
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
      name: 'stubs',
      setup(api) {
        api.onResolve({ filter: /^electron$/ }, () => ({ path: electronStub }))
        api.onResolve({ filter: /^electron-log$/ }, () => ({ path: logStub }))
        // 顺序要紧：具体的 orm 路径要先于兜底的 `@host/*` 命中
        api.onResolve({ filter: /^@host\/main\/database\/orm$/ }, () => ({ path: ormStub }))
        api.onResolve({ filter: /^@host\// }, () => ({ path: hostStub }))
        api.onResolve({ filter: /^@electric-sql\/pglite$/ }, () => ({ path: pgliteShim }))
      }
    }
  ]
})

const mod = await import(pathToFileURL(outfile).href)
const { analyzerHub, mapper, anon, matchAnonymousCandidate, revealAnonymousProfile } = mod

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`
  )
}
const show = (label, value) => console.log(`      · ${label}: ${JSON.stringify(value)}`)

/* ------------------------------------------------------------ 纯逻辑：身份键怎么算 */

console.log('\n=== 1. 身份键：匿名按马甲分开，普通人原样 ===')
const [k1, k2, k3] = [
  anon.anonymousUserId('111111', { nickname: 'dou2056511', honorLevel: 52 }),
  anon.anonymousUserId('111111', { nickname: 'dou4546310', honorLevel: 33 }),
  anon.anonymousUserId('111111', { nickname: 'dou1330533', honorLevel: 27 })
]
check('三个马甲名不同的匿名用户 → 三把不同的键', new Set([k1, k2, k3]).size, 3)
show('示例键', k1)
check(
  '同一个马甲两次 → 同一把键（同一个人不许分裂）',
  anon.anonymousUserId('111111', { nickname: '☞    dou2056511  ' }),
  k1
)
check('普通人（真 id）原样返回', anon.anonymousUserId('7300000000001', { nickname: '张三' }), '7300000000001')
check('连马甲都没有的匿名帧 → 空键（不合并、也不建档案）', anon.anonymousUserId('111111', {}), '')
check('展示用真 id：合成键脱壳', anon.rawDouyinId(k1), '111111')
check('展示用真 id：普通 id 不动', anon.rawDouyinId('7300000000001'), '7300000000001')
check('占位名不往界面塞（空串）', anon.displayNickname('☞      匿名  -'), '')
check('马甲名照显', anon.displayNickname('dou2056511'), 'dou2056511')
check('抖音号里的占位串丢掉', anon.displayDisplayId('111111'), '')

/* ------------------------------------------------- 真链路：hub → recorder → mapper → PGlite */

const ROOM = '880000000001'
const REAL = '7300000000001'

/** 三条匿名消息 + 一条普通用户消息（每条都带 `User` 帧，和真实推送一样） */
const anonUser = (nickname, honorLevel, at) => ({
  items: [
    { id: 0, kind: 'chat', user: nickname, userId: '111111', text: `我是${nickname}`, count: 0, diamonds: 0, toUser: '', toUserId: '', at }
  ],
  users: [
    {
      id: '111111',
      displayId: '',
      nickname,
      gender: 0,
      signature: '',
      city: '',
      avatar: '',
      following: 0,
      follower: 0,
      honorLevel,
      fansClubLevel: 0,
      badges: [],
      secUid: ''
    }
  ]
})

const feed = (webRid, items, users) => analyzerHub.ingestItemsForTest(webRid, items, users, false)

console.log('\n=== 2. 真链路：三个匿名用户各说一句 + 各进一次场 ===')
process.env.DY_WRITE_DIR = ''
await analyzerHub.init({})
await mapper.upsertRoom({
  webRid: ROOM,
  roomId: '1001',
  title: '工装直播间',
  anchor: '工装主播',
  cover: '',
  onlineText: '3',
  status: 'live'
})
const startedAt = Date.now()
const batches = [
  anonUser('dou2056511', 52, startedAt),
  anonUser('dou4546310', 33, startedAt + 1000),
  anonUser('dou1330533', 27, startedAt + 2000),
  {
    items: [
      { id: 0, kind: 'member', user: 'dou2056511', userId: '111111', text: '', count: 30, diamonds: 0, toUser: '', toUserId: '', at: startedAt + 3000 },
      { id: 0, kind: 'member', user: 'dou4546310', userId: '111111', text: '', count: 31, diamonds: 0, toUser: '', toUserId: '', at: startedAt + 3100 },
      { id: 0, kind: 'member', user: 'dou1330533', userId: '111111', text: '', count: 32, diamonds: 0, toUser: '', toUserId: '', at: startedAt + 3200 }
    ],
    users: []
  },
  {
    items: [
      { id: 0, kind: 'chat', user: '张三', userId: REAL, text: '大家好', count: 0, diamonds: 0, toUser: '', toUserId: '', at: startedAt + 4000 }
    ],
    users: [
      { id: REAL, displayId: 'zhangsan', nickname: '张三', gender: 1, signature: '', city: '北京', avatar: '', following: 1, follower: 2, honorLevel: 9, fansClubLevel: 0, badges: [], secUid: 'sec-zhang' }
    ]
  }
]
for (const batch of batches) feed(ROOM, batch.items, batch.users)
// hub 的落库是 2 秒一拍，这里手动催一次（工装不等定时器）
await analyzerHub.flushForTest()
await new Promise((resolve) => setTimeout(resolve, 200))

const session = await mapper.queryMessages({ webRid: ROOM, limit: 100 })
const rows = session.rows
const anonRows = rows.filter((row) => anon.isAnonymousId(row.userId))
const distinctAnon = [...new Set(anonRows.map((row) => row.userId))]
console.log(`      消息行 ${rows.length} 条，其中匿名 ${anonRows.length} 条 / ${distinctAnon.length} 个身份`)
for (const id of distinctAnon) show('匿名身份', id)
check('三条匿名弹幕落在**三个不同身份**上（改前是同一个 111111）', distinctAnon.length, 3)
check('每条身份各一条弹幕', distinctAnon.map((id) => anonRows.filter((row) => row.userId === id && row.kind === 'chat').length), [1, 1, 1])
check('普通用户不受影响', rows.filter((row) => row.userId === REAL).length, 1)

const users = await mapper.listUsersPage(ROOM, 'recent', '', 100)
const anonProfiles = users.rows.filter((row) => anon.isAnonymousId(row.userId))
console.log(`      档案行 ${users.rows.length} 条，其中匿名 ${anonProfiles.length} 条`)
for (const row of anonProfiles) show('匿名档案', `${row.userId} | ${row.nickname} | 弹幕 ${row.stats.chat} / 进场 ${row.stats.enter}`)
check('三个匿名用户各有**自己的一份档案**', anonProfiles.length, 3)
check(
  '每份档案只记自己的 1 弹幕 / 1 进场（改前是一个人 3/3）',
  anonProfiles.map((row) => [row.stats.chat, row.stats.enter]).sort((a, b) => a[0] - b[0]),
  [[1, 1], [1, 1], [1, 1]]
)
check('档案里不再写占位抖音号', anonProfiles.every((row) => row.displayId !== '111111'), true)

console.log('\n=== 3. 同一个人继续说 → 落回同一份档案（不许分裂） ===')
feed(ROOM, anonUser('dou2056511', 52, startedAt + 5000).items, anonUser('dou2056511', 52, startedAt + 5000).users)
await analyzerHub.flushForTest()
await new Promise((resolve) => setTimeout(resolve, 200))
const after = await mapper.listUsersPage(ROOM, 'recent', '', 100)
const anonAfter = after.rows.filter((row) => anon.isAnonymousId(row.userId))
check('匿名档案仍然是三份（没有多出一份）', anonAfter.length, 3)
check(
  'dou2056511 那一份变成 2 条弹幕',
  anonAfter.find((row) => (row.nickname ?? '').includes('dou2056511'))?.stats.chat,
  2
)

console.log('\n=== 4. 认不出人的匿名帧：不建档案，也不写进用户维度 ===')
const ghostAt = startedAt + 6000
feed(
  ROOM,
  [{ id: 0, kind: 'chat', user: '', userId: '111111', text: '我是谁', count: 0, diamonds: 0, toUser: '', toUserId: '', at: ghostAt }],
  []
)
await analyzerHub.flushForTest()
await new Promise((resolve) => setTimeout(resolve, 200))
const ghostRows = (await mapper.queryMessages({ webRid: ROOM, limit: 200 })).rows.filter(
  (row) => row.kind === 'chat' && row.text === '我是谁'
)
/**
 * 这一帧既没有名字也没有等级——认不出是谁。宁可**不记**（它会写进一条没有身份的共用行），
 * 也不能把它算到某个匿名马甲头上（那才是用户说的「内容重复」）。
 */
check('认不出人的帧不落用户维度（宁缺勿并）', ghostRows.length, 0)
const ghostProfiles = (await mapper.listUsersPage(ROOM, 'recent', '', 200)).rows.filter(
  (row) => row.userId === '111111'
)
check('没有为「认不出的人」建 111111 的共用档案', ghostProfiles.length, 0)

/* ------------------------------------------- 历史数据：把旧库那种「都挤在 111111」重排一次 */

console.log('\n=== 5. 历史重排：旧库（所有匿名挤在一个 id 上）→ 按马甲散开 ===')
const LEGACY = '880000000002'
await mapper.upsertRoom({ webRid: LEGACY, roomId: '1002', title: '旧库房间', anchor: '', cover: '', onlineText: '', status: 'ended' })
/**
 * 旧库的真实形状（2026-10-12 查用户库副本）：**消息流水里十几个马甲名挤在一个 `user_id = 111111` 上，
 * 而档案行只剩最后一个马甲**（`(web_rid, user_id)` 是唯一键，后写的覆盖了先写的）。
 * 所以重排要同时对付两种来源：档案里的马甲、以及只在消息行里出现过的马甲。
 */
await mapper.insertMessages([
  { webRid: LEGACY, sessionId: 1, kind: 'chat', userId: '111111', userName: 'dou2056511', content: '好久没玩了', count: 0, diamonds: 0, toUserId: '', toUserName: '', orderKey: '', atMs: startedAt },
  { webRid: LEGACY, sessionId: 1, kind: 'chat', userId: '111111', userName: 'dou4546310', content: '新年快乐', count: 0, diamonds: 0, toUserId: '', toUserName: '', orderKey: '', atMs: startedAt + 1 },
  { webRid: LEGACY, sessionId: 1, kind: 'member', userId: '111111', userName: 'dou2056511', content: '', count: 30, diamonds: 0, toUserId: '', toUserName: '', orderKey: '', atMs: startedAt + 2 },
  { webRid: LEGACY, sessionId: 1, kind: 'gift', userId: '111111', userName: 'dou4546310', content: '小心心', count: 1, diamonds: 1, toUserId: '', toUserName: '少女', orderKey: '', atMs: startedAt + 3 }
])
await mapper.upsertUserDeltas([
  {
    webRid: LEGACY,
    userId: '111111',
    displayId: '',
    nickname: 'dou2056511',
    gender: 0,
    signature: '',
    city: '',
    avatar: '',
    following: 0,
    follower: 0,
    honorLevel: 52,
    fansClubLevel: 0,
    badges: '[]',
    secUid: '',
    delta: { chat: 1, enter: 1, like: 0, follow: 0, gift: 0, diamonds: 0 },
    firstSeen: startedAt,
    lastSeen: startedAt + 2
  }
])
const beforeSplit = await mapper.listUsersPage(LEGACY, 'recent', '', 50)
const rawBefore = await mapper.queryMessages({ webRid: LEGACY, limit: 50 })
show('旧库消息行（4 条都挤在 111111 上，名字各不相同）', rawBefore.rows.map((r) => [r.userId, r.user, r.kind]))
check('旧库形态：档案只剩最后写进来的那个马甲（另一个只在消息流水里）', beforeSplit.rows.filter((row) => row.userId === '111111').length, 1)
show('旧库档案', beforeSplit.rows[0]?.userId)
const moved = await mapper.splitAnonymousIdentities()
console.log(`      重排了 ${moved} 行`)
const rawAfter = await mapper.listUsersPage(LEGACY, 'recent', '', 50)
const afterSplit = rawAfter.rows
show('重排后的档案（user_id / 昵称 / 弹幕累计）', afterSplit.map((r) => [r.userId, r.nickname, r.stats.chat]))
const splitIds = afterSplit.map((row) => row.userId).sort()
show('重排后的身份', splitIds)
check('旧的共享 id 不再有档案行', afterSplit.filter((row) => row.userId === '111111').length, 0)
check('档案里的马甲与只在流水里的马甲都各成一把键', splitIds.length, 2)
check('两把键都是「anon:占位 id#马甲」的形状', splitIds.every((id) => id.startsWith('anon:111111#')), true)
const second = await mapper.splitAnonymousIdentities()
check('幂等：跑第二遍什么都不改', second, 0)
const afterRows = (await mapper.queryMessages({ webRid: LEGACY, limit: 50 })).rows
check('消息流水全部换到新身份上（不再有 111111）', afterRows.filter((row) => row.userId === '111111').length, 0)
check('两条弹幕各自归位（一条 dou2056511、一条 dou4546310）', [
  afterRows.filter((row) => row.kind === 'chat' && (row.user ?? '').includes('dou2056511')).length,
  afterRows.filter((row) => row.kind === 'chat' && (row.user ?? '').includes('dou4546310')).length
], [1, 1])
check('礼物与进场也各归各的', [
  afterRows.filter((row) => row.kind === 'gift').length,
  afterRows.filter((row) => row.kind === 'member').length
], [1, 1])
check('每条弹幕只算在说那句话的人头上（旧的合账被丢掉、按流水重算）', afterSplit.map((row) => row.stats.chat).sort(), [1, 1])
/** 三个身份加起来仍是 4 条（没有凭空多出行来） */
check('总行数没变（拆分不复制数据）', afterRows.length, 4)

/* ------------------------------------------------ 「查看真实资料」：匿名的人也要能点（用户要求） */

console.log('\n=== 6. 匿名档案的「查看真实资料」：按钮能点、判定要严 ===')
const mask = 'dou2056511'
const target = { mask, follower: 9974, following: 12 }
const candidate = (userId, nickname, follower, following) => ({ userId, nickname, follower, following })
check(
  '四条全中才算同一个人（id 尾段 + 昵称尾段 + 粉丝 + 关注）',
  matchAnonymousCandidate(candidate('73500002056511', mask, 9974, 12), target),
  true
)
check('id 尾段不对 → 不算', matchAnonymousCandidate(candidate('73500002056512', mask, 9974, 12), target), false)
check('昵称尾段不对（另一个人）→ 不算', matchAnonymousCandidate(candidate('73500002056511', 'dou9999999', 9974, 12), target), false)
check('粉丝数对不上 → 不算', matchAnonymousCandidate(candidate('73500002056511', mask, 9973, 12), target), false)
check('关注数对不上 → 不算', matchAnonymousCandidate(candidate('73500002056511', mask, 9974, 13), target), false)
check('昵称不是马甲名（真名字）→ 不算', matchAnonymousCandidate(candidate('73500002056511', '张三', 9974, 12), target), false)

/** 正式链路：库里没有全中的候选 → 如实回 `anonymousMasked`，绝不给「猜的那个人」 */
const masked = await revealAnonymousProfile({ webRid: ROOM, userId: 'anon:111111#dou2056511', ...target }, async () => [])
check('核不上 → 回 anonymousMasked（如实说还原不了）', masked, { ok: false, code: 'anonymousMasked' })
/** 连马甲名都没有（空名帧）→ 同样如实回，不去打抖音 */
const noLead = await revealAnonymousProfile(
  { webRid: ROOM, userId: 'anon:111111', mask: '', follower: 0, following: 0 },
  async () => {
    throw new Error('不该查库')
  }
)
check('没有线索 → 回 anonymousMasked，且不查库', noLead, { ok: false, code: 'anonymousMasked' })

/* ------------------------------------------------ 真库副本上的历史重排（另开一个进程做） */
if (sourceDir) {
  console.log('\n=== 6. 真库副本上的重排 ===')
  console.log(`      ⚠️ 这个工装的内存库已经建好了，不能中途换库——真库副本请跑：`)
  console.log(`         $env:DY_DB_DIR="${sourceDir}"; node plugins/douyin-link/spike/anon-migrate-check.mjs`)
}

await mod.closeOrm?.()
console.log(`\n=== 小结 ===\n${failures === 0 ? '✓ 全部断言通过' : `✗ ${failures} 项断言失败`}`)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
