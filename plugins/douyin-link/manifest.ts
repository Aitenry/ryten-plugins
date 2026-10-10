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
  version: '0.15.2',
  description:
    '多直播间分析器：同时监控多个抖音直播间（「实时通道」——主进程**纯 Node 直连**抖音推送 websocket，自带离线签名 + 心跳 + ACK，**不需要任何浏览器**，逐条收弹幕/进场/点赞/礼物，更实时，**不再有任何轮询兜底**）；弹幕/进场/点赞/关注/**礼物**全部落数据库（礼物记下送礼人、**收礼人**、**礼物名与抖币价**——礼物名按 id 查官方目录、**单价以推送帧上报为准**（升级礼物/活动价也准），连送按礼物组去重、不重复计数；普通直播间收礼物需在设置里填「登录态 Cookie」；语音房里「X 送了 想听 Y 演唱」的点歌同样记下它送的是哪件礼物、值多少抖币），可按关键词与类型检索、出 KPI 与趋势（悬停看每一根柱子）、看发言榜与**收礼/送礼榜**（都按抖币排行，点一行翻这个人的礼物历史）、按天查看「每日记录」、做多房间对比；默认**永久保存**不自动清理；**匿名送礼/点歌可以「查看神秘人信息」**——在用户档案弹窗里，如果是匿名的人，点一下按钮就按用户 id 去抖音查回真实账号资料（真名、头像、粉丝数等）；「在线观众」页签把**麦上用户**（聊天室麦位，按麦位序置顶）、直播间接口给的房间成员、以及本场活跃过的人合成一张表，点任意一行可打开用户档案并翻历史弹幕（本房间 / 全部房间、只看弹幕 / 全部互动）；下播后保持监听、重新开播自动拉起；打开应用会接着监控开关开着的房间（可在设置里关掉）；**新增「数据大屏模式」**（左栏一键切换）——全部直播间的**总送/总收礼物榜**（同一个人跨房合并）、**直播间流水分析**与全局趋势，全部**实时更新**（落库即推），检索也收进大屏。',
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
