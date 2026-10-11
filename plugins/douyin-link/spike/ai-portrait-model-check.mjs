/**
 * 真库验证：**AI 画像的整条生成链**（真 PGlite + 真 mapper + 真证据打包 + 假模型）。
 *
 * 为什么这样搭：这条链里最贵的、也最容易骗人的是「调模型」那一步，所以把它换成**可编排的假模型**
 * （能吐分片、能报 usage、能抛错、能挂住不返回），于是：
 * - 真库、真查询、真提示词全部照跑（材料里到底有没有这个人的弹幕原话、礼物名、房间名，看得见）；
 * - 而「调了几次、传了什么、写没写库、失败会不会毁掉已有画像」这些**行为**可以逐条钉死，
 *   且**一分钱不花**（真模型那一路在 `ai-portrait-live.mjs`，要显式 --live 才跑）。
 *
 * 覆盖的场景（都是线上真会发生的）：
 *  1. 建表（`douyin_link_user_portraits`）真的建了；
 *  2. 模型清单**不含 api_key**（主进程内部那份是解密过的，绝不能发给界面）；
 *  3. 第一次生成：写库（版本 1、结构化报告、指纹、用量），材料里带上了这个人的真弹幕与礼物；
 *  4. 已有缓存时**不再调模型**（用户的原话：每次重新生成会很亏 token）；
 *  5. 「重新生成」把上一版喂回去（版本 2，材料里出现上一版画像 + 迭代要求）；
 *  6. 同一个人的第二次请求在第一次还没跑完时 → `busy`（不重复花钱）；
 *  7. 互动太少 → `no-data`（不花钱）；一个可用供应商都没有 → `no-model`（不花钱）；
 *  8. 模型报错 → `model-failed`，而且**已有的画像不被毁**（只有成功才落库）；
 *  9. 流式增量真的推给了界面（分片拼起来 == 模型原文）；
 * 10. 选模型链：设置里指定的 > 宿主默认 > 已启用第一个（指定的那个被删/禁用时要能回落）。
 *
 * 跑法（仓库根目录）：
 *   # A 段（自造数据）总是跑：
 *   node plugins/douyin-link/spike/ai-portrait-model-check.mjs
 *   # B 段（真库副本，验证真人的材料）——必须先退出应用，PGlite 没有跨进程锁：
 *   Copy-Item "$env:APPDATA\ryten-bench\RytenBenchDB" "$env:TEMP\rbdb-copy" -Recurse
 *   node plugins/douyin-link/spike/ai-portrait-model-check.mjs "$env:TEMP\rbdb-copy"
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../../../')
const PLUGIN = join(HERE, '..')

const realDbDir = (process.argv[2] ?? process.env.DY_DB_DIR ?? '').replace(/^\/([A-Za-z]:)/, '$1')

/** 找宿主那份 PGlite（本仓库不装它，与 db-cost-check.mjs 同口径） */
function resolvePglite() {
  const candidates = [
    process.env.RB_PGLITE,
    'E:\\Development-Warehouse\\github\\ryten-bench\\node_modules\\@electric-sql\\pglite\\dist\\index.js'
  ]
  for (const path of candidates) if (path && existsSync(path)) return path
  console.error('找不到 @electric-sql/pglite，可用 RB_PGLITE=<dist/index.js 路径> 指定')
  process.exit(2)
}
const pglitePath = resolvePglite()

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : `\n       ${detail}`}`)
}
const eq = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(label, ok, `期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}`)
}
const has = (label, haystack, needle) =>
  check(label, String(haystack).includes(needle), `找不到：${JSON.stringify(needle)}`)

const SECRET = 'sk-WORKBENCH-SECRET-KEY-do-not-leak'

/* --------------------------------------------------------------- 假宿主（可编排） */

const workDir = mkdtempSync(join(tmpdir(), 'douyin-ai-model-'))
writeFileSync(join(workDir, 'package.json'), '{ "type": "module" }\n', 'utf8')

/** 宿主那层薄封装（withOrm）→ 真 PGlite + 真 drizzle */
writeFileSync(
  join(workDir, 'orm.mjs'),
  `import { drizzle } from 'drizzle-orm/pglite'\n` +
    `import { PGlite } from '@electric-sql/pglite'\n` +
    `let client = null\n` +
    `let orm = null\n` +
    `export async function withOrm(_op, fn) {\n` +
    `  if (!client) { client = new PGlite(process.env.DY_PGLITE_DIR); orm = drizzle(client) }\n` +
    `  return fn(orm)\n` +
    `}\n` +
    `export async function rawQuery(sql) { return client.query(sql) }\n` +
    `export async function closeOrm() { await client.close() }\n`,
  'utf8'
)
/** PGlite 走运行期真路径（esbuild 不做静态解析） */
writeFileSync(
  join(workDir, 'pglite-shim.mjs'),
  `const mod = await import(process.env.DY_PGLITE_URL)\n` +
    `export const PGlite = mod.PGlite\n` +
    `export const types = mod.types\n` +
    `export default mod\n`,
  'utf8'
)
/** 宿主的供应商配置表：按 `DY_PROVIDER_STATE` 现场给（好让工装逐场景切） */
writeFileSync(
  join(workDir, 'provider-mapper.mjs'),
  `function state() { return JSON.parse(process.env.DY_PROVIDER_STATE || '{}') }\n` +
    `function provider(id) {\n` +
    `  return { id, name: 'workbench-' + id, provider: 'openai', base_url: null, model: 'workbench-model',\n` +
    `    temperature: null, max_tokens: null, top_p: null, top_k: null, thinking_mode: 'auto',\n` +
    `    reasoning_effort: null, max_tool_rounds: 500, extra_config: null, metadata: null,\n` +
    `    is_default: false, is_enabled: true, sort_order: 0, is_pinned: false, api_key: ${JSON.stringify(SECRET)} }\n` +
    `}\n` +
    `export async function getEnabledProviders() { return (state().enabled || []).map(provider) }\n` +
    `export async function getDefaultProvider() {\n` +
    `  const s = state()\n` +
    `  return s.default == null ? null : provider(s.default)\n` +
    `}\n` +
    `export async function getProviderById(id) { return provider(id) }\n`,
  'utf8'
)
/** 宿主的模型服务：`createModel` 返回**工装编排的假模型**（挂在 globalThis 上） */
writeFileSync(
  join(workDir, 'provider-service.mjs'),
  `export function getProviderService() {\n` +
    `  return {\n` +
    `    async createModel(providerId) {\n` +
    `      globalThis.__DY_BUILT_PROVIDERS__ = [...(globalThis.__DY_BUILT_PROVIDERS__ || []), providerId]\n` +
    `      const make = globalThis.__DY_FAKE_MODEL__\n` +
    `      if (!make) throw new Error('工装没有装假模型')\n` +
    `      return make(providerId)\n` +
    `    },\n` +
    `    async getConfig(providerId) {\n` +
    `      return { id: providerId, name: 'workbench-' + providerId, provider: 'openai', model: 'workbench-model',\n` +
    `        is_default: false, is_enabled: true, api_key: ${JSON.stringify(SECRET)} }\n` +
    `    },\n` +
    `    clearCache() {}\n` +
    `  }\n` +
    `}\n`,
  'utf8'
)
writeFileSync(
  join(workDir, 'i18n.mjs'),
  `export function getMainLanguage() { return process.env.DY_LANG || 'zh-CN' }\n` +
    `export function mainFormat(template) { return String(template) }\n` +
    `export function mainPlural(one) { return String(one) }\n` +
    `export function mainMessages() { return {} }\n`,
  'utf8'
)
/** 推事件：转交工装的收集器（断言流式增量真的发出去了） */
writeFileSync(
  join(workDir, 'safe-send.mjs'),
  `export function safeSend(_wc, channel, payload) { globalThis.__DOUYIN_SEND__?.(channel, payload) }\n`,
  'utf8'
)
writeFileSync(
  join(workDir, 'electron.mjs'),
  // 给一个「活着」的窗口：事件推送走 `BrowserWindow.getAllWindows()` + safeSend（stub 再转给工装收集器）
  `export const BrowserWindow = {\n` +
    `  getAllWindows: () => [{ isDestroyed: () => false, webContents: { id: 1 } }]\n` +
    `}\n` +
    `export const app = { getPath: () => process.env.DY_USER_DATA || process.cwd(), isReady: () => true, getAppPath: () => process.cwd() }\n`,
  'utf8'
)
writeFileSync(join(workDir, 'log.mjs'), `export default { info() {}, warn() {}, error() {}, debug() {} }\n`, 'utf8')

const outfile = join(workDir, 'bundle.mjs')
await build({
  stdin: {
    contents:
      `export * as portrait from './portrait'\n` +
      `export * as mapper from './db/mapper'\n` +
      // 顺手把桩里的这三个也导出：工装要直接跑 SQL（不另外 import 桩文件，那会绕开打包、找不到依赖）
      `export { rawQuery, closeOrm } from '@host/main/database/orm'\n`,
    loader: 'ts',
    resolveDir: join(PLUGIN, 'main')
  },
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
  /** 桩文件写在临时目录里（那里没有 node_modules）：把本仓库的依赖目录告诉 esbuild */
  nodePaths: [join(ROOT, 'node_modules')],
  plugins: [
    {
      name: 'douyin-ai-model',
      setup(api) {
        api.onResolve({ filter: /^@host\/main\/database\/orm$/ }, () => ({ path: join(workDir, 'orm.mjs') }))
        api.onResolve({ filter: /^@electric-sql\/pglite$/ }, () => ({ path: join(workDir, 'pglite-shim.mjs') }))
        api.onResolve({ filter: /^@host\/main\/database\/mapper\/provider$/ }, () => ({
          path: join(workDir, 'provider-mapper.mjs')
        }))
        api.onResolve({ filter: /^@host\/main\/provider\/service$/ }, () => ({
          path: join(workDir, 'provider-service.mjs')
        }))
        api.onResolve({ filter: /^@host\/main\/i18n$/ }, () => ({ path: join(workDir, 'i18n.mjs') }))
        api.onResolve({ filter: /^@host\/main\/safe-send$/ }, () => ({ path: join(workDir, 'safe-send.mjs') }))
        api.onResolve({ filter: /^electron$/ }, () => ({ path: join(workDir, 'electron.mjs') }))
        api.onResolve({ filter: /^electron-log$/ }, () => ({ path: join(workDir, 'log.mjs') }))
        return null
      }
    }
  ]
})

process.env.DY_PGLITE_URL = pathToFileURL(pglitePath).href

/* ------------------------------------------------------------------ 假模型 */

/** 模型这次要回的话（工装自己写：结构化的那份 JSON） */
const REPORT = {
  persona: '夜聊型陪伴者',
  headline: '深夜来、话不多但一直在的熟客',
  overview: '他几乎只在晚上出现，弹幕短、爱用表情，送的都是小礼物但很稳定。',
  tags: ['夜猫子', '稳定', '爱夸唱'],
  sections: [
    { title: '说话风格', items: ['句子短，爱用 [比心] 这类表情'] },
    { title: '消费与动机', items: ['单笔小、频次稳，更像表达喜欢而不是求关注'] }
  ],
  evidence: [{ quote: '今晚唱得太好听了', note: '他习惯用夸唱开场' }],
  suggestions: ['固定时段点他一句'],
  caveats: ['样本只有十几条弹幕']
}
const RAW = '```json\n' + JSON.stringify(REPORT, null, 1) + '\n```'

/** 工装自己的假模型工厂：可编排「回什么 / 抛错 / 挂住」 */
const modelPlan = {
  /** `ok` 正常回话；`throw` 抛错；`hang` 挂住（手动放行） */
  mode: 'ok',
  raw: RAW,
  /** 已收到的调用（每次一份 messages） */
  calls: [],
  usage: { input_tokens: 1234, output_tokens: 567 },
  /** 拆成几段吐（验流式） */
  chunks: 4,
  release: null
}
globalThis.__DY_FAKE_MODEL__ = () => ({
  async stream(messages, options) {
    modelPlan.calls.push(messages)
    if (modelPlan.mode === 'throw') throw new Error('工装：模型今天不干了（HTTP 500）')
    /*
     * `hang` = 一个字都不吐（模拟本地模型长时间思考 / 卡住）。
     *
     * **必须跟着 signal 走**：真 LangChain 收到 abort 会抛出来结束这个流，
     * 假模型要是不理 signal，插件的看门狗就算把 controller.abort() 了，这个 await 也永远不返回
     * ——工装会直接挂住（第一版就是这样：测静默超时时整个脚本卡死）。
     */
    if (modelPlan.mode === 'hang') {
      await new Promise((resolve, reject) => {
        modelPlan.release = resolve
        const signal = options?.signal
        if (!signal) return
        if (signal.aborted) {
          reject(new Error('This operation was aborted'))
          return
        }
        signal.addEventListener('abort', () => reject(new Error('This operation was aborted')), { once: true })
      })
    }
    const text = modelPlan.raw
    const size = Math.ceil(text.length / modelPlan.chunks)
    const parts = []
    for (let index = 0; index < text.length; index += size) parts.push(text.slice(index, index + size))
    const self = this
    return (async function* generate() {
      for (let index = 0; index < parts.length; index += 1) {
        const last = index === parts.length - 1
        yield last
          ? { content: parts[index], usage_metadata: modelPlan.usage }
          : { content: parts[index] }
      }
      void self
    })()
  }
})

/** 事件收集器（主进程 safeSend → 这里） */
const sent = []
globalThis.__DOUYIN_SEND__ = (channel, payload) => sent.push({ channel, payload })

/** 供应商场景（工装直接改这个环境变量，stub 每次现读） */
const setProviders = (state) => {
  process.env.DY_PROVIDER_STATE = JSON.stringify(state)
}

/* ------------------------------------------------------------ A 段：自造数据 */

const freshDir = join(workDir, 'db')
mkdirSync(freshDir, { recursive: true })
process.env.DY_PGLITE_DIR = freshDir
setProviders({ enabled: [3], default: 3 })
process.env.DY_LANG = 'zh-CN'

const bundle = await import(pathToFileURL(outfile).href)
const { portrait, mapper, rawQuery, closeOrm } = bundle
const rowsOf = async (sql) => (await rawQuery(sql)).rows

const NOW = Date.now()
const DAY = 86400000
const ROOM = '880000000001'
const USER = '2056511'
const ANON_USER = 'anon:111111#dou2056511'

/** 值转 SQL 字面量：一律用 dollar-quoted 字符串，免去引号转义（工装数据里有中文与 emoji） */
const q = (value) => `$dy$${String(value).replace(/\$dy\$/g, '')}$dy$`

async function seedUser(userId, { messages, name = '夜猫子小张' }) {
  await rawQuery(
    `insert into douyin_link_rooms (web_rid, title, anchor, status) values (${q(ROOM)}, ${q('深夜电台')}, ${q('工装主播')}, 'live') ` +
      `on conflict (web_rid) do nothing`
  )
  for (const message of messages) {
    await rawQuery(
      `insert into douyin_link_messages (web_rid, session_id, kind, user_id, user_name, content, count, diamonds, to_user_id, to_user_name, order_key, at_ms) values (` +
        `${q(ROOM)}, 1, ${q(message.kind)}, ${q(userId)}, ${q(name)}, ${q(message.content ?? '')}, ${message.count ?? 0}, ${message.diamonds ?? 0}, ` +
        `${q(message.toUserId ?? '')}, ${q(message.toUserName ?? '')}, '', ${message.atMs})`
    )
  }
  await rawQuery(
    `insert into douyin_link_users (web_rid, user_id, display_id, nickname, gender, signature, city, avatar, following, follower, honor_level, fans_club_level, badges, sec_uid, chat, enter, likes, follows, gift, diamonds, first_seen, last_seen) values (` +
      `${q(ROOM)}, ${q(userId)}, ${q('zhang_2026')}, ${q(name)}, 1, ${q('只听歌不说话')}, ${q('杭州')}, '', 320, 45, 12, 8, '[]', '', ` +
      `${messages.filter((m) => m.kind === 'chat').length}, ${messages.filter((m) => m.kind === 'member').length}, ` +
      `${messages.filter((m) => m.kind === 'like').length}, ${messages.filter((m) => m.kind === 'social').length}, ` +
      `${messages.filter((m) => m.kind === 'gift').length}, ` +
      `${messages.filter((m) => m.kind === 'gift').reduce((acc, m) => acc + (m.diamonds ?? 0), 0)}, ` +
      `${NOW - 26 * DAY}, ${NOW - 2 * 3600000})`
  )
}

/** 一个互动够多的人（6 弹幕 + 进场/点赞/关注各 1 + 2 次送礼） */
const SEED_MESSAGES = [
  { kind: 'chat', content: '今晚唱得太好听了', atMs: NOW - 2 * 3600000 },
  { kind: 'chat', content: '点一首《太聪明》可以吗？', atMs: NOW - 3 * 3600000 },
  { kind: 'chat', content: '哈哈哈哈哈笑死我了', atMs: NOW - 4 * 3600000 },
  { kind: 'chat', content: '[比心] 主播记得喝水', atMs: NOW - 5 * 3600000 },
  { kind: 'chat', content: '谁在麦上啊', atMs: NOW - 6 * 3600000 },
  { kind: 'chat', content: '我下班了刚到家', atMs: NOW - 7 * 3600000 },
  { kind: 'member', atMs: NOW - 8 * 3600000 },
  { kind: 'like', atMs: NOW - 9 * 3600000 },
  { kind: 'social', atMs: NOW - 10 * 3600000 },
  { kind: 'gift', content: '比心', count: 5, diamonds: 500, toUserId: '9001', toUserName: '工装主播', atMs: NOW - 11 * 3600000 },
  { kind: 'gift', content: '小心心', count: 2, diamonds: 200, toUserId: '9001', toUserName: '工装主播', atMs: NOW - 12 * 3600000 }
]
await seedUser(USER, { messages: SEED_MESSAGES })
// 匿名的人：内部键是 `anon:111111#dou2056511`（材料里必须脱壳成 dou2056511）
await seedUser(ANON_USER, { messages: SEED_MESSAGES.slice(0, 6), name: '神秘人七阶' })
// 互动不够的人（只有 1 条弹幕）：用来验 no-data 不花钱
await seedUser('2056999', { messages: [{ kind: 'chat', content: '第一次来', atMs: NOW - 3600000 }] })

console.log('=== 1. 建表与模型清单')
const tableRows = await rowsOf(`select to_regclass('douyin_link_user_portraits') as name`)
check('新表 douyin_link_user_portraits 已建', tableRows[0]?.name === 'douyin_link_user_portraits', JSON.stringify(tableRows))
const models = await portrait.listPortraitModels()
eq('模型清单只有 id/名字/模型名/是否默认', Object.keys(models[0] ?? {}).sort(), ['id', 'isDefault', 'model', 'name'])
check('清单里不含 api_key（也不含密钥原文）', !JSON.stringify(models).includes(SECRET), JSON.stringify(models))
eq('清单内容对', [models[0].id, models[0].model, models[0].isDefault], [3, 'workbench-model', true])

console.log('\n=== 2. 打开弹窗的初始状态（不花钱）')
const stateBefore = await portrait.aiPortraitState({ userId: USER, settings: { portraitProviderId: 3 } })
eq('还没有画像', stateBefore.portrait, null)
check('当前数据侧的互动量 > 0', stateBefore.current.interactions > 0, JSON.stringify(stateBefore.current))
eq('回话里带上选中的模型 id', stateBefore.selectedProviderId, 3)
eq('此时没有在生成', stateBefore.running, false)
eq('一个模型都没调用过', modelPlan.calls.length, 0)

console.log('\n=== 3. 第一次生成：真材料 + 落库')
modelPlan.mode = 'ok'
sent.length = 0
globalThis.__DY_BUILT_PROVIDERS__ = []
const started = Date.now()
const first = await portrait.generateAiPortrait({
  userId: USER,
  webRid: ROOM,
  profile: { nickname: '夜猫子小张', displayId: 'zhang_2026', city: '杭州', honorLevel: 12, fansClubLevel: 8 },
  settings: { portraitProviderId: 3 },
  force: false
})
check('生成成功', first.ok === true, JSON.stringify(first))
eq('版本是第 1 版', first.portrait?.version, 1)
eq('报告解析成结构化内容', first.portrait?.report?.persona, '夜聊型陪伴者')
eq('记下了用哪个供应商 / 模型', [first.portrait?.providerId, first.portrait?.model, first.portrait?.providerName], [3, 'workbench-model', 'workbench-3'])
eq('记下了 token 用量', [first.portrait?.inputTokens, first.portrait?.outputTokens], [1234, 567])
eq('用量与打开的现状一致（同一份指纹口径）', first.portrait?.interactions, stateBefore.current.interactions)
eq('指纹与现状一致', first.portrait?.fingerprint, stateBefore.current.fingerprint)
check(`生成耗时 ${Date.now() - started}ms（假模型，只是记一下）`, true)

const promptText = (modelPlan.calls[0] ?? []).map((message) => message.content).join('\n---\n')
/**
 * `DY_DUMP_PROMPT=<文件>`：把**这一份真材料**写到文件里。
 *
 * 用途：拿它去量本地模型的真实速度（`spike/ai-portrait-local-probe.mjs`）——
 * 「本地小模型会不会超时」这种问题必须先量出「这份提示词它要跑多久」，不能靠推理。
 */
if (process.env.DY_DUMP_PROMPT) {
  writeFileSync(process.env.DY_DUMP_PROMPT, promptText, 'utf8')
  console.log(`  （材料已写到 ${process.env.DY_DUMP_PROMPT}：${promptText.length} 字符）`)
}
check('模型只被调用了一次', modelPlan.calls.length === 1, `实际 ${modelPlan.calls.length}`)
eq('模型是从设置指定的供应商建的', globalThis.__DY_BUILT_PROVIDERS__, [3])
has('材料里带上这个人的真弹幕原话', promptText, '今晚唱得太好听了')
has('材料里带上他点歌那句（含书名号）', promptText, '点一首《太聪明》可以吗？')
has('材料里带上他送的礼物与收礼人', promptText, '比心 ×5（500 抖币） → 工装主播')
has('材料里带上算法层事实', promptText, '行为原型')
has('材料里带上房间名', promptText, '深夜电台（880000000001）')
has('材料里带上档案静态字段', promptText, '地区 杭州')
check('第一次生成没有「上一版」这一段', !promptText.includes('上一版画像'), '')

const storedRow = await mapper.getUserPortrait(`user:${USER}`)
check('真的写进了 douyin_link_user_portraits', storedRow !== null)
eq('库里标了结构化', storedRow?.structured, true)
eq('库里存的是可解析的报告 JSON', JSON.parse(storedRow?.report ?? '{}').persona, '夜聊型陪伴者')
has('库里的原文也留着（排查用）', storedRow?.raw, '```json')

console.log('\n=== 4. 已有缓存 → 不再调模型（省 token）')
const second = await portrait.generateAiPortrait({ userId: USER, webRid: ROOM, profile: null, settings: {}, force: false })
check('第二次成功', second.ok === true)
eq('回的还是第 1 版', second.portrait?.version, 1)
eq('模型调用次数没变（仍然是 1）', modelPlan.calls.length, 1)

console.log('\n=== 5. 「重新生成」：版本 +1，并把上一版喂回去做迭代')
modelPlan.raw = RAW.replace('夜聊型陪伴者', '夜聊型陪伴者（第二版）')
// 事件收集器清空：第 6 段要断言「这一次生成的增量」（不清的话会把第一次生成的也拼进来）
sent.length = 0
const third = await portrait.generateAiPortrait({ userId: USER, webRid: ROOM, profile: null, settings: {}, force: true })
eq('版本变成 2', third.portrait?.version, 2)
eq('新内容覆盖旧内容', third.portrait?.report?.persona, '夜聊型陪伴者（第二版）')
eq('模型调用次数 = 2', modelPlan.calls.length, 2)
const secondPrompt = (modelPlan.calls[1] ?? []).map((message) => message.content).join('\n---\n')
has('第二次材料里有「上一版画像」这一段', secondPrompt, '上一版画像（第 1 版）')
has('上一版的内容真的带上了', secondPrompt, '他习惯用夸唱开场')
has('写明这是迭代而不是从零开始', secondPrompt, '这是一次迭代（不是从零开始）')
eq('库里版本也更新成 2', (await mapper.getUserPortrait(`user:${USER}`))?.version, 2)

console.log('\n=== 6. 流式增量真的推给了界面')
const chunks = sent.filter((entry) => entry.channel === 'plugin:douyin-link:portrait')
check('收到多条增量', chunks.length >= 3, `实际 ${chunks.length}`)
eq('同一次生成的增量共用一个 requestId', [...new Set(chunks.map((entry) => entry.payload?.requestId))].length, 1)
eq('最后一条是 done', chunks[chunks.length - 1]?.payload?.done, true)
eq('中间那些都不是 done（界面据此边收边渲染）', chunks.slice(0, -1).every((entry) => entry.payload?.done === false), true)
const assembled = chunks.map((entry) => entry.payload?.delta ?? '').join('')
eq('分片拼起来 == 模型原文', assembled.length, modelPlan.raw.length)
has('拼起来的内容里有报告正文', assembled, '夜聊型陪伴者（第二版）')

console.log('\n=== 7. 正在生成时再来一次 → busy（不重复花钱）')
modelPlan.mode = 'hang'
modelPlan.calls.length = 0
const hanging = portrait.generateAiPortrait({ userId: USER, webRid: ROOM, profile: null, settings: {}, force: true })
await new Promise((resolve) => setTimeout(resolve, 80))
const busy = await portrait.generateAiPortrait({ userId: USER, webRid: ROOM, profile: null, settings: {}, force: true })
eq('第二次被拒，原因是 busy', [busy.ok, busy.reason], [false, 'busy'])
eq('被拒那次没有调模型', modelPlan.calls.length, 1)
modelPlan.mode = 'ok'
modelPlan.release?.()
const released = await hanging
check('放行之后第一次正常完成', released.ok === true, JSON.stringify(released))
eq('版本继续递增到 3', released.portrait?.version, 3)
check(
  '生成结束后 running 归位',
  (await portrait.aiPortraitState({ userId: USER, settings: {} })).running === false
)

/*
 * 7b. 时间预算（2026-10-13 用户报「小模型会报错，本地的 ollama 模型」之后的定版）。
 *
 * 原来是一根 **180 秒墙钟硬超时**：本机实测本地 9B/Q4 是 21.6 token/s、那条 Ollama 的输出上限
 * 4000 token ⇒ 4000 / 21.6 ≈ 185 秒，**刚好越过 180**：模型还在正常出字，先被我掐了，用户看到
 * 「模型调用失败：This operation was aborted」。所以现在改「静默超时 + 宽松总上限」，并且可停止。
 * 这里既有**默认值守卫**（别再被人悄悄收紧回去），也有两条真路径：
 *   ① 静默超时（把预算调小 + 让假模型一个字都不吐）→ 失败文案必须说清「多少秒没有输出」；
 *   ② 用户点停止 → `cancelled`，且**已有画像不被毁**。
 */
console.log('\n=== 7b. 静默超时与「停止」（本地模型要慢得起）')
eq('默认预算：静默 5 分钟', portrait.PORTRAIT_BUDGETS.stallMs, 5 * 60_000)
eq('默认预算：总上限 30 分钟（配合「停止」按钮，不再是一根 180 秒的墙钟）', portrait.PORTRAIT_BUDGETS.totalMs, 30 * 60_000)

const budgetBackup = { ...portrait.PORTRAIT_BUDGETS }
// 1.1 秒：够快，而且消息里会说「1 秒没有任何输出」（文案按秒取整）
portrait.PORTRAIT_BUDGETS.stallMs = 1100
portrait.PORTRAIT_BUDGETS.totalMs = 60_000
const beforeStall = await mapper.getUserPortrait(`user:${USER}`)
modelPlan.mode = 'hang'
modelPlan.calls.length = 0
const stalled = await portrait.generateAiPortrait({ userId: USER, webRid: ROOM, profile: null, settings: {}, force: true })
eq('静默不动 → 失败（model-failed）', [stalled.ok, stalled.reason], [false, 'model-failed'])
has('失败文案说清「多少秒没有任何输出」', stalled.detail, '1 秒没有任何输出')
has('失败文案给出「已写多少字」', stalled.detail, '已写 0 字符')
has('失败文案给出本地模型的成因提示', stalled.detail, '本地模型')
eq('静默超时后 running 归位（不会卡住）', (await portrait.aiPortraitState({ userId: USER, settings: {} })).running, false)
eq('静默超时**没有**毁掉已有画像', (await mapper.getUserPortrait(`user:${USER}`))?.version, beforeStall?.version)

// ② 用户点「停止」：假模型挂着，调 cancel
modelPlan.calls.length = 0
const toCancel = portrait.generateAiPortrait({ userId: USER, webRid: ROOM, profile: null, settings: {}, force: true })
await new Promise((resolve) => setTimeout(resolve, 80))
eq('停止请求找到了在跑的那一次', await portrait.cancelAiPortrait(USER), true)
const cancelled = await toCancel
eq('停下来是 cancelled（不是错误）', [cancelled.ok, cancelled.reason], [false, 'cancelled'])
eq('停止之后 running 归位', (await portrait.aiPortraitState({ userId: USER, settings: {} })).running, false)
eq('停下来也没有毁掉已有画像', (await mapper.getUserPortrait(`user:${USER}`))?.version, beforeStall?.version)
eq('没有在跑的时候再点停止 → false', await portrait.cancelAiPortrait(USER), false)
modelPlan.mode = 'ok'
portrait.PORTRAIT_BUDGETS.stallMs = budgetBackup.stallMs
portrait.PORTRAIT_BUDGETS.totalMs = budgetBackup.totalMs

console.log('\n=== 8. no-data / no-model：都要在花钱之前挡住')
modelPlan.calls.length = 0
const noData = await portrait.generateAiPortrait({ userId: '2056999', webRid: ROOM, profile: null, settings: {}, force: true })
eq('互动太少 → no-data', [noData.ok, noData.reason], [false, 'no-data'])
eq('no-data 没有调模型', modelPlan.calls.length, 0)
setProviders({ enabled: [], default: null })
const noModel = await portrait.generateAiPortrait({ userId: USER, webRid: ROOM, profile: null, settings: {}, force: true })
eq('一个可用供应商都没有 → no-model', [noModel.ok, noModel.reason], [false, 'no-model'])
eq('no-model 也没有调模型', modelPlan.calls.length, 0)
eq('no-model 时清单是空的', (await portrait.listPortraitModels()).length, 0)

console.log('\n=== 9. 选模型链：指定的 > 默认 > 第一个启用')
setProviders({ enabled: [5, 6], default: 6 })
globalThis.__DY_BUILT_PROVIDERS__ = []
await portrait.generateAiPortrait({ userId: USER, webRid: ROOM, profile: null, settings: { portraitProviderId: 9 }, force: true })
eq('指定的 9 不在已启用里 → 回落到宿主默认 6', globalThis.__DY_BUILT_PROVIDERS__, [6])
setProviders({ enabled: [5, 6], default: null })
globalThis.__DY_BUILT_PROVIDERS__ = []
await portrait.generateAiPortrait({ userId: USER, webRid: ROOM, profile: null, settings: {}, force: true })
eq('没有默认供应商 → 用已启用的第一个 5', globalThis.__DY_BUILT_PROVIDERS__, [5])
setProviders({ enabled: [5, 6], default: 5 })
globalThis.__DY_BUILT_PROVIDERS__ = []
await portrait.generateAiPortrait({ userId: USER, webRid: ROOM, profile: null, settings: { portraitProviderId: 5 }, force: true })
eq('指定的 5 可用 → 就用 5', globalThis.__DY_BUILT_PROVIDERS__, [5])

console.log('\n=== 10. 模型报错：如实报错，且**已有的画像不被毁**')
const beforeFail = await mapper.getUserPortrait(`user:${USER}`)
modelPlan.mode = 'throw'
const failed = await portrait.generateAiPortrait({ userId: USER, webRid: ROOM, profile: null, settings: {}, force: true })
eq('失败原因是 model-failed', [failed.ok, failed.reason], [false, 'model-failed'])
has('失败明细里带上了模型的原话', failed.detail, 'HTTP 500')
const afterFail = await mapper.getUserPortrait(`user:${USER}`)
eq('已有画像原样保留（版本没动）', afterFail?.version, beforeFail?.version)
eq('已有画像内容也没变', afterFail?.raw, beforeFail?.raw)
const errorState = await portrait.aiPortraitState({ userId: USER, settings: {} })
check('失败之后不再是 running（不会卡住）', errorState.running === false)
eq('弹窗拿到的还是上一版好内容', errorState.portrait?.version, beforeFail?.version)
modelPlan.mode = 'ok'

console.log('\n=== 11. 匿名内部键：材料里脱壳成抖音 id，缓存键仍按内部键')
modelPlan.calls.length = 0
await portrait.generateAiPortrait({ userId: ANON_USER, webRid: ROOM, profile: null, settings: {}, force: true })
const anonPrompt = (modelPlan.calls[0] ?? []).map((message) => message.content).join('\n')
check('材料里没有 anon: 前缀', !anonPrompt.includes('anon:'), '')
has('材料里是脱壳后的抖音 id', anonPrompt, '用户 id dou2056511')
check('匿名的人也真的落库了', (await mapper.getUserPortrait(`user:${ANON_USER}`)) !== null)

console.log('\n=== 12. 清数据：AI 画像也在清掉的那一批里')
const cleared = await mapper.deleteUserPortrait(`user:${USER}`)
eq('删掉一行', cleared, 1)
eq('删完读不到', await mapper.getUserPortrait(`user:${USER}`), null)
await rawQuery('delete from douyin_link_user_portraits')
eq('表可以整表清空（purge 走的就是这个）', (await rowsOf('select count(*)::int as n from douyin_link_user_portraits'))[0].n, 0)

/* ------------------------------------------------- B 段：真库副本（可选） */

if (realDbDir && existsSync(join(realDbDir, 'PG_VERSION'))) {
  console.log('\n=== 13. 真库副本：真人的材料长什么样')
  // 先把自造库那一路关掉（PGlite 没有跨进程锁，同一时刻只该有一个客户端开着）
  await closeOrm()
  process.env.DY_PGLITE_DIR = realDbDir
  // 换一个模块实例 = 换一个 PGlite 客户端（指向真库副本；DDL 是 IF NOT EXISTS，写进去也不影响原库）
  const real = await import(`${pathToFileURL(outfile).href}?real=${Date.now()}`)
  const realPortrait = real.portrait
  const realOrm = { rawQuery: real.rawQuery }
  setProviders({ enabled: [3], default: 3 })
  modelPlan.calls.length = 0
  modelPlan.raw = RAW
  const top = (await realOrm.rawQuery(
    `select user_id, count(*)::int as n from douyin_link_messages where kind = 'chat' and user_id <> '' ` +
      `group by user_id order by n desc limit 1`
  )).rows[0]
  if (!top) {
    console.log('     真库里没有弹幕记录，跳过')
  } else {
    setProviders({ enabled: [3], default: 3 })
    modelPlan.calls.length = 0
    modelPlan.raw = RAW
    const result = await realPortrait.generateAiPortrait({
      userId: top.user_id,
      webRid: '',
      profile: null,
      settings: {},
      force: true
    })
    check(`真库里互动最多的那个人（${top.user_id}，${top.n} 条弹幕）能生成`, result.ok === true, JSON.stringify(result))
    const realPrompt = (modelPlan.calls[0] ?? []).map((message) => message.content).join('\n')
    // 真材料导出：量本地模型的真实耗时就用这一份（-real 后缀，与工装合成那份区分开）
    if (process.env.DY_DUMP_PROMPT) {
      const file = `${process.env.DY_DUMP_PROMPT.replace(/\.txt$/, '')}-real.txt`
      writeFileSync(file, realPrompt, 'utf8')
      console.log(`  （真材料已写到 ${file}：${realPrompt.length} 字符）`)
    }
    const sample = (await realOrm.rawQuery(
      `select content from douyin_link_messages where kind = 'chat' and user_id = $dy$${top.user_id}$dy$ and content <> '' order by at_ms desc limit 3`
    )).rows
    for (const row of sample) {
      const text = String(row.content).replace(/\s+/g, ' ').trim()
      if (text.length < 2) continue
      has(`真材料里有他自己的弹幕原话「${text.slice(0, 18)}…」（引用是可行的）`, realPrompt, text)
      break
    }
    console.log(`     真人材料字符：${realPrompt.length}（约 ${Math.round(realPrompt.length / 2)} token 量级）`)
    check('真材料规模在预算内（<= 30000 字符）', realPrompt.length <= 30000, `实际 ${realPrompt.length}`)
    has('真材料里有「互动结构」那一节', realPrompt, '互动结构')
  }
} else if (realDbDir) {
  console.error(`真库目录不像 PGlite 数据目录：${realDbDir}`)
  failures += 1
} else {
  console.log('\n（B 段跳过：想要真人的材料就跑 `node plugins/douyin-link/spike/ai-portrait-model-check.mjs <PGlite 数据目录副本>`）')
}

rmSync(workDir, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项未通过`}`)
process.exit(failures === 0 ? 0 : 1)
