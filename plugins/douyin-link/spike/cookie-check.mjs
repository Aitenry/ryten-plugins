/**
 * Cookie 口径自检（dev-only，不参与打包）：把**真实的** `shared/cookie.ts` 与
 * `main/douyin/cookie.ts` 拿进来跑，断言「用户粘贴的那一行原样留着、并且排在合并结果的最前面」。
 *
 * 为什么要有它（2026-10-10 的事故）：设置里那份登录态 Cookie 被**静默切到 4096 字符**，
 * 而真实的一份是 6 KB 上下（用户实测 6071 字符 / 70 个字段）——被砍掉的正好是**尾部**的
 * `ttwid` / `odin_tt` / `x_tt_token` / `bd_ticket_guard_client_data`。
 * 于是界面上看着「cookie 已经填好」，实际发出去的却是「sessionid 还在、绑定的 ttwid 没了」
 * 的那一行，抖音当无效会话 → 一条内容都拉不到。这个自检盯的就是这条线：
 * **输入框里粘贴了多少、发出去就得是多少**（真撞上限也要能看见）。
 *
 * 怎么跑（仓库根目录；需要 esbuild，它已经在 devDependencies 里）：
 *
 *   node plugins/douyin-link/spike/cookie-check.mjs
 *
 * 另一个用法：**拿真 cookie 量一遍**（不入库、不进 git，只打印数字）：
 *
 *   node plugins/douyin-link/spike/cookie-check.mjs --cookie-file="$env:TEMP\my-cookie.txt"
 *   node plugins/douyin-link/spike/cookie-check.mjs --cookie-file=... --live   # 顺带抓一份真匿名 cookie
 *
 * `--live` 会 GET https://live.douyin.com/ 取一份**匿名** cookie（公开页面、不带任何账号），
 * 用来核对「合并后的长度」与「用户字段仍在最前」这两件事。
 */

import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const workDir = mkdtempSync(join(tmpdir(), 'douyin-cookie-check-'))

/** 旧口径：这个插件 0.15.7 及以前两处都写死的上限（自检拿它当「事故基准」） */
const LEGACY_LIMIT = 4096

/* ------------------------------------------------------------------ 打包装载 */

async function bundle(entry, sub) {
  const outfile = join(workDir, `${sub.replace(/[^\w]/g, '_')}_${entry.replace(/[^\w]/g, '_')}.mjs`)
  await build({
    entryPoints: [join(ROOT, 'plugins/douyin-link', sub, entry)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href)
}

const shared = await bundle('cookie.ts', 'shared')
const mainCookie = await bundle('cookie.ts', 'main/douyin')

/* -------------------------------------------------------------------- 断言 */

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`
  )
}

/** 一行 cookie 里的键名（保持顺序，不去重——要看得出「谁被砍了」） */
const keysOf = (text) =>
  String(text ?? '')
    .split(';')
    .map((part) => {
      const item = part.trim()
      const equal = item.indexOf('=')
      return equal >= 1 ? item.slice(0, equal).trim() : ''
    })
    .filter(Boolean)

const valueOf = (text, name) => {
  const hit = String(text ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : ''
}

/* ------------------------------------------------- 合成一份「真实形状」的 cookie */

/**
 * 按实测那份的形状合成（**不含任何真实凭据**）：页面自己设的一堆小字段在前，
 * 登录态与风控字段（`sessionid` / `ttwid` / `odin_tt` / `x_tt_token` …）压在尾部——
 * 这正是 4096 截断会砍掉的位置，也是这个自检要守住的位置。
 */
function syntheticCookie({ withSession = true } = {}) {
  const junk = [
    'enter_pc_once=1',
    `UIFID_TEMP=${'a'.repeat(64)}`,
    'hevc_supported=true',
    'is_dash_user=1',
    'passport_csrf_token=085bab64b273af2dc9c458f07e29f969',
    'has_biz_token=false',
    `UIFID=${'b'.repeat(900)}`,
    'publish_badge_show_info=%220%2C0%2C0%2C1791264100740%22',
    'my_rd=2',
    'live_use_vvc=%22false%22',
    `fpk1=${'U2FsdGVkX1+' + 'c'.repeat(60)}`,
    'fpk2=e37c4ca5c20c5c9bf6e28230c57fcf75',
    's_v_web_id=verify_muw8ffq6_UZk0EYm0_cZ7U_4IIX_BJ4P_mQBxNdLDeQt1',
    'download_guide=%223%2F20261007%2F1%22',
    `LivePausePop=%22${'d'.repeat(260)}%22`,
    'SEARCH_RESULT_LIST_TYPE=%22single%22',
    `stream_player_status_params=%22${'e'.repeat(400)}%22`,
    'SelfTabRedDotControl=%5B%5D',
    'strategyABtestKey=%221791562700.257%22',
    'has_avx2=null',
    'device_web_cpu_core=20',
    'device_web_memory_size=32',
    `sdk_source_info=${'f'.repeat(520)}`,
    `bit_env=${'0'.repeat(1400)}`,
    'gulu_source_res=eyJwX2luIjoiNzQ3Y2NkNjA3NTljYTg2MTdkZTkzMzU0MTYwNGVkYTc0ZmFkNDE1MGFiNTI2ZTBkYmZkMDA4ZDUxZWE5NzUzZCJ9',
    'csrf_session_id=77bdf524b1d9f7b092ac7dceed745d17',
    'd_ticket=825b900c6e85fad0861bafa5503c5467a3bef',
    'n_mh=MAfTTmFMvAyaqUQsKYSdb4wijZ0roz277Ae0l8UCdwM',
    'is_staff_user=false'
  ]
  const tail = withSession
    ? [
        'passport_auth_status=dcab15fcdd4db950378a53aaeb8fe2a3%2Cf12ac078e723502d8d7a4478758954aa',
        `uid_tt=${'1'.repeat(64)}`,
        'sid_tt=1a8d5ecf86914841ab2c20ae2f4a0f49',
        'sessionid=1a8d5ecf86914841ab2c20ae2f4a0f49',
        'sessionid_ss=1a8d5ecf86914841ab2c20ae2f4a0f49',
        'login_time=1791628916974',
        'is_dbsc=true',
        `ttwid=1%7CbDhzRjFnQzmIGSOhiWLnodUqg7ul0x9iwFJLzDkH1p0%7C1791628920%7C${'2'.repeat(64)}`,
        'bd_ticket_guard_generate_ticket_time=2026-10-10/18:42:01',
        'live_can_add_dy_2_desktop=%220%22',
        `x_tt_token=00${'3'.repeat(400)}-3.0.4`,
        'bd_ticket_guard_client_data=eyJiZC10aWNrZXQtZ3VhcmQtdmVyc2lvbiI6MiwiYmQtdGlja2V0LWd1YXJkLXdlYi12ZXJzaW9uIjoyfQ%3D%3D',
        'odin_tt=374289042448162f0e602063fbca494de21b1deb8e450668a97ba2929e20e0c7e9729c2c75a3ec524b263828671971b3620788c18d14d513de3ee59ff2c0ecd7'
      ]
    : // 匿名那份：**故意带几个登录 cookie 里没有的名字**（真实页面 cookie 就是这样的），
      // 用来验证「合并只补用户没有的字段」，而不是把匿名那份整块塞进去
      [
        'passport_auth_mix_state=x0s5tx0c8ljm0s4uooi23gkajimvvnr8pbp830coq4jma5de',
        'biz_trace_id=2260e931',
        'IsDouyinActive=false'
      ]
  return [...junk, ...tail].join('; ')
}

/**
 * 页面匿名 cookie：**与用户那份同源、但顺序不同**（真实情况就是如此，B 那份就是这么来的）
 * ——把中间一段字段挪到最前，于是「匿名优先」的合并会把用户独有的字段（登录态那一块）
 * 全部挤到末尾。另外带三个页面独有的名字，用来验证「合并只补用户没有的字段」。
 */
function syntheticPageCookie() {
  const parts = syntheticCookie({ withSession: false }).split('; ')
  const pageOnly = 3
  const junk = parts.slice(0, parts.length - pageOnly)
  const tail = parts.slice(parts.length - pageOnly)
  const rotated = [...junk.slice(10), ...junk.slice(0, 10), ...tail]
  return rotated.join('; ')
}

/** 事故时的合并顺序（**匿名在前**、用户独有字段被挤到末尾）；探针里只用来复现，生产代码已不用 */
function mergeWithAnonymousFirst(configured, anonymous) {
  const anonPairs = shared.parseCookiePairs(anonymous)
  const known = new Set(anonPairs.map(([name]) => name))
  const extra = shared.parseCookiePairs(configured).filter(([name]) => !known.has(name))
  return [...anonPairs, ...extra].map(([name, value]) => `${name}=${value}`).join('; ')
}

console.log(`上限 COOKIE_MAX_LENGTH = ${shared.COOKIE_MAX_LENGTH}（旧口径 ${LEGACY_LIMIT}）\n`)

/* ---------------------------------------------- 1. 输入侧：粘贴多少就得留多少 */

const long = syntheticCookie()
const clamped = shared.clampCookie(long)
check('合成 cookie 长度 > 5000（照实测那份 6071 的形状）', long.length > 5000, true)
check('合成 cookie 里登录态字段整体落在 4096 之后（与实测事故同一形状）', long.indexOf('sessionid=') > LEGACY_LIMIT, true)
check('clampCookie：没有超限就不许截断', clamped.truncated, false)
check('clampCookie：一个字符都不许少', clamped.value.length, long.length)
check('clampCookie：字符串逐字相同', clamped.value === long, true)

// 旧口径的账（事故基准）：被 4096 砍掉的是哪些键
const legacy = long.slice(0, LEGACY_LIMIT)
const droppedByLegacy = keysOf(long).filter((name) => !keysOf(legacy).includes(name))
console.log(
  `     旧口径对照：${long.length} 字符 → 4096，丢掉 ${droppedByLegacy.length} 个键` +
    `（含 ttwid=${droppedByLegacy.includes('ttwid')}、odin_tt=${droppedByLegacy.includes('odin_tt')}、` +
    `sessionid=${droppedByLegacy.includes('sessionid')}）`
)
check('旧口径确实会砍掉 ttwid（事故复现）', droppedByLegacy.includes('ttwid'), true)
check('旧口径确实会砍掉 odin_tt（事故复现）', droppedByLegacy.includes('odin_tt'), true)

// 真撞上限时：要能被上层看见（truncated + 原始长度）
const absurd = 'a='.padEnd(shared.COOKIE_MAX_LENGTH + 5000, 'x')
const clampedAbsurd = shared.clampCookie(absurd)
check('超限时 truncated = true（不许静默）', clampedAbsurd.truncated, true)
check('超限时 length 报的是截断前的长度', clampedAbsurd.length, absurd.length)
check('超限时留下的正好是上限', clampedAbsurd.value.length, shared.COOKIE_MAX_LENGTH)

// 宽容解析：整行粘贴、BOM、空白、脏片段
check(
  'stripCookiePrefix：去掉整行 Cookie: 前缀与首尾空白',
  shared.stripCookiePrefix('\uFEFF  Cookie: a=1; b=2  '),
  'a=1; b=2'
)
check(
  'parseCookiePairs：跳过认不出的片段、丢掉带控制字符的值',
  shared.parseCookiePairs('  a=1 ;; =x; b=2; c=3\n4; d=5  '),
  [
    ['a', '1'],
    ['b', '2'],
    ['d', '5']
  ]
)
check('parseCookiePairs：同名后者覆盖前者，且保持首次出现的位置', shared.parseCookiePairs('a=1; b=2; a=3'), [
  ['a', '3'],
  ['b', '2']
])

/* ------------------------------------------------------- 2. 体检（设置页那行提示） */

const healthFull = shared.cookieHealth(long)
check('cookieHealth：登录态 cookie 认得出 sessionid', healthFull.hasSession, true)
check('cookieHealth：登录态 cookie 认得出 ttwid', healthFull.hasTtwid, true)
check('cookieHealth：登录态 cookie 不缺东西', healthFull.missing, [])
check('cookieHealth：字段数是去重后的数量', healthFull.fields, new Set(keysOf(long)).size)

const anon = 'ttwid=abc; csrf_session_id=xyz'
check('cookieHealth：匿名 cookie 只有 ttwid 时缺 sessionid', shared.cookieHealth(anon).missing, ['sessionid'])
check('cookieHealth：空 cookie 两个都缺', shared.cookieHealth('').missing, ['sessionid', 'ttwid'])

/* ----------------------------------------------------------- 3. 合并：谁在前、谁被砍 */

const anonymous = syntheticPageCookie()
const merged = mainCookie.mergeCookieHeaders(long, anonymous)
const userKeys = keysOf(long)
const anonOnly = keysOf(anonymous).filter((name) => !new Set(userKeys).has(name))

check('merge：用户那份的每个字段都在', userKeys.every((name) => keysOf(merged).includes(name)), true)
check('merge：匿名那份独有的字段也补上了', anonOnly.every((name) => keysOf(merged).includes(name)), true)
check(
  'merge：用户那份整块排在匿名那份前面（要砍先砍匿名）',
  keysOf(merged).slice(0, userKeys.length),
  userKeys
)
check('merge：用户那份就是合并结果的前缀', merged.startsWith(long), true)
check(
  'merge：第一个匿名独有的字段排在用户那份之后',
  Math.min(...anonOnly.map((name) => merged.indexOf(`${name}=`))) > merged.lastIndexOf(`${userKeys[userKeys.length - 1]}=`),
  true
)
check(
  'merge：同名以用户那份为准',
  [valueOf(merged, 'csrf_session_id'), valueOf(merged, 'sdk_source_info')],
  [valueOf(long, 'csrf_session_id'), valueOf(long, 'sdk_source_info')]
)
check(
  'merge：长度 = 用户那份 + 匿名独有的字段',
  merged,
  `${long}; ${anonOnly.map((name) => `${name}=${valueOf(anonymous, name)}`).join('; ')}`
)

// 事故形状复现（这是这次事故最要紧的一条）：**匿名优先**的合并会把用户独有的字段
// （登录态那一块）整块挤到末尾，于是任何「砍尾巴」的长度上限都会先砍掉登录态，
// 页面自己那堆小字段反而全留着——实测那份被截到 4096 的 cookie 正是这个形状。
const accidentMerged = mergeWithAnonymousFirst(long, anonymous)
const accidentCut = keysOf(accidentMerged.slice(0, LEGACY_LIMIT))
const loginNames = ['sessionid', 'ttwid', 'odin_tt', 'x_tt_token', 'sid_guard']
const pageKept = keysOf(anonymous).filter((name) => accidentCut.includes(name)).length
console.log(
  `     事故形状：匿名优先合并 ${accidentMerged.length} 字符 → 4096，` +
    `登录态字段留下 ${loginNames.filter((name) => accidentCut.includes(name)).length}/${loginNames.length}，` +
    `页面字段留下 ${pageKept}/${keysOf(anonymous).length}`
)
check(
  '事故形状：匿名优先 + 4096 会整块丢掉登录态字段',
  loginNames.some((name) => !accidentCut.includes(name)),
  true
)
check(
  '修正后：砍点只由用户那份自己决定（匿名那份顶不掉它的任何字段）',
  keysOf(merged.slice(0, LEGACY_LIMIT)),
  keysOf(long.slice(0, LEGACY_LIMIT))
)
check('merge：两边都空就是空串', mainCookie.mergeCookieHeaders('', ''), '')
check(
  'merge：只有匿名那份时字段一个不少（默认匿名通道不受影响）',
  (() => {
    const out = mainCookie.mergeCookieHeaders('', anonymous)
    const wanted = new Set(keysOf(anonymous))
    return [keysOf(out).length, [...wanted].every((name) => keysOf(out).includes(name))]
  })(),
  [new Set(keysOf(anonymous)).size, true]
)

/* --------------------------------------------------- 4.（可选）真 cookie / 真匿名 cookie */

const args = process.argv.slice(2)
const cookieFileArg = args.find((arg) => arg.startsWith('--cookie-file='))
/** 这一轮要用哪一份当「用户那份」：给了真 cookie 就用真的，否则用合成的 */
let userCookie = long
if (cookieFileArg) {
  const path = cookieFileArg.slice('--cookie-file='.length).replace(/^"|"$/g, '')
  const real = readFileSync(path, 'utf8').trim()
  userCookie = real
  const got = shared.clampCookie(real)
  const health = shared.cookieHealth(real)
  const lost = keysOf(real).filter((name) => !keysOf(real.slice(0, LEGACY_LIMIT)).includes(name))
  console.log(`\n真 cookie（${path}）：`)
  console.log(`     字符数 ${got.length}｜字段数 ${health.fields}｜sessionid=${health.hasSession}｜ttwid=${health.hasTtwid}`)
  console.log(`     旧口径 4096 会丢 ${lost.length} 个键：${lost.join(', ') || '（无）'}`)
  console.log(`     新口径 truncated=${got.truncated}，发出去仍是 ${got.value.length} 字符`)
  check('真 cookie：存在会话字段（这份粘贴的是登录态 cookie）', health.hasSession, true)
  check('真 cookie：新口径不截断', got.truncated, false)
}

if (args.includes('--live')) {
  console.log('\n抓一份真匿名 cookie（GET https://live.douyin.com/）…')
  const response = await fetch('https://live.douyin.com/', {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    },
    signal: AbortSignal.timeout(20000)
  })
  const headers = response.headers
  const list =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (headers.get('set-cookie') ?? '').split(/,(?=[^;,=]+=)/)
  const pageCookie = list
    .map((entry) => entry.split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
  void response.text().catch(() => undefined)
  const liveMerged = mainCookie.mergeCookieHeaders(userCookie, pageCookie)
  const liveKeys = keysOf(userCookie)
  console.log(`     页面匿名 cookie：${pageCookie.length} 字符 / ${keysOf(pageCookie).length} 个键（${keysOf(pageCookie).join(', ')}）`)
  console.log(`     用户那份 + 匿名 → ${liveMerged.length} 字符`)
  check('真匿名 cookie 非空', pageCookie.length > 0, true)
  check('合并后仍把用户那份排在最前', keysOf(liveMerged).slice(0, liveKeys.length), liveKeys)
  check(
    '合并结果就是「用户那份 + 匿名独有的字段」（用户那份顶在前面，一个字都不动）',
    liveMerged.startsWith(shared.clampCookie(userCookie).value),
    true
  )
}

/* -------------------------------------------------------------------- 收摊 */

rmSync(workDir, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
