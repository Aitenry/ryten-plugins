import { DouyinLinkZhCN } from './zh-CN'
import { DouyinLinkEnUS } from './en-US'

/**
 * 抖音直播连接器 的词条注册表：渲染层 install 时经
 * `ctx.use('i18n').addResources('translation', DouyinLinkLocales)` 注入 i18next。
 *
 * 插件停用这些键随之消失——别把它们塞进宿主内核的词条文件。
 */
export const DouyinLinkLocales = {
  'zh-CN': DouyinLinkZhCN,
  'en-US': DouyinLinkEnUS
}

export default DouyinLinkLocales
