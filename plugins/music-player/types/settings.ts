/**
 * 宿主系统设置的**类型**面（只声明本插件读写的字段）。
 *
 * 真源在应用仓库的 `src/main/types/settings.ts`；独立插件不能 import 它，所以按需声明。
 * 运行期经 `window.api.systemSettings.getAll()/update()` 读写（宿主通用桥，无需插件权限）。
 */
export interface SystemSettings {
  /** 音乐库根目录（歌单文件夹与其封面都挂在它下面） */
  musicDirectory?: string | null
  [key: string]: unknown
}
