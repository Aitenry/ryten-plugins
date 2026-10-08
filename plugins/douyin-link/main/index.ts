import { PLUGIN_PURGE } from '@host/main/plugins/contributions'
import { APP_BEFORE_QUIT } from '@host/main/plugins/app-hooks'
import { HARNESS_TOOL_CONTRIBUTION } from '@host/main/plugins/tool-contract'
import { EVENTS, createIpcHandlers, initAnalyzer } from './ipc'
import { analyzerHub } from './monitor/hub'
import { giftCatalog } from './gift/catalog'
import { purgePluginData } from './purge'
import { createToolContribution } from './tools'
import type { MainPluginContext } from '@host/main/plugins/context'

/**
 * 抖音直播分析器 的主进程入口（**只做装配**，实现分在 ./monitor、./db 与 ./douyin）。
 *
 * 链路（一张图）：
 *   ./douyin/room             —— 网页房间号 → 直播间信息 + flv 拉流地址 + Cookie + 房间成员名单
 *   ./douyin/danmaku          —— **主进程直连**：轮询 `/webcast/im/fetch/` 收全量推送（无窗口）
 *   ./douyin/json             —— 推送 JSON → 弹幕/用户 + 麦位表（纯函数）
 *   ./gift/catalog            —— 官方礼物目录（礼物 id → 名字 + 抖币价；3 天缓存，落 meta）
 *   ./monitor/recorder        —— 一个房间的「本场」内存视图（最近弹幕、计数、速率、在场、麦位）
 *   ./monitor/hub             —— 分析中枢：房间清单、每房间一路轮询、音频只跟最新选中的房间、
 *                                落库 flush、事件推送、在线观众与全部分析查询的入口
 *   ./audio/pump              —— **主进程**拉 flv + 解复用，把 AAC 帧推给渲染层（渲染层被宿主 CSP 拦住外部请求）
 *   ./db/{schema,ddl,mapper}  —— 自己的 6 张表 + 批量落库 + 分析查询
 *   ./avatar                  —— 头像（data URL 缓存）
 *
 * 0.6.0 的关键变化（用户要求）：**不再创建隐藏 BrowserWindow**。
 * 上一版靠隐藏窗口加载 live.douyin.com，借页面自己算的 signature 连上弹幕 ws，再用 CDP 截帧；
 * 现在改成主进程直接请求 `im/fetch`（实测免签名），于是窗口、CDP、媒体拦截、
 * 以及「隐藏窗口守卫」（`./window-guard.ts`）整套都不需要了。
 *
 * 一切副作用都放进 `ctx.effect` 并返回回滚函数：插件停用时宿主逆序撤销
 * （轮询、音频泵、定时器都是在 `analyzerHub.dispose()` 里收干净的）。
 */
export function install(ctx: MainPluginContext): void {
  initAnalyzer(ctx)

  /**
   * 礼物目录（**礼物 id → 名字 + 抖币价**）：先用库里的缓存，后台再按 3 天有效期刷新一次。
   * 推送帧里只有礼物 id（点歌那类甚至只有一个场景标签），「送了什么、值多少」全靠它。
   * 拉取失败不影响监听（解码器会退回帧里自带的字段）。
   */
  void giftCatalog
    .init()
    .then(() => giftCatalog.ensure())
    .catch(() => undefined)

  ctx.registerEvent(...EVENTS)
  ctx.registerIpc(createIpcHandlers())

  ctx.contribute(HARNESS_TOOL_CONTRIBUTION, createToolContribution())

  // 退出前把轮询与音频泵收掉（托盘「退出」/系统关机时别让请求卡在退出清理期间）
  ctx.contribute(APP_BEFORE_QUIT, {
    label: '抖音直播分析器：停掉弹幕轮询与音频泵',
    run: () => analyzerHub.suspend('appQuit')
  })

  ctx.contribute(PLUGIN_PURGE, {
    label:
      '本插件的数据库表（房间清单 / 消息流水 / 用户统计 / 分钟聚合 / 监控会话）、设置文件（plugin-state/douyin-link.json）',
    run: purgePluginData
  })
}