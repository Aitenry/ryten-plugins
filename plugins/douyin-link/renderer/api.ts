import { DANMAKU_KINDS, isQualityKey } from '../shared/types'
import { clampCookie } from '../shared/cookie'
import { normalizePortraitReport } from '../shared/ai-portrait'
import type {
  AiPortrait,
  AiPortraitChunk,
  AiPortraitFailure,
  AiPortraitModel,
  AiPortraitResult,
  AiPortraitRole,
  AiPortraitState,
  AllAnalysisPush,
  AllRoomsAnalysis,
  AnalyzerSnapshot,
  AudioMessage,
  ComparePush,
  DanmakuItem,
  DanmakuKind,
  DayRecordRow,
  DaysPush,
  DbStats,
  ExportResult,
  FailureInfo,
  GiftBreakdownRow,
  GiftDayRow,
  GiftHistoryRow,
  GiftRankRow,
  IdentityAccountRow,
  ImportResult,
  LiveSettings,
  MessagePage,
  MessageQuery,
  MonitorSession,
  MysteryReveal,
  PresencePush,
  PresenceRow,
  PresenceSnapshot,
  RoomCompareRow,
  RoomRuntime,
  RoomSeriesRow,
  RoomSummary,
  RoomTick,
  StoredMessage,
  SummaryPush,
  UserAnalysis,
  UserAnalysisBehavior,
  UserAnalysisChat,
  UserAnalysisFacts,
  UserAnalysisGifting,
  UserAnalysisInsight,
  UserAnalysisNetwork,
  UserAnalysisPeer,
  UserAnalysisScore,
  UserBatch,
  UserBadge,
  UserDetail,
  UserGiftCalendar,
  UserIdentity,
  UserProfile,
  UserRankPage,
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
  audioOnConnect: true,
  volume: 0.8,
  maxItems: 200,
  kinds: ['chat', 'member', 'like', 'social', 'gift', 'stats', 'control', 'system'],
  autoScroll: true,
  douyinCookie: '',
  monitorConcurrency: 3,
  resumeOnStart: true,
  retentionDays: 7,
  /** 没选过 = null（用宿主的默认模型）；设置页会把「实际会用的那一个」显示出来 */
  portraitProviderId: null,
  /** 默认不动模型（关思考要用户显式打开：它只对支持 `think` 的本地供应商有意义） */
  portraitDisableThinking: false
}

/**
 * 设置归一化：缺项用兜底值，数值收敛到合法范围（音量 0..1）。
 *
 * ⚠️ **这里必须逐字段列全**（2026-10-13 用户报「选择其他模型选择不了」的根因）：
 * 它是设置回话（快照与 `settings-set`）在渲染层的唯一收口，**没列在这里的字段会被悄悄丢掉**，
 * 于是界面拿到的设置里没有那一项 —— 表现为「选完就弹回去、像没生效」，而库里其实已经存对了。
 * 新增设置字段时，这里、`FALLBACK_SETTINGS`、主进程 `DEFAULT_SETTINGS`/`updateSettings`
 * 四处要一起改（工装 `settings-render-check.mjs` 里有一条专门钉这个字段的断言）。
 */
export function normalizeSettings(value: unknown, fallback: LiveSettings = FALLBACK_SETTINGS): LiveSettings {
  if (!isRecord(value)) return { ...fallback, kinds: [...fallback.kinds] }
  const kinds = Array.isArray(value.kinds)
    ? value.kinds.filter((kind): kind is DanmakuKind => DANMAKU_KINDS.includes(kind as DanmakuKind))
    : fallback.kinds
  const bool = (input: unknown, base: boolean): boolean => (typeof input === 'boolean' ? input : base)
  const volume = typeof value.volume === 'number' && Number.isFinite(value.volume) ? value.volume : fallback.volume
  const providerId = value.portraitProviderId
  return {
    quality: isQualityKey(value.quality) ? value.quality : fallback.quality,
    audioOnConnect: bool(value.audioOnConnect, fallback.audioOnConnect),
    volume: Math.min(1, Math.max(0, volume)),
    maxItems: asCount(value.maxItems) || fallback.maxItems,
    kinds: kinds.length > 0 ? kinds : fallback.kinds,
    autoScroll: bool(value.autoScroll, fallback.autoScroll),
    douyinCookie: clampCookie(value.douyinCookie).value,
    monitorConcurrency: asCount(value.monitorConcurrency) || fallback.monitorConcurrency,
    resumeOnStart: bool(value.resumeOnStart, fallback.resumeOnStart),
    retentionDays:
      typeof value.retentionDays === 'number' && Number.isFinite(value.retentionDays)
        ? value.retentionDays
        : fallback.retentionDays,
    portraitProviderId:
      typeof providerId === 'number' && Number.isFinite(providerId) && providerId > 0
        ? Math.round(providerId)
        : null,
    portraitDisableThinking: bool(value.portraitDisableThinking, fallback.portraitDisableThinking ?? false)
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
      enter: asCount(totals.enter),
      like: asCount(totals.like),
      follow: asCount(totals.follow),
      gift: asCount(totals.gift)
    },
    messages: asCount(raw.messages),
    users: asCount(raw.users),
    firstAt: asCount(raw.firstAt),
    lastAt: asCount(raw.lastAt),
    series: asList<RoomSummary['series'][number]>(raw.series),
    kinds: asList<RoomSummary['kinds'][number]>(raw.kinds),
    diamonds: asCount(raw.diamonds),
    gifts: asList<RoomSummary['gifts'][number]>(raw.gifts),
    received: asList<RoomSummary['received'][number]>(raw.received),
    sent: asList<RoomSummary['sent'][number]>(raw.sent),
    topChat: asList<UserRankRow>(raw.topChat)
  }
}

/**
 * 跨直播间聚合分析（数据大屏）：数组字段一律兜空数组；`minutes` 缺省用请求时传的那个
 * （推送来得比 props 晚一拍时的兜底）。
 */
export function normalizeAllRoomsAnalysis(value: unknown, minutes: number): AllRoomsAnalysis {
  const raw = isRecord(value) ? value : {}
  const windowMinutes =
    typeof raw.minutes === 'number' && Number.isFinite(raw.minutes) ? raw.minutes : minutes
  return {
    minutes: windowMinutes,
    windowMinutes: asCount(raw.windowMinutes),
    rooms: asCount(raw.rooms),
    liveRooms: asCount(raw.liveRooms),
    messages: asCount(raw.messages),
    chat: asCount(raw.chat),
    member: asCount(raw.member),
    like: asCount(raw.like),
    social: asCount(raw.social),
    gift: asCount(raw.gift),
    diamonds: asCount(raw.diamonds),
    users: asCount(raw.users),
    firstAt: asCount(raw.firstAt),
    lastAt: asCount(raw.lastAt),
    series: asList<AllRoomsAnalysis['series'][number]>(raw.series),
    sent: asList<GiftRankRow>(raw.sent),
    received: asList<GiftRankRow>(raw.received),
    gifts: asList<GiftBreakdownRow>(raw.gifts),
    perRoom: asList<RoomCompareRow>(raw.perRoom),
    roomSeries: asList<RoomSeriesRow>(raw.roomSeries)
  }
}

/** 消息检索的一页：缺字段就回空页（用户档案里的「历史弹幕」按空态渲染） */
export function normalizeMessagePage(value: unknown): MessagePage {
  const raw = isRecord(value) ? value : {}
  return { rows: asList<MessagePage['rows'][number]>(raw.rows), total: asCount(raw.total) }
}

/** 在线观众快照：行必须是数组，三个计数缺了就数手里的行（面板照常渲染） */
export function normalizePresence(value: unknown, webRid: string): PresenceSnapshot {
  const raw = isRecord(value) ? value : {}
  const rows = asList<PresenceRow>(raw.rows).filter((row) => isRecord(row) && typeof row.userId === 'string')
  return {
    webRid: asText(raw.webRid) || webRid,
    rows,
    micCount: asCount(raw.micCount) || rows.filter((row) => row.seat > 0).length,
    listedCount: asCount(raw.listedCount) || rows.filter((row) => row.listed).length,
    activeCount: asCount(raw.activeCount) || rows.filter((row) => row.lastSeen > 0).length,
    voice: raw.voice === true,
    hasInfo: raw.hasInfo === true,
    updatedAt: asCount(raw.updatedAt)
  }
}

/**
 * 「分析用户」画像归一化：缺字段一律给安全默认，界面永远拿到形状完整的对象
 * （打分用的 `key` 是机器键，界面再按当前语言拼句）。
 */
export function normalizeUserAnalysis(value: unknown): UserAnalysis {
  const raw = isRecord(value) ? value : {}
  const scores = (input: unknown): UserAnalysisScore[] =>
    asList<unknown>(input)
      .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.key === 'string')
      .map((item) => ({ key: item.key as string, score: asCount(item.score) }))
  const insights = (input: unknown): UserAnalysisInsight[] =>
    asList<unknown>(input)
      .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.key === 'string')
      .map((item) => ({
        key: item.key as string,
        params: isRecord(item.params) ? (item.params as Record<string, string | number>) : {}
      }))
  const factsRaw = isRecord(raw.facts) ? raw.facts : {}
  const facts: UserAnalysisFacts = {
    recencyHours: asCount(factsRaw.recencyHours),
    activeDays: asCount(factsRaw.activeDays),
    spanDays: asCount(factsRaw.spanDays),
    monetary: asCount(factsRaw.monetary),
    avgGift: asCount(factsRaw.avgGift),
    peakHour: asCount(factsRaw.peakHour),
    sentiment: asCount(factsRaw.sentiment),
    positive: asCount(factsRaw.positive),
    negative: asCount(factsRaw.negative),
    topGiftName: asText(factsRaw.topGiftName),
    topGiftCount: asCount(factsRaw.topGiftCount),
    topGiftDiamonds: asCount(factsRaw.topGiftDiamonds),
    giftKinds: asCount(factsRaw.giftKinds),
    recipients: asCount(factsRaw.recipients)
  }
  const chatRaw = isRecord(raw.chat) ? raw.chat : {}
  const chat: UserAnalysisChat = {
    sampleCount: asCount(chatRaw.sampleCount),
    avgLength: asCount(chatRaw.avgLength),
    emojiRate: asCount(chatRaw.emojiRate),
    mentionRate: asCount(chatRaw.mentionRate),
    questionRate: asCount(chatRaw.questionRate),
    exclaimRate: asCount(chatRaw.exclaimRate),
    repeatRate: asCount(chatRaw.repeatRate),
    valence: asCount(chatRaw.valence),
    arousal: asCount(chatRaw.arousal),
    emotions: scores(chatRaw.emotions),
    topics: scores(chatRaw.topics),
    keywords: asList<unknown>(chatRaw.keywords).filter((word): word is string => typeof word === 'string')
  }
  const peers = (input: unknown): UserAnalysisPeer[] =>
    asList<unknown>(input)
      .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.userId === 'string')
      .map((item) => ({
        userId: item.userId as string,
        name: asText(item.name),
        diamonds: asCount(item.diamonds),
        items: asCount(item.items),
        hits: asCount(item.hits),
        share: asCount(item.share),
        lastAt: asCount(item.lastAt)
      }))
  const giftingRaw = isRecord(raw.gifting) ? raw.gifting : {}
  const giftHoursRaw = asList<unknown>(giftingRaw.hours).map((value) => asCount(value))
  const gifting: UserAnalysisGifting = {
    giftDays: asCount(giftingRaw.giftDays),
    perDay: asCount(giftingRaw.perDay),
    maxGift: asCount(giftingRaw.maxGift),
    topGiftShare: asCount(giftingRaw.topGiftShare),
    peakHour: asCount(giftingRaw.peakHour),
    spanDays: asCount(giftingRaw.spanDays),
    hours: giftHoursRaw.length === 24 ? giftHoursRaw : new Array(24).fill(0),
    recipients: asCount(giftingRaw.recipients),
    topRecipientShare: asCount(giftingRaw.topRecipientShare),
    topRecipientName: asText(giftingRaw.topRecipientName)
  }
  const networkRaw = isRecord(raw.network) ? raw.network : {}
  const network: UserAnalysisNetwork = {
    outgoing: peers(networkRaw.outgoing),
    incoming: peers(networkRaw.incoming),
    outTotal: asCount(networkRaw.outTotal),
    inTotal: asCount(networkRaw.inTotal)
  }
  const behaviorRaw = isRecord(raw.behavior) ? raw.behavior : {}
  const behavior: UserAnalysisBehavior = {
    sessions: asCount(behaviorRaw.sessions),
    avgStayMinutes: asCount(behaviorRaw.avgStayMinutes),
    maxStayMinutes: asCount(behaviorRaw.maxStayMinutes),
    kinds: scores(behaviorRaw.kinds),
    topKind: asText(behaviorRaw.topKind),
    perSession: asCount(behaviorRaw.perSession),
    followDays: asCount(behaviorRaw.followDays)
  }
  return {
    hasData: raw.hasData === true,
    archetype: asText(raw.archetype) || 'balanced',
    confidence: asCount(raw.confidence),
    archetypes: scores(raw.archetypes),
    traits: scores(raw.traits),
    personality: scores(raw.personality),
    personalityTop: asText(raw.personalityTop),
    motivations: scores(raw.motivations),
    motivationTop: asText(raw.motivationTop),
    chat,
    behavior,
    gifting,
    network,
    tags: asList<unknown>(raw.tags).filter((tag): tag is string => typeof tag === 'string'),
    insights: insights(raw.insights),
    facts
  }
}

/* --------------------------------------------------------------- AI 画像归一化 */

/** 生成失败的原因白名单（主进程给机器码，文案在界面） */
export const AI_PORTRAIT_FAILURES: AiPortraitFailure[] = [
  'no-model',
  'model-failed',
  'busy',
  'no-data',
  'cancelled'
]

function normalizeAiPortraitModel(value: unknown): AiPortraitModel | null {
  if (!isRecord(value)) return null
  const id = asCount(value.id)
  if (id <= 0) return null
  return {
    id,
    name: asText(value.name),
    model: asText(value.model),
    isDefault: value.isDefault === true
  }
}

/**
 * 角色字段的归一：只认 `viewer` / `host`，其它一律按观众。
 *
 * 与主进程的 `portraitRoleArg` 是**一对**：主进程那边「不认识就当没传（自动判定）」，
 * 这边「不认识就当观众」——界面宁可显示成观众，也不要因为一个脏字段白屏。
 */
export function asPortraitRole(value: unknown): AiPortraitRole {
  return value === 'host' ? 'host' : 'viewer'
}

/**
 * 一份已生成的画像。
 *
 * `report` 走 shared 的 `normalizePortraitReport`（与主进程**同一份**校验与限长逻辑）：
 * 库里存的 JSON 可能是旧版本写的、也可能被人手改过，多过一道不至于把界面撑坏。
 * 结构化失败的（模型没按 JSON 回）保留 `raw`，界面按原文显示。
 */
export function normalizeAiPortrait(value: unknown): AiPortrait {
  const raw = isRecord(value) ? value : {}
  const report = normalizePortraitReport(raw.report)
  return {
    key: asText(raw.key),
    userId: asText(raw.userId),
    role: asPortraitRole(raw.role),
    version: asCount(raw.version),
    providerId: asCount(raw.providerId),
    providerName: asText(raw.providerName),
    model: asText(raw.model),
    report,
    raw: asText(raw.raw),
    fingerprint: asText(raw.fingerprint),
    interactions: asCount(raw.interactions),
    inputTokens: asCount(raw.inputTokens),
    outputTokens: asCount(raw.outputTokens),
    generatedAt: asCount(raw.generatedAt)
  }
}

/** 打开弹窗的状态（缺字段一律空态，不炸界面） */
export function normalizeAiPortraitState(value: unknown): AiPortraitState {
  const raw = isRecord(value) ? value : {}
  const current = isRecord(raw.current) ? raw.current : {}
  const selected = raw.selectedProviderId
  return {
    portrait: isRecord(raw.portrait) ? normalizeAiPortrait(raw.portrait) : null,
    role: asPortraitRole(raw.role),
    detectedRole: asPortraitRole(raw.detectedRole),
    current: { fingerprint: asText(current.fingerprint), interactions: asCount(current.interactions) },
    running: raw.running === true,
    models: asList<unknown>(raw.models)
      .map((entry) => normalizeAiPortraitModel(entry))
      .filter((entry): entry is AiPortraitModel => entry !== null),
    selectedProviderId:
      typeof selected === 'number' && Number.isFinite(selected) && selected > 0 ? Math.round(selected) : null
  }
}

export const api = {
  /* ------------------------------------------------------------- 快照 */  snapshot: async (): Promise<AnalyzerSnapshot> => normalizeSnapshot(await invoke(`${PREFIX}snapshot`)),

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

  /* ------------------------------------------------------- 导入 / 导出 */
  /**
   * 导出全部记录为 ZIP（每个 JSON = 某房间某一天的直播数据）。
   * 主进程弹系统保存框；取消或失败都回一个 `ok: false` 的结果，界面按 message 提示。
   */
  exportArchive: async (): Promise<ExportResult> => {
    const raw = await invoke(`${PREFIX}export-archive`)
    const record = isRecord(raw) ? raw : {}
    return {
      ok: record.ok === true,
      path: asText(record.path),
      rooms: asCount(record.rooms),
      days: asCount(record.days),
      messages: asCount(record.messages),
      message: typeof record.message === 'string' ? record.message : undefined
    }
  },
  /** 导入一个 ZIP（去重合并），主进程弹系统打开框；导入后房间清单会自动刷新 */
  importArchive: async (): Promise<ImportResult> => {
    const raw = await invoke(`${PREFIX}import-archive`)
    const record = isRecord(raw) ? raw : {}
    return {
      ok: record.ok === true,
      rooms: asCount(record.rooms),
      messages: asCount(record.messages),
      skipped: asCount(record.skipped),
      users: asCount(record.users),
      message: typeof record.message === 'string' ? record.message : undefined
    }
  },

  /* ------------------------------------------------------- 分析查询 */
  messagesQuery: async (query: MessageQuery): Promise<MessagePage> =>
    normalizeMessagePage(await invoke(`${PREFIX}messages-query`, query)),
  /**
   * 某个人发过的消息（用户档案弹窗里的「历史弹幕」）。
   *
   * 不用新通道：`messages-query` 本来就支持 `userId`，这里只是把参数摆好。
   * `webRid` 传空串 = **跨房间查**（消息流水里的 userId 是全局的，用户统计才是按房间存的）。
   * `userId` 为空直接回空页——不拦的话空条件会变成「把整个库捞一遍」。
   *
   * **多账号（0.15.11）**：`userIds` 是画像的全部账号（含主 id），主进程按「命中任一 id」筛——
   * 所以同一个人的两个号说过的话会**并成一份历史**（关联一律走 id，不看昵称）。
   */
  userMessages: async (
    webRid: string,
    userId: string,
    options: {
      kind?: DanmakuKind | ''
      limit?: number
      offset?: number
      from?: number
      to?: number
      userIds?: string[]
    } = {}
  ): Promise<MessagePage> => {
    if (!userId) return { rows: [], total: 0 }
    const ids = (options.userIds ?? []).filter((id) => id && id !== userId)
    return normalizeMessagePage(
      await invoke(`${PREFIX}messages-query`, {
        webRid,
        userId,
        ...(ids.length > 0 ? { userIds: ids } : {}),
        kind: options.kind ?? '',
        limit: options.limit ?? 50,
        offset: options.offset ?? 0,
        ...(options.from ? { from: options.from } : {}),
        ...(options.to ? { to: options.to } : {})
      })
    )
  },
  /**
   * 房间概览。`range` 给了就按那一段查（时间进度条 / 「看某一天」），否则按最近 `minutes` 分钟；
   * `minutes = 0` 且没有 range = 全部。
   */
  roomSummary: async (webRid: string, minutes = 60, range?: { from: number; to: number }): Promise<RoomSummary> =>
    normalizeRoomSummary(
      await invoke(`${PREFIX}room-summary`, webRid, minutes, range?.from, range?.to),
      webRid,
      minutes
    ),
  /** 每一天的直播记录（左侧房间旁边的列表） */
  dayRecords: async (webRid: string, limit = 90): Promise<DayRecordRow[]> =>
    asList<DayRecordRow>(await invoke(`${PREFIX}day-records`, webRid, limit)),
  /**
   * 查看真实资料：拿用户 id 去抖音查这个账号的平台资料（真名/头像/粉丝数等）。
   *
   * `webRid` 一起传过去：主进程查到之后会**回填**到这个房间的档案行（只写静态字段），
   * 界面随后重拉一次档案就能看到更新后的内容——不需要另开一块「真实资料」。
   * 主进程没回复（桥没挂上）时回 `null`，界面按失败渲染。
   */
  revealMystery: async (userId: string, webRid = ''): Promise<MysteryReveal | null> => {
    const raw = await invoke(`${PREFIX}reveal-mystery`, userId, webRid)
    return isRecord(raw) ? (raw as unknown as MysteryReveal) : null
  },
  roomsCompare: async (minutes = 60): Promise<RoomCompareRow[]> =>
    asList<RoomCompareRow>(await invoke(`${PREFIX}rooms-compare`, minutes)),
  /**
   * 跨直播间聚合分析（数据大屏的「全局分析」）。查一次并**顺带登记**实时推送
   * （同 `roomSummary` 的登记语义：落库后会按同一窗口推回来）。
   */
  allAnalysis: async (minutes = 60, range?: { from: number; to: number } | null): Promise<AllRoomsAnalysis> =>
    normalizeAllRoomsAnalysis(
      await invoke(`${PREFIX}all-analysis`, minutes, range?.from, range?.to),
      minutes
    ),
  /** 停止全局分析的实时推送（切回单房间模式 / 卸载时调）；发出去就不管回话 */
  allAnalysisUnwatch: (): void => {
    void invoke(`${PREFIX}all-analysis-unwatch`)
  },
  usersList: async (
    webRid: string,
    sort: 'recent' | 'chat' | 'gift' = 'recent',
    keyword = '',
    options: { limit?: number; offset?: number } = {}
  ): Promise<UserRankPage> => {
    const raw = await invoke(
      `${PREFIX}users-list`,
      webRid,
      sort,
      keyword,
      options.limit ?? 200,
      options.offset ?? 0
    )
    const record = isRecord(raw) ? raw : {}
    return { rows: asList<UserRankRow>(record.rows), total: asCount(record.total) }
  },
  /**
   * 在线观众（麦上 + 房间成员 + 本场活跃，见 shared/types 的 PresenceRow）。
   *
   * 这一项**不走事件推送**：面板只在自己可见时按需拉（几秒一次），
   * 不然每个房间每秒都要把几百行档案推给渲染层，纯属浪费。
   *
   * **拿不到主进程的回复时回 `null`**（而不是一份「全 0 的快照」）：
   * 主进程还没装载好、或这个通道在运行的版本里不存在（宿主刚升级插件但主进程还是旧模块）时，
   * 回一份全 0 快照会让界面把「没连上」说成「这个房间没人」——那就成了撒谎。
   */
  presenceList: async (webRid: string): Promise<PresenceSnapshot | null> => {
    const raw = await invoke(`${PREFIX}presence-list`, webRid)
    if (!isRecord(raw)) return null
    return normalizePresence(raw, webRid)
  },
  userGet: async (webRid: string, userId: string): Promise<UserDetail | null> => {
    const raw = await invoke(`${PREFIX}user-get`, webRid, userId)
    return isRecord(raw) ? (raw as unknown as UserDetail) : null
  },
  /**
   * 画像（多账号）：这个人绑定的全部账号 + 画像名/主账号。
   * 主进程没回话时返回一份「只有他自己」的空画像——界面按「一个人」渲染，不会白屏。
   */
  userIdentity: async (userId: string): Promise<UserIdentity> => {
    const raw = await invoke(`${PREFIX}user-identity`, userId)
    if (!isRecord(raw)) return { identityId: 0, name: '', note: '', primaryUserId: userId, accounts: [] }
    return {
      identityId: asCount(raw.identityId),
      name: typeof raw.name === 'string' ? raw.name : '',
      note: typeof raw.note === 'string' ? raw.note : '',
      primaryUserId: typeof raw.primaryUserId === 'string' ? raw.primaryUserId : userId,
      accounts: asList<IdentityAccountRow>(raw.accounts)
    }
  },
  /**
   * 搜可关联的账号（跨房间，按昵称/抖音号/id）。**粘贴 id 也走这条**：
   * 输入一整串数字时，命中就是这个人自己。
   */
  accountSearch: async (keyword: string, limit = 20): Promise<IdentityAccountRow[]> =>
    asList<IdentityAccountRow>(await invoke(`${PREFIX}account-search`, keyword, limit)),
  /** 关联账号：把 `targetUserId` 绑到 `sourceUserId` 的画像（两边各有画像就合并），回最新画像视图 */
  accountBind: async (sourceUserId: string, targetUserId: string): Promise<UserIdentity | null> => {
    const raw = await invoke(`${PREFIX}account-bind`, sourceUserId, targetUserId)
    return isRecord(raw) ? ((raw as unknown as UserIdentity) ?? null) : null
  },
  /**
   * 解除关联（只剩一个账号时画像自动解散）。
   * `viewerUserId` = 界面上正在看的 id：回话回的是**他的**画像视图（被解绑的那个账号
   * 解绑后已经不属于任何画像了，拿它的视图回会把弹窗换成空壳）。
   */
  accountUnbind: async (userId: string, viewerUserId: string): Promise<UserIdentity | null> => {
    const raw = await invoke(`${PREFIX}account-unbind`, userId, viewerUserId)
    return isRecord(raw) ? ((raw as unknown as UserIdentity) ?? null) : null
  },
  /** 改画像名（空串 = 退回主账号昵称），回最新画像视图 */
  identityRename: async (userId: string, name: string): Promise<UserIdentity | null> => {
    const raw = await invoke(`${PREFIX}identity-rename`, userId, name)
    return isRecord(raw) ? ((raw as unknown as UserIdentity) ?? null) : null
  },
  /**
   * 实时列表行首那截「人物信息」：等级 / 消费评分 / 入场次数 / 今日消费。
   *
   * 一次一批 id（界面按「可见行 + 新到的消息批」攒，1 秒节流一次）：跨房间的入场合计与
   * 「今天消费」只有主进程手上才有，逐个查会把宿主的 PGlite 拖住（见 hub.userBadges）。
   */
  userBadges: async (webRid: string, userIds: string[]): Promise<UserBadge[]> => {
    if (!webRid || userIds.length === 0) return []
    return asList<UserBadge>(await invoke(`${PREFIX}user-badges`, webRid, userIds))
  },
  /** 某个人送过的礼物（按礼物名聚合；用户榜悬停时按需查） */
  userGifts: async (webRid: string, userId: string): Promise<GiftBreakdownRow[]> =>
    asList<GiftBreakdownRow>(await invoke(`${PREFIX}user-gifts`, webRid, userId)),
  /**
   * 「分析用户」：**跨全部直播间**的画像（只传 userId）。
   * 主进程按人在全库聚合，再跑确定性规则算法，不依赖大模型；文案由界面本地化。
   */
  userAnalysis: async (userId: string): Promise<UserAnalysis | null> => {
    const raw = await invoke(`${PREFIX}user-analysis`, userId)
    return isRecord(raw) ? normalizeUserAnalysis(raw) : null
  },
  /**
   * 「AI 画像」：**读缓存状态**（打开弹窗就调）。
   *
   * 回的是五样：已生成的画像（含角色 / 版本 / 模型 / 用量 / 数据指纹）、当前数据侧现状
   * （用来提示「数据已更新」）、是否正在生成、可选模型清单，以及**自动判定的角色**
   * （界面用它做分段控件的默认值）。这里同样把 IPC 回话归一化——主进程换实现或缺字段时，
   * 界面最多是空态，不会白屏。
   *
   * `role` 不传（`undefined`）时主进程按数据自动判定；切角色就是再调一次这个。
   */
  aiPortrait: async (userId: string, webRid = '', role?: AiPortraitRole): Promise<AiPortraitState> => {
    const raw = await invoke(`${PREFIX}ai-portrait`, userId, webRid, role ?? '')
    return normalizeAiPortraitState(raw)
  },
  /**
   * 「AI 画像」：**生成一版**（真调大模型，会花钱）。
   *
   * `force = false` 时主进程若已有缓存就直接回缓存——「每次重开弹窗都重新生成」会白烧 token
   * （用户 2026-10-13 的原话）。只有用户点了「重新生成」才 `force = true`（版本 +1）。
   * `role` 决定用的是哪一套材料与提问（观众 / 主播），缓存也按角色分开。
   */
  aiPortraitGenerate: async (
    webRid: string,
    userId: string,
    force = false,
    role?: AiPortraitRole
  ): Promise<AiPortraitResult> => {
    const raw = await invoke(`${PREFIX}ai-portrait-generate`, webRid, userId, force, role ?? '')
    if (!isRecord(raw)) return { ok: false, reason: 'model-failed' }
    const reason = asText(raw.reason)
    return {
      ok: raw.ok === true,
      reason: AI_PORTRAIT_FAILURES.includes(reason as AiPortraitFailure)
        ? (reason as AiPortraitFailure)
        : undefined,
      detail: asText(raw.detail) || undefined,
      portrait: isRecord(raw.portrait) ? normalizeAiPortrait(raw.portrait) : undefined
    }
  },
  /** 可选模型清单（设置页的下拉用；**不含 api_key**——主进程只挑 id/名字/模型名发过来） */
  aiPortraitModels: async (): Promise<AiPortraitModel[]> => {
    const raw = await invoke(`${PREFIX}ai-portrait-models`)
    return asList<unknown>(raw)
      .map((entry) => normalizeAiPortraitModel(entry))
      .filter((entry): entry is AiPortraitModel => entry !== null)
  },
  /**
   * 「AI 画像」：**停止**正在跑的那一次（本地小模型一次可能跑十几分钟，光等不行）。
   * 回 `true` = 确实掐了一次；`false` = 那一刻没有在跑的生成（已经结束或本来就没开）。
   */
  aiPortraitCancel: async (userId: string): Promise<boolean> =>
    (await invoke(`${PREFIX}ai-portrait-cancel`, userId)) === true,
  /**
   * 档案里「送礼 / 收礼」点开的**每日收益日历**：这个人一个月的逐日送礼/收礼抖币
   * （跨全部直播间），外加有记录的月份清单与回的是哪个月。
   *
   * `month` 传 `YYYY-MM`；空串 = 让主进程取有记录的最近一个月（从没送过礼的人也不会看到空月份）。
   */
  userGiftCalendar: async (userId: string, month = ''): Promise<UserGiftCalendar> => {
    const raw = await invoke(`${PREFIX}user-gift-calendar`, userId, month)
    const data = isRecord(raw) ? raw : {}
    return {
      month: asText(data.month),
      months: asList<string>(data.months).filter((entry): entry is string => typeof entry === 'string'),
      days: asList<GiftDayRow>(data.days).map((row) => ({
        day: asText((row as GiftDayRow).day),
        bucket: asCount((row as GiftDayRow).bucket),
        sent: asCount((row as GiftDayRow).sent),
        received: asCount((row as GiftDayRow).received),
        sentGifts: asCount((row as GiftDayRow).sentGifts),
        receivedGifts: asCount((row as GiftDayRow).receivedGifts)
      }))
    }
  },
  /**
   * 礼物榜点一行后的礼物历史（`sent` = 他送的 / `received` = 他收到的 / `both` = 两个方向都要）。
   * 走消息流水，所以是**明细**：时间、礼物名、件数、抖币、对方。
   * `both` 时每一行带 `direction` 与 `counterpart`（主进程算好），界面直接显示 `→ / ←`。
   * `range` 必须与榜单同一段（默认就是「今天这一场」）——条数与抖币才和榜上那一行对得上。
   */
  giftHistory: async (
    webRid: string,
    userId: string,
    direction: 'sent' | 'received' | 'both',
    limit = 30,
    offset = 0,
    range?: { from: number; to: number } | null
  ): Promise<{ rows: GiftHistoryRow[]; total: number }> => {
    const raw = await invoke(
      `${PREFIX}gift-history`,
      webRid,
      userId,
      direction,
      limit,
      offset,
      range?.from,
      range?.to
    )
    if (!isRecord(raw)) return { rows: [], total: 0 }
    return {
      rows: asList<GiftHistoryRow>(raw.rows).map((row) => ({
        ...row,
        direction: row.direction === 'received' ? 'received' : 'sent',
        counterpart: asText(row.counterpart),
        counterpartId: asText(row.counterpartId)
      })),
      total: asCount(raw.total)
    }
  },
  /** 头像 data URL（渲染层 CSP 不许外链图片，主进程下载后按 url 缓存） */
  userAvatar: async (webRid: string, userId: string): Promise<string> =>
    asText(await invoke(`${PREFIX}user-avatar`, webRid, userId)),
  sessionsList: async (webRid = '', limit = 20): Promise<MonitorSession[]> =>
    asList<MonitorSession>(await invoke(`${PREFIX}sessions-list`, webRid, limit)),
  /**
   * 停止某个房间概览的实时推送（切房间 / 卸载时调）。
   * 登记是 `roomSummary` 顺带做的（见主进程 ipc），这里只负责撤销——发出去就不管回话。
   */
  summaryUnwatch: (webRid: string): void => {
    if (webRid) void invoke(`${PREFIX}summary-unwatch`, webRid)
  },
  /**
   * 撤销「在线观众 / 每日记录 / 房间对比」的实时推送（切房间 / 切页签 / 卸载时调）。
   * 登记同样是查询顺带做的（见主进程 ipc），这里只负责撤销——发出去就不管回话。
   */
  presenceUnwatch: (webRid: string): void => {
    if (webRid) void invoke(`${PREFIX}presence-unwatch`, webRid)
  },
  daysUnwatch: (webRid: string): void => {
    if (webRid) void invoke(`${PREFIX}days-unwatch`, webRid)
  },
  compareUnwatch: (): void => {
    void invoke(`${PREFIX}compare-unwatch`)
  },
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
  /**
   * 概览实时推送（主进程落库后按界面请求的窗口重算）。
   *
   * 回调里拿到的 `summary` 还是主进程的原始形状，界面用 `normalizeRoomSummary` 收口
   * （与 `roomSummary` 同一条归一化路径），缺字段也不会白屏。
   */
  onSummary: (callback: (push: SummaryPush) => void): (() => void) =>
    window.api.plugin.on(`${PREFIX}summary`, (payload) => {
      const push = payload as SummaryPush
      if (push && typeof push.webRid === 'string' && push.summary) callback(push)
    }),
  /**
   * 跨直播间聚合分析的实时推送（数据大屏的全局页签）。
   * 回调里拿到的 `analysis` 是主进程原始形状，界面用 `normalizeAllRoomsAnalysis` 收口。
   */
  onAllAnalysis: (callback: (push: AllAnalysisPush) => void): (() => void) =>
    window.api.plugin.on(`${PREFIX}all`, (payload) => {
      const push = payload as AllAnalysisPush
      if (push && push.analysis) callback(push)
    }),
  onUsers: (callback: (batch: UserBatch) => void): (() => void) =>
    window.api.plugin.on(`${PREFIX}users`, (payload) => {
      const batch = payload as UserBatch
      if (batch && typeof batch.webRid === 'string' && Array.isArray(batch.users)) callback(batch)
    }),
  /**
   * 在线观众推送（2026-10-11：替掉渲染层那个 5 秒轮询）。
   * 主进程在「观众/麦位/成员名单真的变了」之后推一份，界面直接替换。
   */
  onPresence: (callback: (push: PresencePush) => void): (() => void) =>
    window.api.plugin.on(`${PREFIX}presence`, (payload) => {
      const push = payload as PresencePush
      if (push && typeof push.webRid === 'string' && push.snapshot) callback(push)
    }),
  /** 房间对比推送（替掉对比页签那个 10 秒轮询）；`minutes` 用来挡掉切窗口期间迟到的旧数据 */
  onCompare: (callback: (push: ComparePush) => void): (() => void) =>
    window.api.plugin.on(`${PREFIX}compare`, (payload) => {
      const push = payload as ComparePush
      if (push && typeof push.minutes === 'number' && Array.isArray(push.rows)) callback(push)
    }),
  /** 每日记录推送（替掉左侧列表那个 60 秒轮询） */
  onDays: (callback: (push: DaysPush) => void): (() => void) =>
    window.api.plugin.on(`${PREFIX}days`, (payload) => {
      const push = payload as DaysPush
      if (push && typeof push.webRid === 'string' && Array.isArray(push.days)) callback(push)
    }),
  /** 音频消息（只会是正在响的那个房间）——直接喂给播放器的 handleMessage */
  onAudio: (callback: (message: AudioMessage) => void): (() => void) =>
    window.api.plugin.on(`${PREFIX}audio`, (payload) => {
      const message = payload as AudioMessage
      if (message && typeof message.type === 'string' && typeof message.webRid === 'string') callback(message)
    }),
  /**
   * AI 画像的**流式增量**（模型逐段回话时推来）。
   *
   * 界面按 `requestId` 配对：只认「这次请求」的增量，切人/重新生成时迟到的旧增量直接丢。
   * `delta` 为空、`done: true` 的那一条 = 这次生成收尾（最终结果等 `aiPortraitGenerate` 的回话）。
   */
  onAiPortrait: (callback: (chunk: AiPortraitChunk) => void): (() => void) =>
    window.api.plugin.on(`${PREFIX}portrait`, (payload) => {
      const chunk = payload as AiPortraitChunk
      if (!chunk || typeof chunk.requestId !== 'string') return
      callback({ requestId: chunk.requestId, delta: asText(chunk.delta), done: chunk.done === true })
    })
}

export default api
