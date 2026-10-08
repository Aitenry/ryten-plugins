import * as fs from 'fs'
import logger from 'electron-log'
import { PURGE_TABLES } from './db/ddl'
import { purgeTables } from './db/mapper'
import { analyzerHub } from './monitor/hub'
import { settingsFilePath } from './ipc'

/**
 * 抖音直播分析器 的清数据实现（`plugin.purge` 贡献）。
 *
 * 用户卸载插件并勾了「同时删除该插件的全部数据」时由宿主调用，做三件事：
 * 1. 停掉正在跑的一切（弹幕轮询、音频泵、定时器）——不停就删不干净；
 * 2. 清空自己的 6 张表（房间清单与全部历史，表结构留着）；
 * 3. 删设置文件（userData/plugin-state/douyin-link.json）。
 *
 * 只动自己那几样：别的插件与宿主的表、文件一概不碰。
 * （0.6.0 起不再有隐藏窗口，也就没有「每个房间一个 Electron 会话分区」要清了。）
 */
export async function purgePluginData(): Promise<void> {
  analyzerHub.dispose()

  let tables = 0
  try {
    await purgeTables(PURGE_TABLES)
    tables = PURGE_TABLES.length
  } catch (error) {
    logger.warn('[douyin-link] 清空插件表失败:', error)
  }

  let removedFile = false
  try {
    const file = settingsFilePath()
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true })
      removedFile = true
    }
  } catch (error) {
    logger.warn('[douyin-link] 删除设置文件失败:', error)
  }

  logger.info(
    `[douyin-link] 已清除插件数据：清空 ${tables} 张表、设置文件 ${removedFile ? '已删' : '不存在'}`
  )
}
