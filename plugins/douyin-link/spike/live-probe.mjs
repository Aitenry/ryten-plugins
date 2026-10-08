/**
 * 直播间**主进程那条路**的探针（dev-only，不参与打包）：
 * 公开页拿 ttwid → `GET /webcast/im/fetch/?resp_content_type=protobuf` 轮询，
 * 把服务端推过来的消息**原样列出来**，并对指定 method 打出 protobuf 字段树 / 十六进制。
 *
 * 它存在的理由：`main/douyin/proto-messages.ts` 里每个字段号都得是**实测**出来的，
 * 不许猜（猜错就是把错数据写进库）。要加一种新消息（例如 `WebcastGiftMessage`）时，
 * 先用这个脚本对着真房间跑一轮，把字段号钉死，再回去写解码器。
 *
 * 跑法（不需要 electron，也不需要应用在跑）：
 *
 *   node plugins/douyin-link/spike/live-probe.mjs 108011161837
 *   node plugins/douyin-link/spike/live-probe.mjs https://live.douyin.com/108011161837 180
 *   node plugins/douyin-link/spike/live-probe.mjs 108011161837 3600 --dump=WebcastGiftMessage --stop-on=WebcastGiftMessage
 *   node plugins/douyin-link/spike/live-probe.mjs --discover https://live.douyin.com/category/1   # 挑房间
 *
 * 参数：
 *   <房间号|链接>   [秒数，默认 120]    [--dump=MethodA,MethodB]（默认礼物类）   [-v]（逐条打印）
 *   --stop-on=Method   收到该 method 就打印并退出（「等一条礼物帧」用这个）
 *   --hex              字段树的 hex 不截断
 * 输出：逐条 method（-v）、结束时的 method 汇总、dump 的字段树。
 *
 * 姊妹脚本 `ws-spike.mjs`：走**页面自己的 websocket**（真 Chrome + CDP）——两条路收到的消息
 * 不一定一样（礼物就可能只在其中一条上），所以两份都要能跑。
 */

import { Buffer } from 'node:buffer'
import { asText, dumpTree, getBytes, getBytesAll, getVarint, parseWebRid, readMessage } from './pb.mjs'

const HEADERS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 默认要 dump 的 method（礼物相关；这几个是「浏览器里看得见、插件里解不出来」的那批） */
const DEFAULT_DUMP = [
  'WebcastGiftMessage',
  'WebcastGiftBroadcastMessage',
  'WebcastBindingGiftMessage',
  'WebcastGiftSortMessage',
  // 礼物图标闪烁：真礼物送出时会推（2026-10-08 在 HTTP 通道上抓到过），也一起 dump 看它带不带礼物 id
  'WebcastGiftIconFlashMessage',
  'WebcastRoomRankMessage',
  'WebcastLinkerContributeMessage',
  'WebcastGuestBattleMessage',
  'WebcastRanklistHourEntranceMessage',
  'WebcastLinkmicOrderSingMessage'
]

const args = process.argv.slice(2)
const verbose = args.includes('-v') || args.includes('--verbose')
const dumpArg = args.find((a) => a.startsWith('--dump='))
const stopOnArg = args.find((a) => a.startsWith('--stop-on='))
const STOP_ON = stopOnArg ? stopOnArg.slice('--stop-on='.length) : ''
const positionals = args.filter((a) => !a.startsWith('-'))
const input = positionals[0]
const seconds = Number(positionals[1] ?? 120)
/** dump 时的 hex 前缀长度（整条太长；要全文用 `--hex`） */
const HEX_PREFIX = args.includes('--hex') ? Number.POSITIVE_INFINITY : 240
/** 每个 method 最多 dump 几次（同一种消息的结构是一样的，别把日志冲爆；`--dump-limit=N` 可调） */
const DUMP_LIMIT = Number(args.find((a) => a.startsWith('--dump-limit='))?.slice('--dump-limit='.length) ?? 3)

/** `--discover [房间号|链接]`：列房间（默认首页推荐；给了房间号就扫那个房间页面），不采集 */
if (args.includes('--discover')) {
  const from = input
    ? input.startsWith('http')
      ? input
      : `https://live.douyin.com/${input}`
    : 'https://live.douyin.com/'
  const response = await fetch(from, {
    headers: { 'user-agent': HEADERS_UA, accept: 'text/html,*/*' }
  })
  const html = await response.text()
  // 页面里的 SSR 数据是转义过的（`\"web_rid\":\"…\"`），先去转义再匹配
  const clean = html.replace(/\\"/g, '"')
  const seen = new Set()
  for (const match of clean.matchAll(/"(?:web_rid|webRid)"\s*:\s*"?(\d{6,})"?/g)) {
    if (seen.has(match[1])) continue
    seen.add(match[1])
    // 卡片附近的人数与标题（挑房间用：实测当然优先挑人多的）
    const window = clean.slice(match.index, match.index + 1500)
    const count =
      window.match(/"(?:user_count_str|userCountStr|user_count|userCount)"\s*:\s*"?([^",}]{0,12})/)?.[1] ??
      window.match(/"(?:total_user|totalUser)"\s*:\s*(\d{1,12})/)?.[1] ??
      ''
    const title = window.match(/"title"\s*:\s*"([^"]{0,40})"/)?.[1] ?? ''
    console.log(`${match[1]}  ${count.padStart(8)}  ${title}`)
  }
  console.log(`# ${from} HTTP ${response.status}，共 ${seen.size} 个房间，HTML ${html.length} 字节`)
  process.exit(0)
}

if (!input) {
  console.error('用法：node live-probe.mjs <房间号|直播间链接> [秒数] [--dump=MethodA,MethodB] [--stop-on=Method] [-v]')
  console.error('      node live-probe.mjs --discover [房间号|链接]   # 列房间（挑热闹的那个）')
  process.exit(2)
}
const DUMP = new Set(
  dumpArg
    ? dumpArg
        .slice('--dump='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_DUMP
)

/* ------------------------------------------------------------- 网络那几步 */

const CHROME = {
  'user-agent': HEADERS_UA,
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
}

async function fetchPage(webRid) {
  const response = await fetch(`https://live.douyin.com/${webRid}`, {
    headers: { ...CHROME, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    redirect: 'follow'
  })
  const cookie = (response.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
  const html = await response.text()
  return { html, cookie, status: response.status }
}

async function enterRoom(webRid, roomId, cookie) {
  const query = new URLSearchParams({
    aid: '6383',
    app_name: 'douyin_web',
    live_id: '1',
    device_platform: 'web',
    language: 'zh-CN',
    enter_from: 'web_live',
    cookie_enabled: 'true',
    screen_width: '2560',
    screen_height: '1440',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '126.0.0.0',
    web_rid: webRid,
    room_id: roomId
  })
  const response = await fetch(`https://live.douyin.com/webcast/room/web/enter/?${query}`, {
    headers: { ...CHROME, cookie, referer: `https://live.douyin.com/${webRid}`, accept: 'application/json,*/*' }
  })
  const body = await response.text()
  let json = null
  try {
    json = JSON.parse(body)
  } catch {
    /* 空 body 是常见的风控抖动 */
  }
  return json?.data?.data?.[0] ?? null
}

function fetchQuery(webRid, roomId) {
  return new URLSearchParams({
    aid: '6383',
    app_name: 'douyin_web',
    live_id: '1',
    device_platform: 'web',
    language: 'zh-CN',
    enter_from: 'web_live',
    cookie_enabled: 'true',
    screen_width: '2560',
    screen_height: '1440',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '126.0.0.0',
    web_rid: webRid,
    room_id: roomId,
    did_rule: '3',
    debug: 'false',
    endpoint: 'live_pc',
    support_wrds: '1',
    im_path: '/webcast/im/fetch/',
    resp_content_type: 'protobuf',
    fetch_rule: '1',
    last_rtt: '0',
    user_unique_id: '',
    timestamp: String(Date.now())
  })
}

async function poll(webRid, roomId, cookie, cursor, internalExt) {
  const query = fetchQuery(webRid, roomId)
  if (cursor) query.set('cursor', cursor)
  if (internalExt) query.set('internal_ext', internalExt)
  const response = await fetch(`https://live.douyin.com/webcast/im/fetch/?${query}`, {
    headers: {
      ...CHROME,
      cookie,
      referer: `https://live.douyin.com/${webRid}`,
      accept: 'application/x-protobuf, */*'
    }
  })
  if (!response.ok) return { error: `HTTP ${response.status}` }
  const raw = Buffer.from(await response.arrayBuffer())
  if (raw.length === 0) return { error: 'empty body' }
  if (raw[0] === 0x7b) return { error: 'JSON body (服务端忽略了 resp_content_type)' }
  const root = readMessage(raw)
  const messages = []
  for (const payload of getBytesAll(root, 1)) {
    const message = readMessage(payload)
    const methodRaw = getBytes(message, 1)
    const body = getBytes(message, 2)
    if (!methodRaw || !body) continue
    messages.push({ method: methodRaw.toString('utf8'), body })
  }
  return {
    messages,
    cursor: getBytes(root, 2)?.toString('utf8') ?? '',
    internalExt: getBytes(root, 5)?.toString('utf8') ?? '',
    intervalMs: getVarint(root, 3)?.value ?? 0,
    pushServer: getBytes(root, 10)?.toString('utf8') ?? getBytes(root, 14)?.toString('utf8') ?? '',
    fetchType: getVarint(root, 6)?.value ?? 0,
    bytes: raw.length
  }
}

/* ------------------------------------------------------------------- 主流程 */

const webRid = parseWebRid(input)
if (!webRid) {
  console.error('解析不出房间号：', input)
  process.exit(2)
}

console.log(`# 直播间 ${webRid}，采集 ${seconds}s，dump=${[...DUMP].join(',')}${STOP_ON ? `，收到 ${STOP_ON} 即停` : ''}`)
const page = await fetchPage(webRid)
const roomId = page.html.match(/\\?"roomId\\?":\\?"(\d{6,})\\?"/)?.[1] ?? null
console.log(`# 页面 HTTP ${page.status}，HTML ${page.html.length} 字节，Cookie=${page.cookie || '(空)'}`)
console.log(`# roomId=${roomId}`)
if (roomId) {
  const room = await enterRoom(webRid, roomId, page.cookie)
  if (room) {
    console.log(
      `# 房间：${room.title ?? ''} / 主播 ${room.owner?.nickname ?? ''} / 状态 ${room.status} / 在线 ${room.user_count_str ?? ''}`
    )
  } else {
    console.log('# enter 接口没给数据（风控抖动或未开播），仍然继续试 im/fetch')
  }
}

const counts = new Map()
const samples = new Map()
const dumpCount = new Map()
let cursor = ''
let internalExt = ''
let polls = 0
let items = 0
let summarized = false
/** Ctrl+C 也要给汇总（跑长采集时不用等满时长） */
process.on('SIGINT', () => {
  printSummary()
  process.exit(0)
})

function printSummary() {
  if (summarized) return
  summarized = true
  console.log(`\n# 轮询 ${polls} 次、共 ${items} 条消息`)
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1])
  for (const [method, count] of list) {
    const sample = samples.get(method)
    console.log(`${String(count).padStart(5)}  ${method}  (首条 ${sample ? sample.body.length : 0}B)`)
  }
}

const deadline = Date.now() + Math.max(5, seconds) * 1000
let hit = false

while (Date.now() < deadline && !hit) {
  let result
  try {
    result = await poll(webRid, roomId ?? '', page.cookie, cursor, internalExt)
  } catch (error) {
    console.log(`! 轮询异常 ${error?.message ?? error}`)
    await sleep(3000)
    continue
  }
  if (result.error) {
    console.log(`! ${result.error}`)
    await sleep(result.error.includes('503') ? 8000 : 3000)
    continue
  }
  polls += 1
  cursor = result.cursor || cursor
  internalExt = result.internalExt || internalExt
  items += result.messages.length
  if (polls === 1 && result.pushServer) {
    console.log(`# 服务端下发 push_server=${result.pushServer} fetch_type=${result.fetchType}`)
  }
  for (const { method, body } of result.messages) {
    counts.set(method, (counts.get(method) ?? 0) + 1)
    if (!samples.has(method)) samples.set(method, { body, at: Date.now() })
    if (verbose) {
      const preview = asText(body) ? `"${asText(body)}"` : `${body.length}B`
      console.log(`  ${method} ${preview}`)
    }
    if (DUMP.has(method) && (dumpCount.get(method) ?? 0) < DUMP_LIMIT) {
      dumpCount.set(method, (dumpCount.get(method) ?? 0) + 1)
      console.log(`\n=== dump #${dumpCount.get(method)} ${method} len=${body.length} ===`)
      console.log(`hex=${body.toString('hex').slice(0, HEX_PREFIX * 2)}`)
      dumpTree(body)
    }
    if (STOP_ON && method === STOP_ON) {
      console.log(`\n*** 收到 ${method}（第 ${counts.get(method)} 条），停止采集 ***`)
      hit = true
    }
  }
  if (hit) break
  const wait = Math.max(1500, result.intervalMs || 2000)
  await sleep(wait)
}

printSummary()
console.log(hit ? `# 已抓到 ${STOP_ON}` : `# ${Math.round(seconds)}s 内没有出现 ${STOP_ON || '（未指定 --stop-on）'}`)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
