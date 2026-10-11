import { app, BrowserWindow } from 'electron'
import logger from 'electron-log'

/**
 * 「关闭窗口要关两次」的**现场记录**（2026-10-11）。
 *
 * 用户点的是**任务栏右键菜单里的「关闭窗口」**（截图确认），那等价于系统给窗口发
 * `WM_SYSCOMMAND/SC_CLOSE` 或 `WM_CLOSE`。这条路渲染层看不见，所以我们把探针放在
 * **主进程**里 —— 插件的主模块本来就跑在宿主主进程里，可以直接听 Electron 自己的生命周期。
 *
 * 它要回答的是一个二选一（下一轮排查全靠这几行）：
 *
 * - 日志里**有** `窗口收到 close` → 系统的关闭消息确实到了 Electron，问题在它之后的退出链
 *   （`before-quit` 被 preventDefault / 数据库收尾 / 某个退出前钩子拖着）；
 * - 日志里**没有** `窗口收到 close` → 消息根本没到应用（比如窗口当时是隐藏的：我这边实测
 *   隐藏窗口下 `WM_CLOSE` 完全不生效），那就不是退出链的问题。
 *
 * 顺带把每一步的时刻与**窗口状态**记下来：`visible/minimized/destroyed` 正是上一轮踩过的坑
 * （探针实例的主窗口 `IsWindowVisible=False` 时，响应性指标与关闭消息都不作数）。
 *
 * 全部走事件、**不轮询**；只在真的要退出/关闭时各写一行 `info`（前缀 `[douyin-link][quit-probe]`
 * 便于在 main.log 里捞）。
 */
export function installQuitProbe(): () => void {
  const startedAt = Date.now()
  const log = (message: string): void => {
    logger.info(`[douyin-link][quit-probe] +${((Date.now() - startedAt) / 1000).toFixed(1)}s ${message}`)
  }

  const windows = (): string => {
    const list = BrowserWindow.getAllWindows()
    if (list.length === 0) return '窗口：无'
    return (
      '窗口：' +
      list
        .map((win, index) => `#${index} visible=${win.isVisible()} minimized=${win.isMinimized()} destroyed=${win.isDestroyed()}`)
        .join(' | ')
    )
  }

  const onClose = (): void => log(`窗口收到 close（任务栏/托盘/系统的关闭都走这里）；${windows()}`)
  const onClosed = (): void => log(`窗口 closed；${windows()}`)
  const onAllClosed = (): void => log(`app window-all-closed；${windows()}`)
  const onBeforeQuit = (): void => log(`app before-quit；${windows()}`)
  const onWillQuit = (): void => log(`app will-quit；${windows()}`)

  const watchWindow = (win: BrowserWindow): void => {
    if (win.isDestroyed()) return
    win.on('close', onClose)
    win.on('closed', onClosed)
  }

  app.on('window-all-closed', onAllClosed)
  app.on('before-quit', onBeforeQuit)
  app.on('will-quit', onWillQuit)
  for (const win of BrowserWindow.getAllWindows()) watchWindow(win)
  /**
   * 渲染进程崩溃后宿主会**重建**主窗口（main-window.ts 的自愈），新窗口也要挂上，
   * 否则那之后的关闭就没有记录了。
   */
  const onCreated = (_event: unknown, win: BrowserWindow): void => watchWindow(win)
  app.on('browser-window-created', onCreated as never)

  return () => {
    app.off('window-all-closed', onAllClosed)
    app.off('before-quit', onBeforeQuit)
    app.off('will-quit', onWillQuit)
    app.off('browser-window-created', onCreated as never)
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.off('close', onClose)
      win.off('closed', onClosed)
    }
  }
}
