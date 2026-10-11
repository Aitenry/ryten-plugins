/**
 * 个播「收礼物榜」空榜的回归工装（离线，真 PGlite + 真 recorder + 真 mapper）。
 *
 * 报障（2026-10-11 用户）：「解决个播没有显示收礼物榜内容」——截图里 KPI 有 4,072 件礼物、
 * 6,315 抖币，收礼物榜却写着「这段时间里还没有人收到礼物」。真库副本实测：
 *
 * | web_rid | 礼物行 | 带收礼人(to_user_id) |
 * | --- | --- | --- |
 * | 108011161837（语音房） | 750 | 750 |
 * | 895805895016（语音房） | 504 | 504 |
 * | 41498419462（个播） | 4077 | **0** |
 *
 * 根因：抖音只在**一部分房间类型**的 `WebcastGiftMessage` 里下发 `toUser`（字段 8），
 * 个播一帧都不给；而收礼物榜按 `to_user_id` 分组、空串被 `<> ''` 滤掉 → 榜单整张空。
 *
 * 这个工装做两件事，全部打在**真代码**上（不是替身）：
 *
 * A. 纯函数 `shared/gift-recipient.ts`：帧里有收礼人 → 用帧里的；麦上只有一个人 → 用他；
 *    **个播（从没同步过麦位）过了观察窗口 → 用主播**；语音房没同步到麦位 + 帧里也没有 → 空（不编人）。
 * B. 端到端（真 recorder 的 ingest → 真 mapper 落库 → 真 `giftRankByPerson('recipient')` 出榜）：
 *    ① 个播房间：三件「帧里没有收礼人」的礼物 → 收礼物榜上是主播一个人（3 件 / 全部抖币），
 *       而且榜上显示的是**主播昵称**（不是一串抖音号）；
 *    ② 语音房房间：帧里带收礼人 → 照旧按帧里的收礼人聚合（新逻辑不许改动已有口径）；
 *    ③ 麦上单人：帧里没有、麦位表只有一个 id → 记给麦上那个人（不管他是不是主播）。
 *
 * 跑法（需要一个 PGlite；默认从 ryten-bench 仓库里找，或用 RB_PGLITE 指到 dist/index.js）：
 *   node plugins/douyin-link/spike/gift-recipient-check.mjs
 * 数据目录是临时目录，**不碰**应用的真实库。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const workDir = mkdtempSync(join(tmpdir(), 'douyin-gift-recipient-'))
const dataDir = join(workDir, 'pglite')

function resolvePglite() {
  const candidates = [process.env.RB_PGLITE]
  candidates.push('E:\\Development-Warehouse\\github\\ryten-bench\\node_modules\\@electric-sql\\pglite\\dist\\index.js')
  for (const path of candidates) if (path && existsSync(path)) return path
  console.error('找不到 @electric-sql/pglite，可用 RB_PGLITE=<dist/index.js 路径> 指定')
  process.exit(2)
}
const pglitePath = resolvePglite()

/* --------------------------------------------------------- 宿主桩（与 db-merge-check 同口径） */

const ormStub = join(workDir, 'orm-stub.mjs')
writeFileSync(
  ormStub,
  `import { drizzle } from 'drizzle-orm/pglite'\n` +
    `import { PGlite } from '@electric-sql/pglite'\n` +
    `let client = null\n` +
    `let orm = null\n` +
    `export async function withOrm(_op, fn) {\n` +
    `  if (!client) {\n` +
    `    client = new PGlite(process.env.DY_PGLITE_DIR)\n` +
    `    orm = drizzle(client)\n` +
    `  }\n` +
    `  return fn(orm)\n` +
    `}\n` +
    `export async function closeOrm() { if (client) await client.close() }\n`,
  'utf8'
)

const pgliteShim = join(workDir, 'pglite-shim.mjs')
writeFileSync(
  pgliteShim,
  `const url = process.env.DY_PGLITE_URL\n` +
    `const mod = await import(url)\n` +
    `export const PGlite = mod.PGlite\n` +
    `export const types = mod.types\n` +
    `export default mod\n`,
  'utf8'
)

/** electron-log 桩：写库告警会落在这里，工装顺带断言「一条告警都没有」 */
const logStub = join(workDir, 'log-stub.mjs')
writeFileSync(
  logStub,
  `const calls = (globalThis.__DOUYIN_LOG_CALLS__ ??= [])\n` +
    `const push = (level) => (...args) => { calls.push([level, args.map((a) => String(a)).join(' ')]) }\n` +
    `export default { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }\n`,
  'utf8'
)

/* --------------------------------------------------------------- 被测入口 */

const ANCHOR_ID = '101181076471'
const ANCHOR_NAME = '幸福的小羊羊'
const SOLO_ROOM = '41498419462'
const VOICE_ROOM = '108011161837'
const MIC_ROOM = '895805895016'

/**
 * 一条礼物项：形状与 `decodeProtoGift` 产出的 `DanmakuItem` 一致（帧里给不给收礼人由参数决定）。
 *
 * 两条与真实数据对齐的口径（第一版工装写错过，折腾了一轮）：
 * - `count` 是**服务端推的累积连送量**（同一组 `group_id` 反复推 1→2→5），落库前由
 *   `main/gift/group.ts` 去重成「本次增量」——所以每件礼物最后都只算 1 件（见断言）；
 * - `groupId` 必须**每件都不同**（真实的 `group_id` 就是一次连送一个）：共用一个组 id 时
 *   第二件会被当成「同一次连送的累积量重复帧」丢掉——工装里表现为「窗外那件凭空消失」。
 * `at` 取虚拟时钟（recorder 的窗口逻辑也走同一个 `setNow`），别用真实时间。
 */
const gift = (seq, { userId, userName, name, count, diamonds, toUserId = '', toUser = '' }) => ({
  id: seq,
  kind: 'gift',
  user: userName,
  userId,
  text: name,
  count,
  diamonds,
  toUser,
  toUserId,
  trace: 'proto-gift',
  giftId: 10990,
  groupId: `group-${seq}`,
  giftRecord: true,
  at: nowMs()
})

const entry = `
import { withOrm, closeOrm } from '@host/main/database/orm'
import { RoomRecorder, setNow } from './monitor/recorder'
import { insertMessages, upsertUserDeltas, giftRankByPerson } from './db/mapper'

/** 虚拟时钟：个播的「观察窗口」要靠它跨过去（见 recorder 的 setNow 注释） */
let graceAt = 1_800_000_000_000
setNow(() => graceAt)
/** 工装自己也在虚拟时钟上（gift() 的 at 用它），否则消息时间戳与窗口不同源 */
const nowMs = () => graceAt

const ANCHOR = { id: '${ANCHOR_ID}', displayId: 'x', nickname: '${ANCHOR_NAME}', gender: 1, signature: '', city: '', avatar: '', following: 0, follower: 0, honorLevel: 0, fansClubLevel: 0, badges: [], secUid: '' }
const gift = ${gift.toString()}

/** 把记录器这一场的增量全写进库（hub 的 flush 就是这么做的） */
async function flush(recorder) {
  const messages = recorder.takeMessages()
  await insertMessages(messages)
  await upsertUserDeltas(recorder.takeUserDeltas(500))
  recorder.takeMinutes()
  return messages
}
async function board(webRid) {
  const rows = await giftRankByPerson(webRid, 'recipient', 0, 1e15)
  return rows.map((row) => ({ userId: row.userId, name: row.name, count: row.count, diamonds: row.diamonds }))
}
/** 工装自己收的中间结果（check 要在 import 之后才定义，这里先攒着） */
const later = {}

/* ① 个播：帧里一律没有收礼人（真库 4077/4077 就是这样） → 应该记到主播头上 */
const solo = new RoomRecorder('${SOLO_ROOM}')
solo.begin(1, 200)
solo.setAnchor(ANCHOR)
const soloSenders = ['2200597152143347', '3664014665071789']
solo.ingest([
  gift(1, { userId: soloSenders[0], userName: 'D·Z', name: '人气票', count: 27, diamonds: 573 }),
  gift(2, { userId: soloSenders[1], userName: '张开森', name: '粉丝团灯牌', count: 231, diamonds: 300 })
], [])
/**
 * 观察窗口（60s）内的礼物**先不认收礼人**：这是刻意的——语音房的麦位表是异步同步过来的，
 * 刚连上时它和个播长得一模一样。窗口内那一批落库时收礼人留空（榜单上不出现，也不会认错人）。
 * ⚠️ 这一批是**真的**落库了（下面的 flush 会写进去），所以断言里要看得到它们。
 */
const graceRows = await flush(solo)
later.graceRecipients = graceRows.map((row) => row.toUserId)
const soloBoardDuringGrace = await board('${SOLO_ROOM}')

/*
 * 过了窗口再来一件：这时才敢认定「这是个播」，新的那件记到主播头上。
 *
 * 时钟用记录器自带的 setNow() 注入（不是改全局 Date.now——第一版工装就是那么写的，
 * 结果 ingest 把时刻捕获在闭包里，拨钟根本没生效，窗口永远不过期，白折腾一轮）。
 * 顺序照真实 hub：**这一帧先进来（记下时刻），下一次 flush 才取走**。
 */
setNow(() => graceAt + 61000)
solo.ingest([gift(3, { userId: soloSenders[0], userName: 'D·Z', name: '小心心', count: 1, diamonds: 1 })], [])
const afterWindowRows = solo.takeMessages()
setNow(null)
later.afterWindow = afterWindowRows.map((row) => row.toUserId)
await insertMessages(afterWindowRows)
await upsertUserDeltas(solo.takeUserDeltas(500))
const soloBoard = await board('${SOLO_ROOM}')

/* ② 语音房：帧里有收礼人 → 照旧按帧里的收礼人 */
const voice = new RoomRecorder('${VOICE_ROOM}')
voice.begin(1, 200)
voice.setAnchor(ANCHOR)
voice.setMicUsers(['2450167593701709', '4389723295454568'])
voice.ingest([
  gift(4, { userId: 'S1', userName: '阿拉', name: '跑车', count: 1, diamonds: 1200, toUserId: '2450167593701709', toUser: '软软呀ఇ' }),
  gift(5, { userId: 'S2', userName: '阿丙', name: '礼花筒', count: 2, diamonds: 199, toUserId: '4389723295454568', toUser: '少女 ఇ' })
], [])
await flush(voice)
const voiceBoard = await board('${VOICE_ROOM}')

/* ③ 麦上单人：帧里没有收礼人、麦位表只有一个人（不是主播） */
const mic = new RoomRecorder('${MIC_ROOM}')
mic.begin(1, 200)
mic.setAnchor(ANCHOR)
mic.setMicUsers(['555000111222'])
mic.ingest([gift(6, { userId: 'S3', userName: '看客', name: '小心心', count: 3, diamonds: 3 })], [])
await flush(mic)
const micBoard = await board('${MIC_ROOM}')

/* 语音房「麦位同步过、但此刻没人」+ 帧里也没有收礼人 → 不许记到主播头上（不编数据） */
const voiceIdle = new RoomRecorder('999000000001')
voiceIdle.begin(1, 200)
voiceIdle.setAnchor(ANCHOR)
voiceIdle.setMicUsers([])
graceAt += 61000
voiceIdle.ingest([gift(7, { userId: 'S4', userName: '路人', name: '玫瑰', count: 1, diamonds: 10 })], [])
await flush(voiceIdle)
const voiceIdleBoard = await board('999000000001')

const warnings = (globalThis.__DOUYIN_LOG_CALLS__ ?? []).filter(([level]) => level === 'warn' || level === 'error')
await closeOrm()
export default JSON.stringify({
  graceRecipients: later.graceRecipients,
  afterWindow: later.afterWindow,
  soloBoardDuringGrace,
  soloBoard,
  voiceBoard,
  micBoard,
  voiceIdleBoard,
  warnings: warnings.map(([, text]) => text.slice(0, 160))
})
`

const outfile = join(workDir, 'check.mjs')
await build({
  stdin: {
    contents: entry,
    loader: 'ts',
    resolveDir: join(ROOT, 'plugins/douyin-link/main')
  },
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'silent',
  nodePaths: [join(ROOT, 'node_modules')],
  plugins: [
    {
      name: 'stub-host',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@host\/main\/database\/orm$/ }, () => ({ path: ormStub }))
        buildApi.onResolve({ filter: /^electron-log$/ }, () => ({ path: logStub }))
        buildApi.onResolve({ filter: /^@electric-sql\/pglite$/ }, () => ({ path: pgliteShim }))
      }
    }
  ]
})

process.env.DY_PGLITE_DIR = dataDir
process.env.DY_PGLITE_URL = pathToFileURL(pglitePath).href

/* --------------------------------------------------- A. 纯函数（先跑，失败也继续） */

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`
  )
}

const { resolveGiftRecipient, GIFT_RECIPIENT_GRACE_MS } = await import(
  pathToFileURL(join(ROOT, 'plugins/douyin-link/shared/gift-recipient.ts')).href
)

const room = (over) => ({ anchorId: ANCHOR_ID, anchorName: ANCHOR_NAME, micUsers: [], noRecipientSince: 0, ...over })
const frame = (over) => ({ id: '', name: '', ...over })

console.log('=== A. 收礼人推断（纯函数） ===')
check('窗口 = 60 秒', GIFT_RECIPIENT_GRACE_MS, 60000)
check(
  '帧里有收礼人 → 用帧里的（哪怕不是主播）',
  resolveGiftRecipient(frame({ id: 'R9', name: '别人' }), room({ micUsers: ['X'] }), 1e12),
  { toUserId: 'R9', toUserName: '别人' }
)
check(
  '麦上只有一个人 → 用麦上那个人（不管是不是主播）',
  resolveGiftRecipient(frame({}), room({ micUsers: ['MIC1'] }), 0),
  { toUserId: 'MIC1', toUserName: '' }
)
check(
  '麦上只有主播一个人 → 用主播（名字跟着走）',
  resolveGiftRecipient(frame({}), room({ micUsers: [ANCHOR_ID] }), 0),
  { toUserId: ANCHOR_ID, toUserName: ANCHOR_NAME }
)
check(
  '个播 + 刚起步（窗口内）→ 先别认（不编人）',
  resolveGiftRecipient(frame({}), room({ noRecipientSince: 1_000_000 }), 1_000_000 + 59_000),
  { toUserId: '', toUserName: '' }
)
check(
  '个播 + 过了窗口 → 主播',
  resolveGiftRecipient(frame({}), room({ noRecipientSince: 1_000_000 }), 1_000_000 + 60_000),
  { toUserId: ANCHOR_ID, toUserName: ANCHOR_NAME }
)
check(
  '不知道谁是主播 → 谁都不认',
  resolveGiftRecipient(frame({}), room({ anchorId: '', anchorName: '', noRecipientSince: 1 }), 1e12),
  { toUserId: '', toUserName: '' }
)
check(
  '麦上多人 + 帧里没有 → 不认（宁可少一行，也不给错人）',
  resolveGiftRecipient(frame({}), room({ micUsers: ['A', 'B'] }), 1e12),
  { toUserId: '', toUserName: '' }
)

/* ------------------------------------------------------ B. 端到端（真 recorder → 真库 → 真榜） */

console.log('\n=== B. 端到端：帧里没有收礼人 → 收礼物榜上是主播 ===')
const mod = await import(pathToFileURL(outfile).href)
const result = JSON.parse(mod.default ?? '{}')

check('个播：窗口内落库的礼物不硬塞收礼人（两条都留空）', result.graceRecipients, ['', ''])
check('个播：这时收礼物榜还是空的（不认人，就不上榜）', result.soloBoardDuringGrace, [])
/*
 * 窗外那件之后：**新落库的那件**记到主播名下。
 * 件数按「连送去重后的本次增量」算（每件 1 件），抖币 = 该件之和
 * ——后一条是既有口径（`main/gift/group.ts`），这里顺带把它钉住。
 */
check('个播：窗外那件在落库时认到了主播', result.afterWindow, [ANCHOR_ID])
check('个播：榜上只有一行（只有认得出的那件）', result.soloBoard.length, 1)
check('个播：榜上那个人就是主播', result.soloBoard[0]?.userId, ANCHOR_ID)
check('个播：件数 1（连送去重后每件 1 件）', result.soloBoard[0]?.count, 1)
check('个播：抖币就是那件的 1', result.soloBoard[0]?.diamonds, 1)
check('个播：榜上显示的是主播昵称，不是一串抖音号', result.soloBoard[0]?.name, ANCHOR_NAME)

console.log('\n=== B2. 语音房口径不变（帧里有收礼人就用帧里的） ===')
check('语音房：按帧里的收礼人各聚一行（两人，件数/抖币来自帧）', result.voiceBoard, [
  { userId: '2450167593701709', name: '软软呀ఇ', count: 1, diamonds: 1200 },
  { userId: '4389723295454568', name: '少女 ఇ', count: 1, diamonds: 199 }
])
check('语音房：收礼人用的是帧里的那个人（没被主播顶掉）', result.voiceBoard[0]?.userId, '2450167593701709')
check('语音房：主播没有凭空出现在榜上', result.voiceBoard.some((row) => row.userId === ANCHOR_ID), false)

console.log('\n=== B3. 麦上单人 / 语音房空麦 ===')
check('麦上单人：礼物记给麦上那个人', result.micBoard, [
  { userId: '555000111222', name: '', count: 1, diamonds: 3 }
])
check('语音房（麦位同步过、此刻没人）：不记到主播头上', result.voiceIdleBoard, [])
check('落库过程没有任何 warn/error', result.warnings, [])

console.log(`\n=== 小结 ===\n${failures === 0 ? '✓ 全部断言通过' : `✗ ${failures} 项断言失败`}`)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
