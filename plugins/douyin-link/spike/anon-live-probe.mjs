/**
 * 真机监听：**在活跃房间里守匿名帧，逐字段看里面到底还有什么**（dev-only，不参与打包）。
 *
 * 用户 2026-10-12 的要求：「能不能去互联网搜索，或者自己去处理，监听抖音，帮我找到可以处理这个内容的东西」。
 *
 * 已经证死的三条（见 `main/douyin/anonymous-reveal.ts`）：占位 id 直查、马甲尾段枚举、昵称搜索。
 * 还剩**唯一没被证死**的一条：抖音的帧里除了 `id`/昵称，**会不会还带着别的身份字段**——
 * 只要某一类帧（礼物 / 进场 / 榜单 / 麦位同步）把 `sec_uid`、`short_id`（字段 2）或真实 id 留在里面，
 * 就能拿它直接调资料接口（`mystery.ts` 支持 `sec_user_id`），匿名身份当场就还原了。
 *
 * 这个探针只做这一件事，而且**只报告事实**：
 * 1. 用应用里那份登录态 cookie（设置文件 `plugin-state/douyin-link.json`）直连推送 ws；
 * 2. 每帧在**原始字节**里逐层找「像 User 的段」（有字段 1 的 varint），把这些段的每个字段读出来；
 * 3. 匿名段（`id == 111111`、或昵称像马甲名 / 占位名）一旦出现，就打印它的**全部字段**：
 *    `sec_uid` 在不在、`short_id`（字段 2）在不在、有没有**不等于 111111 的长数字**。
 *    只要看到长数字或 sec_uid，就是「能还原」的铁证，脚本会把原始 hex 落盘。
 *
 * 跑法：
 *   node plugins/douyin-link/spike/anon-live-probe.mjs                 # 默认 20 分钟 / 8 个房
 *   node plugins/douyin-link/spike/anon-live-probe.mjs 600 12          # 秒数 / 房间数
 *   node plugins/douyin-link/spike/anon-live-probe.mjs --rooms=123,456 # 只守指定房间
 *   node plugins/douyin-link/spike/anon-live-probe.mjs --cookie-file=<路径>
 *
 * ⚠️ 连的是抖音、用的是**你自己的登录态 cookie**（只读设置文件，不打印内容）。抓到的原始帧写到
 * `%TEMP%/anon-live-<时间>.jsonl`，里面有别人的昵称等公开信息——别外传。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { build } from 'esbuild'

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const seconds = Number(positional[0] ?? 1200)
const roomCount = Number(positional[1] ?? 8)
const roomsArg = args.find((a) => a.startsWith('--rooms='))?.slice('--rooms='.length)
const cookieFileArg = args.find((a) => a.startsWith('--cookie-file='))?.slice('--cookie-file='.length)
const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const ROOT = join(HERE, '../../../')
const PLUGIN = join(HERE, '..')

/* ------------------------------------------------------------------ 打包真解码器 */

const workDir = join(tmpdir(), `anon-live-${Date.now()}`)
const outfile = join(workDir, 'decoders.mjs')
await build({
  stdin: {
    contents: `
export { readPushFrame, encodeHeartbeat, encodeAck } from '${PLUGIN.replace(/\\/g, '/')}/main/douyin/push-frame.ts'
export * as pb from '${PLUGIN.replace(/\\/g, '/')}/main/douyin/protobuf.ts'
export { buildPushUrl, PUSH_UA } from '${PLUGIN.replace(/\\/g, '/')}/main/douyin/sign.ts'
`,
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
const { readPushFrame, encodeHeartbeat, encodeAck, pb, buildPushUrl, PUSH_UA } = await import(pathToFileURL(outfile).href)

/* ------------------------------------------------------------------------ cookie */

function readCookie() {
  if (cookieFileArg) return readFileSync(cookieFileArg, 'utf8').trim()
  const file = join(process.env.APPDATA ?? '', 'ryten-bench', 'plugin-state', 'douyin-link.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed.douyinCookie === 'string' ? parsed.douyinCookie : ''
  } catch {
    return ''
  }
}
const cookie = readCookie()
console.log(`# cookie：${cookie.length} 字符（ttwid=${cookie.includes('ttwid')}，sessionid=${cookie.includes('sessionid')}）`)
if (!cookie.includes('ttwid')) {
  console.error('没有 ttwid：先让应用拿到一份 cookie（打开插件监控一次）再跑')
  process.exit(2)
}

/* --------------------------------------------------------------------- 房间清单 */

/** 默认房间：真机实测出过匿名观众的那几个 + 需求里提到的房间 */
const DEFAULT_ROOMS = ['108011161837', '760604769280', '41498419462', '895805895016']
const rooms = (roomsArg ? roomsArg.split(',') : DEFAULT_ROOMS).filter(Boolean).slice(0, Math.max(1, roomCount))

/**
 * 页面里的**内部 roomId**（ws 签名要它，不是 webRid）。
 *
 * 与 `main/douyin/room.ts` 的 `enter` 同源：抓一次直播间 HTML，从内嵌 JSON 里取 `roomId`。
 * 取不到就跳过这个房间（ws 连不上没意义）。
 */
async function resolveRoomId(webRid) {
  const response = await fetch(`https://live.douyin.com/${webRid}`, {
    headers: { 'user-agent': PUSH_UA, cookie, referer: 'https://live.douyin.com/' }
  })
  const html = await response.text()
  const roomId =
    html.match(/\\?"roomId\\?"\s*:\s*\\?"(\d{6,})\\?"/)?.[1] ??
    html.match(/room_id["'\\:=\s]{1,6}(\d{10,})/)?.[1] ??
    ''
  const nickname = html.match(/"owner"\s*:\s*\{[^}]*"nickname"\s*:\s*"([^"]{0,24})"/)?.[1] ?? ''
  return { roomId, nickname, live: html.includes('"status":2') || html.includes('"status": 2') }
}

/* ------------------------------------------------------------------ frame 解析 */

const MASK_NAME = /^dou\d{5,}$/i
const ANON_NAME = /匿名|神秘人|anonymous/i
const isMaskedName = (name) => MASK_NAME.test(String(name ?? '').trim())
const isAnonName = (name) => {
  const text = String(name ?? '').replace(/\s+/g, '')
  return text === '' || ANON_NAME.test(text)
}

/** 一段 bytes：像 User 吗（有字段 1 的 varint，且字段 3/68 可读） */
function looksLikeUser(buf) {
  if (!buf || buf.length < 4) return null
  let msg
  try {
    msg = pb.readMessage(buf)
  } catch {
    return null
  }
  const id = pb.getVarint(msg, 1)
  if (!id) return null
  const nickname = pb.getString(msg, 3, 60) ?? pb.getString(msg, 68, 60) ?? ''
  return nickname ? { msg, id: String(id), nickname } : null
}

/** 一个 User 段的**全部字段**（这就是要找的东西：里面还有没有别的身份字段） */
function dumpUserFields(msg) {
  const out = []
  for (const [no, list] of msg.fields) {
    for (const value of list) {
      if (value.kind === 'varint') out.push({ no, kind: 'varint', value: String(value.value) })
      else if (value.kind === 'bytes') {
        const text = value.value.toString('utf8')
        const printable = /^[\x20-\x7e\u4e00-\u9fa5]{1,120}$/.test(text)
        out.push({
          no,
          kind: 'bytes',
          length: value.value.length,
          ...(printable ? { text } : {}),
          hex: value.value.subarray(0, 24).toString('hex')
        })
      } else out.push({ no, kind: value.kind })
    }
  }
  return out.sort((a, b) => a.no - b.no)
}

/** 在整帧里递归找「像 User 的段」（最多下钻 4 层，够覆盖 payload 里的嵌套） */
function findUserSegments(buf, depth = 0, out = []) {
  if (depth > 4 || !buf || buf.length < 4) return out
  const direct = looksLikeUser(buf)
  if (direct) {
    out.push(direct)
    return out
  }
  let msg
  try {
    msg = pb.readMessage(buf)
  } catch {
    return out
  }
  for (const list of msg.fields.values()) {
    for (const value of list) {
      if (value.kind === 'bytes' && value.value.length >= 4) findUserSegments(value.value, depth + 1, out)
    }
  }
  return out
}

const LONG_NUMBER = /\d{9,}/
const logFile = join(tmpdir(), `anon-live-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
let frames = 0
let userSegments = 0
let anonSegments = 0
let leaks = 0
const seen = new Set()

function noteSegment(webRid, method, seg, rawHex) {
  userSegments += 1
  const masked = seg.id === '111111'
  const anonName = isAnonName(seg.nickname)
  if (!masked && !isMaskedName(seg.nickname) && !anonName) return null
  anonSegments += 1
  const fields = dumpUserFields(seg.msg)
  const key = `${seg.id}|${seg.nickname}|${JSON.stringify(fields)}`
  if (seen.has(key)) return null
  seen.add(key)

  /**
   * 泄漏判定：**字段 73（`sec_uid`，真机实测就在这儿）**、字段 46（老帧的 secUid）、
   * 或任何**不等于 111111 的长数字**。
   */
  const secUid46 = fields.find((f) => f.no === 46 && typeof f.text === 'string' && f.text)?.text ?? ''
  const secUid73 = fields.find((f) => f.no === 73 && typeof f.text === 'string' && f.text)?.text ?? ''
  const secUid = secUid46 || secUid73
  const longNumbers = fields
    .filter((f) => f.kind === 'varint' && LONG_NUMBER.test(f.value) && f.value !== '111111')
    .map((f) => `字段${f.no}=${f.value}`)
  const leaked = secUid.length > 0 || longNumbers.length > 0
  if (leaked) leaks += 1

  const line = {
    at: new Date().toISOString(),
    webRid,
    method,
    id: seg.id,
    nickname: seg.nickname,
    secUid: secUid ? `${secUid.slice(0, 24)}…` : '',
    secUidField: secUid46 ? 46 : secUid73 ? 73 : 0,
    longNumbers,
    fields
  }
  appendFileSync(logFile, `${JSON.stringify(line)}\n`)
  console.log(
    `${leaked ? '★★ 泄漏' : '  匿名'} [${webRid}] ${method} id=${seg.id} 昵称=${seg.nickname || '(空)'} ` +
      `sec_uid=${secUid ? `有(字段 ${line.secUidField})` : '无'} 其他长数字=${longNumbers.join(',') || '无'}`
  )
  if (leaked) {
    console.log(`      字段全貌：${JSON.stringify(fields)}`)
    /** `--resolve`：抓到 sec_uid 就当场拿去查资料，验「能不能还原成真人」 */
    if (resolve && secUid) void resolveSecUid(webRid, seg.nickname, secUid)
  }
  return leaked
}

/* ------------------------------------------------------- 用 sec_uid 查真实资料 */

const resolve = args.includes('--resolve')
let resolved = 0
const resolving = new Set()

async function resolveSecUid(webRid, maskName, secUid) {
  const key = secUid.slice(0, 30)
  if (resolving.has(key)) return
  resolving.add(key)
  const query = new URLSearchParams({
    sec_user_id: secUid,
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    version_code: '190500'
  })
  try {
    const response = await fetch(`https://www.douyin.com/aweme/v1/web/user/profile/other/?${query}`, {
      headers: { 'user-agent': PUSH_UA, cookie, referer: 'https://www.douyin.com/', accept: 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(12000)
    })
    const text = await response.text()
    if (!text) {
      console.log(`      ↳ sec_uid 解析：HTTP ${response.status} 空 body`)
      return
    }
    const json = JSON.parse(text)
    const user = json.user
    if (!user?.nickname) {
      console.log(`      ↳ sec_uid 解析：status=${json.status_code} 没有 user`)
      return
    }
    resolved += 1
    console.log(
      `      ↳ ★★ 还原成功！马甲 ${maskName} → uid=${user.uid ?? user.user_id} 真昵称=${user.nickname} ` +
        `抖音号=${user.unique_id ?? '-'} 粉丝=${user.follower_count} 关注=${user.following_count}`
    )
    appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), webRid, resolvedFrom: maskName, uid: String(user.uid ?? user.user_id ?? ''), nickname: user.nickname, uniqueId: user.unique_id ?? '', follower: user.follower_count, following: user.following_count })}\n`)
  } catch (error) {
    console.log(`      ↳ sec_uid 解析失败：${String(error?.message ?? error).slice(0, 80)}`)
  }
}

/* --------------------------------------------------------------------- 连接 */

let stop = false
process.on('SIGINT', () => {
  stop = true
})

async function watchRoom(webRid, roomId) {
  const url = buildPushUrl(roomId)
  const ws = new WebSocket(url, {
    headers: { Origin: 'https://live.douyin.com', 'User-Agent': PUSH_UA, Cookie: cookie }
  })
  /** 二进制帧：Node 的 WebSocket 默认给 Blob，明确要 ArrayBuffer */
  ws.binaryType = 'arraybuffer'
  const state = { webRid, frames: 0, msgs: 0 }
  /** 协议要求：每 5s 一条应用层心跳，收到要 ack 的帧要回 ack（不回服务端就不推了） */
  const beat = () => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(encodeHeartbeat())
      } catch {
        /* 断了会走 close */
      }
    }
  }
  ws.addEventListener('open', () => {
    console.log(`  连接成功 ${webRid}（roomId=${roomId}）`)
    beat()
    state.timer = setInterval(beat, 5000)
  })
  ws.addEventListener('error', (event) => console.log(`  连接出错 ${webRid}：${event?.message ?? ''}`))
  ws.addEventListener('close', () => {
    clearInterval(state.timer)
    console.log(`  断开 ${webRid}`)
  })
  ws.addEventListener('message', (event) => {
    const data = event.data
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    state.frames += 1
    frames += 1
    let frame
    try {
      frame = readPushFrame(buf)
    } catch {
      return
    }
    if (!frame?.payload || frame.payload.length === 0) return
    let body = frame.payload
    if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
      try {
        body = gunzipSync(body)
      } catch {
        return
      }
    }
    let root
    try {
      root = pb.readMessage(body)
    } catch {
      return
    }
    /** 服务端要求应答：回一条 ack（带上这一帧的 logId 与 internalExt） */
    const needAck = (pb.getVarint(root, 9) ?? 0) === 1
    if (needAck && ws.readyState === ws.OPEN) {
      try {
        ws.send(encodeAck(frame.logIdRaw, pb.getString(root, 5, 500) ?? ''))
      } catch {
        /* 断线由 close 处理 */
      }
    }
    for (const list of root.fields.values()) {
      for (const value of list) {
        if (value.kind !== 'bytes') continue
        let message
        try {
          message = pb.readMessage(value.value)
        } catch {
          continue
        }
        const method = pb.getString(message, 1, 64)
        const payload = pb.getBytes(message, 2)
        if (!method || !payload) continue
        state.msgs += 1
        /**
         * 只在**礼物/进场/关注/点赞/榜单/麦位**这类带 User 的帧里找；
         * 弹幕帧也看（匿名发言就是靠它露的马甲名）。
         */
        for (const seg of findUserSegments(payload)) noteSegment(webRid, method, seg, payload.toString('hex').slice(0, 200))
      }
    }
  })
  return ws
}

/* --------------------------------------------------------------------- 主循环 */

console.log(`\n守着 ${rooms.length} 个房间：${rooms.join(', ')}`)
console.log(`时长上限 ${seconds}s；原始证据写到 ${logFile}\n`)
const sockets = []
for (const webRid of rooms) {
  try {
    const room = await resolveRoomId(webRid)
    if (!room.roomId) {
      console.log(`  跳过 ${webRid}：页面上取不到内部 roomId（没开播 / 页面改了结构）`)
      continue
    }
    console.log(`  ${webRid} → roomId=${room.roomId} 主播=${room.nickname || '(未知)'}`)
    sockets.push(await watchRoom(webRid, room.roomId))
  } catch (error) {
    console.log(`  跳过 ${webRid}：${String(error?.message ?? error).slice(0, 80)}`)
  }
}
if (sockets.length === 0) {
  console.error('一个房间都没连上（都下播了？），下次换 --rooms= 指定正在播的房间')
  process.exit(2)
}

const startedAt = Date.now()
while (!stop && Date.now() - startedAt < seconds * 1000) {
  await new Promise((resolve) => setTimeout(resolve, 15000))
  const left = Math.round((seconds * 1000 - (Date.now() - startedAt)) / 1000)
  console.log(
    `…已跑 ${Math.round((Date.now() - startedAt) / 1000)}s（剩 ${left}s）` +
      `帧 ${frames} · 带 User 的段 ${userSegments} · 匿名段 ${anonSegments} · 泄漏 ${leaks}`
  )
}

for (const ws of sockets) {
  try {
    ws.close()
  } catch {
    /* 已经断了 */
  }
}

console.log(
  `\n=== 小结 ===\n帧 ${frames} · 带 User 的段 ${userSegments} · 匿名段 ${anonSegments} · **泄漏 ${leaks}**\n` +
    (leaks > 0
      ? `看到泄漏了：证据在 ${logFile}（把 字段全貌 那几行贴给我，我来接还原链路）`
      : `这次没抓到泄漏：匿名帧里依然只有占位 id + 马甲名（原始明细在 ${logFile}）`)
)
process.exit(0)
