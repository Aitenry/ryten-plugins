/**
 * 校验「神秘人还原」的关键假设（真房间、真弹幕流，**多分类页收房间 + 20+ 房间并行长跑监控**）：
 *
 *   假设1：资料接口不是「只对主播有效」→ 用**普通观众**的 id 测；
 *   假设2：匿名/神秘人帧里的 id 是**真实账号 id**，按它能查回真资料
 *         → 抓到匿名帧（昵称空 / 含「匿名」「神秘人」/ 礼物帧没有发送者 User）就立刻用它测。
 *
 * 匿名送礼通常来自想隐藏身份的大户 → 尽量挑**人多、送礼多**的房间：
 * 从多个分类页收 web_rid，按在线人数排序，取最多的 N 个并行监控（各自独立 cookie）。
 *
 * 跑法：node plugins/douyin-link/spike/mystery-validate.mjs [秒数=600] [房间数=24]
 */
import { Buffer } from 'node:buffer'
import { asText, getBytes, getBytesAll, getVarint, readMessage, varintString } from './pb.mjs'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const CHROME = { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }
const seconds = Number(process.argv[2] || 600)
const roomCount = Number(process.argv[3] || 24)
const ANON = /匿名|神秘人|anonymous/i
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 喂给 feed 的 cookie 就够轮询用；web_rid / room_id 都用房间的内部 id_str（实测可行） */

async function cookieOf(url) {
  const res = await fetch(url, { headers: CHROME })
  const cookie = (res.headers.getSetCookie?.() ?? []).map((e) => e.split(';')[0].trim()).filter(Boolean).join('; ')
  return { cookie, html: await res.text() }
}

function pollQuery(webRid, roomId, cursor, internalExt) {
  const q = new URLSearchParams({
    aid: '6383', app_name: 'douyin_web', live_id: '1', device_platform: 'web', language: 'zh-CN',
    enter_from: 'web_live', cookie_enabled: 'true', screen_width: '2560', screen_height: '1440',
    browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Chrome', browser_version: '126.0.0.0',
    web_rid: webRid, room_id: roomId, did_rule: '3', debug: 'false', endpoint: 'live_pc',
    support_wrds: '1', im_path: '/webcast/im/fetch/', resp_content_type: 'protobuf', fetch_rule: '1',
    last_rtt: '0', user_unique_id: '', timestamp: String(Date.now())
  })
  if (cursor) q.set('cursor', cursor)
  if (internalExt) q.set('internal_ext', internalExt)
  return q
}

async function poll(webRid, roomId, cookie, cursor, internalExt) {
  const res = await fetch(`https://live.douyin.com/webcast/im/fetch/?${pollQuery(webRid, roomId, cursor, internalExt)}`, {
    headers: { ...CHROME, cookie, referer: `https://live.douyin.com/${webRid}`, accept: 'application/x-protobuf, */*' }
  })
  if (!res.ok) return { error: `HTTP ${res.status}` }
  const raw = Buffer.from(await res.arrayBuffer())
  if (raw.length === 0) return { error: 'empty' }
  if (raw[0] === 0x7b) return { error: 'json' }
  const root = readMessage(raw)
  const messages = []
  for (const payload of getBytesAll(root, 1)) {
    const m = readMessage(payload)
    const method = getBytes(m, 1)?.toString('utf8')
    const body = getBytes(m, 2)
    if (method && body) messages.push({ method, body })
  }
  return {
    messages,
    cursor: getBytes(root, 2)?.toString('utf8') ?? '',
    internalExt: getBytes(root, 5)?.toString('utf8') ?? '',
    intervalMs: getVarint(root, 3)?.value ?? 0
  }
}

/** User → { id, nickname }（字段号：1 id / 3 昵称） */
function parseUser(buf) {
  if (!buf) return null
  const u = readMessage(buf)
  const idRaw = getVarint(u, 1)
  return { id: idRaw ? varintString(idRaw.raw) : '', nickname: asText(getBytes(u, 3)) ?? '' }
}

async function profileOf(id, cookie) {
  const r = await fetch(
    `https://www.douyin.com/aweme/v1/web/user/profile/other/?user_id=${id}&device_platform=webapp&aid=6383&channel=channel_pc_web&version_code=190500&publish_video_strategy_type=2`,
    { headers: { ...CHROME, cookie, referer: 'https://www.douyin.com/', accept: 'application/json,*/*' } }
  )
  const text = await r.text()
  try {
    const j = JSON.parse(text)
    return { sc: j.status_code, nick: j.user?.nickname, follower: j.user?.follower_count, hasAvatar: Boolean(j.user?.avatar_300x300?.url_list?.[0]) }
  } catch {
    return { sc: 'parse-fail', raw: text.slice(0, 100) }
  }
}

/* 1) 收房间：feed 多打几次（人气高、带 user_count；web_rid = 内部 id_str 实测可轮询）
 *    + 多个分类页 SSR 的房间（补数量）。都按 web_rid 去重，feed 的人数优先 */
const { cookie: feedCookie } = await cookieOf('https://live.douyin.com/')
const byId = new Map() // webRid -> { webRid, roomId, count, nick }
for (let round = 0; round < 6; round += 1) {
  try {
    const res = await fetch('https://live.douyin.com/webcast/feed/?aid=6383&app_name=douyin_web&device_platform=web&count=60', { headers: { ...CHROME, cookie: feedCookie } })
    const feed = JSON.parse(await res.text())
    for (const d of feed.data || []) {
      const r = d.data
      if (!r || r.status !== 2 || !/^\d{6,}$/.test(String(r.id_str || ''))) continue
      const id = String(r.id_str)
      const count = Number(r.user_count || 0)
      const prev = byId.get(id)
      if (!prev || prev.count < count) byId.set(id, { webRid: id, roomId: id, count, nick: String(r.owner?.nickname || '') })
    }
  } catch { /* 这一轮拿不到就算了 */ }
  await sleep(400)
}
for (const cat of ['1', '2', '3', '4', '102', '103']) {
  try {
    const { html } = await cookieOf(`https://live.douyin.com/category/${cat}`)
    const clean = html.replace(/\\"/g, '"')
    for (const m of clean.matchAll(/"web_rid":"(\d{6,})"/g)) {
      const win = clean.slice(m.index, m.index + 5000)
      const count = Number(win.match(/"display_value":(\d+)/)?.[1] ?? '0')
      const nick = win.match(/"title":"([^"]{0,24})"/)?.[1] ?? ''
      if (!byId.has(m[1])) byId.set(m[1], { webRid: m[1], roomId: m[1], count, nick })
    }
  } catch { /* 跳过 */ }
}
const ranked = [...byId.values()].sort((a, b) => b.count - a.count)
console.log(`共收 ${ranked.length} 个在播房间；取人气最高的 ${roomCount} 个`)
console.log('前 20：', ranked.slice(0, 20).map((r) => `${r.nick}:${r.count}`).join('  '))

/* 2) 组房间（web_rid = room_id，共用 feed cookie） */
const rooms = ranked.slice(0, roomCount).map((r) => ({ webRid: r.webRid, roomId: r.roomId, cookie: feedCookie, nick: r.nick, msgs: 0, gifts: 0 }))
console.log(`\n并行监控 ${rooms.length} 个房间，最多 ${seconds}s\n`)

const allUsers = new Map() // id -> { nickname, from, webRid }
const anonFrames = []
let captured = 0
let giftTotal = 0
let stop = false
const started = Date.now()

async function monitor(room) {
  let cursor = '', internalExt = ''
  const deadline = Date.now() + seconds * 1000
  while (!stop && Date.now() < deadline) {
    let r
    try {
      r = await poll(room.webRid, room.roomId, room.cookie, cursor, internalExt)
    } catch { await sleep(3000); continue }
    if (r.error) { await sleep(3000); continue }
    cursor = r.cursor || cursor
    internalExt = r.internalExt || internalExt
    room.msgs += r.messages.length
    for (const { method, body } of r.messages) {
      const m = readMessage(body)
      let user = null, kind = ''
      if (method === 'WebcastChatMessage') { user = parseUser(getBytes(m, 2)); kind = 'chat' }
      else if (method === 'WebcastMemberMessage') { user = parseUser(getBytes(m, 2)); kind = 'enter' }
      else if (method === 'WebcastGiftMessage') {
        room.gifts += 1
        giftTotal += 1
        user = parseUser(getBytes(m, 7))
        kind = 'gift'
        if (!user?.id) {
          // 匿名送礼时帧里可能**根本没有发送者 User**，只剩收礼人：这种最值得记录
          console.log(`  ☆ [${room.webRid}] 礼物帧没有发送者 User（疑似匿名）`)
          continue
        }
      }
      if (!user?.id) continue
      captured += 1
      if (!allUsers.has(user.id)) allUsers.set(user.id, { nickname: user.nickname, from: kind, webRid: room.webRid })
      if (!user.nickname || ANON.test(user.nickname)) {
        anonFrames.push({ id: user.id, nickname: user.nickname, kind, webRid: room.webRid })
        console.log(`  ★ [${room.webRid}] 疑似匿名帧：${kind} id=${user.id} 昵称=${JSON.stringify(user.nickname)}`)
        stop = true
      }
    }
    await sleep(Math.max(2000, Math.round((r.intervalMs || 2200) * 1.3)))
  }
}

/* 每 30s 打一次进度，长跑时能看见在动 */
const ticker = setInterval(() => {
  const alive = rooms.filter((room) => room.msgs > 0).length
  console.log(`  … ${Math.round((Date.now() - started) / 1000)}s / 活跃房间 ${alive}/${rooms.length} · 消息 ${captured} · 礼物 ${giftTotal} · 匿名 ${anonFrames.length}`)
}, 30000)

await Promise.all(rooms.map((room) => monitor(room)))
clearInterval(ticker)
stop = true

console.log(`\n合计 ${captured} 条带用户消息，去重 ${allUsers.size} 人，礼物帧 ${giftTotal} 个，疑似匿名 ${anonFrames.length} 个`)
const active = rooms.filter((r) => r.msgs > 0).sort((a, b) => b.gifts - a.gifts).slice(0, 10)
console.log('送礼最多的房间：', active.map((r) => `${r.webRid}(礼物${r.gifts}/消息${r.msgs})`).join('  ') || '（本次没有房间收到消息）')

/* 3) 独立 cookie 跑还原接口 */
const { cookie: testCookie } = await cookieOf('https://live.douyin.com/')

const picks = [...allUsers.entries()].slice(0, 10)
if (picks.length > 0) {
  console.log('\n--- 普通观众（非主播）还原测试 ---')
  let ok = 0
  for (const [id, info] of picks) {
    const p = await profileOf(id, testCookie)
    const good = p.sc === 0 && p.nick && !ANON.test(p.nick)
    if (good) ok += 1
    console.log(`  ${good ? '✓' : '✗'} id=${id} 本场昵称=${JSON.stringify(info.nickname)}(${info.from},房${info.webRid}) → ${JSON.stringify(p)}`)
  }
  console.log(`  非主播可查率：${ok}/${picks.length}`)
}

if (anonFrames.length > 0) {
  console.log('\n--- 匿名帧专用测试（关键！能不能还原神秘人）---')
  for (const a of anonFrames.slice(0, 10)) {
    const p = await profileOf(a.id, testCookie)
    const good = p.sc === 0 && p.nick && !ANON.test(p.nick)
    console.log(`  ${good ? '✓ 还原成功' : '✗ 没还原'} id=${a.id}（帧内昵称 ${JSON.stringify(a.nickname)}, ${a.kind}）→ ${JSON.stringify(p)}`)
  }
} else {
  console.log('\n本次窗口内没有撞到匿名帧；匿名那一半需要真有人匿名送礼时再验（脚本可继续长跑等）')
}
