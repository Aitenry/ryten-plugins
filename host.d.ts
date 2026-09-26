/**
 * 宿主 API 的**环境声明**（RytenBench 插件宿主契约）。
 *
 * 独立插件在构建时把 `@host/**` 说明符原样留给宿主（宿主的运行时表 / UI 桥在装载时注入），
 * 因此这里只做「让 TypeScript 认识这些说明符」的声明，取值形状与宿主保持一致：
 *
 * | 说明符                                   | 宿主体内的来源                                        |
 * | ---------------------------------------- | ----------------------------------------------------- |
 * | `@host/main/*`                           | `src/main/plugins/runtime.ts` 的 `HOST_MAIN` 表       |
 * | `@host/shared/*`                         | 同表的 `HOST_SHARED`                                  |
 * | `@host/renderer/*` / `@host/vendor/*`    | `src/renderer/src/plugin-host/host-ui.ts` 的 `HOST_UI` |
 *
 * 表中没有的说明符，宿主会在装载期抛「宿主运行时没有提供模块 '…'」——升级插件前先对照
 * RytenBench 的 `src/plugins/PACKAGING.md`（契约面清单）确认宿主有没有对外开放。
 */
declare module '@host/main/i18n' {
  /** 当前界面语言（'zh-CN' | 'en-US' 等，宿主 i18n 的权威值） */
  export function getMainLanguage(): string
  /** `{{name}}` 占位符替换 */
  export function mainFormat(template: string, params?: Record<string, unknown>): string
  /** 单复数：按 `count` 取 `_one` / `_other` 文案 */
  export function mainPlural(one: string, other: string, count: number): string
  /** 宿主主进程侧的全部词条（插件一般用不上，主要给需要复用宿主措辞的场景） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function mainMessages(): any
}

declare module '@host/main/context' {
  /** 宿主的设置存储（electron-store；键空间是全局的） */
  export const settingsStore: {
    get(key: string): unknown
    set(key: string, value: unknown): void
    delete(key: string): void
  }
}

declare module '@host/main/safe-send' {
  /** 向渲染层推送：宿主内部会做存活检查（失效帧不抛异常） */
  export function safeSend(webContentsOrWindow: unknown, channel: string, ...args: unknown[]): void
}

declare module '@host/main/database/orm' {
  import type { PgDatabase } from 'drizzle-orm/pg-core'
  /**
   * 宿主唯一的 PGlite/Drizzle 连接（`withOrm` 在同一个连接上跑回调）。
   *
   * 泛型用 `any` 是有意的：插件有自己的表对象（`./db/schema`），drizzle 会从**传入的表**
   * 推导查询类型，宿主的泛型参数对插件没有意义。（宿主自己的 `Orm` 类型是 `PgliteDatabase<typeof schema>`，
   * 插件不该依赖宿主的 schema。）
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Orm = PgDatabase<any, any, any>
  /** 插件自带的表在同一个库里，直接查自己的表对象即可 */
  export function withOrm<T>(op: string, fn: (db: Orm) => Promise<T>): Promise<T>
}

declare module '@host/main/database/schema/common' {
  /**
   * 宿主的通用表：图片（base64 存库），插件用 `image_id` 外键引用。
   *
   * 只声明插件用到的列（`id` / `data` / `created_at`），列类型放宽成 `PgColumn<any, any>`
   * ——插件只需要「能进 `eq()` / `foreignKey()` / `select({ … images.data })`」这一层。
   */
  // TODO(plugin-sdk)：宿主应发布一份真正的插件 SDK 类型包（含宿主表定义）；ny 只是权宜
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const images: any
}

declare module '@host/main/plugins/contributions' {
  /** 贡献点键：插件自清数据（卸载时勾了「同时删除数据」由宿主回调） */
  export const PLUGIN_PURGE: string
  export interface PluginPurgeContribution {
    run: () => void | Promise<void>
    /** 会删掉什么（显示在卸载确认框的勾选项里） */
    label: string
  }
}

declare module '@host/main/plugins/context' {
  /** 主进程 IPC 处理器表：键 = `plugin:<命名空间>:<通道>` */
  export interface MainIpcHandlers {
    [channel: string]: (...args: never[]) => unknown
  }
  /** 主进程插件上下文（宿注入；只声明本插件用到的能力） */
  export interface MainPluginContext {
    registerIpc(handlers: MainIpcHandlers): void
    registerEvent(...channels: string[]): void
    contribute<T>(key: string, value: T): void
    effect(fn: () => void | (() => void)): void
    dispose(): void
  }
}

declare module '@host/main/plugins/tool-contract' {
  import type { StructuredToolInterface } from '@langchain/core/tools'
  /** 贡献点键：AI 工具（harness 拉取） */
  export const HARNESS_TOOL_CONTRIBUTION: string
  export interface ToolInfo {
    name: string
    label: string
    description: string
    icon: string
    color: string
  }
  export interface PluginToolContribution {
    name: string
    info: ToolInfo
    build: () => StructuredToolInterface
  }
}

declare module '@host/renderer/i18n' {
  /** 宿主 i18n 的 react 绑定 */
  export function useTranslation(): {
    t: (key: string, options?: Record<string, unknown>) => string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    i18n: any
  }
  /** 行内翻译组件（宿主 i18next 的 `<Trans>`） */
  export const Trans: React.ComponentType<Record<string, unknown>>
  /** 界面语言元数据表（含 dayjs 的 locale 名映射） */
  export const LANGUAGES: Record<string, { dayjs: string }>
}

declare module '@host/renderer/utils/formatTime' {
  /** 秒 → mm:ss / h:mm:ss */
  export function formatTime(seconds: number): string
}

declare module '@host/renderer/hooks/useMessage' {
  /** 宿主统一的操作反馈（与设置页其它地方一致） */
  export function useMessage(): {
    viewMessage: (
      key: string,
      type: 'loading' | 'success' | 'error' | 'info',
      content: string,
      duration?: number
    ) => void
  }
}

declare module '@host/renderer/components/system/settings/SettingsUI' {
  import type { ComponentType, ReactNode } from 'react'
  export const SettingsPageHeader: ComponentType<{
    title: ReactNode
    description?: ReactNode
    extra?: ReactNode
  }>
  export const SettingsSection: ComponentType<{
    title?: ReactNode
    description?: ReactNode
    icon?: ReactNode
    bodyPadding?: number
    children?: ReactNode
  }>
  export const SettingRow: ComponentType<{ label?: ReactNode; children?: ReactNode }>
  export const SettingBlock: ComponentType<{ children?: ReactNode }>
}

declare module '@host/renderer/route/RouteSkeleton' {
  import type { ComponentType } from 'react'
  const RouteSkeleton: ComponentType<{ variant?: string; showTag?: boolean }>
  export default RouteSkeleton
}
