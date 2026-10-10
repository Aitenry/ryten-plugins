/**
 * dev-only 探针（不参与打包）：验证插件自己的 `main/douyin/sign.ts` + `push-frame.ts` 能在
 * **纯 Node** 下算出签名并直连抖音推送 ws（101 + 收到帧）。
 *
 * 跑法：
 *   node plugins/douyin-link/spike/push-spike.mjs 108011161837
 *   node plugins/douyin-link/spike/push-spike.mjs <房间号> <秒数>
 *
 * 做法：用 esbuild 把 `sign.ts` 临时打成 CJS → require → `buildPushUrl(roomId)` → tls 直连，
 * 发 hb 心跳、收帧、打印消息类型。与插件 `main/douyin/push-capture.ts` 的收发逻辑同构。
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

const webRid = process.argv[2] || '108011161837'
const seconds = Number(process.argv[3] || 20)

/** 1) 打包并加载插件自己的签名模块 */
const tmp = mkdtempSync(join(tmpdir(), 'dy-push-spike-'))
const outfile = join(tmp, 'sign.cjs')
await build({
  entryPoints: [join(PLUGIN, 'main/douyin/sign.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'silent'
})
const { buildPushUrl, PUSH_UA } = require(outfile)
rmSync(tmp, { recursive: true, force: true })

/** 2) 取 ttwid + roomId */
async function text(url, headers) {
  const r = await fetch(url, { headers, redirect: 'follow' })
  const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : []
  return { status: r.status, cookie: setCookie.map((c) => c.split(';')[0]).join('; '), body: await r.text() }
}
const home = await text('https://live.douyin.com/', { 'user-agent': UA })
const cookie = home.cookie
const q = new URLSearchParams({
  aid: '6383', app_name: 'douyin_web', live_id: '1', device_platform: 'web', language: 'zh-CN',
  enter_from: 'web_live', cookie_enabled: 'true', screen_width: '2560', screen_height: '1440',
  browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Chrome',
  browser_version: '126.0.0.0', web_rid: webRid
})
const enter = await text(`https://live.douyin.com/webcast/room/web/enter/?${q}`, {
  'user-agent': UA, cookie, referer: `https://live.douyin.com/${webRid}`, accept: 'application/json, */*'
})
let roomId = ''
let status = 0
try {
  const j = JSON.parse(enter.body)
  const room = j?.data?.data?.[0]
  roomId = String(room?.id_str ?? '')
  status = room?.status ?? 0
} catch {}
if (!roomId) { console.log('! 拿不到 roomId'); process.exit(1) }
console.log(`# webRid=${webRid} roomId=${roomId} status=${status}`)

const url = buildPushUrl(roomId)
console.log(`# signature=${new URL(url).searchParams.get('signature')} UA=${PUSH_UA.slice(0, 30)}…`)

/** 3) 直连 */
function frameOut(opcode, payload) {
  const len = payload.length, mask = crypto.randomBytes(4)
  let header
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len])
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2) }
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
  return Buffer.concat([header, mask, masked])
}
// 与 push-frame.ts 同款：只需要 hb
const hbFrame = Buffer.concat([Buffer.from([(7 << 3) | 2, 2]), Buffer.from('hb')])

function rv(buf, off) {
  let result = 0, shift = 0, c = off
  while (c < buf.length) { const b = buf[c++]; result += (b & 0x7f) * 2 ** shift; if ((b & 0x80) === 0) return { value: result, next: c }; shift += 7; if (shift > 63) return null }
  return null
}
function methods(buf) {
  const out = []
  let off = 0, payload = null
  while (off < buf.length) {
    const t = rv(buf, off); if (!t) break; off = t.next
    const no = Math.floor(t.value / 8), wire = t.value % 8
    if (wire === 0) { const v = rv(buf, off); if (!v) break; off = v.next }
    else if (wire === 2) { const l = rv(buf, off); if (!l) break; if (no === 8) payload = buf.subarray(l.next, l.next + l.value); off = l.next + l.value }
    else if (wire === 5) off += 4
    else if (wire === 1) off += 8
    else break
  }
  if (!payload || !payload.length) return out
  if (payload[0] === 0x1f && payload[1] === 0x8b) { try { payload = zlib.gunzipSync(payload) } catch { return out } }
  let o = 0
  while (o < payload.length) {
    const t = rv(payload, o); if (!t) break; o = t.next
    const no = Math.floor(t.value / 8), wire = t.value % 8
    if (wire === 2) {
      const l = rv(payload, o); if (!l) break
      const val = payload.subarray(l.next, l.next + l.value); o = l.next + l.value
      if (no === 1) { const mt = rv(val, 0); if (mt && Math.floor(mt.value / 8) === 1) { const ml = rv(val, mt.next); if (ml) out.push(val.subarray(ml.next, ml.next + ml.value).toString('utf8')) } }
    } else if (wire === 0) { const v = rv(payload, o); if (!v) break; o = v.next }
    else if (wire === 5) o += 4
    else if (wire === 1) o += 8
    else break
  }
  return out
}

const result = await new Promise((resolve) => {
  const u = new URL(url)
  const r = { status: 0, hs: '', frames: 0, methods: [] }
  let done = false, hb, hsDone = false, buffer = Buffer.alloc(0)
  const finish = (why) => { if (done) return; done = true; if (hb) clearInterval(hb); try { socket.destroy() } catch {} resolve(r) }
  const socket = tls.connect({ host: u.hostname, port: 443, servername: u.hostname }, () => {
    socket.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://live.douyin.com\r\nUser-Agent: ${PUSH_UA}\r\nCookie: ${cookie}\r\n\r\n`)
  })
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    if (!hsDone) {
      const idx = buffer.indexOf('\r\n\r\n'); if (idx < 0) return
      const head = buffer.subarray(0, idx).toString('utf8')
      r.status = Number((head.split('\r\n')[0].match(/HTTP\/1\.1 (\d+)/) || [])[1] || 0)
      r.hs = (head.match(/Handshake-Msg:\s*(.+)/i) || [])[1]?.trim() || ''
      hsDone = r.status === 101
      buffer = buffer.subarray(idx + 4)
      if (!hsDone) return finish('handshake failed')
      socket.write(frameOut(2, hbFrame))
      hb = setInterval(() => socket.write(frameOut(2, hbFrame)), 5000)
    }
    while (buffer.length >= 2) {
      const b0 = buffer[0], b1 = buffer[1], op = b0 & 0x0f, masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f, off = 2
      if (len === 126) { len = buffer.readUInt16BE(2); off = 4 }
      else if (len === 127) { len = Number(buffer.readBigUInt64BE(2)); off = 10 }
      if (masked) off += 4
      if (buffer.length < off + len) break
      let payload = buffer.subarray(off, off + len)
      if (masked) { const m = buffer.subarray(off - 4, off); const o = Buffer.from(payload); for (let i = 0; i < o.length; i++) o[i] ^= m[i % 4]; payload = o }
      buffer = buffer.subarray(off + len)
      if (op === 8) return finish('server closed')
      if (op === 9) { socket.write(frameOut(0x0a, payload)); continue }
      if (op === 2) { r.frames++; try { r.methods.push(...methods(payload)) } catch {} }
    }
  })
  socket.on('error', (e) => finish('error: ' + e.message))
  setTimeout(() => finish('timeout'), seconds * 1000)
})

const uniq = [...new Set(result.methods)]
console.log(`\n结果：HTTP ${result.status}${result.hs ? ' / ' + result.hs : ''} / 收帧 ${result.frames}${result.frames ? '' : ''}`)
if (uniq.length) console.log(`消息类型(${uniq.length})：${uniq.slice(0, 25).join(', ')}`)
if (result.status === 101 && result.frames > 0) console.log('★ 通过：纯 Node 直连成功')
else { console.log('✗ 未通过'); process.exitCode = 1 }