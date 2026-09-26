import type { PluginManifest } from './types/plugin'

/**
 * music 插件清单（**单一真源**）：主进程与渲染层都读它。
 *
 * 只放静态元数据（id/name/version/description/inject/routes/menu），
 * 不 import react/electron，两端构建都能直接打包。
 */
export const musicManifest: PluginManifest = {
  id: 'music-player',
  name: '音乐播放器',
  version: '0.1.0',
  description: '本地音乐播放器：歌单、播放控制与迷你播放器',
  /** 独立插件：`false`。宿主据此按「第三方」对待（不随应用分发、默认停用） */
  builtin: false,
  /**
   * 实际用到的宿主上下文键：
   * route 懒加载视图 + 骨架、menu 侧栏、settingsSection 设置页、
   * appProvider 播放器状态（AudioProvider 随插件装卸）、
   * bottomBar 底栏音乐条目（外壳插槽）、i18n 词条。
   */
  inject: ['route', 'menu', 'settingsSection', 'appProvider', 'bottomBar', 'i18n'],
  routes: [{ path: '/music', skeleton: 'music' }],
  menu: { key: 'music', labelKey: 'music.menu.title', icon: 'RiDiscLine', order: 30 }
}

export default musicManifest
