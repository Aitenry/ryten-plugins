import logger from 'electron-log'
import * as zlib from 'node:zlib'
import type { BrowserPage } from './browser-host'
import { BROWSER_UA, browserHost } from './browser-host'
import { findBrowser } from './browser-find'
import { RawWebSocket, WsHandshakeError } from './raw-ws'
import type { DanmakuItem, UserInfo } from '../../shared/types'
import { getBytes, readMessage } from './protobuf'
import { decodeProtoResponse } from './proto-messages'
import { giftCatalog } from '../gift/catalog'
import type { DanmakuHooks, DanmakuTarget } from './danmaku'

/**
 * 实时通道采集器：**主进程自己连抖音推送 ws**，签名由本机真实浏览器产生。
 *
 * 为什么不再开 Electron 隐藏窗口 / 不再纯 Node 算签名（2026-10 实测，`spike/gate-spike.mjs`）：
 * 抖音推送网关有**设备指纹闸**——用页面自己那条已签名的 ws URL 从纯 Node（tls 裸连）连接
 * **能返回 101 并收到全量帧**；但离线用 webmssdk 重算 signature 一律被 `DEVICE_BLOCKED` 拒，
 * 因为签名还依赖网页安全 SDK（secsdk/isaac）的运行时设备指纹，纯 Node 复刻不可行。
 *
 * 所以这里：**借本机已安装的 Chromium（Chrome/Edge/Brave/Chromium）**——无头 spawn 一个独立
 * 临时 profile 的浏览器进程，加载直播间页，用 CDP 抓页面那条推送 ws 的**完整 URL 与握手头**，
 * 再由**主进程自己**用 `RawWebSocket` 连上去、解码 `PushFrame`、整批上报。
 *
 * 契约与旧实现一致（`DanmakuHooks` / `start` / `stop` / `setTarget` / `connected`）：
 * 中枢据相位决定「用 ws 还是回落到 HTTP 轮询」（`danmaku.ts`），二者二选一，避免同一条消息记两次。
 *
 * 降级：找不到浏览器 → `noBrowser`（本会话放弃，HTTP 轮询接管）；浏览器起不来/页面没建 ws →
 * 退避重试。连续失败到上限即本会话放弃，弹幕与数据库不受影响。
 */

/** 推送 ws 的 URL 特征（老 `…/webcast/im/push/v2/` 与新 bytelink `…/bytelink/wss/` 两条都认） */
const PUSH_URL_MARKS = ['/webcast/im/push/', '/bytelink/wss/']
/** 等「页面把 ws 建起来」的死线 */
const START_TIMEOUT_MS = 25000
/** 建立成功后又长时间没有帧，视为掉线（页面可能被风控） */
const IDLE_TIMEOUT_MS = 120000
/** 失败退避阶梯 */
const RETRY_BACKOFF_MS = [4000, 8000, 16000, 30000, 60000]
/** 连续失败多少次就本会话放弃 */
const MAX_FAILURES = 5
/** 定时换一份新签名（页面 reload 触发重连），清掉累积状态 */
const SIGNATURE_REFRESH_MS = 10 * 60 * 1000
/** 推送消息普查的间隔（实时页空白时靠它定位服务端推了哪些消息） */
const METHOD_SUMMARY_MS = 2 * 60 * 1000

/** 抓到的「页面那条已签名推送 ws」：URL（含 signature）与抓到的时刻 */
interface SignedSocket {
  url: string
  at: number
}

export interface RoomSocketOptions {
  /** 显式指定的浏览器可执行文件路径（设置为空则自动发现） */
  browserPath?: string
}

export class RoomSocketCapture {
  private readonly hooks: DanmakuHooks
  private target: DanmakuTarget
  private readonly browserPath: string
  private page: BrowserPage | null = null
  private ws: RawWebSocket | null = null
  private stopped = true
  private connectedOnce = false
  private failures = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private signed: SignedSocket | null = null
  /** 正在等一条新的已签名 URL（reload 之后）——收到就发起连接 */
  private awaitingSignature = false
  private pageSession = ''
  private messages = 0
  private methods: Record<string, number> = {}
  private lastSummaryAt = 0

  constructor(target: DanmakuTarget, hooks: DanmakuHooks, options: RoomSocketOptions = {}) {
    this.target = target
    this.hooks = hooks
    this.browserPath = String(options.browserPath ?? '').trim()
  }

  get connected(): boolean {
    return this.connectedOnce
  }

  setTarget(target: DanmakuTarget): void {
    this.target = target
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connectedOnce = false
    this.failures = 0
    this.messages = 0
    this.methods = {}
    this.lastSummaryAt = Date.now()
    this.signed = null
    this.hooks.onStatus({ phase: 'connecting', failure: null })
    logger.info(`[douyin-link] ${this.target.webRid} 实时通道：借本机浏览器产生签名，主进程直连 ws`)
    void this.openSession()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.connectedOnce = false
    this.awaitingSignature = false
    this.clearTimers()
    this.closeWs()
    const page = this.page
    this.page = null
    this.signed = null
    if (page) void page.close()
  }

  /* --------------------------------------------------------------- 内部 */

  /** 起会话：找浏览器 → 开标签页 → 订阅事件 → 导航（等页面自己把推送 ws 建起来） */
  private async openSession(): Promise<void> {
    if (this.stopped) return
    const found = findBrowser(this.browserPath)
    if (!found) {
      // 没有可驱动的 Chromium：本会话放弃（HTTP 轮询接管）
      this.hooks.onStatus({ phase: 'error', failure: { code: 'noBrowser' } })
      logger.warn(`[douyin-link] ${this.target.webRid} 实时通道：未找到 Chrome/Edge/Chromium，改用 HTTP 轮询`)
      this.stop()
      return
    }
    try {
      await browserHost.ensure(found.path)
    } catch (error) {
      this.fail('browserLaunchFailed', describe(error))
      return
    }
    if (this.stopped) return
    try {
      const page = await browserHost.openPage()
      if (this.stopped) {
        void page.close()
        return
      }
      this.page = page
      this.pageSession = page.sessionId
      // 事件是浏览器级的（所有会话都推）：只认本标签页的
      page.on('Network.webSocketCreated', (params, sessionId) => {
        if (sessionId === this.pageSession) this.onSocketCreated(params)
      })
      await page.send('Network.enable')
      await page.send('Page.enable')
      await page.send('Page.navigate', { url: `https://live.douyin.com/${this.target.webRid}` })
      this.awaitingSignature = true
      this.armStartTimer()
    } catch (error) {
      this.fail('browserLaunchFailed', describe(error))
    }
  }

  /**
   * 页面建了一条 ws：若是推送 ws，就抓下它的完整 URL（含 signature），改由主进程直连。
   *
   * 用 `Network.webSocketCreated` 而不是 `…WillSendHandshakeRequest`：实测后者在当前 Chrome 里
   * `request.url` 是空的，而前者给的就是**带着 signature 的完整 URL**（spike 已证可直连）。
   */
  private onSocketCreated(params: Record<string, unknown>): void {
    if (this.stopped) return
    const url = String(params.url ?? '')
    if (!isPushUrl(url)) return
    this.signed = { url, at: Date.now() }
    if (this.startTimer) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }
    logger.info(`[douyin-link] ${this.target.webRid} 实时通道：页面已建推送 ws，改由主进程直连`)
    void this.connectMainWs()
  }

  /** 主进程自己连那条已签名的推送 ws（握手头自建：Origin + UA + Cookie） */
  private async connectMainWs(): Promise<void> {
    if (this.stopped || !this.signed) return
    if (this.ws) return // 已在连/已连上
    this.awaitingSignature = false
    const url = this.signed.url
    const headers: Record<string, string> = {
      Origin: 'https://live.douyin.com',
      // 签名与 UA 绑定：必须用**浏览器同款** UA（见 browser-host 的 BROWSER_UA）
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    }
    try {
      const res = (await this.page?.send('Network.getCookies', {
        urls: [`https://live.douyin.com/${this.target.webRid}`]
      })) as { cookies?: Array<{ name: string; value: string }> } | undefined
      const cookie = (res?.cookies ?? []).map((c) => `${c.name}=${c.value}`).join('; ')
      if (cookie) headers.Cookie = cookie
    } catch {
      /* 拿不到 Cookie 也试：抖音推送 ws 主要靠 URL 里的 signature */
    }
    if (this.stopped) return
    const ws = new RawWebSocket(url, { headers })
    this.ws = ws
    ws.onopen = () => logger.info(`[douyin-link] ${this.target.webRid} 实时通道：主进程 ws 握手 101`)
    ws.onmessage = (data, isBinary) => {
      if (isBinary) this.onBinaryFrame(data)
    }
    ws.onerror = (error) => {
      if (error instanceof WsHandshakeError) {
        // 签名过期/被拒：reload 换一份新的，再重连
        logger.warn(`[douyin-link] ${this.target.webRid} 实时通道：握手被拒（${error.handshakeMsg || error.status}）`)
        this.onLost('handshakeRejected')
      } else {
        logger.warn(`[douyin-link] ${this.target.webRid} 实时通道：ws 错误 ${error.message}`)
      }
    }
    ws.onclose = (reason) => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.stopped) return
      // 已经收到过帧且没有 error 分支处理过：当作掉线重连
      this.onLost(`closed ${reason}`)
    }
  }

  /** 一帧二进制 PushFrame：解出内层 WebcastResponse，整批上报（弹幕/进场/…/麦位） */
  private onBinaryFrame(payloadData: Buffer): void {
    let frame: ReturnType<typeof readMessage>
    try {
      frame = readMessage(payloadData)
    } catch {
      return
    }
    let body = getBytes(frame, 8)
    if (!body || body.length === 0) return
    if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
      try {
        body = zlib.gunzipSync(body)
      } catch {
        return
      }
    }

    let items: DanmakuItem[] = []
    let users: UserInfo[] = []
    let roomEnded = false
    let micUserIds: string[] | null = null
    try {
      const batch = decodeProtoResponse(body, giftCatalog).batch
      items = batch.items
      users = batch.users
      roomEnded = batch.roomEnded
      micUserIds = batch.micUserIds
      this.noteMethods(batch.methods)
    } catch (error) {
      logger.warn(`[douyin-link] ${this.target.webRid} 实时帧解码失败:`, describe(error))
      return
    }

    if (!this.connectedOnce) {
      this.connectedOnce = true
      this.failures = 0
      this.clearStartTimer()
      logger.info(`[douyin-link] ${this.target.webRid} 实时通道：已连上（开始截取推送帧）`)
      this.hooks.onStatus({ phase: 'live', failure: null })
      this.armRefreshTimer()
    }
    this.armIdleTimer()

    if (micUserIds && micUserIds.length > 0) this.hooks.onMic(micUserIds)
    if (items.length > 0 || users.length > 0) {
      this.messages += items.length
      this.hooks.onItems(items, users, { roomEnded })
    }
  }

  /** 掉线/被拒：换一份新签名（reload 页面触发页面重连）再重试 */
  private onLost(reason: string): void {
    if (this.stopped) return
    this.closeWs()
    this.connectedOnce = false
    this.armIdleTimerReset()
    this.hooks.onStatus({ phase: 'retrying', failure: { code: 'realtimeChannelLost', detail: reason.slice(0, 80) } })
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    this.failures += 1
    if (this.failures > MAX_FAILURES) {
      logger.warn(`[douyin-link] ${this.target.webRid} 实时通道连续失败 ${this.failures - 1} 次，本会话放弃（弹幕不受影响）`)
      this.hooks.onStatus({ phase: 'error', failure: { code: 'realtimeChannelLost' } })
      this.stop()
      return
    }
    const backoff = RETRY_BACKOFF_MS[Math.min(this.failures - 1, RETRY_BACKOFF_MS.length - 1)]
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.stopped) return
      void this.refreshSignature()
    }, backoff)
  }

  /** reload 页面 → 页面重新建推送 ws → 抓到新的已签名 URL（`onHandshake` 会接着连） */
  private async refreshSignature(): Promise<void> {
    if (this.stopped) return
    if (!this.page) {
      void this.openSession()
      return
    }
    try {
      this.signed = null
      this.awaitingSignature = true
      this.armStartTimer()
      await this.page.send('Page.reload', { ignoreCache: false })
    } catch (error) {
      this.fail('browserLaunchFailed', describe(error))
    }
  }

  /** 起不来就退避重试；找不到浏览器是永久失败（由 openSession 直接停） */
  private fail(code: string, detail: string): void {
    if (this.stopped) return
    logger.warn(`[douyin-link] ${this.target.webRid} 实时通道失败（${code} ${detail.slice(0, 120)}）`)
    this.hooks.onStatus({ phase: 'retrying', failure: { code, detail: detail.slice(0, 160) } })
    this.scheduleRetry()
  }

  private noteMethods(methods: Record<string, number>): void {
    for (const [method, count] of Object.entries(methods)) {
      this.methods[method] = (this.methods[method] ?? 0) + count
    }
    if (Date.now() - this.lastSummaryAt < METHOD_SUMMARY_MS) return
    this.lastSummaryAt = Date.now()
    const list = Object.entries(this.methods)
      .sort((a, b) => b[1] - a[1])
      .map(([method, count]) => `${method.replace(/^Webcast/, '')}=${count}`)
      .join(' ')
    logger.info(`[douyin-link] ${this.target.webRid} 实时通道推送过的消息：${list || '（一条都没有）'}`)
    this.methods = {}
  }

  private closeWs(): void {
    const ws = this.ws
    this.ws = null
    if (ws) ws.close()
  }

  private armStartTimer(): void {
    this.clearStartTimer()
    this.startTimer = setTimeout(() => {
      this.startTimer = null
      if (this.stopped || this.ws || this.connectedOnce) return
      this.fail('noSignedUrl', '页面未建立推送 ws')
    }, START_TIMEOUT_MS)
  }

  private clearStartTimer(): void {
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.stopped) this.onLost('idle')
    }, IDLE_TIMEOUT_MS)
  }

  private armIdleTimerReset(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private armRefreshTimer(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      if (!this.stopped) void this.refreshSignature()
    }, SIGNATURE_REFRESH_MS)
  }

  private clearTimers(): void {
    for (const key of ['retryTimer', 'idleTimer', 'startTimer', 'refreshTimer'] as const) {
      const timer = this[key]
      if (timer) clearTimeout(timer)
      this[key] = null
    }
  }
}

function isPushUrl(url: string): boolean {
  return PUSH_URL_MARKS.some((mark) => url.includes(mark))
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 160)
  return String(error).slice(0, 160)
}