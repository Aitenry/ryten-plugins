import { RiSettings4Line, RiTiktokFill } from '@remixicon/react'
import { DouyinLinkLocales } from '../locales'
import manifest from '../manifest'
import type { Plugin } from '../types/plugin'
import Settings from './Settings'

/**
 * 抖音直播分析器 的渲染层入口（**只做装配**）。
 *
 * 挂载点：route（页面）、menu（侧栏）、settingsSection（设置页）、i18n（词条）。
 * 都是可逆装配——插件停用时宿主自动摘除，不需要写反注册。
 *
 * 三个坑：
 * - 菜单的 `icon` 必须在 `@remixicon/react` 里真实存在，且与清单（`manifest.ts`）的
 *   `menu.icon` 是同一枚——清单图标只决定首帧；
 * - 词条第一个参数是**命名空间**（宿主界面一律 'translation'），写成语言名会让界面显示原始键名；
 * - 主视图只经 `load: () => import('./Page')` 引入：**别再静态 import 一次 Page**，
 *   否则 esbuild 无法把它拆成按需 chunk（会被内联进入口，懒加载名存实亡）。
 */
const plugin: Plugin = {
  // id/name/version/description 的单一真源在 ../manifest.ts（主进程 plugins-list 同源）
  manifest,
  install(ctx): void {
    ctx.use('route').register({
      path: '/douyin-link',
      load: () => import('./Page')
    })
    ctx.use('menu').register({
      // 菜单键必须与路由路径一致：点击菜单就是 navigate('/' + key)
      key: 'douyin-link',
      labelKey: 'douyin-link.menu.title',
      icon: <RiTiktokFill size={16} />,
      order: 60
    })
    ctx.use('settingsSection').register({
      tabKey: 'douyin-link',
      labelKey: 'douyin-link.settings.title',
      icon: <RiSettings4Line size={16} />,
      group: 'assistant',
      order: 90,
      // 设置页是常驻入口（不进懒加载 chunk），所以要静态引用
      Component: Settings
    })
    // 词条随插件注册：第一个参数是命名空间（宿主界面一律 'translation'），第二个是「语言 → 词条树」
    ctx.use('i18n').addResources('translation', DouyinLinkLocales)
  }
}

export default plugin
