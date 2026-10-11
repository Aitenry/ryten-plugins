/**
 * 档案「互动统计」与「每日收益」日历的回归工装（离线，真 PGlite + 真 mapper + 真 hub 月份助手）。
 *
 * 用户 2026-10-11：
 * 「这个互动统计（本房间累计）需要所有直播间统计，并且礼物价值要改成送礼和收礼两个统计，
 *   点击后可以查看每一个月的每一天送礼和收礼的抖币」。
 *
 * 断言分三段：
 *
 * A. 纯函数 `hub.monthBucketRange`：`YYYY-MM` → 该月第一天/最后一天的**本地日桶**，
 *    并且与 mapper 里 `floor((at_ms + 偏移) / 86400000)` 的口径对得上（拿本地某天的时刻验）；
 * B. `mapper.userStatsAnyRoom`：**跨房间**把互动合起来（发言/进场/点赞/关注/送礼次数/送礼抖币），
 *    **收礼抖币按收礼人另算**，而且①自己给自己送的不算收礼、②认不出收礼人的礼物两边都不算；
 * C. `mapper.userGiftDays` + `userGiftMonths`：按**本地自然日**给出每天的送礼/收礼抖币，
 *    只回有记录的日子；月份清单倒序、只算送礼/收礼都算「有记录」。
 *
 * 跑法（需要一个 PGlite；默认从 ryten-bench 仓库里找，或用 RB_PGLITE 指到 dist/index.js）：
 *   node plugins/douyin-link/spike/user-calendar-check.mjs
 * 数据目录是临时目录，**不碰**应用的真实库。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const workDir = mkdtempSync(join(tmpdir(), 'douyin-user-calendar-'))
const dataDir = join(workDir, 'pglite')

function resolvePglite() {
  const candidates = [process.env.RB_PGLITE]
  candidates.push('E:\\Development-Warehouse\\github\\ryten-bench\\node_modules\\@electric-sql\\pglite\\dist\\index.js')
  for (const path of candidates) if (path && existsSync(path)) return path
  console.error('找不到 @electric-sql/pglite，可用 RB_PGLITE=<dist/index.js 路径> 指定')
  process.exit(2)
}
const pglitePath = resolvePglite()

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
const logStub = join(workDir, 'log-stub.mjs')
writeFileSync(
  logStub,
  `export default { info() {}, warn() {}, error() {}, debug() {} }\n`,
  'utf8'
)

/* ------------------------------------------------------------------ 测试数据 */

const ME = '9001' // 主角：两个房间都出现过
const PEER = '9002' // 给他送礼的人
const SELF = '9003' // 自己给自己送的人（自环，不算收礼）
const ANON_TO = '' // 认不出收礼人的礼物

/**
 * 时间用**本地时间**构造（不带 Z），这样「本地自然日」就是我们要的那一天——
 * 与 `dayRecords` / `userGiftDays` 的分天口径一致。
 */
const AT = {
  /** 本月：8 号我送出一份跑车（1200 抖币） */
  m8: new Date('2026-10-08T12:00:00').getTime(),
  /** 本月：8 号我收到两份礼物（99 + 1） */
  m8b: new Date('2026-10-08T13:00:00').getTime(),
  /** 本月：9 号我只收到（500） */
  m9: new Date('2026-10-09T09:30:00').getTime(),
  /** 上个月 */
  prev: new Date('2026-09-20T20:00:00').getTime()
}

const entry = `
import { withOrm, closeOrm } from '@host/main/database/orm'
import { insertMessages, upsertUserDeltas, userStatsAnyRoom, userGiftDays, userGiftMonths, clearUsers, queryMessages } from './db/mapper'

const ROOM_A = '700000000001'
const ROOM_B = '700000000002'
const ME = '${ME}'
const PEER = '${PEER}'
const SELF = '${SELF}'
const AT = ${JSON.stringify(AT)}

const row = (over) => ({
  webRid: ROOM_A,
  sessionId: 1,
  kind: 'gift',
  userId: '',
  userName: '',
  content: '跑车',
  count: 1,
  diamonds: 0,
  toUserId: '',
  toUserName: '',
  orderKey: '',
  giftRecord: true,
  atMs: 0,
  ...over
})

/** 一条礼物：送礼人 → 收礼人 */
const gift = (at, from, to, diamonds, webRid = ROOM_A) =>
  row({ webRid, atMs: at, userId: from, userName: from === ME ? '我' : '对方', toUserId: to, toUserName: to ? '收礼人' : '', diamonds })

/* 消息流水：送礼 1200（本月 8 号，送给 PEER）；收礼 99 + 1（本月 8 号）+ 500（本月 9 号）+ 上个月 700 */
await insertMessages([
  gift(AT.m8, ME, PEER, 1200),
  gift(AT.m8b, PEER, ME, 99),
  gift(AT.m8b + 60000, PEER, ME, 1),
  gift(AT.m9, PEER, ME, 500, ROOM_B),
  gift(AT.prev, PEER, ME, 700, ROOM_B),
  /* 自环：自己给自己送 300（该算「送出」，但两个方向的收礼数字都不该被它灌水） */
  gift(AT.m8b + 120000, SELF, SELF, 300),
  /* 认不出收礼人的礼物 50：送礼人算得出（PEER 送出 50 → 他的送礼抖币会多这 50），收礼那边谁都不算 */
  gift(AT.m9 + 60000, PEER, '${ANON_TO}', 50, ROOM_B),
  /* 非礼物：不该进任何一个礼物数字 */
  row({ webRid: ROOM_A, kind: 'chat', userId: ME, userName: '我', content: '你好', atMs: AT.m8, diamonds: 0 })
])

/* 用户档案行：跨房间各一份累计（互动统计就是把它们加起来） */
const userDelta = (webRid, userId, over = {}) => ({
  webRid,
  userId,
  displayId: '',
  nickname: userId === ME ? '我' : '对方',
  gender: 0,
  signature: '',
  city: '',
  avatar: '',
  following: 0,
  follower: 0,
  honorLevel: 0,
  fansClubLevel: 0,
  badges: '[]',
  secUid: '',
  delta: { chat: 0, enter: 0, like: 0, follow: 0, gift: 0, diamonds: 0 },
  firstSeen: AT.prev,
  lastSeen: AT.m9,
  ...over
})
await upsertUserDeltas([
  /* A 房：发言 3、进场 1、点赞 2、关注 1、送礼 1 次 / 1200 抖币 */
  userDelta(ROOM_A, ME, {
    delta: { chat: 3, enter: 1, like: 2, follow: 1, gift: 1, diamonds: 1200 }
  }),
  /* B 房：发言 5、进场 2、送礼 0 次 / 0 抖币 */
  userDelta(ROOM_B, ME, {
    delta: { chat: 5, enter: 2, like: 0, follow: 0, gift: 0, diamonds: 0 }
  }),
  /* 另一个人（确认按 id 分开算）：档案里送出 3 次 / 849 抖币，而流水里他送出 1200 + 50 */
  userDelta(ROOM_A, PEER, {
    delta: { chat: 1, enter: 0, like: 0, follow: 0, gift: 3, diamonds: 849 }
  }),
  /* 自环送礼的人：也有档案行（送礼抖币来自档案表） */
  userDelta(ROOM_A, SELF, {
    delta: { chat: 0, enter: 0, like: 0, follow: 0, gift: 1, diamonds: 300 }
  })
])

/*
 * 口径（读这个工装前先记住）：userStatsAnyRoom(ids) 里的 ids 是**一个人名下的全部账号**
 * （hub 只在 accountIdsOf 之后调用它）。所以「自环」= 这批 id 内部互相送的礼物，会被排掉。
 * 验不同的人时，就必须**一个人一个人地查**——把三个人塞进一次调用等于告诉他们是一个人。
 */
const stats = await userStatsAnyRoom([])
for (const id of [ME, PEER, SELF]) {
  const one = await userStatsAnyRoom([id])
  const hit = one.get(id)
  if (hit) stats.set(id, hit)
}
const statsOf = (id) => {
  const hit = stats.get(id)
  return hit ? { chat: hit.chat, enter: hit.enter, like: hit.like, follow: hit.follow, gift: hit.gift, diamonds: hit.diamonds, received: hit.receivedDiamonds } : null
}
/** 画像内部的自环：把 ME + SELF 当成「一个人名下的两个号」再查一次 */
const boundPair = await userStatsAnyRoom([ME, SELF])

const months = await userGiftMonths([ME])
const dayRange = (month) => {
  const [y, m] = month.split('-').map(Number)
  const offset = -new Date(2026, 9, 15).getTimezoneOffset() * 60000
  const first = new Date(y, m - 1, 1).getTime()
  const last = new Date(y, m, 0).getTime()
  return { from: Math.floor((first - new Date(y, m - 1, 1).getTimezoneOffset() * 60000) / 86400000), to: Math.floor((last - new Date(y, m - 1, 1).getTimezoneOffset() * 60000) / 86400000) }
}
const october = await userGiftDays([ME], dayRange('2026-10').from, dayRange('2026-10').to)
const september = await userGiftDays([ME], dayRange('2026-09').from, dayRange('2026-09').to)

/*
 * 「某一天的明细」要**两个方向都给**（用户 2026-10-11：「礼物历史只能看见送的，没有收的」——
 * 日历那格写着送礼 + 收礼两个数，明细却只给送出）。
 * bothDirections: true = 送礼与收礼从「与」变成「或」，一次查回来。
 */
/* 那一天（本地）的起止：与 shared/gift-calendar.ts 的 dayRangeOf 同一口径，这里就地算 */
const day8 = {
  from: new Date(2026, 9, 8, 0, 0, 0, 0).getTime(),
  to: new Date(2026, 9, 8, 23, 59, 59, 999).getTime()
}
const onlySent = await queryMessages({ kind: 'gift', userIds: [ME], from: day8.from, to: day8.to })
const onlyReceived = await queryMessages({ kind: 'gift', toUserIds: [ME], from: day8.from, to: day8.to })
const both = await queryMessages({
  kind: 'gift',
  userIds: [ME],
  toUserIds: [ME],
  bothDirections: true,
  from: day8.from,
  to: day8.to
})
const summary = (page) => page.rows.map((row) => row.userId + '->' + row.toUserId + ':' + row.diamonds).sort()
/* 清空用户表后：没有档案行的人也应该算得出收礼（收礼是从流水里来的） */
await clearUsers()
const noProfile = await userStatsAnyRoom([ME])

await closeOrm()
export default JSON.stringify({
  me: statsOf(ME),
  peer: statsOf(PEER),
  self: statsOf(SELF),
  boundReceived: (() => {
    const me = boundPair.get(ME)
    const self = boundPair.get(SELF)
    return { meReceived: me?.receivedDiamonds ?? -1, selfReceived: self?.receivedDiamonds ?? -1 }
  })(),
  unknownUser: noProfile.has('9999'),
  meAfterClear: (() => { const hit = noProfile.get(ME); return hit ? { chat: hit.chat, diamonds: hit.diamonds, received: hit.receivedDiamonds } : null })(),
  months,
  october: october.map((d) => ({ day: d.day, sent: d.sent, received: d.received, sentGifts: d.sentGifts, receivedGifts: d.receivedGifts })),
  september: september.map((d) => ({ day: d.day, sent: d.sent, received: d.received })),
  dayDetail: {
    sent: summary(onlySent),
    received: summary(onlyReceived),
    both: summary(both),
    bothTotal: both.total
  }
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

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`
  )
}

/* --------------------------------------------- A. 月份 → 本地日桶（真 hub 的纯函数） */

const { monthBucketRange, dayBucketOf, dayRangeOf } = await import(
  pathToFileURL(join(ROOT, 'plugins/douyin-link/shared/gift-calendar.ts')).href
)
console.log('=== A. 月份 → 本地日桶 ===')
const oct = monthBucketRange('2026-10')
check('10-01 的桶就是月初', dayBucketOf(new Date(2026, 9, 1, 12).getTime()), oct.from)
check('10-31 的桶就是月末', dayBucketOf(new Date(2026, 9, 31, 12).getTime()), oct.to)
check('9 月最后一天不在 10 月范围里', dayBucketOf(new Date(2026, 8, 30, 12).getTime()) < oct.from, true)
check('11-01 不在 10 月范围里', dayBucketOf(new Date(2026, 10, 1, 12).getTime()) > oct.to, true)
check('非法月份给空范围（from > to）', monthBucketRange('2026-13').from > monthBucketRange('2026-13').to, true)
check('非法字符串给空范围', monthBucketRange('').from > monthBucketRange('').to, true)
/* 桶 ↔ 时刻来回换算必须自洽：界面点格子拿 `dayRangeOf` 去查明细，错一天就是查错天 */
const day9 = dayBucketOf(new Date(2026, 9, 9, 9).getTime())
const range9 = dayRangeOf(day9)
check(
  '某个桶摊回时刻：正好是那一天的 00:00:00.000 → 23:59:59.999',
  [
    new Date(range9.from).getDate(),
    new Date(range9.from).getHours(),
    new Date(range9.from).getMinutes(),
    new Date(range9.to).getDate(),
    new Date(range9.to).getHours(),
    new Date(range9.to).getMinutes()
  ],
  [9, 0, 0, 9, 23, 59]
)
check('而且再算回桶还是它自己', dayBucketOf(range9.from), day9)

/* ------------------------------- B/C. 真库：跨房间合计 + 逐日送礼/收礼 ------------------------------- */

const mod = await import(pathToFileURL(outfile).href)
const result = JSON.parse(mod.default ?? '{}')

console.log('\n=== B. 互动统计：跨房间合计，送礼 / 收礼分开 ===')
check('发言 = A 房 3 + B 房 5（跨房间相加）', result.me.chat, 8)
check('进场 = 1 + 2', result.me.enter, 3)
check('点赞 = 2 + 0', result.me.like, 2)
check('关注 = 1 + 0', result.me.follow, 1)
check('送礼次数 = 1 + 0', result.me.gift, 1)
check('送礼抖币 = 1200 + 0（只算送出的）', result.me.diamonds, 1200)
check('收礼抖币 = 99 + 1 + 500 + 700（跨房间、跨月，按收礼人现算）', result.me.received, 1300)
check('另一个人按 id 分开算（收礼 = 我送给他的 1200）', result.peer, {
  chat: 1,
  enter: 0,
  like: 0,
  follow: 0,
  gift: 3,
  diamonds: 849,
  received: 1200
})
check(
  '自环（自己给自己送 300）：送礼算送出，收礼不灌水',
  { sent: result.self?.diamonds ?? 0, received: result.self?.received ?? 0 },
  { sent: 300, received: 0 }
)
check(
  '画像内部的自环：自环那 300 不计进任何一边的「收礼」',
  result.boundReceived,
  { meReceived: 1300, selfReceived: 0 }
)
check(
  '清空用户档案后：收礼仍算得出（收礼来自流水），互动数归 0',
  result.meAfterClear,
  { chat: 0, diamonds: 0, received: 1300 }
)

console.log('\n=== C. 每日收益：逐日送礼 / 收礼 + 月份清单 ===')
check('月份清单（倒序，10 月在前）', result.months.slice(0, 2), ['2026-10', '2026-09'])
check(
  '10 月只回有记录的 8 号与 9 号',
  result.october.map((d) => d.day),
  ['2026-10-08', '2026-10-09']
)
check('10-08：送出 1200、收到 100（99 + 1）', [result.october[0].sent, result.october[0].received], [1200, 100])
check('10-08：送礼 1 件、收礼 2 件', [result.october[0].sentGifts, result.october[0].receivedGifts], [1, 2])
check('10-09：只收到 500（那一天没送过）', [result.october[1].sent, result.october[1].received], [0, 500])
check('9 月那天的 700 落在 9 月，不在 10 月', result.september.map((d) => [d.day, d.received]), [['2026-09-20', 700]])
check('9 月那天没有送礼', result.september[0].sent, 0)

console.log('\n=== D. 某一天的礼物明细：送出与收到都要有 ===')
/*
 * 10-08 那一天：我送出 1 件（给 PEER 1200）、收到 2 件（PEER 给的 99 + 1）。
 * 只查「送」或只查「收」各得一半；`bothDirections` 一次拿全——这就是用户说的
 * 「礼物历史只能看见送的，没有收的」要修的那条。
 */
check('只按送礼人查：只有那条送出的', result.dayDetail.sent, [`${ME}->${PEER}:1200`])
check(
  '只按收礼人查：只有那两条收到的',
  result.dayDetail.received,
  [`${PEER}->${ME}:1`, `${PEER}->${ME}:99`]
)
check(
  '两个方向都要：三条都在（送出 + 收到）',
  result.dayDetail.both,
  [`${ME}->${PEER}:1200`, `${PEER}->${ME}:1`, `${PEER}->${ME}:99`]
)
check('总数也是三条（分页不会少算）', result.dayDetail.bothTotal, 3)

console.log(`\n=== 小结 ===\n${failures === 0 ? '✓ 全部断言通过' : `✗ ${failures} 项断言失败`}`)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
