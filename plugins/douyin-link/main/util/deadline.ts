/**
 * 看门狗小工具：**给「可能永远不 resolve 的 await」套一个死线**。
 *
 * 为什么单开一个文件：这个插件被两次「界面永远停在某个中间态」咬过
 * （弹幕采集窗口 loadURL / debugger.sendCommand、音频泵连上却没有帧），
 * 共同点都是某一步没有出口。所以凡是跨进程/跨网络的 await，都从这里过一道。
 */

/** 超时专用错误（调用方只关心「没在死线内给出结果」） */
export class TimeoutError extends Error {
  readonly label: string

  constructor(label: string, ms: number) {
    super(`${label} 超过 ${ms}ms 没有结果`)
    this.name = 'TimeoutError'
    this.label = label
  }
}

/** 死线竞速：超时就抛 TimeoutError（原 promise 继续跑，其结果被丢弃） */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** 毫秒睡眠（重试用） */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 从某一刻算起的耗时，日志里统一用它（`+123ms`） */
export function since(startedAt: number): string {
  return `+${Date.now() - startedAt}ms`
}
