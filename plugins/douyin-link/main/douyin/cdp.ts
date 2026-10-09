import * as http from 'node:http'
import { RawWebSocket } from './raw-ws'

/**
 * 极简 CDP（Chrome DevTools Protocol）客户端。
 *
 * 用在哪：主进程 spawn 本机 Chromium 后，连它的**浏览器级** WebSocket，用 `Target.*` 开标签页、
 * `Network.*` 抓那条已签名的推送 ws URL、`Page.reload` 触发重签。
 *
 * 会话模型：连浏览器级端点后，用 `Target.attachToTarget({flatten:true})` 拿到 `sessionId`，
 * 之后所有页面级命令/事件都带 `sessionId`（「扁平」模式，不需要每条命令再嵌 sessionId 字段）。
 * 这样**不必**再去 `/json/list` 轮询页面自己的 `webSocketDebuggerUrl`。
 */

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class Cdp {
  private readonly ws: RawWebSocket
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<(params: Record<string, unknown>, sessionId?: string) => void>>()
  private closed = false

  private constructor(ws: RawWebSocket) {
    this.ws = ws
    ws.onmessage = (data, isBinary) => {
      if (isBinary) return
      this.dispatch(data.toString('utf8'))
    }
    ws.onclose = (reason) => {
      this.closed = true
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`cdp closed: ${reason}`))
      }
      this.pending.clear()
    }
  }

  static connect(wsUrl: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new RawWebSocket(wsUrl, { timeoutMs: 10000 })
      const cdp = new Cdp(ws)
      ws.onopen = () => resolve(cdp)
      ws.onerror = (error) => reject(error)
    })
  }

  /** 发一条命令；失败（CDP error / 连接断开）时 reject */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('cdp closed'))
    const id = this.nextId++
    const payload: Record<string, unknown> = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`cdp timeout: ${method}`))
      }, 20000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify(payload))
    })
  }

  /** 订阅一个 CDP 事件；返回退订函数 */
  on(method: string, handler: (params: Record<string, unknown>, sessionId?: string) => void): () => void {
    const set = this.listeners.get(method) ?? new Set()
    set.add(handler)
    this.listeners.set(method, set)
    return () => set.delete(handler)
  }

  close(): void {
    this.closed = true
    this.ws.close()
  }

  private dispatch(text: string): void {
    let message: {
      id?: number
      result?: unknown
      error?: { message?: string }
      method?: string
      params?: Record<string, unknown>
      sessionId?: string
    }
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message ?? 'cdp error'))
      else pending.resolve(message.result)
      return
    }
    if (message.method) {
      for (const handler of this.listeners.get(message.method) ?? []) {
        try {
          handler(message.params ?? {}, message.sessionId)
        } catch {
          /* 订阅者自己的异常不该拖垮 CDP 分发 */
        }
      }
    }
  }
}

/** 取 `http://127.0.0.1:<port>/json/version`（浏览器级 `webSocketDebuggerUrl` 在这里） */
export function devtoolsVersion(port: number, timeoutMs = 1000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`devtools version HTTP ${res.statusCode}`))
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error('devtools version timeout')))
    request.on('error', reject)
  })
}