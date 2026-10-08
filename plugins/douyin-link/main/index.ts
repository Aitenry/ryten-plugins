import { PLUGIN_PURGE } from '@host/main/plugins/contributions'
import { APP_BEFORE_QUIT } from '@host/main/plugins/app-hooks'
import { HARNESS_TOOL_CONTRIBUTION } from '@host/main/plugins/tool-contract'
import { EVENTS, createIpcHandlers, initAnalyzer } from './ipc'
import { analyzerHub } from './monitor/hub'
import { purgePluginData } from './purge'
import { installHostWindowGuard, revealHostMainWindow } from './window-guard'
import { createToolContribution } from './tools'
import type { MainPluginContext } from '@host/main/plugins/context'

/**
 * 抖音直播分析器 的主进程入口（**只做装配**，实现分在 ./monitor、./db 与 ./douyin）。
 *
 * 链路（一张图）：
 *   ./db/{schema,ddl,mapper}  —— 自己的 7 张表（房间/消息/用户/分钟桶/会话/礼物/键值）+ 批量落库 + 分析查询
 *   ./monitor/recorder        —— 一个房间的「本场」内存视图（最近弹幕、计数、速率、用户增量）
 *   ./monitor/hub             —— 分析中枢：房间清单、每房间一个采集器、音频只跟最新选中的房间、
 *                                落库 flush、事件推送、全部分析查询的入口
 *   ./douyin/room             —— 网页房间号 → 直播间信息 + flv 拉流地址
 *   ./douyin/danmaku + push   —— 隐藏窗口 + CDP 截弹幕 websocket，protobuf 解码（纯函数）
 *   ./audio/pump              —— **主进程**拉 flv + 解复用，把 AAC 帧推给渲染层（渲染层被宿主 CSP 拦住外部请求）
 *   ./avatar, ./gift/catalog  —— 头像（data URL 缓存）、官方礼物目录（落库）
 *   ./window-guard            —— 隐藏采集窗口的看管：被 show 就按回去；宿主主窗口一关就收摊
 *                                （隐藏窗口也是窗口，留着会让应用关不掉、重开看到直播间画面）
 *
 * 一切副作用都放进 `ctx.effect` 并返回回滚函数：插件停用时宿主逆序撤销
 * （隐藏窗口、音频泵、定时器都是在 `analyzerHub.dispose()` 里收干净的——
 * 停用插件不该留下后台窗口，也不该有 quietly 在跑的拉流）。
 */
export function install(ctx: MainPluginContext): void {
  initAnalyzer(ctx)

  // 隐藏窗口守卫（见 ./window-guard.ts）：采集窗口永不可见 + 宿主主窗口一关就收摊
  installWindowGuard(ctx)

  ctx.registerEvent(...EVENTS)
  ctx.registerIpc(createIpcHandlers())

  ctx.contribute(HARNESS_TOOL_CONTRIBUTION, createToolContribution())

  ctx.contribute(PLUGIN_PURGE, {
    label:
      '本插件的数据库表（房间清单 / 消息流水 / 用户统计 / 分钟聚合 / 监控会话 / 礼物目录）、设置文件（plugin-state/douyin-link.json）与每个房间的弹幕会话数据',
    run: purgePluginData
  })
}

/**
 * 隐藏窗口与退出时机的守卫（全貌见 `./window-guard.ts`）。
 *
 * 起因：采集弹幕用的隐藏 BrowserWindow 虽然不可见，却是宿主退出流程与
 * second-instance 处理器都会看见的「窗口」——它留着就会让用户「关闭应用」变成
 * 「应用还在后台跑，再打开却看到抖音直播间画面」。所以：
 * - 主窗口被销毁 → `suspend()` 收掉采集窗口/音频泵，让 `window-all-closed` 有机会触发；
 * - 应用退出前（托盘「退出」/系统关机）也收一次，别让拉流卡在退出清理期间；
 * - 隐藏窗口自身的「被 show 就按回去」在 `guardHiddenWindow()` 里，创建时就挂上；
 * - 被 show 时顺手把宿主主窗口露出来（真机实测 `getAllWindows()` 新窗口在前，
 *   宿主的 second-instance 挑中的恰好是后建的采集窗口——用户点图标要的是界面）。
 */
function installWindowGuard(ctx: MainPluginContext): void {
  ctx.effect(() =>
    installHostWindowGuard({
      onHostUiGone: () => analyzerHub.suspend('hostWindowClosed'),
      onHiddenWindowShown: () => revealHostMainWindow()
    })
  )
  ctx.contribute(APP_BEFORE_QUIT, {
    label: '抖音直播连接器：收掉隐藏采集窗口与音频泵',
    run: () => analyzerHub.suspend('appQuit')
  })
}
