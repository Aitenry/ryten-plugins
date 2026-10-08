/**
 * 抖音直播分析器（douyin-link）的跨进程契约（主进程与渲染层共用）。
 *
 * 规矩：**不 import drizzle / electron / node**——渲染层也要 import 它，
 * 带上任何一端的东西都会把那一端打进另一端的产物。
 *
 * 这一版的模型与上一版最大的不同：状态不再是「一个房间」，而是
 * **一条房间列表 + 一个「最新选中」的房间**（`AnalyzerSnapshot`）：
 * - 每个房间在**主进程**里各有一份运行态（采集器、弹幕相位、计数）与库里的历史数据；
 * - 音频（`AudioMessage`）**只跟最新选中的那个房间**走，其余房间只监听弹幕；
 * - 渲染层是纯视图：它拿到的每个数字都来自主进程（内存运行态或数据库查询）。
 */

/** 音质档位（抖音 web 端的固定四档，FULL_HD1 最高） */
export type QualityKey = 'FULL_HD1' | 'HD1' | 'SD1' | 'SD2'

export const QUALITY_KEYS: QualityKey[] = ['FULL_HD1', 'HD1', 'SD1', 'SD2']

/** 直播间静态信息（主进程解析一次，渲染层只读） */
export interface LiveRoomInfo {
  /** 网页房间号（链接里的那串数字，如 108011161837） */
  webRid: string
  /** 内部房间 id（webcast 接口用的长 id） */
  roomId: string
  title: string
  anchor: string
  /** 在线人数（接口直接给的展示串，如 "11w+"） */
  onlineText: string
  status: 'live' | 'ended' | 'unknown'
  cover: string
  /**
   * 语音/聊天室（有麦位的直播间，接口给 `function_type = "radio"`）。
   * 这类房间的重点是「麦上」那个人，所以在线观众面板会把麦位单列出来。
   */
  voice: boolean
}

/** 弹幕类型：界面按类型配色与过滤 */
export type DanmakuKind = 'chat' | 'member' | 'like' | 'social' | 'gift' | 'stats' | 'control' | 'system'

export const DANMAKU_KINDS: DanmakuKind[] = [
  'chat',
  'member',
  'like',
  'social',
  'gift',
  'stats',
  'control',
  'system'
]

/** 计数用到的类型（stats/control/system 不入库，它们不是「互动」） */
export const COUNTED_KINDS: DanmakuKind[] = ['chat', 'member', 'like', 'social', 'gift']

/**
 * 用户在直播间里的静态信息（主进程从弹幕帧里的 `User` 消息解出来，跨进程共用）。
 *
 * 字段号是**真机 dump 出来的**：`1` id / `2` shortId / `3` 昵称 / `4` 性别 / `5` 签名 /
 * `14|63` 城市 / `9|10|11` 头像三档 / `22` FollowInfo{1 关注数, 2 粉丝数, 6|7 字符串镜像} /
 * `23` PayGrade{6 荣誉等级} / `24` FansClub{1.2 等级} / `61` 勋章列表 / `38` 抖音号 / `46` secUid。
 */
export interface UserInfo {
  /** 用户 id（int64 精确十进制串；BigInt 还原，不走 Number） */
  id: string
  /** 抖音号（displayId，拿不到时退回 shortId 的十进制串） */
  displayId: string
  nickname: string
  /** 1 = 男，2 = 女，其它 = 未知 */
  gender: number
  /** 个性签名 */
  signature: string
  /** 城市（接口偶尔给的是 IP 归属地） */
  city: string
  /** 头像地址（抖音 CDN 的 https；渲染层不能直接请求，见 `user-avatar` 通道） */
  avatar: string
  /** 关注数 */
  following: number
  /** 粉丝数 */
  follower: number
  /** 荣誉等级（0 = 未知） */
  honorLevel: number
  /** 粉丝团等级（0 = 没加入） */
  fansClubLevel: number
  /** 勋章描述（如「荣誉等级31级勋章」） */
  badges: string[]
  secUid: string
}

/** 单个用户在某一个直播间里的累计互动计数 */
export interface UserStats {
  /** 发言条数 */
  chat: number
  /** 进场次数 */
  enter: number
  /** 点赞次数 */
  like: number
  /** 关注直播间次数 */
  follow: number
  /** 送出礼物的**次数**（连击按推送来的每一条算一次） */
  gift: number
  /**
   * 送出礼物的**抖币总额**（0 = 官方没给价或全是免费礼物）。
   *
   * 口径：一条 `WebcastGiftMessage` 的价值 = `GiftStruct.diamond_count × 该条的数量`；
   * 拿不到 `diamond_count` 时按 0 计（**宁可没有数字，也不给一个错的**）。
   */
  diamonds: number
}

/** 完整档案 = 静态信息 + 出现记录 + 该房间的累计统计 */
export interface UserProfile extends UserInfo {
  /** 首次出现 / 最近出现（ms） */
  firstSeen: number
  lastSeen: number
  stats: UserStats
}

/** 一个房间的互动计数（内存运行态与库里统计都用它） */
export interface LiveInteractions {
  chat: number
  enter: number
  like: number
  follow: number
  /** 本场收到的礼物条数（抖币价值看每条消息的 `diamonds` 与用户/汇总的累计） */
  gift: number
}

/**
 * 一条弹幕 / 一条直播间消息。
 *
 * 礼物这一类多两个「收礼人」字段：真礼物在推送里有 `toUser`（`WebcastGiftMessage.8`），
 * 语音房点歌那一帧里也有（`6.5.1.1` 是歌手 = 收到这份点唱礼物的人）。
 * 其它类型一律为空串。
 */
export interface DanmakuItem {
  /** 自增序号（渲染层做 key；protobuf 里的 id 会丢精度，不用它） */
  id: number
  kind: DanmakuKind
  /** 发送者昵称（系统消息为空） */
  user: string
  /** 发送者 id（渲染层拿它查用户档案；拿不到时是空串） */
  userId: string
  /**
   * 正文：
   * - chat = 弹幕内容；stats = 人数串；system/control = 提示原文；
   * - **gift = 礼物名**（真礼物取 `GiftStruct.name`；点歌那头取点唱礼物记录里的 `6.5.1.10`）。
   */
  text: string
  /**
   * 计数：点赞数（like）/ 进场后的在线人数（member）/ **该条消息里的礼物数量**（gift）。
   * 0 = 无。
   */
  count: number
  /**
   * 抖币价值：**只有 gift 用**（= 单价 × 数量），其余类型一律 0。
   *
   * 单价来自推送里的价格字段（真礼物是 `GiftStruct.diamond_count`，点歌是点唱礼物记录里的价格）；
   * 拿不到就是 0，界面上显示成「价值未知」而不是「免费」。
   */
  diamonds: number
  /** **收礼人**昵称（礼物才有：谁收到了这份礼物；拿不到时是空串） */
  toUser: string
  /** 收礼人 id（礼物才有；空串 = 不知道 / 这条不是礼物） */
  toUserId: string
  /** 主进程收到的时刻（ms） */
  at: number
}

/** 库里的一条消息（多一个房间号：跨房间检索要用） */
export interface StoredMessage extends DanmakuItem {
  webRid: string
}

/** 失败原因：**只回代码 + 明细**，文案由渲染层按界面语言翻 */
export interface FailureInfo {
  code: string
  detail?: string
}

/** 弹幕通道阶段 */
export type DanmakuPhase = 'off' | 'connecting' | 'live' | 'retrying' | 'error'

export interface DanmakuStatus {
  phase: DanmakuPhase
  failure: FailureInfo | null
  /** 当前弹幕连接开始时刻（ms） */
  since: number
  /** 本次连接收到的消息条数 */
  received: number
}

/**
 * 一个房间的监控相位（主进程算，界面只显示）。
 *
 * `queued` 是这一版新增的：同时在跑的房间数有上限（省内存），
 * 勾了监控但排不进槽位的房间就是这个相位——它没失败，只是在排队。
 *
 * `connecting` 是采集窗口正在建/页面正在连 im 的中间态（与 `DanmakuPhase` 里同名的那一个对齐），
 * 界面把它显示成「连接中」。
 */
export type MonitorPhase =
  | 'off'
  | 'queued'
  | 'resolving'
  | 'connecting'
  | 'live'
  | 'retrying'
  | 'error'
  | 'ended'

/**
 * 运行时快照里的一个房间（内存运行态 + 库里的累计量）。
 *
 * 这是界面左栏那一列、以及「对比」页签的数据源。**不含消息正文**（正文走
 * `messages` 事件或 `messages-query` 通道），所以整份列表可以每秒推一次而不心疼。
 */
export interface RoomRuntime {
  /** 网页房间号 = 房间的稳定标识（库里的主键之一） */
  webRid: string
  title: string
  anchor: string
  cover: string
  onlineText: string
  status: 'live' | 'ended' | 'unknown'
  /** 用户备注（库里存，随便写） */
  note: string
  /** 期望是否监控（库里存：重启后按它决定要不要接着跑） */
  monitor: boolean
  /** 当前相位 */
  phase: MonitorPhase
  failure: FailureInfo | null
  danmaku: DanmakuStatus
  /** 服务端提供的档位 / 当前选的档位 */
  quality: QualityKey | null
  qualities: QualityKey[]
  /** 是否正在往界面推这个房间的音频（全局最多一个房间为 true） */
  audio: boolean
  /** 本次监控会话在库里的 id（0 = 没有） */
  sessionId: number
  /** 本次会话的实时计数（连上就清零） */
  counters: LiveInteractions
  /** 本次会话收到的消息条数 */
  received: number
  /** 最近一分钟的消息速率（条/分，主进程滑窗算） */
  rate: number
  /** 本次会话出现过的人数 */
  sessionUsers: number
  /** 库里该房间的累计量（KPI 卡片与对比页签用） */
  stored: { messages: number; users: number; sessions: number }
  addedAt: number
  lastActiveAt: number
  lastSeenAt: number
}

/** 库里的行数统计（设置页显示「数据存在数据库里」的实据） */
export interface DbStats {
  rooms: number
  messages: number
  users: number
  minutes: number
  sessions: number
  /** 库里最早 / 最新一条消息的时间（0 = 空库） */
  firstMessageAt: number
  lastMessageAt: number
}

/**
 * 界面一次拿到的全量：房间列表 + 「分析中的房间」 + 设置 + 该房间的内存最近弹幕。
 *
 * `activeRoom` 是**最新选中的那个房间**：音频跟着它走，页签里的分析也是它。
 * 主进程不再有「全局唯一连接」这件事——连接是每个房间各自的事。
 */
export interface AnalyzerSnapshot {
  rooms: RoomRuntime[]
  /** 正在分析的房间（最新选中的那个；'' = 还没选） */
  activeRoom: string
  /** 正在推音频的房间（'' = 没在响） */
  audioRoom: string
  settings: LiveSettings
  /** activeRoom 的内存最近弹幕（新 → 旧） */
  recent: DanmakuItem[]
  db: DbStats
  updatedAt: number
}

/** 主进程推送的一条消息批（房间 + 这一批） */
export interface MessageBatch {
  webRid: string
  items: DanmakuItem[]
}

/** 主进程推送的计数心跳（房间 + 几个数字；界面原地合并，不重拉快照） */
export interface RoomTick {
  webRid: string
  counters: LiveInteractions
  received: number
  rate: number
  sessionUsers: number
}

/** 主进程推送的档案变化（只推变了的那几个） */
export interface UserBatch {
  webRid: string
  users: UserProfile[]
}

/**
 * 「在线观众」里的一行。
 *
 * 来自三条**不同来源**的合并（谁有数据用谁，互相不覆盖，界面上用标签区分）：
 * - **麦上**（`seat > 0`）：语音聊天室的麦位表（`RoomLinkmicMicDisplayInfoSyncData`），
 *   顺序就是麦位序；
 * - **房间成员**（`listed = true`）：直播间接口（enter）给的房间成员 id 列表
 *   （实测固定 30 位、几分钟内不随观众进出变化，所以它是成员名单而不是「正在看的人」）；
 * - **本场**（`lastSeen > 0`）：本次监控里出现在任何一条消息里的人（弹幕/进场/点赞/关注）。
 *
 * 昵称/头像只有「我们见过这个人」才有（推送里的 User 或库里上一轮监控留下的档案）；
 * 只有 id 的行会显示成用户号——不编造名字。
 */
export interface PresenceRow {
  userId: string
  nickname: string
  displayId: string
  avatar: string
  gender: number
  honorLevel: number
  fansClubLevel: number
  badges: string[]
  secUid: string
  /** 麦位序号（1 起；0 = 不在麦上） */
  seat: number
  /** 是否主播 */
  anchor: boolean
  /** 是否在直播间接口给的房间成员名单里 */
  listed: boolean
  /** 本场最后一次出现（ms；0 = 本场没见过） */
  lastSeen: number
  /** 本场首次出现（ms） */
  firstSeen: number
  /** **本场**互动计数（这次监控开始之后） */
  session: UserStats
  /** 库里累计（跨会话；这个人在本房间的历史） */
  stats: UserStats
  /** 库里最早的记录时间（ms；0 = 库里没有） */
  storedFirstSeen: number
}

/** 一个房间的「在线观众」快照（面板一次拉一份，按需刷新） */
export interface PresenceSnapshot {
  webRid: string
  rows: PresenceRow[]
  /** 在麦上的人数 */
  micCount: number
  /** 接口给的房间成员人数 */
  listedCount: number
  /** 本场出现过的人数 */
  activeCount: number
  /** 是不是语音/聊天室（有麦位） */
  voice: boolean
  /**
   * 房间信息是否已经解析过（主进程有没有这个房间的运行态）。
   *
   * `false` 有两种情形，界面都该显示「正在解析 / 主进程还没就绪」而不是「没有数据」：
   * 插件刚装上还没连过、或宿主刚升级完插件而主进程的房间清单还是空的。
   */
  hasInfo: boolean
  updatedAt: number
}

/** 插件的设置（存 userData/plugin-state/douyin-link.json；数据本身进数据库） */
export interface LiveSettings {
  quality: QualityKey
  /** 开始监控/切换房间时自动把声音切过去 */
  audioOnConnect: boolean
  volume: number
  /** 每个房间在内存里保留的弹幕条数（库里是全量，受保留天数约束） */
  maxItems: number
  /** 要显示的弹幕类型 */
  kinds: DanmakuKind[]
  /**
   * 实时通道：借直播间页面自己的 websocket 收**逐条消息**（弹幕/进场/点赞/关注/人数/麦位）。
   *
   * 它比 HTTP 轮询（`im/fetch`）更实时；打开它时中枢会**暂停 HTTP 轮询**、
   * 改用 ws（ws 断了再自动回落到轮询）。它需要**一个隐藏窗口**加载直播间页（推送 ws 有设备指纹闸，
   * 合成设备连不上），所以是可关闭的实验性开关；任何失败都会自动降级，不影响监听本身。
   */
  realtimeStream: boolean
  /** 弹幕列表自动跟随最新 */
  autoScroll: boolean
  /** 同时监控的房间数上限（每个房间一路推送连接，超了排队） */
  monitorConcurrency: number
  /** 启动应用时接着监控上次在监控的房间（默认关：打开应用不该自己连上直播间） */
  resumeOnStart: boolean
  /** 消息保留天数（启动时按它清旧数据，0 = 永久保留） */
  retentionDays: number
}

/** 房间列表里的累计统计（概览页签的 KPI 卡片与对比页签） */
export interface RoomSummary {
  webRid: string
  /** 统计窗口（分钟） */
  windowMinutes: number
  totals: LiveInteractions
  /** 消息总条数（含未计入互动的 stats/control/system） */
  messages: number
  users: number
  /** 窗口内第一条 / 最后一条消息的时刻（ms；0 = 窗口内没有数据） */
  firstAt: number
  lastAt: number
  /** 每秒一条的时间序列（按分钟聚合，主进程补齐缺口） */
  series: Array<{ minute: number; chat: number; member: number; like: number; social: number; gift: number }>
  /** 窗口内的礼物抖币总额（0 = 没有礼物，或官方没给价） */
  diamonds: number
  /** 类型分布 */
  kinds: Array<{ kind: DanmakuKind; count: number }>
  topChat: UserRankRow[]
}

/** 榜单 / 用户列表的一行（= 用户档案的「库口径」，统计是跨会话累计的） */
export interface UserRankRow {
  userId: string
  nickname: string
  displayId: string
  avatar: string
  gender: number
  signature: string
  city: string
  badges: string[]
  secUid: string
  following: number
  follower: number
  honorLevel: number
  fansClubLevel: number
  stats: UserStats
  firstSeen: number
  lastSeen: number
}

/** 消息检索条件（全部可选；空条件 = 最近的消息） */
export interface MessageQuery {
  /** 房间号；'' = 所有房间 */
  webRid?: string
  /** 关键词（匹配正文或昵称） */
  keyword?: string
  kind?: DanmakuKind | ''
  userId?: string
  /** 时间范围（ms） */
  from?: number
  to?: number
  limit?: number
  offset?: number
}

/** 检索结果一页 */
export interface MessagePage {
  rows: StoredMessage[]
  /** 命中总数（用于「共 N 条」与翻页） */
  total: number
}

/** 多房间对比的一行 */
export interface RoomCompareRow {
  webRid: string
  title: string
  anchor: string
  status: 'live' | 'ended' | 'unknown'
  phase: MonitorPhase
  audio: boolean
  /** 窗口内的分钟数（有数据的分钟数 / 窗口分钟数） */
  activeMinutes: number
  windowMinutes: number
  messages: number
  chat: number
  member: number
  like: number
  social: number
  /** 窗口内的礼物条数 */
  gift: number
  /** 窗口内的礼物抖币总额 */
  diamonds: number
  users: number
  /** 平均速率（条/分，按窗口算） */
  perMinute: number
  /** 库里累计 */
  totalMessages: number
}

/** 一次监控会话（房间 + 起止 + 消息数） */
export interface MonitorSession {
  id: number
  webRid: string
  startedAt: number
  endedAt: number
  messages: number
  endReason: string
}

/** 主进程拉流阶段（渲染层只用来显示，真正的解码状态在播放器里） */
export type AudioPhase = 'idle' | 'connecting' | 'live' | 'error'

/** 一枚 AAC 裸帧（跨 IPC 传的就是它） */
export interface AudioFrame {
  /** 相对**本次连接**第一帧的毫秒时间戳（每次重连从 0 重新计） */
  ts: number
  /** AAC 裸帧字节 */
  data: Uint8Array
}

/** AAC 解码参数（FLV 里那份 AudioSpecificConfig 解出来的） */
export interface AudioConfig {
  sampleRate: number
  channels: number
  /** AAC object type（2 = LC） */
  objectType: number
  /** AudioSpecificConfig：WebCodecs 的 description 要它 */
  asc: Uint8Array
}

/**
 * 主进程 → 渲染层的音频消息（同一条事件通道 `plugin:douyin-link:audio`，靠 type 区分）。
 *
 * **只会有正在响的那个房间的消息**（`webRid` 就是它）：切房间时主进程会先停旧泵再开新泵，
 * 渲染层的播放器只需按 `webRid` 判断「这批帧还是不是我该放的」。
 * 为什么走 IPC 而不是让渲染层自己 fetch：宿主 CSP 不许（见 LiveSettings 之上的说明）。
 */
export type AudioMessage =
  | { type: 'status'; webRid: string; phase: AudioPhase; failure: FailureInfo | null }
  | { type: 'config'; webRid: string; config: AudioConfig }
  | { type: 'frames'; webRid: string; seq: number; frames: AudioFrame[] }

/** 音质档位的中文/英文展示名由渲染层词条给，这里只给键 */
export function isQualityKey(value: unknown): value is QualityKey {
  return typeof value === 'string' && (QUALITY_KEYS as string[]).includes(value)
}

/** 从任意用户输入里抠出网页房间号（支持整条链接、带参数链接、纯数字） */
export function parseWebRid(input: string): string | null {
  const text = String(input ?? '').trim()
  if (!text) return null
  if (/^\d{4,}$/.test(text)) return text
  const direct = text.match(/live\.douyin\.com\/(?:u\/)?(\d{4,})/)
  if (direct) return direct[1]
  const query = text.match(/[?&](?:web_rid|room_id|rid)=(\d{4,})/)
  if (query) return query[1]
  const loose = text.match(/(\d{6,})/)
  return loose ? loose[1] : null
}
