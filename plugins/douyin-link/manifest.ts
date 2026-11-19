import type { PluginManifest } from './types/plugin'

/**
 * douyin-link 插件清单（**单一真源**）：主进程与渲染层都读它。
 *
 * 只放静态元数据（id/name/version/description/inject/routes/menu），
 * 不 import react/electron，两端构建都能直接打包。
 *
 * `entry` 不写在这里：它由 `scripts/build.mjs` 在生成 `dist/<id>/plugin.json` 时补上。
 */
export const douyinLinkManifest: PluginManifest = {
  id: 'douyin-link',
  name: '抖音直播分析器',
  version: '0.15.42',
  description: '抖音多直播间监控，弹幕与礼物分析。',
  /** 独立插件：`false`。宿主据此按「第三方」对待（不随应用分发、默认停用） */
  builtin: false,
  /**
   * 实际用到的宿主上下文键：
   * route 懒加载视图、menu 侧栏、settingsSection 设置页、i18n 词条（随插件注册，停用即消失）。
   */
  inject: ['route', 'menu', 'settingsSection', 'i18n'],
  routes: [{ path: '/douyin-link' }],
  menu: { key: 'douyin-link', labelKey: 'douyin-link.menu.title', icon: 'RiTiktokFill', order: 60 }
}

export default douyinLinkManifest
