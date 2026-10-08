/**
 * Phase 0 可行性 spike（dev-only，不进产物）：
 * 验证「无窗口」能否拿到 ws 的 signature，并用签名版 im/fetch 换到 push_server。
 *
 * 跑法：node plugins/douyin-link/spike/sign-spike.mjs <webRid> [recon|sign]
 *   recon —— 只抓页面、列出 script chunk、找含 acrawler/webmssdk 的那个
 *   sign  —— 求值 acrawler、算 signature、打签名版 im/fetch，打印 push_server / internal_ext
 */
import * as vm from 'node:vm'
import * as crypto from 'node:crypto'
import * as tls from 'node:tls'
import * as zlib from 'node:zlib'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const mode = process.argv[3] ?? 'recon'
let webRid = process.argv[2]
if (!webRid) {
  webRid = '108011161837'
}

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex')
}

async function fetchPage(rid) {
  const res = await fetch(`https://live.douyin.com/${rid}`, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
    },
    redirect: 'follow'
  })
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  const cookie = setCookie.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ')
  const html = await res.text()
  return { html, cookie, setCookie, status: res.status }
}

function listScripts(html) {
  const out = new Set()
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) out.add(m[1])
  return [...out]
}

/** 把页面里的 src 还原成可请求的绝对 URL */
function resolveUrl(src) {
  if (src.startsWith('//')) return 'https:' + src
  if (src.startsWith('/')) return 'https://live.douyin.com' + src
  if (/^https?:/.test(src)) return src
  return null
}

/** 在页面 script 里找出 webmssdk/acrawler 那个 chunk */
async function findAcrawlerUrl(html, cookie, rid) {
  for (const src of listScripts(html)) {
    const url = resolveUrl(src)
    if (!url) continue
    if (/webmssdk|acrawler/i.test(url)) return url
  }
  return null
}

/** 给 webmssdk 补浏览器环境（补环境），返回沙箱 */
function makeSandbox(cookie, rid) {
  const location = {
    href: `https://live.douyin.com/${rid}`,
    protocol: 'https:',
    host: 'live.douyin.com',
    hostname: 'live.douyin.com',
    port: '',
    pathname: `/${rid}`,
    search: '',
    hash: '',
    origin: 'https://live.douyin.com'
  }
  const navigator = {
    userAgent: UA,
    appName: 'Netscape',
    appVersion: '5.0 (Windows)',
    platform: 'Win32',
    language: 'zh-CN',
    languages: ['zh-CN', 'zh', 'en'],
    webdriver: false,
    plugins: { length: 0 },
    mimeTypes: { length: 0 },
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 0,
    onLine: true,
    cookieEnabled: true,
    product: 'Gecko',
    vendor: 'Google Inc.'
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
  const storage = (() => {
    const m = new Map()
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }
  })()
  const sandbox = {
    location,
    navigator,
    document,
    screen: { width: 2560, height: 1440, availWidth: 2560, availHeight: 1440, colorDepth: 24, pixelDepth: 24 },
    innerWidth: 2560,
    innerHeight: 1440,
    outerWidth: 2560,
    outerHeight: 1440,
    devicePixelRatio: 1,
    localStorage: storage,
    sessionStorage: storage,
    performance: { now: () => Date.now(), timeOrigin: Date.now() },
    crypto: { getRandomValues: (arr) => crypto.webcrypto.getRandomValues(arr), randomUUID: () => crypto.randomUUID() },
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
  sandbox.__cookieWrites = cookieWrites
  return sandbox
}

async function loadAcrawler(html, cookie, rid) {
  const url = await findAcrawlerUrl(html, cookie, rid)
  if (!url) return { error: 'no acrawler chunk found' }
  console.log(`[spike] acrawler chunk: ${url}`)
  const res = await fetch(url, { headers: { 'user-agent': UA, referer: `https://live.douyin.com/${rid}` } })
  if (!res.ok) return { error: `acrawler HTTP ${res.status}` }
  const code = await res.text()
  console.log(`[spike] acrawler len=${code.length}`)
  const sandbox = makeSandbox(cookie, rid)
  vm.createContext(sandbox)
  try {
    vm.runInContext(code, sandbox, { filename: 'webmssdk.es5.js', timeout: 20000 })
  } catch (e) {
    return { error: `eval failed: ${e.message}` }
  }
  const acrawler = sandbox.window?.byted_acrawler ?? sandbox.byted_acrawler
  console.log('[spike] byted_acrawler 存在:', Boolean(acrawler), 'keys:', acrawler ? Object.keys(acrawler).slice(0, 20) : [])
  console.log('[spike] acrawler 写过的 cookie:', JSON.stringify(sandbox.__cookieWrites).slice(0, 600))
  console.log('[spike] document.cookie 现状:', String(sandbox.document.cookie).slice(0, 300))
  return { sandbox, acrawler }
}

async function main() {
  console.log(`[spike] mode=${mode} webRid=${webRid}`)
  const page = await fetchPage(webRid)
  console.log(`[spike] page HTTP ${page.status} len=${page.html.length} cookie=${page.cookie.slice(0, 70)}`)

  const scripts = listScripts(page.html)
  console.log(`[spike] script 数=${scripts.length}`)
  for (const s of scripts.slice(0, 40)) console.log('   ', s)

  // 页面里是否直接提到 acrawler / webmssdk
  for (const kw of ['byted_acrawler', 'frontierSign', 'webmssdk', 'acrawler']) {
    console.log(`[spike] 页面提及 ${kw}:`, page.html.includes(kw))
  }

  if (mode === 'recon') {
    // 抓所有同源 script，找含目标关键字的
    for (const src of scripts) {
      const url = resolveUrl(src)
      if (!url) continue
      try {
        const r = await fetch(url, { headers: { 'user-agent': UA, referer: `https://live.douyin.com/${webRid}` } })
        if (!r.ok) {
          console.log(`[spike]   ${r.status} ${url}`)
          continue
        }
        const text = await r.text()
        const hit = ['byted_acrawler', 'frontierSign', 'webmssdk', 'acrawler'].filter((k) => text.includes(k))
        console.log(`[spike]   ${r.status} len=${text.length} hits=[${hit.join(',')}] ${url}`)
      } catch (e) {
        console.log(`[spike]   ERR ${url} ${e.message}`)
      }
    }
    return
  }

  if (mode === 'sign') {
    const loaded = await loadAcrawler(page.html, page.cookie, webRid)
    if (loaded.error) {
      console.log('[spike] 加载 acrawler 失败：', loaded.error)
      return
    }
    const { sandbox, acrawler } = loaded
    if (!acrawler) {
      console.log('[spike] 没拿到 byted_acrawler（沙箱顶层键：', Object.keys(sandbox).filter((k) => !k.startsWith('__')), '）')
      return
    }
    // 试试 frontierSign：X-MS-STUB = md5(参数串)
    const paramString = 'aid=6383&app_name=douyin_web&web_rid=' + webRid
    const stub = md5(paramString)
    console.log('[spike] X-MS-STUB =', stub)
    try {
      const out = acrawler.frontierSign({ 'X-MS-STUB': stub })
      console.log('[spike] frontierSign(未 init) 返回：', JSON.stringify(out))
    } catch (e) {
      console.log('[spike] frontierSign 抛错：', e.message)
    }
    // 试试 init（也许 init 后才会生成 webid / 改变签名）
    for (const args of [{ aid: 6383 }, { aid: 6383, dfp: true }, { aid: 6383, boe: false, dfp: true }]) {
      try {
        const r = acrawler.init(args)
        console.log('[spike] init(', JSON.stringify(args), ') →', typeof r === 'object' ? JSON.stringify(r).slice(0, 160) : String(r))
      } catch (e) {
        console.log('[spike] init 抛错：', e.message)
      }
    }
    console.log('[spike] init 后 cookie 写入:', JSON.stringify(sandbox.__cookieWrites).slice(0, 500))
    console.log('[spike] init 后 document.cookie:', String(sandbox.document.cookie).slice(0, 400))
    try {
      const out2 = acrawler.frontierSign({ 'X-MS-STUB': stub })
      console.log('[spike] frontierSign(init 后) 返回：', JSON.stringify(out2))
    } catch (e) {
      console.log('[spike] frontierSign(init 后) 抛错：', e.message)
    }
    return
  }

  if (mode === 'try') {
    console.log('[spike] set-cookie:', page.setCookie.map((c) => c.split('=')[0]).join(', '))
    const loaded = await loadAcrawler(page.html, page.cookie, webRid)
    if (loaded.error || !loaded.acrawler) {
      console.log('[spike] acrawler 不可用：', loaded.error ?? 'no acrawler')
      return
    }
    const { acrawler } = loaded
    const roomId = (page.html.match(/roomId\\?":\\?"(\d{6,})/) ?? [])[1] ?? ''
    console.log('[spike] roomId=', roomId)

    // 与 danmaku.ts poll() 完全一致的参数（顺序也一致）
    const base = {
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
    }

    for (const withSign of [false]) {
      const query = new URLSearchParams(base)
      if (withSign) {
        const stub = md5(query.toString())
        const sig = acrawler.frontierSign({ 'X-MS-STUB': stub })['X-Bogus']
        query.set('X-Bogus', sig)
        console.log(`\n[spike] 签名版：X-MS-STUB=${stub} X-Bogus=${sig}`)
      } else {
        console.log('\n[spike] 未签名版（对照）')
      }
      const res = await fetch(`https://live.douyin.com/webcast/im/fetch/?${query}`, {
        headers: {
          'user-agent': UA,
          cookie: page.cookie,
          referer: `https://live.douyin.com/${webRid}`,
          accept: 'application/x-protobuf, */*'
        }
      })
      const buf = Buffer.from(await res.arrayBuffer())
      console.log(`[spike]   HTTP ${res.status} len=${buf.length} 首字节=0x${buf.length ? buf[0].toString(16) : '--'}`)
      if (buf.length > 0 && buf[0] !== 0x7b) {
        const root = readMessage(buf)
        console.log('[spike]   顶层字段:', dumpFields(root))
        for (const no of [...root.keys()].sort((a, b) => a - b)) {
          if (no === 1) continue
          const s = getString(root, no)
          const v = getVarint(root, no)
          console.log(`[spike]     field ${no}:`, s ? JSON.stringify(s) : v !== undefined ? `varint ${v}` : dumpFields(new Map([[no, root.get(no)]])))
        }
      } else if (buf.length) {
        console.log('[spike]   body(JSON 前 300):', buf.toString('utf8').slice(0, 300))
      }
    }
    return
  }

  if (mode === 'ws') {
    const loaded = await loadAcrawler(page.html, page.cookie, webRid)
    if (loaded.error || !loaded.acrawler) {
      console.log('[spike] acrawler 不可用：', loaded.error ?? 'no acrawler')
      return
    }
    const { acrawler } = loaded
    const roomId = (page.html.match(/roomId\\?":\\?"(\d{6,})/) ?? [])[1] ?? ''

    // 先拿一次 cursor / internal_ext / push_server
    const base = new URLSearchParams({
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
    const fr = await fetch(`https://live.douyin.com/webcast/im/fetch/?${base}`, {
      headers: { 'user-agent': UA, cookie: page.cookie, referer: `https://live.douyin.com/${webRid}`, accept: 'application/x-protobuf, */*' }
    })
    const fbuf = Buffer.from(await fr.arrayBuffer())
    const froot = readMessage(fbuf)
    const pushServer = getString(froot, 10) ?? ''
    const cursor = getString(froot, 2) ?? ''
    const internalExt = getString(froot, 5) ?? ''
    console.log('[spike] push_server=', pushServer)
    console.log('[spike] cursor=', cursor)
    const host = new URL(pushServer).host
    const path = new URL(pushServer).pathname
    const did = (internalExt.match(/wss_push_did:(\d+)/) ?? [])[1] ?? ''
    console.log('[spike] wss_push_did=', did)

    const wsParams = new URLSearchParams({
      app_name: 'douyin_web',
      version_code: '180800',
      webcast_sdk_version: '1.0.14-beta.0',
      update_version_code: '1.0.14-beta.0',
      compress: 'gzip',
      device_platform: 'web',
      cookie_enabled: 'true',
      screen_width: '2560',
      screen_height: '1440',
      browser_language: 'zh-CN',
      browser_platform: 'Win32',
      browser_name: 'Mozilla',
      browser_version: UA,
      browser_online: 'true',
      tz_name: 'Asia/Shanghai',
      cursor,
      internal_ext: internalExt,
      host: 'https://live.douyin.com',
      aid: '6383',
      live_id: '1',
      did_rule: '3',
      debug: 'false',
      endpoint: 'live_pc',
      support_wrds: '1',
      user_unique_id: did,
      im_path: '/webcast/im/fetch/',
      identity: 'audience',
      need_persist_msg_count: '15',
      insert_task_id: '',
      live_reason: '',
      room_id: roomId,
      heartbeatDuration: '0'
    })

    const sign = (paramList) => {
      let o = ''
      for (const { param_name } of paramList) o += `,${param_name}=${wsParams.get(param_name) ?? ''}`
      const stub = md5(o.substring(1))
      return acrawler.frontierSign({ 'X-MS-STUB': stub })['X-Bogus']
    }

    // 补一份 __ac_nonce（来自 www.douyin.com）+ 用 did 充当 webid，看看能否过设备校验
    let nonce = ''
    try {
      const ww = await fetch('https://www.douyin.com/', { headers: { 'user-agent': UA } })
      const sc = ww.headers.getSetCookie ? ww.headers.getSetCookie() : []
      for (const c of sc) if (c.startsWith('__ac_nonce=')) nonce = c.split(';')[0]
    } catch {}
    const richCookie = `${page.cookie}; ${nonce}; webid=${did}; tt_webid=${did}; tt_webid_v2=${did}`
    console.log('[spike] richCookie 长度=', richCookie.length)

    const attempt = async (label, opts) => {
      const q = new URLSearchParams(wsParams)
      if (opts.debug) q.set('debug', 'true')
      if (opts.sig === 'empty') q.set('signature', sign([]))
      else if (opts.sig === 'query') q.set('signature', acrawler.frontierSign({ 'X-MS-STUB': md5(q.toString()) })['X-Bogus'])
      else if (opts.sig === 'list') q.set('signature', sign(opts.list))
      console.log(`\n[spike] ws 尝试：${label}（signature=${q.get('signature') ?? '无'}）`)
      let frames = 0
      const sock = wsConnect(host, `${path}?${q}`, opts.cookie ?? page.cookie, opts.ext, (payload) => {
        frames += 1
        try {
          const pf = parsePushFrame(payload)
          const methods = pf.payload ? decodeInner(pf.payload) : []
          console.log(`[spike]   帧#${frames} type=${pf.payloadType} enc=${pf.payloadEncoding} methods=[${methods.join(',')}]`)
        } catch (e) {
          console.log(`[spike]   帧#${frames} 解析失败: ${e.message}`)
        }
      }, (why) => console.log('[spike]   ws 结束:', why))
      await new Promise((r) => setTimeout(r, 5000))
      console.log(`[spike]   ${label} 共收 ${frames} 帧`)
      try {
        sock.destroy()
      } catch {}
      return frames
    }

    await attempt('富 cookie + signature=md5("")', { sig: 'empty', debug: true, ext: false, cookie: richCookie })
    await attempt('富 cookie + 无 signature', { sig: 'none', debug: true, ext: false, cookie: richCookie })
    process.exit(0)
  }

  if (mode === 'grep') {
    // 在页面引用的 bundle 里找 ws 参数构造
    const keywords = ['push/v2', 'websocket_key', '_getSocketParams', 'device_id', 'webid', 'Handshake', 'wss_info']
    for (const src of scripts) {
      const url = resolveUrl(src)
      if (!url) continue
      try {
        const r = await fetch(url, { headers: { 'user-agent': UA, referer: `https://live.douyin.com/${webRid}` } })
        if (!r.ok) continue
        const text = await r.text()
        for (const kw of keywords) {
          let i = text.indexOf(kw)
          let shown = 0
          while (i >= 0 && shown < 2) {
            console.log(`\n[grep] ${url.split('/').pop()} :: ${kw} @${i}\n   ...${text.slice(Math.max(0, i - 160), i + 200).replace(/\n/g, ' ')}...`)
            i = text.indexOf(kw, i + 1)
            shown += 1
          }
        }
      } catch (e) {
        console.log('[grep] ERR', url, e.message)
      }
    }
    return
  }

  if (mode === 'webid') {
    const variants = [
      { aid: 1768, service: 'www.douyin.com', needFid: false, url: 'https://ttwid.bytedance.com/ttwid/union/register/' },
      { aid: 1768, service: 'www.douyin.com', needFid: true, url: 'https://ttwid.bytedance.com/ttwid/union/register/' },
      { aid: 6383, service: 'live.douyin.com', needFid: true, url: 'https://ttwid.bytedance.com/ttwid/union/register/' },
      { aid: 6383, service: 'www.douyin.com', needFid: false, url: 'https://mssdk.bytedance.com/web/report' }
    ]
    for (const v of variants) {
      const body = JSON.stringify({
        region: 'cn',
        aid: v.aid,
        needFid: v.needFid,
        service: v.service,
        migrate_info: { ticket: '', source: 'node' },
        cbUrlProtocol: 'https',
        union: true
      })
      try {
        const r = await fetch(v.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': UA, referer: `https://live.douyin.com/${webRid}` },
          body
        })
        const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []
        const names = sc.map((c) => c.split('=')[0])
        console.log(`[spike] ${v.url} aid=${v.aid} needFid=${v.needFid} service=${v.service} -> HTTP ${r.status} cookies=[${names.join(',')}]`)
        if (names.some((n) => /webid|fid/i.test(n))) console.log('   ★ 命中 webid/fid:', sc.join(' || '))
        const t = await r.text()
        if (t.length < 200) console.log('   body:', t)
      } catch (e) {
        console.log(`[spike] ${v.url} ERR ${e.message}`)
      }
    }
    return
  }

  if (mode === 'secsdk') {
    const url = process.argv[4] ?? 'https://lf-c-flwb.bytetos.com/obj/rc-client-security/web/glue/1.0.0.64-fix.01/sdk-glue.js'
    const r = await fetch(url, { headers: { 'user-agent': UA, referer: `https://live.douyin.com/${webRid}` } })
    const text = await r.text()
    console.log('[spike] target len=', text.length, url.split('/').pop())
    const keywords = ['tt_webid', 'webid', 'WebId', 'register', 'ttwid', 'setTTWebid', 'bytedance.com', 'needFid']
    for (const kw of keywords) {
      let i = text.indexOf(kw)
      let shown = 0
      while (i >= 0 && shown < 3) {
        console.log(`\n[grep] :: ${kw} @${i}\n   ...${text.slice(Math.max(0, i - 140), i + 180).replace(/\n/g, ' ')}...`)
        i = text.indexOf(kw, i + 1)
        shown += 1
      }
    }
    return
  }

  if (mode === 'ip') {
    try {
      const r = await fetch('https://ipinfo.io/json')
      console.log('[spike] ipinfo:', JSON.stringify(await r.json()))
    } catch (e) {
      console.log('[spike] ipinfo ERR', e.message)
    }
    return
  }

  if (mode === 'cookies') {
    const urls = [
      'https://www.douyin.com/',
      'https://live.douyin.com/',
      `https://live.douyin.com/${webRid}`,
      'https://www.douyin.com/passport/general/login_guiding_strategy/'
    ]
    for (const u of urls) {
      try {
        const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, redirect: 'follow' })
        const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []
        console.log(`[spike] ${u} -> ${r.status} cookies=[${sc.map((c) => c.split('=')[0]).join(',')}]`)
      } catch (e) {
        console.log(`[spike] ${u} ERR ${e.message}`)
      }
    }
    return
  }

  if (mode === 'htmljs') {
    const all = new Set()
    for (const m of page.html.matchAll(/[^"'\s()]+\.js/g)) all.add(m[0])
    console.log('[spike] HTML 内出现的 .js：')
    for (const u of [...all].slice(0, 60)) console.log('   ', u)
    console.log('[spike] HTML 含 push/v2:', page.html.includes('push/v2'), ' webcast/im/push:', page.html.includes('webcast/im/push'))
    // 找 webpack chunk manifest / 资源映射
    for (const kw of ['push/v2', 'routeParams', 'pushServer', 'websocket_key', '__LOADABLE', 'asset-manifest', 'chunk']) {
      const i = page.html.indexOf(kw)
      if (i >= 0) console.log(`[spike] HTML 命中 ${kw} @${i}: ...${page.html.slice(i - 100, i + 120).replace(/\n/g, ' ')}...`)
    }
    return
  }

  if (mode === 'chunks') {
    const urls = new Set()
    for (const m of page.html.matchAll(/https:\/\/lf-webcast-platform\.bytetos\.com\/[^"'\s]+\.js/g)) urls.add(m[0])
    console.log('[spike] chunk 数=', urls.size)
    const keywords = ['push/v2', 'websocket_key', 'routeParams', 'pushServer', 'getSocketParams', 'wss_info', 'signature']
    for (const url of urls) {
      try {
        const r = await fetch(url, { headers: { 'user-agent': UA, referer: `https://live.douyin.com/${webRid}` } })
        if (!r.ok) continue
        const text = await r.text()
        for (const kw of keywords) {
          const i = text.indexOf(kw)
          if (i >= 0) {
            console.log(`\n[chunk] ${url.split('/').pop()} :: ${kw} @${i}\n   ...${text.slice(Math.max(0, i - 200), i + 260).replace(/\n/g, ' ')}...`)
          }
        }
      } catch {
        /* ignore */
      }
    }
    return
  }

  if (mode === 'dumpchunk') {
    const url = process.argv[4]
    const off = Number(process.argv[5] ?? 0)
    const len = Number(process.argv[6] ?? 2000)
    const r = await fetch(url, { headers: { 'user-agent': UA, referer: `https://live.douyin.com/${webRid}` } })
    const text = await r.text()
    console.log(`[spike] ${url.split('/').pop()} len=${text.length} @${off}`)
    console.log(text.slice(Math.max(0, off - 100), off + len))
    return
  }

  if (mode === 'wskey') {
    const urls = new Set()
    for (const m of page.html.matchAll(/https:\/\/lf-webcast-platform\.bytetos\.com\/[^"'\s]+\.js/g)) urls.add(m[0])
    for (const url of urls) {
      try {
        const r = await fetch(url, { headers: { 'user-agent': UA, referer: `https://live.douyin.com/${webRid}` } })
        const text = await r.text()
        for (const kw of ['setWebsocketKey', 'websocket_key']) {
          let i = text.indexOf(kw)
          let shown = 0
          while (i >= 0 && shown < 4) {
            console.log(`\n[ws] ${url.split('/').pop()} :: ${kw} @${i}\n${text.slice(Math.max(0, i - 400), i + 400).replace(/\n/g, ' ')}`)
            i = text.indexOf(kw, i + 1)
            shown += 1
          }
        }
      } catch {
        /* ignore */
      }
    }
    return
  }

  console.log('[spike] 未知模式')
}
function wsConnect(host, pathWithQuery, cookie, withExt, onText, onClose) {
  const socket = tls.connect({ host, port: 443, servername: host }, () => {
    const key = crypto.randomBytes(16).toString('base64')
    const req =
      `GET ${pathWithQuery} HTTP/1.1\r\n` +
      `Host: ${host}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      (withExt ? `Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n` : '') +
      `Origin: https://live.douyin.com\r\n` +
      `User-Agent: ${UA}\r\n` +
      `Cookie: ${cookie}\r\n\r\n`
    socket.write(req)
  })
  let handshakeDone = false
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    if (!handshakeDone) {
      const idx = buffer.indexOf('\r\n\r\n')
      if (idx < 0) return
      const head = buffer.subarray(0, idx).toString('utf8')
      console.log('[spike] ws 握手响应首行:', head.split('\r\n')[0])
      handshakeDone = head.includes('101')
      buffer = buffer.subarray(idx + 4)
      if (!handshakeDone) {
        console.log('[spike] 非 101，响应头:\n' + head)
        console.log('[spike] 响应体(前 400):', buffer.subarray(0, 400).toString('utf8'))
        onClose('handshake failed')
        socket.destroy()
        return
      }
    }
    // 解帧
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
      const mask = masked ? buffer.subarray(off - 4, off) : null
      let payload = buffer.subarray(off, off + len)
      if (mask) {
        const out = Buffer.from(payload)
        for (let i = 0; i < out.length; i += 1) out[i] ^= mask[i % 4]
        payload = out
      }
      buffer = buffer.subarray(off + len)
      if (opcode === 8) {
        onClose('server closed')
        socket.destroy()
        return
      }
      if (opcode === 9) {
        // ping → pong
        socket.write(frameOut(0x0a, payload))
        continue
      }
      if (opcode === 2 || opcode === 1) onText(payload)
    }
  })
  socket.on('error', (e) => onClose('error: ' + e.message))
  return socket
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

/** PushFrame → gzip payload */
function parsePushFrame(buf) {
  const f = readMessage(buf)
  return {
    payloadType: getString(f, 7) ?? '',
    payloadEncoding: getString(f, 6) ?? '',
    payload: getBytes(f, 8)
  }
}

function decodeInner(payloadRaw) {
  let buf = payloadRaw
  if (buf && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf)
  const root = readMessage(buf)
  const methods = []
  for (const v of root.get(1) ?? []) {
    if (v.kind !== 'bytes') continue
    const m = readMessage(v.value)
    const method = getString(m, 1) ?? '?'
    methods.push(method)
  }
  return methods
}

/* ---------------- 极简 protobuf 读取（仅 spike 用） ---------------- */
function readVarint(buf, offset) {
  let result = 0
  let shift = 0
  let cursor = offset
  while (cursor < buf.length) {
    const byte = buf[cursor]
    cursor += 1
    result += (byte & 0x7f) * Math.pow(2, shift)
    if ((byte & 0x80) === 0) return { value: result, next: cursor }
    shift += 7
    if (shift > 63) return null
  }
  return null
}
function readMessage(buf) {
  const fields = new Map()
  let offset = 0
  while (offset < buf.length) {
    const tag = readVarint(buf, offset)
    if (!tag) break
    offset = tag.next
    const no = Math.floor(tag.value / 8)
    const wire = tag.value % 8
    if (no <= 0) break
    const push = (v) => fields.set(no, [...(fields.get(no) ?? []), v])
    if (wire === 0) {
      const n = readVarint(buf, offset)
      if (!n) break
      push({ kind: 'varint', value: n.value })
      offset = n.next
    } else if (wire === 2) {
      const len = readVarint(buf, offset)
      if (!len) break
      push({ kind: 'bytes', value: buf.subarray(len.next, len.next + len.value) })
      offset = len.next + len.value
    } else if (wire === 5) {
      push({ kind: 'fixed32', value: buf.readUInt32LE(offset) })
      offset += 4
    } else if (wire === 1) {
      push({ kind: 'fixed64', value: buf.subarray(offset, offset + 8) })
      offset += 8
    } else break
  }
  return fields
}
function dumpFields(fields) {
  return [...fields.entries()].map(([no, list]) => `${no}:${list.map((v) => (v.kind === 'bytes' ? `bytes(${v.value.length})` : v.kind)).join('|')}`).join(' ')
}
function getBytes(fields, no) {
  for (const v of fields.get(no) ?? []) if (v.kind === 'bytes') return v.value
  return undefined
}
function getString(fields, no) {
  const raw = getBytes(fields, no)
  if (!raw || raw.length === 0 || raw.length > 400) return undefined
  const t = raw.toString('utf8')
  if (!Buffer.from(t, 'utf8').equals(raw)) return undefined
  return t
}
function getVarint(fields, no) {
  for (const v of fields.get(no) ?? []) if (v.kind === 'varint') return v.value
  return undefined
}

main()