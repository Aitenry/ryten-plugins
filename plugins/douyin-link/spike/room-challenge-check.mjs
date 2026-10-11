/**
 * 回归工装：**风控验证页不能报成 `roomNotFound`**（用户 2026-10-11 22:11 报障）。
 *
 * 现场：6 个房间的监控全部「0 条 · 本场 0」，日志里每条房间都是
 * `监控 <webRid> 启动失败: roomNotFound`；而 21:32 之前一直正常。
 * 真机诊断（`spike/room-resolve-probe.mjs`）拿到根因：
 * 抖音返回的是 **HTTP 200 + `<title>验证码中间页</title>`**（6,285 字符，没有任何房间数据），
 * 于是 `pickRoomId()` 取不到 roomId → 一路掉到 `roomNotFound`——**看起来像房间号错了**，
 * 实际上「这个网络被挡在验证码后面了」，跟用户的房间号、跟插件版本都没关系。
 *
 * 这个工装钉两件事：
 * 1. `looksLikeChallengePage()` 认得出验证页、且**不误判正常页**（正常页里也有「验证」二字）；
 * 2. `resolveLiveRoom()` 在验证页下抛的是 **`resolving`**（带 captcha 明细），不再是 `roomNotFound`。
 *
 * 跑法：`node plugins/douyin-link/spike/room-challenge-check.mjs`
 * 带 `--live` 会真的打一次抖音（当前这个 IP 可能仍被挡，那时正好用真页当样本）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const ROOT = join(HERE, '../../../')
const PLUGIN = join(HERE, '..')
const live = process.argv.includes('--live')

const workDir = mkdtempSync(join(tmpdir(), 'room-challenge-'))
const outfile = join(workDir, 'room.mjs')
await build({
  stdin: {
    contents: `export * as room from '${PLUGIN.replace(/\\/g, '/')}/main/douyin/room.ts'`,
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
  external: ['electron', 'electron-log', 'node:*']
})
const { room } = await import(pathToFileURL(outfile).href)

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`
  )
}

console.log('=== 1. 认得出验证页，且不误判正常页 ===')
/** 真机那一版（探针抓到的形状）：标题是「验证码中间页」，正文里一条房间数据都没有 */
const challengeHtml = `<!doctype html><html><head><meta charset="utf-8"><title>验证码中间页</title>
<script>window.__captcha__={verify_type:'slide'}</script></head><body><div id="captcha_container"></div></body></html>`
check('验证码中间页 → 认得出', room.looksLikeChallengePage(challengeHtml), true)
check('安全验证页 → 认得出', room.looksLikeChallengePage('<html><head><title>安全验证</title></head>'), true)
/** 正常页：**正文里出现「验证」二字不该误判**（弹幕/简介里很常见） */
const normalHtml = `<html><head><title>少女的直播间 - 抖音直播</title></head><body>
{"roomId":"7695383415037725490","title":"10级以上进来喊少爷！"}
<div>主播正在验证这条弹幕，欢迎来到直播间</div></body></html>`
check('正常直播间页面 → 不误判', room.looksLikeChallengePage(normalHtml), false)
check('空正文 → 不误判（那是 pageFailed 的活）', room.looksLikeChallengePage(''), false)

console.log('\n=== 2. 验证页下 resolveLiveRoom 必须报 resolving（不是 roomNotFound）===')
/**
 * 直接换掉 `fetch`：让这个进程里所有请求都返回那张验证页。
 * 这样验的是**真 `resolveLiveRoom` 的判断链**，不是复制一份逻辑。
 */
const realFetch = globalThis.fetch
globalThis.fetch = async () => new Response(challengeHtml, { status: 200, headers: { 'content-type': 'text/html' } })
let thrown = null
try {
  await room.resolveLiveRoom('https://live.douyin.com/108011161837')
} catch (error) {
  thrown = { code: error?.code, detail: error?.detail }
}
globalThis.fetch = realFetch
console.log(`      抛出：${JSON.stringify(thrown)}`)
check('报的是 resolving', thrown?.code, 'resolving')
check('明细标了 captcha', thrown?.detail, 'captcha')

console.log('\n=== 3. 带上应用的 cookie 就不再被挡（真机口径的桩）===')
/**
 * 真机实测的分界（2026-10-11）：
 * - **不带 cookie** 抓 `https://live.douyin.com/<webRid>` → 验证码中间页（6KB、没有 roomId）；
 * - **带上应用里那份 cookie** → 正常页面（1MB、roomId 在、`enter` 也正常回数据）。
 *
 * 所以这里用一个「按 cookie 分岔」的桩把这条契约钉住：`resolveLiveRoom(target, cookie)`
 * 必须把 cookie 带进页面请求，否则这起事故会原样复发。
 */
const roomPageHtml = `<!doctype html><html><head><title>少女的直播间</title></head><body>
<script>window.__ROOM__={"roomId":"7695383415037725490","title":"试播","owner":{"nickname":"少女"}}</script>
</body></html>`
const enterJson = JSON.stringify({
  status_code: 0,
  data: {
    data: [
      {
        id_str: '7695383415037725490',
        title: '试播',
        status: 2,
        user_count_str: '31',
        owner: { id_str: '1', nickname: '少女' },
        admin_user_ids_str: ['111']
      }
    ]
  }
})

let sawCookieOnPage = false
globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  if (target.includes('/webcast/room/web/enter/')) {
    return new Response(enterJson, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const headers = options.headers ?? {}
  const cookie = typeof headers.cookie === 'string' ? headers.cookie : ''
  if (!cookie) {
    /** 没带 cookie：抖音给验证页（真机就是这么回的） */
    return new Response(challengeHtml, { status: 200, headers: { 'content-type': 'text/html' } })
  }
  sawCookieOnPage = true
  return new Response(roomPageHtml, {
    status: 200,
    headers: { 'content-type': 'text/html', 'set-cookie': 'ttwid=fake; Path=/' }
  })
}

let ok = null
let fail = null
try {
  const resolved = await room.resolveLiveRoom('https://live.douyin.com/108011161837', 'sessionid=fake; ttwid=fake')
  ok = { anchor: resolved.room.anchor, status: resolved.room.status, online: resolved.room.onlineText }
} catch (error) {
  ok = { code: error?.code, detail: error?.detail }
}
try {
  await room.resolveLiveRoom('https://live.douyin.com/108011161837')
  fail = '没有抛错'
} catch (error) {
  fail = { code: error?.code, detail: error?.detail }
}
globalThis.fetch = realFetch
console.log(`      带 cookie：${JSON.stringify(ok)}`)
console.log(`      不带 cookie：${JSON.stringify(fail)}`)
check('带 cookie 时页面请求确实带了 cookie', sawCookieOnPage, true)
check('带 cookie → 解析成功（主播/状态/人数都拿到）', ok, { anchor: '少女', status: 'live', online: '31' })
check('不带 cookie → 如实报 resolving/captcha（不再 roomNotFound）', fail, { code: 'resolving', detail: 'captcha' })

if (live) {
  console.log('\n=== 4. 真机再看一眼（当前 IP 也许仍被挡）===')
  let cookie = ''
  try {
    const file = join(process.env.APPDATA ?? '', 'ryten-bench', 'plugin-state', 'douyin-link.json')
    cookie = JSON.parse(readFileSync(file, 'utf8')).douyinCookie ?? ''
  } catch {
    /* 没装应用也算正常 */
  }
  console.log(`      应用 cookie ${cookie.length} 字符`)
  try {
    const page = await room.fetchPage('108011161837', cookie)
    console.log(`      带 cookie 抓到：正文 ${page.html.length} 字符`)
    check('真实页面不被误判成验证页', room.looksLikeChallengePage(page.html), false)
  } catch (error) {
    console.log(`      带 cookie 仍然抛出：code=${error?.code} detail=${error?.detail}`)
  }
}

console.log(`\n=== 小结 ===\n${failures === 0 ? '✓ 全部断言通过' : `✗ ${failures} 项断言失败`}`)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
