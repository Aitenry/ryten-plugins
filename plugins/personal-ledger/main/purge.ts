import * as fs from 'fs'
import logger from 'electron-log'
import { deleteAllData } from './db/mapper'
import { settingsFilePath } from './ipc'

/**
 * 个人记账台账 的清数据实现（`plugin.purge` 贡献）。
 *
 * 用户卸载插件并勾了「同时删除该插件的全部数据」时由宿主调用，做两件事：
 * 1. **删自己的表行**（10 张 `personal_ledger_*` 表，绝不碰别的表）；
 * 2. **删应用托管的数据**（设置文件 userData/plugin-state/personal-ledger.json）。
 *    用户自己选的文件（导入的账单、导出的备份）一律不动。
 *
 * 表结构不动：迁移由宿主统一管，卸载后迁移记录必须保持一致。
 */
export async function purgePluginData(): Promise<void> {
  const removed = await deleteAllData()
  let removedFile = false
  try {
    const file = settingsFilePath()
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true })
      removedFile = true
    }
  } catch (err) {
    // 文件被占用：只告警，不阻塞卸载（表行已经删干净了）
    logger.warn('[personal-ledger] 清理设置文件失败:', err)
  }
  logger.info(
    `[personal-ledger] 已清除插件数据：记录 ${removed} 行、设置文件 ${removedFile ? '已删' : '不存在'}`
  )
}
