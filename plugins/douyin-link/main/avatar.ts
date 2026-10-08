import { net } from 'electron'
import logger from 'electron-log'
import { withTimeout } from './util/deadline'

/**
 * 头像缓存（内存，按需下载）。
 *
 * 为什么必须由主进程下载：宿主渲染层的 CSP 是 `img-src 'self' data: plugin:`，
 * **外链图片一律加载不了**，所以头像要主进程取下来转成 data URL 再给界面。
 *
 * 三条上限（一场直播能出现几千个头像，无节流就是自己打自己 CDN）：
 * 缓存 400 条、同时 4 个请求、单张 ≤ 512KB；失败（超时/超大/不是图片）返回空串，
 * 界面用首字母兜底。这是**缓存**不是数据：插件停用即丢，不落盘（档案在数据库里）。
 */

/** 头像缓存条数（一条约 10~40KB） */
const AVATAR_CAP = 400
/** 同时下载的头像数 */
const AVATAR_CONCURRENCY = 4
const AVATAR_TIMEOUT_MS = 8000
/** 单张头像的体积上限（超了直接放弃，别把 IPC 撑爆） */
const AVATAR_MAX_BYTES = 512 * 1024

export class AvatarCache {
  private avatars = new Map<string, string>()
  private pending = new Map<string, Promise<string>>()
  private running = 0
  private queue: Array<() => void> = []

  /** 头像地址 → data URL（命中缓存立刻返回；同一个地址并发只下载一次） */
  async dataUrl(url: string): Promise<string> {
    if (!url) return ''
    const cached = this.avatars.get(url)
    if (cached) return cached
    const pending = this.pending.get(url)
    if (pending) return pending

    const task = this.withSlot(async () => {
      const dataUrl = await downloadAvatar(url)
      if (dataUrl) {
        this.avatars.set(url, dataUrl)
        if (this.avatars.size > AVATAR_CAP) {
          // 简单淘汰：删最早插入的那条（Map 保持插入顺序）
          const oldest = this.avatars.keys().next().value
          if (oldest) this.avatars.delete(oldest)
        }
      }
      return dataUrl
    }).finally(() => {
      this.pending.delete(url)
    })
    this.pending.set(url, task)
    return task
  }

  dispose(): void {
    this.avatars.clear()
    this.pending.clear()
  }

  private async withSlot<T>(run: () => Promise<T>): Promise<T> {
    if (this.running >= AVATAR_CONCURRENCY) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.running += 1
    try {
      return await run()
    } finally {
      this.running -= 1
      const next = this.queue.shift()
      if (next) next()
    }
  }
}

/** 下载头像并转成 data URL（先 Node fetch，再回落 Chromium 网络栈） */
async function downloadAvatar(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return ''
  const attempts: Array<() => Promise<Buffer | null>> = [
    async () => {
      const response = await fetch(url, {
        headers: { referer: 'https://live.douyin.com/', accept: 'image/*' },
        signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS)
      })
      if (!response.ok) return null
      return Buffer.from(await response.arrayBuffer())
    },
    async () => {
      const response = await net.fetch(url, {
        headers: { referer: 'https://live.douyin.com/', accept: 'image/*' }
      })
      if (!response.ok) return null
      return Buffer.from(await response.arrayBuffer())
    }
  ]
  for (const attempt of attempts) {
    try {
      const buffer = await withTimeout(attempt(), AVATAR_TIMEOUT_MS + 2000, 'avatar')
      if (!buffer || buffer.length === 0 || buffer.length > AVATAR_MAX_BYTES) continue
      const mime = sniffImage(buffer)
      if (!mime) continue
      return `data:${mime};base64,${buffer.toString('base64')}`
    } catch (error) {
      // 换下一种取法（两种都失败就返回空串，界面用首字母兜底）
      logger.debug('[douyin-link] 头像下载失败，换下一种取法:', describe(error))
    }
  }
  return ''
}

/** 认一下图片类型（只认渲染层能画的几种） */
function sniffImage(buffer: Buffer): string {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png'
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF') return 'image/webp'
  if (buffer.length > 6 && buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  return ''
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 160)
  return String(error).slice(0, 160)
}

export const avatarCache = new AvatarCache()
