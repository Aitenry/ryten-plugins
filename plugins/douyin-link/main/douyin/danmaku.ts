import logger from 'electron-log'
import type { DanmakuItem, DanmakuPhase, FailureInfo, UserInfo } from '../../shared/types'
import { decodePushBatch, parseJsonLoose, type JsonDecodedBatch } from './json'
import { decodeProtoResponse } from './proto-messages'

/**
 * 弹幕采集器：**主进程自己 GET `/webcast/im/fetch/`**，不再建隐藏窗口。
 *
 * 为什么换掉「隐藏窗口 + CDP 截 ws 帧」（上一版的做法）：
 * 那条路的全部麻烦都来自「ws 推送要 signature」——而 signature 只有页面里那份混淆的
 * webmssdk 算得出来（而且要有真浏览器的设备指纹与 msToken 才不是占位值），于是只能开窗口借
 * 页面自己的连接。实测（2026-10）：
 * - `wss://…/webcast/im/push/v2/` 即使带上同样的 Cookie 也只会拿到 **200 空响应**
 *   （试遍了各家域名、两种 webcast_sdk_version、以及照 IM SDK 原样拼的
 *   `signature = frontierSign({'X-MS-STUB': md5(param 串)})['X-Bogus']` 都一样）；
 * - 官方推送地址是**服务端下发**的（`push_server` + `route_params`，只在页面那套签名流程的
 *   protobuf 响应里给），我们自己拉到的响应里 `internal_ext` 永远是 `wss_info:0-0-0-0`
 *   ——即「没给我们分配推送节点」；
 * - 但 HTTP 的 `GET /webcast/im/fetch/` **不需要 signature**：一份 ttwid Cookie + 一组
 *   固定参数就能拿到 `{data:[…], extra:{cursor, fetch_interval, now}, internal_ext}`，
 *   而且 `cursor`/`internal_ext` 带上就继续增量推送——这就是主进程能独立收全量的原因。
 *
 * 于是采集变成：**主进程按服务端给的间隔轮询**（`fetch_interval`，实测 1000ms）。
 *
 * ⚠️ 限流（这是实测踩过的坑）：**1 秒一次连着跑会被风控**，接口开始回
 * `HTTP 503`（用户 2026-10 遇到的「接口返回异常状态码：HTTP 503」就是这个）。
 * 503 是「慢一点、等会再来」，不是「挂了」，所以这里：
 * - 503 / 429 → 单独的 `throttled` 状态 + 指数退避（5s→10s→20s→40s→60s 封顶），
 *   并且**把该房间的轮询下限抬上去**（自适应节流：被限流就慢一档，连续顺畅再慢慢降回来）；
 * - 其它失败才按「连续 3 次」判死（交回中枢重解析换新 Cookie）。
 *
 * 与上一版一致的对外契约：`onItems` / `onStatus`，另外多一个 `onMic`
 * ——聊天室的麦位表随推送一起来（`RoomLinkmicMicDisplayInfoSyncData`）。
 *
 * 省流量这件事不再需要设置项：没有窗口就没有画面，压根不会去拉 flv/m3u8。
 */

/** 单次请求的死线（轮询是长期动作，一次卡住不该拖住整条链路） */
const POLL_TIMEOUT_MS = 15000
/** 轮询间隔的钳制范围（服务端给 1000ms；再快没必要，再慢会积压） */
const MIN_INTERVAL_MS = 1200
const MAX_INTERVAL_MS = 5000
/** 被限流时该房间的轮询下限能抬到多少（自适应节流的天花板） */
const MAX_THROTTLE_FLOOR_MS = 15000
/** 被限流后的退避阶梯（毫秒） */
const THROTTLE_BACKOFF_MS = [5000, 10000, 20000, 40000, 60000]
/** 连续顺畅多少轮之后，把抬高的下限降回来 */
const RELAX_AFTER_SUCCESS = 20
/** 诊断汇总的间隔：「接口到底推了哪些消息」按这个节奏写一条日志（实时页空白时靠它定位） */
const METHOD_SUMMARY_MS = 5 * 60 * 1000
/** 其它失败连续多少次算「这条通道不行了」（之后交给中枢重试：会重新解析房间换新 Cookie） */
const FATAL_FAILURES = 3
/** 失败后的退避基数 */
const BACKOFF_BASE_MS = 2000

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export interface DanmakuTarget {
  webRid: string
  /** 内部房间 id（webcast 接口用的长 id） */
  roomId: string
  /** 进房时拿到的 Cookie（ttwid 必需） */
  cookie: string
}

export interface DanmakuHooks {
  /** 一批消息 + 这批里出现的用户静态信息（交给用户档案库聚合） */
  onItems: (items: DanmakuItem[], users: UserInfo[], meta: { roomEnded: boolean }) => void
  /** 在麦上的用户（按麦位顺序；聊天室才有） */
  onMic: (userIds: string[]) => void
  onStatus: (status: { phase: DanmakuPhase; failure: FailureInfo | null }) => void
}

interface PollResult {
  messages: unknown[]
  /** protobuf 模式下的原始报文（与 `messages` 二选一） */
  proto: Buffer | null
  cursor: string
  internalExt: string
  intervalMs: number
  /** 服务端下发的推送地址（protobuf 才给；后续尝试升级到 websocket 用） */
  pushServer: string
  fetchType: number
}

/** 带失败码的轮询错误（`code` 直接给界面翻文案） */
class PollError extends Error {
  readonly code: string
  readonly detail: string
  /** 是否属于「被限流」（503/429）：这类不该判死，只该慢下来 */
  readonly throttled: boolean

  constructor(code: string, detail = '', throttled = false) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'PollError'
    this.code = code
    this.detail = detail
    this.throttled = throttled
  }
}

export class DanmakuCollector {
  private readonly hooks: DanmakuHooks
  private target: DanmakuTarget
  private stopped = true
  private running = false
  private connectedOnce = false
  private failures = 0
  private cursor = ''
  private internalExt = ''
  private intervalMs = MIN_INTERVAL_MS
  /** 被限流抬高的轮询下限（自适应节流；顺畅一段时间后慢慢降回 MIN_INTERVAL_MS） */
  private floorMs = MIN_INTERVAL_MS
  /** 连续被限流的次数（决定退避阶梯） */
  private throttles = 0
  /** 连续顺畅的轮数（用于把抬高的下限降回来） */
  private smoothRounds = 0
  /** 诊断计数（见 METHOD_SUMMARY_MS） */
  private pollsDone = 0
  private itemsDone = 0
  private methods: Record<string, number> = {}
  private lastSummaryAt = Date.now()
  private loggedFirstBatch = false
  /** 服务端下发的推送地址（protobuf 响应里才有；记录一次，供日志与后续 ws 升级用） */
  private pushServer = ''
  private wakeup: (() => void) | null = null

  constructor(target: DanmakuTarget, hooks: DanmakuHooks) {
    this.target = target
    this.hooks = hooks
  }

  /** 推送通道是否已经成功拉到过数据（界面上的「已连接」） */
  get connected(): boolean {
    return this.connectedOnce
  }

  /** 换一份 Cookie / 房间 id（重解析之后） */
  setTarget(target: DanmakuTarget): void {
    this.target = target
  }

  start(): void {
    if (this.running) return
    this.stopped = false
    this.running = true
    this.connectedOnce = false
    this.failures = 0
    this.throttles = 0
    this.smoothRounds = 0
    this.floorMs = MIN_INTERVAL_MS
    this.pollsDone = 0
    this.itemsDone = 0
    this.methods = {}
    this.lastSummaryAt = Date.now()
    this.loggedFirstBatch = false
    this.cursor = ''
    this.internalExt = ''
    this.intervalMs = MIN_INTERVAL_MS
    this.hooks.onStatus({ phase: 'connecting', failure: null })
    logger.info(`[douyin-link] 弹幕通道开始轮询（房间 ${this.target.webRid} / ${this.target.roomId}）`)
    void this.loop()
  }

  stop(): void {
    this.stopped = true
    this.running = false
    this.connectedOnce = false
    const wake = this.wakeup
    this.wakeup = null
    if (wake) wake()
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let waitMs = 0
      try {
        const result = await this.poll()
        if (this.stopped) return
        this.failures = 0
        this.smoothRounds += 1
        if (this.smoothRounds >= RELAX_AFTER_SUCCESS && this.floorMs > MIN_INTERVAL_MS) {
          // 顺畅够久了：把自适应抬高的下限降一档（不一次降到底，免得又撞限流）
          this.floorMs = Math.max(MIN_INTERVAL_MS, Math.round(this.floorMs / 2))
          this.smoothRounds = 0
          this.throttles = 0
          logger.info(`[douyin-link] ${this.target.webRid} 轮询顺畅，间隔下限降到 ${this.floorMs}ms`)
        }
        this.cursor = result.cursor || this.cursor
        this.internalExt = result.internalExt || this.internalExt
        this.intervalMs = clampInterval(result.intervalMs)
        if (result.pushServer && result.pushServer !== this.pushServer) {
          this.pushServer = result.pushServer
          logger.info(
            `[douyin-link] ${this.target.webRid} 服务端下发推送地址：${this.pushServer}` +
              `（fetch_type=${result.fetchType}${result.fetchType === 1 ? ' = 建议走 websocket' : ''}）`
          )
        }
        if (!this.connectedOnce) {
          this.connectedOnce = true
          logger.info(`[douyin-link] 弹幕通道已连上（房间 ${this.target.webRid}）`)
          this.hooks.onStatus({ phase: 'live', failure: null })
        } else if (this.throttles > 0) {
          // 从限流里恢复：把相位与失败提示收回去
          this.throttles = 0
          this.hooks.onStatus({ phase: 'live', failure: null })
        }
        this.consume(result)
        waitMs = jittered(Math.max(this.floorMs, this.intervalMs))
      } catch (error) {
        if (this.stopped) return
        const failure = toFailure(error)
        /**
         * 限流（503/429）：**不判死**。
         * 这是「慢一点」，服务端一直在回同一个 503 也不代表房间没了——
         * 所以只退避、只把该房间的下限抬一档，然后继续；界面看到的是 `retrying + throttled`。
         */
        if (isThrottled(error)) {
          this.throttles += 1
          this.smoothRounds = 0
          this.floorMs = Math.min(MAX_THROTTLE_FLOOR_MS, Math.round(this.floorMs * 2))
          const backoff = THROTTLE_BACKOFF_MS[Math.min(this.throttles - 1, THROTTLE_BACKOFF_MS.length - 1)]
          logger.warn(
            `[douyin-link] ${this.target.webRid} 被限流（${failure.detail ?? failure.code}），` +
              `${Math.round(backoff / 1000)}s 后重试，间隔下限抬到 ${this.floorMs}ms`
          )
          this.hooks.onStatus({ phase: 'retrying', failure })
          waitMs = backoff
        } else {
          this.failures += 1
          if (this.failures >= FATAL_FAILURES) {
            logger.warn(
              `[douyin-link] 弹幕通道连不上（房间 ${this.target.webRid}，连续 ${this.failures} 次）:`,
              failure.code,
              failure.detail ?? ''
            )
            this.hooks.onStatus({ phase: 'error', failure })
            this.running = false
            return
          }
          logger.warn(
            `[douyin-link] 弹幕拉取失败（房间 ${this.target.webRid}，第 ${this.failures} 次）:`,
            failure.code,
            failure.detail ?? ''
          )
          this.hooks.onStatus({ phase: 'retrying', failure })
          waitMs = Math.min(MAX_INTERVAL_MS * 2, BACKOFF_BASE_MS * this.failures)
        }
      }
      await this.sleep(waitMs)
    }
  }

  /**
   * 拉一次。**带上上次拿到的 cursor / internal_ext** 就是增量（服务端只回新的），
   * 不带则是「从现在开始」——所以重连后不会重复补发旧消息。
   */
  private async poll(): Promise<PollResult> {
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
      web_rid: this.target.webRid,
      room_id: this.target.roomId,
      did_rule: '3',
      debug: 'false',
      endpoint: 'live_pc',
      support_wrds: '1',
      im_path: '/webcast/im/fetch/',
      /**
       * **必须是 protobuf**：JSON（默认）只回房间级消息（`RoomMessage`/`RoomDataSyncMessage`），
       * 用户消息（进场/弹幕/在线人数）一条都没有——「实时」页空白就是这个原因；
       * 而且只有 protobuf 响应里才带服务端下发的 `push_server`（websocket 升级要用）。
       */
      resp_content_type: 'protobuf',
      fetch_rule: '1',
      last_rtt: '0',
      user_unique_id: '',
      timestamp: String(Date.now())
    })
    if (this.cursor) query.set('cursor', this.cursor)
    if (this.internalExt) query.set('internal_ext', this.internalExt)

    let response: Response
    try {
      response = await fetch(`https://live.douyin.com/webcast/im/fetch/?${query}`, {
        method: 'GET',
        headers: {
          'user-agent': CHROME_UA,
          cookie: this.target.cookie,
          referer: `https://live.douyin.com/${this.target.webRid}`,
          accept: 'application/x-protobuf, */*',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
        },
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS)
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new PollError(detail.includes('timeout') ? 'timeout' : 'network', detail.slice(0, 120))
    }
    if (!response.ok) {
      // 503/429 = 被限流（不是房间没了）：标成 throttled，调用方只退避、不判死
      const throttled = response.status === 503 || response.status === 429
      throw new PollError(
        throttled ? 'throttled' : 'httpError',
        `HTTP ${response.status}`,
        throttled
      )
    }
    const raw = Buffer.from(await response.arrayBuffer())
    if (raw.length === 0) throw new PollError('badResponse', 'empty body')

    // protobuf 与 JSON 两种可能的回包都认（服务端偶尔会忽略 resp_content_type）
    if (raw[0] !== 0x7b) {
      const decoded = decodeProtoResponse(raw)
      return {
        messages: [],
        proto: raw,
        cursor: decoded.cursor,
        internalExt: decoded.internalExt,
        intervalMs: decoded.intervalMs > 0 ? decoded.intervalMs : this.intervalMs,
        pushServer: decoded.pushServer,
        fetchType: decoded.fetchType
      }
    }

    let body: {
      data?: unknown
      extra?: { cursor?: unknown; fetch_interval?: unknown }
      internal_ext?: unknown
      status_code?: unknown
    }
    try {
      body = parseJsonLoose(raw.toString('utf8'))
    } catch (error) {
      throw new PollError('badResponse', error instanceof Error ? error.message.slice(0, 80) : 'parse')
    }
    const status = Number(body?.status_code ?? 0)
    if (status !== 0) {
      // 20003 = 没登录（Cookie 失效）；其它也一律当作「要换一份 Cookie 再来」
      const detail = typeof body?.data === 'object' && body.data ? JSON.stringify(body.data).slice(0, 120) : ''
      throw new PollError(status === 20003 ? 'sessionExpired' : 'rejected', `${status}${detail ? ' ' + detail : ''}`)
    }
    const intervalRaw = Number((body?.extra as { fetch_interval?: unknown })?.fetch_interval ?? 0)
    return {
      messages: Array.isArray(body?.data) ? body.data : [],
      proto: null,
      cursor: typeof body?.extra?.cursor === 'string' ? body.extra.cursor : '',
      internalExt: typeof body?.internal_ext === 'string' ? body.internal_ext : '',
      intervalMs: intervalRaw > 0 ? intervalRaw : this.intervalMs,
      pushServer: '',
      fetchType: 0
    }
  }

  /** 解一批消息并上报（解码在 ./json.ts 与 ./proto-messages.ts；单条解不动不影响这一批的其它消息） */
  private consume(result: PollResult): void {
    const decoded: JsonDecodedBatch = result.proto
      ? decodeProtoResponse(result.proto).batch
      : result.messages.length > 0
        ? decodePushBatch(result.messages)
        : { items: [], users: [], roomEnded: false, micUserIds: null, methods: {} }
    if (Object.keys(decoded.methods).length > 0) this.pollsDone += 1
    for (const [method, count] of Object.entries(decoded.methods)) {
      this.methods[method] = (this.methods[method] ?? 0) + count
    }
    this.itemsDone += decoded.items.length
    if (!this.loggedFirstBatch && decoded.items.length > 0) {
      this.loggedFirstBatch = true
      logger.info(
        `[douyin-link] ${this.target.webRid} 首批消息已解出：${decoded.items.length} 条（${decoded.items
          .map((item) => item.kind)
          .join(',')}），带用户信息 ${decoded.users.length} 人`
      )
    }
    if (Date.now() - this.lastSummaryAt >= METHOD_SUMMARY_MS) {
      this.lastSummaryAt = Date.now()
      const list = Object.entries(this.methods)
        .sort((a, b) => b[1] - a[1])
        .map(([method, count]) => `${method.replace(/^Webcast/, '')}=${count}`)
        .join(' ')
      logger.info(
        `[douyin-link] ${this.target.webRid} 近 ${Math.round(METHOD_SUMMARY_MS / 60000)} 分钟：` +
          `轮询 ${this.pollsDone} 次、解出 ${this.itemsDone} 行；接口推过的消息：${list || '（一条都没有）'}`
      )
      this.pollsDone = 0
      this.itemsDone = 0
      this.methods = {}
    }
    if (decoded.micUserIds && decoded.micUserIds.length > 0) this.hooks.onMic(decoded.micUserIds)
    if (decoded.items.length > 0 || decoded.users.length > 0) {
      this.hooks.onItems(decoded.items, decoded.users, { roomEnded: decoded.roomEnded })
    }
  }

  /** 可被 `stop()` 立刻打断的等待 */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeup = null
        resolve()
      }, ms)
      this.wakeup = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }
}

function clampInterval(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return MIN_INTERVAL_MS
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms)))
}

/** 抖一下（多房间同刻启动时，别让所有房间在同一毫秒一起打接口） */
function jittered(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2))
}

function toFailure(error: unknown): FailureInfo {
  if (error instanceof PollError) return { code: error.code, detail: error.detail || undefined }
  return { code: 'pollFailed', detail: describe(error) }
}

/** 是不是「被限流」（503/429）：这类只退避，不判死 */
function isThrottled(error: unknown): boolean {
  return error instanceof PollError && error.throttled
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 160)
  return String(error).slice(0, 160)
}