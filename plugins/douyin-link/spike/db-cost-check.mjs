/*
 * 「渲染层轮询一次到底要花多少钱」+「关应用要多久」的**真库测量**（dev-only，不参与打包）。
 *
 * 为什么要这个工装（2026-10-11）：用户两条反馈——
 *   ①「有一些内容都是渲染进程主动轮询，而不是由主进程推送数据的，这样子不行的」；
 *   ②「这个插件运行久了之后，会导致整体应用关闭窗口失败，需要关闭两次窗口」。
 * 两条指向同一件事：**同一批聚合查询在被反复跑，而数据是永久保存、越跑越大**。
 * 所以先量成本（真 mapper + 真 PGlite + 用户的真库副本），再决定推什么、多久推一次、
 * 哪些查询绝不能落进轮询。
 *
 * ⚠️ **PGlite 没有跨进程锁**：DB 目录必须是**副本**（应用正在用真库时绝不能开它）。
 *    powershell: Copy-Item "$env:APPDATA\ryten-bench\RytenBenchDB" "$env:TEMP\rbdb-copy" -Recurse
 *
 * 跑法（仓库根目录；PGlite 从 ryten-bench 找，或用 RB_PGLITE 指定 dist/index.js）：
 *   node plugins/douyin-link/spike/db-cost-check.mjs "$env:TEMP\rbdb-copy"
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件仓库根（本脚本在 plugins/douyin-link/spike/ 下） */
const ROOT = join(HERE, '../../../')
const PLUGIN = join(HERE, '..')

const dataDir = process.argv[2] ?? process.env.DY_DB_DIR ?? ''
if (!dataDir || !existsSync(join(dataDir, 'PG_VERSION'))) {
  console.error('用法：node db-cost-check.mjs <PGlite 数据目录副本>（或 DY_DB_DIR=…）')
  process.exit(2)
}

/** 找宿主那份 PGlite（本脚本不打包依赖，与 db-inspect.mjs / db-merge-check.mjs 同口径） */
function resolvePglite() {
  const candidates = [process.env.RB_PGLITE]
  candidates.push('E:\\Development-Warehouse\\github\\ryten-bench\\node_modules\\@electric-sql\\pglite\\dist\\index.js')
  for (const path of candidates) if (path && existsSync(path)) return path
  console.error('找不到 @electric-sql/pglite，可用 RB_PGLITE=<dist/index.js 路径> 指定')
  process.exit(2)
}
const pglitePath = resolvePglite()

const START = Date.now()
const workDir = mkdtempSync(join(tmpdir(), 'douyin-db-cost-'))

/* 宿主那层薄封装（withOrm）→ 真 PGlite + 真 drizzle（与 db-merge-check.mjs 同款） */
const ormStub = join(workDir, 'orm.mjs')
writeFileSync(
  ormStub,
  `import { drizzle } from 'drizzle-orm/pglite'\n` +
    `import { PGlite } from '@electric-sql/pglite'\n` +
    `let client = null\n` +
    `let orm = null\n` +
    `export async function withOrm(_op, fn) {\n` +
    `  if (!client) { client = new PGlite(process.env.DY_PGLITE_DIR); orm = drizzle(client) }\n` +
    `  return fn(orm)\n` +
    `}\n` +
    `export async function rawQuery(sql) { return client.query(sql) }\n` +
    `export async function closeOrm() { const t = Date.now(); await client.close(); return Date.now() - t }\n`,
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
export { withOrm, rawQuery, closeOrm } from '@host/main/database/orm'
export * as mapper from './mapper'
`,
    loader: 'ts',
    resolveDir: join(PLUGIN, 'main/db')
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
      name: 'douyin-db-cost',
      setup(api) {
        api.onResolve({ filter: /^@host\/main\/database\/orm$/ }, () => ({ path: ormStub }))
        api.onResolve({ filter: /^@electric-sql\/pglite$/ }, () => ({ path: pgliteShim }))
        api.onResolve({ filter: /^electron-log$/ }, () => ({ path: logStub }))
        return null
      }
    }
  ]
})

process.env.DY_PGLITE_DIR = dataDir
process.env.DY_PGLITE_URL = pathToFileURL(pglitePath).href

const { mapper, rawQuery, closeOrm } = await import(pathToFileURL(outfile).href)

/**
 * `RB_COST_CLOSE_ONLY=1`：只量「打开 + 关闭」——用来回答「点退出之后为什么要等那么久」。
 *
 * 为什么单独一个模式：正常模式会先跑一堆查询，那些查询本身会推动检查点，
 * 量出来的 close 就不代表「用户点退出那一刻」的成本了。这个模式**只开、不查、立刻关**。
 */
if (process.env.RB_COST_CLOSE_ONLY === '1') {
  const openMs = Date.now() - START
  console.log(`库目录：${dataDir}`)
  console.log(`  PGlite 打开（含 WAL 恢复）  ${openMs}ms`)
  /**
   * **心跳**：这是判断「该用什么修法」的关键——如果 close 期间事件循环还在跑，
   * 那宿主可以用 `Promise.race(close, 超时)` 兜住；如果心跳停了，说明 close 是**同步**堵死
   * 主线程的（PGlite 是 WASM、跑在主进程里），那任何超时/定时器都不会触发，
   * 只能改成「退出时不等它」。
   */
  let beats = 0
  const beat = setInterval(() => {
    beats += 1
    console.log(`    [心跳] close 已跑 ${((Date.now() - START - openMs) / 1000).toFixed(0)}s（事件循环仍然活着）`)
  }, 3000)
  const closeMs = await closeOrm()
  clearInterval(beat)
  console.log(`  db.close()（检查点 + 折 WAL）  ${closeMs}ms，期间心跳 ${beats} 次`)
  console.log(beats === 0 ? '  → close 期间事件循环**没有**跑（同步堵死主线程）' : '  → close 期间事件循环仍在跑（可以用超时兜）')
  rmSync(workDir, { recursive: true, force: true })
  process.exit(0)
}

/**
 * `RB_COST_CHECKPOINT=1`：量「手动 CHECKPOINT」的成本，以及**检查点之后**的 close 成本。
 *
 * 这是为 2026-10-11 那个「关应用要关两次」：真库的 `pg_wal` 涨到 912MB，
 * `db.close()`（检查点 + 折 WAL）在主进程里跑了 **10 分钟以上没结束**——PGlite 是 WASM、
 * 跑在主进程里，整个应用因此卡住，点关闭当然「没反应」。这个模式用来验证
 * 「定期主动 CHECKPOINT、把 WAL 压住，让退出那次检查点变便宜」这条路走不走得通。
 */
if (process.env.RB_COST_CHECKPOINT === '1') {
  const openMs = Date.now() - START
  const walBytes = async () => {
    const r = await rawQuery(`select coalesce(sum(size), 0)::bigint as bytes from pg_ls_waldir()`)
    return Number(r.rows[0].bytes)
  }
  console.log(`库目录：${dataDir}`)
  console.log(`  PGlite 打开（含 WAL 恢复）  ${openMs}ms`)
  console.log(`  检查点之前 pg_wal           ${(await walBytes() / 1048576).toFixed(1)} MB`)
  const t1 = Date.now()
  await rawQuery('CHECKPOINT')
  console.log(`  第 1 次 CHECKPOINT         ${Date.now() - t1}ms`)
  console.log(`  检查点之后 pg_wal           ${(await walBytes() / 1048576).toFixed(1)} MB`)
  const t2 = Date.now()
  await rawQuery('CHECKPOINT')
  console.log(`  第 2 次 CHECKPOINT         ${Date.now() - t2}ms`)
  const t3 = Date.now()
  await rawQuery('CHECKPOINT')
  console.log(`  第 3 次 CHECKPOINT         ${Date.now() - t3}ms`)
  const closeMs = await closeOrm()
  console.log(`  db.close()                 ${closeMs}ms`)
  rmSync(workDir, { recursive: true, force: true })
  process.exit(0)
}

const NOW = Date.now()
const HOUR = 3600 * 1000
const rowsOf = async (sql) => (await rawQuery(sql)).rows

console.log(`库目录：${dataDir}`)
const pkgVersion = JSON.parse(readFileSync(join(PLUGIN, 'manifest.ts'), 'utf8').match(/version: '([^']+)'/)[1] ? '{}' : '{}')
void pkgVersion
console.log('')

/* ---------------------------------------------------------- 0. 库里有什么 */

const tables = await rowsOf(
  `select relname as name, pg_total_relation_size(relid) as bytes
     from pg_stat_user_tables where relname like 'douyin%' order by bytes desc`
)
console.log('=== 表与大小 ===')
for (const t of tables) {
  const n = (await rowsOf(`select count(*)::int as n from ${t.name}`))[0].n
  console.log(`  ${String(t.name).padEnd(28)} 行 ${String(n).padStart(9)}  ${(Number(t.bytes) / 1048576).toFixed(1)} MB`)
}
const rooms = await rowsOf(
  `select web_rid, count(*)::int as n from douyin_link_messages group by 1 order by 2 desc`
)
console.log('\n=== 每个房间的消息行数 ===')
for (const r of rooms) console.log(`  ${r.web_rid}  ${r.n}`)

const span = await rowsOf(`select min(at_ms)::bigint as first, max(at_ms)::bigint as last from douyin_link_messages`)
console.log(
  `\n消息跨度：${new Date(Number(span[0].first)).toISOString()} → ${new Date(Number(span[0].last)).toISOString()}`
)

/* --------------------------------------------- 1. 量：界面轮询/推送用到的真实查询 */

const time = async (label, fn, runs = 2) => {
  const samples = []
  let value
  for (let i = 0; i < runs; i += 1) {
    const t = Date.now()
    value = await fn()
    samples.push(Date.now() - t)
  }
  const size =
    value === undefined || value === null || typeof value === 'number'
      ? ''
      : Array.isArray(value)
        ? `   （${value.length} 项）`
        : value instanceof Map
          ? `   （${value.size} 项）`
          : ''
  console.log(`  ${label.padEnd(48)}${samples.map((s) => String(s).padStart(6) + 'ms').join(' ')}${size}`)
  return value
}

const widest = rooms[0]?.web_rid ?? ''
const from24 = NOW - 24 * HOUR
const fromMinute = Math.floor(from24 / 60000)
const toMinute = Math.floor(NOW / 60000)

console.log(`\n=== 界面用到的查询（每个跑 2 次；第一次含冷缓存） ===`)
console.log(`（房间取消息最多的那个：${widest}；窗口 = 最近 24 小时）\n`)

console.log('· 概览（SUMMARY_EVENT 每次推送都要跑这一组）')
await time('windowTotals(24h) ← 里面就是 windowAggregates', () => mapper.windowTotals(widest, from24, NOW))
await time('messageCount(24h)', () => mapper.messageCount(widest, from24, NOW))
await time('minuteSeries(24h)', () => mapper.minuteSeries(widest, fromMinute, toMinute))
await time('giftRankByPerson(recipient,24h)', () => mapper.giftRankByPerson(widest, 'recipient', from24, NOW, 20))
await time('chatRankByPerson(24h)', () => mapper.chatRankByPerson(widest, from24, NOW, 20))
await time('giftBreakdown(24h)', () => mapper.giftBreakdown(widest, from24, NOW, 40))
await time('listSessions(5)', () => mapper.listSessions(widest, 5))

console.log('\n· 数据大屏全局分析（ALL_EVENT 每次推送都要跑这一组）')
await time('windowAggregates(24h) ← 跨房横截面', () => mapper.windowAggregates(from24, NOW))
await time('activeMinutes(24h)', () => mapper.activeMinutes(fromMinute, toMinute))
await time('minuteSeriesAll(24h)', () => mapper.minuteSeriesAll(fromMinute, toMinute))
await time('activeUsersAll(24h)', () => mapper.activeUsersAll(from24, NOW))
await time('giftRankByPersonAll(recipient,24h)', () => mapper.giftRankByPersonAll('recipient', from24, NOW, 20))
await time('giftBreakdownAll(24h)', () => mapper.giftBreakdownAll(from24, NOW, 40))
await time('minuteSeriesPerRoom(24h)', () => mapper.minuteSeriesPerRoom(fromMinute, toMinute))

console.log('\n· 房间对比 / 在线观众 / 每日记录（**渲染层正在按 5~30 秒轮询**的）')
await time('windowAggregates(10 分钟) ← 对比页 10 秒一次', () => mapper.windowAggregates(NOW - 10 * 60_000, NOW))
await time('activeMinutes(10 分钟)', () => mapper.activeMinutes(Math.floor((NOW - 10 * 60_000) / 60000), toMinute))
await time('listUsersPage(200) ← 在线观众（5 秒一次）', () => mapper.listUsersPage(widest, 'recent', '', 200, 0))
await time('dayRecords(90) ← 每日记录 60 秒一次', () => mapper.dayRecords(widest, 90))
await time('dbStats ← 房间列表每次推送都带', () => mapper.dbStats())
await time('roomStores ← 房间列表每次推送都带', () => mapper.roomStores())

/* ------------------------------------------------------------- 2. 关应用要多久 */

console.log('\n=== 关闭数据库（应用退出时 core 会 await 它） ===')
const closeMs = await closeOrm()
console.log(`  db.close()  ${closeMs}ms`)

rmSync(workDir, { recursive: true, force: true })

