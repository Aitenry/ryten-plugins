/**
 * 「隐藏身份」探针 · **批量版**（dev-only，不参与打包）：一次性并行嗅探几十个在播房间，
 * 定位抖音在推送帧里**怎么标记一个身份被藏起来的用户**。
 *
 * 背景（用户 2026-10-09）：
 * - 抖音有两种「藏身份」，我们之前只认了其中一种：
 *   1) **神秘人**：匿名送礼/点歌，帧里要么没有发送者 `User`，要么昵称是占位串（「匿名」）；
 *   2) **高等级用户匿名**（本次要补的）：昵称变成 `dou` + 数字这类马甲名，抖音号 / 关注 / 粉丝全空，
 *      档案里「用户 id」都像占位值（实测见过 `111111`）。
 * - 要「不看名字」地判出来，**必须**从协议层找判据：隐藏身份的用户在帧里到底缺了什么、
 *   `id` 是不是真的、`secUid`(46) 还在不在——这决定能不能拿它去 `main/douyin/mystery.ts` 查真实资料。
 *
 * ⚠️ 为什么是批量：高等级匿名只在**大房间、送礼时段**偶尔出现，单开一个房间守株待兔太慢。
 * 这里先收一批**人气最高**的在播房间，再**并行**轮询它们，撞到一个就 dump 出来（默认撞到即停）。
 * 房间收集与并行监控的思路照搬 `mystery-validate.mjs`（那脚本已验证可行）。
 *
 * 跑法（不需要 electron，也不需要应用在跑）：
 *   node plugins/douyin-link/spike/hidden-probe.mjs                 # 默认：收 24 个热门房，跑 600s
 *   node plugins/douyin-link/spike/hidden-probe.mjs 900 40          # 跑 900s，并行 40 个房
 *   node plugins/douyin-link/spike/hidden-probe.mjs --rooms=123,456 # 只嗅指定的房间
 *   node plugins/douyin-link/spike/hidden-probe.mjs --keep-going    # 撞到不退出，一直收到达时间上限
 *   node plugins/douyin-link/spike/hidden-probe.mjs --all           # 所有人的字段树都打（吵）
 *   node plugins/douyin-link/spike/hidden-probe.mjs --hex           # 原始帧 hex 不截断
 */

import { Buffer } from 'node:buffer'
import { asText, dumpTree, getBytes, getBytesAll, getVarint, parseWebRid, readMessage, varintString } from './pb.mjs'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const CHROME = { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }

/** 已知「User 在哪」的字段（与 `main/douyin/proto-messages.ts` 的 USER_FIELDS 同口径；认不全再用深扫兜底） */
const USER_FIELDS = {
  WebcastChatMessage: [2],
  WebcastEmojiChatMessage: [2],
  WebcastMemberMessage: [2],
  WebcastSocialMessage: [2],
  WebcastLikeMessage: [5, 2],
  WebcastGiftMessage: [7, 2]
}

/** 关注统计类消息照样要看（高等级匿名也常在这类榜单里露面）；礼物类单独标出来（泄漏口重点） */
const ALSO_SCAN = new Set([
  ...Object.keys(USER_FIELDS),
  'WebcastRoomRankMessage',
  'WebcastLinkerContributeMessage',
  'WebcastLinkmicOrderSingMessage'
])
/** 这一条算不算「礼物类」：追泄漏口时，只有这类帧被匿名用户触发才算命中 */
const isGiftLike = (method) => /Gift|OrderSing|Broadcast/i.test(method)
/** 要不要扫这条消息：白名单 + 任何名字里带 Gift/Rank/Contribute 的（怕漏了新方法名） */
const shouldScan = (method) =>
  ALSO_SCAN.has(method) || /Gift|OrderSing|Rank|Contribute|Broadcast/i.test(method)

/* ------------------------------------------------------------------ 参数 */

const args = process.argv.slice(2)
const dumpAll = args.includes('--all')
const fullHex = args.includes('--hex')
const keepGoing = args.includes('--keep-going')
const roomsArg = args.find((a) => a.startsWith('--rooms='))
const explicitRooms = roomsArg
  ? roomsArg
      .slice('--rooms='.length)
      .split(',')
      .map((s) => parseWebRid(s))
      .filter(Boolean)
  : []
const positionals = args.filter((a) => !a.startsWith('-'))
const seconds = Number(positionals[0] ?? 600)
const roomCount = Number(positionals[1] ?? 24)

/* -------------------------------------------------------------- 房间收集 */

/**
 * 收一批在播房间：feed 多打几轮（带 user_count，人多优先）+ 多个分类页 SSR 兜底。
 * `web_rid` 直接当 `room_id` 用来轮询（实测可行，同 `mystery-validate.mjs`）。
 */
async function collectRooms(limit) {
  const { cookie } = await homeCookie()
  const byId = new Map()
  for (let round = 0; round < 6; round += 1) {
    try {
      const res = await fetch(
        'https://live.douyin.com/webcast/feed/?aid=6383&app_name=douyin_web&device_platform=web&count=60',
        { headers: { ...CHROME, cookie } }
      )
      const feed = JSON.parse(await res.text())
      for (const entry of feed.data || []) {
        const room = entry.data
        if (!room || room.status !== 2 || !/^\d{6,}$/.test(String(room.id_str || ''))) continue
        const id = String(room.id_str)
        const count = Number(room.user_count || 0)
        const prev = byId.get(id)
        if (!prev || prev.count < count) {
          byId.set(id, { webRid: id, roomId: id, count, nick: String(room.owner?.nickname || '') })
        }
      }
    } catch {
      /* 这一轮拿不到就算了 */
    }
    await sleep(300)
  }
  for (const cat of ['1', '2', '3', '4', '102', '103']) {
    try {
      const res = await fetch(`https://live.douyin.com/category/${cat}`, { headers: CHROME })
      const clean = (await res.text()).replace(/\\"/g, '"')
      for (const m of clean.matchAll(/"web_rid":"(\d{6,})"/g)) {
        if (byId.has(m[1])) continue
        const win = clean.slice(m.index, m.index + 5000)
        const count = Number(win.match(/"display_value":(\d+)/)?.[1] ?? '0')
        const nick = win.match(/"title":"([^"]{0,24})"/)?.[1] ?? ''
        byId.set(m[1], { webRid: m[1], roomId: m[1], count, nick })
      }
    } catch {
      /* 跳过 */
    }
  }
  const ranked = [...byId.values()].sort((a, b) => b.count - a.count)
  return ranked.slice(0, limit)
}

/** 进房拿 cookie + 页面里的 roomId（显式指定房间时用） */
async function homeCookie() {
  const res = await fetch('https://live.douyin.com/', { headers: CHROME })
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((e) => e.split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
  return { cookie }
}

async function resolveRoom(webRid, cookie) {
  try {
    const res = await fetch(`https://live.douyin.com/${webRid}`, { headers: { ...CHROME, cookie } })
    const html = await res.text()
    const roomId = html.match(/\\?"roomId\\?"\s*:\s*\\?"(\d{6,})\\?"/)?.[1] ?? webRid
    const nick = html.match(/"owner"\s*:\s*\{[^}]*"nickname"\s*:\s*"([^"]{0,24})"/)?.[1] ?? ''
    return { webRid, roomId, count: 0, nick }
  } catch {
    return { webRid, roomId: webRid, count: 0, nick: '' }
  }
}

/* ------------------------------------------------------------------ 网络 */

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
    headers: { ...CHROME, cookie, referer: `https://live.douyin.com/${webRid}`, accept: 'application/x-protobuf, */*' }
  })
  if (!response.ok) return { error: `HTTP ${response.status}` }
  const raw = Buffer.from(await response.arrayBuffer())
  if (raw.length === 0) return { error: 'empty body' }
  if (raw[0] === 0x7b) return { error: 'json reply' }
  const root = readMessage(raw)
  const messages = []
  for (const payload of getBytesAll(root, 1)) {
    const message = readMessage(payload)
    const methodRaw = getBytes(message, 1)
    const body = getBytes(message, 2)
    if (methodRaw && body) messages.push({ method: methodRaw.toString('utf8'), body })
  }
  return {
    messages,
    cursor: getBytes(root, 2)?.toString('utf8') ?? '',
    internalExt: getBytes(root, 5)?.toString('utf8') ?? '',
    intervalMs: getVarint(root, 3)?.value ?? 0
  }
}

/* -------------------------------------------------------------- User 解析 */

/** 一个 User 的可读字段（字段号对齐 `main/douyin/proto-messages.ts` 的对照表） */
function readUser(bytes) {
  const msg = readMessage(bytes)
  const idRaw = getVarint(msg, 1)
  const id = idRaw ? varintString(idRaw.raw) : ''
  const shortIdRaw = getVarint(msg, 2)
  const follow = getBytes(msg, 22) ? readMessage(getBytes(msg, 22)) : null
  const avatarUrl = (() => {
    for (const no of [11, 10, 9]) {
      const image = getBytes(msg, no)
      if (!image) continue
      for (const list of readMessage(image).fields.values()) {
        for (const value of list) {
          const text = value.kind === 'bytes' ? asText(value.value) : null
          if (text?.startsWith('http')) return text
        }
      }
    }
    return ''
  })()
  return {
    id,
    shortId: shortIdRaw ? varintString(shortIdRaw.raw) : '',
    nickname: asText(getBytes(msg, 3) ?? Buffer.alloc(0)) ?? '',
    displayId: asText(getBytes(msg, 38) ?? Buffer.alloc(0)) ?? '',
    secUid: asText(getBytes(msg, 46) ?? Buffer.alloc(0)) ?? '',
    gender: getVarint(msg, 4)?.value ?? 0,
    avatarUrl,
    hasFollow: Boolean(follow),
    following: follow ? (getVarint(follow, 1)?.value ?? 0) : 0,
    follower: follow ? (getVarint(follow, 2)?.value ?? 0) : 0
  }
}

/** 一个字节段「像 User 吗」：有 varint 的字段 1（id），且字段 3 或 68 是可读昵称 */
function looksLikeUser(bytes) {
  if (!bytes || bytes.length < 4) return false
  let msg
  try {
    msg = readMessage(bytes)
  } catch {
    return false
  }
  if (!getVarint(msg, 1)) return false
  return Boolean(asText(getBytes(msg, 3) ?? Buffer.alloc(0)) || asText(getBytes(msg, 68) ?? Buffer.alloc(0)))
}

/** 从一条消息里掏出所有 User（先按已知字段，再在嵌套结构里深扫兜底——点歌/榜单里的 User 藏得深） */
function collectUsers(method, body) {
  const msg = readMessage(body)
  const found = []
  const seen = new Set()
  const add = (bytes, path) => {
    if (!bytes || seen.has(bytes.toString('hex'))) return
    if (!looksLikeUser(bytes)) return
    seen.add(bytes.toString('hex'))
    found.push({ bytes, path })
  }
  for (const field of USER_FIELDS[method] ?? []) add(getBytes(msg, field), `${method}.${field}`)
  const walk = (node, path, depth) => {
    if (depth > 4) return
    for (const [no, list] of node.fields.entries()) {
      for (const value of list) {
        if (value.kind !== 'bytes' || value.value.length < 4) continue
        const childPath = `${path}.${no}`
        add(value.value, childPath)
        try {
          walk(readMessage(value.value), childPath, depth + 1)
        } catch {
          /* 不是嵌套 message，跳过 */
        }
      }
    }
  }
  walk(msg, method, 0)
  return found
}

/**
 * 「这个人像是被藏了身份吗」——**判据来自协议字段，实测钉死的两条**：
 * - `id === '111111'`：抖音给匿名/隐藏身份用户发的**共用占位 id**（2026-10-09 批量抓帧实测，
 *   所有被掩码的用户都是这个值，几十条无一例外）；
 * - 昵称是 `首字 + ***` 这种掩码串（如 `燕***`）。
 * 另外「没有头像且没有抖音号」也算可疑（真用户至少有一个），用于兜新玩法。
 * 注意：`dou…` 这种名字只作为备注打印，**不参与判定**（用户要求别靠名字）。
 */
function isHidden(info) {
  if (!info.id || info.id === '0') return true
  if (info.id === '111111') return true
  if (/\*{2,}$/.test(info.nickname)) return true
  if (!info.avatarUrl && !info.displayId) return true
  return false
}

/**
 * 从**整条帧**里挖「可能的真实 id」——这是「神秘人」能还原的原因：点歌单号串 `发送者id_歌手id_…`
 * 里泄露了真实 id。这里把两类东西都捞出来：
 * - 单号串：`\d{4,}_\d+_\d+…`（点歌/礼物的 key）；
 * - 任何 ≥10 位的长数字串（真用户 id 是 15–19 位；排除占位 `111111`）。
 * 只要这些里出现了**不等于 111111 的长数字**，就说明匿名用户的真实身份在帧里漏了。
 */
function collectIdentifiers(body) {
  const orderKeys = new Set()
  const bigNumbers = new Set()
  const visit = (node, depth) => {
    if (depth > 4) return
    for (const list of node.fields.values()) {
      for (const value of list) {
        if (value.kind !== 'bytes') continue
        const text = asText(value.value)
        if (text) {
          for (const m of text.matchAll(/\d{4,}(?:_\d+){1,}/g)) orderKeys.add(m[0].slice(0, 90))
          for (const m of text.matchAll(/\d{10,}/g)) if (m[0] !== '111111') bigNumbers.add(m[0])
        } else if (value.value.length > 1) {
          try {
            visit(readMessage(value.value), depth + 1)
          } catch {
            /* 不是嵌套 message */
          }
        }
      }
    }
  }
  try {
    visit(readMessage(body), 0)
  } catch {
    /* ignore */
  }
  return { orderKeys: [...orderKeys], bigNumbers: [...bigNumbers] }
}

/* ------------------------------------------------------------------ 主流程 */

console.log(
  `# 隐藏身份探针（批量）· ${seconds}s · 并行房间 ${explicitRooms.length || roomCount}` +
    `${dumpAll ? ' · --all' : ''}${keepGoing ? ' · --keep-going' : ''}${fullHex ? ' · --hex' : ''}`
)
const { cookie } = await homeCookie()
const rooms =
  explicitRooms.length > 0
    ? await Promise.all(explicitRooms.map((id) => resolveRoom(id, cookie)))
    : await collectRooms(roomCount)
console.log(`# 收房间 ${rooms.length} 个。前 10：`, rooms.slice(0, 10).map((r) => `${r.nick || '?'}:${r.count}`).join('  '))
if (rooms.length === 0) {
  console.error('# 一个房间都没收到，换网络/稍后再试')
  process.exit(1)
}

/** 跨房间共享：名册（去重）、命中数、停止标志 */
const roster = new Map()
let dumps = 0
const hits = []
let stop = false
const started = Date.now()

const record = (info) => {
  const key = info.id || `昵称:${info.nickname}`
  const entry = roster.get(key) ?? { info, hidden: isHidden(info), count: 0, rooms: new Set() }
  entry.count += 1
  roster.set(key, entry)
  return entry
}

async function monitor(room) {
  let cursor = ''
  let internalExt = ''
  const deadline = Date.now() + seconds * 1000
  let backoff = 0
  while (!stop && Date.now() < deadline) {
    let result
    try {
      result = await poll(room.webRid, room.roomId, cookie, cursor, internalExt)
    } catch {
      await sleep(3000)
      continue
    }
    if (result.error) {
      backoff = result.error.includes('503') ? Math.min(backoff + 5000, 60000) : 3000
      await sleep(backoff)
      continue
    }
    backoff = 0
    cursor = result.cursor || cursor
    internalExt = result.internalExt || internalExt
    for (const { method, body } of result.messages) {
      if (!shouldScan(method)) continue
      const giftLike = isGiftLike(method)
      const found = collectUsers(method, body)
      /**
       * 帧里一个 `User` 都没有（神秘人那种「只剩单号串」）：礼物类直接看标识符，
       * 有没有泄露出来的真实 id。
       */
      if (found.length === 0) {
        if (!giftLike) continue
        const ids = collectIdentifiers(body)
        if (ids.orderKeys.length === 0 && ids.bigNumbers.length === 0) continue
        dumps += 1
        console.log(`\n===== 疑似泄漏口 #${dumps} · 房 ${room.webRid}（${room.nick || '?'}）· ${method}（帧内无 User）=====`)
        console.log(`单号串=${ids.orderKeys.join(' | ') || '(无)'}`)
        console.log(`长数字=${ids.bigNumbers.join(' ') || '(无)'}`)
        console.log('整条消息字段树：')
        dumpTree(body, 0, '', console.log, 4)
        console.log(`原始帧 hex=${fullHex ? body.toString('hex') : body.toString('hex').slice(0, 480)}`)
        continue
      }
      const ids = collectIdentifiers(body)
      for (const { bytes, path } of found) {
        const info = readUser(bytes)
        const entry = record(info)
        entry.rooms.add(room.webRid)
        const hidden = isHidden(info)
        if (hidden) hits.push({ info, method, webRid: room.webRid, leaked: ids.bigNumbers })
        // 非礼物类的匿名帧证据已经够了，不再逐条 dump；但占位 id=111111 的帧要看它带不带 secUid，
        // 只保留「匿名用户出现在礼物帧」为本次要找的泄漏口。
        if (!dumpAll && (!hidden || (!giftLike && info.id !== '111111'))) continue
        dumps += 1
        const note = /^dou\d+$/i.test(info.nickname) ? '（名字像平台生成的马甲）' : ''
        console.log(`\n===== 疑似隐藏身份 #${dumps} · 房 ${room.webRid}（${room.nick || '?'}）· ${method} @ ${path} ${note}=====`)
        console.log(
          `id=${info.id || '(空)'} shortId=${info.shortId || '-'} 昵称="${info.nickname}"` +
            ` 抖音号=${info.displayId || '-'} secUid=${info.secUid ? `${info.secUid.slice(0, 16)}…` : '(空)'}` +
            ` 头像=${info.avatarUrl ? '有' : '无'} 关注=${info.hasFollow ? `${info.following}/${info.follower}` : '(无)'}`
        )
        console.log(`本帧单号串=${ids.orderKeys.join(' | ') || '(无)'}`)
        console.log(`本帧长数字=${ids.bigNumbers.join(' ') || '(无)'}   ← 出现了不等于 111111 的长数字就是泄漏`)
        console.log('User 字段树：')
        dumpTree(bytes, 0, '', console.log, 4)
        console.log('整条消息字段树：')
        dumpTree(body, 0, '', console.log, 4)
        console.log(`原始帧 hex=${fullHex ? body.toString('hex') : body.toString('hex').slice(0, 480)}`)
        // 目标命中：匿名用户出现在**礼物类**帧里 → 撞到一个就够，收工（除非 --keep-going）
        if (hidden && giftLike && !keepGoing) stop = true
      }
    }
    await sleep(Math.max(1500, result.intervalMs || 2000))
  }
}

const ticker = setInterval(() => {
  console.log(
    `  … ${Math.round((Date.now() - started) / 1000)}s / 名册 ${roster.size} 人 · 命中 ${hits.length} · dump ${dumps}`
  )
}, 30000)

await Promise.all(rooms.map((r) => monitor(r).catch(() => undefined)))
clearInterval(ticker)
stop = true

console.log(`\n# 结束：名册 ${roster.size} 人、命中 ${hits.length}、dump ${dumps}`)
const rows = [...roster.values()].sort((a, b) => Number(b.hidden) - Number(a.hidden) || b.count - a.count)
if (rows.length > 0) {
  console.log('# id                 短id          昵称            抖音号       头像 secUid 关注  隐藏? 次数')
  for (const { info, hidden, count } of rows.slice(0, 60)) {
    console.log(
      `${(info.id || '(空)').padEnd(19)} ${(info.shortId || '-').padEnd(13)} ${(info.nickname || '').slice(0, 14).padEnd(15)}` +
        ` ${(info.displayId || '-').slice(0, 12).padEnd(12)} ${info.avatarUrl ? '有 ' : '无 '}` +
        ` ${info.secUid ? '有   ' : '无   '} ${info.hasFollow ? '有   ' : '无   '} ${hidden ? '★' : ' '}   ${count}`
    )
  }
  console.log('\n# 重点看「隐藏? ★」那几行：id 是不是占位、secUid 还在不在。')
  console.log('# secUid 还在而 id 是假的 → 还原改成按 secUid 查（main/douyin/mystery.ts 支持 sec_user_id）。')
} else {
  console.log('# 这次没抓到任何用户消息：房间可能冷清或都在被限流，换批房间、跑久一点')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}