import type { AudioConfig, AudioFrame, AudioMessage, AudioPhase, FailureInfo } from '../../shared/types'

/**
 * 直播音频播放器（渲染层）：收主进程推来的 AAC 裸帧 → WebCodecs 解码 → Web Audio 按时间轴排帧。
 *
 * **它不拉流**（这点跟第一版不一样，别再改回去）：宿主渲染层的 CSP 是
 * `connect-src 'self' plugin:; media-src 'self' blob: plugin:`，渲染层发出的任何外部请求
 * 都会被拦掉，所以拉流与解复用都在主进程（main/audio/pump.ts），这里只做「解码 + 播放」。
 *
 * 为什么不用 `<audio src=…>`：CSP 先不说，Chromium 既不认 FLV 也不认 HLS，抖音这两路地址
 * 塞进标签也是无声；而主进程送过来的是**裸 AAC 帧**，WebCodecs 的 `AudioDecoder` 正好吃这个
 * （description = AudioSpecificConfig）。
 *
 * 实时性怎么保证（直播不能越播越延迟）：
 * - 解出来的每一帧按自己的时长**预约**到 AudioContext 的时间轴上（`nextTime += duration`），
 *   目标缓冲 `LEAD` 秒；
 * - 掉链子（解码/调度跟不上）时不追赶、只**丢帧**（超过 `MAX_LEAD` 的帧直接扔），
 *   宁可少放几帧，也不要越积越多；
 * - 主进程重连后会重发一次参数，解码器按需重建（时间轴从新的流重新起步）。
 */

export type PlayerState = 'idle' | 'connecting' | 'playing' | 'paused' | 'blocked' | 'error'

/**
 * AudioContext 有没有真的跑起来。
 *
 * 为什么要用函数重新读一次 `state`，而不是直接写 `context.state === 'running'`：
 * `markContextState` 里先判了 `state === 'suspended'`，TS 会把这条收窄一路带到 `await resume()`
 * **之后**——可那正是状态会变的地方，直接比较会被判成「两个类型没有重叠」。读一次就没这问题。
 */
const isRunning = (context: AudioContext): boolean => context.state === 'running'

export interface PlayerStats {
  state: PlayerState
  sampleRate: number
  channels: number
  /** 从主进程收到的 AAC 帧数 */
  received: number
  /** 解码成功并排上时间轴的帧数 */
  decoded: number
  /** 为了追直播而丢掉的帧数 */
  dropped: number
  /** 当前缓冲（秒） */
  buffer: number
  errorCode: string
  detail: string
}

/**
 * 目标缓冲：太小会断续，太大就不"直播"了。
 *
 * 别再回到 0.35s：主进程按 200ms 一批推帧，加上 IPC/渲染线程的抖动，0.35s 的余量
 * 经常被一次抖动吃穿 → 时间轴跳到 `now+LEAD` → 听感就是「一卡一卡」。0.7s 的余量能明显
 * 扛住抖动，对直播音频来说这点延迟可以接受。
 */
const LEAD_SECONDS = 0.7
/** 超过这个领先量就丢帧（说明解码/调度落后了） */
const MAX_LEAD_SECONDS = 2.5
/** 解码队列积压上限：超过就丢帧，别让队列无限涨 */
const MAX_DECODE_QUEUE = 60
/** 参数（ASC）还没到就先到的帧最多攒这么多（正常不会用到，FLV 里参数在第一帧之前） */
const MAX_PRECONFIG = 240
/** 音频看门狗死线：这么久还没收到音频参数/帧就报 noAudio（主进程那边也有死线，这是最后一道） */
const CONNECT_DEADLINE_MS = 60000

const SUPPORTED_HINT = 'mp4a.40.2'

export class LiveAudioPlayer {
  private context: AudioContext | null = null
  private gain: GainNode | null = null
  private decoder: AudioDecoder | null = null
  /** 已排上时间轴的音源 → 它预期播完的上下文时刻（兜底清理用，见 pruneSources） */
  private sources = new Map<AudioBufferSourceNode, number>()
  private nextTime = 0
  private volume = 0.8
  private config: AudioConfig | null = null
  private preConfig: AudioFrame[] = []
  private statsTimer: ReturnType<typeof setInterval> | null = null
  /** 是否处于「应该在播」的状态（begin/stopStream 控制） */
  private active = false
  /** 解码器连续出错的次数（超过阈值才认定环境不支持） */
  private decodeErrors = 0
  /** 「应该有声但还没收到音频」的起点（看门狗用；收到参数或帧就归零） */
  private waitingSince = 0

  onStats: ((stats: PlayerStats) => void) | null = null

  private stats: PlayerStats = {
    state: 'idle',
    sampleRate: 0,
    channels: 0,
    received: 0,
    decoded: 0,
    dropped: 0,
    buffer: 0,
    errorCode: '',
    detail: ''
  }

  /** 运行环境是否具备解码能力（探针与页面提示都用它） */
  static isSupported(): boolean {
    const globalScope = globalThis as unknown as {
      AudioDecoder?: unknown
      AudioContext?: unknown
    }
    return typeof globalScope.AudioDecoder === 'function' && typeof globalScope.AudioContext === 'function'
  }

  /** 直接问浏览器一句：它到底支不支持 AAC 解码 */
  static async probeCodec(sampleRate = 48000, channels = 2): Promise<boolean> {
    if (!LiveAudioPlayer.isSupported()) return false
    try {
      const support = await AudioDecoder.isConfigSupported({
        codec: SUPPORTED_HINT,
        sampleRate,
        numberOfChannels: channels
      })
      return Boolean(support?.supported)
    } catch {
      return false
    }
  }

  getStats(): PlayerStats {
    const stats = { ...this.stats }
    if (this.context && stats.state === 'playing') {
      stats.buffer = Math.max(0, this.nextTime - this.context.currentTime)
    }
    return stats
  }

  /** 开始收音频（主进程那边已经 audioStart 过了）：重置时间轴与解码器，等帧到 */
  begin(): void {
    this.resetStream()
    this.active = true
    this.waitingSince = Date.now()
    this.patch({ state: 'connecting', errorCode: '', detail: '' })
    this.startStatsTimer()
  }

  /** 收主进程的音频消息（参数 / 帧批 / 状态） */
  handleMessage(message: AudioMessage): void {
    switch (message.type) {
      case 'status':
        this.handleStatus(message.phase, message.failure)
        return
      case 'config':
        this.configureDecoder(message.config)
        return
      case 'frames': {
        if (!this.active) return
        this.waitingSince = 0
        const decoder = this.decoder
        if (!decoder || decoder.state !== 'configured') {
          // 参数还没到（正常不会发生）：先攒着，别把帧丢了
          for (const frame of message.frames) {
            this.preConfig.push(frame)
            if (this.preConfig.length > MAX_PRECONFIG) this.preConfig.shift()
          }
          return
        }
        for (const frame of message.frames) this.decodeFrame(frame)
        return
      }
    }
  }

  /** 用户交互后恢复播放（自动播放策略：AudioContext 初始可能是 suspended） */
  async resume(): Promise<void> {
    const context = this.ensureContext()
    if (context.state === 'suspended') {
      try {
        await context.resume()
      } catch {
        this.patch({ state: 'blocked' })
        return
      }
    }
    if (context.state === 'running' && this.active) this.patch({ state: 'playing' })
  }

  pause(): void {
    const context = this.context
    if (context && context.state === 'running') void context.suspend()
    if (this.active) this.patch({ state: 'paused' })
  }

  /** 断开/暂停：停掉已排上的帧与解码器（主进程那边的泵由页面显式 audioStop） */
  stopStream(): void {
    this.active = false
    this.waitingSince = 0
    this.resetStream()
    this.stopStatsTimer()
    this.patch({ state: 'idle', buffer: 0 })
  }

  /** 彻底拆掉（插件停用/卸载、页面卸载） */
  dispose(): void {
    this.stopStream()
    const context = this.context
    this.context = null
    this.gain = null
    if (context) void context.close()
  }

  setVolume(value: number): void {
    this.volume = Math.min(1, Math.max(0, value))
    if (this.gain) this.gain.gain.value = this.volume
  }

  private resetStream(): void {
    for (const source of this.sources.keys()) {
      try {
        source.stop()
      } catch {
        // 已经播完了
      }
    }
    this.sources.clear()
    if (this.decoder) {
      try {
        this.decoder.close()
      } catch {
        // 已关闭
      }
      this.decoder = null
    }
    this.config = null
    this.preConfig = []
    this.nextTime = 0
    this.decodeErrors = 0
    this.patch({
      received: 0,
      decoded: 0,
      dropped: 0,
      buffer: 0,
      sampleRate: 0,
      channels: 0,
      detail: ''
    })
  }

  private handleStatus(phase: AudioPhase, failure: FailureInfo | null): void {
    if (!this.active) return
    switch (phase) {
      case 'connecting':
        this.patch({ state: this.stats.state === 'playing' ? 'playing' : 'connecting', errorCode: '', detail: '' })
        return
      case 'live':
        this.startStatsTimer()
        return
      case 'idle':
        this.patch({ state: 'idle' })
        return
      case 'error':
        this.patch({
          state: 'error',
          errorCode: failure?.code ?? 'fetchFailed',
          detail: failure?.detail ?? ''
        })
        return
      default:
        return
    }
  }

  /**
   * 取一个稳定的 AudioContext（**不带 sampleRate**）。
   *
   * 刻意不按流的采样率建上下文：那样每次收到新参数都可能要重建上下文，
   * 而重建出来的上下文不在用户手势里、还可能又处于 suspended（自动播放策略），
   * 白白把「已解锁」的状态丢掉。Web Audio 会给采样率不一致的 buffer 自动重采样
   * （`createBuffer(ch, frames, data.sampleRate)` 就是干这个的），所以一个默认采样率的
   * 上下文就够用，且只建一次。
   */
  private ensureContext(): AudioContext {
    if (this.context) return this.context
    const context = new AudioContext()
    const gain = context.createGain()
    gain.gain.value = this.volume
    gain.connect(context.destination)
    this.context = context
    this.gain = gain
    return context
  }

  private configureDecoder(config: AudioConfig): void {
    if (!this.active) return
    // 收到音轨参数 = 有声音了，看门狗收工
    this.waitingSince = 0
    if (this.config && sameConfig(this.config, config) && this.decoder && this.decoder.state === 'configured') {
      return
    }
    this.config = config
    this.ensureContext()
    this.patch({ sampleRate: config.sampleRate, channels: config.channels })
    if (this.decoder) {
      try {
        this.decoder.close()
      } catch {
        // 忽略
      }
      this.decoder = null
    }
    const decoder = new AudioDecoder({
      output: (data) => this.schedule(data),
      error: (error) => this.handleDecodeError(error)
    })
    try {
      decoder.configure({
        codec: SUPPORTED_HINT,
        sampleRate: config.sampleRate,
        numberOfChannels: config.channels,
        description: config.asc
      })
    } catch (error) {
      this.patch({ state: 'error', errorCode: 'decodeFailed', detail: describe(error) })
      return
    }
    this.decoder = decoder
    this.decodeErrors = 0
    void this.markContextState()
    // 参数到了：把之前攒下的帧补上
    const pending = this.preConfig
    this.preConfig = []
    for (const frame of pending) this.decodeFrame(frame)
  }

  private async markContextState(): Promise<void> {
    const context = this.context
    if (!context) return
    if (context.state === 'suspended') {
      // 自动播放策略：AudioContext 起不来，等用户点一下「播放」
      this.patch({ state: 'blocked' })
      try {
        await context.resume()
      } catch {
        return
      }
      if (this.active && isRunning(context)) this.patch({ state: 'playing' })
      return
    }
    if (this.active) this.patch({ state: 'playing' })
  }

  private decodeFrame(frame: AudioFrame): void {
    this.patch({ received: this.stats.received + 1 })
    const decoder = this.decoder
    if (!decoder || decoder.state !== 'configured') return
    if (decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      this.patch({ dropped: this.stats.dropped + 1 })
      return
    }
    try {
      decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round(frame.ts * 1000),
          data: frame.data
        })
      )
    } catch (error) {
      this.patch({ dropped: this.stats.dropped + 1, detail: describe(error) })
    }
  }

  private schedule(data: AudioData): void {
    const context = this.context
    const gain = this.gain
    if (!context || !gain || !this.active) {
      data.close()
      return
    }
    try {
      if (context.state !== 'running') {
        // 上下文没跑起来（自动播放被拦/已暂停）：丢掉，等用户点播放
        this.patch({ state: 'blocked' })
        return
      }
      const frames = data.numberOfFrames
      const channels = Math.max(1, data.numberOfChannels)
      if (frames <= 0) return
      const buffer = context.createBuffer(channels, frames, data.sampleRate)
      for (let channel = 0; channel < channels; channel += 1) {
        const target = buffer.getChannelData(channel)
        data.copyTo(target, { planeIndex: channel, format: 'f32-planar' })
      }
      const now = context.currentTime
      if (this.nextTime < now + 0.02) this.nextTime = now + LEAD_SECONDS
      if (this.nextTime > now + MAX_LEAD_SECONDS) {
        // 已经甩开直播太远：丢掉这一帧，并**把时间轴拉回「现在 + 目标缓冲」**。
        // 关键：这里必须重置 nextTime。旧版只丢帧不重置，nextTime 会一直吊在超前状态，
        // 后续每一帧都继续命中这里被丢掉——一次突发（例如泵重连灌进来一大批）就能丢几千帧。
        this.nextTime = now + LEAD_SECONDS
        this.patch({ dropped: this.stats.dropped + 1 })
        return
      }
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(gain)
      const endAt = this.nextTime + buffer.duration
      source.start(this.nextTime)
      this.nextTime = endAt
      this.sources.set(source, endAt)
      source.onended = () => {
        this.sources.delete(source)
        try {
          source.disconnect()
        } catch {
          // 忽略
        }
      }
      this.patch({ decoded: this.stats.decoded + 1, state: 'playing' })
    } finally {
      data.close()
    }
  }

  private handleDecodeError(error: unknown): void {
    // 解码器出错后是「已关闭」状态：重建一个继续，连续失败 3 次才报警
    this.patch({ errorCode: 'decodeFailed', detail: describe(error) })
    const config = this.config
    if (!config) {
      this.patch({ state: 'error' })
      return
    }
    const attempts = this.decodeErrors + 1
    this.decodeErrors = attempts
    if (attempts > 3) {
      this.patch({ state: 'error' })
      return
    }
    this.decoder = null
    this.configureDecoder(config)
  }

  private startStatsTimer(): void {
    if (this.statsTimer) return
    this.statsTimer = setInterval(() => {
      this.pruneSources()
      this.checkWatchdog()
      this.emit()
    }, 500)
  }

  /**
   * 兜底清理排过期的音源。
   *
   * 正常由 `source.onended` 回收；但如果 onended 因故没触发（上下文被挂起/被提前 stop），
   * 这些 AudioBufferSourceNode 会一直挂在图上、越积越多——正是「越跑越卡、越跑越占资源」的一种来源。
   * 这里按「预期播完时刻」定期把过期的收掉，保证节点数与 0.7s 的缓冲量同量级。
   */
  private pruneSources(): void {
    const context = this.context
    if (!context) return
    const now = context.currentTime
    for (const [source, endAt] of this.sources) {
      if (now <= endAt + 1) continue
      this.sources.delete(source)
      try {
        source.stop()
      } catch {
        // 已经结束
      }
      try {
        source.disconnect()
      } catch {
        // 忽略
      }
    }
  }

  /**
   * 音频看门狗：**界面不许永远停在「拉流中…」**。
   *
   * 主进程的泵已经有三道出口（首帧死线 / 读空闲 / noAudio 总预算），正常都会给出结论；
   * 万一它自己卡住（或事件没到），这里做最后一道：超时就报 noAudio，让界面有话说。
   */
  private checkWatchdog(): void {
    if (!this.active || this.stats.state !== 'connecting' || this.waitingSince === 0) return
    if (Date.now() - this.waitingSince < CONNECT_DEADLINE_MS) return
    this.patch({
      state: 'error',
      errorCode: 'noAudio',
      detail: `等待音频数据 ${Math.round(CONNECT_DEADLINE_MS / 1000)}s 没有结果`
    })
  }

  private stopStatsTimer(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer)
      this.statsTimer = null
    }
  }

  private patch(changes: Partial<PlayerStats>): void {
    this.stats = { ...this.stats, ...changes }
    this.emit()
  }

  private emit(): void {
    this.onStats?.(this.getStats())
  }
}

function sameConfig(a: AudioConfig, b: AudioConfig): boolean {
  return (
    a.sampleRate === b.sampleRate &&
    a.channels === b.channels &&
    a.objectType === b.objectType &&
    a.asc.length === b.asc.length &&
    a.asc.every((byte, index) => byte === b.asc[index])
  )
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 160)
  return String(error).slice(0, 160)
}
