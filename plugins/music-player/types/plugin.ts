import type { ComponentType, ReactNode } from 'react'

/**
 * 插件渲染层契约（宿主 API 的**类型**面，只声明本插件用到的部分）。
 *
 * 运行期这些对象由宿主在 `install(ctx)` 时注入；类型上插件不能 import 宿主的源码，
 * 所以这里按宿主文档把用到的挂载点写成声明（与 RytenBench 的
 * `src/renderer/src/plugin-host/types.ts` 保持一致，宿主升级时同步这里即可）。
 */

/** 插件清单（`plugin.json` 的 `PluginManifest`） */
export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  icon?: string
  /** 独立插件恒为 false（宿主用这个字段区分「随应用分发」） */
  builtin: boolean
  entry?: { renderer?: string; main?: string }
  inject?: string[]
  provide?: string[]
  routes?: { path: string; skeleton?: string }[]
  menu?: { key: string; labelKey: string; icon: string; order?: number }
  permissions?: string[]
}

/** 懒加载工厂：返回 default 导出的页面组件 */
export type LazyLoader = () => Promise<{ default: ComponentType }>

/** 注册表服务：register 返回注销函数（宿主在插件卸载时整组清空） */
export interface RegistryService<T> {
  register(item: Omit<T, 'pluginId'>): () => void
  getAll(): T[]
}

export interface RegisteredRoute {
  pluginId: string
  path: string
  skeleton?: string
  load?: LazyLoader
  Component?: ComponentType
}

export interface RegisteredMenuItem {
  pluginId: string
  key: string
  labelKey: string
  icon: ReactNode
  order: number
}

export interface SettingsSectionRegistration {
  pluginId: string
  tabKey: string
  labelKey: string
  icon: ReactNode
  group: string
  order: number
  Component: ComponentType
}

export type ProviderComponent = ComponentType<{ children: ReactNode }>

export interface AppProviderRegistration {
  pluginId: string
  Provider: ProviderComponent
  order: number
}

/** 底栏槽位条目：外壳按 `order` 轮播 `isVisible()` 为真的项 */
export interface BottomBarItemRegistration {
  pluginId: string
  id: string
  order: number
  isVisible: () => boolean
  subscribe?: (onChange: () => void) => () => void
  Tab: ComponentType
  Popup: ComponentType
}

/** 宿主内置的固定服务键（插件用到的部分） */
export interface HostServices {
  route: RegistryService<RegisteredRoute>
  menu: RegistryService<RegisteredMenuItem>
  settingsSection: RegistryService<SettingsSectionRegistration>
  appProvider: RegistryService<AppProviderRegistration>
  bottomBar: RegistryService<BottomBarItemRegistration>
  api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> }
  i18n: { addResources: (ns: string, resources: Record<string, unknown>) => void }
}

export type HostServiceKey = keyof HostServices

export interface PluginContext {
  use<K extends HostServiceKey>(key: K): HostServices[K]
}

/** 插件：manifest + install（注册的逆操作进入宿主回滚栈） */
export interface Plugin {
  manifest: PluginManifest
  install(ctx: PluginContext): void | (() => void) | Promise<void | (() => void)>
}
