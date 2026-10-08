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
}

/** 弹幕类型：界面按类型配色与过滤 */
export type DanmakuKind =
  | 'chat'
  | 'gift'
  | 'member'
  | 'like'
  | 'social'
  | 'stats'
  | 'control'
  | 'system'

export const DANMAKU_KINDS: DanmakuKind[] = [
  'chat',
  'gift',
  'member',
  'like',
  'social',
  'stats',
  'control',
  'system'
]

/** 计数用到的类型（stats/control/system 不入库，它们不是「互动」） */
export const COUNTED_KINDS: DanmakuKind[] = ['chat', 'gift', 'member', 'like', 'social']

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
  /** 送礼次数（消息条数） */
  gift: number
  /** 送礼额度合计（抖币） */
  diamonds: number
  /** 进场次数 */
  enter: number
  /** 点赞次数 */
  like: number
  /** 关注直播间次数 */
  follow: number
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
  gift: number
  /** 礼物额度合计（抖币） */
  diamonds: number
  enter: number
  like: number
  follow: number
}

/** 一条弹幕 / 一条直播间消息 */
export interface DanmakuItem {
  /** 自增序号（渲染层做 key；protobuf 里的 id 会丢精度，不用它） */
  id: number
  kind: DanmakuKind
  /** 发送者昵称（系统消息为空） */
  user: string
  /** 发送者 id（渲染层拿它查用户档案；拿不到时是空串） */
  userId: string
  /** 正文（chat = 弹幕内容；gift = 礼物名；stats = 人数串） */
  text: string
  /** 计数（点赞数、礼物连发数等，0 = 无） */
  count: number
  /** 这一条礼物的额度（抖币 = 单价 × 数量）；只有礼物有，其它是 0 */
  diamonds: number
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
  stored: { messages: number; users: number; diamonds: number; sessions: number }
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
  gifts: number
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

/** 插件的设置（存 userData/plugin-state/douyin-link.json；数据本身进数据库） */
export interface LiveSettings {
  quality: QualityKey
  /** 省流量：弹幕窗口里不加载画面（只挂弹幕 websocket） */
  saveData: boolean
  /** 开始监控/切换房间时自动把声音切过去 */
  audioOnConnect: boolean
  volume: number
  /** 每个房间在内存里保留的弹幕条数（库里是全量，受保留天数约束） */
  maxItems: number
  /** 要显示的弹幕类型 */
  kinds: DanmakuKind[]
  /** 弹幕列表自动跟随最新 */
  autoScroll: boolean
  /** 同时监控的房间数上限（每个房间一个隐藏窗口，超了排队） */
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
  series: Array<{ minute: number; chat: number; gift: number; member: number; like: number; social: number; diamonds: number }>
  /** 类型分布 */
  kinds: Array<{ kind: DanmakuKind; count: number }>
  topChat: UserRankRow[]
  topGift: UserRankRow[]
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
  gift: number
  diamonds: number
  member: number
  like: number
  social: number
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
