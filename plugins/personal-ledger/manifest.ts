import type { PluginManifest } from './types/plugin'

/**
 * personal-ledger 插件清单（**单一真源**）：主进程与渲染层都读它。
 *
 * 只放静态元数据（id/name/version/description/inject/routes/menu），
 * 不 import react/electron，两端构建都能直接打包。
 *
 * `entry` 不写在这里：它由 `scripts/build.mjs` 在生成 `dist/<id>/plugin.json` 时补上。
 */
export const personalLedgerManifest: PluginManifest = {
  id: 'personal-ledger',
  name: '个人记账台账',
  version: '1.1.6',
  description:
    '个人 / 家庭记账台账：多账户多币种流水、分类标签商家、预算与储蓄目标、周期记账与分期、借入借出（应收应付）、信用卡账单与定期存款提醒、资产净值与报表图表、CSV 账单导入导出，并给 AI 助手提供记账与查账工具。',
  /** 独立插件：`false`。宿主据此按「第三方」对待（不随应用分发、默认停用） */
  builtin: false,
  /**
   * 实际用到的宿主上下文键：
   * route 懒加载视图、menu 侧栏、settingsSection 设置页、i18n 词条（随插件注册，停用即消失）。
   */
  inject: ['route', 'menu', 'settingsSection', 'i18n'],
  routes: [{ path: '/personal-ledger' }],
  menu: { key: 'personal-ledger', labelKey: 'personal-ledger.menu.title', icon: 'RiWalletLine', order: 60 }
}

export default personalLedgerManifest
