import * as zlib from 'zlib'
import type { DanmakuItem, DanmakuKind, UserInfo } from '../../shared/types'
import {
  getBytes,
  getMessage,
  getMessages,
  getString,
  getStrings,
  getVarint,
  getVarintString,
  pickString,
  pickVarint,
  pickVarintInRange,
  readMessage,
  type PbMessage
} from './protobuf'

/**
 * 抖音弹幕推送帧的解码（**纯函数**，不碰 electron / 网络，方便单测）。
 *
 * 链路：websocket 二进制帧 → PushFrame(protobuf) → payload（gzip）→ WebcastResponse(protobuf)
 *      → 每条 Message(protobuf) → 具体消息（WebcastChatMessage 等）
 *
 * 字段号分两类，**处理方式不一样**：
 * - **实测过的**（用户档案那一组，见 shared/types 的 UserInfo 注释）：直接用，不做候选猜测；
 * - **没实测过的**（礼物的抖币价）：一律「查外部权威表 + 校验」，查不到就不显示
 *   （见 main/gift/catalog.ts）——宁可界面上没有额度，也不给用户一个错的数字。
 */

let nextId = 1

/** 礼物额度解析器（由主进程注入，把 giftId 换成官方目录里的名称与抖币价） */
export interface GiftResolver {
  resolve(id: number): { name: string; diamonds: number } | undefined
  /** 连击档文案（10 →「十全十美」） */
  comboText(count: number): string
}

/** 是否为 gzip 数据（弹幕帧的 payload 有的压、有的不压，两种都得认） */
function maybeGunzip(buf: Buffer): Buffer {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return zlib.gunzipSync(buf)
    } catch {
      return buf
    }
  }
  return buf
}

export interface ParsedFrame {
  /** PushFrame.payloadType：msg（正常推送）/ ack / hb / close */
  type: string
  /** PushFrame.payloadEncoding：gzip / '' */
  encoding: string
  /** 解出来的消息 */
  items: DanmakuItem[]
  /** 这批消息里出现的用户静态信息（按 id 去重，交给用户档案库聚合） */
  users: UserInfo[]
  /** 服务端要求客户端回 ack 时给的原帧 logId（透传给调用方） */
  logId: number
  /** 主播关播等控制信号 */
  close: boolean
}

/**
 * 解一帧 websocket 二进制数据。**永不抛错**：解析失败返回空结果
 * （弹幕协议偶发变更/心跳帧都不该让整条链路挂掉）。
 */
export function parsePushFrame(raw: Buffer, gifts?: GiftResolver): ParsedFrame {
  const empty: ParsedFrame = { type: '', encoding: '', items: [], users: [], logId: 0, close: false }
  if (!raw || raw.length < 4) return empty
  try {
    const frame = readMessage(raw)
    const type = getString(frame, 7, 16) ?? ''
    const encoding = getString(frame, 6, 16) ?? ''
    const logId = getVarint(frame, 2) ?? 0
    if (type && type !== 'msg') return { ...empty, type, encoding, logId }
    const payloadRaw = getBytes(frame, 8)
    if (!payloadRaw) return { ...empty, type, encoding, logId }
    const payload = maybeGunzip(payloadRaw)
    const response = readMessage(payload)
    const items: DanmakuItem[] = []
    const users = new Map<string, UserInfo>()
    let close = false
    for (const message of getMessages(response, 1)) {
      const method = getString(message, 1, 64) ?? ''
      const body = getBytes(message, 2)
      if (!body) continue
      const decoded = decodeMessage(method, maybeGunzip(body), gifts)
      if (!decoded) continue
      if (decoded.user && decoded.user.id) users.set(decoded.user.id, decoded.user)
      if (decoded.item.kind === 'control' && decoded.item.text === 'ended') close = true
      items.push(decoded.item)
    }
    return { type: type || 'msg', encoding, logId, items, users: [...users.values()], close }
  } catch {
    return empty
  }
}

interface Decoded {
  item: DanmakuItem
  user: UserInfo | null
}

/** 单条消息 → 界面要显示的一行 + 这条消息里带的用户信息；不认识的 method 返回 null */
export function decodeMessage(
  method: string,
  body: Buffer,
  gifts?: GiftResolver
): Decoded | null {
  if (!method || body.length === 0) return null
  try {
    const msg = readMessage(body)
    const userMessage = findUserMessage(msg)
    const user = userMessage ? parseUser(userMessage) : null
    const userId = user?.id ?? ''
    const nickname = user?.nickname ?? ''
    switch (method) {
      case 'WebcastChatMessage':
      case 'WebcastEmojiChatMessage': {
        const text = pickString(msg, [3, 4, 5], 200) ?? ''
        if (!text && !nickname) return null
        return { item: item('chat', nickname, userId, text, 0, 0), user }
      }
      case 'WebcastGiftMessage':
        return decodeGift(msg, user, gifts)
      case 'WebcastMemberMessage': {
        const count = getVarint(msg, 3) ?? 0
        return { item: item('member', nickname, userId, '', count, 0), user }
      }
      case 'WebcastLikeMessage':
      case 'WebcastRoomMessage': {
        const count = pickVarintInRange(msg, [2, 3], 0, 100000) ?? 0
        return { item: item('like', nickname, userId, '', count, 0), user }
      }
      case 'WebcastSocialMessage':
        return { item: item('social', nickname, userId, '', 0, 0), user }
      case 'WebcastRoomUserSeqMessage': {
        const text = pickString(msg, [8, 7, 3], 24)
        const total = getVarint(msg, 2) ?? 0
        return { item: item('stats', '', '', text ?? (total ? String(total) : ''), total, 0), user: null }
      }
      case 'WebcastControlMessage': {
        const status = getVarint(msg, 2) ?? 0
        // 3 = 直播结束：text 给的是**原因码**，文案由渲染层按语言翻
        return { item: item('control', '', '', status === 3 ? 'ended' : 'changed', status, 0), user: null }
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

/**
 * 礼物消息：**名称与额度都从官方目录拿**（用 giftId 查），查不到就只留名字、额度 0。
 *
 * 为什么这么绕：`WebcastGiftMessage` 的字段号没有实测样本（真机抓了 5 个房间、
 * 匿名会话下根本没收到过这条消息），猜 `diamond_count` 的字段号等于把错价格显示给用户。
 * 官方 `webcast/gift/list/` 免签名可用（1287 件礼物，1279 件带 `diamond_count`），
 * 于是改成「消息只提供 id，价格以目录为准」——**id 认不出来就不显示额度**。
 */
function decodeGift(msg: PbMessage, user: UserInfo | null, gifts?: GiftResolver): Decoded | null {
  const gift = getMessage(msg, 15)
  // 连发数量（repeatCount）与连击（comboCount）：这两个都在 [1, 100000] 内，取不到就按 1 算
  const repeat = pickVarintInRange(msg, [5, 4], 1, 100000) ?? 1
  const combo = getVarint(msg, 6) ?? 0
  const idCandidates = [
    gift ? getVarint(gift, 1) : undefined,
    getVarint(msg, 2),
    gift ? getVarint(gift, 3) : undefined
  ]
  let name = ''
  let unit = 0
  for (const candidate of idCandidates) {
    if (candidate === undefined || candidate <= 0) continue
    const hit = gifts?.resolve(candidate)
    if (hit && hit.name) {
      name = hit.name
      unit = hit.diamonds
      break
    }
  }
  if (!name) name = gift ? (pickString(gift, [16, 12, 2, 3], 40) ?? '') : ''
  const comboText = combo > 1 ? (gifts?.comboText(repeat) ?? '') : ''
  const text = comboText ? `${name || '🎁'}（${comboText}）` : name
  return { item: item('gift', user?.nickname ?? '', user?.id ?? '', text, repeat, unit * repeat), user }
}

/** 消息里那个 `User` 子消息：**扫一遍字节字段，认「字段 3 是合法昵称」的那个** */
function findUserMessage(msg: PbMessage): PbMessage | undefined {
  for (const list of msg.fields.values()) {
    for (const value of list) {
      if (value.kind !== 'bytes' || value.value.length < 4) continue
      const sub = readMessage(value.value)
      const nickname = getString(sub, 3, 60)
      if (nickname && nickname.length > 0) return sub
    }
  }
  return undefined
}

/**
 * `User` 消息 → 静态信息。字段号全部实测过（真机 dump），所以这里不做多候选猜测。
 * 只收「有 id」的用户：id 是档案库的键，没有键就没法聚合。
 */
export function parseUser(user: PbMessage): UserInfo | null {
  const id = getVarintString(user, 1) ?? ''
  if (!id) return null
  const shortId = getVarintString(user, 2) ?? ''
  const displayId = getString(user, 38, 40) ?? shortId
  const nickname = getString(user, 3, 60) ?? ''

  const follow = getMessage(user, 22)
  const following = follow ? (getVarint(follow, 1) ?? 0) : 0
  const follower = follow ? (getVarint(follow, 2) ?? 0) : 0

  const payGrade = getMessage(user, 23)
  let honorLevel = payGrade ? (getVarint(payGrade, 6) ?? 0) : 0

  const fansClub = getMessage(user, 24)
  const fansClubData = fansClub ? getMessage(fansClub, 1) : undefined
  let fansClubLevel = fansClubData ? (getVarint(fansClubData, 2) ?? 0) : 0

  // 勋章列表（字段 61，退化到 21）：顺便从里面补荣誉等级/粉丝团等级
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
    displayId,
    nickname,
    gender: getVarint(user, 4) ?? 0,
    signature: getString(user, 5, 200) ?? '',
    city: pickString(user, [14, 63], 40) ?? '',
    avatar: pickAvatar(user),
    following,
    follower,
    honorLevel,
    fansClubLevel,
    badges: badges.slice(0, 4),
    secUid: getString(user, 46, 200) ?? ''
  }
}

/** 头像：优先大图（11），退化到中图（10）/ 缩略图（9）；只认 https 的那条 url_list */
function pickAvatar(user: PbMessage): string {
  for (const fieldNo of [11, 10, 9]) {
    const image = getMessage(user, fieldNo)
    if (!image) continue
    const urls = getStrings(image, 1, 300)
    const https = urls.find((url) => url.startsWith('https://'))
    if (https) return https
    if (urls.length > 0) return urls[0]
  }
  return ''
}

function item(
  kind: DanmakuKind,
  user: string,
  userId: string,
  text: string,
  count: number,
  diamonds: number
): DanmakuItem {
  return { id: nextId++, kind, user, userId, text, count, diamonds, at: Date.now() }
}

/** 测试用：重置自增序号 */
export function __resetIds(): void {
  nextId = 1
}

/**
 * 字段号对照（**前一组是真机 dump 实测**，后一组来自公开 webcast proto、未经实测）：
 *
 * PushFrame: 2 logId, 6 payloadEncoding, 7 payloadType, 8 payload
 * WebcastResponse: 1 messages
 * Message: 1 method, 2 payload
 * Common: 1 method, 2 msgId, 3 roomId, 6 createTime
 * User: 1 id, 2 shortId, 3 nickname, 4 gender, 5 signature, 9/10/11 avatar(thumb/medium/large),
 *       14|63 city, 21|61 badges{ 1 image, 6 type, 8.3 level, 8.4 desc }, 22 followInfo,
 *       23 payGrade{ 6 level, 10/11 diamond range }, 24 fansClub{ 1 data{ 2 level, 3 status } },
 *       38 displayId, 46 secUid
 * WebcastChatMessage: 2 user, 3 content
 * WebcastGiftMessage: 2 giftId（未实测）, 5 repeatCount（未实测）, 6 comboCount（未实测）,
 *       7 user, 15 gift{ 1 id? 16 name?（未实测） }
 * WebcastMemberMessage: 2 user, 3 memberCount
 * WebcastLikeMessage: 2 count, 3 total, 5 user
 * WebcastSocialMessage: 2 user
 * WebcastRoomUserSeqMessage: 2 total, 3 popStr, 7 totalUserStr, 8 totalStr
 * WebcastControlMessage: 2 status（3 = 关播）
 */
