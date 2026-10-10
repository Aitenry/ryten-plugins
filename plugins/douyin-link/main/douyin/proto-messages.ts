import logger from 'electron-log'
import type { DanmakuItem, DanmakuKind, UserInfo } from '../../shared/types'
import type { GiftResolver } from '../gift/catalog'
import {
  getBytes,
  getMessage,
  getMessages,
  getString,
  getVarint,
  getVarintString,
  pickString,
  pickVarintInRange,
  readMessage,
  type PbMessage
} from './protobuf'

/**
 * `im/fetch` 的 **protobuf** 推送 → 与 JSON 那条路完全一样的批次结构（纯函数）。
 *
 * 为什么必须有这一份（用户 2026-10 实测「实时里面没有任何内容」的根因）：
 * 同一个 `im/fetch` 接口，**`resp_content_type=json`（默认）只回「房间级」消息**
 * （`WebcastRoomMessage` / `WebcastRoomDataSyncMessage`），
 * 而 `resp_content_type=protobuf` 回**全量**：`WebcastMemberMessage`（进场）、
 * `WebcastRoomStatsMessage`（在线人数）、直播排行、连麦小玩法……
 * 两个房间连着采 40 轮对比：JSON 模式 0 条用户消息，protobuf 模式一次就 21 条消息。
 * 所以 protobuf 才是主路，JSON 只当兜底。
 *
 * 顺带：protobuf 响应里还带着服务端下发的 **`push_server`（字段 10/14）与 `fetch_type=1`**
 * ——也就是「去这个 wss 地址收推送」的官方指示（`./danmaku.ts` 用它尝试升级到 websocket）。
 *
 * 字段号来源：老版本用 CDP 截真机 ws 帧时 dump 出来的（见文件末尾对照表），
 * 这次的 protobuf 实测又核对了一遍（MemberMessage 的 2=user、3=memberCount 等）。
 */

/** WebcastResponse 顶层里我们要的东西 */
export interface ProtoResponse {
  batch: ProtoBatch
  /** 服务端下发的推送地址（没有则为空串） */
  pushServer: string
  /** `fetch_type`：1 = Socket（服务端在示意可以升级到 ws） */
  fetchType: number
  /** 增量游标（字段 2） */
  cursor: string
  /** 增量上下文（字段 5）：下一次请求要带回去 */
  internalExt: string
  /** 服务端建议的轮询间隔（字段 3，毫秒） */
  intervalMs: number
  /** 是否需要回 ack（字段 9）：推送 ws 通道据此回 `PushFrame{payloadType:'ack'}` */
  needAck: boolean
}

export interface ProtoBatch {
  items: DanmakuItem[]
  users: UserInfo[]
  roomEnded: boolean
  micUserIds: string[] | null
  methods: Record<string, number>
}

let nextId = 1

/** 解一份 protobuf 响应（永不抛错：单条解不动只跳过那一条） */
export function decodeProtoResponse(buf: Buffer, gifts?: GiftResolver): ProtoResponse {
  const empty: ProtoBatch = { items: [], users: [], roomEnded: false, micUserIds: null, methods: {} }
  const fallback: ProtoResponse = {
    batch: empty,
    pushServer: '',
    fetchType: 0,
    cursor: '',
    internalExt: '',
    intervalMs: 0,
    needAck: false
  }
  if (!buf || buf.length === 0) return fallback
  try {
    const root = readMessage(buf)
    const items: DanmakuItem[] = []
    const users = new Map<string, UserInfo>()
    const methods: Record<string, number> = {}
    let roomEnded = false
    let micUserIds: string[] | null = null
    for (const message of getMessages(root, 1)) {
      const method = getString(message, 1, 64) ?? ''
      const payload = getBytes(message, 2)
      if (!method || !payload) continue
      methods[method] = (methods[method] ?? 0) + 1
      const decoded = decodeProtoMessage(method, payload, gifts)
      if (!decoded) continue
      for (const user of decoded.users) if (user.id) users.set(user.id, user)
      if (decoded.roomEnded) roomEnded = true
      if (decoded.micUserIds) micUserIds = decoded.micUserIds
      if (decoded.item) items.push(decoded.item)
    }
    const interval = getVarint(root, 3) ?? 0
    return {
      batch: { items, users: [...users.values()], roomEnded, micUserIds, methods },
      pushServer: getString(root, 10, 300) ?? getString(root, 14, 300) ?? '',
      fetchType: getVarint(root, 6) ?? 0,
      cursor: getString(root, 2, 300) ?? '',
      internalExt: getString(root, 5, 500) ?? '',
      intervalMs: interval > 0 ? interval : 0,
      needAck: (getVarint(root, 9) ?? 0) === 1
    }
  } catch {
    return fallback
  }
}

interface ProtoDecoded {
  item: DanmakuItem | null
  users: UserInfo[]
  roomEnded: boolean
  micUserIds: string[] | null
}

const nothing = (): ProtoDecoded => ({ item: null, users: [], roomEnded: false, micUserIds: null })

/** 每种消息里的 `User` 位置（真机 dump 实测；认不出来再用扫描兜底） */
const USER_FIELDS: Record<string, number[]> = {
  WebcastChatMessage: [2],
  WebcastEmojiChatMessage: [2],
  WebcastMemberMessage: [2],
  WebcastSocialMessage: [2],
  WebcastLikeMessage: [5, 2],
  WebcastGiftMessage: [7, 2]
}

/** 单条消息 → 一行 + 里面的用户（不认识的 method 返回 null） */
export function decodeProtoMessage(
  method: string,
  payload: Buffer,
  gifts?: GiftResolver
): ProtoDecoded | null {
  let msg: PbMessage
  try {
    msg = readMessage(payload)
  } catch {
    return null
  }
  const user = findUser(msg, method)
  const nickname = user?.nickname ?? ''
  const userId = user?.id ?? ''
  const withUser = (users: UserInfo[]): UserInfo[] => users

  switch (method) {
    case 'WebcastChatMessage':
    case 'WebcastEmojiChatMessage': {
      const text = pickString(msg, [3, 4, 5], 200) ?? ''
      if (!text && !nickname) return null
      return { ...nothing(), item: item('chat', nickname, userId, text, 0), users: withUser(user ? [user] : []) }
    }
    case 'WebcastMemberMessage': {
      const count = getVarint(msg, 3) ?? 0
      return { ...nothing(), item: item('member', nickname, userId, '', count), users: withUser(user ? [user] : []) }
    }
    case 'WebcastLikeMessage': {
      const count = pickVarintInRange(msg, [2, 3], 0, 100000) ?? 0
      return { ...nothing(), item: item('like', nickname, userId, '', count), users: withUser(user ? [user] : []) }
    }
    case 'WebcastSocialMessage':
      return { ...nothing(), item: item('social', nickname, userId, '', 0), users: withUser(user ? [user] : []) }
    case 'WebcastGiftMessage':
      return decodeProtoGift(msg, user, gifts, payload)
    case 'WebcastRoomStatsMessage': {
      // 在线人数（JSON 模式根本收不到这条）：4 是展示串（"31在线观众"），5 是数字
      const total = pickVarintInRange(msg, [5, 9], 0, 100000000) ?? 0
      const text = pickString(msg, [4], 24) ?? (total > 0 ? String(total) : '')
      if (!text) return null
      return { ...nothing(), item: item('stats', '', '', text, total) }
    }
    case 'WebcastRoomUserSeqMessage': {
      // 7 = totalUserStr（"32在线观众"）、3 = popStr；拿不到就用数字
      const total = getVarint(msg, 2) ?? 0
      const text = pickString(msg, [7, 3], 24) ?? (total ? String(total) : '')
      if (!text) return null
      return { ...nothing(), item: item('stats', '', '', text, total) }
    }
    case 'WebcastRoomMessage': {
      // 房间级提示（进房欢迎语等）：**空内容不要占一行**（消息体很常见地只带个空串）
      const text = getString(msg, 2, 200) ?? ''
      if (!text.trim()) return null
      return { ...nothing(), item: item('system', '', '', text, 0) }
    }
    case 'WebcastControlMessage': {
      const status = getVarint(msg, 2) ?? 0
      return { ...nothing(), item: item('control', '', '', status === 3 ? 'ended' : 'changed', status) }
    }
    case 'WebcastRoomDataSyncMessage':
      return decodeProtoDataSync(msg)
    default:
      maybeDumpUnknown(method, payload)
      return null
  }
}

/**
 * 礼物消息（`WebcastGiftMessage`）。
 *
 * 字段号（`5 = repeatCount`、`6 = comboCount`、`7 = user`、`8 = toUser`、`11 = groupId`、
 * `15 = gift(GiftStruct: 2 describe, 5 id, 12 diamondCount, 16 name)`）与参考项目
 * `LiukerSun/DouyinDanmu` 用 C++ 生产验证过的 `backend/proto/douyin.proto` 一致。
 *
 * 三条口径：
 * - **单价以帧自带的 `GiftStruct.diamondCount`（12）为准**（升级礼物/活动价与目录标准价不同），
 *   目录价只在帧没给价时兜底；两边都没有 = 0 = 未知（不编数）；
 * - **数量**取 `combo_count`(6) 与 `repeat_count`(5) 的较大者，即服务端推的**累积量**；
 *   「累积量 → 本次增量」的连送去重（按 `group_id`+双方+gift_id）在 `main/gift/group.ts` 里做；
 * - **收礼人** = `8 = toUser`（谁收到了这份礼物）。
 */
function decodeProtoGift(msg: PbMessage, user: UserInfo | null, gifts: GiftResolver | undefined, payload: Buffer): ProtoDecoded {
  const gift = getMessage(msg, 15)
  const nickname = user?.nickname ?? ''
  const toUser = parseProtoUser(getMessage(msg, 8))
  const frameName = (gift ? (pickString(gift, [16, 2], 40) ?? '') : '').trim()
  const frameUnit = gift ? (pickVarintInRange(gift, [12], 0, 1000000) ?? 0) : 0
  const giftId = (gift ? (getVarint(gift, 5) ?? 0) : 0) || (getVarint(msg, 2) ?? 0)
  let hit = giftId > 0 ? gifts?.resolve(giftId) : undefined
  /** 兜底：帧里出现了某个目录礼物名就直接认它（按字段号解不出名字时才走） */
  if (!frameName && !hit) hit = matchGiftNameInFrame(msg, gifts)
  const name = frameName || hit?.name || ''
  /**
   * **单价以帧自带的 `GiftStruct.diamondCount`（字段 12）为准**：它反映这次实际发送的价格，
   * 而目录里的是标准价——**升级礼物、神秘商店/活动价都与标准价不同**（用户反馈「金额对不上」
   * 就是这个原因）。目录价只在帧没给价时兜底；两边都没有就是 0 = **未知**（不编数）。
   */
  const unit = frameUnit || hit?.diamonds || 0
  /**
   * 连送数量：服务端推的是**累积量**，取 `combo_count`(6) 与 `repeat_count`(5) 的较大者（至少 1）。
   * `group_count`(4) 是「原始组数」，参考项目明确**不作为连送乘数**，这里也不用。
   * 「累积量 → 本次增量」的去重在后处理里做（`main/gift/group.ts`，需要 `group_id`）。
   */
  const cumulative = Math.max(getVarint(msg, 6) ?? 0, pickVarintInRange(msg, [5], 1, 100000) ?? 1, 1)
  /** 连送分组身份之一（`GiftMessage.group_id`，字段 11） */
  const groupId = getVarintString(msg, 11) ?? ''
  /**
   * 名字解不出来的真礼物：把**原始帧**记进日志（限几次）。
   *
   * 为什么值得留：`WebcastGiftMessage` 的字段号来自社区 proto，本机一直没抓到真帧；
   * 2026-10-08 用户库里出现了一条「收礼人有、礼物名空」的行（`失眠了 → 不乖ఇ`），
   * 说明真礼物帧**到了**、但我们没能从里面解出礼物名——这时候日志里的字段表就是唯一的线索，
   * 照着它把字段号钉死，比再猜一轮强。
   */
  if (!name && nickname) logGiftWithoutName(msg, payload)
  if (!name && !nickname) return nothing()
  const base = item('gift', nickname, user?.id ?? '', name, cumulative, unit * cumulative)
  return {
    ...nothing(),
    item: {
      ...base,
      toUser: toUser?.nickname ?? '',
      toUserId: toUser?.id ?? '',
      trace: 'proto-gift',
      giftRecord: true,
      giftId,
      groupId
    },
    users: [...(user ? [user] : []), ...(toUser ? [toUser] : [])]
  }
}

/**
 * 把帧里（含嵌套，最多 4 层）所有像字符串的字节拿去和目录对名字，第一个对上的就是这件礼物。
 *
 * 只在「按字段号解不出名字」时才走这条路；目录里没有同名礼物就返回 undefined。
 */
function matchGiftNameInFrame(msg: PbMessage, gifts?: GiftResolver): { name: string; diamonds: number } | undefined {
  if (!gifts?.resolveByName) return undefined
  const seen = new Set<string>()
  const walk = (node: PbMessage, depth: number): { name: string; diamonds: number } | undefined => {
    for (const list of node.fields.values()) {
      for (const value of list) {
        if (value.kind !== 'bytes' || value.value.length === 0) continue
        const text = value.value.toString('utf8')
        const valid = Buffer.from(text, 'utf8').equals(value.value) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)
        if (valid && text.length <= 40) {
          if (seen.has(text)) continue
          seen.add(text)
          const hit = gifts.resolveByName?.(text)
          if (hit?.name) return hit
        }
        if (depth > 0 && value.value.length > 1) {
          const nested = walk(readMessage(value.value), depth - 1)
          if (nested) return nested
        }
      }
    }
    return undefined
  }
  try {
    return walk(msg, 3)
  } catch {
    return undefined
  }
}

/** 解不出礼物名的真礼物帧：原始字段表 + 头部十六进制（每场最多记 5 条，别把日志刷爆） */
let giftDumpCount = 0
function logGiftWithoutName(msg: PbMessage, payload: Buffer): void {
  if (giftDumpCount >= 5) return
  giftDumpCount += 1
  try {
    const dump = (node: PbMessage): string =>
      [...node.fields.entries()]
        .map(([no, list]) =>
          `${no}:${list
            .map((value) =>
              value.kind === 'bytes'
                ? `b(${value.value.length})`
                : value.kind === 'varint'
                  ? `v(${value.value})`
                  : value.kind
            )
            .join('|')}`
        )
        .join(' ')
    const gift = getMessage(msg, 15)
    logger.info(`[douyin-link][gift-unknown] len=${payload.length} 顶层 ${dump(msg)}`)
    logger.info(`[douyin-link][gift-unknown] field15 ${gift ? dump(gift) : '（没有 field 15）'}`)
    logger.info(`[douyin-link][gift-unknown] hex=${payload.subarray(0, 512).toString('hex')}`)
  } catch {
    /* 诊断失败无所谓 */
  }
}


/**
 * 榜单/贡献类消息的字段号**仍未实测**（`WebcastRoomRankMessage` / `WebcastLinkerContributeMessage` /
 * `WebcastGuestBattleMessage` / `WebcastRanklistHourEntranceMessage`）。
 *
 * 为什么先只做「dump」不做解码：这些结构给的是**本房间累计值**，字段号猜错就是把错误数字写进
 * 用户榜（本插件的原则是宁可没有、不给错数）。所以先用环境变量开诊断，真机跑一轮把字段号钉死，
 * 再回来补解码器。
 *
 * 开法：`DOUYIN_DUMP_UNKNOWN=1` 启动应用，日志里会出现 `[douyin-link][dump] <method> …`。
 */
const DUMP_METHODS = new Set([
  'WebcastRoomRankMessage',
  'WebcastLinkerContributeMessage',
  'WebcastGuestBattleMessage',
  'WebcastRanklistHourEntranceMessage',
  'WebcastLinkmicOrderSingScoreMessage'
])

function maybeDumpUnknown(method: string, payload: Buffer): void {
  if (process.env.DOUYIN_DUMP_UNKNOWN !== '1') return
  if (!DUMP_METHODS.has(method)) return
  try {
    const msg = readMessage(payload)
    const fields = [...msg.fields.entries()]
      .map(([no, list]) => `${no}:${list.map((value) => (value.kind === 'bytes' ? `b(${value.value.length})` : value.kind === 'varint' ? `v(${value.value})` : value.kind)).join('|')}`)
      .join(' ')
    logger.info(`[douyin-link][dump] ${method} len=${payload.length} fields=${fields}`)
    logger.info(`[douyin-link][dump] ${method} hex=${payload.subarray(0, 256).toString('hex')}`)
  } catch {
    /* dump 只是诊断，失败无所谓 */
  }
}

/** 房间数据同步：麦位表（`syncKey` 在 3，`payload` 在 5） */
function decodeProtoDataSync(msg: PbMessage): ProtoDecoded {
  const syncKey = getString(msg, 3, 64) ?? ''
  const out = nothing()
  if (!/MicDisplayInfo/i.test(syncKey)) return out
  const payload = getMessage(msg, 5)
  if (!payload) return out
  out.micUserIds = collectMicUserIds(payload)
  return out
}

/**
 * 从麦位同步结构里收集用户 id：逐层下钻 `field 2`，直到某一层是「重复的麦位条目」。
 *
 * 判据（包装层与条目层的区别）：包装层的 `field 2` 子消息里有 `field 1`（房间 id），
 * 而麦位条目的 `field 2` 子消息里没有。只看「字段 1 是不是大数字」会撞上房间 id
 * （19 位，和用户 id 一样长），所以必须用结构判据。
 */
function collectMicUserIds(root: PbMessage): string[] {
  let node: PbMessage | undefined = root
  for (let depth = 0; depth < 5 && node; depth += 1) {
    const entries = getMessages(node, 2)
    if (entries.length > 0 && entries.every(isSeatEntry)) {
      return entries.map((entry) => getVarintString(entry, 1) ?? '').filter((id) => id.length > 0)
    }
    node = getMessage(node, 2)
  }
  return []
}

function isSeatEntry(entry: PbMessage): boolean {
  const id = getVarintString(entry, 1)
  if (!id || id === '0') return false
  const meta = getMessage(entry, 2)
  if (!meta) return false
  return getVarint(meta, 1) === undefined
}

/** 找消息里的 `User`：先按实测字段号取，取不到再扫一遍字节字段认「字段 3 是合法昵称」的那个 */
function findUser(msg: PbMessage, method: string): UserInfo | null {
  for (const field of USER_FIELDS[method] ?? []) {
    const parsed = parseProtoUser(getMessage(msg, field))
    if (parsed?.nickname) return parsed
  }
  for (const list of msg.fields.values()) {
    for (const value of list) {
      if (value.kind !== 'bytes' || value.value.length < 4) continue
      const sub = readMessage(value.value)
      const nickname = getString(sub, 3, 60)
      if (nickname) {
        const parsed = parseProtoUser(sub)
        if (parsed) return parsed
      }
    }
  }
  return null
}

/** `User`（protobuf）→ 静态信息（字段号真机 dump 实测，见文件末尾对照表） */
export function parseProtoUser(user: PbMessage | undefined): UserInfo | null {
  if (!user) return null
  const id = getVarintString(user, 1) ?? ''
  if (!id || id === '0') return null
  const shortId = getVarintString(user, 2) ?? ''
  const follow = getMessage(user, 22)
  const payGrade = getMessage(user, 23)
  let honorLevel = payGrade ? (getVarint(payGrade, 6) ?? 0) : 0
  const fansClub = getMessage(user, 24)
  const fansClubData = fansClub ? getMessage(fansClub, 1) : undefined
  let fansClubLevel = fansClubData ? (getVarint(fansClubData, 2) ?? 0) : 0

  const badges: string[] = []
  for (const fieldNo of [61, 21]) {
    for (const badge of getMessages(user, fieldNo)) {
      const info = getMessage(badge, 8)
      const text = info ? (getString(info, 4, 40) ?? '') : ''
      const level = info ? (getVarint(info, 3) ?? 0) : 0
      const type = getVarint(badge, 6) ?? 0
      if (type === 1 && level > 0 && honorLevel === 0) honorLevel = level
      if (type === 7 && level > 0 && fansClubLevel === 0) fansClubLevel = level
      if (text && !badges.includes(text)) badges.push(text)
    }
    if (badges.length > 0) break
  }

  return {
    id,
    displayId: getString(user, 38, 40) ?? shortId,
    nickname: getString(user, 3, 60) ?? getString(user, 68, 60) ?? '',
    gender: getVarint(user, 4) ?? 0,
    signature: getString(user, 5, 200) ?? '',
    city: pickString(user, [14, 63], 40) ?? '',
    avatar: pickProtoAvatar(user),
    following: follow ? (getVarint(follow, 1) ?? 0) : 0,
    follower: follow ? (getVarint(follow, 2) ?? 0) : 0,
    honorLevel,
    fansClubLevel,
    badges: badges.slice(0, 4),
    secUid: getString(user, 46, 200) ?? ''
  }
}

/** 头像：优先大图（11），退化到中图（10）/ 缩略图（9）；只认 https 的那条 url_list */
function pickProtoAvatar(user: PbMessage): string {
  for (const fieldNo of [11, 10, 9]) {
    const image = getMessage(user, fieldNo)
    if (!image) continue
    const urls: string[] = []
    for (const list of image.fields.values()) {
      for (const value of list) {
        if (value.kind !== 'bytes') continue
        const text = value.value.toString('utf8')
        if (text.startsWith('http')) urls.push(text)
      }
    }
    const https = urls.find((url) => url.startsWith('https://'))
    if (https) return https.slice(0, 300)
    if (urls.length > 0) return urls[0].slice(0, 300)
  }
  return ''
}

function item(
  kind: DanmakuKind,
  user: string,
  userId: string,
  text: string,
  count: number,
  diamonds = 0
): DanmakuItem {
  // 收礼人只有礼物用得到，先给空串；礼物那两个解码器再补 `toUser` / `toUserId`
  return { id: nextId++, kind, user, userId, text, count, diamonds, toUser: '', toUserId: '', at: Date.now() }
}

/** 测试用：重置自增序号 */
export function __resetProtoIds(): void {
  nextId = 1
}

/**
 * 字段号对照（**真机 dump 实测**，2026-10 又用 protobuf 响应核对过一遍）：
 *
 * WebcastResponse: 1 messages, 2 cursor, 3 fetchInterval, 5 internalExt, 6 fetchType,
 *                  10/14 pushServer
 * Message: 1 method, 2 payload
 * Common: 1 method, 2 msgId, 3 roomId, 4 createTime, 6 →（成员消息里是 1）
 * User: 1 id, 2 shortId, 3 nickname, 4 gender, 5 signature, 9/10/11 avatar(thumb/medium/large),
 *       14|63 city, 21|61 badges{ 1 image, 6 type, 8.3 level, 8.4 desc }, 22 followInfo,
 *       23 payGrade{ 6 level }, 24 fansClub{ 1 data{ 2 level } }, 38 displayId, 46 secUid, 68 nickname(备用)
 * WebcastChatMessage: 2 user, 3 content
 * WebcastMemberMessage: 2 user, **3 memberCount**（实测 31 = 在线人数）
 * WebcastLikeMessage: 2 count, 3 total, 5 user
 * WebcastSocialMessage: 2 user
 * WebcastGiftMessage: 2 giftId, 5 repeatCount, 6 comboCount, 7 user, 8 toUser, 9 repeatEnd,
 *                     15 gift(GiftStruct: 2 describe, 5 id, 11 type, 12 diamondCount, 16 name)
 *                     —— 与参考项目 `backend/proto/douyin.proto` 一致（生产验证过）
 * WebcastRoomStatsMessage: 2/3/4 展示串（"31"、"31在线观众"）, 5 count（JSON 模式收不到这条）
 * WebcastRoomUserSeqMessage: 2 total, 3 popStr, 7 totalUserStr, 8 totalStr
 * WebcastRoomMessage: 2 content（进房欢迎语这类房间级提示）
 * WebcastRoomDataSyncMessage: 2 roomID, 3 syncKey, 4 version, 5 payload（麦位表在
 *                      syncKey=RoomLinkmicMicDisplayInfoSyncData 的 payload 里）
 * WebcastControlMessage: 2 status（3 = 关播）
 */