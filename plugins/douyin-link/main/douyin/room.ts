import type { LiveRoomInfo, QualityKey, UserInfo } from '../../shared/types'
import { QUALITY_KEYS, parseWebRid } from '../../shared/types'
import { parseUserJson } from './json'

/**
 * 直播间解析：网页房间号 → 直播间信息 + 音频流地址。
 *
 * 两步（都在主进程做：渲染层跨域拿不到 live.douyin.com 的 HTML 和 ttwid Cookie）：
 * 1. GET https://live.douyin.com/<webRid> —— 拿到 ttwid Cookie（接口要它）+ HTML（里面嵌着 roomId）；
 * 2. GET /webcast/room/web/enter/ —— 拿标题、主播、在线人数、拉流地址、房间成员名单。
 *
 * 实测要点（2026-01 抓的真机数据）：
 * - enter 接口**不需要 signature**，但参数必须带全（少一个 web_rid 之外的字段会返回**空 body**），
 *   所以参数表按 web 端原样照抄；
 * - 拉流地址是 http，html5 侧一律升成 https（同一域名同一签名，实测都能拉）；
 * - 页面 HTML 里也有一份同样的 stream_url，enter 接口异常时用它兜底。
 *
 * 2026-10 新增两件（都是为了「在线观众 / 麦上用户」）：
 * - `admin_user_ids_str`：房间成员名单（固定 30 位；实测几分钟内不随观众进出变化，
 *   所以它不是「正在看的人」，但它是接口唯一稳定给出的用户 id 列表，界面上标成「成员」）；
 * - `linker_detail.function_type`：`radio` = 语音聊天室（有麦位）；
 *   兜底判据是拉流地址里的 `/radio/` 路径（实测这两个聊天室的 flv 就在该路径下）。
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
  /** 解析时用的 Cookie（推送给 `im/fetch` 的轮询要用它） */
  cookie: string
  /** 房间成员名单（接口给的，最多 30 位；解析失败时空数组） */
  roomUserIds: string[]
  /** 主播的 User（能解出来就带上，用来把主播放进用户库/在线观众里） */
  anchorUser: UserInfo | null
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

/** 只解析出房间信息与 Cookie，不要拉流（用来拿进房凭证与房间成员名单） */
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
  roomUserIds: string[]
  anchorUser: UserInfo | null
}

/** 只打 enter 接口（用于监控期间的轻量刷新：房间成员名单、在线人数、标题、开播状态） */
export async function enterLiveRoom(webRid: string, roomId: string, cookie: string): Promise<EnterResult> {
  const entered = await tryEnter(webRid, roomId, cookie)
  if (!entered) throw new ResolveFailure('enterFailed', roomId)
  return entered
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
  const flv = pickStreams(room.stream_url?.flv_pull_url)
  const memberIds = (room.admin_user_ids_str ?? [])
    .map((id) => String(id ?? '').trim())
    .filter((id) => /^\d{4,}$/.test(id))
  return {
    room: {
      webRid,
      roomId: String(room.id_str ?? roomId),
      title: String(room.title ?? ''),
      anchor: String(room.owner?.nickname ?? ''),
      onlineText: String(room.user_count_str ?? ''),
      status: mapStatus(room.status),
      cover: String(room.cover?.url_list?.[0] ?? ''),
      voice: isVoiceRoom(room, flv)
    },
    flv,
    roomUserIds: memberIds,
    anchorUser: parseUserJson(room.owner)
  }
}

/** 语音/聊天室：`linker_detail.function_type = radio`，兜底看拉流路径里的 `/radio/` */
function isVoiceRoom(room: EnterRoom, flv: Partial<Record<QualityKey, string>>): boolean {
  const functionType = String(room.linker_detail?.function_type ?? '').toLowerCase()
  if (functionType === 'radio' || functionType === 'voice') return true
  for (const url of Object.values(flv)) if (url && /\/radio\//.test(url)) return true
  return false
}

function build(webRid: string, cookie: string, entered: EnterResult): RoomResolveResult {
  return {
    room: { ...entered.room, webRid },
    flv: entered.flv,
    cookie,
    roomUserIds: entered.roomUserIds,
    anchorUser: entered.anchorUser
  }
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
      cover: '',
      voice: Object.values(flv).some((url) => /\/radio\//.test(url))
    },
    flv: upgradeStreams(flv),
    roomUserIds: [],
    anchorUser: null
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
  data?: { data?: EnterRoom[] }
}

/** enter 返回里我们真的会读的字段（其余原样忽略） */
interface EnterRoom {
  id_str?: string
  title?: string
  status?: number
  user_count_str?: string
  cover?: { url_list?: string[] }
  /** 主播的 User（结构完整的一份，交给 `parseUserJson` 解） */
  owner?: Record<string, unknown>
  /** 房间成员名单（精确 id；`admin_user_ids` 那份是丢精度的数字版，不用） */
  admin_user_ids_str?: string[]
  linker_detail?: { function_type?: string }
  /** 拉流地址：`{ FULL_HD1: 'http://…flv?…' }` */
  stream_url?: { flv_pull_url?: Record<string, string> }
}
