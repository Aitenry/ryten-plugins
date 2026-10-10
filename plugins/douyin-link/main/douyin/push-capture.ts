import logger from 'electron-log'
import * as zlib from 'node:zlib'
import { RawWebSocket, WsHandshakeError } from './raw-ws'
import { PUSH_UA, buildPushUrl } from './sign'
import { encodeAck, encodeHeartbeat, readPushFrame } from './push-frame'
import { decodeProtoResponse } from './proto-messages'
import { giftCatalog } from '../gift/catalog'
import { applyGiftIncrements, type GiftGroupState } from '../gift/group'
import type { DanmakuItem, DanmakuStatus, FailureInfo, UserInfo } from '../../shared/types'

/**
 * 采集目标：一个直播间 + 直连推送 ws 所需的房间内部 id 与进房 Cookie。
 */
export interface DanmakuTarget {
  webRid: string
  /** 内部房间 id（webcast 接口用的长 id） */
  roomId: string
  /** 进房时拿到的 Cookie（ttwid 必需） */
  cookie: string
}

/**
 * 实时通道向中枢上报的三种事件（与旧 HTTP 轮询通道的契约一致）。
 */
export interface DanmakuHooks {
  /** 一批消息 + 这批里出现的用户静态信息（交给用户档案库聚合） */
  onItems: (items: DanmakuItem[], users: UserInfo[], meta: { roomEnded: boolean }) => void
  /** 在麦上的用户（按麦位顺序；聊天室才有） */
  onMic: (userIds: string[]) => void
  onStatus: (status: { phase: DanmakuStatus['phase']; failure: FailureInfo | null }) => void
}

/**
 * 实时通道（纯 Node 直连）：**主进程自己算签名、直连抖音推送 ws**，不借任何浏览器。
 *
 * 为什么能这么做（2026-10 实测，见 `spike/push-spike.mjs`）：抖音推送网关的设备闸，只拦
 * 「页面 webmssdk 在 Node 里补环境重算的签名」；而 `./sign.ts` 内嵌的**静态 X-Bogus 算法**
 * 不依赖运行时设备指纹，纯 Node 直连返回 **101** 并收到全量帧（弹幕/进场/点赞/礼物/榜单…）。
 *
 * 与旧版（`ws-capture.ts`：spawn 无头浏览器 + CDP 抓页面已签名 URL）相比：
 * - 不再有浏览器进程（旧版无头页面会真实拉流解码画面，拖慢宿主 CPU）；
 * - 不再依赖本机装有 Chromium；
 * - 补齐了协议要求的**应用层心跳 `hb`（每 5s）与 `ack` 应答**，连接更稳。
 *
 * 这是**唯一的采集通道**（HTTP 轮询兜底已移除）：`hub.ts` 把每个在监控的房间都挂一个它。
 * 签名初始化失败 / 房间号缺失 → 上报 error；握手被拒或掉线 → 退避重连（每次重连都重新生成
 * 签名与 `user_unique_id`）；连续失败到上限即本会话放弃并上报 error，交给中枢的重试逻辑重新拉起。
 */

/** 应用层心跳间隔（协议要求；服务端不收到心跳会断连接） */
const HEARTBEAT_MS = 5000
/** 握手成功（101）后多久还没收到任何帧，视为没拿到数据 */
const START_TIMEOUT_MS = 30000
/** 已连上后长时间没有帧，视为掉线（页面/房间被风控） */
const IDLE_TIMEOUT_MS = 120000
/** 失败退避阶梯 */
const RETRY_BACKOFF_MS = [4000, 8000, 16000, 30000, 60000]
/** 连续失败多少次就本会话放弃 */
const MAX_FAILURES = 5
/** 推送消息普查的间隔（实时页空白时靠它定位服务端推了哪些消息） */
const METHOD_SUMMARY_MS = 2 * 60 * 1000

export class DirectPushCapture {
  private readonly hooks: DanmakuHooks
  private target: DanmakuTarget
  private ws: RawWebSocket | null = null
  private stopped = true
  private connectedOnce = false
  private failures = 0
  private hbTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private messages = 0
  private methods: Record<string, number> = {}
  private lastSummaryAt = 0
  /** 连送（combo）分组的跨帧状态（见 `../gift/group.ts`）：按房间持有，随会话重置 */
  private giftGroups: GiftGroupState = new Map()
  /**
   * 帧解码的串行链（见 `onFrame`）：一帧一帧按到达顺序异步解，
   * 把 gunzip 与 protobuf 解码从「同步跑完」改成「让出事件循环」，避免卡住主进程其他工作。
   */
  private decodeChain: Promise<void> = Promise.resolve()

  constructor(target: DanmakuTarget, hooks: DanmakuHooks) {
    this.target = target
    this.hooks = hooks
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
    this.giftGroups.clear()
    this.hooks.onStatus({ phase: 'connecting', failure: null })
    logger.info(`[douyin-link] ${this.target.webRid} 实时通道：主进程直连推送 ws（离线签名，无浏览器）`)
    this.open()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.connectedOnce = false
    this.giftGroups.clear()
    this.clearTimers()
    this.closeWs()
  }

  /* --------------------------------------------------------------- 内部 */

  /** 建连：生成一份新的已签名 URL，主进程自己连上去 */
  private open(): void {
    if (this.stopped) return
    const roomId = String(this.target.roomId ?? '').trim()
    if (!/^\d+$/.test(roomId)) {
      this.fail('noRoomId', roomId || '(空)')
      return
    }
    let url: string
    try {
      url = buildPushUrl(roomId)
    } catch (error) {
      this.fail('signFailed', describe(error))
      return
    }

    const headers: Record<string, string> = {
      Origin: 'https://live.douyin.com',
      'User-Agent': PUSH_UA,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    }
    if (this.target.cookie) headers.Cookie = this.target.cookie

    const ws = new RawWebSocket(url, { headers })
    this.ws = ws
    ws.onopen = () => {
      if (this.stopped || this.ws !== ws) return
      logger.info(`[douyin-link] ${this.target.webRid} 实时通道：主进程 ws 握手 101`)
      this.startHeartbeat()
      this.armStartTimer()
    }
    ws.onmessage = (data, isBinary) => {
      if (isBinary) this.onFrame(data)
    }
    ws.onerror = (error) => {
      if (error instanceof WsHandshakeError) {
        logger.warn(
          `[douyin-link] ${this.target.webRid} 实时通道：握手被拒（${error.handshakeMsg || error.status}）`
        )
        this.onLost('handshakeRejected', 'pushRejected')
      } else {
        logger.warn(`[douyin-link] ${this.target.webRid} 实时通道：ws 错误 ${error.message}`)
      }
    }
    ws.onclose = (reason) => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.stopped) return
      this.onLost(`closed ${reason}`)
    }
  }

  /**
   * 收一帧二进制 PushFrame：先剔掉心跳帧，再解内层 WebcastResponse，整批上报。
   * **串行 + 异步**（见 `decodeChain`）：大帧若同步跑完（gunzip + protobuf）会卡住主进程。
   */
  private onFrame(payloadData: Buffer): void {
    this.decodeChain = this.decodeChain
      .then(() => this.decodeFrame(payloadData))
      .catch((error) => logger.warn(`[douyin-link] ${this.target.webRid} 实时帧解码失败:`, describe(error)))
  }

  private async decodeFrame(payloadData: Buffer): Promise<void> {
    if (this.stopped) return
    let frame: ReturnType<typeof readPushFrame>
    try {
      frame = readPushFrame(payloadData)
    } catch {
      return
    }
    // 心跳帧（payloadType='hb'）与空帧：只证明连接活着，没有业务内容
    if (!frame.payload || frame.payload.length === 0) {
      this.armIdleTimer()
      return
    }
    let body = frame.payload
    if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
      try {
        body = await gunzip(body)
      } catch {
        return
      }
    }

    let batch: ReturnType<typeof decodeProtoResponse>['batch']
    let needAck = false
    let internalExt = ''
    try {
      const decoded = decodeProtoResponse(body, giftCatalog)
      batch = decoded.batch
      needAck = decoded.needAck
      internalExt = decoded.internalExt
      this.noteMethods(batch.methods)
    } catch (error) {
      logger.warn(`[douyin-link] ${this.target.webRid} 实时帧解码失败:`, describe(error))
      return
    }

    // 服务端要求应答：回一条 ack（带上这一帧的 logId 与 internalExt）
    if (needAck) this.sendAck(frame.logIdRaw, internalExt)

    if (!this.connectedOnce) {
      this.connectedOnce = true
      this.failures = 0
      this.clearStartTimer()
      logger.info(`[douyin-link] ${this.target.webRid} 实时通道：已连上（开始接收推送帧）`)
      this.hooks.onStatus({ phase: 'live', failure: null })
    }
    this.armIdleTimer()

    if (batch.micUserIds && batch.micUserIds.length > 0) this.hooks.onMic(batch.micUserIds)
    if (batch.items.length > 0 || batch.users.length > 0) {
      // 连送去重：把服务端的累积数量换算成「本次增量」，零增量的重复帧在这一步被丢弃
      const items = applyGiftIncrements(batch.items, this.giftGroups)
      this.messages += items.length
      if (items.length > 0 || batch.users.length > 0) {
        this.hooks.onItems(items, batch.users, { roomEnded: batch.roomEnded })
      }
    }
  }

  /** 掉线/被拒：停掉当前连接，退避后用**新签名**重连 */
  private onLost(reason: string, code = 'realtimeChannelLost'): void {
    if (this.stopped) return
    this.closeWs()
    this.stopHeartbeat()
    this.clearStartTimer()
    this.clearIdleTimer()
    this.connectedOnce = false
    this.hooks.onStatus({ phase: 'retrying', failure: { code, detail: reason.slice(0, 80) } })
    this.scheduleRetry()
  }

  /** 起不来（签名失败/房间号缺失）也走同一条退避路：到上限交回 HTTP 轮询 */
  private fail(code: string, detail: string): void {
    if (this.stopped) return
    logger.warn(`[douyin-link] ${this.target.webRid} 实时通道失败（${code} ${detail.slice(0, 120)}）`)
    this.hooks.onStatus({ phase: 'retrying', failure: { code, detail: detail.slice(0, 160) } })
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    this.failures += 1
    if (this.failures > MAX_FAILURES) {
      logger.warn(`[douyin-link] ${this.target.webRid} 实时通道连续失败 ${this.failures - 1} 次，本会话放弃（HTTP 轮询不受影响）`)
      this.hooks.onStatus({ phase: 'error', failure: { code: 'realtimeChannelLost' } })
      this.stop()
      return
    }
    const backoff = RETRY_BACKOFF_MS[Math.min(this.failures - 1, RETRY_BACKOFF_MS.length - 1)]
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.stopped) return
      this.open()
    }, backoff)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    const beat = (): void => {
      const ws = this.ws
      if (!ws || !ws.ready) return
      try {
        ws.send(encodeHeartbeat(), 0x02)
      } catch {
        /* 发送失败交给 onclose/onerror 处理 */
      }
    }
    beat()
    this.hbTimer = setInterval(beat, HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) clearInterval(this.hbTimer)
    this.hbTimer = null
  }

  private sendAck(logIdRaw: Buffer | null, internalExt: string): void {
    const ws = this.ws
    if (!ws || !ws.ready) return
    try {
      ws.send(encodeAck(logIdRaw, internalExt), 0x02)
    } catch {
      /* 忽略：连接若坏了会由 onclose 触发重连 */
    }
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
      if (this.stopped || this.connectedOnce) return
      this.onLost('noFramesYet')
    }, START_TIMEOUT_MS)
  }

  private clearStartTimer(): void {
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
  }

  private armIdleTimer(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.stopped) this.onLost('idle')
    }, IDLE_TIMEOUT_MS)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private clearTimers(): void {
    this.clearStartTimer()
    this.clearIdleTimer()
    this.stopHeartbeat()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }
}

/** 异步 gunzip（不用 `gunzipSync`：同步解压会卡住主进程的其他工作） */
function gunzip(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.gunzip(input, (error, output) => (error ? reject(error) : resolve(output)))
  })
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 160)
  return String(error).slice(0, 160)
}