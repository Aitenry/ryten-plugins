import { app, BrowserWindow } from 'electron'
import logger from 'electron-log'

/**
 * 隐藏窗口守卫：**我们的采集窗口不许变成用户看得见的窗口，也不许把应用吊住**。
 *
 * 为什么需要（2026-10-08 用户实测：「我关闭这个应用之后，打开后是抖音的直播间画面」）：
 * 主进程为了截弹幕 websocket 开了一个 `show: false` 的窗口（见 ./douyin/danmaku.ts）——
 * 它虽然不可见，但**是一个货真价实的 BrowserWindow**，宿主 core 的两条逻辑因此被它带偏：
 *
 * 1. `window-all-closed → app.quit()`（宿主 src/main/lifecycle.ts）以「所有窗口都关了」为条件。
 *    只要我们的隐藏窗口还活着，用户关掉主窗口之后**应用永远不会退出**：
 *    进程留在后台，隐藏窗口继续拉直播间页面、音频泵继续取流（用户以为已经关掉了）。
 * 2. 再次启动应用时，宿主的 `second-instance` 处理器会把
 *    `BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())` 那个窗口 `show()` 出来
 *    （宿主 src/main/index.ts）——真机实测（Electron 44 / Windows）`getAllWindows()` 是
 *    **新窗口在前**：采集窗口总是后建的，所以被挑中的恰好是它。
 *    抖音直播间页面于是被顶到用户脸上，而真正的新实例因为单实例锁直接退出
 *    （日志里只有一行 `ERR_FAILED loading … loading.html`）。
 *
 * 三条对策（都在主进程，不需要宿主配合，也没有改任何 core 代码）：
 *
 * - `guardHiddenWindow(win)`：把窗口登记成「我们的」，并**一旦被 show 就立刻按回去**——
 *   不管是谁调用的 `show()`（宿主、页面、还是我们自己手滑），隐藏窗口都不会留在屏幕上；
 * - `revealHostMainWindow()`：作为上一条的补救，按回去之后顺手把宿主主窗口露出来
 *   （用户点图标要的是界面，不是「什么都没发生」）；
 * - `installHostWindowGuard(hooks)`：盯住宿主的**主窗口**（加载 `…/resource/index.html`
 *   的那个窗口，加载页/托盘菜单/预览窗口都不匹配）。主窗口一被销毁，就说明用户界面没了、
 *   该收摊了：回调里把采集窗口与音频泵收掉，进程回到「只剩宿主自己的窗口」的状态，
 *   `window-all-closed` 才有机会触发（否则退出流程永远等不到最后一刻）。
 *
 * 注意两种**不该收摊**的情形，别把它们误判成「关掉了」：
 * - 「关闭到系统托盘」：宿主在 `win.on('close')` 里 `preventDefault() + hide()`，
 *   窗口没有 `closed` 事件，所以这里不会触发——应用驻留后台、监控继续，这是应用自己的特性；
 * - 渲染进程崩溃后的自愈重建：宿主的做法是「先建新主窗口、再销毁旧的」，
 *   所以新窗口被我们收养之后，旧窗口的 `closed` 会被忽略（见下面 `trackedMain !== win` 的判断）。
 */

/** 宿主主窗口的地址标记（dev 走 ELECTRON_RENDERER_URL，打包走 loadFile，两者都带这一段） */
const MAIN_WINDOW_MARK = '/resource/index.html'

/** 本插件自己的窗口（弹幕采集用）。**绝不可见**，也不算宿主窗口 */
const OURS = new WeakSet<BrowserWindow>()

/** 当前认定的宿主主窗口（渲染进程自愈重建时会被新窗口顶替；被销毁后置空） */
let trackedMain: BrowserWindow | null = null

/** 隐藏窗口被人 show() 时的补救动作（由 installHostWindowGuard 装上：把界面露出来） */
let onHiddenShown: (() => void) | null = null

/** 登记一个「我们的隐藏窗口」：任何 show() 都立刻按回去 */
export function guardHiddenWindow(win: BrowserWindow): void {
  OURS.add(win)
  win.on('show', () => {
    if (win.isDestroyed()) return
    logger.warn('[douyin-link] 隐藏采集窗口被 show() 了，立刻按回去（防止直播间画面顶到界面上）')
    win.hide()
    // 又一条真机实测结论（Electron 44 / Windows）：`BrowserWindow.getAllWindows()` 是
    // **新窗口在前**。宿主 second-instance 处理器取的是 `getAllWindows().find(存活的那个)`，
    // 而采集窗口总是后建的 ⇒ 现实里它挑中的就是我们的采集窗口，
    // 于是「用户点应用图标想回界面」变成了「抖音直播间顶到脸上」。
    // 我们把它按回去之后，顺手替宿主把主窗口露出来——用户要的本来就是界面。
    try {
      onHiddenShown?.()
    } catch (error) {
      logger.warn('[douyin-link] 露回宿主主窗口失败:', error)
    }
  })
}

/** 把宿主主窗口露出来（最小化就还原）。返回是否真的找到了主窗口 */
export function revealHostMainWindow(): boolean {
  const win = trackedMain
  if (!win || win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
  logger.info('[douyin-link] 已替宿主把主窗口露出来（隐藏窗口被误 show 的补救）')
  return true
}

/** 这个窗口是不是本插件的隐藏采集窗口 */
export function isGuardedWindow(win: BrowserWindow): boolean {
  return OURS.has(win)
}

export interface HostWindowGuardHooks {
  /**
   * 宿主主窗口被销毁（不是 hide）时调用：这里应该把插件**所有带窗口/带后台流的东西**收掉，
   * 但保留房间清单、设置与定时器（宿主还有可能在同一个进程里重建窗口）。
   */
  onHostUiGone: () => void
  /**
   * 我们的隐藏窗口被 show() 时调用（已经按回去了）：默认动作就是把宿主主窗口露出来——
   * 会走到这一步，说明宿主 second-instance 挑错了窗口（见 `guardHiddenWindow` 里的说明）。
   */
  onHiddenWindowShown?: () => void
}

/**
 * 盯住宿主主窗口。返回卸载函数（插件停用时由 `ctx.effect` 回滚，不留监听器）。
 */
export function installHostWindowGuard(hooks: HostWindowGuardHooks): () => void {
  const adopted = new WeakSet<BrowserWindow>()
  onHiddenShown = hooks.onHiddenWindowShown ?? null

  const adopt = (win: BrowserWindow): void => {
    if (adopted.has(win)) return
    adopted.add(win)
    trackedMain = win
    win.once('closed', () => {
      // 已经被新的主窗口顶替（宿主「先建后毁」的自愈）：这不是「界面没了」，别收摊
      if (trackedMain !== win) return
      trackedMain = null
      logger.info('[douyin-link] 宿主主窗口已关闭：收掉隐藏采集窗口与音频泵（别把进程吊住）')
      try {
        hooks.onHostUiGone()
      } catch (error) {
        logger.warn('[douyin-link] 主窗口关闭后的收摊失败:', error)
      }
    })
  }

  const watch = (win: BrowserWindow): void => {
    if (isGuardedWindow(win) || win.isDestroyed()) return
    if (isHostMainWindow(win)) {
      adopt(win)
      return
    }
    // 窗口刚建出来时地址还是空的：等它加载完再认一次
    const check = (): void => {
      if (win.isDestroyed()) {
        off()
        return
      }
      if (isHostMainWindow(win)) {
        off()
        adopt(win)
      }
    }
    const off = (): void => {
      if (win.isDestroyed()) return
      win.webContents.removeListener('did-finish-load', check)
      win.webContents.removeListener('did-navigate', check)
    }
    win.webContents.on('did-finish-load', check)
    win.webContents.on('did-navigate', check)
    check()
  }

  const onCreated = (_event: unknown, win: BrowserWindow): void => watch(win)
  app.on('browser-window-created', onCreated)
  // 插件可能晚于主窗口装载（例如刚启用插件）：先把手头已有的窗口过一遍
  for (const win of BrowserWindow.getAllWindows()) watch(win)

  return () => {
    app.removeListener('browser-window-created', onCreated)
    onHiddenShown = null
  }
}

/** 宿主主窗口判定：加载 `…/resource/index.html` 的那个窗口（加载页/托盘菜单/预览都不匹配） */
function isHostMainWindow(win: BrowserWindow): boolean {
  try {
    return win.webContents.getURL().includes(MAIN_WINDOW_MARK)
  } catch {
    return false
  }
}
