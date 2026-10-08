/*
 * 「同一单 → 一行」这条规则**在真库上**跑一遍（真 PGlite + 真 drizzle + 真 mapper，不是替身）。
 *
 * 为什么单独写一个：`decoder-check.mjs` 验的是**纯函数**（`mergeGiftRows`），
 * 而真正落库的是 `main/db/mapper.ts` 的 `insertMessages`——它要：
 * ① 建表（`order_key` 列与索引是 0.7.8 新加的，老库靠 `ALTER TABLE … IF NOT EXISTS` 补）；
 * ② 同一单先插一行、后到的那条**更新**那一行（不是再插一行）；
 * ③ 更新时**不许**把已经查到的礼物名与价格抹掉（后到的那条正文只能是「想听 X 演唱」）。
 * 这三条只有连上 PGlite 才能证。
 *
 * 跑法（需要一个 PGlite；默认从 ryten-bench 仓库里找，或用 RB_PGLITE 指定 dist/index.js）：
 *   node plugins/douyin-link/spike/db-merge-check.mjs
 * 数据目录用的是临时目录，**不碰**应用的真实库。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const workDir = mkdtempSync(join(tmpdir(), 'douyin-db-merge-'))
const dataDir = join(workDir, 'pglite')

/** 找宿主那份 PGlite（本脚本不打包依赖，跟 db-inspect.mjs 一个口径） */
function resolvePglite() {
  const candidates = [process.env.RB_PGLITE]
  candidates.push('E:\\Development-Warehouse\\github\\ryten-bench\\node_modules\\@electric-sql\\pglite\\dist\\index.js')
  for (const path of candidates) if (path && existsSync(path)) return path
  console.error('找不到 @electric-sql/pglite，可用 RB_PGLITE=<dist/index.js 路径> 指定')
  process.exit(2)
}
const pglitePath = resolvePglite()

/* 宿主那层薄封装（`withOrm`）：这里换成「真 PGlite + 真 drizzle」 */
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

/*
 * PGlite 不在插件仓库的依赖里（它是宿主的）：用一层转发 shim **运行时**再去 import 真实路径。
 * 路径走环境变量，esbuild 就不会去静态解析它（写死 `import('file:///…')` 会被 esbuild 当成要打包的模块）。
 */
const pgliteShim = join(workDir, 'pglite-shim.mjs')
writeFileSync(
  pgliteShim,
  `const url = process.env.DY_PGLITE_URL\n` +
    `const mod = await import(url)\n` +
    // drizzle 的 pglite 驱动会 import { PGlite } 和 { types } 两个名字
    `export const PGlite = mod.PGlite\n` +
    `export const types = mod.types\n` +
    `export default mod\n`,
  'utf8'
)

/* 日志探针：查「有没有写告警」用 */
const logStub = join(workDir, 'log-stub.mjs')
writeFileSync(
  logStub,
  `const calls = (globalThis.__DOUYIN_LOG_CALLS__ ??= [])\n` +
    `const push = (level) => (...args) => { calls.push([level, args.map((a) => String(a)).join(' ')]) }\n` +
    `export default { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }\n`,
  'utf8'
)

/* 入口：只用真 mapper 的 insertMessages + 真 schema 查行 */
const entry = `
import { and, eq } from 'drizzle-orm'
import { withOrm, closeOrm } from '@host/main/database/orm'
import { insertMessages } from './mapper'
import { giftRankByPerson, queryMessages } from './mapper'
import { deleteMessagesBefore, deleteMinutesBefore } from './mapper'
import { dayRecords } from './mapper'
import { revealAnonymousNames } from './mapper'
import { douyinLinkMessages, douyinLinkUsers } from './schema'

const row = (over) => ({
  webRid: '108011161837',
  sessionId: 7,
  kind: 'gift',
  userId: '1671723870326936',
  userName: '',
  content: '',
  count: 1,
  diamonds: 0,
  toUserId: '',
  toUserName: '',
  orderKey: '',
  giftRecord: false,
  atMs: 0,
  ...over
})

async function rows(orderKey) {
  return withOrm('check.select', async (db) =>
    db.select().from(douyinLinkMessages).where(eq(douyinLinkMessages.orderKey, orderKey))
  )
}

const key = '1671723870326936_7632724065811874865_999_0_4353_1_Normal'
await insertMessages([
  row({ orderKey: key, content: '想听 谷雨ఇ 演唱', toUserId: '7632724065811874865', toUserName: '谷雨ఇ', atMs: 1000 })
])
const afterWeak = await rows(key)
await insertMessages([
  row({
    orderKey: key,
    userId: '1671723870326936',
    userName: '河里的大白鲨',
    content: '跑车',
    diamonds: 1200,
    toUserId: '7632724065811874865',
    toUserName: '谷雨ఇ',
    giftRecord: true,
    atMs: 2000
  })
])
const afterRecord = await rows(key)

/* 反序：带记录的先到，后到的「想听 X 演唱」不许抹掉礼物名 */
const key2 = '1671723870326936_7632724065811874865_1000_0_4353_1_Normal'
await insertMessages([
  row({ orderKey: key2, userName: '河里的大白鲨', content: '跑车', diamonds: 1200, toUserName: '谷雨ఇ', giftRecord: true, atMs: 3000 })
])
await insertMessages([row({ orderKey: key2, content: '想听 谷雨ఇ 演唱', toUserName: '谷雨ఇ', atMs: 4000 })])
const reversed = await rows(key2)

/* 没单号串的礼物行照旧一行一条（不参与合并） */
await insertMessages([row({ content: '爱的纸鹤', diamonds: 99, giftRecord: true, atMs: 5000 })])
await insertMessages([row({ content: '爱的纸鹤', diamonds: 99, giftRecord: true, atMs: 6000 })])
const plain = await withOrm('check.plain', async (db) =>
  db.select().from(douyinLinkMessages).where(eq(douyinLinkMessages.orderKey, ''))
)

const columns = await withOrm('check.columns', async (db) => db.execute(
  \`select column_name from information_schema.columns where table_name='douyin_link_messages' and column_name='order_key'\`
))
const indexes = await withOrm('check.indexes', async (db) => db.execute(
  \`select indexname from pg_indexes where tablename='douyin_link_messages' and indexname like '%order%'\`
))

/*
 * 收礼物榜 / 送礼物榜 / 收礼历史（2026-10-08 新加的界面数据）：
 * 三件必须成立的事——① 按「收礼人」聚合能对上（同一人两次 1200 = 2400，件数 2）；
 * ② 没记收礼人的礼物行**不进收礼榜**（宁可没有，不给错人）；③ 按收礼人查历史能翻出明细。
 */
await insertMessages([
  row({ userId: 'S1', userName: '送礼甲', content: '跑车', diamonds: 1200, toUserId: 'R1', toUserName: '收礼甲', atMs: 10000 }),
  row({ userId: 'S1', userName: '送礼甲', content: '跑车', diamonds: 1200, toUserId: 'R1', toUserName: '收礼甲', atMs: 11000 }),
  row({ userId: 'S2', userName: '送礼乙', content: '礼花筒', diamonds: 199, toUserId: 'R2', toUserName: '收礼乙', atMs: 12000 }),
  row({ userId: 'S3', userName: '送礼丙', content: '爱的纸鹤', diamonds: 99, toUserId: '', toUserName: '', atMs: 13000 })
])
const recipients = await giftRankByPerson('108011161837', 'recipient', 0, 1e15)
const senders = await giftRankByPerson('108011161837', 'sender', 9000, 1e15)
const history = await queryMessages({ webRid: '108011161837', kind: 'gift', toUserId: 'R1' })

/*
 * 每日记录（左侧「每日记录」列表）：跨本地午夜的两条消息必须落进**两个**不同的天。
 * 用不带 Z 的本地时间构造，正好压在 23:30 / 00:30——按 UTC 分天的话这两条会挤进同一天。
 */
await insertMessages([
  row({ userId: 'S9', content: '跑车', diamonds: 1200, toUserId: 'R9', toUserName: '收礼九', atMs: new Date('2026-10-08T23:30:00').getTime() }),
  row({ userId: 'S9', content: '礼花筒', diamonds: 199, toUserId: 'R9', toUserName: '收礼九', atMs: new Date('2026-10-09T00:30:00').getTime() })
])
const days = await dayRecords('108011161837')

/*
 * 昵称兜底：点歌那类帧常常只有送礼人 id、没有昵称，榜单不能显示成裸 id。
 * 插一条**没有昵称**的礼物行（S4）+ 用户表里的一条昵称，榜单应该把用户表的名字用上。
 */
await insertMessages([
  row({ userId: 'S4', userName: '', content: '比心', diamonds: 199, toUserId: 'R2', toUserName: '收礼乙', atMs: 14000 })
])
await withOrm('check.user', async (db) =>
  db.insert(douyinLinkUsers).values({ webRid: '108011161837', userId: 'S4', nickname: '用户表里的丁' })
)
const sendersNamed = await giftRankByPerson('108011161837', 'sender', 9000, 1e15)

/*
 * 脱马甲（用户 2026-10-08：「可以脱神秘人的衣服，可以知道这个人是谁」）：
 * - S5：礼物行名字是空的，但**用户档案里有真名** → 还原成档案里的名字；
 * - S6：礼物行的名字是抖音给的占位串「☞ 匿名 -」，同一 id 后来发过一条弹幕 → 用弹幕里的真名还原；
 * - S7：只有一条匿名礼物、别处从没露过面 → **保持原样**（宁可还显示匿名，也不猜）。
 */
await insertMessages([
  row({ userId: 'S5', userName: '', content: '跑车', diamonds: 1200, toUserId: 'R1', toUserName: '收礼甲', atMs: 20000 }),
  row({ userId: 'S6', userName: '☞              匿名  -', content: '跑车', diamonds: 1200, toUserId: 'R1', toUserName: '收礼甲', atMs: 21000 }),
  row({ kind: 'chat', userId: 'S6', userName: '真名己', content: '大家好', atMs: 22000 }),
  row({ userId: 'S7', userName: '', content: '跑车', diamonds: 1200, toUserId: 'R1', toUserName: '收礼甲', atMs: 23000 })
])
await withOrm('check.user', async (db) =>
  db.insert(douyinLinkUsers).values({ webRid: '108011161837', userId: 'S5', nickname: '用户表里的戊' })
)
const reveal = await revealAnonymousNames('108011161837')
const revealedS5 = await queryMessages({ webRid: '108011161837', kind: 'gift', userId: 'S5' })
const revealedS6 = await queryMessages({ webRid: '108011161837', kind: 'gift', userId: 'S6' })
const revealedS7 = await queryMessages({ webRid: '108011161837', kind: 'gift', userId: 'S7' })

/*
 * 永久保存的兜底（2026-10-08「我需要永久存储」）：
 * hub 的 cleanup 在保留期为 0 时根本不调这两个函数，但这里再验一层——**非正 cutoff 一律不删**，
 * 一个坏参数（0 / NaN）不该把整张表清空。
 */
const beforeGuard = await queryMessages({ webRid: '108011161837', kind: 'gift' })
/**
 * 「加载更早」翻页用的就是同一个查询的时间上界（to，按时间往回翻）：验一下它确实只回更早的行，
 * 而且 total 只数这一段——界面靠它判断「库里再往前还有没有」。
 */
const pageOlder = await queryMessages({ webRid: '108011161837', kind: 'gift', to: 11500, limit: 10 })
const deletedByZero = await deleteMessagesBefore(0)
const deletedMinutesByZero = await deleteMinutesBefore(0)
const deletedByNaN = await deleteMessagesBefore(Number.NaN)
const afterGuard = await queryMessages({ webRid: '108011161837', kind: 'gift' })
await closeOrm()
export default JSON.stringify({
  afterWeak: afterWeak.map((r) => ({ id: String(r.id), content: r.content, diamonds: r.diamonds, atMs: r.atMs })),
  afterRecord: afterRecord.map((r) => ({ id: String(r.id), content: r.content, diamonds: r.diamonds, toUserName: r.toUserName, userName: r.userName, atMs: r.atMs })),
  reversed: reversed.map((r) => ({ content: r.content, diamonds: r.diamonds, atMs: r.atMs })),
  plainRows: plain.length,
  column: columns.rows.length,
  index: indexes.rows.length,
  recipients: recipients.map((r) => ({ userId: r.userId, name: r.name, count: r.count, diamonds: r.diamonds })),
  senders: senders.map((r) => ({ userId: r.userId, count: r.count, diamonds: r.diamonds })),
  history: { total: history.total, rows: history.rows.map((r) => ({ content: r.text, diamonds: r.diamonds, user: r.user, toUserId: r.toUserId })) },
  keepGuard: {
    before: beforeGuard.total,
    after: afterGuard.total,
    deletedByZero,
    deletedMinutesByZero,
    deletedByNaN
  },
  paging: {
    total: pageOlder.total,
    ats: pageOlder.rows.map((r) => r.at),
    contents: pageOlder.rows.map((r) => r.text)
  },
  days: days.map((d) => ({ day: d.day, messages: d.messages, gifts: d.gifts, diamonds: d.diamonds, users: d.users })),
  sendersNamed: sendersNamed.map((s) => ({ userId: s.userId, name: s.name })),
  reveal: {
    revealed: reveal.revealed,
    remaining: reveal.remaining,
    s5: revealedS5.rows[0]?.user ?? null,
    s6: revealedS6.rows[0]?.user ?? null,
    s7: revealedS7.rows[0]?.user ?? null
  }
})
`

const outfile = join(workDir, 'check.mjs')
await build({
  stdin: {
    contents: entry,
    loader: 'ts',
    resolveDir: join(ROOT, 'plugins/douyin-link/main/db')
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
const mod = await import(pathToFileURL(outfile).href)
const result = JSON.parse(mod.default ?? '{}')

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`)
}

check('建表：order_key 列存在', result.column, 1)
check('建表：order_key 上有索引', result.index >= 1, true)
check('先到没记录 → 先落一行（正文=房间的说法、价未知）', result.afterWeak.length, 1)
check('先到没记录 → 正文不是空的', result.afterWeak[0].content, '想听 谷雨ఇ 演唱')
check('后到带记录 → 还是同一行（id 不变）', result.afterRecord.length, 1)
check('后到带记录 → id 与先到那行相同', result.afterRecord[0].id, result.afterWeak[0].id)
check('后到带记录 → 礼物名与价格补上', [result.afterRecord[0].content, result.afterRecord[0].diamonds], ['跑车', 1200])
check('后到带记录 → 收礼人与送礼人补上', [result.afterRecord[0].toUserName, result.afterRecord[0].userName], ['谷雨ఇ', '河里的大白鲨'])
check('时间仍是先到的那一刻（不是补记录的时间）', result.afterRecord[0].atMs, 1000)
check('反序：带记录先到 → 礼物名不被「想听 X 演唱」抹掉', [result.reversed[0].content, result.reversed[0].diamonds], ['跑车', 1200])
check('没单号串的礼物行照旧一行一条', result.plainRows, 2)

/* 收礼物榜 / 送礼物榜 / 收礼历史 */
check('收礼物榜：按收礼人聚合（同一人两次 1200 → 2400 / 2 件）', result.recipients[0], {
  userId: 'R1',
  name: '收礼甲',
  count: 2,
  diamonds: 2400
})
check('收礼物榜：没记收礼人的礼物不进榜（99 抖币那两件不在）', result.recipients.some((row) => row.diamonds === 99), false)
check('收礼物榜：另一人也在榜上（按抖币排序）', result.recipients[2], {
  userId: 'R2',
  name: '收礼乙',
  count: 1,
  diamonds: 199
})
check('送礼物榜：按送礼人聚合', result.senders[0], { userId: 'S1', count: 2, diamonds: 2400 })
check('送礼物榜：三个人各一行', result.senders.length, 3)
check('收礼历史：按收礼人翻明细（共 2 条、都是 R1）', [result.history.total, result.history.rows.length], [2, 2])
check('收礼历史：行里带着礼物名与抖币', result.history.rows[0], {
  content: '跑车',
  diamonds: 1200,
  user: '送礼甲',
  toUserId: 'R1'
})

/* 永久保存：非正 cutoff 一条都不许删 */
check('永久保存：cutoff=0 不删任何消息', result.keepGuard.deletedByZero, 0)
check('永久保存：cutoff=0 不删任何分钟桶', result.keepGuard.deletedMinutesByZero, 0)
check('永久保存：cutoff=NaN 不删任何消息', result.keepGuard.deletedByNaN, 0)
check('永久保存：清理跑完后行数不变', [result.keepGuard.before, result.keepGuard.after], [result.keepGuard.before, result.keepGuard.before])

/* 「加载更早」的翻页语义：`to` 只回更早的行，total 也只数这一段 */
check('翻页：只回 at <= to 的行', result.paging.ats.every((at) => at <= 11500), true)
check('翻页：包含 to 之前的礼物（10000/11000）', result.paging.contents.slice(-2), ['跑车', '跑车'])
check('翻页：total 只数这一段', result.paging.total, result.paging.ats.length)

/* 每日记录：跨本地午夜的两条消息分进两天，且按天倒序 */
check('每日记录：00:30 那条落在 10-09', result.days[0], { day: '2026-10-09', messages: 1, gifts: 1, diamonds: 199, users: 1 })
check('每日记录：23:30 那条落在 10-08', result.days[1], { day: '2026-10-08', messages: 1, gifts: 1, diamonds: 1200, users: 1 })
check('每日记录：更早的数据各自成一天（按天倒序）', result.days.length >= 3, true)

/* 榜单昵称兜底：消息里没名字就用用户表里的昵称，别给用户看裸 id */
check('送礼榜：消息里带昵称的用消息里的', result.sendersNamed.find((s) => s.userId === 'S1')?.name, '送礼甲')
check('送礼榜：消息里没昵称的退回用户表昵称', result.sendersNamed.find((s) => s.userId === 'S4')?.name, '用户表里的丁')

/* 脱马甲 */
check('脱马甲：空名 → 用户档案里的真名', result.reveal.s5, '用户表里的戊')
check('脱马甲：占位名「☞ 匿名 -」→ 同一 id 弹幕里的真名', result.reveal.s6, '真名己')
check('脱马甲：从未露过面的 id 保持原样（不猜）', result.reveal.s7, '')
check('脱马甲：确实还原了不止一条', result.reveal.revealed >= 2, true)
check('脱马甲：还剩认不出的（S7 那条）', result.reveal.remaining >= 1, true)
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项不通过`)

rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
