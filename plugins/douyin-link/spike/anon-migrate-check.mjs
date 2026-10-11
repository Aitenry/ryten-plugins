/**
 * 匿名身份拆分：**在真库副本上跑一遍迁移**并量出前后差异（dev-only，不参与打包）。
 *
 * 为什么单开这一个脚本（`anon-identity-check.mjs` 覆盖不到）：那个工装一开场就建好了内存库
 * （ORM 替身是懒建 + 只建一次），中途换不了库；真库副本必须在**进程一开始**就指向它。
 *
 * 跑法（**只给副本路径**，绝不指向应用正在用的数据目录——PGlite 没有跨进程锁）：
 *   node plugins/douyin-link/spike/anon-migrate-check.mjs "$env:TEMP\rbdb-anon"
 *
 * 它做四件事：
 * 1. 量出重排前「挤在共用占位 id `111111` 上」的消息行数与档案行数（真库实测 76 / 4）；
 * 2. 跑 `mapper.splitAnonymousIdentities()`，量出改动行数与耗时；
 * 3. **再跑一遍断言为 0**（幂等）；
 * 4. 抽查一个房间：重排后每个人的档案统计是不是只剩自己的那几条
 *    （用户报障的正是「个人主页内容重复」——原来那里是十几个人的合计）。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../../../')
const PLUGIN = join(HERE, '..')

const dataDir = process.argv[2] ?? process.env.DY_DB_DIR ?? ''
if (!dataDir || !existsSync(join(dataDir, 'PG_VERSION'))) {
  console.error('用法：node anon-migrate-check.mjs <PGlite 数据目录（副本！）>')
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
const workDir = mkdtempSync(join(tmpdir(), 'douyin-anon-migrate-'))
process.env.DY_PGLITE_URL = pathToFileURL(resolvePglite()).href
/** **写库就是这份副本**（ORM 替身按它建 PGlite） */
process.env.DY_WRITE_DIR = dataDir

const ormStub = join(workDir, 'orm.mjs')
writeFileSync(
  ormStub,
  `import { drizzle } from 'drizzle-orm/pglite'\n` +
    `import { PGlite } from '@electric-sql/pglite'\n` +
    `let client = null\n` +
    `let orm = null\n` +
    `export async function withOrm(_op, fn) {\n` +
    `  if (!client) { client = new PGlite(process.env.DY_WRITE_DIR); orm = drizzle(client) }\n` +
    `  return fn(orm)\n` +
    `}\n` +
    `export async function rawQuery(sql) { if (!client) client = new PGlite(process.env.DY_WRITE_DIR); return client.query(sql) }\n` +
    `export async function closeOrm() { if (client) await client.close() }\n`,
  'utf8'
)
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
writeFileSync(
  logStub,
  `const noop = () => {}\n` + `export default { info: noop, warn: noop, error: noop, debug: noop }\n`,
  'utf8'
)

const outfile = join(workDir, 'bundle.mjs')
await build({
  stdin: {
    contents: `
export * as mapper from '${slash(join(PLUGIN, 'main/db/mapper.ts'))}'
export { closeOrm, rawQuery } from '@host/main/database/orm'
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
        api.onResolve({ filter: /^electron$/ }, () => ({ path: logStub }))
        api.onResolve({ filter: /^electron-log$/ }, () => ({ path: logStub }))
        api.onResolve({ filter: /^@host\/main\/database\/orm$/ }, () => ({ path: ormStub }))
        api.onResolve({ filter: /^@host\// }, () => ({ path: logStub }))
        api.onResolve({ filter: /^@electric-sql\/pglite$/ }, () => ({ path: pgliteShim }))
      }
    }
  ]
})

const { mapper, closeOrm, rawQuery } = await import(pathToFileURL(outfile).href)

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`
  )
}

const count = async (table, where) => {
  const result = await rawQuery(`select count(*)::int as value from ${table} where ${where}`)
  return Number(result.rows?.[0]?.value ?? 0)
}

console.log(`=== 副本：${dataDir} ===`)
/** 「还没拆」的行：共用占位 id，或 `anon:` 开头但没有马甲段（半迁移状态也算） */
const UNSET = `(user_id = '111111' or (user_id like 'anon:%' and position('#' in user_id) = 0))`
const beforeMessages = await count('douyin_link_messages', UNSET)
const beforeUsers = await count('douyin_link_users', UNSET)
/** 已经拆好的行（重排前就存在的）——真库可能已经迁过，所以要用**增量**核，不能只看总数 */
const beforeSplitMessages = await count('douyin_link_messages', `user_id like 'anon:%#%'`)
const beforeNames = await rawQuery(
  `select count(distinct (web_rid || '|' || user_name))::int as value from douyin_link_messages where ${UNSET}`
)
console.log(
  `      重排前：消息行 ${beforeMessages} 条、档案行 ${beforeUsers} 条、` +
    `涉及 ${beforeNames.rows?.[0]?.value ?? 0} 个「房间+马甲」组合`
)
if (beforeMessages === 0) {
  console.log('      这份副本里已经没有「所有匿名挤在一个 id 上」的行（已经迁移过或没有匿名数据）')
  await closeOrm()
  rmSync(workDir, { recursive: true, force: true })
  process.exit(0)
}

const startedAt = Date.now()
const moved = await mapper.splitAnonymousIdentities()
console.log(`      重排了 ${moved} 行，耗时 ${Date.now() - startedAt}ms`)

const afterMessages = await count('douyin_link_messages', UNSET)
const afterUsers = await count('douyin_link_users', UNSET)
const splitUsers = await count('douyin_link_users', `user_id like 'anon:%#%'`)
const splitMessages = await count('douyin_link_messages', `user_id like 'anon:%#%'`)
const splitNames = await rawQuery(
  `select count(distinct (web_rid || '|' || nickname))::int as value from douyin_link_users where user_id like 'anon:%#%'`
)
console.log(
  `      重排后：还挤在共用 id 上的消息 ${afterMessages} 条、档案 ${afterUsers} 条；` +
    `按马甲分开的档案 ${splitUsers} 条、消息 ${splitMessages} 条`
)
check('旧的共享档案行清零', afterUsers, 0)
/**
 * 用**增量**核：`还挤在共用 id 上的行` 减少了多少，`按马甲分开的行` 就该增加多少。
 * （不能直接比总数：真库可能已经迁过一轮，那时 before 里就已经有拆好的行了。）
 */
check(
  '消息行是「换身份」不是「复制/丢弃」：两边增量相等',
  beforeMessages - afterMessages,
  splitMessages - beforeSplitMessages
)
check('消息行总数没变（合计守恒）', afterMessages + splitMessages, beforeMessages + beforeSplitMessages)
/**
 * 「拆出来的身份数」= **每个房间各自**的马甲数，所以对不上「所有房间的马甲并集」。
 * 用 `(房间, 马甲)` 这个组合数来核：拆出来的档案应该正好等于它（同一房间同一个马甲只留一行）。
 */
check('拆出来的档案数 == 房间 × 马甲的组合数', splitUsers, Number(splitNames.rows?.[0]?.value ?? 0))
check('确实拆出了多个身份（不是原地换一个键）', splitUsers > beforeUsers, true)

const again = await mapper.splitAnonymousIdentities()
check('幂等：跑第二遍什么都不改', again, 0)

/** 抽查一个房间：重排后每个人的档案统计只算自己的（用户报障的「个人主页内容重复」） */
const busiest = await rawQuery(
  `select web_rid, count(*)::int as value from douyin_link_messages where user_id like 'anon:%#%'
     group by web_rid order by value desc limit 1`
)
const room = busiest.rows?.[0]?.web_rid
if (room) {
  const rows = await rawQuery(
    `select u.user_id, u.nickname, u.chat, u.enter,
       (select count(*)::int from douyin_link_messages m where m.web_rid = u.web_rid and m.user_id = u.user_id and m.kind = 'chat') as chat_rows
     from douyin_link_users u where u.web_rid = '${room}' and u.user_id like 'anon:%#%'
     order by u.chat desc limit 8`
  )
  console.log(`\n      房间 ${room} 重排后的匿名档案（弹幕累计 / 库里还留着的弹幕行数）：`)
  console.table(rows.rows)
  /**
   * 只断言**不会多于**流水里数得出来的条数：`chat` 是「档案里的累计」，而消息流水可能被
   * 「清空本房间记录」或保留期清掉过——那时档案大于流水行数是正常的（历史累计比流水留得久）。
   * 反过来（档案少于流水）说明这个人的行被算到别人头上了，那才是 bug。
   * 本行数据里的反例：`dou2056511` 累计 4 条、流水 0 条——旧版把十几个人的条目全加在他身上
   * （bug 本体），而 4 这个数字本身是旧数据留下来的历史账，迁移只按流水重算「能算的那部分」。
   */
  const overloaded = (rows.rows ?? []).filter((row) => Number(row.chat) < Number(row.chat_rows)).length
  check('没有「档案比流水还少」的人（那说明行被算到别人头上）', overloaded, 0)

  /**
   * 「匿名的人能不能还原成真账号」——**这条断言是真库现状的结论**（用户 2026-10-12 的要求）：
   * 主进程的候选查询（`getAnonymousCandidates`：id 以马甲尾段结尾 或 昵称就是这个马甲名）
   * 在这份真库上**一条都收不到** → 「查看真实资料」按钮点了只会如实回 `anonymousMasked`。
   *
   * 为什么真库里必然没有：马甲名尾段是**真实 id 的尾段**，而一个真实 id 是它自己的账号，
   * 昵称不会是这个马甲名；所以这个索引只有「那人自己在别的房间露过真名/真 id」时才可能命中。
   * 哪天这条断言变红（收得到候选了），就说明真库形态变了——那时再回来看还原这条路。
   */
  const probe = (rows.rows ?? []).find((row) => /^dou\d+$/.test(String(row.nickname))) ?? rows.rows?.[0]
  if (probe) {
    const candidates = await mapper.getAnonymousCandidates(room, String(probe.nickname), String(probe.nickname).replace(/^dou/, ''))
    console.log(
      `      匿名还原线索（房间 ${room} / 马甲 ${probe.nickname}）：` +
        `库里候选 ${candidates.length} 个（id 尾段或同名）`
    )
    check('真库现状：匿名还原的本地候选为空 → 按钮只会如实回「还原不了」', candidates.length, 0)
  }
}

await closeOrm()
console.log(`\n=== 小结 ===\n${failures === 0 ? '✓ 全部断言通过' : `✗ ${failures} 项断言失败`}`)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)