/**
 * 「第一次点关闭没反应」的**现场诊断**（2026-10-11）。
 *
 * 背景：用户反馈「停在抖音插件页上，点窗口关闭按钮第一次完全没反应，再点一次才关」。
 * 我在两个真机探针里都没能复现（`probe-douyin-plugin-close.mjs`：关闭按钮没有被任何东西盖住，
 * 合成点击一次就退出；`probe-douyin-plugin-wedge.mjs`：插件页在真实推送下 40 秒一直响应）。
 * 既然复现不了，就把**下一次现场**留下来——这里只做两件事，都不轮询、不开新通道：
 *
 * 1. **长任务**：主线程被卡住时，点击事件会迟到（体感就是「没反应」）。
 *    用 `PerformanceObserver` 记 1 秒以上的长任务（这是浏览器原生事件，不是定时器轮询）；
 * 2. **关闭按钮**：拦截捕获阶段的点击，把两件事记进宿主日志（渲染层 `console.warn`
 *    会被宿主转发到 `main.log`，见 RytenBench `main-window.ts` 的渲染 console 转发）：
 *    - 点击落在关闭按钮的矩形里、但事件目标**不是**那个按钮 → 有东西把按钮盖住了（谁盖的都记下来）；
 *    - 点击了关闭按钮，2 秒后页面还活着 → 这一次关闭**没生效**，并附上期间最长的一次卡顿。
 *
 * 日志前缀统一 `[douyin-link][close-probe]`，方便在 `main.log` 里捞。
 */

/** 主线程最优（最长）卡顿：给「点下去没反应」提供数字 */
let worstLag = 0

const describeNode = (node: EventTarget | null): string => {
  if (!(node instanceof Element)) return node ? String(node) : '(null)'
  const cls = typeof node.className === 'string' && node.className ? `.${node.className.split(/\s+/).slice(0, 3).join('.')}` : ''
  return `${node.tagName}${cls}`
}

export function installCloseDiagnostics(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined
  const warn = (message: string): void => {
    // eslint-disable-next-line no-console
    console.warn(`[douyin-link][close-probe] ${message}`)
  }

  /** 1) 长任务：PerformanceObserver（原生事件，不轮询） */
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        worstLag = Math.max(worstLag, Math.round(entry.duration))
        if (entry.duration >= 1000) {
          warn(`主线程卡顿 ${Math.round(entry.duration)}ms（这么长的时间里点击是不会有反应的）`)
        }
      }
    })
    observer.observe({ type: 'longtask', buffered: true })
  } catch {
    observer = null
  }

  /** 2) 关闭按钮：被遮挡 / 点了没生效 */
  const onClick = (event: MouseEvent): void => {
    const button = document.querySelector('.frame-titlebar-btn-close')
    if (!(button instanceof HTMLElement)) return
    const rect = button.getBoundingClientRect()
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom

    if (inside && !button.contains(event.target as Node)) {
      warn(
        `关闭按钮被挡住：点击落在 ${describeNode(event.target)}（按钮位置 ${Math.round(rect.left)},${Math.round(rect.top)} ` +
          `${Math.round(rect.width)}x${Math.round(rect.height)}）`
      )
      return
    }
    if (!inside || !button.contains(event.target as Node)) return

    // 点了关闭按钮：2 秒后如果本页还在，说明这一次关闭没生效（把当时的卡顿一起记下来）
    const at = Date.now()
    window.setTimeout(() => {
      if (typeof document === 'undefined' || !document.documentElement) return
      warn(
        `点了关闭按钮 2 秒后页面还在（这一次关闭没生效）；点击前主线程最长卡顿 ${worstLag}ms、` +
          `这次点击后累计 ${Date.now() - at}ms`
      )
    }, 2000)
  }

  document.addEventListener('click', onClick, true)
  return () => {
    document.removeEventListener('click', onClick, true)
    observer?.disconnect()
  }
}
