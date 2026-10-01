import { PersonalLedgerZhCN } from './zh-CN'
import { PersonalLedgerEnUS } from './en-US'

/**
 * 个人记账台账 的词条注册表：渲染层 install 时经
 * `ctx.use('i18n').addResources('translation', PersonalLedgerLocales)` 注入 i18next。
 *
 * 插件停用这些键随之消失——别把它们塞进宿主内核的词条文件。
 */
export const PersonalLedgerLocales = {
  'zh-CN': PersonalLedgerZhCN,
  'en-US': PersonalLedgerEnUS
}

export default PersonalLedgerLocales
