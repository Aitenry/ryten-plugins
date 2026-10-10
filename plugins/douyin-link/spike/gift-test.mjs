/**
 * dev-only 探针（不参与打包）：验证**通用礼物通道**（`WebcastGiftMessage`，匿名直连）在指定直播间
 * 到底能不能收到礼物；支持**多房间并发**与**长时间运行（自动重连）**。
 *
 * 用法：
 *   node plugins/douyin-link/spike/gift-test.mjs 108011161837 895805895016 --seconds=3600
 *   node plugins/douyin-link/spike/gift-test.mjs 房间号1,房间号2 --seconds=1800   （逗号或空格分隔）
 *
 * 做法：用插件自己的 `main/douyin/sign.ts` 生成签名直连推送 ws（匿名，不带登录 Cookie），
 * 用插件自己的 `main/douyin/proto-messages.ts` 解码；掉线自动重连（每次重新签名）直到到点。
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import * as crypto from 'node:crypto'
import * as tls from 'node:tls'
import * as zlib from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '..')
const require = createRequire(import.meta.url)
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const args = process.argv.slice(2)
const seconds = Number(args.find((a) => a.startsWith('--seconds='))?.slice(10) ?? 90)
/** `--cookie=<完整 Cookie 头>`：登录态 Cookie（留空 = 匿名）。抖音只向已登录会话推送礼物消息 */
const cookieArg = args.find((a) => a.startsWith('--cookie='))?.slice('--cookie='.length) ?? ''
const rooms = args
  .filter((a) => !a.startsWith('--'))
  .flatMap((a) => a.split(','))
  .map((s) => s.trim())
  .filter((s) => /^\d{6,}$/.test(s))
if (rooms.length === 0) {
  console.error('用法：node gift-test.mjs <房间号...> [--seconds=N] [--cookie="登录态Cookie"]   （多房间**并发**、掉线自动重连）')
  process.exit(2)
}

/* 打包并加载插件自己的「签名」与「解码」模块 */
const tmp = mkdtempSync(join(tmpdir(), 'dy-gift-test-'))
async function bundle(rel) {
  const outfile = join(tmp, rel.replace(/[\\/]/g, '_') + '.cjs')
  await build({ entryPoints: [join(PLUGIN, rel)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' })
  return require(outfile)
}
const { buildPushUrl, PUSH_UA } = await bundle('main/douyin/sign.ts')
const proto = await bundle('main/douyin/proto-messages.ts')
rmSync(tmp, { recursive: true, force: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function text(url, headers) {
  const r = await fetch(url, { headers, redirect: 'follow' })
  const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : []
  return { status: r.status, cookie: setCookie.map((c) => c.split(';')[0]).join('; '), body: await r.text() }
}

/** 首页游客 ttwid（匿名身份，与插件一致）；并发时共用一个 Promise */
let guestPromise = null
function guest() {
  if (!guestPromise) guestPromise = text('https://live.douyin.com/', { 'user-agent': UA }).then((h) => h.cookie)
  return guestPromise
}

/** 把 `--cookie` 里的登录态 Cookie 合并到游客 Cookie 上（同名键以登录态为准，与插件 `cookie.ts` 同规则） */
function mergeCookie(configured, anonymous) {
  const map = new Map()
  for (const part of `${anonymous || ''};${configured || ''}`.split(';')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    const name = part.slice(0, i).trim()
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name)) continue
    map.set(name, part.slice(i + 1).trim())
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ')
}

/** 有效 Cookie（登录态叠加游客），并发共用一个 Promise */
let cookiePromise = null
function effectiveCookie() {
  if (!cookiePromise) cookiePromise = guest().then((g) => mergeCookie(cookieArg, g))
  return cookiePromise
}

async function roomIdOf(webRid) {
  const cookie = await effectiveCookie()
  const q = new URLSearchParams({
    aid: '6383', app_name: 'douyin_web', live_id: '1', device_platform: 'web', language: 'zh-CN',
    enter_from: 'web_live', cookie_enabled: 'true', screen_width: '2560', screen_height: '1440',
    browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Chrome',
    browser_version: '126.0.0.0', web_rid: webRid
  })
  const r = await text(`https://live.douyin.com/webcast/room/web/enter/?${q}`, {
    'user-agent': UA, cookie, referer: `https://live.douyin.com/${webRid}`, accept: 'application/json, */*'
  })
  try {
    const room = JSON.parse(r.body)?.data?.data?.[0]
    return { roomId: String(room?.id_str ?? ''), status: room?.status ?? 0, title: room?.title ?? '', cookie }
  } catch {
    return { roomId: '', status: 0, title: '', cookie }
  }
}

/* ------------------------------------------------------------- ws 直连 */

function frameOut(opcode, payload) {
  const len = payload.length, mask = crypto.randomBytes(4)
  let header
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len])
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2) }
  const m = Buffer.from(payload); for (let i = 0; i < m.length; i++) m[i] ^= mask[i % 4]
  return Buffer.concat([header, mask, m])
}
const hbFrame = Buffer.concat([Buffer.from([(7 << 3) | 2, 2]), Buffer.from('hb')])

function readVarint(buf, off) {
  let result = 0, shift = 0, c = off
  while (c < buf.length) { const b = buf[c++]; result += (b & 0x7f) * 2 ** shift; if ((b & 0x80) === 0) return { value: result, next: c }; shift += 7; if (shift > 63) return null }
  return null
}
/** PushFrame：取 field 8 (payload) 与 field 7 (payloadType) */
function pushFrame(buf) {
  let off = 0, payload = null, type = ''
  while (off < buf.length) {
    const t = readVarint(buf, off); if (!t) break; off = t.next
    const no = Math.floor(t.value / 8), wire = t.value % 8
    if (wire === 0) { const v = readVarint(buf, off); if (!v) break; off = v.next }
    else if (wire === 2) {
      const l = readVarint(buf, off); if (!l) break
      const val = buf.subarray(l.next, l.next + l.value); off = l.next + l.value
      if (no === 8) payload = val
      if (no === 7) type = val.toString('utf8')
    } else if (wire === 5) off += 4
    else if (wire === 1) off += 8
    else break
  }
  return { payload, type }
}

/** 连一次（直到掉线 / 出错 / 到 maxMs），把结果累加进 result */
function connectOnce(roomId, cookie, result, maxMs) {
  return new Promise((resolveP) => {
    const u = new URL(buildPushUrl(roomId))
    let done = false, hb, hsDone = false, buf = Buffer.alloc(0)
    const finish = (why) => {
      if (done) return
      done = true
      if (hb) clearInterval(hb)
      if (why && why !== 'timeout') result.drops.push(why)
      try { socket.destroy() } catch {}
      resolveP()
    }
    const socket = tls.connect({ host: u.hostname, port: 443, servername: u.hostname }, () => {
      socket.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://live.douyin.com\r\nUser-Agent: ${PUSH_UA}\r\nCookie: ${cookie}\r\n\r\n`)
    })
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (!hsDone) {
        const i = buf.indexOf('\r\n\r\n'); if (i < 0) return
        const head = buf.subarray(0, i).toString('utf8')
        result.status = Number((head.split('\r\n')[0].match(/HTTP\/1\.1 (\d+)/) || [])[1] || 0)
        result.hs = (head.match(/Handshake-Msg:\s*(.+)/i) || [])[1]?.trim() || ''
        hsDone = result.status === 101
        buf = buf.subarray(i + 4)
        if (!hsDone) return finish(`handshake ${result.status} ${result.hs}`)
        result.conns++
        socket.write(frameOut(2, hbFrame))
        hb = setInterval(() => { try { socket.write(frameOut(2, hbFrame)) } catch {} }, 5000)
      }
      while (buf.length >= 2) {
        const b0 = buf[0], b1 = buf[1], op = b0 & 0x0f, masked = (b1 & 0x80) !== 0
        let len = b1 & 0x7f, off = 2
        if (len === 126) { len = buf.readUInt16BE(2); off = 4 }
        else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10 }
        if (masked) off += 4
        if (buf.length < off + len) break
        let payload = buf.subarray(off, off + len)
        if (masked) { const m = buf.subarray(off - 4, off); const o = Buffer.from(payload); for (let i = 0; i < o.length; i++) o[i] ^= m[i % 4]; payload = o }
        buf = buf.subarray(off + len)
        if (op === 8) return finish('server closed')
        if (op === 9) { try { socket.write(frameOut(0x0a, payload)) } catch {}; continue }
        if (op !== 2) continue
        result.frames++
        const { payload: inner } = pushFrame(payload)
        if (!inner || inner.length === 0) continue
        let body = inner
        if (body[0] === 0x1f && body[1] === 0x8b) { try { body = zlib.gunzipSync(body) } catch { continue } }
        let dec
        try { dec = proto.decodeProtoResponse(body) } catch { continue }
        for (const [m, c] of Object.entries(dec.batch.methods)) result.methods[m] = (result.methods[m] ?? 0) + c
        for (const item of dec.batch.items) if (item.kind === 'gift') result.gifts.push({ ...item, at: Date.now() })
      }
    })
    socket.on('error', (e) => finish('error ' + e.message))
    setTimeout(() => finish('timeout'), maxMs)
  })
}

async function run(webRid) {
  const info = await roomIdOf(webRid)
  console.log(`\n===== ${webRid} =====`)
  console.log(`# roomId=${info.roomId || '(空)'} status=${info.status} title=${info.title || '(空)'}`)
  console.log(`# 身份：${cookieArg ? '登录态 Cookie（已叠加游客 ttwid）' : '匿名（仅游客 ttwid）'}`)
  const result = { webRid, status: 0, hs: '', frames: 0, conns: 0, drops: [], methods: {}, gifts: [] }
  if (!info.roomId) {
    result.reason = 'no roomId'
    return result
  }
  const deadline = Date.now() + seconds * 1000
  // 每 60s 打印一次进度（与是否重连无关；连接稳定时也能看到实时进展）
  const ticker = setInterval(() => {
    const gifts = result.methods['WebcastGiftMessage'] ?? 0
    console.log(
      `  [${webRid}] ${new Date().toLocaleTimeString()} 连接${result.conns} 帧${result.frames} 礼物消息${gifts} 礼物行${result.gifts.length} 掉线${result.drops.length}`
    )
  }, 60000)
  while (Date.now() < deadline) {
    await connectOnce(info.roomId, info.cookie, result, Math.max(1000, deadline - Date.now()))
    if (Date.now() >= deadline) break
    await sleep(3000) // 重连退避
  }
  clearInterval(ticker)

  const uniq = Object.entries(result.methods).sort((a, b) => b[1] - a[1])
  console.log(`\n# ${webRid} 结果：HTTP ${result.status} 帧 ${result.frames} 连接 ${result.conns} 次 掉线 ${result.drops.length} 次`)
  console.log(`# 消息类型(${uniq.length})：${uniq.slice(0, 20).map(([m, c]) => `${m.replace(/^Webcast/, '')}=${c}`).join(' ') || '（无）'}`)
  console.log(`# WebcastGiftMessage = ${result.methods['WebcastGiftMessage'] ?? 0}；解出的礼物行 = ${result.gifts.length}`)
  for (const g of result.gifts.slice(0, 30)) {
    console.log(`   🎁 ${g.user || '(匿名)'}(${g.userId}) → ${g.toUser || '?'} | ${g.text || '(名字未知)'} ×${g.count} = ${g.diamonds} 抖币 | giftId=${g.giftId ?? '-'} groupId=${g.groupId || '-'}`)
  }
  return result
}

/** **并发**监听所有房间（同一时刻一起连，掉线各自重连，直到各自的 deadline） */
const all = await Promise.all(rooms.map((webRid) => run(webRid).catch((e) => ({ webRid, ok: false, reason: e.message }))))

console.log('\n===== 汇总 =====')
for (const r of all) {
  const gifts = r.methods?.['WebcastGiftMessage'] ?? 0
  console.log(`${r.webRid}: HTTP ${r.status ?? '-'} 帧 ${r.frames ?? 0} 连接 ${r.conns ?? 0} 礼物消息 ${gifts} 解出礼物 ${r.gifts?.length ?? 0} ${r.reason ? '(' + r.reason + ')' : ''}`)
}