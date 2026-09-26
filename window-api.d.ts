/**
 * 宿主 preload 暴露的 `window.api` **类型**面（独立插件按需声明，真源在 RytenBench 的
 * `src/preload/index.ts` / `src/renderer/resource/types/window.d.ts`）。
 *
 * 插件只走两条路：
 * - `api.plugin.invoke('plugin:<自己的命名空间>:<通道>')`：调用自己主进程注册的通道；
 * - `api.plugin.on(...)`：订阅自己主进程 `registerEvent` 声明过的事件通道；
 * 以及宿主已有的通用能力（如 `systemSettings`），它们不经插件通道、无需声明权限。
 */
interface Window {
  api: {
    plugin: {
      /** 调用插件通道（宿主按 `plugin:<ns>:` 前缀与命名空间归属校验） */
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
      /** 订阅插件事件通道（宿主 preload 白名单门控） */
      on: (channel: string, callback: (data?: unknown) => void) => () => void
      /** 插件列表（宿主面板用；插件一般不需要） */
      list: () => Promise<unknown[]>
    }
    systemSettings: {
      /** 全部系统设置（宿主返回一个宽松对象；插件按自己声明的形状读字段） */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getAll: () => Promise<any>
      update: (updates: Record<string, unknown>) => Promise<boolean>
    }
  }
}
