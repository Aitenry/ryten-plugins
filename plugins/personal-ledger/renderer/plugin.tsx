import { RiWalletLine } from '@remixicon/react'
import { PersonalLedgerLocales } from '../locales'
import manifest from '../manifest'
import type { Plugin } from '../types/plugin'
import Settings from './Settings'

/**
 * 个人记账台账 的渲染层入口（**只做装配**）。
 *
 * 挂载点：route（页面）、menu（侧栏）、settingsSection（设置页）、i18n（词条）。
 * 都是可逆装配——插件停用时宿主自动摘除，不需要写反注册。
 */
const plugin: Plugin = {
  // id/name/version/description 的单一真源在 ../manifest.ts（主进程 plugins-list 同源）
  manifest,
  install(ctx): void {
    ctx.use('route').register({
      path: '/personal-ledger',
      // 懒加载：主视图单独成 chunk，不被入口内联（别再静态 import 一次 Page）
      load: () => import('./Page')
    })
    ctx.use('menu').register({
      // 菜单键必须与路由路径一致：点击菜单就是 navigate('/' + key)
      key: 'personal-ledger',
      labelKey: 'personal-ledger.menu.title',
      icon: <RiWalletLine size={16} />,
      order: 60
    })
    ctx.use('settingsSection').register({
      tabKey: 'personal-ledger',
      labelKey: 'personal-ledger.settings.title',
      icon: <RiWalletLine size={16} />,
      group: 'assistant',
      order: 90,
      // 设置页是常驻入口（不进懒加载 chunk），所以要静态引用
      Component: Settings
    })
    // 词条随插件注册：第一个参数是命名空间（宿主界面一律 'translation'），第二个是「语言 → 词条树」
    ctx.use('i18n').addResources('translation', PersonalLedgerLocales)
  }
}

export default plugin
