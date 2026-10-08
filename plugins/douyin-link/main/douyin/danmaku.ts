import { BrowserWindow, session, type Debugger, type Session } from 'electron'
import logger from 'electron-log'
import type { DanmakuItem, DanmakuPhase, FailureInfo, UserInfo } from '../../shared/types'
import { since, withTimeout } from '../util/deadline'
import { giftCatalog } from '../gift/catalog'
import { guardHiddenWindow } from '../window-guard'
import { parsePushFrame } from './push'

/**
 * 弹幕采集器：**借直播间页面自己的那条已签名 websocket**。
 *
 * 为什么不自己连：抖音 web 端的弹幕推送地址 `wss://…/webcast/im/push/v2/` 需要
 * `signature`（由页面里那份 webmssdk 现场算出来的），裸连一律被风控挡回 502（实测四种域名都一样），
 * 而 HTTP 的 `im/fetch` 在缺签名时返回空数组。与其复刻那套混淆签名，不如：
 *
 * 1. 开一个**隐藏窗口**加载 `https://live.douyin.com/<rid>`（页面自己会算出签名、连上 ws、发心跳、回 ack）；
 * 2. 用 Electron 自带的 **CDP（webContents.debugger）** 监听 `Network.webSocketFrameReceived`，
 *    直接把 ws 收到的二进制帧截下来（无需注入脚本、不依赖页面内部结构）；
 * 3. 主进程按 protobuf 解出弹幕（见 ./push.ts）。
 *
 * 省流量：隐藏窗口默认**取消所有流媒体请求**（flv/m3u8/ts/mp4），只看弹幕；
 * 若 15 秒内没截到 ws，自动关掉拦截重试一次（有页面非要把播放器拉起来才连 im 的情况）。
 * 画面与声音一律不落到用户耳朵里：窗口不 show、webContents.setAudioMuted(true)、
 * 页面弹窗一律拒绝（`setWindowOpenHandler`），并且窗口交给 `../window-guard` 看管
 * ——**被 show 就立刻按回去**，主窗口关闭时也会被连带收掉（隐藏窗口也是窗口，
 * 留在那儿会让宿主永远等不到 `window-all-closed`）。
 */

const PUSH_HOST_MARK = '/webcast/im'
const WATCHDOG_NO_SOCKET_MS = 15000
const WATCHDOG_SILENCE_MS = 90000
const MAX_RELOADS = 5
/** CDP 挂载/开网络域的死线：这两步都可能「吊住且不报错」，别让它拦住加载 */
const CDP_DEADLINE_MS = 8000

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const MEDIA_PATTERN = /\.(flv|m3u8|ts|mp4|m4s|aac|mp3)(\?|$)/i

export interface DanmakuHooks {
  /** 一批弹幕 + 这批里出现的用户静态信息（交给用户档案库聚合） */
  onItems: (items: DanmakuItem[], users: UserInfo[], meta: { roomEnded: boolean }) => void
  onStatus: (status: { phase: DanmakuPhase; failure: FailureInfo | null }) => void
}

export class DanmakuCollector {
  private readonly partition: string
  private readonly hooks: DanmakuHooks
  private win: BrowserWindow | null = null
  private target = ''
  private blockMedia = true
  private stopped = true
  private sawSocket = false
  private firstItemsLogged = false
  private socketIds = new Set<string>()
  private lastFrameAt = 0
  private reloads = 0
  private reloadedForBlocking = false
  private noSocketTimer: ReturnType<typeof setTimeout> | null = null
  private silenceTimer: ReturnType<typeof setInterval> | null = null
  private cdpHandler: ((event: unknown, method: string, params: unknown) => void) | null = null

  constructor(partition: string, hooks: DanmakuHooks) {
    this.partition = partition
    this.hooks = hooks
  }

  /** 弹幕通道是否已经建立过（页面里的 ws 被截到过） */
  get connected(): boolean {
    return this.sawSocket
  }

  async start(webRid: string, options: { saveData: boolean }): Promise<void> {
    this.stop()
    this.target = webRid
    this.blockMedia = options.saveData
    this.stopped = false
    this.reloads = 0
    this.reloadedForBlocking = false
    this.sawSocket = false
    this.firstItemsLogged = false
    this.socketIds.clear()
    this.lastFrameAt = 0
    await this.open()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    const win = this.win
    this.win = null
    this.sawSocket = false
    this.socketIds.clear()
    if (win && !win.isDestroyed()) {
      try {
        if (win.webContents.debugger.isAttached()) {
          if (this.cdpHandler) win.webContents.debugger.removeListener('message', this.cdpHandler)
          win.webContents.debugger.detach()
        }
      } catch {
        // 窗口已经没了：忽略
      }
      try {
        win.destroy()
      } catch {
        // 同上
      }
    }
    this.cdpHandler = null
    this.clearMediaBlock()
  }

  /** 换省流量策略：重建窗口（拦截器只能装在会话上，改策略最省事就是重开） */
  async restart(webRid: string, options: { saveData: boolean }): Promise<void> {
    await this.start(webRid, options)
  }

  private async open(): Promise<void> {
    // **看门狗必须在最早的一刻装上**：建窗口、CDP attach、Network.enable、loadURL，
    // 这几步（在真机上）都可能「吊住而且不报错」。旧版把看门狗放在 `await Network.enable`
    // 之后，那一步不返回就永远没有出口——界面停「连接弹幕中…」，日志里连一行失败都没有。
    // 现在无论卡在哪一步，15 秒后都会被拽出来（先关掉省流量重试，再不行就报 noSocket）。
    this.armNoSocketWatchdog()
    this.armSilenceWatchdog()
    try {
      const ses = session.fromPartition(this.partition)
      this.applyUserAgent(ses)
      this.applyMediaBlock(ses)
      const win = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        width: 960,
        height: 540,
        webPreferences: {
          partition: this.partition,
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          spellcheck: false,
          devTools: false
        }
      })
      this.win = win
      win.webContents.setAudioMuted(true)
      // 隐藏窗口不能有可见的副产物：
      // ① 登记守卫——万一有人（宿主 second-instance 处理器 / 页面）把它 show() 出来，立刻按回去；
      // ② 拒掉页面自己开的弹窗——默认策略会为 window.open 建一个**可见**的 BrowserWindow，
      //    抖音直播页的登录/广告浮层足够触发它（那也会表现为「冒出个直播间画面」）。
      guardHiddenWindow(win)
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.on('closed', () => {
        if (!this.stopped && this.win === win) {
          this.win = null
          this.hooks.onStatus({ phase: 'error', failure: { code: 'windowClosed' } })
        }
      })
      win.webContents.on('render-process-gone', (_event, details) => {
        if (this.stopped) return
        this.hooks.onStatus({ phase: 'retrying', failure: { code: 'renderGone', detail: details.reason } })
        this.scheduleReload(2000)
      })

      await this.attachCdp(win)

      // 页面就绪后再要一次 Network 域（命令幂等）：第一次万一没生效，这里补一次
      win.webContents.on('dom-ready', () => {
        if (this.stopped || this.win !== win) return
        this.enableNetwork(win.webContents.debugger)
      })

      this.hooks.onStatus({ phase: 'connecting', failure: null })
      // 不 await 加载：页面只要有一个请求迟迟不 settle，`await loadURL` 就会一直吊着。
      // 看门狗已经在上面装好，加载失败也单独报 loadFailed。
      logger.info(`[douyin-link] 弹幕窗口开始加载（房间 ${this.target}）`)
      win.loadURL(`https://live.douyin.com/${this.target}`).catch((error) => {
        // 换过一次窗口（restart）时旧窗口的失败不该报到新会话上
        if (this.stopped || this.win !== win) return
        this.hooks.onStatus({ phase: 'error', failure: { code: 'loadFailed', detail: describe(error) } })
      })
    } catch (error) {
      if (this.stopped) return
      this.hooks.onStatus({
        phase: 'error',
        failure: { code: 'windowFailed', detail: describe(error) }
      })
    }
  }

  /**
   * 挂 CDP 并打开 Network 域。
   *
   * **每一步都带死线**：`debugger.attach` 与 `sendCommand` 在目标还没就绪时都可能永远不返回，
   * 而且不会抛错。CDP 没挂上不等于弹幕没戏（看门狗会重载页面再试），
   * 所以超时只记日志、继续加载——**绝不允许它拦住流程**。
   */
  private async attachCdp(win: BrowserWindow): Promise<void> {
    const startedAt = Date.now()
    const debug = win.webContents.debugger
    try {
      debug.attach('1.3')
    } catch (error) {
      logger.warn('[douyin-link] CDP attach 失败，弹幕可能截不到:', describe(error))
      return
    }
    this.cdpHandler = (_event, method, params) => {
      this.onCdp(method, params as Record<string, unknown>)
    }
    debug.on('message', this.cdpHandler)
    logger.info(`[douyin-link] 弹幕窗口 CDP 已挂载（${since(startedAt)}），开始等推送通道`)
    // **绝不等 Network.enable 的回执**：真机实测（Electron 44 / Chromium 152）这条命令的回执
    // 有时永远不回来——但 Network 事件照旧在推（实测同一窗口 40 秒收到 71 帧）。
    // 旧版在这里 await，于是页面永远不加载、界面永远停「连接弹幕中…」，日志里连一行失败都没有。
    this.enableNetwork(debug)
  }

  /** 开 Network 域（幂等）。回执可能不来，所以只记日志、不阻塞任何流程 */
  private enableNetwork(debug: Debugger): void {
    withTimeout(
      debug.sendCommand('Network.enable', {
        maxTotalBufferSize: 0,
        maxResourceBufferSize: 0,
        maxPostDataSize: 0
      }),
      CDP_DEADLINE_MS,
      'Network.enable'
    )
      .then(() => logger.info('[douyin-link] CDP Network 域已开（等弹幕推送通道）'))
      .catch((error) =>
        logger.warn('[douyin-link] CDP Network.enable 没拿到回执，继续观察事件:', describe(error))
      )
  }

  private onCdp(method: string, params: Record<string, unknown>): void {
    if (this.stopped) return
    if (method === 'Network.webSocketCreated') {
      const url = String(params.url ?? '')
      const id = String(params.requestId ?? '')
      // 把看到的每一条 ws 都记下来：万一抖音改了推送地址、`/webcast/im` 这个标记失效，
      // 日志里能直接看出「它连到哪儿去了」，而不用再加一轮探针
      logger.info(`[douyin-link] 弹幕窗口建立 websocket：${url.slice(0, 160)}`)
      if (url.includes(PUSH_HOST_MARK)) {
        this.socketIds.add(id)
        if (!this.sawSocket) {
          this.sawSocket = true
          this.reloads = 0
          this.lastFrameAt = Date.now()
          this.clearNoSocketWatchdog()
          logger.info('[douyin-link] 已截到弹幕推送通道')
          this.hooks.onStatus({ phase: 'live', failure: null })
        }
      }
      return
    }
    if (method === 'Network.webSocketClosed' || method === 'Network.webSocketWillSendHandshakeRequest') {
      if (method === 'Network.webSocketClosed') this.socketIds.delete(String(params.requestId ?? ''))
      return
    }
    if (method === 'Network.webSocketFrameReceived') {
      const id = String(params.requestId ?? '')
      if (this.socketIds.size > 0 && !this.socketIds.has(id)) return
      const response = params.response as { opcode?: number; payloadData?: string } | undefined
      const data = response?.payloadData
      if (!data) return
      const raw = Buffer.from(data, 'base64')
      if (raw.length === 0) return
      this.lastFrameAt = Date.now()
      // 礼物额度靠官方目录（giftId → 抖币价），目录没就绪时礼物只显示名字、不给数字
      const parsed = parsePushFrame(raw, giftCatalog)
      if (parsed.items.length > 0) {
        if (!this.firstItemsLogged) {
          this.firstItemsLogged = true
          logger.info(
            `[douyin-link] 首批弹幕已解出：${parsed.items.length} 条（${parsed.items
              .map((item) => item.kind)
              .join(',')}），带用户信息 ${parsed.users.length} 人`
          )
        }
        this.hooks.onItems(parsed.items, parsed.users, { roomEnded: parsed.close })
      }
    }
  }

  private armNoSocketWatchdog(): void {
    this.clearNoSocketWatchdog()
    this.noSocketTimer = setTimeout(() => {
      this.noSocketTimer = null
      if (this.stopped || this.sawSocket) return
      if (this.blockMedia && !this.reloadedForBlocking) {
        // 很可能是「画面被拦 → 页面没把 im 拉起来」：关掉拦截重试一次
        this.reloadedForBlocking = true
        this.hooks.onStatus({ phase: 'retrying', failure: { code: 'retryWithoutSaveData' } })
        void this.restart(this.target, { saveData: false })
        return
      }
      this.hooks.onStatus({ phase: 'error', failure: { code: 'noSocket' } })
    }, WATCHDOG_NO_SOCKET_MS)
  }

  private clearNoSocketWatchdog(): void {
    if (this.noSocketTimer) {
      clearTimeout(this.noSocketTimer)
      this.noSocketTimer = null
    }
  }

  private armSilenceWatchdog(): void {
    if (this.silenceTimer) clearInterval(this.silenceTimer)
    this.silenceTimer = setInterval(() => {
      if (this.stopped || !this.sawSocket) return
      if (Date.now() - this.lastFrameAt < WATCHDOG_SILENCE_MS) return
      this.hooks.onStatus({ phase: 'retrying', failure: { code: 'silent' } })
      this.scheduleReload(1000)
    }, 20000)
  }

  private scheduleReload(delay: number): void {
    if (this.stopped) return
    if (this.reloads >= MAX_RELOADS) {
      this.hooks.onStatus({ phase: 'error', failure: { code: 'reloadLimit' } })
      return
    }
    this.reloads += 1
    setTimeout(() => {
      const win = this.win
      if (this.stopped || !win || win.isDestroyed()) return
      this.sawSocket = false
      this.socketIds.clear()
      this.lastFrameAt = Date.now()
      this.armNoSocketWatchdog()
      try {
        win.webContents.reload()
      } catch {
        this.hooks.onStatus({ phase: 'error', failure: { code: 'windowFailed' } })
      }
    }, delay)
  }

  private clearTimers(): void {
    this.clearNoSocketWatchdog()
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer)
      this.silenceTimer = null
    }
  }

  private applyUserAgent(ses: Session): void {
    try {
      // 隐藏窗口不能带 Electron 标识：抖音 web 端对 UA 有风控
      ses.setUserAgent(CHROME_UA)
    } catch {
      // 某些环境不允许改会话 UA：不影响主流程
    }
  }

  private applyMediaBlock(ses: Session): void {
    this.clearMediaBlock()
    if (!this.blockMedia) return
    try {
      ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
        if (details.resourceType === 'media' || MEDIA_PATTERN.test(details.url)) {
          callback({ cancel: true })
          return
        }
        callback({})
      })
    } catch {
      // 拿不到 webRequest（例如非 Electron 环境）：退化成「画面也一起拉」
    }
  }

  private clearMediaBlock(): void {
    try {
      session.fromPartition(this.partition).webRequest.onBeforeRequest(null)
    } catch {
      // 会话不存在：忽略
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 160)
  return String(error).slice(0, 160)
}
