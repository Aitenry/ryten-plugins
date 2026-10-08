/**
 * 直播间**页面 websocket 那条路**的探针（dev-only，不参与打包）。
 *
 * 为什么要单独一个：`im/fetch`（HTTP 轮询，见 `live-probe.mjs`）与页面自己的推送 ws
 * **收到的消息不一定一样**——实测 2026-10：同一个房间、同一段时间，
 * HTTP 那条路上连一条 `WebcastGiftMessage` 都没有，而浏览器页面上礼物提示照常出现。
 * 所以「礼物到底推没推、推在哪条路上」必须两条路都能量。
 *
 * 做法与插件 `main/douyin/ws-capture.ts` 完全同构（只是宿主从 electron 换成真 Chrome）：
 * 开一个浏览器加载直播间页 → 页面自己把 ws 连上（推送网关有设备指纹闸，合成 ttwid 直连会被
 * `DEVICE_BLOCKED` 挡回来，详见 `sign-spike.mjs`）→ 用 CDP 截 `Network.webSocketFrameReceived`
 * 的二进制帧 → `PushFrame.payload`（字段 8，常态 gzip）解压 → 就是同一份 `WebcastResponse`。
 *
 * 跑法（本机装了 Chrome 或 Edge 即可；不需要应用、不需要 electron）：
 *
 *   node plugins/douyin-link/spike/ws-spike.mjs 108011161837
 *   node plugins/douyin-link/spike/ws-spike.mjs 108011161837 900 --stop-on=WebcastGiftMessage
 *   node plugins/douyin-link/spike/ws-spike.mjs 108011161837 300 --headed        # 风控时可试有头
 *
 * 参数：`<房间号|链接>` `[秒数，默认 300]` `[--stop-on=Method]` `[--headed]` `[--port=9222]`
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { dumpTree, parseWebRid, getBytes, readMessage, readResponseMessages } from './pb.mjs'

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean)

/** 推送 ws 的 URL 特征（与插件 `ws-capture.ts` 同一份判据） */
const PUSH_URL_MARKS = ['/webcast/im/push/', '/bytelink/wss/']
/** 伪装成普通 Chrome（headless 的默认 UA 带 "HeadlessChrome"） */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'

const args = process.argv.slice(2)
const headed = args.includes('--headed')
const stopOn = args.find((a) => a.startsWith('--stop-on='))?.slice('--stop-on='.length) ?? ''
const port = Number(args.find((a) => a.startsWith('--port='))?.slice('--port='.length) ?? 9222)
const positionals = args.filter((a) => !a.startsWith('-'))
const input = positionals[0]
const seconds = Number(positionals[1] ?? 300)
/** `--reload-after=N`：第 N 秒像插件那样刷新一次页面；`--reenable`：刷新后再 enable 一次 Network 域 */
const reloadAfter = Number(args.find((a) => a.startsWith('--reload-after='))?.slice('--reload-after='.length) ?? 0)
const reenable = args.includes('--reenable')

if (!input) {
  console.error('用法：node ws-spike.mjs <房间号|直播间链接> [秒数] [--stop-on=Method] [--headed]')
  process.exit(2)
}
const webRid = parseWebRid(input)
if (!webRid) {
  console.error('解析不出房间号：', input)
  process.exit(2)
}
const chrome = CHROME_CANDIDATES.find((path) => existsSync(path))
if (!chrome) {
  console.error('找不到 Chrome/Edge：', CHROME_CANDIDATES.join(' | '))
  process.exit(2)
}

/** 用户数据目录：默认每次新建（干净）；给 `--profile=<dir>` 就**固定复用**——
 *  同一份设备身份与 Cookie 跨多次运行累积，更像「一直待在这个房间的设备」。 */
const profileArg = args.find((a) => a.startsWith('--profile='))?.slice('--profile='.length)
const profileDir = profileArg || mkdtempSync(join(tmpdir(), 'douyin-ws-spike-'))
const keepProfile = Boolean(profileArg)
const roomUrl = `https://live.douyin.com/${webRid}`
console.log(`# 用 ${chrome} 打开 ${roomUrl}（采集 ${seconds}s${stopOn ? `，收到 ${stopOn} 即停` : ''}）`)
console.log(`# 用户数据目录 ${profileDir}`)

const child = spawn(
  chrome,
  [
    ...(headed ? [] : ['--headless=new']),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    // headless 的 UA 里带 "HeadlessChrome"，抖音据此可能不给分配推送节点
    // （实测：默认 headless 下页面整场都不建 ws，只有 HTTP 轮询）——这里换成普通 Chrome UA
    `--user-agent=${UA}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--mute-audio',
    '--window-size=480,320',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank'
  ],
  { stdio: 'ignore', detached: false }
)

/** 退出时收摊：关浏览器、删临时 profile */
let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  try {
    // --profile= 指定时保留（下次接着用同一份身份）
    if (!keepProfile) rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* Windows 上浏览器可能还占着文件，删不掉就算了（临时目录） */
  }
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  summarize()
  process.exit(0)
})

/* --------------------------------------------------------------- CDP 客户端 */

const counts = new Map()
const samples = new Map()
const dumpCount = new Map()
const socketUrls = new Map()
/** 正在等 `Network.getResponseBody` 的页面自己发的 im/fetch 请求 */
const httpRequestIds = new Set()
/** 打过的页面接口路径（去重，避免刷屏） */
const loggedEndpoints = new Set()
let frames = 0
let wsCreated = 0
let summarized = false
let hit = false

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForDevtools() {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  throw new Error('CDP 端口没起来（30s）')
}

async function pickPageTarget() {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (page) return page
    await sleep(300)
  }
  throw new Error('没有可用的 page target')
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function decodeFrame(payloadData) {
  let payload
  try {
    const frame = readMessage(Buffer.from(payloadData, 'base64'))
    payload = getBytes(frame, 8)
  } catch {
    return []
  }
  if (!payload || payload.length === 0) return []
  let body = payload
  if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
    try {
      body = zlib.gunzipSync(body)
    } catch {
      return []
    }
  }
  try {
    return readResponseMessages(body).messages
  } catch {
    return []
  }
}

function handleMessages(messages, viaLabel) {
  for (const { method, body } of messages) {
    counts.set(method, (counts.get(method) ?? 0) + 1)
    if (!samples.has(method)) samples.set(method, { body, at: Date.now(), via: viaLabel })
    const limit = method.includes('Gift') || method.includes('OrderSing') ? 3 : 1
    if ((dumpCount.get(method) ?? 0) < limit && /Gift|Contribute|Rank|OrderSing|Notify/.test(method)) {
      dumpCount.set(method, (dumpCount.get(method) ?? 0) + 1)
      console.log(`\n=== ${viaLabel} dump #${dumpCount.get(method)} ${method} len=${body.length} ===`)
      // 礼物/点歌这类要能整帧回喂给 `decoder-check.mjs --frame=`，所以 hex 不截断
      console.log(`hex=${body.toString('hex')}`)
      dumpTree(body)
    }
    if (stopOn && method === stopOn) hit = true
  }
}

function summarize() {
  if (summarized) return
  summarized = true
  console.log(`\n# 页面建的 ws ${wsCreated} 条、收到推送帧 ${frames} 帧`)
  for (const [method, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const sample = samples.get(method)
    console.log(`${String(count).padStart(5)}  ${method}  (首条 ${sample ? sample.body.length : 0}B, ${sample?.via ?? ''})`)
  }
  if (counts.size === 0) console.log('# 一条消息都没解出来')
}

const version = await waitForDevtools()
console.log(`# ${version.Browser ?? 'CDP'} 已就绪（port ${port}）`)
const target = await pickPageTarget()
const socket = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()

function send(method, params = {}) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => {
    // 超时兜底：页面卡住/CDP 不回包时，主循环绝不能跟着一起挂死
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(undefined)
    }, 15000)
    pending.set(id, (value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', () => reject(new Error('CDP websocket 连不上')))
})

socket.addEventListener('message', (event) => {
  let message
  try {
    message = JSON.parse(event.data)
  } catch {
    return
  }
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result)
    pending.delete(message.id)
    return
  }
  const { method, params } = message
  /**
   * 页面自己打的 `im/fetch` 也要截：实测（2026-10）headless 里页面**根本没建 websocket**，
   * 它自己就是靠 HTTP 轮询收弹幕的——那就得看它的**回包**里有没有礼物，
   * 否则「礼物只在 ws 上」这个结论就成了猜的。
   */
  if (method === 'Network.responseReceived' && typeof params?.response?.url === 'string') {
    const url = params.response.url
    if (url.includes('/webcast/im/fetch/')) {
      httpRequestIds.add(params.requestId)
      console.log(`# 页面 im/fetch ← HTTP ${params.response.status}`)
    } else if (url.includes('/webcast/') && loggedEndpoints.size < 40) {
      const path = url.split('?')[0].replace('https://live.douyin.com', '')
      if (!loggedEndpoints.has(path)) {
        loggedEndpoints.add(path)
        console.log(`# 页面接口 ${path}`)
      }
    }
    return
  }
  if (method === 'Network.loadingFinished' && httpRequestIds.has(params?.requestId)) {
    const requestId = params.requestId
    httpRequestIds.delete(requestId)
    void send('Network.getResponseBody', { requestId }).then((body) => {
      if (!body?.body) return
      const raw = Buffer.from(body.base64Encoded ? body.body : Buffer.from(body.body, 'utf8').toString('base64'), 'base64')
      if (raw[0] === 0x7b) {
        console.log(`# 页面 im/fetch 回包是 JSON（${raw.length}B）`)
        return
      }
      try {
        const { messages } = readResponseMessages(raw)
        console.log(`# 页面 im/fetch 回包：${messages.length} 条（${messages.map((m) => m.method.replace(/^Webcast/, '')).join(',')}）`)
        handleMessages(messages, 'http')
      } catch (error) {
        console.log(`! 页面 im/fetch 回包解不动：${describe(error)}`)
      }
    })
    return
  }
  if (method === 'Network.webSocketCreated') {
    wsCreated += 1
    if (params?.requestId && params?.url) socketUrls.set(params.requestId, params.url)
    const isPush = Boolean(params?.url && PUSH_URL_MARKS.some((mark) => params.url.includes(mark)))
    console.log(`# ws[${wsCreated}]${isPush ? ' ←推送' : ''} ${String(params?.url ?? '').slice(0, 110)}`)
    return
  }
  if (method === 'Network.webSocketFrameReceived') {
    const url = socketUrls.get(params?.requestId ?? '') ?? ''
    if (!PUSH_URL_MARKS.some((mark) => url.includes(mark))) return
    const frame = params?.response
    if (!frame || frame.opcode !== 2 || !frame.payloadData) return
    frames += 1
    handleMessages(decodeFrame(frame.payloadData), 'ws')
    return
  }
  if (method === 'Network.webSocketClosed' && params?.requestId) socketUrls.delete(params.requestId)
})

await send('Network.enable')
await send('Page.enable')
await send('Page.navigate', { url: roomUrl })
console.log('# 已导航到直播间页，等页面的推送 ws…')

const deadline = Date.now() + Math.max(10, seconds) * 1000
let lastBeat = Date.now()
let lastWsCount = -1
const reloadAt = reloadAfter > 0 ? Date.now() + reloadAfter * 1000 : 0
let reloaded = false
let lastFrames = 0
while (Date.now() < deadline && !hit) {
  await sleep(500)
  if (child.exitCode !== null) {
    console.log(`! 浏览器退出了（code ${child.exitCode}）`)
    break
  }
  /**
   * 刷新实验（复刻插件每 10 分钟 reload 隐藏窗口）：
   * 用 `--reload-after=N [--reenable]` 看刷新后推送帧会不会断——
   * 用户的日志里，刷新后「页面已连上推送 ws」却整整 2 分钟没有帧（idle 失败），
   * 这正是消息丢失的窗口。
   */
  if (reloadAt && !reloaded && Date.now() >= reloadAt) {
    reloaded = true
    console.log(`# [实验] 第 ${reloadAfter}s 刷新页面（reenable=${reenable}）`)
    await send('Page.reload', { ignoreCache: false })
    if (reenable) await send('Network.enable')
  }
  if (Date.now() - lastBeat > 15000) {
    console.log(`# [帧数] 累计 ${frames} 帧（较上次 +${frames - lastFrames}）`)
    lastFrames = frames
  }
  // 心跳：页面到底加载成什么样、有没有在建 ws（headless 被风控时的唯一线索）
  if (Date.now() - lastBeat > 15000) {
    lastBeat = Date.now()
    const info = await send('Runtime.evaluate', {
      expression:
        'JSON.stringify({href: location.href, title: document.title, ready: document.readyState, text: (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, 100)})',
      returnByValue: true
    })
    console.log(`# 页面 ${info?.result?.value ?? '(读不到)'}`)
    if (wsCreated === lastWsCount) console.log('# （这 15s 内没有新建任何 ws）')
    lastWsCount = wsCreated
  }
}

summarize()
if (hit) console.log(`# 已抓到 ${stopOn}，停止`)
console.log('# 结束（关闭浏览器）')
process.exit(0)
