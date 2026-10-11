/**
 * 诊断：**直播间解析（`resolveLiveRoom`）现在为什么回 `roomNotFound`**（dev-only，不参与打包）。
 *
 * 现象（2026-10-11 22:11 起）：监控开关打开的房间，界面一直「0 条 · 本场 0 · 库里 N 条」，
 * 日志每条房间都是 `监控 <webRid> 启动失败: roomNotFound`；而 21:32 之前是好的。
 *
 * 这个脚本把插件那条链**逐段复现**，看是哪一段断了（不猜）：
 * 1. `fetchPage('https://live.douyin.com/<webRid>')` → HTTP 码 / 正文长度 / 是否带 `ttwid` cookie；
 * 2. `pickRoomId(page.html)` → 页面里还找不找得到 `roomId`（找不到就成了 `roomNotFound`）；
 * 3. `enterLiveRoom(webRid, roomId, cookie)` → enter 接口的 `status_code` 与 data；
 * 4. 兜底 `fromPageHtml` → HTML 里那份 room 数据还在不在。
 *
 * 跑法：`node plugins/douyin-link/spike/room-resolve-probe.mjs [webRid...]`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const ROOT = join(HERE, '../../../')
const PLUGIN = join(HERE, '..')
const workDir = join(process.env.TEMP ?? '.', `room-resolve-${Date.now()}`)
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

/** 应用里的登录态 cookie（只读，不打印内容） */
function readCookie() {
  const file = join(process.env.APPDATA ?? '', 'ryten-bench', 'plugin-state', 'douyin-link.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8')).douyinCookie ?? ''
  } catch {
    return ''
  }
}
const appCookie = readCookie()
console.log(`# 应用 cookie：${appCookie.length} 字符（ttwid=${appCookie.includes('ttwid')}，sessionid=${appCookie.includes('sessionid')}）`)

const rids = process.argv.slice(2).filter((a) => /^\d+$/.test(a))
if (rids.length === 0) rids.push('108011161837', '760604769280', '41498419462')

for (const webRid of rids) {
  console.log(`\n=== ${webRid} ===`)
  /**
   * ⓪ **带应用里那份登录态 cookie** 直接抓一次页面（插件自己的解析是**不带** cookie 的，
   * 见 `fetchPage`）：这一步用来判断「换了账号 cookie 能不能绕过验证页」。
   */
  try {
    const withCookie = await fetch(`https://live.douyin.com/${webRid}`, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9',
        cookie: appCookie,
        referer: 'https://live.douyin.com/'
      },
      signal: AbortSignal.timeout(15000)
    })
    const html = await withCookie.text()
    const title = html.match(/<title>([^<]{0,60})<\/title>/)?.[1] ?? '(无 title)'
    const hasRoom = /"roomId"\s*:\s*"?\d{6,}/.test(html)
    console.log(`  ⓪ 带登录态 cookie 抓页面：HTTP ${withCookie.status}，${html.length} 字符，title=${title}，有 roomId=${hasRoom}`)
  } catch (error) {
    console.log(`  ⓪ 带 cookie 抓页面失败：${String(error?.message ?? error).slice(0, 100)}`)
  }

  /** ① 抓页面（**带应用 cookie**：修复后 `fetchPage` 就是这么调的；再跑一次不带的做对照） */
  let page = null
  try {
    page = await room.fetchPage(webRid, appCookie)
    console.log(`  ① fetchPage(带应用 cookie)：正文 ${page.html.length} 字符，页面 cookie ${page.cookie.length} 字符（ttwid=${page.cookie.includes('ttwid')}）`)
    const blocked = /验证|滑块|captcha|访问频繁|操作频繁/.test(page.html.slice(0, 4000))
    console.log(`     正文里有没有风控字样：${blocked}；<title> = ${page.html.match(/<title>([^<]{0,60})<\/title>/)?.[1] ?? '(没有 title)'}`)
  } catch (error) {
    console.log(`  ① fetchPage 失败：${error?.code ?? ''} ${String(error?.message ?? error).slice(0, 120)}`)
    continue
  }
  /** ② roomId */
  const roomId = page.html.match(/\\?"roomId\\?"\s*:\s*\\?"(\d{6,})\\?"/)?.[1] ?? ''
  console.log(`  ② 页面上取 roomId：${roomId || '(取不到 → 就会变成 roomNotFound)'}`)
  /** ②b 不带 cookie 的对照 */
  try {
    const bare = await room.fetchPage(webRid)
    console.log(`  ②b fetchPage(不带 cookie)：正文 ${bare.html.length} 字符（要是验证页就说明 cookie 是关键）`)
  } catch (error) {
    console.log(`  ②b fetchPage(不带 cookie) 抛出：code=${error?.code} detail=${error?.detail}`)
  }
  /** ③ enter 接口 */
  if (roomId) {
    try {
      const entered = await room.enterLiveRoom(webRid, roomId, page.cookie)
      console.log(
        `  ③ enterLiveRoom OK：主播=${entered.room.anchor} 状态=${entered.room.status} 在线=${entered.room.onlineText} ` +
          `成员 ${entered.roomUserIds.length} 个`
      )
    } catch (error) {
      console.log(`  ③ enterLiveRoom 失败：${error?.code ?? ''} ${String(error?.message ?? error).slice(0, 160)}`)
      /** 直接把 enter 的原始回话打出来（status_code 是关键） */
      const query = new URLSearchParams({
        aid: '6383',
        app_name: 'douyin_web',
        live_id: '1',
        device_platform: 'web',
        web_rid: webRid,
        room_id: roomId,
        resp_content_type: 'protobuf',
        endpoint: 'live_pc',
        timestamp: String(Date.now())
      })
      const raw = await fetch(`https://live.douyin.com/webcast/room/web/enter/?${query}`, {
        headers: {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          cookie: page.cookie,
          referer: `https://live.douyin.com/${webRid}`
        },
        signal: AbortSignal.timeout(15000)
      })
      const text = await raw.text()
      console.log(`     原始 enter：HTTP ${raw.status}，${text.length} 字符 → ${text.slice(0, 200)}`)
    }
  }
}
