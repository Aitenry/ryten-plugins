import type { LiveRoomInfo, QualityKey } from '../../shared/types'
import { QUALITY_KEYS, parseWebRid } from '../../shared/types'

/**
 * 直播间解析：网页房间号 → 直播间信息 + 音频流地址。
 *
 * 两步（都在主进程做：渲染层跨域拿不到 live.douyin.com 的 HTML 和 ttwid Cookie）：
 * 1. GET https://live.douyin.com/<webRid> —— 拿到 ttwid Cookie（接口要它）+ HTML（里面嵌着 roomId）；
 * 2. GET /webcast/room/web/enter/ —— 拿标题、主播、在线人数、拉流地址。
 *
 * 实测要点（2026-01 抓的真机数据）：
 * - enter 接口**不需要 signature**，但参数必须带全（少一个 web_rid 之外的字段会返回**空 body**），
 *   所以参数表按 web 端原样照抄；
 * - 拉流地址是 http，html5 侧一律升成 https（同一域名同一签名，实测都能拉）；
 * - 页面 HTML 里也有一份同样的 stream_url，enter 接口异常时用它兜底。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const PAGE_TIMEOUT_MS = 20000

/** 解析失败：只带代码 + 明细，文案交给渲染层（见 shared/types 的 FailureInfo） */
export class ResolveFailure extends Error {
  readonly code: string
  readonly detail: string

  constructor(code: string, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ResolveFailure'
    this.code = code
    this.detail = detail
  }
}

export interface RoomResolveResult {
  room: LiveRoomInfo
  /** 档位 → flv 地址（https） */
  flv: Partial<Record<QualityKey, string>>
  /** 解析时用的 Cookie（弹幕窗口自己会带自己的会话，这里只做记录） */
  cookie: string
}

export async function resolveLiveRoom(input: string): Promise<RoomResolveResult> {
  const webRid = parseWebRid(input)
  if (!webRid) throw new ResolveFailure('badInput', String(input ?? '').slice(0, 80))

  const page = await fetchPage(webRid)
  const roomId = pickRoomId(page.html)
  let entered: EnterResult | null = null
  if (roomId) entered = await tryEnter(webRid, roomId, page.cookie)
  if ((!entered || !entered.room) && roomId) {
    // 偶发空 body（风控/抖动）：换一份 Cookie 再试一次
    const retryPage = await fetchPage(webRid)
    const retryRoomId = pickRoomId(retryPage.html) ?? roomId
    entered = await tryEnter(webRid, retryRoomId, retryPage.cookie).catch(() => entered)
    if (entered && entered.room) return build(webRid, retryPage.cookie, entered)

    // enter 彻底没戏：用 HTML 里嵌的那份兜底
    const fromHtml = fromPageHtml(webRid, retryPage.html)
    if (fromHtml) return build(webRid, retryPage.cookie, fromHtml)
  }
  if (entered && entered.room) return build(webRid, page.cookie, entered)

  const fromHtml = fromPageHtml(webRid, page.html)
  if (fromHtml) return build(webRid, page.cookie, fromHtml)
  if (!roomId) throw new ResolveFailure('roomNotFound', webRid)
  throw new ResolveFailure('enterFailed', String(roomId))
}

/** 只解析出房间信息，不要拉流（弹幕窗口用不上） */
export async function fetchPage(webRid: string): Promise<{ html: string; cookie: string }> {
  let response: Response
  try {
    response = await fetch(`https://live.douyin.com/${webRid}`, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
    })
  } catch (error) {
    throw new ResolveFailure('network', describeError(error))
  }
  if (!response.ok) throw new ResolveFailure('pageFailed', `HTTP ${response.status}`)
  const cookie = readCookieHeader(response)
  const html = await response.text()
  if (!html) throw new ResolveFailure('pageFailed', 'empty body')
  return { html, cookie }
}

interface EnterResult {
  room: LiveRoomInfo
  flv: Partial<Record<QualityKey, string>>
}

async function tryEnter(
  webRid: string,
  roomId: string,
  cookie: string
): Promise<EnterResult | null> {
  // 参数表照抄 web 端：少一个字段接口会返回空 body（实测）
  const query = new URLSearchParams({
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
    room_id: roomId
  })
  let response: Response
  try {
    response = await fetch(`https://live.douyin.com/webcast/room/web/enter/?${query}`, {
      headers: {
        'user-agent': UA,
        cookie,
        referer: `https://live.douyin.com/${webRid}`,
        accept: 'application/json, text/plain, */*'
      },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
    })
  } catch (error) {
    throw new ResolveFailure('network', describeError(error))
  }
  if (!response.ok) throw new ResolveFailure('enterFailed', `HTTP ${response.status}`)
  const body = await response.text()
  if (!body) return null
  let json: EnterJson
  try {
    json = JSON.parse(body) as EnterJson
  } catch {
    return null
  }
  const room = json?.data?.data?.[0]
  if (!room) return null
  return {
    room: {
      webRid,
      roomId: String(room.id_str ?? roomId),
      title: String(room.title ?? ''),
      anchor: String(room.owner?.nickname ?? ''),
      onlineText: String(room.user_count_str ?? ''),
      status: mapStatus(room.status),
      cover: String(room.cover?.url_list?.[0] ?? '')
    },
    flv: pickStreams(room.stream_url?.flv_pull_url)
  }
}

function build(webRid: string, cookie: string, entered: EnterResult): RoomResolveResult {
  return { room: { ...entered.room, webRid }, flv: entered.flv, cookie }
}

/** 页面 HTML 里嵌着的同一份数据（enter 接口不可用时的兜底） */
function fromPageHtml(webRid: string, html: string): EnterResult | null {
  const unescaped = html.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\"/g, '"')
  const flv: Partial<Record<QualityKey, string>> = {}
  for (const key of QUALITY_KEYS) {
    const match = unescaped.match(new RegExp(`"${key}":"(https?:[^"]+?\\.flv[^"]*)"`))
    if (match) flv[key] = match[1]
  }
  const title = unescaped.match(/"title":"([^"]{0,120})"/)?.[1]
  const anchor = unescaped.match(/"nickname":"([^"]{0,60})"/)?.[1]
  const online = unescaped.match(/"user_count_str":"([^"]{0,20})"/)?.[1]
  if (!title && Object.keys(flv).length === 0) return null
  return {
    room: {
      webRid,
      roomId: pickRoomId(html) ?? '',
      title: title ?? '',
      anchor: anchor ?? '',
      onlineText: online ?? '',
      status: Object.keys(flv).length > 0 ? 'live' : 'ended',
      cover: ''
    },
    flv: upgradeStreams(flv)
  }
}

function pickRoomId(html: string): string | null {
  return (
    html.match(/\\?"roomId\\?":\\?"(\d{6,})\\?"/)?.[1] ??
    html.match(/room_id=(\d{6,})/)?.[1] ??
    null
  )
}

/** 拉流地址一律走 https（同域名同签名，实测可用；渲染层在 https/app 上下文里不怕混合内容） */
function upgradeStreams(map: Partial<Record<QualityKey, string>>): Partial<Record<QualityKey, string>> {
  const out: Partial<Record<QualityKey, string>> = {}
  for (const key of QUALITY_KEYS) {
    const url = map[key]
    if (url) out[key] = url.replace(/^http:/, 'https:')
  }
  return out
}

function pickStreams(raw: Record<string, string> | undefined): Partial<Record<QualityKey, string>> {
  const picked: Partial<Record<QualityKey, string>> = {}
  if (!raw) return picked
  for (const key of QUALITY_KEYS) {
    if (typeof raw[key] === 'string' && raw[key]) picked[key] = raw[key]
  }
  return upgradeStreams(picked)
}

function mapStatus(status: number | undefined): LiveRoomInfo['status'] {
  if (status === 2) return 'live'
  if (status === 4) return 'ended'
  return 'unknown'
}

function readCookieHeader(response: Response): string {
  const headers = response.headers as unknown as { getSetCookie?: () => string[] }
  const list =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : splitSetCookie(response.headers.get('set-cookie') ?? '')
  return list
    .map((entry) => entry.split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
}

/** set-cookie 合并头的老式拆法（只有拿不到 getSetCookie 时才用） */
function splitSetCookie(raw: string): string[] {
  if (!raw) return []
  return raw.split(/,(?=[^;,=]+=)/)
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'timeout'
    return error.message.slice(0, 120)
  }
  return String(error).slice(0, 120)
}

interface EnterJson {
  data?: {
    data?: Array<{
      id_str?: string
      title?: string
      status?: number
      user_count_str?: string
      cover?: { url_list?: string[] }
      owner?: { nickname?: string }
      stream_url?: { flv_pull_url?: Record<string, string> }
    }>
  }
}
