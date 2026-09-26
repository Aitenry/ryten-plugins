import type { MainPluginContext } from '@host/main/plugins/context'
import { PLUGIN_PURGE } from '@host/main/plugins/contributions'
import { HARNESS_TOOL_CONTRIBUTION } from '@host/main/plugins/tool-contract'
// 副作用导入：装载即触发**本插件自带建表**（幂等），不必等到第一次查询
import { schemaReady } from './db/ddl'
import { plannerIpcHandlers } from './ipc'
import { purgePlannerData } from './purge'
import { plannerToolContributions } from './tools'

/**
 * planner 插件主进程入口。
 *
 * - `./db/ddl`：本插件**自带**建表（宿主不再知道 `planner_*` 表），幂等；
 *   mapper 与 purge 都会先 await 它的 `schemaReady`，因此数据访问不会跑到建表之前；
 * - `ctx.registerIpc`：10 个 `plugin:task-planner:*` 通道（任务增删改查/排序 + 依赖关系），
 *   停用或卸载时随 `ctx.dispose()` 一并摘除——宿主侧无需知道计划视图的存在；
 * - `ctx.contribute(HARNESS_TOOL_CONTRIBUTION, …)`：本插件自己的 AI 工具
 *   （`manage_planner`，实现在 `./tools.ts`，读的是本插件的 mapper）经 harness 的工具
 *   贡献点注册给模型；插件停用时贡献一并摘除，工具集里自然不再有它；
 * - `ctx.contribute(PLUGIN_PURGE, …)`：卸载时勾了「同时删除该插件的全部数据」由宿主回调，
 *   删本插件的任务/依赖行（实现见 `./purge.ts`）。宿主因此不需要知道任何计划表名。
 * - 本插件没有「主进程 → 渲染层」的事件通道（无 webContents.send / safeSend），
 *   因此不需要 `ctx.registerEvent`。
 */
export function install(ctx: MainPluginContext): void {
  void schemaReady
  ctx.registerIpc(plannerIpcHandlers)
  for (const tool of plannerToolContributions) ctx.contribute(HARNESS_TOOL_CONTRIBUTION, tool)
  ctx.contribute(PLUGIN_PURGE, { run: purgePlannerData, label: '计划任务与依赖关系' })
}
