/**
 * 看一眼**真实的应用库**里插件写进去的行（dev-only，不参与打包）。
 *
 * 什么时候用它：界面上显示的东西和预期不符（例如「礼物榜里只有一个有价格」），
 * 而主进程日志看不出所以然——直接查库最快：消息流水的 `kind / content / count / diamonds /
 * to_user_name` 到底是哪些值。
 *
 * ⚠️ **PGlite 没有跨进程锁**：绝不要用它连**应用正在用的**数据目录（两个进程同时写会写坏集群，
 * 2026-09-18 就是这么坏过一次）。正确做法是先退出应用，或把数据目录**整个复制一份**再查副本：
 *
 *   Copy-Item "$env:APPDATA\ryten-bench\RytenBenchDB" $env:TEMP\rbdb-copy -Recurse
 *   node plugins/douyin-link/spike/db-inspect.mjs "$env:TEMP\rbdb-copy" "select kind, count(*) from douyin_link_messages group by kind"
 *
 * 跑法：`node db-inspect.mjs <PGlite 数据目录> [SQL] [--json]`
 * 不带 SQL 时打一组常用查询（插件自己的表、消息类型分布、礼物行明细、用户礼物流水）。
 * 需要宿主的 `@electric-sql/pglite`：脚本从 `RB_PGLITE` 或默认的 ryten-bench 仓库里找。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const positional = args.filter((a) => !a.startsWith('--'))
const dataDir = positional[0]
const sqlArg = positional[1]

if (!dataDir || !existsSync(join(dataDir, 'PG_VERSION'))) {
  console.error('用法：node db-inspect.mjs <PGlite 数据目录（副本！）> [SQL] [--json]')
  process.exit(2)
}

/** 找宿主那份 PGlite（本脚本不打包任何依赖） */
function resolvePglite() {
  const candidates = []
  if (process.env.RB_PGLITE) candidates.push(process.env.RB_PGLITE)
  candidates.push(
    'E:\\Development-Warehouse\\github\\ryten-bench\\node_modules\\@electric-sql\\pglite\\dist\\index.js'
  )
  for (const path of candidates) if (path && existsSync(path)) return path
  // 兜底：从 ryten-bench 的 package.json 里读版本，去 pnpm store 里找
  const benchDir = 'E:\\Development-Warehouse\\github\\ryten-bench'
  try {
    const pkg = JSON.parse(readFileSync(join(benchDir, 'package.json'), 'utf8'))
    console.error(`（提示：没找到 PGlite；ryten-bench 声明的版本是 ${pkg.dependencies?.['@electric-sql/pglite'] ?? '?'}）`)
  } catch {
    /* ignore */
  }
  console.error('找不到 @electric-sql/pglite，可用 RB_PGLITE=<dist/index.js 路径> 指定')
  process.exit(2)
}

const { PGlite } = await import(pathToFileURL(resolvePglite()).href)
const db = new PGlite(dataDir)

/** 默认那组查询：插件的表 + 消息类型分布 + 礼物明细 + 用户礼物流水 */
const DEFAULT_QUERIES = [
  ['插件自己的表', `select tablename from pg_tables where schemaname='public' and tablename like 'douyin_link%' order by 1`],
  ['消息类型分布', `select kind, count(*) as rows, count(distinct web_rid) as rooms from douyin_link_messages group by kind order by rows desc`],
  [
    '礼物行明细（按正文分组）',
    `select content, count(*) as rows, sum(diamonds) as diamonds, count(*) filter (where diamonds > 0) as priced
       from douyin_link_messages where kind='gift' group by content order by rows desc`
  ],
  [
    '礼物行（最近 30 条）',
    `select to_char(to_timestamp(at_ms/1000), 'MM-DD HH24:MI:SS') as at, user_name, content, count, diamonds, to_user_name
       from douyin_link_messages where kind='gift' order by at_ms desc limit 30`
  ],
  [
    '用户礼物流水',
    `select user_name, sum(diamonds) as diamonds, count(*) as rows from douyin_link_messages
      where kind='gift' group by user_name order by diamonds desc nulls last limit 20`
  ],
  ['目录缓存', `select key, length(value) as bytes, left(value, 80) as head from douyin_link_meta where key like 'gifts.%'`]
]

const queries = sqlArg ? [['自定义', sqlArg]] : DEFAULT_QUERIES
for (const [label, sql] of queries) {
  console.log(`\n=== ${label} ===`)
  console.log(sql.replace(/\s+/g, ' ').trim())
  try {
    const result = await db.query(sql)
    if (asJson) console.log(JSON.stringify(result.rows, null, 2))
    else if (result.rows.length === 0) console.log('（没有行）')
    else console.table(result.rows)
  } catch (error) {
    console.log(`! 查询失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

// 顺带列出库里有没有别的可疑点：空正文的礼物、缺 to_user 的礼物
console.log('\n=== 诊断小结 ===')
const gift = await db.query(
  `select count(*)::int as total,
          count(*) filter (where content <> '')::int as named,
          count(*) filter (where diamonds > 0)::int as priced,
          count(*) filter (where to_user_name <> '')::int as with_recipient
     from douyin_link_messages where kind='gift'`
)
console.log(gift.rows[0])
console.log(`（同目录下还有 ${readdirSync(dataDir).length} 个文件/目录）`)
await db.close()
