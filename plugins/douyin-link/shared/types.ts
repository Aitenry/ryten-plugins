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

/**
 * 神秘人的**真实资料**（我们库里藏着一个 id 都查不到的那种）。
 *
 * 与 `UserProfile` 不同：这份不是「我们观察到的」，而是拿用户 id 去抖音的 web 端
 * 用户资料接口**当场问回来的**——昵称、头像、粉丝数都是账号本人的，跟直播间里的匿名马甲无关。
 * 头像由主进程下载成 data URL（渲染层 CSP 不许外链图片）。
 */
export interface MysteryProfile {
  userId: string
  nickname: string
  /** 抖音号（接口的 `unique_id`；拿不到时是空串） */
  displayId: string
  secUid: string
  signature: string
  /** 1 = 男，2 = 女，其它 = 未知（与 `UserInfo.gender` 同一口径） */
  gender: number
  /** IP 归属地 / 城市（接口不一定给） */
  region: string
  follower: number
  following: number
  /** 作品数 */
  awemeCount: number
  /** 获赞总数 */
  totalFavorited: number
  /** 认证文案（个人认证 / 企业认证；没有就是空串） */
  verified: string
  /** 头像 data URL（主进程下载；失败为空串，界面用首字兜底） */
  avatar: string
}

/** 「查看神秘人信息」的结果：成功给资料，失败给一个可翻译的失败码 */
export type MysteryReveal =
  | { ok: true; profile: MysteryProfile }
  | { ok: false; code: 'badInput' | 'network' | 'notFound' | 'badResponse'; detail?: string }

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
   * 计数：点赞数（like）/ 进场后的在线人数（member）/ **礼物数量**（gift）。
   *
   * 礼物那一项是**本次增量**（同一次连送的累积量之差，见 `main/gift/group.ts`），
   * 不是服务端推的累积量。0 = 无。
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
  /**
   * **诊断用**：这条是哪个解码器产出来的（`proto-gift` / `proto-order` / `json-gift`…）。
   *
   * 只进内存、不进库：库里出现「礼物名空、收礼人有」这种行时，只有它能说清是谁写的
   * （2026-10-08 的排查就是卡在这里——两种解码器都能产出空名字，日志里看不出是哪一种）。
   */
  trace?: string
  /**
   * **点歌单号串**（只有点歌那类有）。
   *
   * 一个订单会被推好几次：**先来一条没有礼物记录的、稍后再来一条带记录的**（实测相隔 16 秒~3.5 分钟，
   * 两次的 `6.1` 与 `6.5.1.3` 是同一个串）。落库时按它**合并成一行**——
   * 否则同一单会留下「一行没名字 + 一行有名字」，礼物榜里就多出一条「（礼物名未知）」。
   */
  orderKey?: string
  /**
   * **这一帧里带着礼物记录**（有礼物 id、有单价）——点歌那类用它区分同一单的两条推送：
   * 一条有记录（能解出礼物名与价格）、一条没有（只能解出「想听 X 演唱」）。
   *
   * 落库合并（`main/db/mapper.ts` 的 `mergeGiftRows`）只让**有记录**的那条覆盖正文与价格，
   * 否则后到的那条没记录的帧会把已经查到的礼物名抹成「想听 X 演唱」（实测两种先后顺序都出现过）。
   */
  giftRecord?: boolean
  /**
   * **礼物 id**（`GiftStruct.id` / `GiftMessage.gift_id`；只有真礼物 `WebcastGiftMessage` 才有）。
   * 用于「同一次连送」的分组去重（见 `main/gift/group.ts`）。
   */
  giftId?: number
  /**
   * **礼物组 id**（`GiftMessage.group_id`；只有真礼物才有）。
   *
   * 抖音对**同一次连送**会反复推**累积数量**（`1→2→5→5`）；逐帧落库会把它们全加起来
   * （重复计数）。落库前按 `group_id + 送礼人 + 收礼人 + 礼物 id` 分组，用历史最大累积量
   * 算「本次增量」，只把增量写进 `count` / `diamonds`（见 `main/gift/group.ts`）。
   */
  groupId?: string
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
  /** 弹幕列表自动跟随最新 */
  autoScroll: boolean
  /**
   * **登录态 Cookie**（从抖音网页版复制，形如 `ttwid=…; passport_csrf_token=…; sessionid=…`）。
   *
   * 为什么需要：**平台只向「已登录会话」推送礼物消息**（`WebcastGiftMessage`），匿名会话在普通
   * 直播间基本收不到礼物（当前插件在聊天室能拿到礼物，是因为那条走的是点歌 `…OrderSingMessage`）。
   * 填上你自己账号的 Cookie 后，实时通道握手会带上它，普通直播间也能收到礼物。
   *
   * 留空 = 匿名（礼物可能收不到，但不影响弹幕/进场/点赞）。只存在本机数据库里，不随插件分发。
   */
  douyinCookie: string
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
  /** 窗口内的礼物流水按礼物名聚合（「送了什么、值多少」看这里；空数组 = 窗口内没有礼物） */
  gifts: GiftBreakdownRow[]
  /**
   * **收礼物榜**：窗口内**在麦上**的那些人各收到了多少礼物值（用户 2026-10-08 的要求：
   * 「改为收礼物榜，并且只要麦上收礼物的人员礼物值」）。空数组 = 没有麦位信息或麦上没人收过礼物。
   */
  received: GiftRankRow[]
  /** **送礼物榜**：窗口内谁送出的礼物值最多（同名次同钻，按人聚合） */
  sent: GiftRankRow[]
  /** 类型分布 */
  kinds: Array<{ kind: DanmakuKind; count: number }>
  topChat: UserRankRow[]
}

/**
 * 主进程推送的概览快照（概览页签的实时更新）。
 *
 * 概览里的每一项都来自数据库聚合（KPI、分钟趋势、类型分布、用户榜、两张礼物榜），
 * 界面自己轮询只能「每 10 秒看一眼」。主进程**在落库之后**（此刻数据才是真的）按界面
 * 请求过的窗口重算一份推过来，界面直接替换——这样关掉页面数据不丢、开着页面就是活的。
 */
export interface SummaryPush {
  webRid: string
  summary: RoomSummary
  sessions: MonitorSession[]
}

/**
 * **单个直播间**在窗口内的分钟序列（数据大屏「指标」页签的原始素材）。
 *
 * 与 `AllRoomsAnalysis.series`（跨房**合计**的一条曲线）互补：这一份是**每房一条**，
 * 所以能画「动态排序柱状图 / 日内走势 / 按小时分布」这类**房间之间横向比**的细节图。
 * 主进程按与全局趋势同一套分桶口径（补齐缺口、按跨度合并成最多 240 个点）算好再推，
 * 渲染层只负责画——`minute` 是该桶起点的 ms epoch。
 */
export interface RoomSeriesRow {
  webRid: string
  title: string
  anchor: string
  status: 'live' | 'ended' | 'unknown'
  phase: MonitorPhase
  /** 窗口内的分钟序列（至少一个桶有礼物才会被收进来，空房间不占位） */
  series: Array<{ minute: number; diamonds: number; gift: number; chat: number }>
}

/**
 * **跨直播间**的聚合分析（「数据大屏模式」的全局分析页签）。
 *
 * 与 `RoomSummary`（单房间）相对：这里的所有口径都是**所有直播间合起来**的——
 * 两张按人的礼物榜把同一个人跨房间的礼物合并成一行（`user_id` / `to_user_id` 分组），
 * 全局人数按 userId 去重（不重复计跨房出现的同一个人），`perRoom` 给出每房间的流水横截面。
 */
export interface AllRoomsAnalysis {
  /** 有效的统计窗口（分钟；0 = 全部） */
  minutes: number
  /** 实际跨度（分钟；用于平均速率的分母） */
  windowMinutes: number
  /** 房间总数 / 在播数 */
  rooms: number
  liveRooms: number
  messages: number
  chat: number
  member: number
  like: number
  social: number
  /** 礼物件数 */
  gift: number
  /** 礼物抖币总额 */
  diamonds: number
  /** 全局活跃用户（按 userId 去重，跨房出现的同一个人只算一次） */
  users: number
  firstAt: number
  lastAt: number
  /** 全局分钟趋势（跨房合计，主进程补齐缺口并分桶） */
  series: Array<{ minute: number; chat: number; member: number; like: number; social: number; gift: number }>
  /** 总送礼物榜（跨房按人合并；`seat` 恒 0） */
  sent: GiftRankRow[]
  /** 总收礼物榜（跨房按人合并；`seat` 恒 0） */
  received: GiftRankRow[]
  /** 礼物种类榜（跨房按礼物名聚合） */
  gifts: GiftBreakdownRow[]
  /** 每个直播间的流水横截面（口径同对比页签） */
  perRoom: RoomCompareRow[]
  /**
   * 每个直播间在窗口内的**分钟序列**（数据大屏「指标」页签：动态排序柱状图 / 日内走势 /
   * 按小时分布都从它算）。只含窗口内有过礼物的房间，其余不占位。
   */
  roomSeries: RoomSeriesRow[]
}

/** 主进程推送的全局分析快照（数据大屏的实时更新；形状同 `SummaryPush`） */
export interface AllAnalysisPush {
  analysis: AllRoomsAnalysis
}

/**
 * 礼物榜（收礼 / 送礼）的一行：**一个人**在窗口内的礼物合计。
 *
 * 与 `GiftBreakdownRow`（按礼物名聚合）互补：那个回答「送了什么」，这个回答「谁收/谁送、值多少」，
 * 点一行能翻出这个人的礼物历史（送礼人或收礼人口径）。
 */
export interface GiftRankRow {
  userId: string
  /** 昵称（库里记的最近一次；拿不到就是空串，界面显示用户 id） */
  name: string
  /** 礼物件数 */
  count: number
  /** 抖币总额（0 = 这些礼物官方都没给价） */
  diamonds: number
  /** 最近一次礼物时间（ms） */
  lastAt: number
  /** 麦位序号（1 起；0 = 不在麦上）。收礼物榜只收 > 0 的人，并按麦位序排 */
  seat: number
}

/**
 * 「礼物流水」按**礼物名**聚合出来的一行（概览的礼物榜 / 用户礼物明细都用它）。
 *
 * 为什么要有它：礼物的名字与价格是解码时按礼物 id 查目录补上的，落在消息的正文里；
 * 界面上只有「次数」的列是看不出「送的是什么、值多少」的（用户 2026-10-08 反馈
 * 「只有送礼物的次数，没有地方看」），所以这里按名字把件数与抖币合起来给一张表。
 */
export interface GiftBreakdownRow {
  /** 礼物名（`messages.content`；目录查不到名字时是空串，界面显示成「（礼物名未知）」） */
  name: string
  /** 送出的件数（一条消息按它自带的数量算，连击会来多条） */
  count: number
  /** 抖币总额（0 = 目录里没给价） */
  diamonds: number
  /** 有多少个人送过它 */
  users: number
}

/**
 * 用户榜的一页（服务端分页）。
 *
 * 为什么要有它：用户榜以前固定只取前 300 条，超出的人**永远翻不到**。
 * 改成「一页一页查」之后，`total` 让界面知道总人数与页数（见 `UsersPanel`）。
 */
export interface UserRankPage {
  rows: UserRankRow[]
  /** 命中总人数（用于「共 N 人」与翻页） */
  total: number
}

/** 榜单 / 用户列表的一行（= 用户档案的「库口径」，统计是跨会话累计的） */export interface UserRankRow {
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

/* --------------------------------------------- 「分析用户」画像（规则算法，不依赖大模型） */

/**
 * 画像的一个评分项：**维度**或**行为原型**（`key` 是稳定的机器键，界面本地化；`score` 0-100）。
 *
 * 为什么给机器键而不是直接给人话：主进程不能产出中文/英文——文案必须留在
 * `locales/*` 里（跟插件其它文案一套机制），所以打分只输出键，由界面拼句。
 */
export interface UserAnalysisScore {
  key: string
  score: number
}

/** 画像结论里的一条要点：`key` 机器键 + `params` 参数（界面按当前语言拼句） */
export interface UserAnalysisInsight {
  key: string
  params: Record<string, string | number>
}

/** 画像用到的量化事实（界面直接显示数字；不本地化，只做格式化） */
export interface UserAnalysisFacts {
  /** 距最近一次出现的小时数 */
  recencyHours: number
  /** 出现过的天数（按本地时区分天） */
  activeDays: number
  /** 首末出现跨度（天） */
  spanDays: number
  /** 累计送出抖币 */
  monetary: number
  /** 单次平均抖币（无送礼为 0） */
  avgGift: number
  /** 最活跃的小时（0-23；无数据为 -1） */
  peakHour: number
  /** 情感倾向（-100 消极 ~ +100 积极；0 = 中性/无词命中） */
  sentiment: number
  /** 正面词命中数 */
  positive: number
  /** 负面词命中数 */
  negative: number
  /** 送得最多的礼物名（没有为空串） */
  topGiftName: string
  /** 该礼物的件数 / 抖币 */
  topGiftCount: number
  topGiftDiamonds: number
  /** 送过的礼物种类数 */
  giftKinds: number
  /** 送礼对象去重个数（1 = 定向给同一个人，多 = 泛社交） */
  recipients: number
}

/**
 * 弹幕文本分析结果（**只看这个人自己发的弹幕**，纯词典法 + 规则统计，不依赖大模型）。
 *
 * 维度设计参考情绪心理学与语用学：
 * - **情绪效价 valence + 唤起度 arousal**：Russell 情绪环状模型的两个主轴（愉悦度 × 激活度），
 *   比单一「积极/消极」更能刻画情绪状态（同样开心，高唤起的「啊啊啊」与低唤起的「舒服」不同）；
 * - **内容主题**：按直播语用把弹幕分成赞美 / 提问 / 应援 / 玩梗 / 催促 / 打招呼 / 闲聊，
 *   用来判断这个人在直播间里「说什么、想干什么」；
 * - **语言特征**：平均字数、表情率、疑问率、外放率、重复率，作为人格与动机的行为线索。
 */
export interface UserAnalysisChat {
  /** 参与分析的弹幕样本数 */
  sampleCount: number
  /** 平均字数（保留 1 位小数） */
  avgLength: number
  /** 使用表情符号的弹幕占比（0-100）：`[名字]` 方括号表情或 unicode emoji */
  emojiRate: number
  /** 带 @提及 的弹幕占比（0-100） */
  mentionRate: number
  /** 疑问句占比（0-100） */
  questionRate: number
  /** 外放表达（感叹号 / 叠字 / 强化词）占比（0-100） */
  exclaimRate: number
  /** 重复刷屏占比（0-100） */
  repeatRate: number
  /** 情绪效价（-100 消极 ~ +100 积极；0 = 中性） */
  valence: number
  /** 情绪唤起度（0 平静 ~ 100 激动） */
  arousal: number
  /** 内容主题占比（机器键 + 百分比打分，按占比降序，最多 6 项） */
  topics: UserAnalysisScore[]
  /** 高频关键词（最多 8 个，纯展示；无数据为空数组） */
  keywords: string[]
}

/**
 * 关系网里的一个人：该用户**送礼的对象**，或**送礼给该用户的人**。
 * 一条边 = 一个人（同一对关系在多条礼物帧里被聚合）。
 */
export interface UserAnalysisPeer {
  /** 对方 userId */
  userId: string
  /** 昵称（消息流水里记的；可能为空 → 界面显示 id 尾号） */
  name: string
  /** 抖币总额 */
  diamonds: number
  /** 礼物件数 */
  items: number
  /** 互动次数（礼物条数） */
  hits: number
  /** 占该方向抖币总额的百分比（0-100） */
  share: number
  /** 最近一次时间（ms，0 = 未知） */
  lastAt: number
}

/** 送礼习惯：把礼物流水按时间 / 种类 / 对象摊开看 */
export interface UserAnalysisGifting {
  /** 送过礼的天数（本地时区分天） */
  giftDays: number
  /** 平均每个送礼日的送礼次数 */
  perDay: number
  /** 单笔最大抖币 */
  maxGift: number
  /** 最常送的礼物占总抖币的百分比（0-100） */
  topGiftShare: number
  /** 送礼时段高峰（0-23；-1 = 无） */
  peakHour: number
  /** 送礼时间跨度（天） */
  spanDays: number
  /** 24 小时送礼分布（仅礼物条数） */
  hours: number[]
  /** 送礼对象去重个数 */
  recipients: number
  /** 最青睐对象的占比（0-100） */
  topRecipientShare: number
  /** 最青睐对象的昵称 / id 尾号（无为空串） */
  topRecipientName: string
}

/** 人物关系网：以本人为中心的**一跳图**（谁给谁送了礼） */
export interface UserAnalysisNetwork {
  /** 本人 → 对方（本人送出的礼） */
  outgoing: UserAnalysisPeer[]
  /** 对方 → 本人（本人收到的礼） */
  incoming: UserAnalysisPeer[]
  /** 本人送出的总抖币 */
  outTotal: number
  /** 本人收到的总抖币 */
  inTotal: number
}

/**
 * 「分析用户」的用户画像结果。
 *
 * 方法论（**确定性规则，不依赖大模型**，见 `main/analysis/portrait.ts`）：
 * - 价值分层用经典的 **RFM**（Recency / Frequency / Monetary）；
 * - 行为原型借鉴 **Bartle 玩家类型学**（社交 / 认同 / 消费 / 氛围 / 旁观）适配直播场景；
 * - 人格侧写用 **大五人格模型（Big Five / OCEAN）**：由弹幕与行为做**行为侧写**（behavioral proxy），
 *   只表示「从数据里看到的行为倾向」，不是临床人格判定；
 * - 动机结构借 **自我决定论（SDT）** 的基本心理需求：社交连接 / 身份认同 / 内容欣赏 / 习惯陪伴；
 * - 弹幕文本用**词典法情感分析 + 语用主题分类**（情绪效价与唤起度、内容主题、语言特征）；
 * - 送礼习惯把礼物流水按**时段 / 种类 / 对象**摊开（频率、单笔峰值、礼物与对象的集中度）；
 * - 人物关系网是**以本人为中心的一跳图**（本人送出的对象 + 送礼给本人的人），用于看「青睐谁」。
 * 所有分值都是「现有数据 → 归一化 → 加权」的纯函数结果，同一份数据同一天必然同一份结论。
 */
export interface UserAnalysis {
  /** 数据是否足以成画（互动太少 → false，界面给一句说明） */
  hasData: boolean
  /** 主行为原型（机器键；`balanced` = 无明显主导） */
  archetype: string
  /** 主原型的置信度（0-100，= 主原型占比） */
  confidence: number
  /** 全部原型的评分（按分数降序） */
  archetypes: UserAnalysisScore[]
  /** 六个维度的评分（顺序固定：消费力 / 活跃度 / 社交性 / 忠诚度 / 情绪热度 / 身份标识） */
  traits: UserAnalysisScore[]
  /** 大五人格行为侧写（固定顺序：开放性 / 尽责性 / 外向性 / 宜人性 / 情绪稳定性） */
  personality: UserAnalysisScore[]
  /** 最突出的人格维度（机器键） */
  personalityTop: string
  /** 动机结构（固定顺序：社交连接 / 身份认同 / 内容欣赏 / 习惯陪伴） */
  motivations: UserAnalysisScore[]
  /** 主导动机（机器键） */
  motivationTop: string
  /** 弹幕文本分析 */
  chat: UserAnalysisChat
  /** 送礼习惯 */
  gifting: UserAnalysisGifting
  /** 人物关系网（一跳） */
  network: UserAnalysisNetwork
  /** 命中的标签（机器键；顺序稳定，最多 6 个） */
  tags: string[]
  /** 结论文本要点（机器键 + 参数；最多 8 条） */
  insights: UserAnalysisInsight[]
  /** 量化事实 */
  facts: UserAnalysisFacts
}

/** 消息检索条件（全部可选；空条件 = 最近的消息） */
export interface MessageQuery {
  /** 房间号；'' = 所有房间 */
  webRid?: string
  /** 关键词（匹配正文或昵称） */
  keyword?: string
  kind?: DanmakuKind | ''
  /** 发送者 id */
  userId?: string
  /**
   * **收礼人 id**（礼物才有：`messages.to_user_id`）。
   * 「某人收到的礼物历史」就是 `kind = 'gift'` + 这个条件。
   */
  toUserId?: string
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

/**
 * **一天**的直播记录（左侧「每日记录」列表的一行）。
 *
 * 为什么按天：直播是「一天一场」的东西——用户 2026-10-08 的要求是「要按照每一天的直播来保存，
 * 有一个每一天的监听列表，点击后才显示当前的详细信息」。这份聚合是**按本地时区**分天的
 * （当天 00:00 → 次日 00:00），点一行就把详情页的时间范围切到那一天。
 */
export interface DayRecordRow {
  /** 本地日期 `YYYY-MM-DD` */
  day: string
  /** 这一天第一/最后一条消息的时刻（ms；0 = 这一天没有消息） */
  firstAt: number
  lastAt: number
  /** 消息条数（含未计入互动的类型） */
  messages: number
  /** 礼物条数与抖币总额 */
  gifts: number
  diamonds: number
  /** 这一天出现过的用户数（按消息里的用户 id 去重） */
  users: number
  /** 这一天开过几次监控会话 */
  sessions: number
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

/**
 * 导出压缩包的结果（设置页「导出数据」）。
 *
 * 包内结构：`manifest.json` + `rooms.json` + `users/<webRid>.json` +
 * `records/<webRid>/<YYYY-MM-DD>.json`（每个 JSON = 某房间某一天的直播数据）。
 */
export interface ExportResult {
  ok: boolean
  /** 落盘路径（取消 / 失败时是空串） */
  path: string
  rooms: number
  /** 打进去的「房间 × 天」文件数 */
  days: number
  messages: number
  /** 失败 / 取消的原因（可翻译的键或原文） */
  message?: string
}

/** 导入压缩包的结果（重复导入同一份包时 `added` 为 0、`skipped` 为全部） */
export interface ImportResult {
  ok: boolean
  /** 新增的房间数（已存在的房间不算） */
  rooms: number
  /** 新写入的消息条数 */
  messages: number
  /** 因库里已有（或包内重复）而跳过的消息条数 */
  skipped: number
  /** 导入的用户档案行数 */
  users: number
  message?: string
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
