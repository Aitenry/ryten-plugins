import type { PluginManifest } from './types/plugin'

/**
 * planner 插件清单（**单一真源**）：主进程与渲染层都读它。
 *
 * 只放静态元数据（id/name/version/description/inject/routes/menu），
 * 不 import react/electron，两端构建都能直接打包。
 */
export const plannerManifest: PluginManifest = {
  id: 'task-planner',
  name: '任务规划',
  version: '0.1.0',
  description: '任务树、甘特图与列表视图',
  /** 独立插件：`false`。宿主据此按「第三方」对待（不随应用分发、默认停用） */
  builtin: false,
  /**
   * 实际用到的宿主上下文键：
   * route 懒加载视图 + 骨架、menu 侧栏、i18n 词条（随插件注册，停用即消失）。
   */
  inject: ['route', 'menu', 'i18n'],
  routes: [{ path: '/planner', skeleton: 'planner' }],
  menu: { key: 'planner', labelKey: 'planner.menu.title', icon: 'RiCalendar2Line', order: 20 }
}

export default plannerManifest
