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
import { douyinLinkMessages } from './schema'

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
await closeOrm()
export default JSON.stringify({
  afterWeak: afterWeak.map((r) => ({ id: String(r.id), content: r.content, diamonds: r.diamonds, atMs: r.atMs })),
  afterRecord: afterRecord.map((r) => ({ id: String(r.id), content: r.content, diamonds: r.diamonds, toUserName: r.toUserName, userName: r.userName, atMs: r.atMs })),
  reversed: reversed.map((r) => ({ content: r.content, diamonds: r.diamonds, atMs: r.atMs })),
  plainRows: plain.length,
  column: columns.rows.length,
  index: indexes.rows.length
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
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项不通过`)

rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
