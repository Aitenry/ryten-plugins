import { useEffect, useState } from 'react'
import api from '../api'
import { usePluginPalette } from './ui'

/**
 * 头像：**必须由主进程下载成 data URL**。
 *
 * 宿主渲染层的 CSP 是 `img-src 'self' data: plugin:`——抖音 CDN 的外链图片一律被拦，
 * 所以 `src` 直接用档案里的 `avatar` 会得到一个空白框。这里的做法：
 * 1. `userId` 有值时向主进程要 data URL（主进程带 referer 下载、转 base64、按 url 缓存）；
 * 2. 拿不到（没头像/超时/CSP 之外）就退回「昵称首字」色块，永远不会是空白。
 *
 * 只给真正画出来的行请求（事件行 + 详情页），聊天流里的每一行都用首字色块——
 * 一场直播几千人，逐个下载头像是自己打自己 CDN。
 */
const cache = new Map<string, string>()
const pending = new Map<string, Promise<string>>()

function keyOf(webRid: string, userId: string): string {
  return `${webRid}:${userId}`
}

function load(webRid: string, userId: string): Promise<string> {
  const key = keyOf(webRid, userId)
  const hit = cache.get(key)
  if (hit !== undefined) return Promise.resolve(hit)
  const running = pending.get(key)
  if (running) return running
  const task = api
    .userAvatar(webRid, userId)
    .then((dataUrl) => {
      cache.set(key, dataUrl)
      return dataUrl
    })
    .catch(() => '')
    .finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}

/** 供「清空用户记录」时把本地缓存一起丢掉 */
export function clearAvatarCache(): void {
  cache.clear()
}

export function UserAvatar(props: {
  /** 头像按房间缓存（同一个人在 A 房与 B 房可能是不同的历史头像） */
  webRid: string
  userId: string
  nickname: string
  size?: number
  /** 传 false 就不下载，只用首字色块（聊天流用） */
  fetch?: boolean
}): React.JSX.Element {
  const palette = usePluginPalette()
  const size = props.size ?? 22
  const [url, setUrl] = useState(() => cache.get(keyOf(props.webRid, props.userId)) ?? '')

  useEffect(() => {
    if (!props.userId || props.fetch === false) return
    let alive = true
    void load(props.webRid, props.userId).then((dataUrl) => {
      if (alive) setUrl(dataUrl)
    })
    return () => {
      alive = false
    }
  }, [props.webRid, props.userId, props.fetch])

  const letter = (props.nickname || '?').trim().slice(0, 1).toUpperCase()
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full text-[10px]"
      style={{
        width: size,
        height: size,
        color: palette.surface,
        backgroundColor: colorOf(props.userId || props.nickname, palette.accent, palette.warn, palette.up)
      }}
      title={props.nickname}
    >
      {url ? <img src={url} alt="" width={size} height={size} style={{ objectFit: 'cover' }} /> : letter}
    </span>
  )
}

/** 没有头像时的底色：按 id 稳定取一个调色板颜色（同一个用户每次都是同一个色） */
function colorOf(seed: string, ...candidates: string[]): string {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 100000
  }
  return candidates[hash % candidates.length] ?? candidates[0]
}
