import * as zlib from 'node:zlib'
import type { DanmakuItem, DanmakuKind, UserInfo } from '../../shared/types'
import type { GiftResolver } from '../gift/catalog'
import {
  getMessage,
  getMessages,
  getVarint,
  getVarintString,
  readMessage,
  type PbMessage
} from './protobuf'

/**
 * `im/fetch` 的 JSON 推送 → 界面/库要用的数据结构（**纯函数**，不碰 electron / 网络，方便单测与探针）。
 *
 * 为什么这条路取代了「隐藏窗口 + CDP 截帧 + protobuf」：
 * `POST/GET https://live.douyin.com/webcast/im/fetch/` **不需要 signature**（2026-10 实测：
 * 只带一份 ttwid Cookie 就能拿到 `{data:[…], extra:{cursor, fetch_interval}, internal_ext}`），
 * 而 ws（`/webcast/im/push/v2/`）即使带同样的 Cookie 也会被 200 空响应挡回来。
 * 所以主进程自己就能收全量推送，不必借直播间页面那份混淆签名——也就没有隐藏窗口了。
 *
 * 两条纪律（这一层最容易出错的地方）：
 * 1. **int64 不能走 Number**：JSON 里的 `room_id` / 用户 id 是 19 位整数，`JSON.parse` 会把
 *    7694110896603613978 抹成 …614000（两个不同的人会撞成同一个）。所以先用 `parseJsonLoose`
 *    把「16 位以上的整数字面量」改写成字符串再 parse（见 `parseJsonLoose`），取值时优先用
 *    接口同时给的 `*_str` 字段。
 * 2. **字段名要容错**：抖音这份 JSON 混用 snake_case（`room_id` / `content` / `follow_info`）
 *    与 camelCase（`syncKey` / `bizLogID`），且不同消息各自为政。所以每个取值都给一组候选键，
 *    数字/字符串两种写法都认——宁可某个字段取不到（回退到空），也不要因为认错键而整条消息丢掉。
 */

let nextId = 1

/* ------------------------------------------------------------ JSON 解析 */

/**
 * 把 16 位以上的整数**字面量**加引号后再 `JSON.parse`，避免 int64 精度丢失。
 *
 * 只动「字符串字面量之外」的数字：逐字符扫描，遇到 `"` 就整段复制（含转义），
 * 否则把连续的数字（含负号）读出来，位数够长就加引号、否则原样输出。
 * 结果里这些值变成字符串，取值侧（`pickId` / `pickInt`）本来就同时认数字与字符串。
 */
export function parseJsonLoose<T = unknown>(text: string): T {
  let out = ''
  let i = 0
  const size = text.length
  while (i < size) {
    const ch = text[i]
    if (ch === '"') {
      out += ch
      i += 1
      while (i < size) {
        const inner = text[i]
        out += inner
        i += 1
        if (inner === '\\') {
          if (i < size) {
            out += text[i]
            i += 1
          }
          continue
        }
        if (inner === '"') break
      }
      continue
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let cursor = i
      if (text[cursor] === '-') cursor += 1
      const digitsStart = cursor
      while (cursor < size && text[cursor] >= '0' && text[cursor] <= '9') cursor += 1
      const digits = cursor - digitsStart
      let isFloat = false
      while (cursor < size && (text[cursor] === '.' || text[cursor] === 'e' || text[cursor] === 'E' || (isFloat && (text[cursor] === '+' || text[cursor] === '-')))) {
        isFloat = true
        cursor += 1
        while (cursor < size && text[cursor] >= '0' && text[cursor] <= '9') cursor += 1
      }
      const literal = text.slice(i, cursor)
      out += !isFloat && digits >= 16 ? `"${literal}"` : literal
      i = cursor
      continue
    }
    out += ch
    i += 1
  }
  return JSON.parse(out) as T
}

type Json = Record<string, unknown>

const asObject = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

function pickRaw(obj: Json | undefined, keys: string[]): unknown {
  if (!obj) return undefined
  for (const key of keys) {
    const value = obj[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/** 取短文本（数字会被转成串，超长截断） */
function pickText(obj: Json | undefined, keys: string[], maxLength = 120): string {
  const value = pickRaw(obj, keys)
  if (typeof value === 'string') return value.slice(0, maxLength)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 取整数（字符串形式也认；取不到回 fallback） */
function pickInt(obj: Json | undefined, keys: string[], fallback = 0): number {
  const value = pickRaw(obj, keys)
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
  }
  return fallback
}

/**
 * 取 int64 标识的**精确十进制串**。优先 `*_str` 字段（接口对 id 一般同时给两份），
 * 退化时用被 `parseJsonLoose` 转成字符串的那份（数字形式的 19 位 id 已经不可信）。
 */
function pickId(obj: Json | undefined, keys: string[], strKeys: string[] = []): string {
  const text = pickText(obj, strKeys, 32)
  if (text) return text
  const value = pickRaw(obj, keys)
  if (typeof value === 'string' && value) return value.slice(0, 32)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 图片对象（`{url_list:[…]}`）或裸字符串 → https 地址 */
function pickImageUrl(value: unknown): string {
  if (typeof value === 'string') return value
  const obj = asObject(value)
  if (!obj) return ''
  const list = asArray(pickRaw(obj, ['url_list', 'urlList']))
  const urls = list.filter((item): item is string => typeof item === 'string' && item.length > 0)
  const https = urls.find((url) => url.startsWith('https://'))
  if (https) return https
  if (urls.length > 0) return urls[0]
  return pickText(obj, ['url', 'uri'], 300)
}

/* ------------------------------------------------------------- 用户解析 */

/**
 * `User`（JSON）→ 静态信息。字段名 relentlessly 容错：
 * 真机 enter 接口给的是 `id_str` / `nickname` / `avatar_thumb.url_list` / `follow_info`，
 * 推送里的 User 字段更全（`pay_grade` / `fans_club` / `badge_image_list`），两份都要认。
 */
export function parseUserJson(raw: unknown): UserInfo | null {
  const user = asObject(raw)
  if (!user) return null
  const id = pickId(user, ['id'], ['id_str', 'idStr'])
  if (!id) return null
  const shortId = pickId(user, ['short_id', 'shortId'], ['short_id_str', 'shortIdStr'])
  const follow = asObject(pickRaw(user, ['follow_info', 'followInfo']))
  const payGrade = asObject(pickRaw(user, ['pay_grade', 'payGrade']))
  const fansClub = asObject(pickRaw(user, ['fans_club', 'fansClub']))
  const fansClubData = fansClub ? asObject(pickRaw(fansClub, ['data'])) : undefined

  let honorLevel = pickInt(user, ['honor_level', 'honorLevel'])
  if (honorLevel === 0 && payGrade) honorLevel = pickInt(payGrade, ['level', 'deposit_level', 'depositLevel'])
  let fansClubLevel = pickInt(user, ['fans_club_level', 'fansClubLevel'])
  if (fansClubLevel === 0 && fansClubData) fansClubLevel = pickInt(fansClubData, ['level'])
  else if (fansClubLevel === 0 && fansClub) fansClubLevel = pickInt(fansClub, ['level'])

  const badges: string[] = []
  for (const badge of asArray(pickRaw(user, ['badge_image_list', 'badgeImageList', 'badges']))) {
    const entry = asObject(badge)
    if (!entry) continue
    const type = pickInt(entry, ['type'])
    const level = badgeLevel(entry)
    const text = badgeText(entry)
    if (type === 1 && level > 0 && honorLevel === 0) honorLevel = level
    if (type === 7 && level > 0 && fansClubLevel === 0) fansClubLevel = level
    if (text && !badges.includes(text)) badges.push(text.slice(0, 40))
  }

  let avatar = ''
  for (const key of ['avatar_large', 'avatar_medium', 'avatar_thumb', 'avatar_168x168', 'avatar_300x300', 'avatar']) {
    avatar = pickImageUrl(pickRaw(user, [key]))
    if (avatar) break
  }

  return {
    id,
    displayId: pickText(user, ['display_id', 'displayId'], 40) || shortId,
    nickname: pickText(user, ['nickname'], 60),
    gender: pickInt(user, ['gender']),
    signature: pickText(user, ['signature'], 200),
    city: pickText(user, ['city', 'ip_location', 'location'], 40),
    avatar,
    following: follow ? pickInt(follow, ['following_count', 'followingCount']) : 0,
    follower: follow ? pickInt(follow, ['follower_count', 'followerCount']) : 0,
    honorLevel,
    fansClubLevel,
    badges: badges.slice(0, 4),
    secUid: pickText(user, ['sec_uid', 'secUid'], 200)
  }
}

/** 勋章里的等级（字段名有两三层候选） */
function badgeLevel(badge: Json): number {
  const direct = pickInt(badge, ['level'])
  if (direct > 0) return direct
  for (const key of ['content', 'display', 'detail']) {
    const nested = asObject(pickRaw(badge, [key]))
    if (!nested) continue
    const level = pickInt(nested, ['level'])
    if (level > 0) return level
  }
  return 0
}

/** 勋章里的描述文案（如「荣誉等级31级勋章」） */
function badgeText(badge: Json): string {
  const direct = pickText(badge, ['text', 'display_text', 'displayText', 'describe', 'description', 'name'], 40)
  if (direct) return direct
  for (const key of ['content', 'display', 'detail']) {
    const nested = asObject(pickRaw(badge, [key]))
    if (!nested) continue
    const text = pickText(nested, ['text', 'display_text', 'displayText', 'describe', 'description', 'name'], 40)
    if (text) return text
  }
  return ''
}

/* ------------------------------------------------------------- 消息解析 */

export interface JsonDecodedBatch {
  items: DanmakuItem[]
  /** 这批里出现的用户静态信息（按 id 去重） */
  users: UserInfo[]
  /** 主播下播等控制信号 */
  roomEnded: boolean
  /**
   * 在麦上的用户 id（**按麦位顺序**）；`null` = 这一批没有说话（不要用它覆盖已知麦位）。
   * 来自 `RoomLinkmicMicDisplayInfoSyncData`（语音聊天室的麦位表）。
   */
  micUserIds: string[] | null
  /**
   * 这一批里各 method 的条数（诊断用：接口到底推了哪些消息）。
   * 界面「实时」页空白时，靠它区分「房间安静」与「接口只回了房间级消息」。
   */
  methods: Record<string, number>
}

/** 一批 `im/fetch` 的 `data` 数组 → 界面要显示的东西（永不抛错） */
export function decodePushBatch(rawMessages: unknown[], gifts?: GiftResolver): JsonDecodedBatch {
  const items: DanmakuItem[] = []
  const users = new Map<string, UserInfo>()
  const methods: Record<string, number> = {}
  let roomEnded = false
  let micUserIds: string[] | null = null
  for (const raw of rawMessages) {
    const message = asObject(raw)
    if (!message) continue
    const common = asObject(pickRaw(message, ['common']))
    const method = pickText(common ?? message, ['method'], 64)
    if (!method) continue
    methods[method] = (methods[method] ?? 0) + 1
    try {
      const decoded = decodeMessageJson(method, message, gifts)
      if (!decoded) continue
      for (const user of decoded.users) if (user.id) users.set(user.id, user)
      if (decoded.roomEnded) roomEnded = true
      if (decoded.micUserIds) micUserIds = decoded.micUserIds
      if (decoded.item) items.push(decoded.item)
    } catch {
      // 单条消息解不动不该影响这一批的其它消息
    }
  }
  return { items, users: [...users.values()], roomEnded, micUserIds, methods }
}

interface JsonDecoded {
  item: DanmakuItem | null
  users: UserInfo[]
  roomEnded: boolean
  micUserIds: string[] | null
}

const nothing = (): JsonDecoded => ({ item: null, users: [], roomEnded: false, micUserIds: null })

/** 单条消息 → 一行 + 里面的用户；不认识的 method 返回 null */
export function decodeMessageJson(method: string, message: Json, gifts?: GiftResolver): JsonDecoded | null {
  // 推送里的 method 是 `WebcastChatMessage` 这种全名；SDK 内部用的是去前缀的短名。两者都认
  const name = method.startsWith('Webcast') ? method.slice(7) : method
  const user = parseUserJson(pickRaw(message, ['user']))
  const nickname = user?.nickname ?? ''
  const userId = user?.id ?? ''

  switch (name) {
    case 'ChatMessage':
    case 'EmojiChatMessage': {
      const text = pickText(message, ['content', 'emoji_content', 'display_content'], 200)
      if (!text && !nickname) return null
      return { ...nothing(), item: item('chat', nickname, userId, text, 0), users: user ? [user] : [] }
    }
    case 'MemberMessage': {
      const count = pickInt(message, ['member_count', 'memberCount'])
      return {
        ...nothing(),
        item: item('member', nickname, userId, '', count),
        users: user ? [user] : []
      }
    }
    case 'LikeMessage': {
      const count = pickInt(message, ['count', 'like_count', 'likeCount'])
      return { ...nothing(), item: item('like', nickname, userId, '', count), users: user ? [user] : [] }
    }
    case 'SocialMessage':
      return { ...nothing(), item: item('social', nickname, userId, '', 0), users: user ? [user] : [] }
    case 'GiftMessage': {
      /**
       * 礼物（JSON 这条路只在服务端忽略 `resp_content_type=protobuf` 时才会用到）。
       *
       * 字段名与 protobuf 一一对应：`gift.name` / `gift.describe` / `gift.diamond_count`、
       * `repeat_count`、`combo_count`、`to_user`（收礼人）。价格取不到就是 0 = **未知**（不编数）。
       */
      const gift = asObject(pickRaw(message, ['gift']))
      const frameName = pickText(gift, ['name'], 40) || pickText(gift, ['describe'], 40)
      const frameUnit = pickInt(gift, ['diamond_count', 'diamondCount'])
      const giftId = pickInt(gift, ['id']) || pickInt(message, ['gift_id', 'giftId'])
      let hit = giftId > 0 ? gifts?.resolve(giftId) : undefined
      // 与 protobuf 那条路同一套兜底：帧里出现了目录里的礼物名就直接认它
      if (!frameName && !hit) hit = matchGiftNameInJson(message, gifts)
      if (giftId > 0 && frameUnit > 0) gifts?.noteFramePrice?.(giftId, frameUnit)
      const name = frameName || hit?.name || ''
      const unit = frameUnit || hit?.diamonds || 0
      const repeat = Math.max(1, pickInt(message, ['repeat_count', 'repeatCount'], 1))
      const toUser = parseUserJson(pickRaw(message, ['to_user', 'toUser']))
      if (!name && !nickname) return null
      const base = item('gift', nickname, userId, name, repeat, unit * repeat)
      return {
        ...nothing(),
        item: { ...base, toUser: toUser?.nickname ?? '', toUserId: toUser?.id ?? '' },
        users: [...(user ? [user] : []), ...(toUser ? [toUser] : [])]
      }
    }
    case 'RoomUserSeqMessage': {
      // 在线人数 + 观众榜（榜单里每条都带完整用户信息，是「在线观众」的来源之一）
      const total = pickInt(message, ['total', 'total_user', 'totalUser'])
      const text =
        pickText(message, ['total_user_str', 'totalUserStr'], 24) ||
        pickText(message, ['total_str', 'totalStr'], 24) ||
        (total > 0 ? String(total) : '')
      const ranked: UserInfo[] = []
      for (const entry of asArray(pickRaw(message, ['ranks', 'rank_list', 'rankList']))) {
        const parsed = parseUserJson(pickRaw(asObject(entry), ['user']))
        if (parsed) ranked.push(parsed)
      }
      return { ...nothing(), item: item('stats', '', '', text, total), users: ranked }
    }
    case 'ControlMessage': {
      const status = pickInt(message, ['status', 'action'])
      const flag = pickText(message, ['status_str', 'action_str'], 16)
      const ended = status === 3 || flag === 'FINISH' || flag === 'FINISH_BY_ADMIN'
      return { ...nothing(), roomEnded: ended, item: item('control', '', '', ended ? 'ended' : 'changed', status) }
    }
    case 'RoomMessage':
      return { ...nothing(), item: item('system', '', '', pickText(message, ['content'], 200), 0) }
    case 'RoomDataSyncMessage':
      return decodeDataSync(message)
    default:
      return null
  }
}

/**
 * 房间数据同步：**语音聊天室的麦位表**就藏在这里。
 *
 * `syncKey = RoomLinkmicMicDisplayInfoSyncData` 的 `payload` 是 base64 的 protobuf：
 * 三层 `field 2` 包着「重复的麦位条目」，每条 `field 1` 是用户 id（int64，从原始字节用
 * BigInt 还原，`Number` 到这个量级会丢低位）。顺序按麦位序，界面从上到下就是麦上顺序。
 */
function decodeDataSync(message: Json): JsonDecoded {
  const syncKey = pickText(message, ['syncKey', 'sync_key'], 64)
  if (!syncKey) return { ...nothing() }
  const out = nothing()
  if (!/MicDisplayInfo/i.test(syncKey)) return out
  const payload = pickText(message, ['payload'], 100000)
  if (!payload) return out
  try {
    const root = readMessage(decompress(Buffer.from(payload, 'base64')))
    out.micUserIds = collectMicUserIds(root)
  } catch {
    return out
  }
  return out
}

/** payload 有时会被 gzip 一道（ws 帧里是常态，JSON 里偶尔也有） */
function decompress(buf: Buffer): Buffer {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return zlib.gunzipSync(buf)
    } catch {
      return buf
    }
  }
  return buf
}

/**
 * 从麦位同步结构里收集用户 id：逐层下钻 `field 2`，直到某一层是「重复的麦位条目」。
 *
 * 判据（三层包装层与条目层的区别）：**包装层的 `field 2` 子消息里有 `field 1`（房间 id），
 * 而麦位条目的 `field 2` 子消息里没有**。只看「字段 1 是不是大数字」会撞上房间 id
 * （19 位，和用户 id 一样长），所以必须用结构判据。
 */
function collectMicUserIds(root: PbMessage): string[] {
  let node: PbMessage | undefined = root
  for (let depth = 0; depth < 5 && node; depth += 1) {
    const entries = getMessages(node, 2)
    if (entries.length > 0 && entries.every(isSeatEntry)) {
      return entries
        .map((entry) => getVarintString(entry, 1) ?? '')
        .filter((id) => id.length > 0)
    }
    node = getMessage(node, 2)
  }
  return []
}

/** 麦位条目：`field 1` = 用户 id，`field 2` = 席位元信息（里面**没有** field 1） */
function isSeatEntry(entry: PbMessage): boolean {
  const id = getVarintString(entry, 1)
  if (!id || id === '0') return false
  const meta = getMessage(entry, 2)
  if (!meta) return false
  if (getVarint(meta, 1) !== undefined) return false
  return true
}

/** 深度优先找「某个目录礼物名」：JSON 版的 `matchGiftNameInFrame`（只在按字段名解不出名字时走） */
function matchGiftNameInJson(value: unknown, gifts?: GiftResolver, depth = 3): { name: string; diamonds: number } | undefined {
  if (!gifts?.resolveByName || depth < 0) return undefined
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.length === 0 || text.length > 40) return undefined
    return gifts.resolveByName(text)
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const hit = matchGiftNameInJson(entry, gifts, depth - 1)
      if (hit) return hit
    }
    return undefined
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      const hit = matchGiftNameInJson(entry, gifts, depth - 1)
      if (hit) return hit
    }
  }
  return undefined
}

function item(
  kind: DanmakuKind,
  user: string,
  userId: string,
  text: string,
  count: number,
  diamonds = 0
): DanmakuItem {
  // 收礼人只有礼物用得到，先给空串；礼物那条分支再补 `toUser` / `toUserId`
  return { id: nextId++, kind, user, userId, text, count, diamonds, toUser: '', toUserId: '', at: Date.now() }
}

/** 测试用：重置自增序号 */
export function __resetIds(): void {
  nextId = 1
}

/**
 * 字段名对照（2026-10 实测，`im/fetch` 的 JSON）：
 *
 * `common.method` / `common.room_id` / `common.create_time` / `common.msg_id`（snake_case），
 * 但 `RoomDataSyncMessage` 用的是 `roomID` / `syncKey` / `bizLogID`（camelCase）——两套并存，
 * 所以本文件里每个字段都给了候选键。
 *
 * User（enter 接口实测）：`id_str` `sec_uid` `nickname` `avatar_thumb{url_list}` `follow_info`
 *      `subscribe{is_member,level}` `border`；
 * User（推送里更全，字段名同源）：`pay_grade.level`（荣誉等级）、`fans_club.data.level`（粉丝团）、
 *      `badge_image_list`、`display_id`、`follow_info.following_count|follower_count`。
 * GiftMessage：`gift.name` / `gift.describe` / `gift.diamond_count`、`repeat_count`、`combo_count`。
 * RoomDataSyncMessage：`syncKey` = RoomLinkmicMicDisplayInfoSyncData → `payload`（base64 protobuf）。
 */