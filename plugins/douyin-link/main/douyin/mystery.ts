import { net } from 'electron'
import logger from 'electron-log'
import { avatarCache } from '../avatar'
import { withTimeout } from '../util/deadline'
import type { MysteryProfile, MysteryReveal } from '../../shared/types'

/**
 * 「神秘人」还原：抖音匿名送礼 / 发言时只给一个占位名（空串或「匿名」），
 * 但**用户 id 一直在**。拿这个 id 调 web 端的用户资料接口，就能把真名、头像、
 * 粉丝数这些本来藏着的东西取回来。
 *
 * 参考项目 `liangshengmoran/dyMysteryManMagicMirror`（两年前的）——2026-10 复测：
 * - 它用的 `webcast/ranklist/audience/`（观众榜，匿名用户会在里面泄露 `sec_uid`）**已经失效**：
 *   带匿名 ttwid 无论怎么拼参数都返回 200 空 body（本目录 `spike/mystery-probe.mjs` 有记录）；
 * - 但 `aweme/v1/web/user/profile/other/` **免签名**，只要有 ttwid cookie 就能按 `user_id`
 *   拿到完整资料（实测 `status_code = 0`，`nickname` / `avatar_300x300` / `follower_count` 都在）。
 *
 * 三条实测要点：
 * - **必须带 cookie**：没有 ttwid 时接口返回 200 但 body 是空的；
 * - `user_id`（数字串）与 `sec_user_id` 都认——我们手上只有数字 id，所以走 `user_id`；
 * - 找不到人或资料为空时返回失败码，界面照实说，不编。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const TIMEOUT_MS = 12000
const PROFILE_PATH = 'https://www.douyin.com/aweme/v1/web/user/profile/other/'

/** ttwid cookie 缓存（接口要它；从直播首页取——与 `room.ts` 同一份来源，10 分钟过期） */
let cookieCache = { value: '', at: 0 }
const COOKIE_TTL_MS = 10 * 60 * 1000

async function getCookie(): Promise<string> {
  if (cookieCache.value && Date.now() - cookieCache.at < COOKIE_TTL_MS) return cookieCache.value
  const response = await fetch('https://live.douyin.com/', {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const headers = response.headers as unknown as { getSetCookie?: () => string[] }
  const list =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (response.headers.get('set-cookie') ?? '').split(/,(?=[^;,=]+=)/)
  const cookie = list
    .map((entry) => entry.split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
  void response.text().catch(() => undefined)
  if (cookie) cookieCache = { value: cookie, at: Date.now() }
  return cookie
}

/**
 * 还原某个用户 id 的真实资料。**按 id 直查**，不需要这个人先在我们库里露过面——
 * 这正是旧版「脱马甲」（只能靠我们自己数据里的同名 id 反推）做不到的地方。
 */
export async function revealMysteryProfile(userId: string): Promise<MysteryReveal> {
  const id = String(userId ?? '').trim()
  if (!/^\d{4,}$/.test(id)) return { ok: false, code: 'badInput' }

  let cookie = ''
  try {
    cookie = await getCookie()
  } catch (error) {
    logger.warn('[douyin-link] 神秘人还原：取 cookie 失败:', describe(error))
    return { ok: false, code: 'network', detail: describe(error) }
  }
  if (!cookie) return { ok: false, code: 'network', detail: 'no cookie' }

  const query = new URLSearchParams({
    user_id: id,
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    version_code: '190500',
    publish_video_strategy_type: '2'
  })

  let body = ''
  try {
    body = await fetchJson(`${PROFILE_PATH}?${query}`, cookie)
  } catch (error) {
    logger.warn('[douyin-link] 神秘人还原：请求资料失败:', describe(error))
    return { ok: false, code: 'network', detail: describe(error) }
  }

  let json: ProfileJson
  try {
    json = JSON.parse(body) as ProfileJson
  } catch {
    return { ok: false, code: 'badResponse', detail: body.slice(0, 120) }
  }

  const user = json.user
  if (!user || !user.nickname) return { ok: false, code: 'notFound' }

  const avatarUrl = pickAvatar(user)
  const avatar = avatarUrl ? await avatarCache.dataUrl(avatarUrl) : ''
  return { ok: true, profile: toProfile(id, user, avatar) }
}

/** 先走 Node 的 fetch，再回落 Chromium 网络栈（与 `avatar.ts` 同款两手准备） */
async function fetchJson(url: string, cookie: string): Promise<string> {
  const headers = {
    'user-agent': UA,
    cookie,
    referer: 'https://www.douyin.com/',
    accept: 'application/json, text/plain, */*'
  }
  const attempts: Array<() => Promise<Response>> = [
    () => fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }),
    () => net.fetch(url, { headers })
  ]
  let last = ''
  for (const attempt of attempts) {
    try {
      const response = await withTimeout(attempt(), TIMEOUT_MS + 2000, 'mystery')
      const text = await response.text()
      if (response.ok && text) return text
      last = `HTTP ${response.status}`
    } catch (error) {
      last = describe(error)
    }
  }
  throw new Error(last || 'request failed')
}

/** 头像：优先 300×300 大图，退化到 larger/medium/thumb；只认 https 那条 */
function pickAvatar(user: ProfileUser): string {
  for (const image of [user.avatar_300x300, user.avatar_larger, user.avatar_medium, user.avatar_thumb]) {
    const url = image?.url_list?.find((entry) => entry.startsWith('https://'))
    if (url) return url
  }
  return ''
}

function toProfile(id: string, user: ProfileUser, avatar: string): MysteryProfile {
  const region = text(user.ip_location) || text(user.city) || [text(user.province), text(user.country)].filter(Boolean).join(' ')
  return {
    userId: id,
    nickname: text(user.nickname),
    displayId: text(user.unique_id) || (text(user.short_id) !== '0' ? text(user.short_id) : ''),
    secUid: text(user.sec_uid),
    signature: text(user.signature),
    gender: count(user.gender),
    region,
    follower: count(user.follower_count),
    following: count(user.following_count),
    awemeCount: count(user.aweme_count),
    totalFavorited: count(user.total_favorited),
    verified: text(user.custom_verify) || text(user.enterprise_verify_reason),
    avatar
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'timeout'
    return error.message.slice(0, 160)
  }
  return String(error).slice(0, 160)
}

interface ProfileImage {
  url_list?: string[]
}

interface ProfileUser {
  nickname?: string
  unique_id?: string
  short_id?: string
  sec_uid?: string
  signature?: string
  gender?: number
  city?: string
  province?: string
  country?: string
  ip_location?: string
  follower_count?: number
  following_count?: number
  aweme_count?: number
  total_favorited?: number
  custom_verify?: string
  enterprise_verify_reason?: string
  avatar_300x300?: ProfileImage
  avatar_larger?: ProfileImage
  avatar_medium?: ProfileImage
  avatar_thumb?: ProfileImage
}

interface ProfileJson {
  status_code?: number
  user?: ProfileUser
}
