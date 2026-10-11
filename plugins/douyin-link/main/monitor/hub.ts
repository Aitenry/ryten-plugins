import { BrowserWindow } from 'electron'
import logger from 'electron-log'
import { safeSend } from '@host/main/safe-send'
import {
  QUALITY_KEYS,
  parseWebRid,
  type AllAnalysisPush,
  type AllRoomsAnalysis,
  type AnalyzerSnapshot,
  type AudioMessage,
  type ComparePush,
  type DanmakuItem,
  type DayRecordRow,
  type DanmakuStatus,
  type DaysPush,
  type DbStats,
  type FailureInfo,
  type GiftBreakdownRow,
  type GiftRankRow,
  type IdentityAccountRow,
  type LiveRoomInfo,
  type LiveSettings,
  type MessageBatch,
  type MessagePage,
  type MessageQuery,
  type MonitorPhase,
  type MonitorSession,
  type MysteryReveal,
  type PresencePush,
  type PresenceRow,
  type PresenceSnapshot,
  type QualityKey,
  type RoomCompareRow,
  type RoomRuntime,
  type RoomSeriesRow,
  type RoomSummary,
  type RoomTick,
  type SummaryPush,
  type UserAnalysis,
  type UserBadge,
  type UserIdentity,
  type UserInfo,
  type UserDetail,
  type UserProfile,
  type UserRankPage,
  type UserRankRow,
  type UserStats,
  type UserTotalsRow,
  type UserGiftCalendar,
  type GiftDayRow,
  type GiftHistoryRow,
  type UserBatch,
  type AiPortraitResult,
  type AiPortraitState
} from '../../shared/types'
import * as store from '../db/mapper'
import type { MessageRow } from '../db/mapper'
import { AudioPump } from '../audio/pump'
import { DirectPushCapture } from '../douyin/push-capture'
import { ResolveFailure, enterLiveRoom, resolveLiveRoom } from '../douyin/room'
import { mergeCookieHeaders } from '../douyin/cookie'
import type { RoomResolveResult } from '../douyin/room'
import { fetchUserProfile, revealMysteryProfile } from '../douyin/mystery'
import { avatarCache } from '../avatar'
import { RoomRecorder, minuteOf } from './recorder'
import { TodaySpend } from './today-spend'
import { spendScore } from '../../shared/score'
import { buildUserAnalysis } from '../analysis/portrait'
import {
  aiPortraitState as readAiPortraitState,
  disposePortrait,
  generateAiPortrait as runAiPortrait
} from '../portrait'
import { since, withTimeout } from '../util/deadline'
import {
  ANON_ID_PREFIX,
  anonymousBaseId,
  anonymousMaskTail,
  anonymousUserId,
  displayDisplayId,
  displayNickname,
  isAnonymousId,
  isAnonymousName,
  isUsableNickname,
  isGenericMaskName
} from '../../shared/anonymous'
import { revealAnonymousProfile } from '../douyin/anonymous-reveal'
import { COOKIE_MAX_LENGTH, clampCookie } from '../../shared/cookie'
import { monthBucketRange, monthOf } from '../../shared/gift-calendar'

/**
 * 分析中枢：**所有网络与数据都在这里**（渲染层只是视图）。
 *
 * 链路（实时通道：主进程纯 Node 直连抖音推送 ws，无浏览器、无轮询兜底）：
 *   采集通道（`../douyin/push-capture` 直连 `…/webcast/im/push/v2/` 收逐条消息）→ recorder（本场计数 + 最近弹幕 + 在场/麦位）
 *        → 事件推界面（节流）↘ 每 2 秒 flush：消息流水 / 分钟桶 / 用户统计 → 数据库
 *   直播间接口（`../douyin/room` 的 enter）→ 房间成员名单 + 是否语音聊天室 + 主播信息
 *        → 每 5 分钟轻刷一次（只打 enter，不重新抓页面）
 *
 * | 能力 | 落点 |
 * |------|------|
 * | 同时监控多个房间 | 每个房间一路推送 ws 连接（无窗口、无内存大户） |
 * | 音频只跟「最新选中的房间」 | 全局最多一个 `AudioPump`，切房间时先停旧泵再起新泵 |
 * | 历史与分析数据 | 全部落数据库（`main/db/mapper.ts`），中枢只维护「本场」的内存数字 |
 * | 在线观众 / 麦上用户 | recorder 的在场清单 + 麦位表 + enter 的成员名单，`presence()` 合并 |
 * | 打开应用不该自己连上直播间 | 装载时**只读房间清单**，不解析、不连接、不出声 |
 */

/** 主进程 → 渲染层：房间列表（相位、计数、库里累计）变了 */
export const ROOMS_EVENT = 'plugin:douyin-link:rooms'
/** 主进程 → 渲染层：某个房间来了新消息（一批） */
export const MESSAGES_EVENT = 'plugin:douyin-link:messages'
/** 主进程 → 渲染层：音频消息（只会是正在响的那个房间） */
export const AUDIO_EVENT = 'plugin:douyin-link:audio'
/** 主进程 → 渲染层：某个房间的用户档案有更新 */
export const USERS_EVENT = 'plugin:douyin-link:users'
/**
 * 主进程 → 渲染层：本场计数的**实时心跳**（一秒一跳，只带几个数字）。
 *
 * 为什么不复用 ROOMS 事件：房间列表节流到 2 秒、还带着库里的累计量；
 * 界面上「本场：弹幕 12 · 进场 3」这条统计行要跟手，
 * 所以单开一条只带数字的通道，页面原地合并即可（不重拉快照）。
 */
export const TICKS_EVENT = 'plugin:douyin-link:ticks'
/**
 * 主进程 → 渲染层：概览快照（KPI / 分钟趋势 / 类型分布 / 榜单 + 会话摘要）。
 *
 * 概览里的每一项都是数据库聚合，界面自己轮询只能「每 10 秒看一眼」。这里在**落库之后**
 * （数据此刻才是真的）按界面请求过的窗口重算一份推过去，页面直接替换 → 概览就是活的。
 * 没有新数据落库就不推——空闲房间几乎零开销。
 */
export const SUMMARY_EVENT = 'plugin:douyin-link:summary'

/**
 * 主进程 → 渲染层：**跨直播间聚合分析**（数据大屏的全局分析）。
 *
 * 与 `SUMMARY_EVENT` 同款（落库后按界面请求的窗口重算推回），但口径是**所有房间合起来**：
 * 全局 KPI / 趋势、跨房按人合并的两张礼物榜、每房间流水横截面。它是全窗口扫描，
 * 所以推送节流比概览更宽（见 `ALL_PUSH_MS`），且**只在界面登记了才计算**。
 */
export const ALL_EVENT = 'plugin:douyin-link:all'

/**
 * 主进程 → 渲染层：**在线观众**快照（界面开着这个页签时，数据变了就推）。
 * 2026-10-11 起用它替掉渲染层那个 5 秒轮询（见 `PresencePush` 的说明）。
 */
export const PRESENCE_EVENT = 'plugin:douyin-link:presence'
/** 主进程 → 渲染层：**房间对比**（替掉对比页签那个 10 秒轮询） */
export const COMPARE_EVENT = 'plugin:douyin-link:compare'
/** 主进程 → 渲染层：**每日记录**（替掉左侧列表那个 60 秒轮询） */
export const DAYS_EVENT = 'plugin:douyin-link:days'

/** 一个房间在内存里最多留多少条最近弹幕 */
const RECENT_CAP = 400
/** 「名字空的礼物行」最多记几条日志（见 noteEmptyGifts） */
const EMPTY_GIFT_LOG_LIMIT = 20
/** flush 间隔与「房间列表」推送节流 */
const FLUSH_INTERVAL_MS = 2000
const ROOMS_PUSH_THROTTLE_MS = 1000
/**
 * 落库后多久把概览推出去。落库本身是 2 秒一批，所以这里只需很短的延迟把同一批
 * 攒起来的脏标记合并掉——真正的节流来自「有数据才标脏」，不是这个值。
 */
const SUMMARY_PUSH_MS = 300
/**
 * 全局分析（数据大屏）的推送去抖间隔。
 *
 * 比概览宽得多：它一次要跑好几条**跨房全窗口**聚合（礼物榜 ×2、礼物种类榜、分钟序列、
 * 去重人数），跑在宿主的 PGlite 上，太频繁会把宿主的流式输出一起挤住。
 */
const ALL_PUSH_MS = 4000
/**
 * 「观众 / 对比 / 每日记录」这三份推送的最小间隔（2026-10-11）。
 *
 * 它们原来是渲染层在轮询（5 秒 / 10 秒 / 60 秒各一次 IPC + 一次查询/合成）。
 * 现在改成主进程按「数据真的变了」标脏 + 这个节流推：一次事件里连着落几批数据也只推一份。
 * 比原来的轮询间隔短（2 秒），所以观感只会更实时，而请求次数只少不多。
 */
const WATCH_PUSH_MS = 2000
/** 窗口右端早于「现在」这么多就算历史区间：不会再落进新数据，不必实时重算 */
const SUMMARY_LIVE_GRACE_MS = 60 * 1000
const USERS_PUSH_THROTTLE_MS = 1500
/** 库里累计量的缓存时长（房间列表每秒推一次，不必每次都去 count(*)） */
const STORE_CACHE_MS = 5000
const DB_STATS_CACHE_MS = 15000
/** 推给界面的合批间隔（见 schedulePush）：太快淹掉渲染层，太慢界面不跟手 */
const PUSH_INTERVAL_MS = 250
/** 一个房间一批最多推多少条（超了丢老的：界面已经跟不上了，硬塞只会更卡） */
const MESSAGES_BUFFER_CAP = 600
/** 解析与新房间信息的死线：绝不许把一次点击变成永久转圈 */
const RESOLVE_DEADLINE_MS = 20000
/** 掉线后自动重试的间隔与上限（监控是长期的，中断要自己爬起来） */
const RETRY_DELAY_MS = 25000
const RETRY_LIMIT = 12
/**
 * 下播后「等重新开播」的探测间隔：一分钟一次。
 * 一整天下来是 1440 次轻量解析——比「主播开播了却永远不开始监控」划算得多。
 */
const RELIVE_PROBE_MS = 60 * 1000
/**
 * 实时通道「连着但一条业务消息都没有」容忍多久（见 `watchMonitors`）。
 *
 * 主播下播时推送 ws **常常既不推下播帧、也不断开**，只是不再有业务消息；实测那条废连接
 * 挂着推了 7 个多小时的空帧（真机日志：「实时通道推送过的消息：（一条都没有）」），
 * 于是「连接还在」这件事本身不能当作「还在采集」。live 房间每几秒就有成员/点赞/人数帧，
 * 5 分钟一条业务消息都没有只可能是这条连接已经废了。
 *
 * 这个阈值按真机日志校过（2026-10-11 的 `logs/main.log`，三个房间共 447 段）：
 * 直播中的房间相邻两段消息**中位 120 秒、最大 173 秒**（那是日志自己的 2 分钟汇总节流），
 * 所以 5 分钟离正常抖动还有一倍余量；判错的代价也只是重连一次（约 2 秒）。
 */
const STALL_MS = 5 * 60 * 1000
/** 房间信息（成员名单/在线人数/标题）的轻刷新间隔：只打 enter，一次一个请求 */
const ROOM_REFRESH_MS = 5 * 60 * 1000
/** 没在监控的房间多久刷一次（只要面板有房间级数据就行，别为闲置房间频繁抓页面） */
const IDLE_REFRESH_MS = 30 * 60 * 1000
/** 「在线观众」一次最多合成多少行（面板画不下更多，也免得查询无限膨胀） */
const PRESENCE_ROWS_CAP = 400
/**
 * 数据大屏「指标」页签：每房分钟序列最多推多少个房间（按窗口抖币降序取）。
 * 每房最多 240 个点，24 房就是约 5.8k 个点——够画横向对比，又不至于把负载顶起来。
 */
const ROOM_SERIES_CAP = 24
/**
 * 「只有 id 的人」按 id 去抖音补资料（在线观众里的成员名单只给 id）：
 * 单次最多查多少个 / 并发多少 / 同一个 id 失败后的冷却。
 * 三重约束是为了别把这个接口打爆（用户的诉求是「明明可以获取」，不是「无限抓」）。
 */
const ENRICH_BUDGET = 20
const ENRICH_CONCURRENCY = 2
const ENRICH_FAIL_COOLDOWN_MS = 10 * 60 * 1000
/** 保留期清理的节流 */
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 一次最多给多少个 id 算「行首那截人物信息」（界面按可见行 + 新到的消息批攒，1 秒一次） */
const BADGE_ROWS_CAP = 400

/**
 * 「补档案」跑没跑过的标记（`douyin_link_meta` 的键，见 `repairUserRowsOnce`）。
 * 只做一次的原因：那是**一次性的历史缺口**（0.15.9 以前的配额 bug 留下的），
 * 而全表按 (web_rid, user_id) 聚合在「永久保存」的库上会越跑越贵。
 */
const USERS_REPAIRED_KEY = 'users.repaired'

/**
 * 「匿名身份拆分」跑没跑过的标记（见 `splitAnonymousOnce`）。
 *
 * 与补档案同一个道理：那是一次性的历史重排（把共用占位 id `111111` 上的所有匿名行
 * 按马甲分开），跑完之后新数据写入时就带对了身份，没必要每次启动再扫一遍全库。
 */
const ANON_SPLIT_KEY = 'identity.anon-split'

/**
 * 「空名字回填」跑没跑过的标记（见 `backfillNamesOnce`）。
 *
 * 与补档案/匿名拆分同一个道理：那是一次性的历史修复（补名字那条链以前只对礼物类生效），
 * 跑完之后新数据写入时名字就是对的，没必要每次启动再全表扫一遍。
 */
const NAMES_BACKFILLED_KEY = 'messages.names-backfilled'

export const DEFAULT_SETTINGS: LiveSettings = {
  // 只放声音，档位越低越省流量（实测各档音频轨是一样的）
  quality: 'SD2',
  /**
   * **不再自动出声**（2026-10-08 用户要求「移除播放音频内容」）：播放/清晰度/音量那一整条
   * 工具行都下线了，插件现在是纯采集分析——留着 true 的话，界面上一旦没有停止按钮，
   * 声音就会自己响起来。老设置里写着的 true 会在 `loadSettings` 里迁移成 false。
   */
  audioOnConnect: false,
  volume: 0.8,
  maxItems: 200,
  kinds: ['chat', 'member', 'like', 'social', 'gift', 'stats', 'control', 'system'],
  autoScroll: true,
  // 登录态 Cookie（留空 = 匿名）。抖音只向已登录会话推送礼物消息，填上后普通直播间也能收到礼物
  douyinCookie: '',
  // 同时监控 3 个房间（每个房间一路推送 ws 连接，很轻，但还是别贪）
  monitorConcurrency: 3,
  // 默认**开**：开关开着 = 就在监控（2026-10 用户实测反馈：开关显示开着、实际没在跑，
  // 还得点两次开关才动）。关掉它则「打开应用只恢复清单」，此时启动会把监控勾选一并清掉，
  // 免得开关撒谎（见 init()）。
  resumeOnStart: true,
  /**
   * **默认永久保存**（0 = 不自动清理，用户 2026-10-08：「怎么礼物会不断消失，我需要永久存储，
   * 所有内容都需要永久存储」）。以前默认 7 天，礼物榜/历史翻到 7 天前就没了。
   * 想要自动瘦身的人可以在设置里填天数（> 0 才清理）。
   */
  retentionDays: 0
}

const idleDanmaku = (): DanmakuStatus => ({ phase: 'off', failure: null, since: 0, received: 0 })

/** 一个房间的全部运行态（内存部分；库里那部分按需查） */
interface RoomState {
  webRid: string
  /** 解析用的目标（链接形式，交给 resolveLiveRoom） */
  target: string
  /**
   * 内部房间 id（webcast 接口用的长 id）。
   *
   * 除了实时通道（直连推送 ws）要用，它还决定「房间信息轻刷新」能不能做：库里的房间行带着它，
   * 所以**没在监控的房间**也能每 5 分钟刷一次（在线人数/标题/成员名单/是否语音房）。
   * 缺了它，界面上的「在线观众」在没开监控时就只能是一片 0（用户实测反馈过）。
   */
  roomId: string
  info: LiveRoomInfo | null
  title: string
  anchor: string
  cover: string
  onlineText: string
  status: 'live' | 'ended' | 'unknown'
  note: string
  /** 期望监控（用户勾的） */
  monitor: boolean
  phase: MonitorPhase
  failure: FailureInfo | null
  danmaku: DanmakuStatus
  qualities: QualityKey[]
  quality: QualityKey | null
  streams: Partial<Record<QualityKey, string>>
  /** 解析时拿到的 Cookie（`im/fetch` 轮询要带它；失败重试时会随重新解析换新） */
  cookie: string
  /** 房间成员名单（enter 的 `admin_user_ids_str`，最多 30 位） */
  roomUserIds: string[]
  /** 主播的 User（用来把他放进用户库与在线观众） */
  anchorUser: UserInfo | null
  /** 是否语音/聊天室（有麦位） */
  voice: boolean
  /** 上次轻刷新房间信息的时刻（见 ROOM_REFRESH_MS） */
  refreshedAt: number
  /** 当前音频泵在用的地址（重连会换签名；界面看到的仍是 streamUrl 的语义） */
  sourceUrl: string
  recorder: RoomRecorder
  /**
   * 实时通道：主进程**纯 Node 直连**抖音推送 ws，收逐条消息（弹幕/进场/点赞/礼物/麦位）。
   * **这是唯一的采集通道**（HTTP 轮询兜底已移除）；非空 = 这个房间正在跑，reconcile 据此判重入。
   */
  roomSocket: DirectPushCapture | null
  /**
   * 启动令牌（0 = 没有启动在进行中）。**防重入的关键**。
   *
   * 为什么必须有：`startMonitor()` 要 `await` 解析直播间（约 1 秒）之后才把 `roomSocket`
   * 赋上，而 `reconcile()` 只看 `roomSocket`——这 1 秒里任何一次 reconcile（切房间、点开关、
   * 刷新、设置生效）都会给**同一个房间**再起一路采集，两边把同一批弹幕各推
   * 一次，界面上每条弹幕就出现两遍。真机日志为证（同一房间、相隔 700ms）：
   * `03:56:35.611 开始监控 646268856760` / `03:56:36.303 开始监控 646268856760`。
   */
  startToken: number
  sessionId: number
  attempts: number
  addedAt: number
  lastActiveAt: number
  lastSeenAt: number
}

export class AnalyzerHub {
  private states = new Map<string, RoomState>()
  private settings: LiveSettings = { ...DEFAULT_SETTINGS }
  private activeRoom = ''
  private audioRoom = ''
  private pump: AudioPump | null = null
  private audioSeq = 0
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 「下播了、等它重新开播」的探测定时器（每房间一个，见 `scheduleRelive`） */
  private reliveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * 正在跑「开播探测」的房间（解析要一两秒）。这一两秒里既没有采集、也没有定时器，
   * 看门狗（`watchMonitors`）别把同一件事又排一遍。
   */
  private reliveProbing = new Set<string>()
  /**
   * 每个房间**最近一次真的收到业务消息**的时刻（见 `watchMonitors`）。
   * 只记业务消息（弹幕/进场/礼物/麦位），空帧与心跳不算——它们证明不了房间还在。
   */
  private lastDataAt = new Map<string, number>()
  private roomsDirty = false
  private roomsPushedAt = 0
  /** 启动令牌自增（见 RoomState.startToken） */
  private startSeq = 0
  /** 轻刷新是否在跑（避免 flush 每分钟叠一次请求） */
  private refreshing = false
  /** 攒着还没推给界面的弹幕与心跳（见 schedulePush：逐帧广播会把界面和主进程一起淹掉） */
  private pendingMessages = new Map<string, DanmakuItem[]>()
  private pendingTicks = new Map<string, RoomTick>()
  /**
   * 每个房间「吃一批消息」的串行链（见 handleItems）：
   * 给送礼人补昵称要查库（异步），串起来才能保证批次不会互相超车。
   */
  private readonly ingestChain = new Map<string, Promise<void>>()
  /** 「名字空的礼物行」已经记了几条（见 noteEmptyGifts；别把日志刷爆） */
  private emptyGiftLogged = 0
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private usersPushAt = 0
  private pendingUsers: UserBatch[] = []
  /**
   * 界面正在看的概览窗口（`watchSummary` 登记，房间 + 分钟窗口 / 明确区间）。
   * 只有登记过的房间才会被实时推送——没人看的房间不必花聚合查询。
   */
  private summaryWatch = new Map<string, { minutes: number; range?: { from: number; to: number } }>()
  /** 有数据落库、概览需要重算的房间（推完清空） */
  private summaryDirty = new Set<string>()
  private summaryTimer: ReturnType<typeof setTimeout> | null = null
  /** 概览推送是否在算（避免同一时刻叠几次聚合查询） */
  private summaryPushing = false
  /**
   * 界面正在看的全局分析窗口（`watchAllAnalysis` 登记；`null` = 没人在看）。
   * 与概览不同，全局只有一份，所以用一个字段而不是 Map。
   */
  private allWatch: { minutes: number; range?: { from: number; to: number } } | null = null
  /** 有数据落库、全局分析需要重算（推完清空） */
  private allDirty = false
  private allTimer: ReturnType<typeof setTimeout> | null = null
  /** 全局推送是否在算（避免同一时刻叠几次跨房聚合） */
  private allPushing = false
  /**
   * 「界面正在看的**观众 / 对比 / 每日记录**」——2026-10-11 加，把渲染层那三个轮询
   * （5 秒 / 10 秒 / 60 秒）换成推送。
   *
   * 三份都是「界面开着才有意义」的数据，所以按登记来：谁登记了就为谁算，卸载/切页签就撤销。
   * 推送统一走 `pushWatches()`，一次最多 `WATCH_PUSH_MS`（数据变了才标脏，没变不白算）。
   */
  private presenceWatch = new Map<string, boolean>()
  private presenceDirty = new Set<string>()
  private daysWatch = new Map<string, number>()
  private daysDirty = new Set<string>()
  private compareWatch: number | null = null
  private compareDirty = false
  private watchTimer: ReturnType<typeof setTimeout> | null = null
  private watchPushing = false
  private storeCache = { at: 0, data: new Map<string, store.RoomStore>() }
  private dbCache = { at: 0, data: null as DbStats | null }
  /** 「只有 id 的人」补资料的缓存：成功本进程永久记着，失败按冷却重试（见 enrichUnknownUsers） */
  private enrichCache = new Map<string, { at: number; ok: boolean }>()
  /** 正在补资料的房间：避免 presence 每 5 秒叠一批请求 */
  private enriching = new Set<string>()
  private started = false

  /* ------------------------------------------------------------ 生命周期 */

  /** 装载：把库里的房间清单读进内存，按保留期清一次旧数据。**不自动连接** */
  async init(settings: Partial<LiveSettings>): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...settings }
    /**
     * `system` 与 `gift` 必须留在显示类型里（读旧设置时强制补上）。
     *
     * `system`（0.6.2 起）：房间级提示（`WebcastRoomMessage`，例如「欢迎来到直播间…」）在界面上是
     * `system`，而老版本的默认显示类型里**没有**它——安静房间里唯一会来的消息就被过滤掉了，
     * 「实时」页于是看着像坏了（用户 2026-10 实测反馈「实时里面的弹幕，没有任何内容」）。
     *
     * `gift`（0.7.5 起）：老设置文件里同样没有它，于是界面上出现「礼物 1」的计数、
     * 点进去却是「这一类还没有消息」——**计数在数全部消息、列表在按显示类型过滤**，
     * 两处口径不一致（用户 2026-10-08 截图反馈「只有送礼物的次数，没有地方看」）。
     *
     * 磁盘上的旧设置文件不会自己多出新类型，所以这里读进来时各补一刀。
     */
    if (Array.isArray(this.settings.kinds)) {
      const added = (['system', 'gift'] as const).filter((kind) => !this.settings.kinds.includes(kind))
      if (added.length > 0) {
        this.settings.kinds = [...this.settings.kinds, ...added]
        logger.info(`[douyin-link] 显示类型里补上 ${added.join('、')}（旧设置文件里没有这个类型）`)
      }
    }
    const rooms = await store.listRooms()
    for (const room of rooms) {
      this.states.set(room.webRid, this.createState(room))
    }
    logger.info(
      `[douyin-link] 分析中枢已就绪：库里 ${rooms.length} 个直播间（监控中 ${rooms.filter((room) => room.monitor).length} 个）` +
        `、并发上限 ${this.settings.monitorConcurrency}、` +
        (this.settings.retentionDays > 0
          ? `保留 ${this.settings.retentionDays} 天`
          : '消息永久保存（不自动清理）')
    )
    this.startTimers()
    void this.cleanup()
    void this.repairUserRowsOnce()
    void this.splitAnonymousOnce()
    void this.backfillNamesOnce()
    /**
     * 打开应用时**默认选中最近在监控的那个房间**：清单恢复了但一个都没选中的话，
     * 详情页是「先从左边选一个直播间」的空态——用户每次打开都要多点一下（而且我自己的
     * 真机验证也踩到过：重启后 CDP 抓不到任何面板，因为根本没选中房间）。
     *
     * 一个都没在监控（下播了、用户把开关关了）就退一步选**最近活跃过的房间**：
     * 用户 2026-10-08 反馈「下播后就看不见了」——数据都在库里，界面上总得先选中它才看得到。
     */
    if (!this.activeRoom) {
      const byActive = [...this.states.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      const candidate = byActive.find((state) => state.monitor) ?? byActive[0]
      if (candidate) this.activeRoom = candidate.webRid
    }
    if (this.settings.resumeOnStart) {
      // **开关开着 = 就在监控**：库里勾着监控的房间直接接着跑（用户 2026-10 明确要的行为）
      const wanted = [...this.states.values()].filter((state) => state.monitor).length
      if (wanted > 0) logger.info(`[douyin-link] 打开应用接着监控 ${wanted} 个房间（可在设置里关掉）`)
      this.reconcile()
    } else {
      // 不接着监控：那勾选也得跟着归零——**开关不许撒谎**。
      // 旧版这里只 emitRooms，于是「显示开着却没人跑」，用户得点两次开关才动。
      let cleared = 0
      for (const state of this.states.values()) {
        if (!state.monitor) continue
        state.monitor = false
        cleared += 1
        void store.setRoomMonitor(state.webRid, false)
      }
      if (cleared > 0) {
        logger.info(`[douyin-link] 打开应用不接着监控：已清掉 ${cleared} 个房间的监控勾选（开关如实显示为关）`)
      }
      this.emitRooms(true)
    }
  }

  /**
   * **工装用**：把一批消息直接喂进某个房间的记录器（跳过网络与采集器）。
   *
   * 为什么要有这个入口（`spike/anon-identity-check.mjs`）：匿名身份拆分这件事发生在
   * `applyItems` → `identifyBatch`（进 recorder 之前），只有走**真 hub** 才能验到
   * 「三个共用占位 id `111111` 的匿名用户各记各的」。房间不在库里就现场建一个空状态
   * （不落库、不连网、不出声）。
   */
  ingestItemsForTest(webRid: string, items: DanmakuItem[], users: UserInfo[] = [], roomEnded = false): void {
    const state = this.states.get(webRid) ?? this.createState({ webRid, addedAt: Date.now() })
    this.states.set(webRid, state)
    this.handleItems(state, items, users, roomEnded)
  }

  /** 工装用：立刻跑一次攒批落库（不等 2 秒那一拍） */
  async flushForTest(): Promise<void> {
    await this.flush()
  }

  /** 工装用：看一眼某个房间记录器里**本场**那份用户档案（排查「名字为什么没补上」） */
  debugProfileForTest(webRid: string, userId: string): { nickname: string } | null {
    const profile = this.states.get(webRid)?.recorder.profile(userId)
    return profile ? { nickname: profile.nickname } : null
  }

  /**
   * 工装用：把「空名字回填」那一步真跑一遍（`backfillNamesOnce` 是装载时 fire-and-forget 的私有方法，
   * 工装要能直接调它验证「清垃圾 + 回填真名 + 写标记」三件事）。
   */
  async backfillNamesForTest(): Promise<void> {
    await this.backfillNamesOnce()
  }

  /**
   * **补档案（跑一次）**：把 0.15.9 以前那个配额 bug 漏掉的历史档案行按消息流水补出来。
   *
   * 三个决定：
   * 1. **放在装载时、fire-and-forget**：补档案不该拖慢装载（界面上晚几秒看到档案没关系）；
   * 2. **只跑一次**（`users.repaired` 标记）：这是历史缺口，新数据现在由 recorder 正常写入，
   *    而全表聚合在永久保存的库上会越跑越贵；跑失败不写标记，下次启动再试；
   * 3. **不覆盖已有档案**：`repairUsersFromMessages` 是 `on conflict do nothing`，
   *    用户自己「清空用户记录」之后也不会被它偷偷补回来（清空会留下这个标记）。
   */
  private async repairUserRowsOnce(): Promise<void> {
    try {
      if ((await store.getMeta(USERS_REPAIRED_KEY)) === '1') return
      const startedAt = Date.now()
      const repaired = await store.repairUsersFromMessages('')
      await store.setMeta(USERS_REPAIRED_KEY, '1')
      logger.info(
        repaired > 0
          ? `[douyin-link] 补档案：按消息流水补回 ${repaired} 个用户的档案行（+${since(startedAt)}）`
          : `[douyin-link] 补档案：没有缺失的用户档案（+${since(startedAt)}）`
      )
      if (repaired > 0) {
        // 补出来的是**新行**：作废「库里累计量」缓存，让房间列表的「用户 N」跟着更新
        this.storeCache.at = 0
      }
    } catch (error) {
      logger.warn('[douyin-link] 补档案失败（下次启动会再试）:', describe(error))
    }
  }

  /**
   * **空名字回填（跑一次）**：把「消息行没名字、但我们档案里有」的历史行补上名字。
   *
   * 由来（2026-10-11 用户报障「神秘人七阶获取不了名称」）：补名字那条链以前只对**礼物类帧**生效，
   * 弹幕/进场帧没带名字时从来没查过库；再叠上「名字被当占位清掉」那个 bug，
   * 库里就留下一批「档案有名字、消息行空着」的历史行。运行期两处都已修，这份迁移补历史。
   *
   * 三个决定（照 `repairUserRowsOnce` 的口径）：
   * 1. **装载时 fire-and-forget**：全表回填不该拖慢装载；
   * 2. **只跑一次**（`messages.names-backfilled` 标记）：跑失败不写标记，下次启动再试；
   * 3. 补上名字会把房间列表的「用户 N / 消息数」口径带准，所以顺手作废两个缓存。
   */
  private async backfillNamesOnce(): Promise<void> {
    try {
      if ((await store.getMeta(NAMES_BACKFILLED_KEY)) === '1') return
      const startedAt = Date.now()
      /**
       * **顺序要紧**：先清历史垃圾名（`张**`/`秋***`），再按档案回填真名。
       * 反过来的话，那些垃圾名会先被「保存下来」当证据——它们本来就不该存在。
       */
      const cleared = await store.clearMaskNames()
      const filled = await store.backfillMessageNames()
      await store.setMeta(NAMES_BACKFILLED_KEY, '1')
      logger.info(
        `[douyin-link] 名字修复：清掉 ${cleared} 行历史打码名、按档案补回 ${filled} 行真名（+${since(startedAt)}）`
      )
      if (filled > 0 || cleared > 0) {
        this.storeCache.at = 0
        this.dbCache.at = 0
      }
    } catch (error) {
      logger.warn('[douyin-link] 名字修复失败（下次启动会再试）:', describe(error))
    }
  }

  /**
   * **匿名身份拆分（跑一次）**：把历史上堆在共用占位 id `111111` 上的匿名行按马甲分开。
   *
   * 由来（2026-10-12 用户报障「匿名用户，内容监控会重复，这么严重的 bug」）：抖音给所有
   * 隐藏身份的人发的 id 都是 `111111`，按 id 聚合的一切都把互不相干的匿名观众堆成一个人——
   * 档案弹窗的「互动统计」成了几个人头的合计、「历史弹幕」成了混合时间线，
   * 看上去就是同一个人把内容重复刷了一遍。新数据从这一版起按马甲分开，**旧数据靠这次重排**。
   *
   * 三个决定（照 `repairUserRowsOnce` 的口径）：
   * 1. **装载时 fire-and-forget**：重排几万行不该拖慢装载（界面上晚几秒看到正确的档案没关系）；
   * 2. **只跑一次**（`identity.anon-split` 标记）：跑失败不写标记，下次启动再试；
   * 3. 跑完之后**作废「库里累计量」缓存**：房间列表的「用户 N」在拆分后本来就该变大。
   */
  private async splitAnonymousOnce(): Promise<void> {
    try {
      if ((await store.getMeta(ANON_SPLIT_KEY)) === '1') return
      const startedAt = Date.now()
      const moved = await store.splitAnonymousIdentities()
      await store.setMeta(ANON_SPLIT_KEY, '1')
      logger.info(
        moved > 0
          ? `[douyin-link] 匿名身份拆分：按马甲重排了 ${moved} 行（原先是所有匿名用户共用一个 id，+${since(startedAt)}）`
          : `[douyin-link] 匿名身份拆分：没有需要重排的匿名行（+${since(startedAt)}）`
      )
      if (moved > 0) this.storeCache.at = 0
    } catch (error) {
      logger.warn('[douyin-link] 匿名身份拆分失败（下次启动会再试）:', describe(error))
    }
  }

  /** 插件停用/卸载：轮询、泵与定时器全收干净（不留后台请求） */
  dispose(): void {
    for (const state of this.states.values()) {
      this.stopRelive(state)
      this.stopState(state, 'pluginDisabled')
    }
    this.stopAudio()
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    if (this.summaryTimer) clearTimeout(this.summaryTimer)
    this.summaryTimer = null
    this.summaryWatch.clear()
    this.summaryDirty.clear()
    if (this.allTimer) clearTimeout(this.allTimer)
    this.allTimer = null
    this.allWatch = null
    this.allDirty = false
    this.pendingMessages.clear()
    this.pendingTicks.clear()
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    for (const timer of this.reliveTimers.values()) clearTimeout(timer)
    this.reliveTimers.clear()
    // 停用之后不留「正在探测」「最后一条消息」这类运行态（重新启用时 init 会重建）
    this.reliveProbing.clear()
    this.lastDataAt.clear()
    // 三份按登记推送的数据也一起清掉（重新启用时界面会重新登记）
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = null
    this.presenceWatch.clear()
    this.presenceDirty.clear()
    this.daysWatch.clear()
    this.daysDirty.clear()
    this.compareWatch = null
    this.compareDirty = false
    this.flushTimer = null
    this.cleanupTimer = null
    this.started = false
    avatarCache.dispose()
    // AI 画像的「正在生成」登记也清掉：插件停用后不该再拦住下一次生成
    disposePortrait()
    logger.info('[douyin-link] 分析中枢已停止（实时通道与音频泵都收掉了）')
  }

  /**
   * 收摊（应用退出前调用）：把**所有在跑的东西**停掉，但**保留**房间清单、设置与定时器
   * （宿主还有可能在同一个进程里重建界面，收得太狠会半死）。
   *
   * 这条路上没有窗口要关（实时通道是主进程纯 Node 直连推送 ws），
   * 收的是推送连接、音频泵与重试定时器。
   *
   * **异步并返回 Promise**（2026-10-09）：宿主在 before-quit 里会 `await` 这个返回值再退出，
   * 收干净之后再退，免得留下半死的连接。
   */
  async suspend(reason: string): Promise<void> {
    try {
      let collected = 0
      for (const state of this.states.values()) {
        if (state.roomSocket || state.sessionId) collected += 1
        this.stopRelive(state)
        this.stopState(state, reason)
      }
      for (const timer of this.retryTimers.values()) clearTimeout(timer)
      this.retryTimers.clear()
      for (const timer of this.reliveTimers.values()) clearTimeout(timer)
      this.reliveTimers.clear()
      this.stopAudio()
      logger.info(`[douyin-link] 已收摊（${reason}）：停掉 ${collected} 路实时采集与音频泵，房间清单与设置保持不变`)
      this.emitRooms(true)
    } catch (error) {
      // 退出钩子绝不能抛：宿主逐个 await 这些钩子，抛出去会把退出流程打断（关不掉窗口）
      logger.warn('[douyin-link] 收摊时出错（已忽略，继续退出）:', describe(error))
    }
  }

  getSettings(): LiveSettings {
    return { ...this.settings }
  }

  /** 改设置（ipc 负责落盘；会影响采集器的那部分走 applySettingsEffects） */
  updateSettings(patch: Partial<LiveSettings>): LiveSettings {
    const next: LiveSettings = { ...this.settings }
    if (patch.quality && (QUALITY_KEYS as string[]).includes(patch.quality)) next.quality = patch.quality
    if (typeof patch.audioOnConnect === 'boolean') next.audioOnConnect = patch.audioOnConnect
    if (typeof patch.volume === 'number' && Number.isFinite(patch.volume)) {
      next.volume = Math.min(1, Math.max(0, patch.volume))
    }
    if (typeof patch.maxItems === 'number' && Number.isFinite(patch.maxItems)) {
      next.maxItems = Math.min(1000, Math.max(50, Math.round(patch.maxItems)))
    }
    if (Array.isArray(patch.kinds)) next.kinds = patch.kinds
    if (typeof patch.autoScroll === 'boolean') next.autoScroll = patch.autoScroll
    if (typeof patch.douyinCookie === 'string') {
      // 上限只有一处（shared/cookie.ts）：真实登录态 cookie 约 6 KB，这里只防「粘贴了一大坨别的东西」。
      // 一旦真的截断，尾巴上丢的往往是 ttwid / odin_tt —— 必须留下日志，别让用户对着
      // 「填了却没内容」发呆（2026-10-10 的 4096 静默截断就是这么被发现的）。
      const cookie = clampCookie(patch.douyinCookie)
      if (cookie.truncated) {
        logger.warn(
          `[douyin-link] 登录态 Cookie 有 ${cookie.length} 字符，超过上限 ${COOKIE_MAX_LENGTH}，已截断：` +
            '被截掉的是尾部的字段（ttwid / odin_tt 之类），抖音可能因此不当它是有效会话，请确认粘贴的是完整的一行'
        )
      }
      next.douyinCookie = cookie.value
    }
    if (typeof patch.monitorConcurrency === 'number' && Number.isFinite(patch.monitorConcurrency)) {
      next.monitorConcurrency = Math.min(8, Math.max(1, Math.round(patch.monitorConcurrency)))
    }
    if (typeof patch.resumeOnStart === 'boolean') next.resumeOnStart = patch.resumeOnStart
    if (typeof patch.retentionDays === 'number' && Number.isFinite(patch.retentionDays)) {
      next.retentionDays = Math.min(365, Math.max(0, Math.round(patch.retentionDays)))
    }
    /**
     * 「AI 画像」用哪个模型：给 0/负数/空 = 清成「跟随宿主默认模型」。
     * 这里只做形状校验（正整数或 null），**不校验配置是否还存在**——那个判断在用的那一刻做
     * （见 main/portrait.ts 的 resolveProviderId），否则用户删掉一个供应商就会连带把设置改坏。
     */
    if ('portraitProviderId' in patch) {
      const value = patch.portraitProviderId
      next.portraitProviderId =
        typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
    }
    this.settings = next
    for (const state of this.states.values()) state.recorder.setCap(next.maxItems)
    return this.getSettings()
  }

  /** 设置里「影响正在跑的采集器/音频泵」的那部分变化（ipc 落盘后调用） */
  async applySettingsEffects(previous: LiveSettings): Promise<void> {
    if (previous.quality !== this.settings.quality && this.pump && this.audioRoom) {
      logger.info(`[douyin-link] 档位切到 ${this.settings.quality}，重启 ${this.audioRoom} 的音频泵`)
      const state = this.states.get(this.audioRoom)
      if (state) {
        this.restartAudio(state)
        this.emitRooms(true)
      }
    }
    if (previous.monitorConcurrency !== this.settings.monitorConcurrency) this.reconcile()
    // 登录态 Cookie 变了：重建在跑的实时连接（新 Cookie 必须带进新的握手，否则礼物授权不生效）
    if (previous.douyinCookie !== this.settings.douyinCookie) {
      let restarted = 0
      for (const state of this.states.values()) {
        if (!state.roomSocket) continue
        this.stopRoomSocket(state)
        this.startRoomSocket(state)
        restarted += 1
      }
      logger.info(
        `[douyin-link] 登录态 Cookie 已${this.settings.douyinCookie ? '更新' : '清空'}，重建 ${restarted} 路实时连接`
      )
    }
  }

  /* --------------------------------------------------------------- 快照 */

  async snapshot(): Promise<AnalyzerSnapshot> {
    const rooms = await this.buildRooms()
    const state = this.activeRoom ? this.states.get(this.activeRoom) : undefined
    return {
      rooms,
      activeRoom: this.activeRoom,
      audioRoom: this.audioRoom,
      settings: this.getSettings(),
      recent: state ? state.recorder.recent.slice(-this.settings.maxItems).reverse() : [],
      db: await this.databaseStats(),
      updatedAt: Date.now()
    }
  }

  private async buildRooms(): Promise<RoomRuntime[]> {
    const stores = await this.roomStores()
    const list = [...this.states.values()]
    // 顺序 = 加入时间倒序（新加的在上），**点选不改顺序**（用户反馈：点一下房间就跳到最上面，
    // 很迷惑）。选中态由左栏的高亮表达，位置不该动。也不能按 `lastActiveAt` 排——选中会刷新它，
    // 等于换个说法继续置顶。
    list.sort((a, b) => b.addedAt - a.addedAt)
    return list.map((state) => {
      const stored = stores.get(state.webRid) ?? { messages: 0, users: 0, sessions: 0 }
      return {
        webRid: state.webRid,
        title: state.info?.title || state.title,
        anchor: state.info?.anchor || state.anchor,
        cover: state.info?.cover || state.cover,
        onlineText: state.info?.onlineText || state.onlineText,
        status: state.status,
        note: state.note,
        monitor: state.monitor,
        phase: state.phase,
        failure: state.failure,
        danmaku: { ...state.danmaku },
        quality: state.quality,
        qualities: [...state.qualities],
        audio: this.audioRoom === state.webRid,
        sessionId: state.sessionId,
        counters: { ...state.recorder.counters },
        received: state.recorder.received,
        rate: state.recorder.rate,
        sessionUsers: state.recorder.users,
        stored: { ...stored },
        addedAt: state.addedAt,
        lastActiveAt: state.lastActiveAt,
        lastSeenAt: state.lastSeenAt
      } satisfies RoomRuntime
    })
  }

  private async roomStores(): Promise<Map<string, store.RoomStore>> {
    const now = Date.now()
    if (now - this.storeCache.at < STORE_CACHE_MS) return this.storeCache.data
    const data = await store.roomStores()
    this.storeCache = { at: now, data }
    return data
  }

  async databaseStats(): Promise<DbStats> {
    const now = Date.now()
    if (this.dbCache.data && now - this.dbCache.at < DB_STATS_CACHE_MS) return this.dbCache.data
    const data = await store.dbStats()
    this.dbCache = { at: now, data }
    return data
  }

  /* ---------------------------------------------------------- 房间增删改 */

  /** 加一个直播间（链接或房间号）：解析一次 → 落库 → 成为分析中的房间 */
  async addRoom(input: string): Promise<{ ok: boolean; webRid?: string; failure?: FailureInfo }> {
    const webRid = parseWebRid(input)
    if (!webRid) return { ok: false, failure: { code: 'badInput', detail: String(input ?? '').slice(0, 60) } }
    const startedAt = Date.now()
    try {
      const resolved = await withTimeout(resolveLiveRoom(`https://live.douyin.com/${webRid}`, this.settings.douyinCookie), RESOLVE_DEADLINE_MS, 'addRoom')
      const existing = this.states.get(webRid)
      const state = existing ?? this.createState({ webRid, addedAt: Date.now() })
      this.applyResolved(state, resolved)
      if (!existing) this.states.set(webRid, state)
      await store.upsertRoom(resolved.room)
      await store.touchRoom(webRid, { active: true, seen: true })
      state.lastActiveAt = Date.now()
      logger.info(
        `[douyin-link] 已加入直播间 ${webRid}《${resolved.room.title}》主播=${resolved.room.anchor} ` +
          `状态=${resolved.room.status}（${since(startedAt)}）`
      )
      this.activeRoom = webRid
      this.emitRooms(true)
      return { ok: true, webRid }
    } catch (error) {
      const failure: FailureInfo =
        error instanceof ResolveFailure
          ? { code: error.code, detail: error.detail || undefined }
          : { code: 'resolveFailed', detail: describe(error) }
      logger.warn('[douyin-link] 加入直播间失败:', failure.code, failure.detail ?? '')
      return { ok: false, failure }
    }
  }

  /** 移除一个房间（`purge` = 连它的历史数据一起删） */
  async removeRoom(webRid: string, purge = true): Promise<boolean> {
    const state = this.states.get(webRid)
    if (!state) return false
    this.stopRelive(state)
    this.stopState(state, 'removed')
    if (this.audioRoom === webRid) this.stopAudio()
    this.states.delete(webRid)
    if (this.activeRoom === webRid) this.activeRoom = ''
    if (purge) await store.forgetRoom(webRid)
    this.storeCache.at = 0
    this.dbCache.at = 0
    this.emitRooms(true)
    return true
  }

  /**
   * 导入数据之后：把库里的房间清单重新读进内存——新增的建运行态、已有的更新静态信息，
   * 并作废「库里累计量 / 库统计」缓存，最后推一次房间列表。
   *
   * 不自动连接：导入进来的房间 `monitor` 一律是 false（见 `importRooms`），
   * 用户要接着监控得自己打开开关——导入的是「记录」，不是「现在就去连它」。
   */
  async reloadRooms(): Promise<void> {
    const rooms = await store.listRooms()
    for (const room of rooms) {
      const state = this.states.get(room.webRid)
      if (!state) {
        this.states.set(room.webRid, this.createState(room))
        continue
      }
      state.roomId = room.roomId || state.roomId
      state.title = room.title || state.title
      state.anchor = room.anchor || state.anchor
      state.cover = room.cover || state.cover
      state.onlineText = room.onlineText || state.onlineText
      if (room.status !== 'unknown') state.status = room.status
      state.note = room.note
      state.monitor = room.monitor
      state.addedAt = room.addedAt || state.addedAt
      state.lastSeenAt = room.lastSeenAt || state.lastSeenAt
    }
    this.storeCache.at = 0
    this.dbCache.at = 0
    this.emitRooms(true)
  }

  /** 勾上/取消监控（queued 与并发上限都在 reconcile 里处理） */
  async setMonitor(webRid: string, on: boolean): Promise<boolean> {
    const state = this.states.get(webRid)
    if (!state) return false
    state.monitor = on
    // 关掉开关就把「等重新开播」的探测也收掉（探测定时器只在开关开着时才有意义）
    if (!on) this.stopRelive(state)
    await store.setRoomMonitor(webRid, on)
    if (on) {
      await store.touchRoom(webRid, { active: true })
      state.lastActiveAt = Date.now()
      // 监控谁就把分析焦点切到谁：用户点「开始监控」之后想看的就是它
      this.activeRoom = webRid
    }
    this.reconcile()
    return true
  }

  /** 全部开/关（一键） */
  async monitorAll(on: boolean): Promise<boolean> {
    for (const state of this.states.values()) {
      state.monitor = on
      await store.setRoomMonitor(state.webRid, on)
    }
    this.reconcile()
    return true
  }

  /** 选中某个房间做分析（音频跟着它走；这就是「音频只能切到最新的那个」） */
  async selectRoom(webRid: string): Promise<boolean> {
    const state = this.states.get(webRid)
    if (!state) return false
    this.activeRoom = webRid
    state.lastActiveAt = Date.now()
    await store.touchRoom(webRid, { active: true })
    if (this.audioRoom && this.audioRoom !== webRid) {
      await this.startAudio(webRid)
    }
    this.emitRooms(true)
    return true
  }

  /** 重新解析房间（标题/在线人数/开播状态/拉流地址） */
  async refreshRoom(webRid: string): Promise<boolean> {
    const state = this.states.get(webRid)
    if (!state) return false
    try {
      const resolved = await withTimeout(resolveLiveRoom(state.target, this.settings.douyinCookie), RESOLVE_DEADLINE_MS, 'refreshRoom')
      this.applyResolved(state, resolved)
      await store.upsertRoom(resolved.room)
      state.failure = null
      /**
       * 判据是「**有没有采集在跑**」，不是相位（2026-10-11 修）。
       *
       * 旧版两个分支都写成 `state.phase === 'ended' && ...`，于是相位一旦被别的回调改掉
       * （通道那边上报 retrying/error、并发满之后 reconcile 打上 queued），
       * 这一条路就**两个分支都不进**：定时器进来之前已经删掉了、也没有人再排新的 ——
       * 房间永久停摆：开关开着、没有任何采集、主播重开播也不再有人管（就是用户报的
       * 「断播后重新开播拉不起来、丢数据」）。真机实测：探测失败一次之后相位变 error，
       * 之后再没有任何「还没开播，继续等」，一整天都不回来。
       */
      if (state.monitor && !state.roomSocket && !state.startToken && resolved.room.status === 'ended') {
        // 没在播就如实显示「已下播 · 等开播」（探测失败过的房间也在这里被捋回来）
        state.phase = 'ended'
      }
      if (state.monitor && !state.roomSocket && !state.startToken) {
        if (resolved.room.status === 'live') {
          logger.info(`[douyin-link] ${webRid} 重新开播，自动拉起监听`)
          this.reconcile()
        } else {
          // 还是没开播：继续排队等着（下播期间开关一直是开的）
          logger.debug(`[douyin-link] ${webRid} 还没开播，继续等（每分钟探测一次）`)
        }
        /**
         * reconcile 之后还是没有人管它（并发满被排队 / 解析到还没开播 / 连开关都是刚打开的），
         * 就把下一次探测排上——**这一句是「等待链永远不会断」的保证**。
         * `scheduleRelive` 自己会判重（有定时器就不排），不会叠。
         */
        if (!state.roomSocket && !state.startToken) this.scheduleRelive(state)
      }
      this.emitRooms(true)
      return true
    } catch (error) {
      state.failure =
        error instanceof ResolveFailure
          ? { code: error.code, detail: error.detail || undefined }
          : { code: 'resolveFailed', detail: describe(error) }
      if (!state.roomSocket) {
        /**
         * 还在等开播的房间，探测失败只是「这一分钟没问到」，**不能**把相位改成错误：
         * 开关开着 = 还在等（界面「已下播 · 等开播」），失败明细走 `failure` 字段。
         * 相位一改，用户看到的就是「监控莫名其妙停了」。
         */
        state.phase = state.monitor && state.phase === 'ended' ? 'ended' : 'error'
      }
      // 失败也必须把下一次探测排上（旧版这里直接 return：探测失败一次 = 等待链从此断掉）
      if (state.monitor && !state.roomSocket && !state.startToken) this.scheduleRelive(state)
      this.emitRooms(true)
      return false
    }
  }

  /**
   * 下播之后**持续等它重新开播**：每 `RELIVE_PROBE_MS` 解析一次直播间。
   *
   * 用户 2026-10-08 的要求：「需要实现实时监听直播间，如果有重新开播需要拉起监听」。
   * 旧行为是收到下播消息就把监控开关**关掉**（`setRoomMonitor(false)`）——于是主播第二天
   * 再开播时，这个房间永远不会自己回来，用户看到的就是「监控莫名其妙停了」。
   *
   * 现在：下播只停采集器，**开关保持开着**，由一个每分钟一次的状态探测负责把监控拉起来
   * （探测复用 `refreshRoom` —— 也就是界面上「刷新信息」那一条路，行为一致、只有一处实现）。
   */
  private scheduleRelive(state: RoomState): void {
    if (!state.monitor || this.reliveTimers.has(state.webRid)) return
    this.reliveTimers.set(
      state.webRid,
      setTimeout(() => {
        this.reliveTimers.delete(state.webRid)
        if (!state.monitor) return
        if (this.states.get(state.webRid) !== state) return
        if (state.roomSocket) return
        /**
         * 探测期间打个标记（见 `watchMonitors`）：解析要一两秒，这期间「没有采集、也没有定时器」，
         * 看门狗别把同一件事又排一遍 —— 否则等待期的探测频率会翻倍。
         */
        this.reliveProbing.add(state.webRid)
        void this.refreshRoom(state.webRid).finally(() => this.reliveProbing.delete(state.webRid))
      }, RELIVE_PROBE_MS)
    )
  }

  /** 停止「等重新开播」的探测（关开关、删房间、插件停用时都要收掉） */
  private stopRelive(state: RoomState): void {
    const timer = this.reliveTimers.get(state.webRid)
    if (timer) clearTimeout(timer)
    this.reliveTimers.delete(state.webRid)
  }

  /** 备注（自由文本，存在库里） */
  async noteRoom(webRid: string, note: string): Promise<boolean> {
    const state = this.states.get(webRid)
    if (!state) return false
    state.note = note.slice(0, 200)
    await store.setRoomNote(webRid, state.note)
    this.emitRooms(true)
    return true
  }

  /* --------------------------------------------------------------- 音频 */

  /**
   * 开始推音频（默认给「分析中的房间」）。
   *
   * **全局只响一个房间**：已经有别的房间在响就先把它停掉——这就是
   * 「音频只能切到最新的那个，其他房间只监听」的落点。
   */
  async startAudio(webRid?: string): Promise<boolean> {
    const target = String(webRid ?? this.activeRoom ?? '').trim()
    const state = target ? this.states.get(target) : undefined
    if (!state) {
      this.emitAudio({ type: 'status', webRid: target, phase: 'error', failure: { code: 'notConnected' } })
      return false
    }
    if (this.audioRoom && this.audioRoom !== state.webRid) {
      logger.info(`[douyin-link] 音频切到 ${state.webRid}（${this.audioRoom} 转为只监听）`)
      this.stopPump()
    }
    this.activeRoom = state.webRid
    if (this.pump && this.audioRoom === state.webRid) return true

    // 拉流地址可能还没有（房间从没解析过、或地址过期）：现解析一次
    const quality = this.pickQuality(state)
    let url = state.streams[quality] ?? ''
    if (!url) {
      try {
        const resolved = await withTimeout(resolveLiveRoom(state.target, this.settings.douyinCookie), RESOLVE_DEADLINE_MS, 'startAudio')
        this.applyResolved(state, resolved)
        await store.upsertRoom(resolved.room)
        url = state.streams[this.pickQuality(state)] ?? ''
      } catch (error) {
        state.failure = { code: 'resolveFailed', detail: describe(error) }
        this.emitRooms(true)
        this.emitAudio({
          type: 'status',
          webRid: state.webRid,
          phase: 'error',
          failure: { code: error instanceof ResolveFailure ? error.code : 'resolveFailed' }
        })
        return false
      }
    }
    if (!url) {
      this.emitAudio({ type: 'status', webRid: state.webRid, phase: 'error', failure: { code: 'noAudioStream' } })
      return false
    }
    this.audioRoom = state.webRid
    state.sourceUrl = url
    state.quality = this.pickQuality(state)
    this.startPump(state)
    logger.info(`[douyin-link] 开始推送音频：${state.webRid}（档位 ${state.quality}）`)
    this.emitRooms(true)
    return true
  }

  stopAudio(): boolean {
    if (this.audioRoom) logger.info(`[douyin-link] 停止推送音频：${this.audioRoom}`)
    const room = this.audioRoom
    this.stopPump()
    if (room) this.emitAudio({ type: 'status', webRid: room, phase: 'idle', failure: null })
    this.emitRooms(true)
    return true
  }

  private restartAudio(state: RoomState): void {
    this.stopPump()
    this.audioRoom = state.webRid
    this.startPump(state)
  }

  private startPump(state: RoomState): void {
    const pump = new AudioPump({
      onStatus: (phase, failure) => {
        if (phase === 'error') {
          logger.warn(`[douyin-link] 音频流失败（${state.webRid}）:`, failure?.code, failure?.detail ?? '')
        }
        this.emitAudio({ type: 'status', webRid: state.webRid, phase, failure })
      },
      onConfig: (config) => this.emitAudio({ type: 'config', webRid: state.webRid, config }),
      onFrames: (frames) => {
        this.audioSeq += 1
        this.emitAudio({ type: 'frames', webRid: state.webRid, seq: this.audioSeq, frames })
      }
    })
    this.pump = pump
    pump.start(state.sourceUrl || null, async () => {
      // 地址过期时重解析（签名带 t=）；**不改界面状态**，音频自己换地址即可
      logger.info(`[douyin-link] 重新解析音频地址（${state.webRid}）`)
      const resolved = await resolveLiveRoom(state.target, this.settings.douyinCookie)
      this.applyResolved(state, resolved)
      const url = state.streams[this.pickQuality(state)] ?? ''
      if (!url) throw new ResolveFailure('enterFailed', 'no flv url')
      state.sourceUrl = url
      return url
    })
  }

  private stopPump(): void {
    if (this.pump) {
      this.pump.stop()
      this.pump = null
    }
    const state = this.audioRoom ? this.states.get(this.audioRoom) : undefined
    if (state) state.sourceUrl = ''
    this.audioRoom = ''
  }

  private pickQuality(state: RoomState): QualityKey {
    const preferred = this.settings.quality
    if (state.streams[preferred]) return preferred
    for (const key of QUALITY_KEYS) if (state.streams[key]) return key
    return preferred
  }

  /* ------------------------------------------------------- 监控调度 */

  /** 按「期望监控」与并发上限，把该跑的跑起来、该停的停掉、超出的排队 */
  reconcile(): void {
    const wanted = [...this.states.values()].filter((state) => state.monitor)
    wanted.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    const cap = this.settings.monitorConcurrency
    const running = wanted.filter((state) => state.roomSocket).length
    let slots = Math.max(0, cap - running)

    for (const state of wanted) {
      if (state.roomSocket) {
        // 正在跑的：相位由实时通道回调驱动，只在它还没上报过状态时给个「连接中」
        if (state.phase === 'off' || state.phase === 'queued') state.phase = 'connecting'
        continue
      }
      // 正在启动中的也算「已经有人管了」：少这一条，解析那 1 秒里的第二次 reconcile
      // 就会给同一个房间起第二个采集通道 → 每条弹幕推两次（见 RoomState.startToken）
      if (state.startToken) continue
      if (slots > 0) {
        slots -= 1
        void this.startMonitor(state)
      } else {
        state.phase = 'queued'
        state.failure = null
      }
    }
    for (const state of this.states.values()) {
      if (!state.monitor && state.roomSocket) this.stopState(state, 'stopped')
      else if (!state.monitor && state.phase !== 'off') {
        state.phase = 'off'
        state.failure = null
        state.danmaku = idleDanmaku()
      }
    }
    this.emitRooms(true)
  }

  private async startMonitor(state: RoomState): Promise<void> {
    if (state.roomSocket || state.startToken || this.states.get(state.webRid) !== state) return
    const token = (this.startSeq += 1)
    state.startToken = token
    /**
     * 每个 `await` 之后都问一次「还能不能继续」：令牌没被换掉、房间还在清单里、
     * 而且用户没把开关关掉。解析与开会话都可能要一两秒，这期间用户完全可能取消监控
     * 或把房间删掉——那种情况下**绝不能**再把采集器装上去（否则关掉的房间会自己跑起来）。
     */
    const alive = (): boolean =>
      state.startToken === token && state.monitor && this.states.get(state.webRid) === state
    state.phase = 'resolving'
    state.failure = null
    this.emitRooms(true)
    const startedAt = Date.now()
    try {
      const resolved = await withTimeout(resolveLiveRoom(state.target, this.settings.douyinCookie), RESOLVE_DEADLINE_MS, 'startMonitor')
      if (!alive()) return
      this.applyResolved(state, resolved)
      await store.upsertRoom(resolved.room)
      if (!alive()) return
      await store.touchRoom(state.webRid, { active: true, seen: true })
      if (!alive()) return
      if (resolved.room.status === 'ended') {
        state.phase = 'ended'
        state.sessionId = 0
        logger.info(`[douyin-link] ${state.webRid} 当前没在直播，暂停采集并等它开播（开关保持开着）`)
        // 开关没关就排队等重新开播：主播开播后最多一分钟就会自动开始监控
        this.scheduleRelive(state)
        this.emitRooms(true)
        return
      }
      const sessionId = await store.openSession(state.webRid)
      if (!alive()) {
        // 会话已经开出来了但这次启动被取消了：关掉它，别在库里留一条空会话
        void store.closeSession(sessionId, 0, 'aborted')
        return
      }
      state.sessionId = sessionId
      state.recorder.begin(sessionId, this.settings.maxItems)
      // `begin()` 清掉了收礼人推断的上下文，这里立刻把已知的主播灌回去（见 recorder.setAnchor）
      state.recorder.setAnchor(state.anchorUser)
      this.markDaysDirty(state.webRid)
      state.danmaku = { phase: 'connecting', failure: null, since: Date.now(), received: 0 }
      state.phase = 'connecting'
      logger.info(
        `[douyin-link] 开始监控 ${state.webRid}《${state.title}》` +
          `${state.voice ? '（语音聊天室：会跟着麦位表）' : ''}（${since(startedAt)}）`
      )
      this.startRoomSocket(state)
      this.emitRooms(true)
    } catch (error) {
      if (!alive()) return
      const failure: FailureInfo =
        error instanceof ResolveFailure
          ? { code: error.code, detail: error.detail || undefined }
          : { code: 'connectFailed', detail: describe(error) }
      state.phase = 'error'
      state.failure = failure
      logger.warn(`[douyin-link] 监控 ${state.webRid} 启动失败:`, failure.code, failure.detail ?? '')
      this.scheduleRetry(state)
      this.emitRooms(true)
    } finally {
      // 令牌一定要还回去：否则这个房间从此再也起不来（reconcile 会一直跳过它）
      if (state.startToken === token) state.startToken = 0
    }
  }

  private stopState(state: RoomState, reason: string): void {
    // 让进行中的启动立刻失效（见 RoomState.startToken）：它会在下一个 await 处退出
    state.startToken = 0
    const hadSocket = Boolean(state.roomSocket)
    this.stopRoomSocket(state)
    // 没在跑了，就别再拿旧的「最后一条消息时刻」判相位（见 watchMonitors）
    this.lastDataAt.delete(state.webRid)
    const timer = this.retryTimers.get(state.webRid)
    if (timer) {
      clearTimeout(timer)
      this.retryTimers.delete(state.webRid)
    }
    if (hadSocket) logger.info(`[douyin-link] 停止监控 ${state.webRid}（${reason}）`)
    if (state.sessionId) {
      const id = state.sessionId
      const messages = state.recorder.received
      state.sessionId = 0
      void store.closeSession(id, messages, reason)
      // 会话开/关都会改变「今天那一条」的场次数
      this.markDaysDirty(state.webRid)
    }
    state.phase = 'off'
    state.danmaku = idleDanmaku()
    state.failure = null
  }

  /**
   * 实时通道：主进程**纯 Node 直连**抖音推送 ws（离线签名 + 心跳 + ACK，无需浏览器），
   * 收逐条消息（弹幕/进场/点赞/关注/人数/麦位）整批上报。**这是唯一的采集通道**。
   */
  private startRoomSocket(state: RoomState): void {
    if (state.roomSocket) return
    // 新通道的「宽限期」从这里算（见 watchMonitors）：刚连上还没来消息不算废
    this.lastDataAt.set(state.webRid, Date.now())
    const socket = new DirectPushCapture(
      { webRid: state.webRid, roomId: state.roomId, cookie: mergeCookieHeaders(this.settings.douyinCookie, state.cookie) },
      {
        onItems: (items, users, meta) => this.handleItems(state, items, users, meta.roomEnded),
        onMic: (userIds) => this.handleMic(state, userIds),
        onStatus: (status) => this.handleChannelStatus(state, status.phase, status.failure)
      }
    )
    state.roomSocket = socket
    socket.start()
  }

  /** 停掉实时通道（采集就此停止；重启由 reconcile / scheduleRetry 负责） */
  private stopRoomSocket(state: RoomState): void {
    const socket = state.roomSocket
    state.roomSocket = null
    if (socket) socket.stop()
  }

  /** 掉线自动重试（监控是长期的，中断要自己爬起来） */
  private scheduleRetry(state: RoomState): void {
    if (!state.monitor || this.retryTimers.has(state.webRid)) return
    if (state.attempts >= RETRY_LIMIT) {
      /**
       * 密集重连到上限就**换成慢探测**，不许直接放弃（2026-10-11 修）。
       *
       * 旧版这里只打一条 warn 就 return，而调用它的两条路上 `state.roomSocket` 可能还是那个
       * 已经死掉的采集器：`reconcile` 看 `roomSocket` 非空会一直跳过这个房间，
       * `scheduleRelive` 的回调也因为它非空而直接返回 —— 于是「开关开着、界面显示错误、
       * 主播再开播也不会有人管」，一停就是一整晚（真机日志：连续 12 次重试用尽后再无任何动作）。
       */
      logger.warn(
        `[douyin-link] ${state.webRid} 重试 ${state.attempts} 次仍未成功，改为每分钟探测一次（不再密集重连）`
      )
      this.stopRoomSocket(state)
      this.scheduleRelive(state)
      return
    }
    state.attempts += 1
    /**
     * **风控验证页（`resolving`）退让得更久**（2026-10-11 真机踩到）：
     * 这个状态下抖音已经把这个 IP 挡在验证码后面了，25 秒一次的密集重连只会让它更不高兴，
     * 而密集重试的额度（`RETRY_LIMIT` 次）几分钟就用光，之后就只剩每分钟探测。
     * 所以这一类直接用 2 分钟起步、并随次数线性拉长（最多 10 分钟），等用户去过验证码或风控自己解除。
     */
    const challenged = state.failure?.code === 'resolving'
    const delay = challenged ? Math.min(120_000 * state.attempts, 600_000) : RETRY_DELAY_MS
    if (challenged) {
      logger.warn(
        `[douyin-link] ${state.webRid} 被抖音的验证码挡着，${Math.round(delay / 1000)}s 后再试` +
          `（用浏览器打开一次 live.douyin.com 过掉验证码会立刻恢复）`
      )
    }
    this.retryTimers.set(
      state.webRid,
      setTimeout(() => {
        this.retryTimers.delete(state.webRid)
        if (!state.monitor) return
        if (this.states.get(state.webRid) !== state) return
        this.stopRoomSocket(state)
        this.reconcile()
      }, delay)
    )
  }

  /* --------------------------------------------------------- 采集回调 */

  private handleItems(state: RoomState, items: DanmakuItem[], infoList: UserInfo[], roomEnded: boolean): void {
    if (items.length === 0 && infoList.length === 0) return
    /**
     * 帧里没带名字的消息要补名字：`item.user` 是空串或占位名（`匿名` / 打码名）时，
     * **先看本场见过的人，再查我们自己的库**（见 `resolveMissingNames`）。
     *
     * 两类都走这条路：
     * - 点歌/礼物帧里根本没有发送者的 `User`，只有单号串里的 id；
     * - **弹幕/进场帧偶尔只给 id、名字是空的**（2026-10-11 用户报障「神秘人获取不了名称」：
     *   库里这个人明明有档案（昵称=神秘人七阶、抖音号、粉丝数都在），弹幕行却写着空名字）。
     */
    const unnamed = items.filter((item) => item.userId && !isUsableNickname(item.user))
    if (unnamed.length === 0) {
      this.applyItems(state, items, infoList, roomEnded)
      return
    }
    /**
     * 补昵称要查库（异步），所以这一批不能立刻吃进去；**按房间串起来**保证先后顺序——
     * 否则慢的那一批会被后到的批次抢先，弹幕流的顺序就乱了。
     */
    const previous = this.ingestChain.get(state.webRid) ?? Promise.resolve()
    const next = previous.then(async () => {
      try {
        /**
         * ⚠️ 这里的三个参数名**不能叫 `users`**（2026-10-11 踩到）：`DanmakuItem` 自己也有一个
         * `users` 字段（这一帧里带出来的用户数组），`recorder.ingest(items, users)` 的第二参是
         * **用户静态信息**。之前这里传的是 `applyItems` 的 `items`（元素带 `users` 字段），
         * TypeScript 的 `UserInfo[]` 只约束 `id`，结构上「也像」，于是编译期一声不响，
         * 运行期 `frameUsers` 里全是 `info.nickname === undefined` —— 名字补了个空。
         */
        const extra = await this.resolveMissingNames(state, unnamed, infoList)
        this.applyItems(state, items, extra.length > 0 ? [...infoList, ...extra] : infoList, roomEnded)
      } catch (error) {
        logger.warn(`[douyin-link] ${state.webRid} 处理这一批消息失败:`, describe(error))
        this.applyItems(state, items, infoList, roomEnded)
      }
    })
    this.ingestChain.set(state.webRid, next.catch(() => undefined))
  }

  /**
   * **把「匿名」的人按马甲分开**（2026-10-12 修：用户报障「匿名用户，内容监控会重复」）。
   *
   * 抖音给所有隐藏身份的人发的 `id` 都是 `111111`，于是按 id 聚合的一切都会把互不相干的
   * 匿名观众堆成一个人：档案「互动统计」成了几个人头的合计、库里累计变成十几条弹幕，
   * 「历史弹幕」把几个马甲名说过的话排成一条时间线——看上去就是同一个人把内容重复刷了一遍。
   *
   * 这里在**进 recorder 之前**把 id 换成 `anon:<占位 id>#<马甲>`（见 `shared/anonymous.ts`），
   * 于是一条链路全都跟着分开：内存档案、消息流水、用户统计、分钟桶、在场清单、榜单、历史查询。
   * 名字补到了真名（这个人以前露过面）就退回他的真 id，同一帧里的 `users` 也要跟着换，
   * 否则档案会写到两个身份上。
   */
  private identifyBatch(state: RoomState, items: DanmakuItem[], users: UserInfo[]): { items: DanmakuItem[]; users: UserInfo[] } {
    const identityOf = new Map<string, string>()
    const usersOut: UserInfo[] = []
    /**
     * **名字该不该清掉，看的是「这个 id 是不是占位」，不是「这个名字像不像匿名」**
     * （2026-10-11 修的，就是「神秘人七阶」这个报障）：
     * - id 是共用占位 `111111` / 合成键 → 名字是马甲或打码名，清掉（见 `isAnonymousName`）；
     * - **id 是真的**（`99740023199` 这种）→ 名字就是这个人**真实的昵称**，
     *   「神秘人七阶」「匿名」这些是抖音允许用户自己起的名字，**一个字都不能动**。
     *
     * 之前这里无条件调用 `displayNickname()`，于是 id 是真的、昵称叫「神秘人七阶」的用户
     * 在落库前被清成了空名字——库里档案写着名字、弹幕行却是空的。
     */
    const nameFor = (item: DanmakuItem, key: string): string =>
      isAnonymousId(key) ? displayNickname(item.user) : String(item.user ?? '').trim()
    for (const info of users) {
      if (!info.id) continue
      const key = this.anonymousKeyOf(state.webRid, info.id, info)
      identityOf.set(info.id, key)
      /**
       * 连马甲都没有（残缺帧 / 记不下来的通用打码名）：**认不出人**，那就不建档案——
       * 建出来的一行会把好几个人合成一个（正是用户报障的那种「重复」）。
       */
      if (!this.identifiedAnonymously(info.id, info)) continue
      usersOut.push({ ...info, id: key, displayId: displayDisplayId(info.displayId) })
    }
    const seen = new Set<string>()
    const itemsOut: DanmakuItem[] = []
    for (const item of items) {
      if (!item.userId) {
        itemsOut.push({ ...item, user: displayNickname(item.user) })
        continue
      }
      const key = identityOf.get(item.userId) ?? this.anonymousKeyOf(state.webRid, item.userId, { nickname: item.user })
      itemsOut.push({ ...item, userId: key, user: nameFor(item, key) })
      // 帧里没带 `User` 的那条（点歌 / 只有裸 id 的礼物）：身份是从 id 推出来的，
      // 这一批若没有它的档案就补一份只有昵称的，否则名字就丢了
      if (!identityOf.has(item.userId) && !seen.has(key)) {
        seen.add(key)
        const name = displayNickname(item.user)
        if (name && this.identifiedAnonymously(item.userId, { nickname: item.user })) {
          usersOut.push({
            id: key,
            displayId: '',
            nickname: name,
            gender: 0,
            signature: '',
            city: '',
            avatar: '',
            following: 0,
            follower: 0,
            honorLevel: 0,
            fansClubLevel: 0,
            badges: [],
            secUid: ''
          })
        }
      }
    }
    return { items: itemsOut, users: usersOut }
  }

  /**
   * 一个「匿名帧」该记到哪把身份键上。
   *
   * 三种情况（2026-10-12 真机实测后定的口径，见 `spike/anon-live-probe.mjs`）：
   * 1. **认得出马甲**（`dou2056511` 这种带数字的马甲名）→ 按马甲分开，各记各的；
   * 2. **通用打码名 / 认不出**（`秋***`、空名）→ **一个房间一个「匿名观众」桶**：
   *    按房间分开（绝不跨房间并成一个人），房间内合成一个「匿名观众」条目。
   *    为什么不是「每条消息一个身份」（统计会爆成几千行）、也不是直接丢掉
   *    （用户看到的次数就比真实发生的少）：一个房间一个未知桶是唯一既诚实又稳定的口径。
   * 3. 普通人 → 原样。
   */
  private anonymousKeyOf(
    webRid: string,
    id: string,
    source: {
      nickname?: string | null
      displayId?: string | null
      secUid?: string | null
      honorLevel?: number | null
      fansClubLevel?: number | null
    }
  ): string {
    const identified = anonymousUserId(id, source)
    /** 打码名（`秋***`）：马甲名不是身份 → 归到本房间的未知桶 */
    if (identified && !isGenericMaskName(source.nickname)) return identified
    return `${ANON_ID_PREFIX}${anonymousBaseId(id)}#room:${webRid || 'unknown'}`
  }

  /** 这一帧**够不够**给这个人建一份档案行（认不出的人只进消息流水，不建档案） */
  private identifiedAnonymously(
    id: string,
    source: {
      nickname?: string | null
      displayId?: string | null
      secUid?: string | null
      honorLevel?: number | null
      fansClubLevel?: number | null
    }
  ): boolean {
    if (!anonymousUserId(id, source)) return false
    return !isGenericMaskName(source.nickname)
  }

  /**
   * 给「帧里没带名字」的消息补昵称：**先本场见过的人，再查库**（跨会话留下的档案）。
   *
   * 为什么必须有这一步：
   * - **点歌/礼物帧**里没有发送者的 `User`，只有点歌单号串里的 id，而送礼的人通常不在本场说过话
   *   （`userMap` 里没有），但他多半在进场消息或房间榜里露过面、库里也留着上一轮的档案；
   * - **弹幕/进场帧偶尔只给 id、名字是空的**（2026-10-11 用户报障「神秘人获取不了名称」）：
   *   库里这个人明明有档案、有抖音号有粉丝数，弹幕行却是空名字——名字本来就在我们自己库里，
   *   只是以前只在礼物那一类上做补名，别的消息类型从来没查过。
   *
   * **匿名送礼**（帧里给的是空串或「☞ 匿名 -」）走同一条路：这些占位名不算名字
   * （`isUsableNickname`），于是这个人只要在房间里露过面，我们就能把马甲脱掉、直接显示真名。
   */
  private async resolveMissingNames(state: RoomState, items: DanmakuItem[], users: UserInfo[]): Promise<UserInfo[]> {
    const found: UserInfo[] = []
    const missing: string[] = []
    /**
     * **帧自己的 `users` 就是第一手资料**（2026-10-11 修）：以前这里只看 recorder 里的本场档案，
     * 而「这个人第一次出现」时那份档案**还没建**——于是帧里明明带着 `User`（昵称/等级/粉丝都有），
     * 这一批却被塞进 `users=[]` 交给 recorder，弹幕行落库就成了空名字
     * （真机表现：库里档案写着「神秘人七阶」，弹幕行却只有 id）。
     */
    const frameUsers = new Map<string, UserInfo>()
    for (const info of users) if (info.id && info.nickname) frameUsers.set(info.id, info)

    /**
     * 一个 item 现在能拿到的**最好名字**（帧 > 本场档案；查库那一轮在此之前已经先跑过）。
     *
     * 判据是 `isUsableNickname`（占位名/打码名不算），**不是** `isAnonymousName`——
     * 后者回答的是「他是不是隐藏了身份」，而叫「神秘人七阶」的人名字是真实的
     * （2026-10-11 就是这两者混用，把名字清成了空串）。
     */
    const bestName = (item: DanmakuItem): string => {
      const fromFrame = frameUsers.get(item.userId)?.nickname
      if (isUsableNickname(fromFrame)) return String(fromFrame).trim()
      const fromSession = state.recorder.profile(item.userId)?.nickname
      if (isUsableNickname(fromSession)) return String(fromSession).trim()
      return ''
    }
    /**
     * 补名的主循环：**空名和打码名都要补**（`isUsableNickname` 判「这名字能不能指向人」），
     * 补不到就先记 id、等查库那一轮。
     */
    for (const item of items) {
      if (item.user && isUsableNickname(item.user)) continue
      const name = bestName(item)
      if (name) {
        item.user = name
        continue
      }
      if (!missing.includes(item.userId)) missing.push(item.userId)
    }
    if (missing.length === 0) return found
    try {
      const rows = await store.getUsers(state.webRid, missing)
      for (const item of items) {
        /** 已经有真名字的不用动；空名/占位名（含打码名）才补 */
        if (item.user && isUsableNickname(item.user)) continue
        const row = rows.get(item.userId)
        if (!row?.nickname || !isUsableNickname(row.nickname)) continue
        item.user = row.nickname
        if (found.some((entry) => entry.id === row.userId)) continue
        found.push({
          id: row.userId,
          displayId: row.displayId,
          nickname: row.nickname,
          gender: row.gender,
          signature: row.signature,
          city: row.city,
          avatar: row.avatar,
          following: row.following,
          follower: row.follower,
          honorLevel: row.honorLevel,
          fansClubLevel: row.fansClubLevel,
          badges: row.badges,
          secUid: row.secUid
        })
      }
    } catch (error) {
      // 查库失败不该让这一批消息消失：宁可先记 id，下一条再补名字
      logger.warn(`[douyin-link] ${state.webRid} 补昵称失败:`, describe(error))
    }
    /**
     * 最后一轮兜底：**凡是这一批里还空着名字、而我们知道他叫什么**的，都补上
     * （帧里带来的 `User`、本场档案、刚查到的库档案三者都算）。
     */
    for (const item of items) {
      if (item.user) continue
      const name = frameUsers.get(item.userId)?.nickname ?? state.recorder.profile(item.userId)?.nickname
      if (isUsableNickname(name)) item.user = String(name).trim()
    }
    return found
  }

  /**
   * 「名字空的礼物行」在这里现形：**所有礼物行都要经过 `applyItems`**，所以它是唯一可靠的哨点。
   *
   * 为什么必须有它（2026-10-08 实战）：用户库里出现过一条 `content='' / to_user_name='ok绷.ఇ'` 的行，
   * 而各解码器自己的诊断日志一条都没打——光看代码和日志推不出是哪条路写的。
   * 这里把 `trace`（哪个解码器）、通道（ws / HTTP）、以及这条行的关键字段一次记全，
   * 下一行「礼物名未知」出现时，日志里就能直接看到凶手。
   */
  private noteEmptyGifts(state: RoomState, items: DanmakuItem[]): void {
    if (this.emptyGiftLogged >= EMPTY_GIFT_LOG_LIMIT) return
    for (const item of items) {
      if (item.kind !== 'gift' || item.text) continue
      if (this.emptyGiftLogged >= EMPTY_GIFT_LOG_LIMIT) return
      this.emptyGiftLogged += 1
      logger.warn(
        `[douyin-link][gift-empty] trace=${item.trace ?? '(未标)'} channel=ws` +
          ` user=${item.user || '(空)'}/${item.userId || '(空)'} to=${item.toUser || '(空)'}/${item.toUserId || '(空)'}` +
          ` count=${item.count} diamonds=${item.diamonds} at=${new Date(item.at).toISOString()}`
      )
    }
  }

  /** 把一批消息真正吃进去（计数/落库/推界面）；送礼人昵称补好之后由 `handleItems` 调这里 */
  private applyItems(state: RoomState, items: DanmakuItem[], users: UserInfo[], roomEnded: boolean): void {
    /**
     * 有业务消息 = 这条通道真的还在采集（看门狗按它判废，见 `watchMonitors`）。
     * 空帧/心跳不算：真机上下播之后那条连接还在推空帧，正是被它骗过去的。
     */
    this.lastDataAt.set(state.webRid, Date.now())
    // 有人发言/进场 → 在线观众那份表要跟着变（界面没开这个页签就不记）
    this.markPresenceDirty(state.webRid)
    /**
     * **匿名的人在这里按马甲分开**（见 `identifyBatch`）——必须在 `ingest` 之前，
     * 因为「这个人的档案/统计/在场/分钟桶」全部按 `userId` 聚合。
     */
    const identified = this.identifyBatch(state, items, users)
    this.noteEmptyGifts(state, identified.items)
    const touched = state.recorder.ingest(identified.items, identified.users, this.settings.maxItems)
    if (touched.length > 0) this.queueUsers(state, touched)
    items = identified.items
    users = identified.users

    if (items.length > 0) {
      state.danmaku = {
        ...state.danmaku,
        phase: 'live',
        failure: null,
        received: state.danmaku.received + items.length
      }
      state.phase = 'live'
      state.attempts = 0
      // **攒着推，不逐帧推**：弹幕一秒可能几十帧，逐帧往界面广播（还顺手带一份心跳）
      // 会把渲染层的 React 更新与主进程的 IPC 都排满——宿主自己的流式输出（助手回复）
      // 就是被这么挤停的（用户实测：「监控一开，对话输出卡到一半不动」）。
      const buffer = this.pendingMessages.get(state.webRid) ?? []
      buffer.push(...items)
      this.pendingMessages.set(
        state.webRid,
        buffer.length > MESSAGES_BUFFER_CAP ? buffer.slice(-MESSAGES_BUFFER_CAP) : buffer
      )
      this.pendingTicks.set(state.webRid, {
        webRid: state.webRid,
        counters: { ...state.recorder.counters },
        received: state.recorder.received,
        rate: state.recorder.rate,
        sessionUsers: state.recorder.users
      })
      this.schedulePush()
    }

    if (roomEnded) {
      state.status = 'ended'
      state.info = state.info ? { ...state.info, status: 'ended' } : null
      /**
       * 下播：停采集器，但**监控开关保持开着**，交给 `scheduleRelive` 每分钟探一次，
       * 主播再开播时自动拉起来（用户 2026-10-08：「如果有重新开播需要拉起监听」）。
       */
      logger.info(`[douyin-link] ${state.webRid} 收到下播消息，停止采集但保持监听（开播后自动拉起）`)
      this.stopState(state, 'ended')
      state.phase = 'ended'
      this.scheduleRelive(state)
    }
    this.roomsDirty = true
  }

  /** 实时通道上报的相位 → 房间相位 / 失败提示（并驱动掉线重试） */
  private handleChannelStatus(state: RoomState, phase: DanmakuStatus['phase'], failure: FailureInfo | null): void {
    const changed = phase !== state.danmaku.phase
    const since = changed ? Date.now() : state.danmaku.since
    state.danmaku = { ...state.danmaku, phase, failure, since }
    if (phase === 'live') {
      state.phase = 'live'
      state.failure = null
      state.attempts = 0
    } else if (phase === 'error') {
      state.phase = 'error'
      state.failure = failure
      this.scheduleRetry(state)
    } else if (phase === 'retrying') {
      state.phase = 'retrying'
      state.failure = failure
    } else if (phase === 'connecting' && state.phase !== 'live') {
      state.phase = 'connecting'
    }
    if (changed) {
      const detail = failure ? `（${failure.code}${failure.detail ? ': ' + failure.detail : ''}）` : ''
      logger.info(`[douyin-link] ${state.webRid} 实时通道：${phase}${detail}`)
    }
    // 对比表里带着相位/错误，相位变了就该重算（界面没在看对比页签就不记）
    this.markCompareDirty()
    this.roomsDirty = true
    this.pushRoomsThrottled()
  }

  /**
   * 麦位表变了（聊天室的 `RoomLinkmicMicDisplayInfoSyncData`）。
   *
   * 麦上的人是语音聊天室最核心的一群人，所以这份表直接进「本场」分析：界面的在线观众面板
   * 会把麦上一列置顶（按麦位序）。
   * 这份同步是**全量快照**（不是增量），所以每次整份替换——留着旧的会让下麦的人永远在麦上。
   */
  private handleMic(state: RoomState, userIds: string[]): void {
    // 麦位同步也是业务消息（语音房掉线时它同样会停，见 watchMonitors）
    this.lastDataAt.set(state.webRid, Date.now())
    // 麦位是「在线观众」表里置顶的那一列：变了就推一份
    this.markPresenceDirty(state.webRid)
    const before = state.recorder.micList()
    const changed =
      before.length !== userIds.length ||
      before.some((item, index) => item.userId !== userIds[index])
    state.recorder.setMicUsers(userIds)
    state.voice = true
    if (changed) {
      logger.info(`[douyin-link] ${state.webRid} 麦位更新：${userIds.length} 人在麦上`)
      this.roomsDirty = true
      this.pushRoomsThrottled(true)
    }
  }

  private queueUsers(state: RoomState, touched: string[]): void {
    const force = touched.length > 0 && Date.now() - this.usersPushAt >= USERS_PUSH_THROTTLE_MS
    if (!force) return
    const changed = state.recorder.takeTouched(120)
    if (changed.length === 0) return
    this.usersPushAt = Date.now()
    this.pendingUsers.push({ webRid: state.webRid, users: changed })
    for (const batch of this.pendingUsers) this.broadcast(USERS_EVENT, batch)
    this.pendingUsers = []
  }

  /* --------------------------------------------------------- 定时任务 */

  private startTimers(): void {
    if (this.started) return
    this.started = true
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS)
    this.cleanupTimer = setInterval(() => void this.cleanup(), CLEANUP_INTERVAL_MS)
  }

  /** 攒批落库：消息流水 / 分钟桶 / 用户统计（三类增量一次 flush 写完） */
  private async flush(): Promise<void> {
    // 每 2 秒看一眼「开关开着的房间是不是真的有人在管」（见 watchMonitors）
    this.watchMonitors()
    let flushed = false
    for (const state of this.states.values()) {
      const recorder = state.recorder
      const messages = recorder.takeMessages()
      const minutes = recorder.takeMinutes()
      const users = recorder.takeUserDeltas()
      if (messages.length === 0 && minutes.length === 0 && users.length === 0) continue
      try {
        await store.insertMessages(messages)
        await store.bumpMinutes(minutes)
        await store.upsertUserDeltas(users)
        // 这一批的礼物抖币进「今日消费」账本（实时列表行首要显示，见 userBadges）
        this.noteTodaySpend(messages)
        this.addFlushedDeltas(state, messages)
        // 此刻数据才真正在库里：概览要看到的就是这一份，标脏让实时推送重算
        this.markSummaryDirty(state.webRid)
        // 这三个房间的「每日记录」也会跟着变（今天那一行的计数是活的）；对比表同理
        this.markDaysDirty(state.webRid)
        this.markCompareDirty()
        flushed = true
      } catch (error) {
        logger.warn(`[douyin-link] ${state.webRid} 落库失败（这批增量会丢）:`, describe(error))
      }
      // 每写完一个房间就让出事件循环一拍：宿主自己的 IPC 与流式输出（助手回复）要能插进来。
      // PGlite 跑在宿主进程里，连着几个 await 不让步就会把别人的输出挤停。
      await yieldToLoop()
    }
    // 全局分析（数据大屏）是**跨房**聚合，与具体哪个房间无关：整批落库之后再标一次脏即可
    if (flushed) this.markAllDirty()
    this.pushRoomsThrottled(true)
    void this.refreshRoomsLight()
  }

  /**
   * 轻刷新（`ROOM_REFRESH_MS` 一次）：只打 enter（没 Cookie 的房间才回落到抓一次页面）。
   *
   * **不限于监控中的房间**（0.6.0 用户实测反馈「在线观众页签全是 0」）：
   * `voice` / 房间成员名单 / 主播档案都是「解析之后才有」的运行态；房间不在监控时如果从不解析，
   * 面板就只能显示「普通直播间 + 全 0」，而这跟「解析过了但确实没人」在界面上一模一样。
   * 所以对所有**知道 roomId 的房间**都轻刷（一次 GET，很便宜，骨架是页面自己也会打的接口）。
   *
   * 麦位与本场活跃仍然只有监控跑起来才有——那是推送里的东西，没有推送就没有，
   * 界面上会把这件事说清楚（见 PresencePanel）。
   */
  private async refreshRoomsLight(): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    try {
      const now = Date.now()
      for (const state of this.states.values()) {
        if (!state.roomId) continue
        // 正在启动监控（startMonitor 里那次解析还在跑）：让那条路去填，别重复抓一遍
        if (state.startToken) continue
        // 监控中的房间刷得勤（在线人数/成员名单在动），没监控的只求「面板有房间级数据」：
        // 半小时一次，既不让面板空着，也不为闲置房间每 5 分钟抓一次页面。
        const interval = state.roomSocket ? ROOM_REFRESH_MS : IDLE_REFRESH_MS
        if (now - state.refreshedAt < interval) continue
        // 先记时刻再请求：失败也要等下一个周期，不要变成每 2 秒一次的请求风暴
        state.refreshedAt = now
        try {
          if (state.cookie) {
            const entered = await enterLiveRoom(
              state.webRid,
              state.roomId,
              mergeCookieHeaders(this.settings.douyinCookie, state.cookie)
            )
            this.applyResolved(state, {
              room: entered.room,
              flv: entered.flv,
              cookie: state.cookie,
              roomUserIds: entered.roomUserIds,
              anchorUser: entered.anchorUser
            })
            await store.upsertRoom(entered.room)
          } else {
            // 还没有进房 Cookie（这个房间从没解析过 / 库里的房间刚恢复）：完整解析一次
            const resolved = await withTimeout(resolveLiveRoom(state.target, this.settings.douyinCookie), RESOLVE_DEADLINE_MS, 'refreshLight')
            this.applyResolved(state, resolved)
            await store.upsertRoom(resolved.room)
          }
          this.roomsDirty = true
        } catch (error) {
          logger.warn(`[douyin-link] ${state.webRid} 房间信息轻刷新失败:`, describe(error))
        }
        await yieldToLoop()
      }
      if (this.roomsDirty) this.pushRoomsThrottled(true)
    } finally {
      this.refreshing = false
    }
  }

  /**
   * **看门狗**（每 2 秒跟着 `flush` 跑一次）：开关开着的房间，必须真的有人在管它。
   *
   * 为什么必须有它（2026-10-11 用户反馈「断播后重新开播拉不起来、丢监控数据」）：
   * 那两个故障都不是「某一次操作失败」，而是**状态机里走进去就出不来的死角**：
   *
   * 1. **通道活着、其实早废了**：主播下播时推送 ws 常常既不推下播帧、也不断开，只是不再有业务
   *    消息（真机日志里那条「实时通道推送过的消息：（一条都没有）」挂了 7 个多小时）。
   *    `state.roomSocket` 非空 → `reconcile` 认为它在跑、`scheduleRelive` 的回调直接返回，
   *    主播重开播之后**永远**收不到东西，界面还一直显示「直播中」——数据就是这么丢的。
   *    这里按「多久没有一条业务消息」判废：到点就把这条连接收掉、重新解析一次
   *    （房间重开后抖音给的**内部房间号会变**，不重新解析连不上新房间）。
   * 2. **没有采集、也没有任何定时器**：探测失败、重试用尽、并发满被排队，都可能留下
   *    「开关开着但没人管」的房间（旧版一次探测失败就永久停摆）。这里补一次开播探测，
   *    保证等待链永远不断——`reconcile` 那边只要有一个并发位空出来就会被叫醒。
   *
   * 两条都以「监控开关」为准：开关关着就什么都不做（用户的意图优先）。
   */
  private watchMonitors(): void {
    const now = Date.now()
    for (const state of this.states.values()) {
      if (!state.monitor) continue
      if (state.roomSocket) {
        const last = this.lastDataAt.get(state.webRid)
        if (last === undefined) {
          this.lastDataAt.set(state.webRid, now)
          continue
        }
        if (now - last < STALL_MS) continue
        const minutes = Math.max(1, Math.round((now - last) / 60000))
        logger.warn(
          `[douyin-link] ${state.webRid} 实时通道 ${minutes} 分钟没有任何消息（多半是下播后重开、` +
            '这条连接已经废了），重新解析并重连'
        )
        // 先把时刻顶掉：重连本身也要一两秒，别让下一次 flush 又触发一遍
        this.lastDataAt.set(state.webRid, now)
        this.stopState(state, 'stalled')
        this.reconcile()
        continue
      }
      if (state.startToken) continue
      if (this.retryTimers.has(state.webRid)) continue
      if (this.reliveTimers.has(state.webRid)) continue
      if (this.reliveProbing.has(state.webRid)) continue
      logger.warn(
        `[douyin-link] ${state.webRid} 监控开着却没有任何采集在跑（相位 ${state.phase}），重新排一次开播探测`
      )
      this.scheduleRelive(state)
    }
  }

  /** 按保留期清旧数据（启动与每 6 小时一次） */
  async cleanup(): Promise<number> {
    const days = this.settings.retentionDays
    if (days <= 0) return 0
    try {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
      const removed = await store.deleteMessagesBefore(cutoff)
      await store.deleteMinutesBefore(minuteOf(cutoff))
      if (removed > 0) {
        logger.info(`[douyin-link] 保留期清理：删掉 ${removed} 条超过 ${days} 天的消息`)
        this.storeCache.at = 0
        this.dbCache.at = 0
      }
      return removed
    } catch (error) {
      logger.warn('[douyin-link] 保留期清理失败:', describe(error))
      return 0
    }
  }

  /**
   * 落库之后**不能**把「库里累计量」缓存整份作废（旧版就是 `storeCache.at = 0`）。
   *
   * 后果：下一次房间列表推送（≤1 秒一次）会重跑三条**全表聚合**——
   * messages `count(*)`、users `count(*)`、sessions `count(*)`。
   * 这些查询跑在宿主的 PGlite 上，房间一多就是每秒几轮全表扫描，宿主自己的写入与
   * 助手流式输出会被卡住（用户实测：「监控一开，对话输出卡到一半不动」）。
   *
   * 现在只把刚写进去的增量加到缓存上；users / sessions 这种「不能简单相加」的量
   * 交给 STORE_CACHE_MS 的 TTL 去刷（累计量晚几秒看到没关系，界面上的「本场」数字走心跳）。
   */
  private addFlushedDeltas(state: RoomState, rows: MessageRow[]): void {
    const cached = this.storeCache.data.get(state.webRid)
    if (!cached || rows.length === 0) return
    cached.messages += rows.length
  }

  private pushRoomsThrottled(force = false): void {
    if (!force && Date.now() - this.roomsPushedAt < ROOMS_PUSH_THROTTLE_MS) {
      this.roomsDirty = true
      return
    }
    this.emitRooms(force)
  }

  /** 推房间列表（异步，因为要带库里的累计量；节流由调用方保证） */
  private emitRooms(force = false): void {
    this.roomsPushedAt = Date.now()
    this.roomsDirty = false
    void this.buildRooms()
      .then((rooms) => {
        this.broadcast(ROOMS_EVENT, { rooms, activeRoom: this.activeRoom, audioRoom: this.audioRoom })
      })
      .catch((error) => logger.warn('[douyin-link] 推房间列表失败:', describe(error)))
  }

  private emitAudio(message: AudioMessage): void {
    this.broadcast(AUDIO_EVENT, message)
  }

  /**
   * 事件只发给**界面窗口**（宿主的主窗口）。
   *
   * 0.6.0 起插件自己不再建窗口，所以这里不需要再挑「哪个窗口是采集用的」——
   * 隐藏窗口那套（`window-guard.ts`）随主进程直连一起删掉了。
   */
  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      safeSend(win.webContents, channel, payload)
    }
  }

  /** 安排一次合批推送（已经安排过就不重复安排） */
  private schedulePush(): void {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => this.flushPush(), PUSH_INTERVAL_MS)
  }

  /** 把攒下的弹幕与心跳一次推给界面 */
  private flushPush(): void {
    this.pushTimer = null
    for (const [webRid, items] of this.pendingMessages) {
      if (items.length === 0) continue
      const batch: MessageBatch = { webRid, items }
      this.broadcast(MESSAGES_EVENT, batch)
    }
    this.pendingMessages.clear()
    for (const tick of this.pendingTicks.values()) this.broadcast(TICKS_EVENT, tick)
    this.pendingTicks.clear()
  }

  /* --------------------------------------------------------- 概览实时推送 */

  /**
   * 登记「界面正在看的概览窗口」（`range` 不给 = 最近 `minutes` 分钟）。
   *
   * 界面每次调 `room-summary` 都会顺带登记（见 ipc.ts），所以窗口跟着界面走：
   * 切时间进度条 / 换预设窗口都只是再登记一次。只有登记过的房间才会被实时推送。
   */
  watchSummary(webRid: string, minutes: number, range?: { from: number; to: number }): void {
    if (!webRid) return
    this.summaryWatch.set(webRid, { minutes, range })
  }

  /** 界面不再看这个房间的概览（切房间 / 卸载）：停掉它的实时推送 */
  unwatchSummary(webRid: string): void {
    if (!webRid) return
    this.summaryWatch.delete(webRid)
    this.summaryDirty.delete(webRid)
  }

  /** 有数据落库 → 概览该重算（没人在看这个房间就不记） */
  private markSummaryDirty(webRid: string): void {
    if (!this.summaryWatch.has(webRid)) return
    this.summaryDirty.add(webRid)
    this.scheduleSummaryPush()
  }

  /** 安排一次概览推送（已经安排过就不重复安排；正在算就等它结束后自查） */
  private scheduleSummaryPush(): void {
    if (this.summaryTimer || this.summaryPushing) return
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = null
      void this.pushSummaries()
    }, SUMMARY_PUSH_MS)
  }

  /**
   * 把脏房间的概览按各自登记的窗口重算并推给界面。
   *
   * **串行 + 只算一个时刻**：`summary()` 是一组聚合查询（还跑在宿主的 PGlite 上），
   * 并发叠几份只会跟宿主的流式输出抢资源；同一时刻只算一轮，算完还有欠账再安排下一轮。
   */
  private async pushSummaries(): Promise<void> {
    if (this.summaryPushing || this.summaryDirty.size === 0) return
    this.summaryPushing = true
    const batch = [...this.summaryDirty]
    this.summaryDirty.clear()
    const now = Date.now()
    try {
      for (const webRid of batch) {
        const watch = this.summaryWatch.get(webRid)
        if (!watch) continue
        // 历史区间（右端早于现在）不会再落进新数据，重算也是同一份，跳过
        if (watch.range && watch.range.to < now - SUMMARY_LIVE_GRACE_MS) continue
        try {
          const summary = await this.summary(webRid, watch.minutes, watch.range)
          const sessions = await this.sessions(webRid, 5)
          this.broadcast(SUMMARY_EVENT, { webRid, summary, sessions } satisfies SummaryPush)
        } catch (error) {
          logger.warn(`[douyin-link] ${webRid} 概览推送失败:`, describe(error))
        }
        await yieldToLoop()
      }
    } finally {
      this.summaryPushing = false
      if (this.summaryDirty.size > 0) this.scheduleSummaryPush()
    }
  }

  /* --------------------------------------------------- 观众 / 对比 / 每日记录推送 */

  /**
   * 登记「界面正在看这个房间的在线观众」。之后数据变了就推 `PRESENCE_EVENT`。
   * 语义与 `watchSummary` 一致：界面每次查都顺带登记（切房间 = 换登记）。
   */
  watchPresence(webRid: string): void {
    if (!webRid) return
    this.presenceWatch.set(webRid, true)
  }

  /** 界面不再看这个房间的在线观众（切房间 / 关页签 / 卸载） */
  unwatchPresence(webRid: string): void {
    if (!webRid) return
    this.presenceWatch.delete(webRid)
    this.presenceDirty.delete(webRid)
  }

  /** 登记「界面正在看这个房间的每日记录」（`limit` 跟着界面要的条数走） */
  watchDays(webRid: string, limit = 90): void {
    if (!webRid) return
    this.daysWatch.set(webRid, Math.min(Math.max(1, Math.round(limit)), 400))
  }

  unwatchDays(webRid: string): void {
    if (!webRid) return
    this.daysWatch.delete(webRid)
    this.daysDirty.delete(webRid)
  }

  /** 登记「界面正在看这个窗口的房间对比」（切窗口 = 换登记，会立刻重算一份推回去） */
  watchCompare(minutes: number): void {
    const next = Math.min(Math.max(5, Math.round(minutes)), 1440)
    const changed = this.compareWatch !== next
    this.compareWatch = next
    if (changed) {
      this.compareDirty = true
      this.scheduleWatchPush()
    }
  }

  unwatchCompare(): void {
    this.compareWatch = null
    this.compareDirty = false
  }

  /** 在线观众的数据变了（发言/进场/麦位/成员名单）：标脏，按节流推 */
  private markPresenceDirty(webRid: string): void {
    if (!this.presenceWatch.has(webRid)) return
    this.presenceDirty.add(webRid)
    this.scheduleWatchPush()
  }

  /** 这一个房间的当日记录该更新了（落库 / 开会话 / 关会话） */
  private markDaysDirty(webRid: string): void {
    if (!this.daysWatch.has(webRid)) return
    this.daysDirty.add(webRid)
    this.scheduleWatchPush()
  }

  /** 有数据落库 / 相位变了 → 对比表要重算（没人在看就不记） */
  private markCompareDirty(): void {
    if (this.compareWatch === null) return
    this.compareDirty = true
    this.scheduleWatchPush()
  }

  private scheduleWatchPush(): void {
    if (this.watchTimer || this.watchPushing) return
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null
      void this.pushWatches()
    }, WATCH_PUSH_MS)
  }

  /**
   * 把这三份「界面登记过的」数据重算并推回去。
   *
   * **串行 + 单飞**（同 `pushSummaries`）：每份都要查库/合成，叠几轮只会跟宿主的流式输出抢资源。
   * 算完还有欠账就再排一轮（数据在不断进来时会持续跟随，但每轮间隔不小于 `WATCH_PUSH_MS`）。
   */
  private async pushWatches(): Promise<void> {
    if (this.watchPushing) return
    this.watchPushing = true
    try {
      const presence = [...this.presenceDirty]
      this.presenceDirty.clear()
      for (const webRid of presence) {
        if (!this.presenceWatch.has(webRid)) continue
        try {
          const snapshot = await this.presence(webRid)
          this.broadcast(PRESENCE_EVENT, { webRid, snapshot } satisfies PresencePush)
        } catch (error) {
          logger.warn(`[douyin-link] ${webRid} 观众推送失败:`, describe(error))
        }
        await yieldToLoop()
      }

      const days = [...this.daysDirty]
      this.daysDirty.clear()
      for (const webRid of days) {
        const limit = this.daysWatch.get(webRid)
        if (limit === undefined) continue
        try {
          const rows = await this.dayRecords(webRid, limit)
          this.broadcast(DAYS_EVENT, { webRid, days: rows } satisfies DaysPush)
        } catch (error) {
          logger.warn(`[douyin-link] ${webRid} 每日记录推送失败:`, describe(error))
        }
        await yieldToLoop()
      }

      if (this.compareDirty && this.compareWatch !== null) {
        this.compareDirty = false
        const minutes = this.compareWatch
        try {
          const rows = await this.compare(minutes)
          this.broadcast(COMPARE_EVENT, { minutes, rows } satisfies ComparePush)
        } catch (error) {
          logger.warn('[douyin-link] 房间对比推送失败:', describe(error))
        }
      }
    } finally {
      this.watchPushing = false
      if (this.presenceDirty.size > 0 || this.daysDirty.size > 0 || this.compareDirty) this.scheduleWatchPush()
    }
  }

  /* --------------------------------------------------- 全局分析（数据大屏） */

  /** 登记：界面正在看全局分析（数据大屏的全局页签）。之后落库会按这个窗口实时推回。 */
  watchAllAnalysis(minutes: number, range?: { from: number; to: number }): void {
    this.allWatch = { minutes, range }
  }

  /** 界面不再看全局分析（切回单房间模式 / 卸载）：停掉它的实时推送 */
  unwatchAllAnalysis(): void {
    this.allWatch = null
    this.allDirty = false
  }

  /** 有数据落库 → 全局分析该重算（没人在看就不记） */
  private markAllDirty(): void {
    if (!this.allWatch) return
    this.allDirty = true
    this.scheduleAllPush()
  }

  /** 安排一次全局推送（已经安排过就不重复安排；正在算就等它结束后自查） */
  private scheduleAllPush(): void {
    if (this.allTimer || this.allPushing) return
    this.allTimer = setTimeout(() => {
      this.allTimer = null
      void this.pushAllAnalyses()
    }, ALL_PUSH_MS)
  }

  /** 把全局分析按界面登记的窗口重算并推给界面（串行 + 单飞，避免叠几轮跨房聚合） */
  private async pushAllAnalyses(): Promise<void> {
    const watch = this.allWatch
    if (this.allPushing || !this.allDirty || !watch) {
      this.allDirty = false
      return
    }
    this.allDirty = false
    // 历史区间（右端早于现在）不会再落进新数据，重算也是同一份，跳过
    if (watch.range && watch.range.to < Date.now() - SUMMARY_LIVE_GRACE_MS) return
    this.allPushing = true
    try {
      const analysis = await this.allRoomsAnalysis(watch.minutes, watch.range)
      this.broadcast(ALL_EVENT, { analysis } satisfies AllAnalysisPush)
    } catch (error) {
      logger.warn('[douyin-link] 全局分析推送失败:', describe(error))
    } finally {
      this.allPushing = false
      if (this.allDirty) this.scheduleAllPush()
    }
  }

  /**
   * 跨直播间聚合分析（数据大屏的「全局分析」页签的数据源）。
   *
   * 口径与 `summary` / `compare` 一致，只是把「所有房间」合起来：
   * - 全局 KPI / 趋势是各房间窗口聚合的**合计**（趋势按分钟跨房相加、补空并分桶）；
   * - 全局人数单独用 `activeUsersAll`（按 userId 去重，跨房出现的同一个人只算一次）；
   * - 两张按人的礼物榜**跨房合并**（同一个人一行）；`perRoom` 是每房间的流水横截面。
   */
  async allRoomsAnalysis(windowMinutes = 60, range?: { from: number; to: number }): Promise<AllRoomsAnalysis> {
    const requested = Math.round(windowMinutes)
    const toMs = range ? Math.max(1, Math.round(range.to)) : Date.now()
    const fromMs = range
      ? Math.max(0, Math.round(range.from))
      : requested > 0
        ? toMs - Math.min(Math.max(5, requested), 1440) * 60000
        : 0
    const all = !range && !(requested > 0)
    /**
     * 窗口分钟数：**给了区间就按区间算**（数据大屏现在是日期区间，跨天也对），
     * 否则按请求的预设窗口。它同时是平均速率的分母与「活跃分钟 / 窗口分钟」的分母，
     * 所以不能再用请求里那个可能为 0 的 `windowMinutes` 兜（否则一整天的区间会被当成 5 分钟）。
     */
    const minutes = all
      ? 0
      : range
        ? Math.max(1, Math.round((toMs - fromMs) / 60000))
        : Math.min(Math.max(5, requested), 1440)

    // 每房间横截面（口径同 compare）+ 活跃分钟；内存态的房间清单补全标题 / 相位 / 声音
    const aggregates = await store.windowAggregates(fromMs, toMs)
    const active = await store.activeMinutes(minuteOf(fromMs), minuteOf(toMs))
    const stores = await this.roomStores()
    const perRoom: RoomCompareRow[] = []
    let messages = 0
    let chat = 0
    let member = 0
    let like = 0
    let social = 0
    let gift = 0
    let diamonds = 0
    for (const state of this.states.values()) {
      const base = aggregates.get(state.webRid)
      const stored = stores.get(state.webRid)
      const row: RoomCompareRow = base ?? {
        webRid: state.webRid,
        title: '',
        anchor: '',
        status: 'unknown',
        phase: 'off',
        audio: false,
        activeMinutes: 0,
        windowMinutes: minutes,
        messages: 0,
        chat: 0,
        member: 0,
        like: 0,
        social: 0,
        gift: 0,
        diamonds: 0,
        users: 0,
        perMinute: 0,
        totalMessages: 0
      }
      const merged: RoomCompareRow = {
        ...row,
        title: state.info?.title || state.title,
        anchor: state.info?.anchor || state.anchor,
        status: state.status,
        phase: state.phase,
        audio: this.audioRoom === state.webRid,
        activeMinutes: active.get(state.webRid) ?? 0,
        windowMinutes: minutes,
        perMinute: minutes > 0 ? Math.round((row.messages / minutes) * 10) / 10 : 0,
        totalMessages: stored?.messages ?? row.messages
      }
      perRoom.push(merged)
      messages += merged.messages
      chat += merged.chat
      member += merged.member
      like += merged.like
      social += merged.social
      gift += merged.gift
      diamonds += merged.diamonds
    }
    perRoom.sort((a, b) => b.messages - a.messages)

    /**
     * 全局趋势：跨房按分钟相加、补齐缺口并分桶（最多 240 个点）。
     * `all` 模式下起点取库里最早一条的分钟（`databaseStats` 有 15s 缓存，不会每次都查）。
     */
    const startMinute = all ? minuteOf((await this.databaseStats()).firstMessageAt || toMs) : minuteOf(fromMs)
    /**
     * 趋势的右端**不越过「现在」**：数据大屏默认的区间是「今天 00:00 → 24:00」（右端在未来，
     * 这样主进程的实时推送不会被当成历史区间跳过），但趋势图不该在「现在」之后画一条 0 值的长尾。
     * 历史区间（右端在过去）不受影响，`min` 取到的就是它自己。
     */
    const endMinute = Math.min(minuteOf(toMs), minuteOf(Date.now()))
    const rawSeries = await store.minuteSeriesAll(startMinute, endMinute)
    const step = Math.max(1, Math.ceil((endMinute - startMinute + 1) / 240))
    const buckets = new Map<number, (typeof rawSeries)[number]>()
    for (const row of rawSeries) {
      const key = startMinute + Math.floor((row.minute - startMinute) / step) * step
      const bucket = buckets.get(key)
      if (!bucket) buckets.set(key, { ...row, minute: key })
      else {
        bucket.chat += row.chat
        bucket.member += row.member
        bucket.likes += row.likes
        bucket.social += row.social
        bucket.gift += row.gift
      }
    }
    const series: AllRoomsAnalysis['series'] = []
    for (let minute = startMinute; minute <= endMinute; minute += step) {
      const row = buckets.get(minute)
      series.push({
        minute: minute * 60000,
        chat: row?.chat ?? 0,
        member: row?.member ?? 0,
        like: row?.likes ?? 0,
        social: row?.social ?? 0,
        gift: row?.gift ?? 0
      })
    }
    const firstAt = rawSeries.length > 0 ? rawSeries[0].minute * 60000 : 0
    const lastAt = rawSeries.length > 0 ? rawSeries[rawSeries.length - 1].minute * 60000 + 59999 : 0

    /**
     * 每个直播间各自的分钟序列（数据大屏「指标」页签）：与上面的全局趋势**同一套分桶口径**
     * （同一个 `startMinute` / `endMinute` / `step`），只是保留房间维度，渲染层才能画
     * 「动态排序柱状图 / 日内走势 / 按小时分布」这类**房间之间横向比**的图。
     *
     * 只收「窗口内有过礼物」的房间——没礼物的房间在这几张图上是空的，留进去只是白占位、白推；
     * 再按窗口抖币降序取前 `ROOM_SERIES_CAP` 个，避免房间特别多时负载无量级地涨。
     */
    const perRoomMinutes = await store.minuteSeriesPerRoom(startMinute, endMinute)
    const roomSeries: RoomSeriesRow[] = []
    for (const state of this.states.values()) {
      const rows = perRoomMinutes.get(state.webRid)
      if (!rows || rows.length === 0) continue
      const bucketMap = new Map<number, { diamonds: number; gift: number; chat: number }>()
      for (const row of rows) {
        const key = startMinute + Math.floor((row.minute - startMinute) / step) * step
        const bucket = bucketMap.get(key)
        if (!bucket) bucketMap.set(key, { diamonds: row.diamonds, gift: row.gift, chat: row.chat })
        else {
          bucket.diamonds += row.diamonds
          bucket.gift += row.gift
          bucket.chat += row.chat
        }
      }
      let total = 0
      let hasGift = false
      const series: RoomSeriesRow['series'] = []
      for (let minute = startMinute; minute <= endMinute; minute += step) {
        const bucket = bucketMap.get(minute)
        const diamonds = bucket?.diamonds ?? 0
        const gift = bucket?.gift ?? 0
        if (diamonds > 0 || gift > 0) hasGift = true
        total += diamonds
        series.push({ minute: minute * 60000, diamonds, gift, chat: bucket?.chat ?? 0 })
      }
      if (!hasGift) continue
      roomSeries.push({
        webRid: state.webRid,
        title: state.info?.title || state.title,
        anchor: state.info?.anchor || state.anchor,
        status: state.status,
        phase: state.phase,
        series
      })
    }
    roomSeries.sort((a, b) => sumDiamonds(b) - sumDiamonds(a))
    if (roomSeries.length > ROOM_SERIES_CAP) roomSeries.length = ROOM_SERIES_CAP

    // 榜单/礼物榜跨房合并（seat 在全局没有意义，恒 0）
    const sent = (await store.giftRankByPersonAll('sender', fromMs, toMs, 50)).map((row) => ({ ...row, seat: 0 }))
    const received = (await store.giftRankByPersonAll('recipient', fromMs, toMs, 50)).map((row) => ({
      ...row,
      seat: 0
    }))
    const gifts = await store.giftBreakdownAll(fromMs, toMs, 40)
    const users = await store.activeUsersAll(fromMs, toMs)
    let liveRooms = 0
    for (const state of this.states.values()) if (state.status === 'live') liveRooms += 1

    return {
      minutes,
      windowMinutes: minutes,
      rooms: this.states.size,
      liveRooms,
      messages,
      chat,
      member,
      like,
      social,
      gift,
      diamonds,
      users,
      firstAt,
      lastAt,
      series,
      sent,
      received,
      gifts,
      perRoom,
      roomSeries
    }
  }

  /* --------------------------------------------------------- 分析查询 */

  /**
   * 概览：窗口内的 KPI + 分钟序列（补齐缺口）+ 类型分布 + 三份礼物聚合。
   *
   * 两种口径：
   * - `windowMinutes > 0`：最近 N 分钟（`windowMinutes <= 0` 也走「全部」，见下）；
   * - **`range` 给了就按它**（`from` → `to`，毫秒）：左侧「每日记录」点某一天、或时间进度条
   *   拖出一段，都是走这条路——这样「点一天看那一天的详情」和「拖动选一段时间」共用同一个查询。
   * - `windowMinutes <= 0`（且没给 range）= **全部**（库里最早一条到现在）。用户要「永久存储」，
   *   那也得能一眼看到全部——固定窗口会把更早的礼物从榜上抹掉，看着就像「礼物不断消失」。
   * 序列按跨度合并成粗桶（最多 240 个点），不然一周就是上万个点。
   */
  async summary(
    webRid: string,
    windowMinutes = 60,
    range?: { from: number; to: number }
  ): Promise<RoomSummary> {
    const requested = Math.round(windowMinutes)
    const all = !range && !(requested > 0)
    const minutes = all ? 0 : Math.min(Math.max(5, requested), 1440)
    const toMs = range ? Math.max(1, Math.round(range.to)) : Date.now()
    const fromMs = range ? Math.max(0, Math.round(range.from)) : all ? 0 : toMs - minutes * 60000
    const { totals, messages } = await store.windowTotals(webRid, fromMs, toMs)
    const breakdown = await store.kindBreakdown(webRid, fromMs, toMs)
    const startMinute = all ? minuteOf(breakdown.firstAt > 0 ? breakdown.firstAt : toMs) : minuteOf(fromMs)
    const endMinute = minuteOf(toMs)
    const rows = await store.minuteSeries(webRid, startMinute, endMinute)
    const step = Math.max(1, Math.ceil((endMinute - startMinute + 1) / 240))
    const buckets = new Map<number, (typeof rows)[number]>()
    for (const row of rows) {
      const key = startMinute + Math.floor((row.minute - startMinute) / step) * step
      const bucket = buckets.get(key)
      if (!bucket) buckets.set(key, { ...row, minute: key })
      else {
        bucket.chat += row.chat
        bucket.member += row.member
        bucket.likes += row.likes
        bucket.social += row.social
        bucket.gift += row.gift
      }
    }
    const series: RoomSummary['series'] = []
    for (let minute = startMinute; minute <= endMinute; minute += step) {
      const row = buckets.get(minute)
      series.push({
        minute: minute * 60000,
        chat: row?.chat ?? 0,
        member: row?.member ?? 0,
        like: row?.likes ?? 0,
        social: row?.social ?? 0,
        gift: row?.gift ?? 0
      })
    }
    const topChat = await store.chatRankByPerson(webRid, fromMs, toMs, 10)
    // 礼物榜：窗口内按礼物名聚合（「送了什么、值多少」在界面上只有这里+实时列表能看到）
    const gifts = await store.giftBreakdown(webRid, fromMs, toMs)
    /**
     * 收礼物榜 / 送礼物榜（用户 2026-10-08 的要求）：
     * - **两张榜都按抖币排行**（用户追加：「收礼物榜和送礼物榜都要按照抖币来排行，收礼物榜没有按照
     *   抖币来排行」）——收礼榜原来先按麦位序，看着就不像按钱排的；麦位号仍然显示（那是信息），
     *   但**不参与排序**。抖币相同时按件数、再按最近一次。
     * - 收礼榜**不再把「不在麦上」的人滤掉**（用户追加：「收礼物榜不能，下播后就看不见了」）：
     *   麦位是**内存里的实时表**，只有「正在监控 + 没重启过」时才有；下播、关掉监控、重启应用之后
     *   它都是空的——照旧过滤的话收礼榜整张空掉，而数据明明都在库里。现在列**这一段时间里所有
     *   收到礼物的人**，在麦上的人带麦位号，其余照常按抖币排在榜上。
     */
    const seats = new Map((this.states.get(webRid)?.recorder.micList() ?? []).map((item) => [item.userId, item.seat]))
    const byCoins = (a: GiftRankRow, b: GiftRankRow): number =>
      b.diamonds - a.diamonds || b.count - a.count || b.lastAt - a.lastAt
    const receivedAll = await store.giftRankByPerson(webRid, 'recipient', fromMs, toMs)
    const received: GiftRankRow[] = receivedAll
      .map((row) => ({ ...row, seat: seats.get(row.userId) ?? 0 }))
      .sort(byCoins)
    const sentAll = await store.giftRankByPerson(webRid, 'sender', fromMs, toMs)
    const sent: GiftRankRow[] = sentAll.map((row) => ({ ...row, seat: seats.get(row.userId) ?? 0 })).sort(byCoins)
    return {
      webRid,
      windowMinutes: minutes,
      totals,
      messages,
      users: breakdown.users,
      firstAt: breakdown.firstAt,
      lastAt: breakdown.lastAt,
      series,
      kinds: breakdown.kinds,
      diamonds: totals.diamonds,
      gifts,
      received,
      sent,
      topChat
    }
  }

  /** 多房间对比（窗口内的量 + 相位/音频状态） */
  async compare(windowMinutes = 60): Promise<RoomCompareRow[]> {
    const minutes = Math.min(Math.max(5, Math.round(windowMinutes)), 1440)
    const toMs = Date.now()
    const fromMs = toMs - minutes * 60000
    const aggregates = await store.windowAggregates(fromMs, toMs)
    const active = await store.activeMinutes(minuteOf(fromMs), minuteOf(toMs))
    const stores = await this.roomStores()
    const rows: RoomCompareRow[] = []
    for (const state of this.states.values()) {
      const base = aggregates.get(state.webRid)
      const stored = stores.get(state.webRid)
      const row: RoomCompareRow = base ?? {
        webRid: state.webRid,
        title: '',
        anchor: '',
        status: 'unknown',
        phase: 'off',
        audio: false,
        activeMinutes: 0,
        windowMinutes: minutes,
        messages: 0,
        chat: 0,
        member: 0,
        like: 0,
        social: 0,
        gift: 0,
        diamonds: 0,
        users: 0,
        perMinute: 0,
        totalMessages: 0
      }
      rows.push({
        ...row,
        title: state.info?.title || state.title,
        anchor: state.info?.anchor || state.anchor,
        status: state.status,
        phase: state.phase,
        audio: this.audioRoom === state.webRid,
        activeMinutes: active.get(state.webRid) ?? 0,
        windowMinutes: minutes,
        perMinute: Math.round((row.messages / minutes) * 10) / 10,
        totalMessages: stored?.messages ?? row.messages
      })
    }
    rows.sort((a, b) => b.messages - a.messages)
    return rows
  }

  /** 消息检索（走数据库；跨房间也行） */
  async queryMessages(query: MessageQuery): Promise<MessagePage> {
    return store.queryMessages(query)
  }

  async listUsers(
    webRid: string,
    sort: store.UserSort,
    keyword: string,
    limit: number,
    offset: number
  ): Promise<UserRankPage> {
    return store.listUsersPage(webRid, sort, keyword, limit, offset)
  }

  /** 某个人送过的礼物（用户榜悬停时按需查；只查库，不进内存）。
   *  **画像口径**：按这个人的全部账号查（没绑定时就是那一个 id）。 */
  async userGifts(webRid: string, userId: string): Promise<GiftBreakdownRow[]> {
    const ids = await this.accountIdsOf(userId)
    return store.userGiftBreakdown(webRid, ids)
  }

  /**
   * 礼物榜点一行后的**礼物历史**（用户 2026-10-08：「点击后可查看历史礼物数据」）。
   *
   * `direction`：`sent` = 这个人送出去的、`received` = 这个人收到的、`both` = **两个方向都要**
   * （2026-10-11 用户报「礼物历史只能看见送的，没有收的」——档案「每日收益」日历点某一天时，
   * 那一格同时写着送礼与收礼两个数，明细就必须两个方向都给）。
   *
   * 三者都走消息流水（`queryMessages` 的 `userId` / `toUserId` 过滤），所以看到的是**明细**：
   * 时间、礼物名、件数、抖币、对方是谁。分页与「共 N 条」由界面管。
   *
   * `both` 时每一行都带 `direction` 与 `counterpart`（在主进程算，因为只有它手里有
   * 「这个人名下的全部账号」那份 id 集合）：界面据此显示 `→ 对方` / `← 对方`，不用自己猜。
   *
   * `range` **必须跟榜单一致**（用户 2026-10-08 追加：「点开显示礼物历史送内容，不能直接显示
   * 之前的内容，只能是当前的，今天的历史礼物」）：榜单是按那天（或进度条选的那一段）算的，
   * 明细就得是同一段——否则榜上写「×2 1,299 抖币」，点开却翻出一堆前几天的礼物，
   * 数字对不上、而且用户要的是「今天这一场」。时间范围由调用方给（前端把同一段 range 传下来）。
   */
  async giftHistory(
    webRid: string,
    userId: string,
    direction: 'sent' | 'received' | 'both',
    limit = 30,
    offset = 0,
    range?: { from: number; to: number }
  ): Promise<{ rows: GiftHistoryRow[]; total: number }> {
    if (!userId) return { rows: [], total: 0 }
    // 画像的多账号：他哪个号送/收的礼物都算这个人的
    const ids = await this.accountIdsOf(userId)
    const idSet = new Set(ids)
    const page = await store.queryMessages({
      webRid,
      kind: 'gift',
      // `both` = 送礼与收礼是「或」（见 `MessageQuery.bothDirections`）
      ...(direction === 'both'
        ? { userIds: ids, toUserIds: ids, bothDirections: true }
        : direction === 'received'
          ? { toUserIds: ids }
          : { userIds: ids }),
      ...(range && range.to > range.from ? { from: range.from, to: range.to } : {}),
      limit,
      offset
    })
    /*
     * 方向逐行算：**我（或我名下的号）发的** = 送出；**我收到的** = 收到。
     * 两个都成立（自己给自己/自己名下两个号互送）时按「送出」记——送礼那条流水是这个人发起的，
     * 与画像里 `selfLoop` 的口径一致（那笔不算他收到的礼）。
     */
    const rows: GiftHistoryRow[] = page.rows.map((row) => {
      const sent = idSet.has(row.userId)
      const counterpart = sent ? row.toUser : row.user
      const counterpartId = sent ? row.toUserId : row.userId
      return {
        ...row,
        direction: sent ? 'sent' : 'received',
        counterpart,
        counterpartId
      }
    })
    return { rows, total: page.total }
  }

  /**
   * 档案里「送礼 / 收礼」点开后的**每日收益日历**（用户 2026-10-11：「点击后可以查看每一个月的
   * 每一天送礼和收礼的抖币，这个内容 UI 向股票的每日收益的样式，点击后就是弹窗」）。
   *
   * 一次把界面要的三样都回：**这个月的逐日数据**（跨全部直播间、按人的全部账号合计）、
   * **有记录的月份清单**（界面据此判断上/下个月能不能翻）、以及回的是哪个月。
   *
   * `month` 是 `YYYY-MM`；不合法或没给就取**有记录的最近一个月**（退而求其次取当月），
   * 这样从没送过礼的人点开也不会是空的月份、而是「就是没有记录」。
   */
  async userGiftCalendar(userId: string, month = ''): Promise<UserGiftCalendar> {
    const ids = await this.accountIdsOf(userId)
    if (ids.length === 0) return { month: '', months: [], days: [] }
    const months = await store.userGiftMonths(ids)
    const wanted = /^\d{4}-\d{2}$/.test(month) ? month : (months[0] ?? monthOf(Date.now()))
    const { from, to } = monthBucketRange(wanted)
    const days = await store.userGiftDays(ids, from, to)
    return { month: wanted, months, days }
  }

  /**
   * 「这个人」的全部抖音账号（画像）；没绑定时就是 `[userId]`。
   * 一处收口的原因：所有「按人」的查询（档案 / 画像 / 历史 / 礼物明细）都要用同一份 id 集合，
   * 各自去查一次 identity 表既慢又容易漏——实现见 `mapper.resolveAccountIds`。
   */
  private async accountIdsOf(userId: string): Promise<string[]> {
    const id = String(userId ?? '').trim()
    if (!id) return []
    const ids = await store.resolveAccountIds(id)
    return ids.length > 0 ? ids : [id]
  }

  /**
   * 用户档案：库里的累计数字（**跨全部直播间**，见下）。
   *
   * **多账号（0.15.11）**：画像里的每个账号都并进来——统计累加、首见取最早、末见取最晚、
   * 等级取最高、静态字段（昵称/头像/抖音号/签名/城市）**按主账号优先**取第一个非空的。
   * 锚点仍是传进来的那个 `userId`（界面的头像/历史按它取），所以没绑定时行为与旧版逐字一致。
   *
   * **统计口径（2026-10-11 改）**：用户明确要求「互动统计（本房间累计）需要所有直播间统计，
   * 并且礼物价值要改成送礼和收礼两个统计」。所以：
   * - 发言/进场/点赞/关注/送礼次数/送礼抖币 = `userStatsAnyRoom`（按人把各房间的累计行加起来）；
   * - **收礼抖币**同样来自它（按收礼人现算；档案表里没有这一列）；
   * - **本场数字不再补**：`recorder` 的 delta 只是「这一个房间这一次监控」的，混进跨房合计会两套口径打架
   *   （实时列表/用户榜仍按单房间的 `UserStats` 渲染，那是另一套，见 `shared/types` 的注释）。
   *   本场刚出现、还没落库的人照旧能给档案——静态字段走 recorder，只是统计暂时是 0，几秒后被 flush 补上。
   */
  async userProfile(webRid: string, userId: string): Promise<UserDetail | null> {
    if (!userId) return null
    const ids = await this.accountIdsOf(userId)
    const ordered = [userId, ...ids.filter((id) => id !== userId)]
    // 静态字段：有当前房间按房间取（每人一行），没有（数据大屏模式）就跨房间各取最近的一行
    const stored = webRid ? await store.getUsers(webRid, ordered) : await store.getUsersAnyRoom(ordered)
    const sessions = new Map<string, UserProfile>()
    const state = webRid ? this.states.get(webRid) : undefined
    for (const id of ordered) {
      const profile = state?.recorder.profile(id)
      if (profile) sessions.set(id, profile)
    }
    if (stored.size === 0 && sessions.size === 0) return null

    const rows = ordered
      .map((id) => ({ row: stored.get(id), session: sessions.get(id) }))
      .filter((entry) => entry.row || entry.session)
    if (rows.length === 0) return null

    const pick = <T>(get: (entry: { row?: UserRankRow; session?: UserProfile }) => T | undefined, fallback: T): T => {
      for (const entry of rows) {
        const value = get(entry)
        if (value !== undefined && value !== '' && value !== 0) return value
      }
      return fallback
    }
    const mergedBadges: string[] = []
    for (const entry of rows) {
      for (const badge of entry.row?.badges.length ? entry.row.badges : (entry.session?.badges ?? [])) {
        if (!mergedBadges.includes(badge)) mergedBadges.push(badge)
      }
    }
    // 跨房间合计（含收礼抖币）：一次查库，按画像里的全部账号
    const totals = await store.userStatsAnyRoom(ordered)
    const stats: UserTotalsRow = {
      userId,
      chat: 0,
      enter: 0,
      like: 0,
      follow: 0,
      gift: 0,
      diamonds: 0,
      receivedDiamonds: 0
    }
    let firstSeen = 0
    let lastSeen = 0
    for (const id of ordered) {
      const hit = totals.get(id)
      if (hit) {
        stats.chat += hit.chat
        stats.enter += hit.enter
        stats.like += hit.like
        stats.follow += hit.follow
        stats.gift += hit.gift
        stats.diamonds += hit.diamonds
        stats.receivedDiamonds += hit.receivedDiamonds
      }
    }
    for (const { row, session } of rows) {
      const first = row?.firstSeen || session?.firstSeen || 0
      if (first > 0) firstSeen = firstSeen > 0 ? Math.min(firstSeen, first) : first
      lastSeen = Math.max(lastSeen, row?.lastSeen ?? 0, session?.lastSeen ?? 0)
    }
    /*
     * 一个人都没有档案行时（`totals` 全 0、`firstSeen` 也取不到），首末出现退回本场——
     * 否则档案弹窗上「首次出现 / 最近出现」会显示成空。
     */
    if (firstSeen === 0) {
      for (const { session } of rows) {
        const first = session?.firstSeen ?? 0
        if (first > 0) firstSeen = firstSeen > 0 ? Math.min(firstSeen, first) : first
      }
    }

    return {
      id: userId,
      displayId: pick(({ row, session }) => row?.displayId || session?.displayId, ''),
      nickname: pick(({ row, session }) => row?.nickname || session?.nickname, ''),
      gender: pick(({ row, session }) => row?.gender || session?.gender, 0),
      signature: pick(({ row, session }) => row?.signature || session?.signature, ''),
      city: pick(({ row, session }) => row?.city || session?.city, ''),
      avatar: pick(({ row, session }) => session?.avatar || row?.avatar, ''),
      following: pick(({ row, session }) => row?.following || session?.following, 0),
      follower: pick(({ row, session }) => row?.follower || session?.follower, 0),
      honorLevel: pick(({ row, session }) => row?.honorLevel || session?.honorLevel, 0),
      fansClubLevel: pick(({ row, session }) => row?.fansClubLevel || session?.fansClubLevel, 0),
      badges: mergedBadges,
      secUid: pick(({ row, session }) => row?.secUid || session?.secUid, ''),
      firstSeen,
      lastSeen,
      stats
    }
  }

  /** 画像视图（名字 + 主账号 + 全部账号概览）；给档案弹窗的「关联账号」那块用 */
  async userIdentity(userId: string): Promise<UserIdentity> {
    return store.userIdentity(userId)
  }

  /** 搜索可关联的账号（跨房间，按昵称/抖音号/id）；粘贴 id 也走这一条 */
  async searchAccounts(keyword: string, limit = 20): Promise<IdentityAccountRow[]> {
    const needle = String(keyword ?? '').trim()
    if (!needle) return []
    return store.searchAccounts(needle, limit)
  }

  /** 把 target 绑到 source 的画像（两边各有画像就合并），返回 source 现在的画像视图 */
  async bindAccount(sourceUserId: string, targetUserId: string): Promise<UserIdentity> {
    await store.bindAccount(sourceUserId, targetUserId)
    return store.userIdentity(sourceUserId)
  }

  /**
   * 解绑一个账号（只剩一个账号时画像自动解散）。
   *
   * `viewerUserId` = **界面上正在看的那个 id**：被解绑的那个账号解绑后就不属于任何画像了，
   * 拿它自己的视图回给界面会把弹窗里的画像换成「一个空壳」——所以要回**看的人**的视图。
   * 不传就退回 `userId`（脚本/一次性调用）。
   */
  async unbindAccount(userId: string, viewerUserId = ''): Promise<UserIdentity> {
    const id = String(userId ?? '').trim()
    const viewer = String(viewerUserId ?? '').trim() || id
    await store.unbindAccount(id)
    return store.userIdentity(viewer)
  }

  /** 改画像名（空 = 退回主账号昵称）。按账号 id 定位画像，改完回一份最新视图。 */
  async renameIdentity(userId: string, name: string): Promise<UserIdentity> {
    const id = String(userId ?? '').trim()
    if (!id) return { identityId: 0, name: '', note: '', primaryUserId: '', accounts: [] }
    const identityId = await store.identityOf(id)
    if (!identityId) return store.userIdentity(id)
    await store.renameIdentity(identityId, name)
    return store.userIdentity(id)
  }

  /**
   * 「分析用户」：把库里的聚合数据交给**确定性规则算法**打分，产出用户画像。
   *
   * 全程**不经过大模型、不需要人工**：同一份数据必然得到同一份结论
   * （方法论与口径见 `main/analysis/portrait.ts`）。
   *
   * **跨全部直播间**（不接收 webRid）：画像回答的是「这个人在这个平台什么样」，
   * 同一个房间的相关性只体现在消息本身，不需要按房间切片。
   * **多账号**：绑定的账号合成一份画像（自环礼物不计入关系网）。
   */
  async userAnalysis(userId: string): Promise<UserAnalysis> {
    const ids = await this.accountIdsOf(userId)
    const data = await store.userAnalysisData(ids)
    return buildUserAnalysis(data, Date.now())
  }

  /**
   * 「AI 画像」：读**缓存状态**（打开弹窗就调；只查库、不算、不调模型）。
   *
   * 实现在 `../portrait.ts`（那一份是「用宿主大模型生成画像」的整条链：证据打包 → 调模型 →
   * 落库缓存）。hub 只做两件它才知道的事：**把当前设置递过去**（用哪个模型）与**复用档案口径**
   * （`userProfile` 的静态字段合并，保证弹窗上与材料里是同一份资料）。
   */
  async aiPortrait(userId: string): Promise<AiPortraitState> {
    return readAiPortraitState({ userId: String(userId ?? ''), settings: this.settings })
  }

  /**
   * 「AI 画像」：**生成**一版（真调大模型，会花钱）。
   *
   * `force = false` 时若已有缓存就直接回缓存——用户明确要求过「需要保存这个画像，
   * 不然每一次都要重新生成，会很亏 token」；只有点了「重新生成」才 `force = true`（版本号 +1，
   * 并把上一版喂回提示词做迭代）。
   */
  async generateAiPortrait(
    webRid: string,
    userId: string,
    force = false
  ): Promise<AiPortraitResult> {
    const profile = await this.userProfile(webRid, userId).catch(() => null)
    return runAiPortrait({
      userId: String(userId ?? ''),
      webRid: String(webRid ?? ''),
      profile,
      settings: this.settings,
      force
    })
  }

  /** 头像 → data URL（渲染层 CSP 不许外链图片，所以这一步在主进程做） */
  async userAvatar(webRid: string, userId: string): Promise<string> {
    if (!userId) return ''
    const session = webRid ? this.states.get(webRid)?.recorder.profile(userId) : undefined
    const url = session?.avatar || (await store.getUser(webRid, userId))?.avatar || ''
    return url ? avatarCache.dataUrl(url) : ''
  }

  /**
   * 实时列表行首那几个数（用户 2026-10-11：「弹幕 tab 的用户和进场的用户前面的人物要显示
   * 等级，消费评分，入场次数，今天消费」）。
   *
   * 一次查一批 id（界面按可见行 + 新到的消息批攒 id，1 秒节流一次），口径：
   * - **等级**（荣誉/粉丝团）、**消费评分**（本房间累计，算法同画像的「消费力」）：本房间档案行；
   *   还没落库的新人退回本场数字（`fromStore = false`，几秒后就会被 flush 补上）；
   * - **入场次数**：跨全部直播间合计（`enterTotalsByUser`）；
   * - **今日消费**：跨全部直播间、本地自然日（`todaySpend` 账本，见 `ensureTodaySpend`）。
   */
  async userBadges(webRid: string, userIds: string[]): Promise<UserBadge[]> {
    const ids = [...new Set(userIds.map((id) => String(id ?? '').trim()).filter((id) => /^\d{4,}$/.test(id)))]
    if (ids.length === 0) return []
    const capped = ids.slice(0, BADGE_ROWS_CAP)
    await this.ensureTodaySpend()
    const [stored, enterTotals] = await Promise.all([
      webRid ? store.getUsers(webRid, capped) : Promise.resolve(new Map<string, UserRankRow>()),
      store.enterTotalsByUser(capped)
    ])
    const state = this.states.get(webRid)
    return capped.map((id) => {
      const row = stored.get(id)
      const session = state?.recorder.profile(id)
      const diamonds = row?.stats.diamonds ?? session?.stats.diamonds ?? 0
      const giftCount = row?.stats.gift ?? session?.stats.gift ?? 0
      return {
        userId: id,
        honorLevel: Math.max(row?.honorLevel ?? 0, session?.honorLevel ?? 0),
        fansClubLevel: Math.max(row?.fansClubLevel ?? 0, session?.fansClubLevel ?? 0),
        spendScore: spendScore(diamonds, giftCount),
        diamonds,
        giftCount,
        // 跨房间的合计：库里那一列（这个 id 在所有房间的 enter 之和）；查不到就退回本场进场数
        enterTotal: enterTotals.get(id) ?? session?.stats.enter ?? 0,
        todayDiamonds: this.todaySpend.get(id),
        fromStore: Boolean(row)
      }
    })
  }

  /**
   * 「今日消费」账本（跨全部直播间、按本地自然日）：内存累加 + 换天/启动时从库里补种。
   *
   * 为什么不每次查库、以及两个入口的口径，见 `./today-spend.ts` 的注释。
   */
  private todaySpend = new TodaySpend()

  /** 补种（进程刚起来 / 刚换天时跑一次；库里的合计是权威） */
  private async ensureTodaySpend(): Promise<void> {
    const day = String(localDayStart())
    this.todaySpend.roll(day)
    if (this.todaySpend.seeded) return
    try {
      this.todaySpend.seed(await store.todayGiftTotals(Number(day)))
    } catch (error) {
      logger.warn('[douyin-link] 今日消费补种失败（先用内存里的增量）:', describe(error))
      // 标记成已补种：否则每次问都重试一次，失败会一直打库
      this.todaySpend.seed(new Map())
    }
  }

  /** 落库之后把这一批的礼物抖币加进「今日消费」（跨房间共用一本账） */
  private noteTodaySpend(rows: MessageRow[]): void {
    if (rows.length === 0) return
    this.todaySpend.roll(String(localDayStart()))
    this.todaySpend.note(rows)
  }

  /**
   * 「在线观众」：把三条来源合起来（见 `shared/types` 的 PresenceRow 注释）。
   *
   * 排序（面板直接按这个顺序渲染）：**麦上按麦位序排最前**（他们是房间里最核心的一群人），
   * 然后按「本场最近出现」，最后是按 id 排的成员名单。
   *
   * 档案来源（谁先有算谁）：本场解出来的 → 库里的（上一轮监控留下的）→ 主播信息 → 只有 id。
   * 只有 id 的行**不编名字**，界面上显示用户号。
   */
  async presence(webRid: string): Promise<PresenceSnapshot> {
    const state = this.states.get(webRid)
    const empty: PresenceSnapshot = {
      webRid,
      rows: [],
      micCount: 0,
      listedCount: 0,
      activeCount: 0,
      voice: false,
      hasInfo: false,
      updatedAt: Date.now()
    }
    if (!state) return empty
    const recorder = state.recorder
    const presence = new Map(recorder.presenceList().map((entry) => [entry.userId, entry]))
    const micSeats = new Map(recorder.micList().map((item) => [item.userId, item.seat]))
    const listed = new Set(state.roomUserIds)
    const anchorId = state.anchorUser?.id ?? ''

    const ids = new Set<string>([...micSeats.keys(), ...listed])
    if (anchorId) ids.add(anchorId)
    // 大直播间的在场清单可能上千人：面板也画不下，只取「最近出现的」补到上限
    // （麦位与成员名单一定在内），免得每 5 秒对宿主的 PGlite 打十几轮 in 查询。
    for (const entry of recorder.presenceList()) {
      if (ids.size >= PRESENCE_ROWS_CAP) break
      ids.add(entry.userId)
    }
    if (ids.size === 0) return { ...empty, voice: state.voice, hasInfo: Boolean(state.info) }

    const stored = await store.getUsers(webRid, [...ids])
    const blank: UserStats = { chat: 0, enter: 0, like: 0, follow: 0, gift: 0, diamonds: 0 }
    const rows: PresenceRow[] = []
    /** 昵称查不到的 id：一会儿按 id 去抖音补资料（见 enrichUnknownUsers） */
    const unknown: string[] = []
    for (const id of ids) {
      const session = recorder.profile(id)
      const anchor = id === anchorId ? state.anchorUser : null
      const row = stored.get(id)
      const stats = row?.stats ?? blank
      const nickname = session?.nickname || row?.nickname || anchor?.nickname || ''
      if (!nickname) unknown.push(id)
      rows.push({
        userId: id,
        nickname,
        displayId: session?.displayId || row?.displayId || anchor?.displayId || '',
        avatar: session?.avatar || row?.avatar || anchor?.avatar || '',
        gender: session?.gender || row?.gender || anchor?.gender || 0,
        honorLevel: session?.honorLevel || row?.honorLevel || anchor?.honorLevel || 0,
        fansClubLevel: session?.fansClubLevel || row?.fansClubLevel || anchor?.fansClubLevel || 0,
        badges: session?.badges?.length ? session.badges : (row?.badges ?? anchor?.badges ?? []),
        secUid: session?.secUid || row?.secUid || anchor?.secUid || '',
        seat: micSeats.get(id) ?? 0,
        anchor: id === anchorId,
        listed: listed.has(id),
        lastSeen: presence.get(id)?.lastSeen ?? 0,
        firstSeen: presence.get(id)?.firstSeen ?? 0,
        session: session?.stats ?? blank,
        stats,
        storedFirstSeen: row?.firstSeen ?? 0
      })
    }
    // 有「只有 id 的人」就顺手在后台按 id 补资料（fire-and-forget，不拖慢这次返回）
    if (unknown.length > 0) this.enrichUnknownUsers(webRid, unknown)
    rows.sort((a, b) => {
      // 麦上优先（按麦位序），然后主播，再按本场最近出现
      if (a.seat !== b.seat) return (a.seat || 999) - (b.seat || 999)
      if (a.anchor !== b.anchor) return a.anchor ? -1 : 1
      if (a.lastSeen !== b.lastSeen) return b.lastSeen - a.lastSeen
      return a.userId.localeCompare(b.userId)
    })
    return {
      webRid,
      rows,
      micCount: micSeats.size,
      listedCount: listed.size,
      activeCount: presence.size,
      voice: state.voice,
      hasInfo: Boolean(state.info),
      updatedAt: Date.now()
    }
  }

  /**
   * 补齐「只有 id 的人」的昵称/头像：按 id 去抖音查真实资料并落库（`fetchUserProfile`）。
   *
   * 为什么要做（用户 2026-10-10：「解决用户信息丢失，明明可以获取的」）：在线观众的「成员」
   * 来自接口的 `admin_user_ids_str`，**只有 id**；这些人若从没在本房间发过言/进过场，库里就没昵称，
   * 界面只能显示一串数字——但按 id 是**可以**查回真实资料的（弹窗的「查看真实资料」就是这条）。
   *
   * 三重收敛（别把这个接口打爆）：单次 ≤ `ENRICH_BUDGET` 个、并发 `ENRICH_CONCURRENCY`、
   * 失败冷却 `ENRICH_FAIL_COOLDOWN_MS`；同一房间同一时刻只跑一批。
   * 全程 fire-and-forget：查完落库并作废缓存，下一轮 5 秒轮询就能看到昵称/头像。
   */
  private enrichUnknownUsers(webRid: string, ids: string[]): void {
    if (!webRid || this.enriching.has(webRid)) return
    const now = Date.now()
    const targets = ids.filter((id) => {
      const cached = this.enrichCache.get(id)
      if (!cached) return true
      // 成功过就不必再查；失败要过了冷却才重试（避免对查不到的人反复打接口）
      return !cached.ok && now - cached.at >= ENRICH_FAIL_COOLDOWN_MS
    })
    if (targets.length === 0) return
    const budget = targets.slice(0, ENRICH_BUDGET)
    this.enriching.add(webRid)
    void (async () => {
      const found: store.UserStaticRow[] = []
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < budget.length) {
          const id = budget[cursor]
          cursor += 1
          try {
            const result = await fetchUserProfile(id)
            if (result.ok) {
              const p = result.profile
              found.push({
                userId: p.userId,
                displayId: p.displayId,
                nickname: p.nickname,
                gender: p.gender,
                signature: p.signature,
                city: p.region,
                avatar: p.avatarUrl,
                following: p.following,
                follower: p.follower,
                secUid: p.secUid
              })
              this.enrichCache.set(id, { at: Date.now(), ok: true })
            } else {
              this.enrichCache.set(id, { at: Date.now(), ok: false })
            }
          } catch {
            this.enrichCache.set(id, { at: Date.now(), ok: false })
          }
        }
      }
      try {
        await Promise.all(
          Array.from({ length: Math.min(ENRICH_CONCURRENCY, budget.length) }, () => worker())
        )
        if (found.length > 0) {
          await store.upsertUserStatic(webRid, found)
          // 补出来的是**新行**：作废「库里累计量」缓存，让房间列表的「用户 N」跟着更新
          this.storeCache.at = 0
          logger.info(`[douyin-link] ${webRid} 按 id 补齐了 ${found.length} 个用户的资料`)
        }
      } catch (error) {
        logger.warn(`[douyin-link] ${webRid} 补齐用户资料失败:`, describe(error))
      } finally {
        this.enriching.delete(webRid)
      }
    })()
  }

  /**
   * **每一天的直播记录**（左侧房间旁边的「每日记录」列表）。
   *
   * 点一天之后看详情用的是 `summary(webRid, 0, { from, to })`——同一条查询路径，
   * 所以「按天看」和「按进度条拖出来的时间段看」看到的数字口径完全一致。
   */
  async dayRecords(webRid: string, limit = 90): Promise<DayRecordRow[]> {
    return store.dayRecords(webRid, limit)
  }

  /**
   * **查看真实资料**：拿用户 id 去抖音的 web 端资料接口，把这个账号的平台资料取回来
   * （真名、头像、粉丝数等，见 `../douyin/mystery`），并**回填到我们自己那份档案**里。
   *
   * 两条口径：
   * - **不缓存**：抖音那边的资料随时可能变，每次点都拿最新的一份；
   * - **回填只写静态字段**（昵称/抖音号/头像/签名/地区/粉丝/关注/secUid），走 `upsertUserStatic`
   *   ——它不动统计与首末时间，所以界面上的互动数字不会因为这个按钮变化
   *   （用户 2026-10-11：「点击后更新用户的信息，回填页面上面的内容」）。
   */
  async revealMystery(userId: string, webRid = ''): Promise<MysteryReveal> {
    const id = String(userId ?? '').trim()
    if (!id) return { ok: false, code: 'badInput' }
    /**
     * **匿名的人走另一条路**（用户 2026-10-12：「我需要匿名用户，可以和神秘人一样获取其信息」）：
     * 帧里给的 id 是所有人共用的占位串、昵称是马甲名，拿占位 id 去查抖音只会拿到 `3170`。
     * 那条路会先按**马甲名尾段**在我们自己库里核对候选，核上才去查抖音——细节与三条实测死路
     * 见 `../douyin/anonymous-reveal.ts`。
     */
    if (isAnonymousId(id)) return this.revealAnonymous(id, webRid)
    return revealMysteryProfile(id, async (raw) => {
      if (!webRid) return
      await store.upsertUserStatic(webRid, [
        {
          userId: raw.userId,
          displayId: raw.displayId,
          nickname: raw.nickname,
          gender: raw.gender,
          signature: raw.signature,
          city: raw.region,
          avatar: raw.avatarUrl,
          following: raw.following,
          follower: raw.follower,
          secUid: raw.secUid
        }
      ])
      // `avatarCache` 按 url 缓存，所以这里不用管它：回填进来的是一个**新的** CDN 地址，
      // 下次 `user-avatar` 自然会去下载那一份（渲染层那边按「房间 + 用户」缓存，见 forgetAvatar）
      logger.info(`[douyin-link] 真实资料已回填：${raw.userId} @ ${webRid}（${raw.nickname}）`)
    })
  }

  /**
   * 匿名档案的「查看真实资料」：拿**马甲名**找线索，找到真 id 再查抖音。
   *
   * 回填与神秘人那条链共用同一套（`upsertUserStatic` 只写静态字段、不动统计）。
   * 查不到的两种情况（没有线索 / 本地也核不上）都回 `anonymousMasked`，
   * 界面照实说明「匿名身份在抖音那边不可还原」，而不是留一个转圈到超时的按钮。
   */
  private async revealAnonymous(userId: string, webRid: string): Promise<MysteryReveal> {
    const profile = webRid ? await store.getUser(webRid, userId) : undefined
    const mask = profile?.nickname ?? ''
    return revealAnonymousProfile(
      {
        webRid,
        userId,
        mask,
        follower: profile?.follower ?? 0,
        following: profile?.following ?? 0
      },
      () => store.getAnonymousCandidates(webRid, mask, anonymousMaskTail(mask)),
      async (raw) => {
        if (!webRid) return
        await store.upsertUserStatic(webRid, [
          {
            userId: raw.userId,
            displayId: raw.displayId,
            nickname: raw.nickname,
            gender: raw.gender,
            signature: raw.signature,
            city: raw.region,
            avatar: raw.avatarUrl,
            following: raw.following,
            follower: raw.follower,
            secUid: raw.secUid
          }
        ])
        logger.info(`[douyin-link] 匿名还原的资料已回填：${raw.userId} @ ${webRid}（${raw.nickname}）`)
      }
    )
  }

  async clearUsers(webRid = ''): Promise<void> {
    await store.clearUsers(webRid)
    this.storeCache.at = 0
    this.dbCache.at = 0
    this.emitRooms(true)
  }

  async clearMessages(webRid = ''): Promise<number> {
    const removed = await store.clearMessages(webRid)
    this.storeCache.at = 0
    this.dbCache.at = 0
    this.emitRooms(true)
    return removed
  }

  clearRecent(webRid: string): boolean {
    const state = this.states.get(webRid)
    if (state) state.recorder.clearRecent()
    this.emitRooms(true)
    return true
  }

  recentFor(webRid: string, limit = 100): DanmakuItem[] {
    const state = this.states.get(webRid)
    if (!state) return []
    const size = Math.min(Math.max(1, Math.round(limit)), RECENT_CAP * 3)
    return state.recorder.recent.slice(-size).reverse()
  }

  async sessions(webRid: string, limit = 20): Promise<MonitorSession[]> {
    return store.listSessions(webRid, limit)
  }

  /* ----------------------------------------------------------- 内部工具 */

  private createState(room: {
    webRid: string
    roomId?: string
    title?: string
    anchor?: string
    cover?: string
    onlineText?: string
    status?: 'live' | 'ended' | 'unknown'
    note?: string
    monitor?: boolean
    addedAt?: number
    lastActiveAt?: number
    lastSeenAt?: number
  }): RoomState {
    return {
      webRid: room.webRid,
      target: `https://live.douyin.com/${room.webRid}`,
      roomId: room.roomId ?? '',
      info: null,
      title: room.title ?? '',
      anchor: room.anchor ?? '',
      cover: room.cover ?? '',
      onlineText: room.onlineText ?? '',
      status: room.status ?? 'unknown',
      note: room.note ?? '',
      monitor: room.monitor ?? false,
      phase: 'off',
      failure: null,
      danmaku: idleDanmaku(),
      qualities: [],
      quality: null,
      streams: {},
      cookie: '',
      roomUserIds: [],
      anchorUser: null,
      voice: false,
      refreshedAt: 0,
      sourceUrl: '',
      recorder: new RoomRecorder(room.webRid),
      roomSocket: null,
      startToken: 0,
      sessionId: 0,
      attempts: 0,
      addedAt: room.addedAt ?? Date.now(),
      lastActiveAt: room.lastActiveAt ?? 0,
      lastSeenAt: room.lastSeenAt ?? 0
    }
  }

  private applyResolved(state: RoomState, resolved: RoomResolveResult): void {
    const info = resolved.room
    state.info = info
    state.roomId = info.roomId || state.roomId
    state.title = info.title
    state.anchor = info.anchor
    state.cover = info.cover
    state.onlineText = info.onlineText
    state.status = info.status
    state.voice = info.voice
    state.streams = resolved.flv
    state.cookie = resolved.cookie || state.cookie
    state.qualities = QUALITY_KEYS.filter((key) => Boolean(resolved.flv[key]))
    if (!state.quality || !resolved.flv[state.quality]) state.quality = this.pickQuality(state)
    // 房间成员名单与主播信息随解析一起更新（见过的用新值覆盖，没见过才写）
    if (resolved.roomUserIds.length > 0) {
      const previous = new Set(state.roomUserIds)
      const merged = [...state.roomUserIds, ...resolved.roomUserIds.filter((id) => !previous.has(id))]
      state.roomUserIds = merged.slice(0, 200)
    }
    if (resolved.anchorUser?.id) state.anchorUser = resolved.anchorUser
    /**
     * 主播资料也喂给记录器：**帧里不给收礼人的房间（个播）靠它把收礼人补上**，
     * 否则收礼物榜整张空着（2026-10-11 报障，见 `shared/gift-recipient.ts`）。
     * 别把 `state.anchorUser` 传进去：它可能是空的，而 recorder 只认非空的那份。
     */
    if (state.anchorUser) state.recorder.setAnchor(state.anchorUser)
    state.refreshedAt = Date.now()
    // 成员名单/主播资料随解析更新，而这两样都在「在线观众」表里
    this.markPresenceDirty(state.webRid)
  }
}

/** 单例：install 时装，停用时 dispose（宿主 LIFO 回滚） */
export const analyzerHub = new AnalyzerHub()

/** 本插件自带的死线提示文案里用到的失败代码表（新增代码记得补词条） */
export const FAILURE_CODES = [
  'noRoom',
  'badInput',
  'network',
  'pageFailed',
  'roomNotFound',
  'enterFailed',
  'resolveFailed',
  'connectFailed',
  'timeout',
  'notConnected',
  'audioUnsupported',
  'noAudioStream',
  'streamEnded',
  'streamFailed',
  'fetchFailed',
  'badStream',
  'noAudio',
  'decodeFailed',
  'unsupported',
  // 实时通道（主进程纯 Node 直连推送 ws）新增
  'signFailed',
  'noRoomId',
  'pushRejected',
  'realtimeChannelLost'
]

/** 让出事件循环一拍（PGlite 与宿主同进程，不让步就会把别人的流式输出挤停） */
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** 一条房间分钟序列的抖币合计（数据大屏「指标」页签按它给房间排序、取前 N） */
function sumDiamonds(row: RoomSeriesRow): number {
  return row.series.reduce((total, point) => total + point.diamonds, 0)
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 160)
  return String(error).slice(0, 160)
}

/**
 * 本地自然日的起点（ms）：`floor((at + 本地偏移) / 一天) * 一天 - 本地偏移`。
 *
 * 与库里的分天口径**同一套**（`mapper.dayRecords` / `uniqueMinutes` 都用本地偏移再取整）——
 * 界面上的「今天」与这里的「今日消费」必须是同一天，不然跨零点那会儿数字会对不上。
 */
function localDayStart(at = Date.now()): number {
  const offset = -new Date().getTimezoneOffset() * 60000
  return Math.floor((at + offset) / 86400000) * 86400000 - offset
}
