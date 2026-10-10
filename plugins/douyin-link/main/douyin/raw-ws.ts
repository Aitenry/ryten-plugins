import * as net from 'node:net'
import * as tls from 'node:tls'
import * as crypto from 'node:crypto'

/**
 * 最小 WebSocket 客户端（主进程用，纯 Node 内置，不引第三方库）。
 *
 * 为什么必须自己实现、不能用全局 `WebSocket`：
 * 抖音推送 ws 的握手要带**页面原始的那几个头**（`Origin: https://live.douyin.com`、`Cookie`、
 * `User-Agent`），而 WHATWG `WebSocket` 不允许自定义请求头。CDP 侧（ws://127.0.0.1）本可用全局的，
 * 但两处统一到这一份实现，行为一致、也少一份对运行环境的假设（构建产物 target 是 node20）。
 *
 * 与浏览器 ws 的差异（够用即止）：
 * - **只认握手返回 101**；非 101 时把响应头里的 `Handshake-Msg`（抖音会写 `DEVICE_BLOCKED`）
 *   原样抛给上层——这正是我们要在日志里看到的关键信息；
 * - **不发 `Sec-WebSocket-Extensions`**：否则会协商 permessage-deflate，收帧要额外处理 RSV1（压缩位），
 *   我们不需要压缩（抖音推送帧自身在应用层就是 gzip，见 push-capture）；
 * - 客户端出帧**一律掩码**（协议要求），支持 126/127 长度；服务端帧按 1/2/8/9/10 处理；
 * - 分片（continuation）按 opcode 0 累积，够 CDP 的大消息用。
 */

export interface RawWsOptions {
  /** 附加请求头（Origin / Cookie / User-Agent 等）；保留头会被忽略 */
  headers?: Record<string, string>
  /** 建连（含握手）死线 */
  timeoutMs?: number
}

/** 握手未成功时抛这个：带上 HTTP 状态与 `Handshake-Msg`，便于上层映射失败码 */
export class WsHandshakeError extends Error {
  readonly status: number
  readonly handshakeMsg: string

  constructor(status: number, handshakeMsg: string) {
    super(`ws handshake ${status}${handshakeMsg ? ` ${handshakeMsg}` : ''}`)
    this.name = 'WsHandshakeError'
    this.status = status
    this.handshakeMsg = handshakeMsg
  }
}

const RESERVED = new Set([
  'host',
  'upgrade',
  'connection',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol'
])

export class RawWebSocket {
  onopen: (() => void) | null = null
  onmessage: ((data: Buffer, isBinary: boolean) => void) | null = null
  onclose: ((reason: string, code?: number) => void) | null = null
  onerror: ((error: Error) => void) | null = null

  private readonly url: URL
  private readonly options: RawWsOptions
  private socket: net.Socket | tls.TLSSocket | null = null
  private buffer = Buffer.alloc(0)
  /** 握手已完成（101 之后） */
  private opened = false
  private finished = false
  /** 分片累积 */
  private fragment: { opcode: number; chunks: Buffer[] } | null = null
  private readonly timeout: ReturnType<typeof setTimeout> | null

  constructor(url: string, options: RawWsOptions = {}) {
    this.url = new URL(url)
    this.options = options
    const timeoutMs = options.timeoutMs ?? 15000
    this.timeout = setTimeout(() => this.fail(new Error('ws handshake timeout')), timeoutMs)
    this.connect()
  }

  get ready(): boolean {
    return this.opened
  }

  /** 发一帧（opcode：1 文本 / 2 二进制 / 9 ping）。默认文本，供 CDP 用 */
  send(data: Buffer | string, opcode = 1): void {
    if (!this.opened || !this.socket) return
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    try {
      this.socket.write(frameOut(opcode, payload))
    } catch (error) {
      this.fail(asError(error))
    }
  }

  ping(): void {
    this.send(Buffer.alloc(0), 0x09)
  }

  close(): void {
    if (this.finished) return
    try {
      if (this.opened && this.socket) this.socket.write(frameOut(0x08, Buffer.from([0x03, 0xe8])))
    } catch {
      /* ignore */
    }
    this.finished = true
    if (this.timeout) clearTimeout(this.timeout)
    try {
      this.socket?.destroy()
    } catch {
      /* ignore */
    }
    this.socket = null
  }

  /* --------------------------------------------------------------- 内部 */

  private connect(): void {
    const secure = this.url.protocol === 'wss:'
    const host = this.url.hostname
    const port = Number(this.url.port) || (secure ? 443 : 80)
    const onConnect = () => this.writeHandshake(host, port)
    try {
      this.socket = secure
        ? tls.connect({ host, port, servername: host }, onConnect)
        : net.connect({ host, port }, onConnect)
    } catch (error) {
      this.fail(asError(error))
      return
    }
    this.socket.on('data', (chunk) => this.onData(chunk))
    this.socket.on('error', (error) => this.fail(asError(error)))
    this.socket.on('close', () => this.finish('socket closed'))
  }

  private writeHandshake(host: string, port: number): void {
    const key = crypto.randomBytes(16).toString('base64')
    const lines = [
      `GET ${this.url.pathname}${this.url.search} HTTP/1.1`,
      `Host: ${host}${isDefaultPort(this.url.protocol, port) ? '' : `:${port}`}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13'
    ]
    for (const [name, value] of Object.entries(this.options.headers ?? {})) {
      if (RESERVED.has(name.toLowerCase())) continue
      lines.push(`${name}: ${value}`)
    }
    try {
      this.socket?.write(`${lines.join('\r\n')}\r\n\r\n`)
    } catch (error) {
      this.fail(asError(error))
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (!this.opened) {
      const end = this.buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const head = this.buffer.subarray(0, end).toString('utf8')
      this.buffer = this.buffer.subarray(end + 4)
      const status = Number((head.match(/^HTTP\/\d\.\d (\d{3})/) ?? [])[1] ?? 0)
      if (status !== 101) {
        const msg = (head.match(/Handshake-Msg:\s*(.+)/i) ?? [])[1]?.trim() ?? ''
        this.fail(new WsHandshakeError(status, msg))
        return
      }
      this.opened = true
      if (this.timeout) clearTimeout(this.timeout)
      this.onopen?.()
    }
    this.drainFrames()
  }

  private drainFrames(): void {
    for (;;) {
      if (this.buffer.length < 2) return
      const b0 = this.buffer[0]
      const b1 = this.buffer[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let length = b1 & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        length = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      let mask: Buffer | null = null
      if (masked) {
        if (this.buffer.length < offset + 4) return
        mask = this.buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (this.buffer.length < offset + length) return
      let payload: Buffer<ArrayBufferLike> = this.buffer.subarray(offset, offset + length)
      this.buffer = this.buffer.subarray(offset + length)
      if (mask) payload = unmask(payload, mask)

      if (opcode === 0x08) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : undefined
        this.finish('server closed', code)
        return
      }
      if (opcode === 0x09) {
        this.send(payload, 0x0a) // ping → pong
        continue
      }
      if (opcode === 0x0a) continue // pong：忽略

      if (opcode === 0x00 && this.fragment) {
        this.fragment.chunks.push(payload)
        if (fin) {
          const data = Buffer.concat(this.fragment.chunks)
          const isBinary = this.fragment.opcode === 0x02
          this.fragment = null
          this.onmessage?.(data, isBinary)
        }
        continue
      }
      if (opcode === 0x01 || opcode === 0x02) {
        if (!fin) {
          this.fragment = { opcode, chunks: [payload] }
          continue
        }
        this.onmessage?.(payload, opcode === 0x02)
      }
    }
  }

  private fail(error: Error): void {
    if (this.finished) return
    this.onerror?.(error)
    this.finish(error.message)
  }

  private finish(reason: string, code?: number): void {
    if (this.finished) return
    this.finished = true
    if (this.timeout) clearTimeout(this.timeout)
    try {
      this.socket?.destroy()
    } catch {
      /* ignore */
    }
    this.socket = null
    this.onclose?.(reason, code)
  }
}

/** 客户端出帧：一律掩码（协议要求），支持 126/127 长度 */
export function frameOut(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  const mask = crypto.randomBytes(4)
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

function unmask(payload: Buffer, mask: Buffer): Buffer {
  const out = Buffer.from(payload)
  for (let i = 0; i < out.length; i += 1) out[i] ^= mask[i % 4]
  return out
}

function isDefaultPort(protocol: string, port: number): boolean {
  return (protocol === 'wss:' && port === 443) || (protocol === 'ws:' && port === 80)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}