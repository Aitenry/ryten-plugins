import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import logger from 'electron-log'
import type { LiveSettings } from '../shared/types'
import {
  AUDIO_EVENT,
  MESSAGES_EVENT,
  ROOMS_EVENT,
  TICKS_EVENT,
  USERS_EVENT,
  analyzerHub
} from './monitor/hub'
import type { MainPluginContext } from '@host/main/plugins/context'

/**
 * 抖音直播分析器 的主进程通道（前缀 `plugin:douyin-link:`，否则装载期就抛）。
 *
 * 分工：
 * - **数据进数据库**（房间清单、消息流水、用户统计、分钟桶、会话）；
 * - **设置进 JSON**（userData/plugin-state/douyin-link.json——它是「偏好」不是数据）；
 * - **运行态在内存**（`monitor/hub.ts`：相位、本场计数、最近弹幕）；
 * - 通道里**不做网络与窗口操作**：全部转给 `analyzerHub`，渲染层拿到的永远是同一份状态。
 *
 * 通道的兜底原则：**能不抛就不抛**。界面一进来就会调 snapshot / rooms-compare 这些，
 * 空库、没选房间、参数缺一半都要给一个合法形状（数组 / null / 0），别让页面白屏。
 */

const SETTINGS_DIR = (): string => path.join(app.getPath('userData'), 'plugin-state')
const SETTINGS_FILE = (): string => path.join(SETTINGS_DIR(), 'douyin-link.json')

/** 设置文件路径（清数据时用） */
export function settingsFilePath(): string {
  return SETTINGS_FILE()
}

/**
 * 读设置。老版本的文件里有 `room` / `autoConnect` 两个字段（单房间时代的默认房间），
 * 这一版不再有「默认房间」——房间清单在数据库里；所以那两个字段**读出来就丢掉**
 * （否则「一开应用就自己连上原来的直播间」会跟着旧文件复活）。
 * `saveData`（省流量：弹幕窗口不加载画面）在 0.6.0 也成了历史：主进程直连不再有窗口，
 * 本来就不会去拉画面，留着它只会让界面有一个不起作用的开关。
 */
export function loadSettings(): Partial<LiveSettings> {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<LiveSettings> & {
      room?: string
      autoConnect?: boolean
      saveData?: boolean
    }
    if (!parsed || typeof parsed !== 'object') return {}
    delete parsed.room
    delete parsed.autoConnect
    delete parsed.saveData
    /**
     * 保留期的迁移（2026-10-08）：旧默认是 7 天，用户在设置里从没主动选过它——
     * 而「礼物不断消失」正是它造成的。默认改成**永久保存**（0）之后，把跟着旧默认写进文件的 7
     * 也一起改成 0，否则老用户升级上来还是 7 天，问题照旧。想自动清理的人填别的天数即可。
     */
    if (parsed.retentionDays === 7) {
      parsed.retentionDays = 0
      logger.info('[douyin-link] 保留期：旧的默认 7 天 → 永久保存（可在设置里改回具体天数）')
    }
    /**
     * 音频下线的迁移（2026-10-08「移除播放音频内容」）：老设置里 `audioOnConnect: true` 会在
     * 开始监控时自己出声，而播放控件已经不在界面上了——置为 false，别让用户遇到
     * 「有声音但找不到地方关」。
     */
    if (parsed.audioOnConnect === true) {
      parsed.audioOnConnect = false
      logger.info('[douyin-link] 音频播放已下线：关闭「连接时播放」（界面不再提供播放/音量）')
    }
    return parsed
  } catch {
    return {}
  }
}

/** 写设置（目录不存在就建：设置放 userData，别写用户的工作区） */
export function saveSettings(settings: LiveSettings): void {
  try {
    const file = SETTINGS_FILE()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf-8')
  } catch (error) {
    logger.warn('[douyin-link] 设置落盘失败:', error)
  }
}

/** 通道表（install 里交给 ctx.registerIpc；停用时随 ctx.dispose 一并摘除） */
export function createIpcHandlers(): Record<string, (...args: never[]) => unknown> {
  const hub = analyzerHub
  return {
    // 全量：房间列表 + 分析中的房间 + 设置 + 该房间的最近弹幕 + 库统计
    'plugin:douyin-link:snapshot': () => hub.snapshot(),

    // 房间清单：加 / 移 / 选 / 监控 / 刷新 / 备注
    'plugin:douyin-link:room-add': (input?: string) => hub.addRoom(String(input ?? '')),
    'plugin:douyin-link:room-remove': (webRid?: string, purge?: boolean) =>
      hub.removeRoom(String(webRid ?? ''), purge !== false),
    'plugin:douyin-link:room-select': (webRid?: string) => hub.selectRoom(String(webRid ?? '')),
    'plugin:douyin-link:room-monitor': (webRid?: string, on?: boolean) =>
      hub.setMonitor(String(webRid ?? ''), on !== false),
    'plugin:douyin-link:room-monitor-all': (on?: boolean) => hub.monitorAll(on !== false),
    'plugin:douyin-link:room-refresh': (webRid?: string) => hub.refreshRoom(String(webRid ?? '')),
    'plugin:douyin-link:room-note': (webRid?: string, note?: string) =>
      hub.noteRoom(String(webRid ?? ''), String(note ?? '')),
    'plugin:douyin-link:room-recent': (webRid?: string, limit?: number) =>
      hub.recentFor(String(webRid ?? ''), typeof limit === 'number' ? limit : 100),

    // 数据清理
    'plugin:douyin-link:messages-clear': (webRid?: string) => hub.clearMessages(String(webRid ?? '')),
    'plugin:douyin-link:recent-clear': (webRid?: string) => hub.clearRecent(String(webRid ?? '')),
    'plugin:douyin-link:users-clear': (webRid?: string) => hub.clearUsers(String(webRid ?? '')).then(() => true),

    // 分析查询（全部走数据库）
    'plugin:douyin-link:messages-query': (query?: unknown) =>
      hub.queryMessages((query ?? {}) as Parameters<typeof hub.queryMessages>[0]),
    'plugin:douyin-link:room-summary': (webRid?: string, minutes?: number, from?: number, to?: number) =>
      hub.summary(
        String(webRid ?? ''),
        typeof minutes === 'number' ? minutes : 60,
        // 时间进度条 / 「看某一天」给的是一段明确区间：两边都是有限数、且 to > from 才认
        typeof from === 'number' && typeof to === 'number' && Number.isFinite(from) && Number.isFinite(to) && to > from
          ? { from, to }
          : undefined
      ),
    // 脱马甲：把匿名/空名的行还原成这个 id 的真名（不传 webRid = 所有房间）
    'plugin:douyin-link:reveal-anonymous': (webRid?: string) => hub.revealAnonymous(String(webRid ?? '')),
    // 每一天的直播记录（左侧房间旁边的列表）
    'plugin:douyin-link:day-records': (webRid?: string, limit?: number) =>
      hub.dayRecords(String(webRid ?? ''), typeof limit === 'number' ? limit : 90),
    'plugin:douyin-link:rooms-compare': (minutes?: number) =>
      hub.compare(typeof minutes === 'number' ? minutes : 60),
    'plugin:douyin-link:users-list': (webRid?: string, sort?: string, keyword?: string, limit?: number) =>
      hub.listUsers(
        String(webRid ?? ''),
        // 排序白名单（gift = 刷礼物榜，按抖币排）
        sort === 'chat' || sort === 'gift' ? sort : 'recent',
        String(keyword ?? ''),
        typeof limit === 'number' ? limit : 200
      ),
    'plugin:douyin-link:user-get': (webRid?: string, userId?: string) =>
      hub.userProfile(String(webRid ?? ''), String(userId ?? '')),
    // 某个人送过的礼物（用户榜悬停看明细）
    'plugin:douyin-link:user-gifts': (webRid?: string, userId?: string) =>
      hub.userGifts(String(webRid ?? ''), String(userId ?? '')),
    // 礼物榜点一行：这个人的礼物历史（sent = 他送的 / received = 他收到的），明细分页
    // `from`/`to` 是榜单当时那段范围（前端把同一段传下来）——明细必须与榜单同一段：今天就是今天
    'plugin:douyin-link:gift-history': (
      webRid?: string,
      userId?: string,
      direction?: string,
      limit?: number,
      offset?: number,
      from?: number,
      to?: number
    ) =>
      hub.giftHistory(
        String(webRid ?? ''),
        String(userId ?? ''),
        direction === 'received' ? 'received' : 'sent',
        typeof limit === 'number' ? limit : 30,
        typeof offset === 'number' ? offset : 0,
        typeof from === 'number' && typeof to === 'number' && Number.isFinite(from) && Number.isFinite(to) && to > from
          ? { from, to }
          : undefined
      ),
    // 「在线观众」：麦上（聊天室）+ 接口给的房间成员 + 本场活跃，合并成一份列表
    'plugin:douyin-link:presence-list': (webRid?: string) => hub.presence(String(webRid ?? '')),
    // 头像：渲染层 CSP 不许外链图片，所以由主进程下载成 data URL 再给界面
    'plugin:douyin-link:user-avatar': (webRid?: string, userId?: string) =>
      hub.userAvatar(String(webRid ?? ''), String(userId ?? '')),
    'plugin:douyin-link:sessions-list': (webRid?: string, limit?: number) =>
      hub.sessions(String(webRid ?? ''), typeof limit === 'number' ? limit : 20),
    'plugin:douyin-link:db-stats': () => hub.databaseStats(),
    /** 立刻按保留期清一次旧数据（设置页的「立即清理」） */
    'plugin:douyin-link:cleanup': () => hub.cleanup(),

    // 音频：**只跟分析中的房间**（全局一个泵），这两个通道是「要不要收」的开关
    'plugin:douyin-link:audio-start': (webRid?: string) =>
      hub.startAudio(typeof webRid === 'string' && webRid ? webRid : undefined),
    'plugin:douyin-link:audio-stop': () => hub.stopAudio(),

    'plugin:douyin-link:settings-set': async (patch?: Partial<LiveSettings>) => {
      const previous = hub.getSettings()
      const next = hub.updateSettings(patch ?? {})
      saveSettings(next)
      await hub.applySettingsEffects(previous)
      return next
    }
  }
}

/**
 * 装载期把设置读进来、把库里的房间清单读进内存。
 *
 * **这里不做任何连接**：打开应用只恢复「清单」，不解析、不轮询、不出声——
 * 上一版就是在这里按设置自动连上「上次那个直播间」，用户看到的就是「一开应用又冒出原来的直播间」。
 * 想恢复监控的人在设置里打开「启动时接着监控上次的房间」。
 */
export function initAnalyzer(ctx: MainPluginContext): void {
  ctx.effect(() => {
    const settings = loadSettings()
    void analyzerHub
      .init(settings)
      .then(() => {
        saveSettings(analyzerHub.getSettings())
        logger.info('[douyin-link] 设置已装载（房间清单只恢复列表，不自动连接）')
      })
      .catch((error) => logger.error('[douyin-link] 分析中枢装载失败:', error))
    return () => {
      analyzerHub.dispose()
    }
  })
}

/** 事件通道名（install 里 registerEvent 用） */
export const EVENTS = [ROOMS_EVENT, MESSAGES_EVENT, USERS_EVENT, TICKS_EVENT, AUDIO_EVENT]
