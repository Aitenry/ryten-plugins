/**
 * 设备闸探针（dev-only，不参与打包）。
 *
 * 要回答的问题：**主进程（纯 Node，无窗口）到底能不能建上抖音推送 ws？**
 *
 * 背景：`sign-spike.mjs ws` 实测握手被回 `Handshake-Msg: DEVICE_BLOCKED`，
 * 但那次只试了 `signature=md5("")` 与「无 signature」——**从没试过用正确参数串算出来的签名**，
 * 所以「签名没用、闸在设备指纹」这个结论其实没被证伪。本探针把它补齐：
 *
 *   1. 用真 Chrome 加载直播间页（页面自己会建推送 ws，带着**浏览器亲算**的 signature）；
 *   2. CDP 截下那条 ws 的**完整 URL**（含 signature）与当时的 Cookie；
 *   3. 再用**纯 Node 的 tls 裸连**，分别试三种 URL：
 *        A. 逐字复刻浏览器那条 URL（签名是浏览器给的，必然"正确"）——**这一步最关键**：
 *           若 A 也被 DEVICE_BLOCKED，说明闸绑的是浏览器上下文/会话，Node 直连此路不通；
 *           若 A 返回 101，说明闸只认「正确的签名 + 对应设备身份」，那剩下的就是离线算签名的事。
 *        B. 用页面自己的 webmssdk（Node vm 补环境）**按 URL 参数顺序重算签名**；
 *        C. 对照：把 signature 抹掉。
 *
 * 跑法：
 *   node plugins/douyin-link/spike/gate-spike.mjs 108011161837
 *   node plugins/douyin-link/spike/gate-spike.mjs 108011161837 --headed --seconds=40
 *
 * 参数：`<房间号|链接>` `[--headed]` `[--seconds=N]` `[--port=9333]`
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as vm from 'node:vm'
import * as crypto from 'node:crypto'
import * as tls from 'node:tls'
import * as zlib from 'node:zlib'
import { parseWebRid, readMessage, getBytes } from './pb.mjs'

const PUSH_URL_MARKS = ['/webcast/im/push/', '/bytelink/wss/']
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean)

const args = process.argv.slice(2)
const headed = args.includes('--headed')
const port = Number(args.find((a) => a.startsWith('--port='))?.slice('--port='.length) ?? 9333)
const seconds = Number(args.find((a) => a.startsWith('--seconds='))?.slice('--seconds='.length) ?? 45)
const input = args.filter((a) => !a.startsWith('-'))[0]
if (!input) {
  console.error('用法：node gate-spike.mjs <房间号|链接> [--headed] [--seconds=N] [--port=N]')
  process.exit(2)
}
const webRid = parseWebRid(input)
if (!webRid) {
  console.error('解析不出房间号：', input)
  process.exit(2)
}
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!chrome) {
  console.error('找不到 Chrome/Edge：', CHROME_CANDIDATES.join(' | '))
  process.exit(2)
}

const roomUrl = `https://live.douyin.com/${webRid}`
const profileDir = mkdtempSync(join(tmpdir(), 'douyin-gate-spike-'))
console.log(`# 用 ${chrome} 打开 ${roomUrl}（${headed ? '有头' : 'headless'}，采集 ${seconds}s）`)

const child = spawn(
  chrome,
  [
    ...(headed ? [] : ['--headless=new']),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
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
  { stdio: 'ignore' }
)

let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  try {
    child.kill()
  } catch {}
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 })
  } catch {}
}
process.on('exit', cleanup)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const md5 = (t) => crypto.createHash('md5').update(t, 'utf8').digest('hex')

/* --------------------------------------------------------------- CDP 客户端 */
async function waitForDevtools() {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) return await r.json()
    } catch {}
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

/** 截到的推送 ws（完整 URL + 当时的 Cookie 头） */
const pushSockets = []
let pageCookieHeader = ''

const version = await waitForDevtools()
console.log(`# ${version.Browser ?? 'CDP'} 已就绪（port ${port}）`)
const target = await pickPageTarget()
const cdp = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
function send(method, params = {}) {
  const id = nextId++
  cdp.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(undefined)
    }, 15000)
    pending.set(id, (v) => {
      clearTimeout(timer)
      resolve(v)
    })
  })
}
await new Promise((resolve, reject) => {
  cdp.addEventListener('open', resolve)
  cdp.addEventListener('error', () => reject(new Error('CDP websocket 连不上')))
})

/** 拿某个 URL 下的 Cookie（含子域），拼成请求头 */
async function cookieHeaderFor(url) {
  const res = await send('Network.getCookies', { urls: [url] })
  const cookies = res?.cookies ?? []
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

cdp.addEventListener('message', (event) => {
  let msg
  try {
    msg = JSON.parse(event.data)
  } catch {
    return
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result)
    pending.delete(msg.id)
    return
  }
  const { method, params } = msg
  if (method === 'Network.webSocketCreated') {
    const url = String(params?.url ?? '')
    if (PUSH_URL_MARKS.some((m) => url.includes(m))) {
      console.log(`# ★ 页面建了推送 ws：${url.slice(0, 90)}…`)
      pushSockets.push({ requestId: params.requestId, url, cookie: pageCookieHeader, at: Date.now() })
    }
    return
  }
})

/**
 * 在页面里挂钩 `byted_acrawler.frontierSign`，把**前端每次签名的输入/输出**记下来。
 *
 * 这是本探针的核心证据：只要拿到前端真实用的 `X-MS-STUB`（= md5(参数串)）与输出的 `X-Bogus`，
 * 就能反推出「参数串到底包含哪些参数、什么顺序」，并核对与浏览器那条 ws URL 里的 signature 是否同源。
 * 必须在导航前注入（页面脚本一执行就会挂上 byted_acrawler）。
 */
const HOOK = `(() => {
  window.__gateLog = [];
  window.__gateHooked = [];
  const METHODS = ['frontierSign','setTTWebid','setTTWebidV2','setTTWid','init','setConfig','setUserMode','getReferer','report'];
  const wrap = (a) => {
    if (!a) return;
    for (const name of METHODS) {
      if (typeof a[name] !== 'function' || a['__w_' + name]) continue;
      const orig = a[name].bind(a);
      try {
        a[name] = function (...args) {
          const out = orig(...args);
          try {
            window.__gateLog.push({
              method: name,
              args: JSON.parse(JSON.stringify(args)),
              output: JSON.parse(JSON.stringify(out ?? null)),
              at: Date.now()
            });
          } catch (e) {}
          return out;
        };
        a['__w_' + name] = true;
        window.__gateHooked.push(name);
      } catch (e) {
        window.__gateHookErr = String(e);
      }
    }
  };
  // 1) 预置 accessor：sdk 若用普通赋值，能在赋值当刻包住方法
  try {
    let val;
    Object.defineProperty(window, 'byted_acrawler', {
      configurable: true,
      get() { return val; },
      set(v) { val = v; wrap(v); }
    });
  } catch (e) { window.__gateHookErr = 'accessor:' + e; }
  // 2) 打补丁 Object.defineProperty：sdk 实测用 defineProperty 重定义（绕过 setter）
  const origDP = Object.defineProperty;
  Object.defineProperty = function (obj, prop, desc) {
    const r = origDP.call(this, obj, prop, desc);
    try { if ((obj === window || obj === globalThis) && prop === 'byted_acrawler') wrap(obj[prop]); } catch (e) {}
    return r;
  };
  // 3) 轮询兜底
  setInterval(() => wrap(window.byted_acrawler), 5);
  wrap(window.byted_acrawler);
})()`

await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK })
await send('Network.enable')
await send('Page.navigate', { url: roomUrl })
console.log('# 已导航（已注入 frontierSign 挂钩），等页面建推送 ws…')

/* 等页面建 ws；同时不断刷新 Cookie（ws 建连那一刻的 Cookie 才有意义） */
const deadline = Date.now() + Math.max(15, seconds) * 1000
while (Date.now() < deadline && pushSockets.length === 0) {
  await sleep(500)
  if (child.exitCode !== null) {
    console.log(`! 浏览器退出（code ${child.exitCode}）`)
    break
  }
  const header = await cookieHeaderFor(roomUrl)
  if (header) pageCookieHeader = header
  // 首条 ws 建连之前，Cookie 一直在变；补一次到已捕获但还没同步 cookie 的记录上
  for (const s of pushSockets) if (!s.cookie) s.cookie = pageCookieHeader
}

if (pushSockets.length === 0) {
  console.log('# 页面整场都没建推送 ws（可能没开播 / 被风控 / headless 不给分配节点）')
  console.log('# → 可以试 --headed 再跑一次')
  cleanup()
  process.exit(0)
}

const sample = pushSockets[0]
console.log(`\n# 捕获到 ${pushSockets.length} 条推送 ws；用第一条做 Node 复连实验`)
console.log(`# URL: ${sample.url}`)
console.log(`# Cookie 长度: ${sample.cookie.length}`)

/** 从 URL 里取设备信息（user_unique_id = wss_push_did）与 ttwid */
const sampleParams = new URL(sample.url).searchParams
const deviceId = sampleParams.get('user_unique_id') ?? ''
const ttwid = (sample.cookie.match(/(?:^|;\s*)ttwid=([^;]+)/) ?? [])[1] ?? ''
const webid = (sample.cookie.match(/(?:^|;\s*)(?:tt_webid|webid)=([^;]+)/) ?? [])[1] ?? ''
console.log(`# 设备 user_unique_id=${deviceId} ttwid=${ttwid.slice(0, 24)}… webid=${webid.slice(0, 24)}…`)

/** 读取页面里挂钩记下的前端签名调用（核心证据） */
const hookState = await send('Runtime.evaluate', {
  expression:
    'JSON.stringify({hooked: window.__gateHooked, err: window.__gateHookErr, log: (window.__gateLog||[]).slice(0,60)})',
  returnByValue: true
})
let state = {}
try {
  state = JSON.parse(hookState?.result?.value ?? '{}')
} catch {}
const logged = state.log ?? []
const signCalls = logged.filter((e) => e.method === 'frontierSign')
const setupCalls = logged.filter((e) => e.method !== 'frontierSign')
console.log(`\n# 挂钩方法：${JSON.stringify(state.hooked ?? [])}${state.err ? ` err=${state.err}` : ''}`)
console.log(`# 前端调用记录：签名 ${signCalls.length} 条、其它 ${setupCalls.length} 条`)
for (const e of setupCalls.slice(0, 12)) {
  console.log(`  ${e.method}(${JSON.stringify(e.args).slice(0, 120)}) → ${JSON.stringify(e.output).slice(0, 80)}`)
}
for (const [i, entry] of signCalls.entries()) {
  const stub = entry.args?.[0]?.['X-MS-STUB'] ?? ''
  const bogus = entry.output?.['X-Bogus'] ?? ''
  const urlSig = sampleParams.get('signature') ?? ''
  console.log(`  [签名 ${i}] X-MS-STUB=${stub} → X-Bogus=${bogus}${bogus === urlSig ? '  ★与 ws URL 的 signature 一致' : ''}`)
}
const browserStub = signCalls[0]?.args?.[0]?.['X-MS-STUB'] ?? ''

/** 采集页面真实运行环境 + 设备状态（补环境要对齐的字段 / cookie / storage） */
const envEval = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    ua: navigator.userAgent, platform: navigator.platform, language: navigator.language,
    languages: navigator.languages, hc: navigator.hardwareConcurrency, dm: navigator.deviceMemory,
    mtp: navigator.maxTouchPoints, w: innerWidth, h: innerHeight, ow: outerWidth, oh: outerHeight,
    dpr: devicePixelRatio, sw: screen.width, sh: screen.height, aw: screen.availWidth,
    ah: screen.availHeight, cd: screen.colorDepth, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    pageCookie: document.cookie,
    local: (() => { try { return Object.fromEntries(Object.entries(localStorage)); } catch (e) { return {}; } })(),
    session: (() => { try { return Object.fromEntries(Object.entries(sessionStorage)); } catch (e) { return {}; } })(),
    globals: Object.keys(window).filter((k) => /webid|ttwid|device|ac_|sec|mstoken|byte|bogus/i.test(k)).slice(0, 60)
  })`,
  returnByValue: true
})
let env = {}
try {
  env = JSON.parse(envEval?.result?.value ?? '{}')
} catch {}
console.log(`\n# 页面环境：${JSON.stringify({ ...env, pageCookie: undefined, local: undefined, session: undefined })}`)
console.log(`# document.cookie：${String(env.pageCookie ?? '').slice(0, 400)}`)
console.log(`# localStorage 键：${JSON.stringify(Object.keys(env.local ?? {}))}`)
console.log(`# 疑似设备全局：${JSON.stringify(env.globals ?? [])}`)

/** frontierSign 是否确定：同一 stub 在浏览器里连调两次，输出是否一致 */
if (browserStub) {
  const detEval = await send('Runtime.evaluate', {
    expression: `(() => {
      const s = window.byted_acrawler;
      const stub = ${JSON.stringify(browserStub)};
      const a = s.frontierSign({ 'X-MS-STUB': stub })?.['X-Bogus'];
      const b = s.frontierSign({ 'X-MS-STUB': stub })?.['X-Bogus'];
      return JSON.stringify({ a, b, same: a === b });
    })()`,
    returnByValue: true
  })
  console.log(`# 浏览器内 determinism（同 stub 两次）：${detEval?.result?.value}`)
}

/* --------------------------------------------------- Node 裸连（tls 手搓 ws） */
function connectWs(url, cookieHeader, { onFrame } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url)
    const host = u.host
    const pathWithQuery = u.pathname + u.search
    const result = { status: 0, handshakeMsg: '', frames: 0, methods: [], error: '' }
    let done = false
    const finish = (why) => {
      if (done) return
      done = true
      result.error = result.error || why
      try {
        socket.destroy()
      } catch {}
      resolve(result)
    }
    const socket = tls.connect({ host, port: 443, servername: host }, () => {
      const key = crypto.randomBytes(16).toString('base64')
      socket.write(
        `GET ${pathWithQuery} HTTP/1.1\r\n` +
          `Host: ${host}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `Origin: https://live.douyin.com\r\n` +
          `User-Agent: ${UA}\r\n` +
          `Cookie: ${cookieHeader}\r\n\r\n`
      )
    })
    let handshakeDone = false
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!handshakeDone) {
        const idx = buffer.indexOf('\r\n\r\n')
        if (idx < 0) return
        const head = buffer.subarray(0, idx).toString('utf8')
        const first = head.split('\r\n')[0]
        result.status = Number((first.match(/HTTP\/1\.1 (\d+)/) ?? [])[1] ?? 0)
        result.handshakeMsg =
          (head.match(/Handshake-Msg:\s*(.+)/i) ?? [])[1]?.trim() ?? ''
        handshakeDone = result.status === 101
        buffer = buffer.subarray(idx + 4)
        if (!handshakeDone) {
          finish('handshake failed')
          return
        }
        console.log('   ✓ 握手 101，连接建立，等帧…')
      }
      while (buffer.length >= 2) {
        const b0 = buffer[0]
        const b1 = buffer[1]
        const opcode = b0 & 0x0f
        const masked = (b1 & 0x80) !== 0
        let len = b1 & 0x7f
        let off = 2
        if (len === 126) {
          len = buffer.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          len = Number(buffer.readBigUInt64BE(2))
          off = 10
        }
        if (masked) off += 4
        if (buffer.length < off + len) break
        let payload = buffer.subarray(off, off + len)
        if (masked) {
          const mask = buffer.subarray(off - 4, off)
          const out = Buffer.from(payload)
          for (let i = 0; i < out.length; i += 1) out[i] ^= mask[i % 4]
          payload = out
        }
        buffer = buffer.subarray(off + len)
        if (opcode === 8) return finish('server closed')
        if (opcode === 9) {
          socket.write(frameOut(0x0a, payload))
          continue
        }
        if (opcode === 2) {
          result.frames += 1
          try {
            const methods = decodeFrameMethods(payload)
            result.methods.push(...methods)
            if (onFrame) onFrame(methods)
          } catch {}
        }
      }
    })
    socket.on('error', (e) => {
      result.error = 'error: ' + e.message
      finish('error')
    })
    // 建连后给 6 秒收帧
    setTimeout(() => finish('timeout'), result.status ? 6000 : 15000)
  })
}

function frameOut(opcode, payload) {
  const len = payload.length
  const mask = crypto.randomBytes(4)
  let header
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len])
  else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

function decodeFrameMethods(buf) {
  const frame = readMessage(buf)
  let payload = getBytes(frame, 8)
  if (!payload || payload.length === 0) return []
  if (payload.length > 2 && payload[0] === 0x1f && payload[1] === 0x8b) {
    try {
      payload = zlib.gunzipSync(payload)
    } catch {
      return []
    }
  }
  const root = readMessage(payload)
  const out = []
  for (const v of root.fields.get(1) ?? []) {
    if (v.kind !== 'bytes') continue
    const m = readMessage(v.value)
    const method = getBytes(m, 1)
    if (method) out.push(method.toString('utf8').replace(/^Webcast/, ''))
  }
  return out
}

/* --------------------------------------------------- 离线加载页面 webmssdk */
function makeSandbox(cookie, env = {}) {
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const mkStorage = (seed) => {
    const m = new Map(Object.entries(seed || {}))
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      clear: () => m.clear(),
      key: (i) => [...m.keys()][i] ?? null,
      get length() {
        return m.size
      }
    }
  }
  const storage = mkStorage(env.local)
  const sessionStorage_ = mkStorage(env.session)
  const location = {
    href: roomUrl,
    protocol: 'https:',
    host: 'live.douyin.com',
    hostname: 'live.douyin.com',
    pathname: `/${webRid}`,
    origin: 'https://live.douyin.com'
  }
  const cookieWrites = []
  let cookieStr = cookie
  const document = {
    referrer: '',
    title: '',
    readyState: 'complete',
    visibilityState: 'visible',
    hidden: false,
    location,
    documentElement: { style: {} },
    body: { appendChild() {}, removeChild() {}, style: {} },
    head: { appendChild() {}, removeChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, getContext: () => null, appendChild() {} }),
    createElementNS: () => ({ style: {}, setAttribute() {} }),
    addEventListener() {},
    removeEventListener() {},
    getElementsByTagName: () => [],
    querySelector: () => null,
    querySelectorAll: () => [],
    get cookie() {
      return cookieStr
    },
    set cookie(v) {
      cookieWrites.push(String(v))
      if (v && !/;\s*$/.test(v)) cookieStr = v
    }
  }
  const sandbox = {
    location,
    navigator: {
      userAgent: env.ua || UA,
      appName: 'Netscape',
      appVersion: '5.0 (Windows)',
      platform: env.platform || 'Win32',
      language: env.language || 'zh-CN',
      languages: env.languages || ['zh-CN', 'zh', 'en'],
      webdriver: false,
      plugins: { length: 0 },
      mimeTypes: { length: 0 },
      hardwareConcurrency: num(env.hc, 8),
      deviceMemory: num(env.dm, 8),
      maxTouchPoints: num(env.mtp, 0),
      onLine: true,
      cookieEnabled: true,
      product: 'Gecko',
      vendor: 'Google Inc.'
    },
    document,
    screen: {
      width: num(env.sw, 2560),
      height: num(env.sh, 1440),
      availWidth: num(env.aw, 2560),
      availHeight: num(env.ah, 1440),
      colorDepth: num(env.cd, 24),
      pixelDepth: num(env.cd, 24)
    },
    innerWidth: num(env.w, 2560),
    innerHeight: num(env.h, 1440),
    outerWidth: num(env.ow, 2560),
    outerHeight: num(env.oh, 1440),
    devicePixelRatio: num(env.dpr, 1),
    localStorage: storage,
    sessionStorage: sessionStorage_,
    performance: { now: () => Date.now(), timeOrigin: Date.now() },
    crypto: { getRandomValues: (a) => crypto.webcrypto.getRandomValues(a), randomUUID: () => crypto.randomUUID() },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    TextEncoder,
    TextDecoder,
    console,
    fetch,
    XMLHttpRequest: function () {
      this.open = () => {}
      this.send = () => {}
      this.setRequestHeader = () => {}
      this.addEventListener = () => {}
    },
    Image: function () {
      this.addEventListener = () => {}
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true
    }
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.top = sandbox
  sandbox.parent = sandbox
  sandbox.globalThis = sandbox
  return { sandbox, cookieWrites }
}

/** 抓页面 → 按顺序在 vm 沙箱里求值**所有安全相关脚本**（webmssdk 之外还有 secsdk/isaac 那套） */
async function loadAcrawler(cookieOverride, env, opts = {}) {
  const res = await fetch(roomUrl, {
    headers: { 'user-agent': UA, accept: 'text/html,*/*' }
  })
  const html = await res.text()
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  const freshCookie = setCookie.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ')
  /** 需要按页面顺序加载的安全脚本（webmssdk 是签名本体；secsdk/glue/runtime 负责设备指纹） */
  const SECURITY_RE = /webmssdk|acrawler|secsdk|security|sdk-glue|bytegoofy|isaac|filter-xss/i
  const urls = []
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
    const src = m[1]
    if (!SECURITY_RE.test(src)) continue
    urls.push(src.startsWith('//') ? 'https:' + src : src.startsWith('/') ? 'https://live.douyin.com' + src : src)
  }
  if (urls.length === 0) return { error: '页面里没找到安全脚本' }
  const { sandbox } = makeSandbox(cookieOverride || freshCookie, env)
  vm.createContext(sandbox)
  let okay = 0
  for (const url of urls) {
    try {
      const codeRes = await fetch(url, { headers: { 'user-agent': UA, referer: roomUrl } })
      const code = await codeRes.text()
      vm.runInContext(code, sandbox, { filename: url.split('/').pop() || 'sec.js', timeout: 30000 })
      okay += 1
      console.log(`#   安全脚本 OK: ${url.split('/').slice(-2).join('/')} (len=${code.length})`)
    } catch (e) {
      console.log(`#   安全脚本失败: ${url.split('/').slice(-2).join('/')} → ${String(e.message).slice(0, 100)}`)
    }
  }
  const acrawler = sandbox.window?.byted_acrawler ?? sandbox.byted_acrawler
  const secGlobals = Object.keys(sandbox).filter((k) => /sec|isaac|bogus|ac_|glue|uifid/i.test(k))
  console.log(`# 沙箱内安全全局：${JSON.stringify(secGlobals)}（脚本成功 ${okay}/${urls.length}）`)
  return { acrawler, sandbox }
}

/** 按 URL 里的参数顺序（去掉 signature）算签名，与前端 `sign(paramList)` 同构 */
function stubForUrlOrder(url) {
  const u = new URL(url)
  const pairs = [...u.searchParams.entries()].filter(([k]) => k !== 'signature')
  return md5(pairs.map(([k, v]) => `${k}=${v}`).join(','))
}

/** 给离线 acrawler 补设备身份（页面里页面自己会带；离线要手动塞进去） */
function setupDevice(acr, info) {
  try {
    acr.setTTWebid?.(info.webid || info.deviceId)
  } catch {}
  try {
    acr.setTTWebidV2?.(info.webid || info.deviceId)
  } catch {}
  try {
    acr.setTTWid?.(info.ttwid)
  } catch {}
}

/* --------------------------------------------------- 开始复连实验 */
console.log('\n===== Node 裸连实验 =====')

/** 用给定 signature 连一次并打印结果（sig 为空 = 抹掉该参数） */
async function tryConnect(label, signature) {
  const u = new URL(sample.url)
  if (signature) u.searchParams.set('signature', signature)
  else u.searchParams.delete('signature')
  const r = await connectWs(u.toString(), sample.cookie)
  console.log(
    `[${label}] signature=${signature || '(无)'} → HTTP ${r.status}` +
      `${r.handshakeMsg ? ` / ${r.handshakeMsg}` : ''} / 收帧 ${r.frames}` +
      `${r.error ? ` (${r.error})` : ''}`
  )
  if (r.frames > 0) console.log(`    帧内消息：${[...new Set(r.methods)].slice(0, 20).join(', ')}`)
  return r
}

// A：逐字复刻浏览器那条 URL（签名由浏览器亲算）——这是「闸能不能从 Node 过」的基准
console.log('\n--- A 基准：浏览器亲算的签名 ---')
await tryConnect('A', sampleParams.get('signature') || '')

// B..：离线重算签名的各种姿势
let loaded
try {
  loaded = await loadAcrawler(env.pageCookie || sample.cookie, env)
} catch (e) {
  console.log('\n[B] 离线加载 webmssdk 失败：', e.message)
}
if (loaded?.acrawler) {
  const acr = loaded.acrawler
  const info = { deviceId, ttwid, webid }
  const sign = (stub) => acr.frontierSign({ 'X-MS-STUB': stub })?.['X-Bogus'] ?? ''
  const urlStub = stubForUrlOrder(sample.url)
  const browserSig = sampleParams.get('signature') || ''
  const loggedBogus = signCalls.map((e) => e.output?.['X-Bogus']).filter(Boolean)

  console.log('\n--- B 离线签名实验 ---')
  console.log(`URL 顺序算出的 X-MS-STUB=${urlStub}`)
  console.log(`前端挂钩记录的 X-Bogus=${JSON.stringify(loggedBogus)}`)

  // B1：裸签（URL 参数顺序）
  await tryConnect('B1', sign(urlStub))

  // B2：init 之后再签
  try {
    acr.init({ aid: 6383, dfp: true, region: 'cn' })
  } catch {}
  await tryConnect('B2', sign(urlStub))

  // B3：补设备身份（ttwid / webid / deviceId）之后再签
  setupDevice(acr, info)
  await tryConnect('B3', sign(urlStub))

  // B4：设备 + init 之后再签
  try {
    acr.init({ aid: 6383, dfp: true, region: 'cn' })
  } catch {}
  await tryConnect('B4', sign(urlStub))

  /**
   * B5（关键实验）：把页面里**前端真实调过的建身子调用**（init / setTTWebid / setTTWid / setConfig…）
   * 在离线 acrawler 上原样重放，再喂前端真实用过的 stub，看能否复现浏览器那条 signature。
   * 能复现 → 离线签名可行（只剩"参数串怎么拼"）；不能 → frontierSign 还依赖我们补不出的环境。
   */
  console.log('\n--- B5 重放前端建身子调用后再签名 ---')
  for (const e of setupCalls) {
    try {
      acr[e.method]?.(...(e.args ?? []))
      console.log(`  重放 ${e.method}(${JSON.stringify(e.args).slice(0, 80)})`)
    } catch (err) {
      console.log(`  重放 ${e.method} 抛错：${String(err).slice(0, 80)}`)
    }
  }
  for (const entry of signCalls) {
    const stub = entry.args?.[0]?.['X-MS-STUB']
    if (!stub) continue
    const bogus = sign(stub)
    const match = bogus === entry.output?.['X-Bogus']
    console.log(`  stub=${stub} → 离线=${bogus} 前端=${entry.output?.['X-Bogus']}${match ? '  ★完全一致' : ''}`)
    if (bogus && !loggedBogus.includes(bogus)) await tryConnect('B5', bogus)
  }
  if (browserSig && loggedBogus.includes(browserSig)) {
    console.log('  ★ 前端记录的 X-Bogus 里包含 ws URL 的 signature：签名同源')
  }
}

// C：对照——把 signature 抹掉
console.log('\n--- C 对照 ---')
await tryConnect('C', '')

console.log('\n# 实验结束，关闭浏览器')
cleanup()
process.exit(0)