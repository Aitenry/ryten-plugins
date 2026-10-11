/**
 * 「多账号画像」回归工装（dev-only，不参与打包）。
 *
 * 用户 2026-10-11 的要求：**一个人可以有多个账号，但其用户画像只有一个**，
 * 并且「插件里面的所有内容关联，要通过抖音 id 作为唯一的标识符号，别人改名称了就乱了」。
 *
 * 这个工装跑的是**真代码**（真 `AnalyzerHub` + 真 mapper + 真 PGlite + 真 recorder + 真画像算法），
 * 只把 electron / 采集器 / 音频泵 / 头像缓存换成桩。八组断言：
 *
 * 1. 绑定前：档案与画像只看这一个 id；
 * 2. 绑定后：**档案（按房间）与画像（跨房间）都按「这个人」合并**，账号清单是 2 个；
 * 3. **自环礼物不算关系**：同一个人两个号之间的送礼计进他的消费，但不进关系网、不算「送礼对象」；
 * 4. **改名免疫**：把消息与档案里的昵称全改掉，数字与关系边一个都不变（关联只走 id）；
 * 5. 关联走 id：改名后按**旧昵称**搜不到、按 **id** 照样搜得到；
 * 6. 两个各有画像的账号绑到一起 → **画像合并**（账号全留、空画像删掉、没有重复行）；
 * 7. 解绑：画像里还剩 ≥2 个账号就留着，只剩 1 个时**画像解散**（单账号不算关联）；
 * 8. 历史查询按 id 集合合并（同一个人的两个号说过的话并成一份）。
 *
 * 跑法（仓库根目录；PGlite 从 ryten-bench 找，或用 RB_PGLITE 指定 dist/index.js）：
 *   node plugins/douyin-link/spike/identity-merge-check.mjs
 *
 * 写库一律是**内存库**：这个工装不碰任何真数据（要在真库副本上试，用 `REAL_DB=<副本目录>`，
 * 那只对副本写、且只做读断言与一次绑定/解绑往返）。
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

/** 找宿主那份 PGlite（与 db-inspect.mjs / db-cost-check.mjs 同口径） */
function resolvePglite() {
  const candidates = [process.env.RB_PGLITE]
  candidates.push('E:\\Development-Warehouse\\github\\ryten-bench\\node_modules\\@electric-sql\\pglite\\dist\\index.js')
  for (const path of candidates) if (path && existsSync(path)) return path
  console.error('找不到 @electric-sql/pglite，可用 RB_PGLITE=<dist/index.js 路径> 指定')
  process.exit(2)
}

const workDir = mkdtempSync(join(tmpdir(), 'douyin-identity-'))
const write = (name, contents) => {
  const path = join(workDir, name)
  writeFileSync(path, contents, 'utf8')
  return path
}

/** 写库连接：默认内存库；`REAL_DB` 给了就**只对那份副本**开（绝不动应用在用的真库） */
const ormStub = write(
  'orm.mjs',
  `import { drizzle } from 'drizzle-orm/pglite'\n` +
    `import { PGlite } from '@electric-sql/pglite'\n` +
    `let client = null\n` +
    `let orm = null\n` +
    `export async function withOrm(_op, fn) {\n` +
    `  if (!client) { const dir = process.env.DY_WRITE_DIR; client = dir ? new PGlite(dir) : new PGlite(); orm = drizzle(client) }\n` +
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

const logStub = write('log.mjs', `export default { info() {}, warn() {}, error() {}, debug() {}, verbose() {}, silly() {} }\n`)

/** 下面这些桩与 `relive-check.mjs` 同款：hub 要的 electron / 采集器 / 音频泵 / 解析器 */
const STUBS = {
  electron: `
export const app = { getPath: () => '.' }
export const net = { fetch: async () => { throw new Error('probe: 不该走网络') } }
export class BrowserWindow { static getAllWindows() { return [] } }
export const ipcMain = { handle() {}, on() {} }
export default { app, net, BrowserWindow, ipcMain }
`,
  '@host/main/safe-send': `export const safeSend = () => {}\nexport const isSenderAlive = () => false\n`,
  /* AI 画像（`main/portrait.ts`）也挂在 hub 上：这三样只有真去调大模型时才用（工装里绝不联网、不花钱） */
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

const entry = `
export { AnalyzerHub } from '${slash(join(PLUGIN, 'main/monitor/hub.ts'))}'
export * as mapper from '${slash(join(PLUGIN, 'main/db/mapper.ts'))}'
export { rawQuery, closeOrm } from '@host/main/database/orm'
`

const outfile = join(workDir, 'bundle.mjs')
await build({
  stdin: { contents: entry, loader: 'ts', resolveDir: PLUGIN },
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'warning',
  nodePaths: [join(ROOT, 'node_modules')],
  plugins: [
    {
      name: 'douyin-identity',
      setup(api) {
        const files = { ...Object.fromEntries(Object.entries(STUBS).map(([key, value]) => [key, write(`${key.replace(/[^\w]/g, '_')}.mjs`, value)])) }
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
process.env.DY_WRITE_DIR = process.env.REAL_DB && existsSync(join(process.env.REAL_DB, 'PG_VERSION')) ? process.env.REAL_DB : ''

const { AnalyzerHub, mapper, rawQuery, closeOrm } = await import(pathToFileURL(outfile).href)

/* ------------------------------------------------------------------ 工具 */

const failures = []
function check(ok, label, detail = '') {
  if (!ok) failures.push(`${label}${detail ? ` —— ${detail}` : ''}`)
  return ok
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const count = async (sql) => Number((await rawQuery(sql)).rows[0]?.value ?? 0)

/* --------------------------------------------------------------- 造数据 */

const ROOM_A = '100000000001'
const ROOM_B = '100000000002'
const A1 = '200000000001' // 阿甲（主账号）
const A2 = '200000000002' // 阿乙（同一个人的第二个号）
const B1 = '300000000001' // 阿丙（另一个人）
const C1 = '300000000002' // 阿丁（与阿丙同一人的第二个号）
const ANCHOR = '999000000001' // 主播（收礼的第三方）

let seq = 0
function message(kind, webRid, userId, userName, content, at, extra = {}) {
  seq += 1
  return {
    webRid,
    sessionId: 1,
    kind,
    userId,
    userName,
    content,
    count: extra.count ?? (kind === 'gift' ? 1 : 0),
    diamonds: extra.diamonds ?? 0,
    toUserId: extra.toUserId ?? '',
    toUserName: extra.toUserName ?? '',
    orderKey: '',
    giftRecord: kind === 'gift',
    atMs: at
  }
}

/** 一个账号在一个房间的档案行（统计= 库里那份累计） */
function userRow(webRid, userId, nickname, stats, firstSeen, lastSeen) {
  return {
    webRid,
    userId,
    nickname,
    displayId: `dy-${userId.slice(-4)}`,
    gender: 0,
    signature: '',
    city: '',
    avatar: '',
    following: 0,
    follower: 0,
    honorLevel: 0,
    fansClubLevel: 0,
    badges: [],
    secUid: '',
    // `UserDeltaRow.delta` 就是**写进库的累加量**（upsert 时 chat = chat + delta.chat）：
    // 工装直接把它当「这个账号已有的累计」用，所以这里必须给真数字，不能给 0
    delta: stats,
    firstSeen,
    lastSeen
  }
}

async function seed() {
  const t0 = Date.now() - 3600_000
  const rows = []
  const users = []
  const push = (kind, webRid, userId, name, content, offset, extra) =>
    rows.push(message(kind, webRid, userId, name, content, t0 + offset, extra))

  // 阿甲：A 房 3 条弹幕 + 给主播 100 抖币；B 房 2 条弹幕
  push('chat', ROOM_A, A1, '阿甲', '一', 1000)
  push('chat', ROOM_A, A1, '阿甲', '二', 2000)
  push('chat', ROOM_A, A1, '阿甲', '三', 3000)
  push('gift', ROOM_A, A1, '阿甲', '小心心', 4000, { diamonds: 100, toUserId: ANCHOR, toUserName: '主播' })
  push('chat', ROOM_B, A1, '阿甲', '四', 5000)
  push('chat', ROOM_B, A1, '阿甲', '五', 6000)
  // 阿乙（同一个人的第二个号）：A 房 2 条弹幕；B 房 1 个 50 抖币的礼物
  push('chat', ROOM_A, A2, '阿乙', '六', 7000)
  push('chat', ROOM_A, A2, '阿乙', '七', 8000)
  push('gift', ROOM_B, A2, '阿乙', '玫瑰', 9000, { diamonds: 50, toUserId: ANCHOR, toUserName: '主播' })
  // **自环**：阿甲给阿乙（同一个人的两个号）送 500 抖币
  push('gift', ROOM_A, A1, '阿甲', '跑车', 10000, { diamonds: 500, toUserId: A2, toUserName: '阿乙' })
  // 阿丙：A 房 4 条弹幕 + 给主播 30 抖币；阿丁：A 房 1 条弹幕
  push('chat', ROOM_A, B1, '阿丙', '甲', 11000)
  push('chat', ROOM_A, B1, '阿丙', '乙', 12000)
  push('chat', ROOM_A, B1, '阿丙', '丙', 13000)
  push('chat', ROOM_A, B1, '阿丙', '丁', 14000)
  push('gift', ROOM_A, B1, '阿丙', '棒棒糖', 15000, { diamonds: 30, toUserId: ANCHOR, toUserName: '主播' })
  push('chat', ROOM_A, C1, '阿丁', '戊', 16000)

  await mapper.insertMessages(rows)
  users.push(userRow(ROOM_A, A1, '阿甲', { chat: 3, enter: 0, like: 0, follow: 0, gift: 2, diamonds: 600 }, t0, t0 + 10000))
  users.push(userRow(ROOM_B, A1, '阿甲', { chat: 2, enter: 0, like: 0, follow: 0, gift: 0, diamonds: 0 }, t0 + 5000, t0 + 6000))
  users.push(userRow(ROOM_A, A2, '阿乙', { chat: 2, enter: 0, like: 0, follow: 0, gift: 0, diamonds: 0 }, t0 + 7000, t0 + 8000))
  users.push(userRow(ROOM_B, A2, '阿乙', { chat: 0, enter: 0, like: 0, follow: 0, gift: 1, diamonds: 50 }, t0 + 9000, t0 + 9000))
  users.push(userRow(ROOM_A, B1, '阿丙', { chat: 4, enter: 0, like: 0, follow: 0, gift: 1, diamonds: 30 }, t0 + 11000, t0 + 15000))
  users.push(userRow(ROOM_A, C1, '阿丁', { chat: 1, enter: 0, like: 0, follow: 0, gift: 0, diamonds: 0 }, t0 + 16000, t0 + 16000))
  await mapper.upsertUserDeltas(users)

  // 种下去的数据先摆出来（工装的断言都建立在它之上，数字对不上时一眼能看出是哪一条）。
  // 只看工装自己那两个房间：真库副本上有几万行，全表 dump 会把日志淹掉
  const sanity = await rawQuery(
    `select web_rid, user_id, kind, count(*)::int as n from douyin_link_messages
      where web_rid in ('${ROOM_A}', '${ROOM_B}') group by 1, 2, 3 order by 1, 2, 3`
  )
  console.log('=== 0. 种下去的消息（工装自己的两个房间）===')
  for (const row of sanity.rows) console.log(`  ${row.web_rid} · ${row.user_id} · ${row.kind} × ${row.n}`)
  console.log(
    `  档案行：${(await rawQuery(`select count(*)::int as value from douyin_link_users`)).rows[0].value} 行`
  )
}

/** 只问画像里关心的几个数字（`userAnalysis` 是跨房间口径） */
async function analysisOf(hub, userId) {
  const result = await hub.userAnalysis(userId)
  const facts = result?.facts ?? {}
  const network = result?.network ?? {}
  return {
    // 弹幕样本数（这个工装的样本远小于画像的 2000 上限，所以它等于真实条数）
    chat: result?.chat?.sampleCount ?? 0,
    monetary: facts.monetary ?? 0,
    recipients: facts.recipients ?? 0,
    outgoing: (network.outgoing ?? []).map((peer) => `${peer.userId}:${peer.diamonds}`).sort()
  }
}

/* ------------------------------------------------------------------ 断言 */

async function main() {
  const hub = new AnalyzerHub()
  await hub.init({ resumeOnStart: false })
  await seed()

  const realId = process.env.REAL_DB ? String(process.env.REAL_ID ?? '').trim() : ''
  const realId2 = process.env.REAL_DB ? String(process.env.REAL_ID2 ?? '').trim() : ''
  if (process.env.REAL_DB && realId) {
    console.log(`\n=== A. 真库副本冒烟：${process.env.REAL_DB} ===`)
    const self = (await hub.searchAccounts(realId, 5)).find((row) => row.userId === realId)
    console.log(`  ${realId} → ${self?.nickname || '(无档案)'} · 弹幕 ${self?.chat ?? 0} · 房间 ${self?.rooms ?? 0} · 画像 ${self?.identityId ?? 0}`)
    check(Boolean(self), 'A：真库：按 id 能搜到这个账号')
    check((await hub.userIdentity(realId)).accounts.length === 1, 'A：真库：这个 id 现在还没绑定（单账号画像）')
    if (self?.nickname) {
      const byName = await hub.searchAccounts(self.nickname, 5)
      check(byName.some((row) => row.userId === realId), 'A：真库：按昵称也能搜到（昵称只用来显示）')
    }
    if (realId2) {
      /*
       * 档案统计现在是**跨全部直播间**的（用户 2026-10-11 的要求），所以期望值也是
       * 「这两个账号在全库档案行之和」——不再是某一个房间那一行。
       */
      const expected = Number(
        (
          await rawQuery(
            `select coalesce(sum(chat), 0)::int as value from douyin_link_users
              where user_id in ('${realId}', '${realId2}')`
          )
        ).rows[0]?.value ?? 0
      )
      const bound = await hub.bindAccount(realId, realId2)
      const mergedProfile = await hub.userProfile(room, realId)
      const crossRoom = await hub.userProfile('', realId)
      console.log(
        `  绑定 ${realId} + ${realId2}：画像 ${bound.identityId} · ${bound.accounts.length} 个账号 · ` +
          `档案弹幕 ${mergedProfile?.stats.chat ?? 0}（库里两行之和 ${expected}）· 空 webRid 也能查：${Boolean(crossRoom)}`
      )
      check(bound.accounts.length === 2, 'A：真库：两个 id 绑成一个画像')
      check(
        (mergedProfile?.stats.chat ?? -1) === expected,
        'A：真库：档案弹幕 = 两个账号的全部档案行之和（跨房间）',
        `实际 ${mergedProfile?.stats.chat} / 期望 ${expected}`
      )
      check(
        (crossRoom?.stats.chat ?? -1) === (mergedProfile?.stats.chat ?? -2),
        'A：真库：给了房间与不给房间（大屏模式）得到同一份跨房合计'
      )
      check(Boolean(crossRoom), 'A：真库：没有当前房间（空 webRid）时档案也能查（跨房间取最近一行）')
      const back = await hub.unbindAccount(realId2, realId)
      const identitiesLeft = await count(`select count(*)::int as value from douyin_link_identities`)
      console.log(`  解绑后：${back.accounts.length} 个账号 · 画像表 ${identitiesLeft} 行`)
      check(back.accounts.length === 1 && identitiesLeft === 0, 'A：真库：解绑后不留痕（单账号画像解散）')
    }
  }

  /* 1. 绑定前 */
  const beforeProfile = await hub.userProfile(ROOM_A, A1)
  const beforeAnalysis = await analysisOf(hub, A1)
  const beforeIdentity = await hub.userIdentity(A1)
  console.log('\n=== 1. 绑定前（只有阿甲自己） ===')
  console.log(`  档案：弹幕 ${beforeProfile?.stats.chat} · 送出 ${beforeProfile?.stats.diamonds} · 收到 ${beforeProfile?.stats.receivedDiamonds}`)
  console.log(`  画像：弹幕 ${beforeAnalysis.chat} · 抖币 ${beforeAnalysis.monetary} · 关系边 ${beforeAnalysis.outgoing.join(' / ') || '-'}`)
  /*
   * 档案统计是**跨全部直播间**的（用户 2026-10-11：「互动统计（本房间累计）需要所有直播间统计」），
   * 所以这里跟画像同口径：A 房 3 条 + B 房 2 条 = 5。
   */
  check(beforeProfile?.stats.chat === 5, '1：绑定前档案（跨房间）= 3 + 2 = 5', `实际 ${beforeProfile?.stats.chat}`)
  check(
    beforeProfile?.stats.receivedDiamonds === 0,
    '1：绑定前没人给他送过礼 → 收礼 0',
    `实际 ${beforeProfile?.stats.receivedDiamonds}`
  )
  check(beforeAnalysis.chat === 5, '1：绑定前画像跨房间 = 3 + 2 = 5', `实际 ${beforeAnalysis.chat}`)
  check(beforeAnalysis.monetary === 600, '1：绑定前抖币 = 100 + 500（自环此刻还不是自环）= 600', `实际 ${beforeAnalysis.monetary}`)
  check(beforeIdentity.identityId === 0 && beforeIdentity.accounts.length === 1, '1：绑定前是「单账号画像」')

  /* 2. 绑定 + 档案/画像合并 */
  const identity = await hub.bindAccount(A1, A2)
  const mergedProfile = await hub.userProfile(ROOM_A, A1)
  const mergedRoomB = await hub.userProfile(ROOM_B, A1)
  const mergedAnalysis = await analysisOf(hub, A1)
  console.log('\n=== 2. 绑定阿甲 + 阿乙 ===')
  console.log(`  画像 ${identity.identityId}：${identity.accounts.map((a) => `${a.nickname}(${a.userId})`).join(' + ')}`)
  console.log(`  档案（A 房入口）：弹幕 ${mergedProfile?.stats.chat}（3 + 2 + 2 = 7）· 送出 ${mergedProfile?.stats.diamonds} · 收到 ${mergedProfile?.stats.receivedDiamonds}`)
  console.log(`  档案（B 房入口）：弹幕 ${mergedRoomB?.stats.chat} · 送出 ${mergedRoomB?.stats.diamonds} · 收到 ${mergedRoomB?.stats.receivedDiamonds}`)
  console.log(`  画像：弹幕 ${mergedAnalysis.chat} · 抖币 ${mergedAnalysis.monetary} · 送礼对象 ${mergedAnalysis.recipients} · 关系边 ${mergedAnalysis.outgoing.join(' / ')}`)
  check(identity.identityId > 0 && identity.accounts.length === 2, '2：绑定后画像里有 2 个账号')
  check(
    identity.accounts.map((a) => a.userId).sort().join(',') === [A1, A2].sort().join(','),
    '2：账号清单就是这两个 id（身份键是 id，不是昵称）'
  )
  check(mergedProfile?.stats.chat === 7, '2：档案 = 两个账号跨房间（3 + 2 + 2 = 7）', `实际 ${mergedProfile?.stats.chat}`)
  check(mergedProfile?.stats.diamonds === 650, '2：送出抖币 = 100 + 500 + 50 = 650', `实际 ${mergedProfile?.stats.diamonds}`)
  /*
   * 收礼 0 是**对的**：这份数据里唯一「送给这两个号」的礼物就是阿甲→阿乙那 500（画像内部的自环），
   * 它被排掉了；给主播的 100 / 50 是**送出去**的。这条断言就是在钉「自环不算收礼」。
   */
  check(
    mergedProfile?.stats.receivedDiamonds === 0,
    '2：收到抖币 = 0（唯一的进账是画像内的自环 500，不算收礼）',
    `实际 ${mergedProfile?.stats.receivedDiamonds}`
  )
  /*
   * **换个房间打开同一个人，数字必须一样**（这是这次改动的重点）：
   * 以前按房间切片，B 房只能看到 50；现在两个入口都是跨房合计。
   */
  check(
    mergedRoomB?.stats.chat === mergedProfile?.stats.chat &&
      mergedRoomB?.stats.diamonds === mergedProfile?.stats.diamonds &&
      mergedRoomB?.stats.receivedDiamonds === mergedProfile?.stats.receivedDiamonds,
    '2：从 A 房 / B 房两个入口打开，数字完全一样（跨房间合计）',
    `A=${JSON.stringify(mergedProfile?.stats)} / B=${JSON.stringify(mergedRoomB?.stats)}`
  )
  check(mergedAnalysis.chat === 7, '2：画像跨房间 = 3 + 2 + 2 = 7', `实际 ${mergedAnalysis.chat}`)

  /* 3. 自环礼物 */
  console.log('\n=== 3. 自环礼物（阿甲 → 阿乙）===')
  check(mergedAnalysis.monetary === 650, '3：自环的 500 仍算他的消费（100 + 500 + 50 = 650）', `实际 ${mergedAnalysis.monetary}`)
  check(
    mergedAnalysis.outgoing.join(',') === `${ANCHOR}:150`,
    '3：自环不进关系网（只剩主播 100 + 50 = 150）',
    `实际 ${mergedAnalysis.outgoing.join(',')}`
  )
  check(mergedAnalysis.recipients === 1, '3：送礼对象去重不含自己人（只剩主播 1 个）', `实际 ${mergedAnalysis.recipients}`)

  /* 4. 改名免疫 */
  // 只改**工装自己种的那两个房间**（真库副本上全表改名会拖到超时，而且没必要）
  await rawQuery(
    `update douyin_link_messages set user_name = '改名乱码-' || user_id, to_user_name = '改名乱码-' || to_user_id
      where web_rid in ('${ROOM_A}', '${ROOM_B}')`
  )
  await rawQuery(
    `update douyin_link_users set nickname = '改名乱码-' || user_id
      where user_id in ('${A1}', '${A2}', '${B1}', '${C1}', '${ANCHOR}')`
  )
  const renamedProfile = await hub.userProfile(ROOM_A, A1)
  const renamedAnalysis = await analysisOf(hub, A1)
  const renamedIdentity = await hub.userIdentity(A1)
  console.log('\n=== 4. 把所有昵称改掉之后 ===')
  console.log(`  档案：弹幕 ${renamedProfile?.stats.chat} · 送出 ${renamedProfile?.stats.diamonds} · 收到 ${renamedProfile?.stats.receivedDiamonds}`)
  console.log(`  画像：弹幕 ${renamedAnalysis.chat} · 抖币 ${renamedAnalysis.monetary} · 关系边 ${renamedAnalysis.outgoing.join(' / ')}`)
  console.log(`  账号清单：${renamedIdentity.accounts.map((a) => a.userId).join(', ')}`)
  check(same(renamedAnalysis, mergedAnalysis), '4：改名后画像数字与关系边逐字不变（关联只走 id）', JSON.stringify(renamedAnalysis))
  check(
    renamedProfile?.stats.chat === mergedProfile?.stats.chat &&
      renamedProfile?.stats.diamonds === mergedProfile?.stats.diamonds &&
      renamedProfile?.stats.receivedDiamonds === mergedProfile?.stats.receivedDiamonds,
    '4：改名后档案数字不变（跨房间合计也一样）'
  )
  check(
    renamedIdentity.accounts.map((a) => a.userId).sort().join(',') === [A1, A2].sort().join(','),
    '4：改名后账号清单不变（仍是两个 id）'
  )

  /* 5. 搜索：旧昵称查不到、id 照样查得到 */
  const byOldName = await hub.searchAccounts('阿乙', 5)
  const byId = await hub.searchAccounts(A2, 5)
  const byNewName = await hub.searchAccounts('改名乱码-' + A2, 5)
  console.log('\n=== 5. 搜索（改名之后） ===')
  console.log(`  按旧昵称「阿乙」：${byOldName.length} 条 · 按新昵称：${byNewName.length} 条 · 按 id：${byId.length} 条`)
  check(byOldName.length === 0, '5：旧昵称查不到（名字改了就是改了）', `实际 ${byOldName.length}`)
  check(byId.some((row) => row.userId === A2), '5：按 id 照样查得到')
  check(byId.find((row) => row.userId === A2)?.identityId === identity.identityId, '5：搜索结果里带着它所属的画像 id')

  /* 6. 两个画像合并 */
  await hub.bindAccount(B1, C1)
  const before = await count(`select count(*)::int as value from douyin_link_identities`)
  const merged = await hub.bindAccount(A1, B1)
  const after = await count(`select count(*)::int as value from douyin_link_identities`)
  const accountRows = await count(`select count(*)::int as value from douyin_link_identity_accounts`)
  const identityOfA2 = await mapper.identityOf(A2)
  console.log('\n=== 6. 两个各有画像的账号绑到一起 ===')
  console.log(`  画像表：${before} → ${after} 行（合并掉一个）· 账号行 ${accountRows} · 4 个账号都在同一个画像：${merged.accounts.length === 4}`)
  check(merged.accounts.length === 4, '6：合并后 4 个账号在同一个画像里', `实际 ${merged.accounts.length}`)
  check(after === 1, '6：空掉的画像被删掉（只剩 1 行）', `实际 ${after}`)
  check(accountRows === 4, '6：账号行不重复（user_id 是主键）', `实际 ${accountRows}`)
  check(identityOfA2 === merged.identityId, '6：原来各自的账号都被迁到同一个画像')

  /* 6b. 导出/导入画像（备份包里的 identities.json）：重复导入必须幂等 */
  const groups = await mapper.exportIdentityGroups()
  await mapper.importIdentityGroups(groups)
  const identitiesAfterImport = await count(`select count(*)::int as value from douyin_link_identities`)
  console.log(`  导出画像分组 ${groups.length} 个（账号 ${groups[0]?.accounts.length ?? 0} 个）· 再导入一次后画像表 ${identitiesAfterImport} 行`)
  check(groups.length === 1 && groups[0].accounts.length === 4, '6b：导出的是一个含 4 个账号的画像分组')
  check(identitiesAfterImport === 1, '6b：重复导入幂等（不会造出第二个画像）', `实际 ${identitiesAfterImport}`)

  /* 7. 解绑与解散 */
  // `viewerUserId` = 界面上正在看的那个 id：回话要回**他的**画像视图（被解绑的账号已经不属于任何画像了）
  const afterUnbindC1 = await hub.unbindAccount(C1, A1)
  const afterUnbindB1 = await hub.unbindAccount(B1, A1)
  const afterUnbindA2 = await hub.unbindAccount(A2, A1)
  const orphanView = await hub.unbindAccount(A2)
  const identitiesLeft = await count(`select count(*)::int as value from douyin_link_identities`)
  const accountsLeft = await count(`select count(*)::int as value from douyin_link_identity_accounts`)
  console.log('\n=== 7. 逐个解绑 ===')
  console.log(
    `  看的人（阿甲）的画像：解绑阿丁后 ${afterUnbindC1.accounts.length} 个 · 解绑阿丙后 ${afterUnbindB1.accounts.length} 个 · 解绑阿乙后 ${afterUnbindA2.accounts.length} 个`
  )
  console.log(`  画像表 ${identitiesLeft} 行 · 账号行 ${accountsLeft}`)
  check(
    afterUnbindC1.accounts.length === 3,
    '7：解绑一个后还剩 3 个（回的是「看的人」的画像）',
    `实际 ${afterUnbindC1.accounts.length}`
  )
  check(afterUnbindB1.accounts.length === 2, '7：再解绑一个后还剩 2 个（画像还在）', `实际 ${afterUnbindB1.accounts.length}`)
  check(
    afterUnbindA2.identityId === 0 && afterUnbindA2.accounts.length === 1,
    '7：只剩一个账号时画像解散（单账号不算关联）',
    `identityId=${afterUnbindA2.identityId} accounts=${afterUnbindA2.accounts.length}`
  )
  check(
    orphanView.accounts.length === 1 && orphanView.accounts[0]?.userId === A2,
    '7：被解绑的账号自己看就是「单账号」'
  )
  check(identitiesLeft === 0 && accountsLeft === 0, '7：解散后画像表与账号表都不留残行', `${identitiesLeft} / ${accountsLeft}`)

  /* 8. 历史按 id 集合合并 */
  const single = await mapper.queryMessages({ webRid: ROOM_A, userId: A1, kind: 'chat' })
  const onlyOther = await mapper.queryMessages({ webRid: ROOM_A, userIds: [A2], kind: 'chat' })
  const both = await mapper.queryMessages({ webRid: ROOM_A, userId: A1, userIds: [A1, A2], kind: 'chat' })
  const viaHub = await hub.queryMessages({ webRid: ROOM_A, userId: A1, userIds: [A1, A2], kind: 'chat' })
  console.log('\n=== 8. 历史查询 ===')
  console.log(
    `  只有阿甲：${single.total} 条 · 只有阿乙：${onlyOther.total} 条 · 两个 id：${both.total} 条 · 走 hub：${viaHub.total} 条`
  )
  check(single.total === 3, '8：单 id 查询 = 3 条', `实际 ${single.total}`)
  check(onlyOther.total === 2, '8：另一个 id 单独查 = 2 条', `实际 ${onlyOther.total}`)
  check(both.total === 5, '8：id 集合查询 = 3 + 2 = 5 条', `实际 ${both.total}`)
  check(viaHub.total === 5, '8：走 hub 的同一条件也是 5 条', `实际 ${viaHub.total}`)

  hub.dispose()
}

await main()

console.log('\n=== 小结 ===')
if (failures.length > 0) {
  console.log(`✗ ${failures.length} 项断言失败：`)
  for (const failure of failures) console.log(`  - ${failure}`)
} else {
  console.log('✓ 全部断言通过')
}

if (process.env.REAL_DB) {
  /**
   * 真库副本很大（几百 MB）：PGlite 的 `close()` 要跑检查点 + 折 WAL，分钟级
   * （同一天的「关应用要关两次」就是它）。副本是一次性的，工装不为它等——直接退出。
   */
  console.log('（真库副本模式：跳过 PGlite close，直接的退出）')
  rmSync(workDir, { recursive: true, force: true })
  process.exit(failures.length > 0 ? 1 : 0)
}

await closeOrm().catch(() => undefined)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures.length > 0 ? 1 : 0)
