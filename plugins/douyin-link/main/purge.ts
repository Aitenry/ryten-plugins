import * as fs from 'fs'
import { session } from 'electron'
import logger from 'electron-log'
import { PURGE_TABLES } from './db/ddl'
import { listRooms, purgeTables } from './db/mapper'
import { giftCatalog } from './gift/catalog'
import { analyzerHub } from './monitor/hub'
import { settingsFilePath } from './ipc'

/** 每个房间一个会话分区（与 ./monitor/hub 里保持一致） */
const PARTITION_PREFIX = 'persist:douyin-link-room-'

/**
 * 抖音直播分析器 的清数据实现（`plugin.purge` 贡献）。
 *
 * 用户卸载插件并勾了「同时删除该插件的全部数据」时由宿主调用，做四件事：
 * 1. 停掉正在跑的一切（采集窗口、音频泵、定时器）——不停就删不干净；
 * 2. 清空自己的 7 张表（房间清单与全部历史，表结构留着）；
 * 3. 删设置文件（userData/plugin-state/douyin-link.json）；
 * 4. 清每个房间的会话数据（ttwid 之类的站点数据）。
 *
 * 只动自己那几样：别的插件与宿主的表、会话一概不碰。
 */
export async function purgePluginData(): Promise<void> {
  analyzerHub.dispose()

  // 分区名要先从库里读（清完表就不知道有哪几个房间了）
  let webRids: string[] = []
  try {
    webRids = (await listRooms()).map((room) => room.webRid)
  } catch (error) {
    logger.warn('[douyin-link] 清数据前读房间清单失败（会话数据可能残留）:', error)
  }

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

  let clearedStorage = 0
  for (const webRid of webRids) {
    try {
      await session.fromPartition(`${PARTITION_PREFIX}${webRid}`).clearStorageData()
      clearedStorage += 1
    } catch (error) {
      logger.warn(`[douyin-link] 清理房间 ${webRid} 的会话数据失败:`, error)
    }
  }

  giftCatalog.reset()
  logger.info(
    `[douyin-link] 已清除插件数据：清空 ${tables} 张表、设置文件 ${removedFile ? '已删' : '不存在'}、` +
      `会话数据 ${clearedStorage}/${webRids.length} 个房间`
  )
}
