import type { UserInfo } from '../../shared/types'

/**
 * 抖音 `User`（JSON）→ 静态信息（**纯函数**，不碰 electron / 网络，方便单测与探针）。
 *
 * 用途：`../douyin/room` 解析 `enter` 接口时，把主播的 `owner` 解成 `UserInfo`
 * （放进用户库与「在线观众」）。
 *
 * 字段名 relentlessly 容错：真机 enter 接口给的是 `id_str` / `nickname` /
 * `avatar_thumb.url_list` / `follow_info`，推送里的 User 字段更全
 * （`pay_grade` / `fans_club` / `badge_image_list`），两份都要认。
 *
 * 说明：本文件以前还带一条 `im/fetch` 的 JSON 消息解码路径（HTTP 轮询通道用）；
 * 轮询兜底已移除，整条 JSON 批解码随之删掉——**逐条消息只走 protobuf**（见 `./proto-messages.ts`）。
 */

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
 * 取 int64 标识的**精确十进制串**。优先 `*_str` 字段（接口对 id 一般同时给两份——
 * `id_str` 是字符串，不受 `JSON.parse` 的 2^53 精度损失影响），退化时用数字值转串。
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

/**
 * `User`（JSON）→ 静态信息（字段名容错，见文件头）。
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

/**
 * 字段名对照（2026-10 实测，`enter` 接口）：
 * User：`id_str` `sec_uid` `nickname` `avatar_thumb{url_list}` `follow_info` `subscribe{is_member,level}` `border`；
 *       推送里更全（字段名同源）：`pay_grade.level`（荣誉等级）、`fans_club.data.level`（粉丝团）、
 *       `badge_image_list`、`display_id`、`follow_info.following_count|follower_count`。
 */