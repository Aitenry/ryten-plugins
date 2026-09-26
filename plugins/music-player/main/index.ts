import type { MainPluginContext } from '@host/main/plugins/context'
import { PLUGIN_PURGE } from '@host/main/plugins/contributions'
import { HARNESS_TOOL_CONTRIBUTION } from '@host/main/plugins/tool-contract'
// 副作用导入：装载即触发**本插件自带建表**（幂等），不必等到第一次查询
import { schemaReady } from './db/ddl'
import { MUSIC_PLAY_TRACK_CHANNEL, musicIpcHandlers } from './ipc'
import { purgeMusicData } from './purge'
import { musicToolContributions } from './tools'

/**
 * music 插件主进程入口。
 *
 * - `./db/ddl`：本插件**自带**建表（宿主不再知道 `music_*` 表），幂等；
 *   mapper 与 purge 都会先 await 它的 `schemaReady`，因此数据访问不会跑到建表之前；
 * - `ctx.registerIpc`：19 个 `plugin:music-player:*` 通道（歌单/曲目/封面/文件读取），
 *   停用或卸载时随 `ctx.dispose()` 一并摘除——宿主侧无需知道音乐的存在；
 * - `ctx.registerEvent`：主进程 → 渲染层的事件通道 `plugin:music-player:play-track`
 *   （AI 工具点播，见 `./tools.ts`）。它没有 ipcMain 处理器，
 *   必须显式声明才会进 preload 的插件通道白名单，渲染层 `window.api.plugin.on` 才放行。
 * - `ctx.contribute(HARNESS_TOOL_CONTRIBUTION, …)`：本插件自己的 AI 工具
 *   （`manage_music`，实现见 `./tools.ts`，读本插件的 mapper）经 harness 的工具贡献点
 *   注册给模型；停用时贡献一并摘除，模型不再被提供该工具。
 * - `ctx.contribute(PLUGIN_PURGE, …)`：卸载时勾了「同时删除该插件的全部数据」由宿主回调，
 *   删本插件的表行与应用托管的歌单目录（实现见 `./purge.ts`）。宿主因此不需要知道任何音乐表名。
 */
export function install(ctx: MainPluginContext): void {
  void schemaReady
  ctx.registerIpc(musicIpcHandlers)
  ctx.registerEvent(MUSIC_PLAY_TRACK_CHANNEL)
  for (const tool of musicToolContributions) ctx.contribute(HARNESS_TOOL_CONTRIBUTION, tool)
  ctx.contribute(PLUGIN_PURGE, { run: purgeMusicData, label: '音乐曲库与托管歌单目录' })
}
