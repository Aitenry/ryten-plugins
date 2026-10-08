import { BrowserWindow } from 'electron'
import logger from 'electron-log'
import * as zlib from 'node:zlib'
import type { DanmakuItem, UserInfo } from '../../shared/types'
import { getBytes, readMessage } from './protobuf'
import { decodeProtoResponse } from './proto-messages'
import { giftCatalog } from '../gift/catalog'
import type { DanmakuHooks, DanmakuTarget } from './danmaku'

/**
 * 实时通道采集器：**借直播间页面自己的 websocket** 拿逐条消息。
 *
 * 为什么必须借页面（而不是主进程直连 ws）：
 * 抖音的推送网关 `wss://…/webcast/im/push/v2/` 有**设备指纹闸**——用合成的 ttwid 直连，
 * 无论签名对不对，握手都会被回 `Handshake-Msg: DEVICE_BLOCKED`（实测 2026-10，
 * 见 `spike/sign-spike.mjs`）。只有真正浏览器上下文里那份 `tt_webid` 设备身份能过闸。
 * 所以这里创建一个**隐藏窗口**（不显示、静音、拦掉视频流）加载直播间页，让页面自己把
 * ws 连上，再用 CDP 截取 `Network.webSocketFrameReceived` 的二进制帧。
 *
 * 上报范围：**整批**（弹幕/进场/点赞/关注/人数/麦位都在），因为 ws 帧里就是完整的
 * `WebcastResponse`。它连上时中枢会**暂停 HTTP 轮询**（`./danmaku`）——二者二选一，避免同一条消息
 * 被两个来源各记一次；ws 断了中枢再把 HTTP 轮询接回来。
 *
 * 两条通道**收到的消息并不完全一样**（2026-10 实测，`spike/live-probe.mjs` 走 HTTP、
 * `spike/ws-spike.mjs` 走页面 ws）：语音房的点歌（`WebcastLinkmicOrderSingMessage`）两边都推
 * （msgId 能对上）；而真正的 `WebcastGiftMessage` 在 HTTP 420s + ws 79 帧/100s 的样本里
 * **一条都没出现过**（房间里却肉眼能看到「X 送了…」，那是点歌）。所以礼物这一类**不能只押在 ws 上**，
 * 两个解码器都得留（见 `./proto-messages.ts`）。
 *
 * 帧结构与复用：ws 帧是 `PushFrame`（`payload` 在字段 8，常态 gzip），
 * 解压后就是**同一份 `WebcastResponse`**——直接交给 `decodeProtoResponse`，与 HTTP 走同一套解码。
 *
 * 降级契约：本类实现与 `DanmakuCollector` 相同的对外接口（start/stop/setTarget/connected +
 * onItems/onMic/onStatus）。中枢据它的相位决定「用 ws 还是回落到 HTTP 轮询」；
 * 连续失败即本会话放弃，窗口在 `stop()` 里彻底销毁。
 */

/**
 * 推送 ws 的 URL 特征（用来从页面所有 ws 里挑出弹幕推送那一条）。
 * 抖音现在有两套：老的 `…/webcast/im/push/v2/`，以及新的 bytelink `…/bytelink/wss/v1/`
 * （页面默认 props 里就是 bytelink 那套），两条都认。
 */
const PUSH_URL_MARKS = ['/webcast/im/push/', '/bytelink/wss/']

function isPushUrl(url: string): boolean {
  return PUSH_URL_MARKS.some((mark) => url.includes(mark))
}
/** 等「页面把 ws 建起来」的死线 */
const START_TIMEOUT_MS = 20000
/** 建立成功后又长时间没有帧，视为掉线（页面可能被风控） */
const IDLE_TIMEOUT_MS = 120000
/** 失败退避阶梯 */
const RETRY_BACKOFF_MS = [4000, 8000, 16000, 30000, 60000]
/** 连续失败多少次就本会话放弃 */
const MAX_FAILURES = 5
/**
 * 隐藏窗口的定期刷新间隔。
 *
 * 为什么必须刷新：窗口里跑的是**整张抖音直播 SPA**（React + webmssdk + 埋点 + 播放器逻辑），
 * 跑久了 JS 堆/定时器只涨不消；实测「一开始不卡、后面越来越卡」就是它在后台跟音频解码/调度抢 CPU。
 * 定期把页面重启一次（ws 会自动重连），就能把累积状态清掉——代价是刷新那一两秒的消息由 HTTP 轮询顶着。
 */
const PAGE_RELOAD_MS = 10 * 60 * 1000
/** 隐藏窗口的尺寸（小一点，只为了跑 JS；不显示） */
const WINDOW_WIDTH = 480
const WINDOW_HEIGHT = 320
/** 推送消息普查的间隔（「这条通道到底推了哪些消息」——实时页空白时靠它定位） */
const METHOD_SUMMARY_MS = 2 * 60 * 1000

interface CdpMessage {
  requestId?: string
  url?: string
  response?: { opcode?: number; payloadData?: string }
}

export class RoomSocketCapture {
  private readonly hooks: DanmakuHooks
  private target: DanmakuTarget
  private win: BrowserWindow | null = null
  private stopped = true
  private connectedOnce = false
  private failures = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private reloadTimer: ReturnType<typeof setTimeout> | null = null
  /** CDP 只给 requestId，URL 要自己用 webSocketCreated 记下来 */
  private readonly sockets = new Map<string, string>()
  private messages = 0
  /** 本会话在该通道推送帧里见过的 method 计数（诊断：这条通道到底推了哪些消息） */
  private methods: Record<string, number> = {}
  private lastSummaryAt = 0

  constructor(target: DanmakuTarget, hooks: DanmakuHooks) {
    this.target = target
    this.hooks = hooks
  }

  /** 是否已经真的收到过 ws 帧（界面「已连接」语义） */
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
    this.hooks.onStatus({ phase: 'connecting', failure: null })
    logger.info(`[douyin-link] ${this.target.webRid} 实时通道：打开隐藏窗口借页面 ws`)
    this.openWindow()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.connectedOnce = false
    this.clearTimers()
    this.sockets.clear()
    const win = this.win
    this.win = null
    if (win && !win.isDestroyed()) {
      try {
        if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
      } catch {
        /* ignore */
      }
      win.destroy()
    }
  }

  /* --------------------------------------------------------------- 内部 */

  private openWindow(): void {
    if (this.stopped) return
    let win: BrowserWindow
    try {
      win = new BrowserWindow({
        show: false,
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
        skipTaskbar: true,
        webPreferences: {
          // 独立会话：既不污染宿主会话，也把「拦资源」限制在自己身上
          partition: 'douyin-link-realtime',
          // **不要** backgroundThrottling:false：隐藏窗口开着不节流会让整个抖音直播页
          // 在后台满速跑（JS/定时器/渲染），实测会把同进程的音频调度挤到卡顿。
          // 推送 ws 是事件驱动的（帧到达就会回调），节流不影响收帧，但能省一大截 CPU。
          backgroundThrottling: true,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
    } catch (error) {
      this.fail('windowFailed', describe(error))
      return
    }
    this.win = win
    win.setMenuBarVisibility(false)
    win.webContents.setAudioMuted(true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    /**
     * 只留「跑 JS + 连 ws」必需的东西：视频、图片、字体一律拦掉。
     * 隐藏窗口不该为了收实时消息去拉整条直播流 / 画页面（既省流量，也不跟音频抢 CPU）。
     * 注意：Electron 的同一个 session 每种事件**只保留最后一个监听器**，所以这里只能注册一次。
     */
    try {
      const blockedTypes = new Set(['image', 'font', 'media', 'ping', 'cspReport'])
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
        if (blockedTypes.has(details.resourceType)) return callback({ cancel: true })
        if (/\.(flv|m3u8|ts)(\?|$)/.test(details.url)) return callback({ cancel: true })
        callback({})
      })
    } catch {
      /* 拦不住也不致命 */
    }

    win.webContents.on('render-process-gone', () => this.onDie('rendererGone'))
    /**
     * `did-fail-load` **只认主框架**。
     *
     * 坑（2026-10 实测）：抖音直播间页里有子框架（广告/统计 iframe）会被页面自己的 CSP 拦掉，
     * 于是浏览器抛 `-30 ERR_BLOCKED_BY_CSP`。旧版这里不看 `isMainFrame`、一律当致命错误，
     * 结果 ws 明明已经连上并收帧了，几秒后却被自己把窗口销毁 → 一条消息都留不住。
     */
    win.webContents.on('did-fail-load', (_event, code, desc, _url, isMainFrame) => {
      if (!isMainFrame) return
      if (code === -3) return // ERR_ABORTED：我们主动停/换地址时的正常中断
      this.onDie(`loadFailed ${code} ${desc}`)
    })

    this.attachDebugger(win)

    const url = `https://live.douyin.com/${this.target.webRid}`
    win.loadURL(url).catch((error) => this.onDie(`loadUrl ${describe(error)}`))

    this.startTimer = setTimeout(() => {
      if (!this.connectedOnce) this.onDie('noSocketInTime')
    }, START_TIMEOUT_MS)
    this.armReloadTimer()
  }

  /** 定期刷新隐藏窗口（见 PAGE_RELOAD_MS）：把页面的累积状态清掉，别让它越跑越拖音频 */
  private armReloadTimer(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => this.reloadPage(), PAGE_RELOAD_MS)
  }

  private reloadPage(): void {
    this.reloadTimer = null
    const win = this.win
    if (this.stopped || !win || win.isDestroyed()) return
    logger.info(`[douyin-link] ${this.target.webRid} 实时通道：定期刷新隐藏窗口（防越跑越卡）`)
    // requestId 会随刷新全变，旧映射清掉；CDP 会话跟着 webContents 走，重开 Network 域即可
    this.sockets.clear()
    try {
      const dbg = win.webContents.debugger
      if (dbg.isAttached()) void dbg.sendCommand('Network.enable').catch(() => {})
    } catch {
      /* ignore */
    }
    win.webContents.reload()
    this.armReloadTimer()
  }

  private attachDebugger(win: BrowserWindow): void {
    try {
      const dbg = win.webContents.debugger
      if (!dbg.isAttached()) dbg.attach('1.3')
      dbg.on('message', (_event, method, params) => this.onCdp(method, params as CdpMessage))
      void dbg.sendCommand('Network.enable').catch(() => {})
      void dbg.sendCommand('Page.enable').catch(() => {})
    } catch (error) {
      // CDP 挂不上：这条通道没法用，直接判失败（不影响 HTTP 弹幕）
      this.fail('cdpFailed', describe(error))
    }
  }

  private onCdp(method: string, params: CdpMessage): void {
    if (this.stopped) return
    if (method === 'Network.webSocketCreated') {
      if (params.requestId && params.url) this.sockets.set(params.requestId, params.url)
      if (params.url && isPushUrl(params.url)) {
        logger.info(`[douyin-link] ${this.target.webRid} 实时通道：页面已连上推送 ws`)
      }
      return
    }
    if (method === 'Network.webSocketFrameReceived') {
      const requestId = params.requestId ?? ''
      const url = this.sockets.get(requestId) ?? ''
      if (!isPushUrl(url)) return
      const frame = params.response
      if (!frame || frame.opcode !== 2 || !frame.payloadData) return
      this.onBinaryFrame(frame.payloadData)
      return
    }
    if (method === 'Network.webSocketClosed') {
      if (params.requestId) this.sockets.delete(params.requestId)
    }
  }

  /** 一帧二进制 PushFrame：解出内层 WebcastResponse，整批上报（弹幕/进场/…/麦位） */
  private onBinaryFrame(payloadData: string): void {
    let payload: Buffer | undefined
    try {
      const frame = readMessage(Buffer.from(payloadData, 'base64'))
      payload = getBytes(frame, 8)
    } catch {
      return
    }
    if (!payload || payload.length === 0) return

    let body = payload
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
    let methodsSeen: Record<string, number> = {}
    try {
      const batch = decodeProtoResponse(body, giftCatalog).batch
      items = batch.items
      users = batch.users
      roomEnded = batch.roomEnded
      micUserIds = batch.micUserIds
      methodsSeen = batch.methods
    } catch (error) {
      logger.warn(`[douyin-link] ${this.target.webRid} 实时帧解码失败:`, describe(error))
      return
    }

    // 诊断：这条通道推了哪些 method（实时页空白时，先看服务端到底推没推）
    this.noteMethods(methodsSeen)

    if (!this.connectedOnce) {
      this.connectedOnce = true
      this.failures = 0
      if (this.startTimer) {
        clearTimeout(this.startTimer)
        this.startTimer = null
      }
      logger.info(`[douyin-link] ${this.target.webRid} 实时通道：已连上（开始截取推送帧）`)
      this.hooks.onStatus({ phase: 'live', failure: null })
    }
    this.armIdleTimer()

    if (micUserIds && micUserIds.length > 0) this.hooks.onMic(micUserIds)
    if (items.length > 0 || users.length > 0) {
      this.messages += items.length
      this.hooks.onItems(items, users, { roomEnded })
    }
  }

  /**
   * 推送 method 普查：这条通道推送帧里见过哪些消息、各多少条。
   *
   * 为什么必须有：本类以前只上报「解出来的行」，**从没说过服务端推了哪些 method**——
   * 于是「实时页空白」根本无从判断是「没推」还是「没解出来」。这里每 2 分钟写一条汇总，
   * 日志里就能一眼看出服务端到底推了哪些消息。
   */
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

  /** 连上后如果长时间没有帧，视为掉线（页面可能被风控/切走） */
  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.onDie('idle'), IDLE_TIMEOUT_MS)
  }

  private onDie(reason: string): void {
    if (this.stopped) return
    // 关掉旧窗口，走重试
    const win = this.win
    this.win = null
    this.connectedOnce = false
    this.clearTimers()
    this.sockets.clear()
    if (win && !win.isDestroyed()) {
      try {
        if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
      } catch {
        /* ignore */
      }
      win.destroy()
    }
    this.fail('realtimeChannelLost', reason)
  }

  private fail(code: string, detail: string): void {
    if (this.stopped) return
    this.failures += 1
    const failure = { code, detail: detail.slice(0, 160) }
    if (this.failures >= MAX_FAILURES) {
      logger.warn(
        `[douyin-link] ${this.target.webRid} 实时通道连续失败 ${this.failures} 次，本会话放弃` +
          `（弹幕不受影响）：${code} ${detail}`
      )
      this.stop()
      return
    }
    const backoff = RETRY_BACKOFF_MS[Math.min(this.failures - 1, RETRY_BACKOFF_MS.length - 1)]
    logger.warn(
      `[douyin-link] ${this.target.webRid} 实时通道失败（${code} ${detail}），${Math.round(backoff / 1000)}s 后重试`
    )
    this.hooks.onStatus({ phase: 'retrying', failure })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.stopped) return
      this.openWindow()
    }, backoff)
  }

  private clearTimers(): void {
    for (const key of ['retryTimer', 'idleTimer', 'startTimer', 'reloadTimer'] as const) {
      const timer = this[key]
      if (timer) clearTimeout(timer)
      this[key] = null
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 160)
  return String(error).slice(0, 160)
}