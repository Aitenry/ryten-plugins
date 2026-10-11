/**
 * 「用户档案行到底有没有写进库」的离线回归工装（dev-only，不参与打包）。
 *
 * 为什么要有（2026-10-11 用户报障）：档案弹窗写着「没有这个用户的档案（可能已被清空或超出保留上限）」，
 * 可是点「查看真实资料」又能查到这个人。真库排查结论是 `RoomRecorder.takeUserDeltas` 的
 * **配额饥饿**：旧版按 userMap 的插入序取前 400 个，而「本场出现过」的人（`sessionUserIds`）
 * 永久满足 active 条件 —— 于是前 400 个固定占满配额，**第 401 个之后出现的人一辈子写不进
 * `douyin_link_users`**，而他们的消息照常进 `douyin_link_messages`（另一条队列）。
 * 真库证据：按「本场首次出现」排名切一刀，rank ≤ 400 的 400 人全部有档案行，
 * rank > 400 的 244 人只有 17 人有（那 17 个来自更早的会话）；本场不足 400 人的会话缺失为 0。
 *
 * 这个工装用**真代码**（真 `RoomRecorder` + 真 mapper + 真 PGlite，flush 顺序照抄 `hub.flush`）干三件事：
 * 1. **合成场景**：900 个不同用户各说一句话，前 400 人持续说话；断言 900 人**全部**有档案行，
 *    并量出「静默时段还在写用户行」的行数（旧版每 2 秒把前 400 个人无条件重写一遍）；
 * 2. **真实回放**（给了真库副本时）：把库里的消息流按会话顺序喂回 recorder、逐 2 秒 flush，
 *    断言「本场发过言的每个人都落了档案」；
 * 3. **改前对照**：`DY_RECORDER_TS=<旧版 recorder.ts>` 用同一套断言跑旧代码，量出改前改后数字。
 *
 * 跑法（仓库根目录；PGlite 从 ryten-bench 找，或用 RB_PGLITE 指定 dist/index.js）：
 *   node plugins/douyin-link/spike/user-row-flush-check.mjs
 *   node plugins/douyin-link/spike/user-row-flush-check.mjs "$env:TEMP\rbdb-copy"
 *   $env:DY_RECORDER_TS="$env:TEMP\recorder-before.ts"; node plugins/douyin-link/spike/user-row-flush-check.mjs
 *
 * `REPAIR=1` 换一个用途：在**真库副本**上验证「补档案」（`mapper.repairUsersFromMessages`）——
 * 缺的行补出来、已有档案一行都不许动（按 `id <= max(id)` 比对前后哈希）。**只对副本写**：
 *   $env:REPAIR="1"; node plugins/douyin-link/spike/user-row-flush-check.mjs "$env:TEMP\rbdb-copy"
 *
 * ⚠️ 只读真库时也必须用**副本**（PGlite 没有跨进程锁，应用正在用的真库绝不能同时开）。
 *    默认写库一律是**内存库**：这个工装不往任何真数据里写东西（REPAIR=1 除外，那只针对你给的副本）。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件仓库根（本脚本在 plugins/douyin-link/spike/ 下） */
const ROOT = join(HERE, '../../../')
const PLUGIN = join(HERE, '..')

/** 可换成旧版 recorder.ts 做「改前对照」（它的 import 全是 `import type`，esbuild 会整条抹掉） */
const recorderTs = process.env.DY_RECORDER_TS || join(PLUGIN, 'main/monitor/recorder.ts')
const recorderLabel = process.env.DY_RECORDER_TS ? `旧版对照（${process.env.DY_RECORDER_TS}）` : '当前仓库'

const sourceDir = process.argv[2] ?? process.env.DY_DB_DIR ?? ''
if (sourceDir && !existsSync(join(sourceDir, 'PG_VERSION'))) {
  console.error(`不是 PGlite 数据目录（缺 PG_VERSION）：${sourceDir}`)
  process.exit(2)
}

/** 找宿主那份 PGlite（本脚本不打包依赖，与 db-inspect.mjs / db-cost-check.mjs 同口径） */
function resolvePglite() {
  const candidates = [process.env.RB_PGLITE]
  candidates.push('E:\\Development-Warehouse\\github\\ryten-bench\\node_modules\\@electric-sql\\pglite\\dist\\index.js')
  for (const path of candidates) if (path && existsSync(path)) return path
  console.error('找不到 @electric-sql/pglite，可用 RB_PGLITE=<dist/index.js 路径> 指定')
  process.exit(2)
}

const slash = (path) => path.replace(/\\/g, '/')
const workDir = mkdtempSync(join(tmpdir(), 'douyin-user-row-'))

/**
 * 宿主那层薄封装（withOrm）的替身：两个连接分开——
 * `withOrm` / `rawQuery` 打**写库**（默认内存库；`REPAIR=1` 时才指向你给的那份副本），
 * `sourceQuery` 只读**真库副本**（回放的数据源）。
 */
const ormStub = join(workDir, 'orm.mjs')
writeFileSync(
  ormStub,
  `import { drizzle } from 'drizzle-orm/pglite'\n` +
    `import { PGlite } from '@electric-sql/pglite'\n` +
    `let client = null\n` +
    `let orm = null\n` +
    `let source = null\n` +
    `export async function withOrm(_op, fn) {\n` +
    `  if (!client) { const dir = process.env.DY_WRITE_DIR; client = dir ? new PGlite(dir) : new PGlite(); orm = drizzle(client) }\n` +
    `  return fn(orm)\n` +
    `}\n` +
    `export async function rawQuery(sql) { return client.query(sql) }\n` +
    `export async function sourceQuery(sql) { if (!source) source = new PGlite(process.env.DY_PGLITE_SOURCE); return source.query(sql) }\n` +
    `export async function closeOrm() { if (source) await source.close(); if (client) await client.close() }\n`,
  'utf8'
)

/* PGlite 不在插件仓库依赖里：运行时再去 import 真路径（环境变量，esbuild 不做静态解析） */
const pgliteShim = join(workDir, 'pglite-shim.mjs')
writeFileSync(
  pgliteShim,
  `const mod = await import(process.env.DY_PGLITE_URL)\n` +
    `export const PGlite = mod.PGlite\n` +
    `export const types = mod.types\n` +
    `export default mod\n`,
  'utf8'
)

const logStub = join(workDir, 'log.mjs')
writeFileSync(logStub, `export default { info() {}, warn() {}, error() {}, debug() {} }\n`, 'utf8')

const outfile = join(workDir, 'bundle.mjs')
await build({
  stdin: {
    contents: `
export { RoomRecorder } from '${slash(recorderTs)}'
export * as mapper from '${slash(join(PLUGIN, 'main/db/mapper.ts'))}'
export { schemaReady } from '${slash(join(PLUGIN, 'main/db/ddl.ts'))}'
export { rawQuery, sourceQuery, closeOrm } from '@host/main/database/orm'
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
      name: 'douyin-user-row',
      setup(api) {
        api.onResolve({ filter: /^@host\/main\/database\/orm$/ }, () => ({ path: ormStub }))
        api.onResolve({ filter: /^@electric-sql\/pglite$/ }, () => ({ path: pgliteShim }))
        api.onResolve({ filter: /^electron-log$/ }, () => ({ path: logStub }))
        return null
      }
    }
  ]
})

process.env.DY_PGLITE_URL = pathToFileURL(resolvePglite()).href
process.env.DY_PGLITE_SOURCE = sourceDir

/**
 * `REPAIR=1`：写库连接指向**你给的那份副本**（验证补档案时才这么做）。
 * 必须在**导入 bundle 之前**设好——`ddl.ts` 的 `schemaReady` 在模块求值时就开工了，
 * 它用的就是那会儿的写库连接。
 */
const repairMode = process.env.REPAIR === '1'
if (repairMode) {
  if (!sourceDir) {
    console.error('REPAIR=1 需要给出真库副本目录：node user-row-flush-check.mjs "<副本目录>"')
    process.exit(2)
  }
  process.env.DY_WRITE_DIR = sourceDir
}

const { RoomRecorder, mapper, schemaReady, rawQuery, sourceQuery, closeOrm } = await import(
  pathToFileURL(outfile).href
)
await schemaReady

/* ------------------------------------------------------------------ 工具 */

const failures = []
function check(ok, label, detail = '') {
  if (!ok) failures.push(`${label}${detail ? ` —— ${detail}` : ''}`)
  return ok
}

/** 单值查询（`as value` 是惯例，见 db-inspect.mjs） */
const count = async (query, sql) => Number((await query(sql)).rows[0]?.value ?? 0)

/** 帧里的一个用户（形状照 `UserInfo`） */
function userInfo(id, nickname) {
  return {
    id,
    displayId: `dy${id.slice(-4)}`,
    nickname,
    gender: 0,
    signature: '',
    city: '',
    avatar: '',
    following: 0,
    follower: 0,
    honorLevel: 0,
    fansClubLevel: 0,
    badges: [],
    secUid: ''
  }
}

let itemSeq = 0
/** 一行消息 → 一条弹幕（形状照 `DanmakuItem`） */
function item(kind, userId, nickname, text, at, extra = {}) {
  itemSeq += 1
  return {
    id: itemSeq,
    kind,
    user: nickname,
    userId,
    text,
    count: extra.count ?? 1,
    diamonds: extra.diamonds ?? 0,
    toUser: extra.toUser ?? '',
    toUserId: extra.toUserId ?? '',
    at
  }
}

/**
 * 一轮 flush：**顺序照抄 `hub.flush()`**（消息 → 分钟桶 → 用户增量）。
 * 顺序是关键：用户行写在消息之后，「消息在、档案不在」这种不对称正是这个工装要抓的东西。
 */
async function flushOnce(recorder, api) {
  const map = api.mapper
  const messages = recorder.takeMessages()
  const minutes = recorder.takeMinutes()
  const users = recorder.takeUserDeltas()
  if (messages.length === 0 && minutes.length === 0 && users.length === 0) return 0
  await map.insertMessages(messages)
  await map.bumpMinutes(minutes)
  await map.upsertUserDeltas(users)
  return users.length
}

/** 把攒批的尾巴写干净（会话结束 / 工装收尾都用它） */
async function drain(recorder, api, maxRounds = 200) {
  let total = 0
  for (let round = 0; round < maxRounds; round++) {
    const written = await flushOnce(recorder, api)
    total += written
    if (written === 0) return total
  }
  return total
}

/* ------------------------------------------------------- 场景一：合成 900 人 */

const SYNTH_RID = '900000000001'
/** 推送帧间隔与 flush 间隔（照 hub：帧约 250ms 一批、2000ms 一次落库） */
const FRAME_MS = 250
const FLUSH_EVERY = 8

async function synthetic() {
  const total = 900
  const api = { mapper }
  const recorder = new RoomRecorder(SYNTH_RID)
  recorder.begin(1, 200)

  let at = Date.now() - total * FRAME_MS
  let upsertRows = 0
  let flushCount = 0
  let frame = 0

  for (let index = 0; index < total; index += 3) {
    const users = []
    const items = []
    for (let k = 0; k < 3 && index + k < total; k++) {
      const id = String(100000000000 + index + k)
      const nickname = `观众${index + k}`
      users.push(userInfo(id, nickname))
      items.push(item('chat', id, nickname, `第 ${index + k} 号报到`, at + k * 10))
    }
    // 前 400 人一直在说话：旧版正是靠这些人把配额占死的
    if (index >= 9) {
      const id = String(100000000000 + (index % 400))
      const nickname = `观众${index % 400}`
      items.push(item('chat', id, nickname, '还在聊', at + 100))
      users.push(userInfo(id, nickname))
    }
    recorder.ingest(items, users, 200)
    frame += 1
    at += FRAME_MS
    if (frame % FLUSH_EVERY === 0) {
      upsertRows += await flushOnce(recorder, api)
      flushCount += 1
    }
  }
  upsertRows += await drain(recorder, api)

  // 静默时段：没有任何新消息，再来 10 轮 flush —— 旧版每轮都会把前 400 个人重写一遍
  let idleRows = 0
  for (let round = 0; round < 10; round++) idleRows += await flushOnce(recorder, api)
  upsertRows += idleRows

  const messages = await count(rawQuery, `select count(*)::int as value from douyin_link_messages where web_rid = '${SYNTH_RID}'`)
  const senders = await count(
    rawQuery,
    `select count(distinct user_id)::int as value from douyin_link_messages where web_rid = '${SYNTH_RID}' and user_id <> ''`
  )
  const stored = await count(rawQuery, `select count(*)::int as value from douyin_link_users where web_rid = '${SYNTH_RID}'`)

  console.log(`\n=== 场景一：合成 ${total} 人（flush ${flushCount} 轮 + 收尾，消息 ${messages} 条）===`)
  console.log(`  档案行          ${stored} / 应有 ${senders}`)
  console.log(`  写库的用户行数  ${upsertRows}（其中静默 10 轮里 ${idleRows} 行 —— 理想值是 0）`)

  check(stored === senders, '场景一：每个发过言的人都要有档案行', `只有 ${stored} / ${senders}`)
  check(idleRows === 0, '场景一：没有新消息时不该再写用户行', `静默 10 轮写了 ${idleRows} 行`)
  return { 场景: '合成 900 人', 应有档案: senders, 实际档案: stored, 用户行写入: upsertRows, 静默空转: idleRows }
}

/* --------------------------------------------------- 场景二：真实消息流回放 */

async function replayRoom(webRid) {
  const rows = (
    await sourceQuery(
      `select session_id, kind, user_id, user_name, content, count, diamonds, to_user_id, to_user_name, at_ms
         from douyin_link_messages where web_rid = '${webRid}' and user_id <> '' order by at_ms, id`
    )
  ).rows
  if (rows.length === 0) return null

  const api = { mapper }
  const recorder = new RoomRecorder(webRid)
  let sessionId = null
  let window = 0
  let upsertRows = 0

  for (const row of rows) {
    const at = Number(row.at_ms)
    if (row.session_id !== sessionId) {
      // 换会话：照 hub 的做法先收尾上一场，再 begin() 新的一场（begin 会清内存用户表）
      upsertRows += await drain(recorder, api)
      sessionId = row.session_id
      window = Math.floor(at / 2000)
      recorder.begin(sessionId, 200)
    }
    const nextWindow = Math.floor(at / 2000)
    if (nextWindow !== window) {
      upsertRows += await flushOnce(recorder, api)
      window = nextWindow
    }
    const nickname = String(row.user_name ?? '')
    recorder.ingest(
      [
        item(row.kind, row.user_id, nickname, String(row.content ?? ''), at, {
          count: Number(row.count ?? 0),
          diamonds: Number(row.diamonds ?? 0),
          toUser: String(row.to_user_name ?? ''),
          toUserId: String(row.to_user_id ?? '')
        })
      ],
      [userInfo(row.user_id, nickname)],
      200
    )
  }
  upsertRows += await drain(recorder, api)

  const senders = await count(
    rawQuery,
    `select count(distinct user_id)::int as value from douyin_link_messages where web_rid = '${webRid}' and user_id <> ''`
  )
  const stored = await count(rawQuery, `select count(*)::int as value from douyin_link_users where web_rid = '${webRid}'`)
  const real = await count(
    sourceQuery,
    `select count(*)::int as value from douyin_link_users where web_rid = '${webRid}'`
  )
  console.log(`\n=== 场景二：${webRid} 真实回放（${rows.length} 条消息，复现出来的档案行 ${stored}）===`)
  console.log(`  应有档案 ${senders} 人 · 用户行写入 ${upsertRows}（真库里那一列有 ${real} 行，可作参照）`)
  check(stored === senders, `场景二 ${webRid}：每个发过言的人都要有档案行`, `只有 ${stored} / ${senders}`)
  return { 场景: `回放 ${webRid}`, 应有档案: senders, 实际档案: stored, 用户行写入: upsertRows, 静默空转: 0 }
}

/* --------------------------------------------------- 场景三：补档案（真库副本） */

/**
 * 在**真库副本**上跑一次 `repairUsersFromMessages`，验三件事：
 * 1. 补之前确实缺行、补之后一行不缺；
 * 2. **已有档案一个字段都没动**（按 `id <= 补之前的 max(id)` 比对前后哈希）；
 * 3. 补出来的行与消息流水逐项对得上（五类互动次数、抖币、首末时间）。
 */
async function repairCheck() {
  const beforeRows = await count(rawQuery, `select count(*)::int as value from douyin_link_users`)
  const beforeMissing = await count(
    rawQuery,
    `select count(*)::int as value from (
       select distinct m.web_rid, m.user_id from douyin_link_messages m where m.user_id <> ''
     ) missing
     where not exists (
       select 1 from douyin_link_users u where u.web_rid = missing.web_rid and u.user_id = missing.user_id
     )`
  )
  const maxId = await count(rawQuery, `select coalesce(max(id), 0)::int as value from douyin_link_users`)
  const fingerprint = async () =>
    String(
      (
        await rawQuery(
          `select md5(string_agg(web_rid || '|' || user_id || '|' || nickname || '|' || chat || '|' || enter || '|' ||
             likes || '|' || follows || '|' || gift || '|' || diamonds || '|' || first_seen || '|' || last_seen, E'\\n'
             order by web_rid, user_id)) as value
           from douyin_link_users where id <= ${maxId}`
        )
      ).rows[0]?.value ?? ''
    )
  const beforeHash = await fingerprint()

  const reported = async () =>
    (
      await rawQuery(
        `select web_rid, user_id, nickname, chat,
                to_char(to_timestamp(first_seen/1000), 'MM-DD HH24:MI') as first_at,
                to_char(to_timestamp(last_seen/1000), 'MM-DD HH24:MI') as last_at
           from douyin_link_users where user_id = '100400732623' and web_rid = '108011161837'`
      )
    ).rows[0]
  const reportedBefore = await reported()

  const started = Date.now()
  const repaired = await mapper.repairUsersFromMessages('')
  const spent = Date.now() - started
  const reportedAfter = await reported()

  const afterRows = await count(rawQuery, `select count(*)::int as value from douyin_link_users`)
  const afterMissing = await count(
    rawQuery,
    `select count(*)::int as value from (
       select distinct m.web_rid, m.user_id from douyin_link_messages m where m.user_id <> ''
     ) missing
     where not exists (
       select 1 from douyin_link_users u where u.web_rid = missing.web_rid and u.user_id = missing.user_id
     )`
  )
  const afterHash = await fingerprint()
  /** 补出来的行与流水逐项对账（只查补出来的那批：`id > maxId`） */
  const mismatched = await count(
    rawQuery,
    `select count(*)::int as value from douyin_link_users u where u.id > ${maxId} and (
       u.chat <> (select count(*) from douyin_link_messages m where m.web_rid = u.web_rid and m.user_id = u.user_id and m.kind = 'chat')
       or u.enter <> (select count(*) from douyin_link_messages m where m.web_rid = u.web_rid and m.user_id = u.user_id and m.kind = 'member')
       or u.likes <> (select count(*) from douyin_link_messages m where m.web_rid = u.web_rid and m.user_id = u.user_id and m.kind = 'like')
       or u.follows <> (select count(*) from douyin_link_messages m where m.web_rid = u.web_rid and m.user_id = u.user_id and m.kind = 'social')
       or u.gift <> (select count(*) from douyin_link_messages m where m.web_rid = u.web_rid and m.user_id = u.user_id and m.kind = 'gift')
       or u.diamonds <> (select coalesce(sum(m.diamonds), 0) from douyin_link_messages m where m.web_rid = u.web_rid and m.user_id = u.user_id and m.kind = 'gift')
       or u.first_seen <> (select min(m.at_ms) from douyin_link_messages m where m.web_rid = u.web_rid and m.user_id = u.user_id)
       or u.last_seen <> (select max(m.at_ms) from douyin_link_messages m where m.web_rid = u.web_rid and m.user_id = u.user_id)
     )`
  )

  const describeReported = (row) =>
    row ? `${row.nickname}（chat=${row.chat}，${row.first_at}~${row.last_at}）` : '没有档案行'

  console.log('\n=== 场景三：在真库副本上补档案 ===')
  console.log(`  档案行          ${beforeRows} → ${afterRows}（补了 ${repaired} 行，耗时 ${spent}ms）`)
  console.log(`  缺档案的人      ${beforeMissing} → ${afterMissing}`)
  console.log(`  已有档案指纹    ${beforeHash.slice(0, 12)}… → ${afterHash.slice(0, 12)}…`)
  console.log(`  报障那位        补之前：${describeReported(reportedBefore)} → 补之后：${describeReported(reportedAfter)}`)
  console.log(`  与流水对不上的补出行 ${mismatched}`)

  check(beforeMissing > 0, '场景三：副本上本来就缺档案（否则这次验证没意义）', `缺 ${beforeMissing}`)
  check(!reportedBefore, '场景三：报障那位在副本里本来没有档案行')
  check(afterMissing === 0, '场景三：补完之后一行不缺', `还缺 ${afterMissing}`)
  check(beforeHash === afterHash, '场景三：已有档案一个字段都不能动', '指纹变了')
  check(mismatched === 0, '场景三：补出来的行要与消息流水逐项对得上', `${mismatched} 行对不上`)
  check(
    Boolean(reportedAfter) && reportedAfter.chat === 2 && reportedAfter.nickname === '拒绝大王',
    '场景三：报障用户（108011161837 / 100400732623）要补出 2 条弹幕的档案',
    describeReported(reportedAfter)
  )
  return {
    场景: '补档案（真库副本）',
    应有档案: afterRows,
    实际档案: afterRows,
    用户行写入: repaired,
    静默空转: 0
  }
}

/* ------------------------------------------------------------------ 主流程 */

if (repairMode) {
  console.log(`补档案验证（副本）：${sourceDir}`)
  const results = [await repairCheck()]
  console.log('\n=== 小结 ===')
  console.table(results)
  if (failures.length > 0) {
    console.log(`\n✗ ${failures.length} 项断言失败：`)
    for (const failure of failures) console.log(`  - ${failure}`)
  } else {
    console.log('\n✓ 全部断言通过')
  }
  await closeOrm().catch(() => undefined)
  rmSync(workDir, { recursive: true, force: true })
  process.exit(failures.length > 0 ? 1 : 0)
}

console.log(`recorder：${recorderLabel}`)
const results = [await synthetic()]

if (sourceDir) {
  const rooms = (
    await sourceQuery(
      `select web_rid from douyin_link_messages where user_id <> '' group by web_rid order by count(*) desc limit 2`
    )
  ).rows
  for (const room of rooms) {
    const result = await replayRoom(room.web_rid)
    if (result) results.push(result)
  }
}

console.log('\n=== 小结 ===')
console.table(results)
if (failures.length > 0) {
  console.log(`\n✗ ${failures.length} 项断言失败：`)
  for (const failure of failures) console.log(`  - ${failure}`)
} else {
  console.log('\n✓ 全部断言通过')
}

await closeOrm().catch(() => undefined)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures.length > 0 ? 1 : 0)
