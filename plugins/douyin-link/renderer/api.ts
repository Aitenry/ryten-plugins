import { DANMAKU_KINDS, isQualityKey } from '../shared/types'
import type {
  AnalyzerSnapshot,
  AudioMessage,
  DanmakuItem,
  DanmakuKind,
  DbStats,
  FailureInfo,
  LiveSettings,
  MessagePage,
  MessageQuery,
  MonitorSession,
  RoomCompareRow,
  RoomRuntime,
  RoomSummary,
  RoomTick,
  UserBatch,
  UserProfile,
  UserRankRow
} from '../shared/types'

/**
 * 抖音直播分析器 主进程通道的薄封装。
 *
 * 组件里**不直接写通道名**：改通道只动这一处，类型也只有这一处需要维护。
 * 走的是 preload 唯一暴露的通用桥（`window.api.plugin.invoke` / `.on`）；
 * 事件通道必须由主进程 `ctx.registerEvent` 声明过才订阅得到。
 *
 * 两条纪律：
 * 1. **回话必须归一化**（见下面「载荷归一化」）：界面永远拿到形状完整的对象，
 *    「主进程还没起来 / 这一项拿不到」表现为空态，而不是白屏；
 * 2. **事件回调不信任 payload 形状**：拿不到认识的字段就当空批处理，
 *    界面最多是「这一批没显示」。
 */

/** 房间列表推送（主进程 → 界面）：整份列表，界面直接替换 */
export interface RoomsPush {
  rooms: RoomRuntime[]
  activeRoom: string
  audioRoom: string
}

const PREFIX = 'plugin:douyin-link:'

/**
 * 主进程通道的调用桥：preload 唯一暴露的通用桥（`window.api.plugin.invoke`）。
 *
 * 草稿目录里的 `./context.ts` 只有这一个运行期东西（其余是宿主上下文的类型影子）；
 * 并入本仓库后渲染层契约统一在 `../types/plugin.ts`（纯类型），桥就留在这一层，
 * 组件里不直接写通道名。
 */
const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  window.api.plugin.invoke(channel, ...args)

/* --------------------------------------------------------------- 载荷归一化 */

/**
 * 为什么在这一层收口：快照是界面所有数字的唯一入口（`settings.volume`、`rooms`、`recent`…），
 * 只要哪个字段没回来，组件里一个 `rooms.find(...)` 就会把整页打成白屏。
 * 而「这一项暂时拿不到」在两种**正常**场景里真的会发生——应用冷启动的第一个瞬间，
 * 以及工坊的渲染层探针挂载冒烟（它在插件刚装好、主进程可能还没起好时就渲染一次页面）。
 * 所以边界在 api 层：出口一律是形状完整、类型正确的对象。
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const asCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

const asList = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

/** 兜底设置：与主进程 `DEFAULT_SETTINGS`（main/monitor/hub.ts）逐字一致 */
export const FALLBACK_SETTINGS: LiveSettings = {
  quality: 'SD2',
  saveData: true,
  audioOnConnect: true,
  volume: 0.8,
  maxItems: 200,
  kinds: ['chat', 'gift', 'member', 'like', 'social', 'stats', 'control'],
  autoScroll: true,
  monitorConcurrency: 3,
  resumeOnStart: true,
  retentionDays: 7
}

/** 设置归一化：缺项用兜底值，数值收敛到合法范围（音量 0..1） */
export function normalizeSettings(value: unknown, fallback: LiveSettings = FALLBACK_SETTINGS): LiveSettings {
  if (!isRecord(value)) return { ...fallback, kinds: [...fallback.kinds] }
  const kinds = Array.isArray(value.kinds)
    ? value.kinds.filter((kind): kind is DanmakuKind => DANMAKU_KINDS.includes(kind as DanmakuKind))
    : fallback.kinds
  const bool = (input: unknown, base: boolean): boolean => (typeof input === 'boolean' ? input : base)
  const volume = typeof value.volume === 'number' && Number.isFinite(value.volume) ? value.volume : fallback.volume
  return {
    quality: isQualityKey(value.quality) ? value.quality : fallback.quality,
    saveData: bool(value.saveData, fallback.saveData),
    audioOnConnect: bool(value.audioOnConnect, fallback.audioOnConnect),
    volume: Math.min(1, Math.max(0, volume)),
    maxItems: asCount(value.maxItems) || fallback.maxItems,
    kinds: kinds.length > 0 ? kinds : fallback.kinds,
    autoScroll: bool(value.autoScroll, fallback.autoScroll),
    monitorConcurrency: asCount(value.monitorConcurrency) || fallback.monitorConcurrency,
    resumeOnStart: bool(value.resumeOnStart, fallback.resumeOnStart),
    retentionDays: typeof value.retentionDays === 'number' && Number.isFinite(value.retentionDays) ? value.retentionDays : fallback.retentionDays
  }
}

/** 行数统计：缺字段就是 0（设置页的「数据库」一栏照常显示） */
export function normalizeDbStats(value: unknown): DbStats {
  const raw = isRecord(value) ? value : {}
  return {
    rooms: asCount(raw.rooms),
    messages: asCount(raw.messages),
    users: asCount(raw.users),
    minutes: asCount(raw.minutes),
    sessions: asCount(raw.sessions),
    gifts: asCount(raw.gifts),
    firstMessageAt: asCount(raw.firstMessageAt),
    lastMessageAt: asCount(raw.lastMessageAt)
  }
}

/**
 * 快照归一化。`rooms` 是重点：界面里到处是 `rooms.find(...)`，
 * 它必须是数组——哪怕这次什么都没拿到。
 */
export function normalizeSnapshot(value: unknown): AnalyzerSnapshot {
  const raw = isRecord(value) ? value : {}
  return {
    rooms: asList<RoomRuntime>(raw.rooms).filter((room) => isRecord(room) && typeof room.webRid === 'string'),
    activeRoom: asText(raw.activeRoom),
    audioRoom: asText(raw.audioRoom),
    settings: normalizeSettings(raw.settings),
    recent: asList<DanmakuItem>(raw.recent),
    db: normalizeDbStats(raw.db),
    updatedAt: asCount(raw.updatedAt)
  }
}

/** 概览/对比的统计结果：数组字段一律给空数组（图表与榜单本来就按空态渲染） */
export function normalizeRoomSummary(value: unknown, webRid: string, minutes: number): RoomSummary {
  const raw = isRecord(value) ? value : {}
  const totals = isRecord(raw.totals) ? raw.totals : {}
  return {
    webRid: asText(raw.webRid) || webRid,
    windowMinutes: asCount(raw.windowMinutes) || minutes,
    totals: {
      chat: asCount(totals.chat),
      gift: asCount(totals.gift),
      diamonds: asCount(totals.diamonds),
      enter: asCount(totals.enter),
      like: asCount(totals.like),
      follow: asCount(totals.follow)
    },
    messages: asCount(raw.messages),
    users: asCount(raw.users),
    firstAt: asCount(raw.firstAt),
    lastAt: asCount(raw.lastAt),
    series: asList<RoomSummary['series'][number]>(raw.series),
    kinds: asList<RoomSummary['kinds'][number]>(raw.kinds),
    topChat: asList<UserRankRow>(raw.topChat),
    topGift: asList<UserRankRow>(raw.topGift)
  }
}

/** 消息检索的一页：缺字段就回空页（用户档案里的「历史弹幕」按空态渲染） */
export function normalizeMessagePage(value: unknown): MessagePage {
  const raw = isRecord(value) ? value : {}
  return { rows: asList<MessagePage['rows'][number]>(raw.rows), total: asCount(raw.total) }
}

export const api = {
  /* ------------------------------------------------------------- 快照 */
  snapshot: async (): Promise<AnalyzerSnapshot> => normalizeSnapshot(await invoke(`${PREFIX}snapshot`)),

  /* --------------------------------------------------------- 房间清单 */
  roomAdd: async (input: string): Promise<{ ok: boolean; webRid?: string; failure?: FailureInfo }> => {
    const raw = await invoke(`${PREFIX}room-add`, input)
    if (!isRecord(raw)) return { ok: false, failure: { code: 'bridgeUnavailable' } }
    return {
      ok: raw.ok === true,
      webRid: asText(raw.webRid) || undefined,
      failure: isRecord(raw.failure) ? (raw.failure as unknown as FailureInfo) : undefined
    }
  },
  roomRemove: async (webRid: string, purge = true): Promise<boolean> =>
    (await invoke(`${PREFIX}room-remove`, webRid, purge)) === true,
  roomSelect: async (webRid: string): Promise<boolean> => (await invoke(`${PREFIX}room-select`, webRid)) === true,
  roomMonitor: async (webRid: string, on: boolean): Promise<boolean> =>
    (await invoke(`${PREFIX}room-monitor`, webRid, on)) === true,
  roomMonitorAll: async (on: boolean): Promise<boolean> => (await invoke(`${PREFIX}room-monitor-all`, on)) === true,
  roomRefresh: async (webRid: string): Promise<boolean> => (await invoke(`${PREFIX}room-refresh`, webRid)) === true,
  roomNote: async (webRid: string, note: string): Promise<boolean> =>
    (await invoke(`${PREFIX}room-note`, webRid, note)) === true,
  /** 「切回某个房间」时先拿它内存里的最近弹幕（库里是全量，检索页签走 messagesQuery） */
  roomRecent: async (webRid: string, limit = 100): Promise<DanmakuItem[]> =>
    asList<DanmakuItem>(await invoke(`${PREFIX}room-recent`, webRid, limit)),

  /* ----------------------------------------------------------- 清理 */
  messagesClear: async (webRid = ''): Promise<number> => asCount(await invoke(`${PREFIX}messages-clear`, webRid)),
  recentClear: async (webRid: string): Promise<boolean> => (await invoke(`${PREFIX}recent-clear`, webRid)) === true,
  usersClear: async (webRid = ''): Promise<boolean> => (await invoke(`${PREFIX}users-clear`, webRid)) === true,

  /* ------------------------------------------------------- 分析查询 */
  messagesQuery: async (query: MessageQuery): Promise<MessagePage> =>
    normalizeMessagePage(await invoke(`${PREFIX}messages-query`, query)),
  /**
   * 某个人发过的消息（用户档案弹窗里的「历史弹幕」）。
   *
   * 不用新通道：`messages-query` 本来就支持 `userId`，这里只是把参数摆好。
   * `webRid` 传空串 = **跨房间查**（消息流水里的 userId 是全局的，用户统计才是按房间存的）。
   * `userId` 为空直接回空页——不拦的话空条件会变成「把整个库捞一遍」。
   */
  userMessages: async (
    webRid: string,
    userId: string,
    options: { kind?: DanmakuKind | ''; limit?: number; offset?: number } = {}
  ): Promise<MessagePage> => {
    if (!userId) return { rows: [], total: 0 }
    return normalizeMessagePage(
      await invoke(`${PREFIX}messages-query`, {
        webRid,
        userId,
        kind: options.kind ?? '',
        limit: options.limit ?? 50,
        offset: options.offset ?? 0
      })
    )
  },
  roomSummary: async (webRid: string, minutes = 60): Promise<RoomSummary> =>
    normalizeRoomSummary(await invoke(`${PREFIX}room-summary`, webRid, minutes), webRid, minutes),
  roomsCompare: async (minutes = 60): Promise<RoomCompareRow[]> =>
    asList<RoomCompareRow>(await invoke(`${PREFIX}rooms-compare`, minutes)),
  usersList: async (
    webRid: string,
    sort: 'recent' | 'chat' | 'gift' = 'recent',
    keyword = '',
    limit = 200
  ): Promise<UserRankRow[]> => asList<UserRankRow>(await invoke(`${PREFIX}users-list`, webRid, sort, keyword, limit)),
  userGet: async (webRid: string, userId: string): Promise<UserProfile | null> => {
    const raw = await invoke(`${PREFIX}user-get`, webRid, userId)
    return isRecord(raw) ? (raw as unknown as UserProfile) : null
  },
  /** 头像 data URL（渲染层 CSP 不许外链图片，主进程下载后按 url 缓存） */
  userAvatar: async (webRid: string, userId: string): Promise<string> =>
    asText(await invoke(`${PREFIX}user-avatar`, webRid, userId)),
  sessionsList: async (webRid = '', limit = 20): Promise<MonitorSession[]> =>
    asList<MonitorSession>(await invoke(`${PREFIX}sessions-list`, webRid, limit)),
  dbStats: async (): Promise<DbStats> => normalizeDbStats(await invoke(`${PREFIX}db-stats`)),
  /** 立刻按保留期清一次旧数据（设置页的「立即清理」），返回删掉的条数 */
  cleanup: async (): Promise<number> => asCount(await invoke(`${PREFIX}cleanup`)),

  /* ----------------------------------------------------------- 音频 */
  /** 声音切到某个房间（**同时只有一个房间出声**，其它房间继续监听弹幕） */
  audioStart: async (webRid?: string): Promise<boolean> => (await invoke(`${PREFIX}audio-start`, webRid)) === true,
  audioStop: async (): Promise<boolean> => (await invoke(`${PREFIX}audio-stop`)) === true,

  setSettings: async (patch: Partial<LiveSettings>): Promise<LiveSettings> =>
    normalizeSettings(await invoke(`${PREFIX}settings-set`, patch)),

  /* ----------------------------------------------------------- 事件 */
  onRooms: (callback: (push: RoomsPush) => void): (() => void) =>
    window.api.plugin.on(`${PREFIX}rooms`, (payload) => {
      const push = payload as RoomsPush
      if (push && Array.isArray(push.rooms)) callback(push)
    }),
  onMessages: (callback: (batch: { webRid: string; items: DanmakuItem[] }) => void): (() => void) =>
    window.api.plugin.on(`${PREFIX}messages`, (payload) => {
      const batch = payload as { webRid?: string; items?: unknown }
      if (!batch || typeof batch.webRid !== 'string' || !Array.isArray(batch.items)) return
      callback({ webRid: batch.webRid, items: batch.items as DanmakuItem[] })
    }),
  onTicks: (callback: (tick: RoomTick) => void): (() => void) =>
    window.api.plugin.on(`${PREFIX}ticks`, (payload) => {
      const tick = payload as RoomTick
      if (tick && typeof tick.webRid === 'string' && tick.counters) callback(tick)
    }),
  onUsers: (callback: (batch: UserBatch) => void): (() => void) =>
    window.api.plugin.on(`${PREFIX}users`, (payload) => {
      const batch = payload as UserBatch
      if (batch && typeof batch.webRid === 'string' && Array.isArray(batch.users)) callback(batch)
    }),
  /** 音频消息（只会是正在响的那个房间）——直接喂给播放器的 handleMessage */
  onAudio: (callback: (message: AudioMessage) => void): (() => void) =>
    window.api.plugin.on(`${PREFIX}audio`, (payload) => {
      const message = payload as AudioMessage
      if (message && typeof message.type === 'string' && typeof message.webRid === 'string') callback(message)
    })
}

export default api
