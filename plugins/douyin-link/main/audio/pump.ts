import { net } from 'electron'
import logger from 'electron-log'
import { FlvDemuxer } from '../../shared/flv'
import type { AudioConfig, AudioFrame, AudioPhase, FailureInfo } from '../../shared/types'
import { sleep } from '../util/deadline'

/**
 * 音频拉流泵（**主进程**）：拉抖音的 FLV、解出 AAC 裸帧、成批推给渲染层。
 *
 * 为什么在主进程拉（别再搬回渲染层）：
 * 宿主渲染层的 HTML 带 `connect-src 'self' plugin:` 的 CSP，渲染层发的任何外部请求
 * （抖音 CDN 的 https 地址）都会被拦掉——渲染层里那句 `fetch(flvUrl)` 永远不会成功，
 * 表现就是「界面一切正常，就是没声音」。主进程没有 CSP 限制，拉流、解复用都放这里，
 * 渲染层只做 WebCodecs 解码 + Web Audio 播放（见 renderer/audio/player.ts）。
 *
 * 数据量：只推音轨。实测整条流 ~38KB/s，音轨本体 ~20KB/s，按 24 帧 / 200ms 一批发，
 * 也就是每 200ms 一条 ~10KB 的 IPC 消息——对 IPC 来说毫无压力。
 *
 * 断线重连：抖音的 flv 地址带 `t=` 过期时间，断了必须**重新解析**拿新地址，
 * 所以调用方给的是一个 `resolveFresh()` 回调，而不是一条固定 URL。
 */

/** 攒够这么多帧就发一批（约 0.5 秒的音频） */
const FLUSH_FRAMES = 24
/** 或者最多攒这么久（低帧率/断续时靠它兜底） */
const FLUSH_MS = 200
/** 连续重连这么多次还连不上就报错收手（每次都换新地址） */
const MAX_ATTEMPTS = 8
const CONNECT_TIMEOUT_MS = 15000
/**
 * 连通后等「音轨参数」的宽限：**HTTP 200 只说明地址通了，不等于这路流里有能用的音轨**。
 * 旧版在这里没有出口——连上了、没有帧、也不报错，界面就永远停在「拉流中…」（用户实测到的那个状态）。
 */
const FIRST_AUDIO_DEADLINE_MS = 12000
/** 读取空闲看门狗：这么久一个字节都没来就当断流（不然 `reader.read()` 会一直吊着） */
const READ_IDLE_MS = 15000
/** 从头到尾一帧音频都没解出来时的总预算：超过就收手报 noAudio，别让界面无限等 */
const NO_AUDIO_BUDGET_MS = 45000

export interface AudioPumpHooks {
  onStatus: (phase: AudioPhase, failure: FailureInfo | null) => void
  onConfig: (config: AudioConfig) => void
  onFrames: (frames: AudioFrame[]) => void
}

export class AudioPump {
  private readonly hooks: AudioPumpHooks
  private controller: AbortController | null = null
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private pending: AudioFrame[] = []
  private stopped = true
  private attempts = 0
  private seq = 0
  /** 本次连接第一帧的时间戳（每次连接重新起算，避免跨连接的绝对时间戳乱跳） */
  private originTs = -1
  private loggedFirstBatch = false
  private brokenReason = ''
  /** 上一次通知过的音轨参数（ASC 的 base64），用来去重 */
  private lastAsc = ''
  /** 本轮泵「解出过音轨参数」吗（决定 noAudio 预算算不算消耗掉） */
  private everPlayed = false
  /** 泵的启动时刻（noAudio 总预算从这儿算） */
  private pumpingSince = 0

  constructor(hooks: AudioPumpHooks) {
    this.hooks = hooks
  }

  /**
   * 开始拉流。`initialUrl` 是已经解析过的地址（首次直接用，省一次往返）；
   * 之后每次重连都调 `resolveFresh()` 拿新地址（旧地址的 `t=` 签名会过期）。
   */
  start(initialUrl: string | null, resolveFresh: () => Promise<string>): void {
    this.stop()
    this.stopped = false
    this.attempts = 0
    this.seq = 0
    this.everPlayed = false
    this.pumpingSince = Date.now()
    void this.run(initialUrl, resolveFresh)
  }

  stop(): void {
    this.stopped = true
    this.controller?.abort()
    this.controller = null
    this.clearFlushTimer()
    this.pending = []
    this.originTs = -1
    this.loggedFirstBatch = false
    this.brokenReason = ''
  }

  private async run(
    initialUrl: string | null,
    resolveFresh: () => Promise<string>
  ): Promise<void> {
    let url = initialUrl ?? ''
    while (!this.stopped) {
      if (!url) {
        try {
          url = await resolveFresh()
        } catch (error) {
          this.attempts += 1
          if (await this.retryOrGiveUp('resolveFailed', describe(error))) return
          continue
        }
      }
      if (this.stopped) return

      this.brokenReason = ''
      let breakCode = 'streamFailed'
      try {
        await this.pull(url)
        // 正常返回 = 流被服务端关了（下播 / 地址过期）
        if (this.stopped) return
        logger.info('[douyin-link] 音频流已结束，准备重连')
        breakCode = 'streamEnded'
        this.hooks.onStatus('connecting', { code: 'streamEnded' })
      } catch (error) {
        if (this.stopped) return
        breakCode = this.brokenReason || 'fetchFailed'
        logger.warn('[douyin-link] 音频拉流中断:', breakCode, describe(error))
        this.hooks.onStatus('connecting', { code: breakCode, detail: describe(error) })
      }

      url = ''
      this.attempts += 1
      if (await this.retryOrGiveUp(breakCode, '')) return
    }
  }

  /** 退避后返回 false 表示继续重试；返回 true 表示已经报错收手 */
  private async retryOrGiveUp(code: string, detail: string): Promise<boolean> {
    // **出口二**：连上了却一直解不出音轨（只连上、不报错最容易骗人）→ 用总预算收手
    const starved = !this.everPlayed && Date.now() - this.pumpingSince > NO_AUDIO_BUDGET_MS
    if (this.attempts >= MAX_ATTEMPTS || starved) {
      const finalCode = starved ? 'noAudio' : code
      logger.warn(
        `[douyin-link] 音频拉流收手（尝试 ${this.attempts} 次${starved ? '，始终没解出音频数据' : ''}）：${finalCode}`
      )
      this.hooks.onStatus('error', { code: finalCode, detail: detail || undefined })
      return true
    }
    const wait = Math.min(4000, 400 * this.attempts)
    logger.info(`[douyin-link] 音频拉流第 ${this.attempts} 次重试，${wait}ms 后开始`)
    await sleep(wait)
    return this.stopped
  }

  /**
   * 打开拉流连接：先走 Node 的 fetch，失败/异常再回落到 Electron 的 net.fetch（Chromium 网络栈）。
   *
   * 抖音 CDN 的边缘节点会间歇性抽风——实测同一个 flv 地址：十几分钟里一直 6 秒超时，
   * 过一会儿同一地址 240ms 就回来 70KB。两条网络栈的 DNS / IPv6 / HTTP 行为不同，
   * 换一条重试常常能过，比单纯等下一次重试快得多。
   */
  private async openStream(url: string, signal: AbortSignal): Promise<Response> {
    const headers = {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      referer: 'https://live.douyin.com/',
      accept: '*/*'
    }
    try {
      const first = await fetch(url, { headers, signal })
      if (first.ok && first.body) return first
      logger.warn(`[douyin-link] 音频拉流（Node）HTTP ${first.status}，改用 Chromium 网络栈重试`)
    } catch (error) {
      // 连接死线到了（主动 abort）就别再试了，交给上层重试逻辑
      if (signal.aborted) throw error
      logger.warn('[douyin-link] 音频拉流（Node）失败，改用 Chromium 网络栈重试:', describe(error))
    }
    return net.fetch(url, { headers, signal })
  }

  private async pull(url: string): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    this.hooks.onStatus('connecting', null)

    // 连接超时只覆盖「拿到响应头」这一段：直播流本身是无限长的，
    // 绝不能用 AbortSignal.timeout 挂在整条流上（那会在半分钟后把好好的流掐断）
    const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)
    let response: Response
    try {
      response = await this.openStream(url, controller.signal)
    } finally {
      clearTimeout(connectTimer)
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (!response.body) throw new Error('empty body')

    // 连上了：本次连接的计数归零，时间戳重新起算
    this.attempts = 0
    this.originTs = -1
    this.lastAsc = ''
    this.loggedFirstBatch = false
    this.hooks.onStatus('live', null)
    logger.info(`[douyin-link] 音频拉流已连接（HTTP ${response.status}，${url.slice(0, 60)}…）`)

    /**
     * **出口零**：连上 ≠ 有音频。HTTP 200 之后等音轨参数（ASC），超时就说明这路流里没有
     * 能用的音轨，直接判废、换地址重试——旧版缺这一步，界面会永远停在「拉流中…」。
     */
    const firstAudioTimer = setTimeout(() => {
      if (this.stopped || this.everPlayed) return
      this.brokenReason = 'badStream'
      logger.warn(`[douyin-link] 连上后 ${FIRST_AUDIO_DEADLINE_MS}ms 还没解出音轨参数，换地址重试`)
      controller.abort()
    }, FIRST_AUDIO_DEADLINE_MS)

    const demuxer = new FlvDemuxer({
      onConfig: (config) => {
        // 解出了音轨参数 = 这路流确实有音轨：撤掉首帧死线
        this.everPlayed = true
        clearTimeout(firstAudioTimer)
        // 实测有的流会在开头重复下发同一个 ASC：一样就不重复通知，
        // 免得渲染层把解码器白白重建一遍
        const key = Buffer.from(config.asc).toString('base64')
        if (key === this.lastAsc) return
        this.lastAsc = key
        logger.info(
          `[douyin-link] 音频参数：${config.sampleRate}Hz / ${config.channels}ch / AAC objectType=${config.objectType}`
        )
        this.hooks.onConfig({
          sampleRate: config.sampleRate,
          channels: config.channels,
          objectType: config.objectType,
          asc: config.asc
        })
      },
      onFrame: (frame, timestampMs) => this.queueFrame(frame, timestampMs),
      onEnd: () => {
        // 解复用判定这路流用不了（不是 FLV / 不是 AAC）：中断读取去重连
        this.brokenReason = 'badStream'
        controller.abort()
      }
    })

    this.startFlushTimer()
    const reader = response.body.getReader()
    let lastByteAt = Date.now()
    /** **出口一**：读空闲看门狗。`reader.read()` 在没有数据时不会返回，光等就等于界面卡死 */
    const idleTimer = setInterval(() => {
      if (this.stopped) return
      const idle = Date.now() - lastByteAt
      if (idle < READ_IDLE_MS) return
      this.brokenReason = 'streamFailed'
      logger.warn(`[douyin-link] 音频流 ${Math.round(idle / 1000)} 秒没有数据，重连`)
      controller.abort()
    }, 5000)
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (this.stopped) return
        if (done) break
        if (value) {
          lastByteAt = Date.now()
          demuxer.feed(value)
        }
      }
    } finally {
      clearTimeout(firstAudioTimer)
      clearInterval(idleTimer)
      this.clearFlushTimer()
      this.flush()
    }
  }

  private queueFrame(frame: Uint8Array, timestampMs: number): void {
    if (this.originTs < 0) this.originTs = timestampMs
    const ts = Math.max(0, timestampMs - this.originTs)
    // **必须拷成独立的小数组**：frame 是流缓冲里的视图，直接发会让 IPC
    // 结构化克隆带上整个底层 ArrayBuffer（几十 KB → 每帧几十 KB）
    const data = new Uint8Array(frame.length)
    data.set(frame)
    this.pending.push({ ts, data })
    if (this.pending.length >= FLUSH_FRAMES) this.flush()
  }

  private flush(): void {
    if (this.pending.length === 0) return
    const frames = this.pending
    this.pending = []
    this.seq += 1
    if (!this.loggedFirstBatch) {
      this.loggedFirstBatch = true
      logger.info(`[douyin-link] 音频首批 ${frames.length} 帧已推给渲染层`)
    }
    this.hooks.onFrames(frames)
  }

  private startFlushTimer(): void {
    this.clearFlushTimer()
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS)
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'aborted'
    return error.message.slice(0, 140)
  }
  return String(error).slice(0, 140)
}
