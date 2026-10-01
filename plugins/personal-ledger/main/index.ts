import logger from 'electron-log'
import { PLUGIN_PURGE } from '@host/main/plugins/contributions'
import { HARNESS_TOOL_CONTRIBUTION } from '@host/main/plugins/tool-contract'
// 副作用导入：装载即触发**本插件自带建表**（幂等），不必等到第一次查询
import { schemaReady } from './db/ddl'
import { runRecurring } from './db/mapper'
import { DATA_CHANGED, broadcastDataChanged, createIpcHandlers, initSettings } from './ipc'
import { purgePluginData } from './purge'
import { createToolContribution } from './tools'
import type { MainPluginContext } from '@host/main/plugins/context'

/**
 * 个人记账台账 的主进程入口（**只做装配**，实现分在 ./ipc ./tools ./csv ./db 下）。
 *
 * - `./db/ddl`：本插件自带建表（宿主不认识这 10 张 `personal_ledger_*` 表），幂等；
 * - `ctx.registerIpc`：30+ 个 `plugin:personal-ledger:*` 通道（流水 / 账户 / 分类 / 标签 /
 *   商家 / 预算 / 目标 / 周期 / 借还 / 存款 / 概览 / 报表 / 导入导出），
 *   停用或卸载时随 `ctx.dispose()` 一并摘除；
 * - `ctx.registerEvent`：主进程 → 渲染层的事件通道（**只有发送方**，不声明渲染层就订阅不到）；
 * - `ctx.effect`：周期记账巡检（每小时一次，把到期的房租/工资/订阅落成流水）；
 * - `ctx.contribute(HARNESS_TOOL_CONTRIBUTION, …)`：给助手的 AI 工具（读写同一份数据）；
 * - `ctx.contribute(PLUGIN_PURGE, …)`：卸载勾「同时删除数据」时清本插件的表行与文件。
 *
 * 一切副作用都放进 `ctx.effect` 并返回回滚函数：插件停用时宿主逆序撤销。
 */
export function install(ctx: MainPluginContext): void {
  // 建表是异步的：这里只是「早点开始」，mapper / purge 各自还会 await 它的承诺
  void schemaReady

  initSettings(ctx)

  ctx.registerEvent(DATA_CHANGED)
  ctx.registerIpc(createIpcHandlers())

  ctx.contribute(HARNESS_TOOL_CONTRIBUTION, createToolContribution())

  ctx.contribute(PLUGIN_PURGE, {
    label: '本插件的记账数据与设置（10 张 personal_ledger_* 表 + plugin-state/personal-ledger.json）',
    run: purgePluginData
  })

  // 周期记账巡检：到期的规则自动生成流水（幂等，靠 next_run 推进）。
  // 放 ctx.effect 里：返回 clearInterval，插件停用即停止巡检。
  ctx.effect(() => {
    const tick = async (): Promise<void> => {
      try {
        const created = await runRecurring()
        if (created > 0) broadcastDataChanged()
      } catch (err) {
        logger.warn('[personal-ledger] 周期记账巡检失败:', err)
      }
    }
    const timer = setInterval(() => void tick(), 60 * 60 * 1000)
    return () => clearInterval(timer)
  })
}
