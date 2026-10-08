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
  version: '0.5.7',
  description:
    '多直播间分析器：同时监控多个抖音直播间（每个房间一个隐藏窗口截弹幕 websocket），音频只跟最新选中的那个房间（其它房间继续监听），历史数据（消息流水/用户统计/分钟聚合/监控会话/礼物目录）全部落数据库，可按关键词与类型检索、出 KPI 与趋势、看发言榜与礼物榜、做多房间对比；点弹幕里的昵称或用户榜的一行可打开用户档案并翻这个人发过的历史弹幕（本房间 / 全部房间、只看弹幕 / 全部互动）；打开应用会接着监控开关开着的房间（可在设置里关掉），关闭应用时后台的隐藏采集窗口会一并收掉（不会留下直播间窗口或后台拉流）。',
  /** 独立插件：`false`。宿主据此按「第三方」对待（不随应用分发、默认停用） */
  builtin: false,
  /**
   * 实际用到的宿主上下文键：
   * route 懒加载视图、menu 侧栏、settingsSection 设置页、i18n 词条（随插件注册，停用即消失）。
   */
  inject: ['route', 'menu', 'settingsSection', 'i18n'],
  routes: [{ path: '/douyin-link' }],
  menu: { key: 'douyin-link', labelKey: 'douyin-link.menu.title', icon: 'RiLiveLine', order: 60 }
}

export default douyinLinkManifest
