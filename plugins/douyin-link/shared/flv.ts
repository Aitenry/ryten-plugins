/**
 * FLV 解复用（只取音轨，纯函数，无宿主依赖）——**主进程与渲染层共用**。
 *
 * 为什么解复用放主进程（这是改过一次的架构，别再搬回去）：
 * 宿主渲染层的 HTML 带一份很严的 CSP
 * （`default-src 'self' plugin:; connect-src 'self' plugin:; media-src 'self' blob: plugin:`），
 * 渲染层发出的**任何**外部请求（抖音 CDN 的 https 地址）都会被拦掉。
 * 所以「拉流」只能在主进程做，见 main/audio/pump.ts：主进程拉流 + 解复用，
 * 把一枚枚 **AAC 裸帧**（几十 KB/s，量很小）推进渲染层，渲染层只做 WebCodecs 解码 + Web Audio 播放。
 * 本文件因此不能 import electron / node（它会被打进渲染层之外，也会被主进程引用）。
 *
 * FLV 结构（都用真机数据核对过）：
 *   | "FLV" ver flags dataOffset(4B,=9) | PreviousTagSize0(4B) | Tag… |
 *   Tag: | type(1B: 8=audio 9=video 18=script) dataSize(3B) timestamp(3B) tsExt(1B) streamId(3B) | data | prevTagSize(4B) |
 *   AAC 音频 data: | soundFormat(4bit,10=AAC) rate(2bit) size(1bit) ch(1bit) | packetType(1B: 0=ASC 1=裸帧) | payload |
 *
 * 实测这路流是 AAC-LC 44.1/48 kHz 立体声（ASC = 12 10 或 11 90），约 43~51 帧/秒、帧长 ~400B。
 */

export interface FlvAudioConfig {
  /** AudioSpecificConfig（WebCodecs 的 description 要它） */
  asc: Uint8Array
  /** AAC object type（2 = LC） */
  objectType: number
  sampleRate: number
  channels: number
}

export interface FlvStats {
  tags: number
  audioFrames: number
  audioBytes: number
  videoTags: number
  /** 被丢弃的字节（视频 + 非数据标签，只用于展示「省了多少」） */
  skippedBytes: number
  firstTimestamp: number
  lastTimestamp: number
}

export interface FlvHandlers {
  onConfig?: (config: FlvAudioConfig) => void
  onFrame?: (frame: Uint8Array, timestampMs: number) => void
  onEnd?: () => void
}

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350
]

const EMPTY = new Uint8Array(0)

export class FlvDemuxer {
  private readonly handlers: FlvHandlers
  private tail: Uint8Array = EMPTY
  private headerDone = false
  private broken = false
  readonly stats: FlvStats = {
    tags: 0,
    audioFrames: 0,
    audioBytes: 0,
    videoTags: 0,
    skippedBytes: 0,
    firstTimestamp: -1,
    lastTimestamp: -1
  }

  constructor(handlers: FlvHandlers) {
    this.handlers = handlers
  }

  /** 喂一段流数据；不完整的数据留在内部等下一段 */
  feed(chunk: Uint8Array): void {
    if (this.broken || !chunk || chunk.length === 0) return
    const data = this.tail.length ? concat(this.tail, chunk) : chunk
    let offset = 0

    if (!this.headerDone) {
      if (data.length < 13) {
        this.tail = copy(data)
        return
      }
      const signature = String.fromCharCode(data[0], data[1], data[2])
      if (signature !== 'FLV') {
        // 不是 FLV（多半拉到了错误页/鉴权页）：判废，让上层重连而不是空转
        this.broken = true
        this.handlers.onEnd?.()
        return
      }
      const dataOffset = readUint32(data, 5)
      offset = dataOffset + 4 // 跳过 PreviousTagSize0
      this.headerDone = true
    }

    for (;;) {
      if (offset + 11 > data.length) break
      const type = data[offset]
      const size = (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]
      const timestamp =
        ((data[offset + 7] << 24) | (data[offset + 4] << 16) | (data[offset + 5] << 8) | data[offset + 6]) >>> 0
      const end = offset + 11 + size + 4
      if (end > data.length) break
      this.handleTag(type, data.subarray(offset + 11, offset + 11 + size), timestamp)
      offset = end
      if (this.broken) return
    }

    this.tail = offset >= data.length ? EMPTY : copy(data.subarray(offset))
  }

  private handleTag(type: number, body: Uint8Array, timestampMs: number): void {
    this.stats.tags += 1
    if (type === 8) {
      if (body.length < 2) return
      const soundFormat = body[0] >> 4
      if (soundFormat !== 10) {
        // 不是 AAC（老流可能是 MP3）：整条流没法用，直接判废，省得上层空转
        this.broken = true
        this.handlers.onEnd?.()
        return
      }
      const packetType = body[1]
      if (packetType === 0) {
        const asc = body.subarray(2)
        if (asc.length < 2) return
        const parsed = parseAsc(asc)
        this.handlers.onConfig?.(parsed)
        return
      }
      const frame = body.subarray(2)
      if (frame.length === 0) return
      this.stats.audioFrames += 1
      this.stats.audioBytes += frame.length
      if (this.stats.firstTimestamp < 0) this.stats.firstTimestamp = timestampMs
      this.stats.lastTimestamp = timestampMs
      this.handlers.onFrame?.(frame, timestampMs)
      return
    }
    if (type === 9) {
      this.stats.videoTags += 1
      this.stats.skippedBytes += body.length
      return
    }
    // script(18) / 其它：只记账
    this.stats.skippedBytes += body.length
  }
}

/** 解 AudioSpecificConfig（前两字节就够 AAC-LC 用） */
export function parseAsc(asc: Uint8Array): FlvAudioConfig {
  const objectType = asc[0] >> 3
  const rateIndex = ((asc[0] & 0x07) << 1) | (asc[1] >> 7)
  const channels = (asc[1] >> 3) & 0x0f
  return {
    asc: copy(asc),
    objectType,
    sampleRate: AAC_SAMPLE_RATES[rateIndex] ?? 48000,
    channels: channels > 0 ? channels : 2
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function copy(view: Uint8Array): Uint8Array {
  const out = new Uint8Array(view.length)
  out.set(view)
  return out
}

function readUint32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] * 0x1000000 + (data[offset + 1] << 16) + (data[offset + 2] << 8) + data[offset + 3]) >>> 0
  )
}
