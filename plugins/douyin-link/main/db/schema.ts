import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  serial,
  text,
  uniqueIndex
} from 'drizzle-orm/pg-core'

/**
 * 抖音直播分析器 的表（9 张，全部带 `douyin_link_` 前缀——一个库里装着所有插件的表，撞名就是事故）。
 *
 * 三条约定（与宿主同规矩）：
 * - JS 键 camelCase，列名显式给 snake_case，mapper 里同一套键名；
 * - 时间戳一律 `doublePrecision` 存 **ms epoch**（直播数据是「秒级流水」，用整数毫秒最省事，
 *   也不踩时区坑；库里的原始时间就是分析用的时间轴）；
 * - 建表语句在 `./ddl.ts`（独立插件的 DDL 归插件自己，宿主不认识这些表）。
 *
 * 列名避开了保留字：`likes` / `follows` / `content`（`like` 是 Postgres 关键字，
 * `text` 作列名也和类型名撞脸，直接不用）。
 */

/** 房间清单：一个房间一行（不随监控开关消失，历史数据都挂在 webRid 下） */
export const douyinLinkRooms = pgTable('douyin_link_rooms', {
  webRid: text('web_rid').primaryKey().notNull(),
  roomId: text('room_id').notNull().default(''),
  title: text().notNull().default(''),
  anchor: text().notNull().default(''),
  cover: text().notNull().default(''),
  onlineText: text('online_text').notNull().default(''),
  status: text().notNull().default('unknown'),
  note: text().notNull().default(''),
  /** 期望是否监控（重启后按它决定要不要接着跑） */
  monitor: boolean().notNull().default(false),
  addedAt: doublePrecision('added_at').notNull().default(0),
  lastActiveAt: doublePrecision('last_active_at').notNull().default(0),
  lastSeenAt: doublePrecision('last_seen_at').notNull().default(0)
})

/** 消息流水（弹幕/进场/点赞/关注/礼物；stats 与系统提示不入库，它们不是互动） */
export const douyinLinkMessages = pgTable('douyin_link_messages', {
  id: serial().primaryKey().notNull(),
  webRid: text('web_rid').notNull(),
  /** 属于哪次监控会话（0 = 没有会话信息） */
  sessionId: integer('session_id').notNull().default(0),
  kind: text().notNull(),
  userId: text('user_id').notNull().default(''),
  userName: text('user_name').notNull().default(''),
  content: text().notNull().default(''),
  count: integer().notNull().default(0),
  /** 礼物的抖币总价值（单价 × 数量）；非礼物消息一律 0，`0` 也表示「官方没给价」 */
  diamonds: integer().notNull().default(0),
  /** 收礼人（礼物才有：谁收到了这份礼物） */
  toUserId: text('to_user_id').notNull().default(''),
  toUserName: text('to_user_name').notNull().default(''),
  /**
   * 点歌单号串（只有点歌那类有）：同一单的几次推送靠它合并成一行
   * （不带礼物记录的先到、带记录的后到 → 后者更新前者，见 `mapper.insertMessages`）。
   */
  orderKey: text('order_key').notNull().default(''),
  atMs: doublePrecision('at_ms').notNull()
})

/** 用户档案（**按房间**一份：同一个人在 A 房和 B 房的发言数当然不同） */
export const douyinLinkUsers = pgTable(
  'douyin_link_users',
  {
    id: serial().primaryKey().notNull(),
    webRid: text('web_rid').notNull(),
    userId: text('user_id').notNull(),
    displayId: text('display_id').notNull().default(''),
    nickname: text().notNull().default(''),
    gender: integer().notNull().default(0),
    signature: text().notNull().default(''),
    city: text().notNull().default(''),
    avatar: text().notNull().default(''),
    following: integer().notNull().default(0),
    follower: integer().notNull().default(0),
    honorLevel: integer('honor_level').notNull().default(0),
    fansClubLevel: integer('fans_club_level').notNull().default(0),
    badges: text().notNull().default('[]'),
    secUid: text('sec_uid').notNull().default(''),
    /**
     * **见过他在麦上**（0.15.32 起）：语音房麦位表 / 房间主播见过这个人就置 true，并且**一直留着**。
     *
     * 为什么要有这一列：「AI 画像」要分清**主播**与**观众**（用户 2026-10-13：「应该是分析主播
     * （个播、房间播有好多主播的）和用户，两者分开，现在都是按照用户的内容进行分析了」）。
     * 麦位是**运行态**（`recorder.micSeats`），关掉应用就没了，所以历史判定只能靠这一列
     * （「以收礼为主」那条启发式只作兜底）。
     */
    onMic: boolean('on_mic').notNull().default(false),
    chat: integer().notNull().default(0),
    enter: integer().notNull().default(0),
    likes: integer().notNull().default(0),
    follows: integer().notNull().default(0),
    /** 送出礼物的次数 */
    gift: integer().notNull().default(0),
    /** 送出礼物的抖币总额（0 = 没送过，或官方没给价） */
    diamonds: integer().notNull().default(0),
    firstSeen: doublePrecision('first_seen').notNull().default(0),
    lastSeen: doublePrecision('last_seen').notNull().default(0)
  },
  (table) => [uniqueIndex('uq_douyin_link_user_room').on(table.webRid, table.userId)]
)

/** 按分钟聚合的计数（趋势图与「活跃分钟」都读它；消息流水会按保留期清理，它留得久） */
export const douyinLinkMinutes = pgTable(
  'douyin_link_minutes',
  {
    id: serial().primaryKey().notNull(),
    webRid: text('web_rid').notNull(),
    /** 分钟桶：floor(ms / 60000) */
    minute: integer().notNull(),
    chat: integer().notNull().default(0),
    member: integer().notNull().default(0),
    likes: integer().notNull().default(0),
    social: integer().notNull().default(0),
    /** 该分钟的礼物条数与抖币总额 */
    gift: integer().notNull().default(0),
    diamonds: integer().notNull().default(0),
    messages: integer().notNull().default(0),
    users: integer().notNull().default(0)
  },
  (table) => [uniqueIndex('uq_douyin_link_minute').on(table.webRid, table.minute)]
)

/** 监控会话（每次「开始监控 → 停止/掉线」一条，界面上能看这段监控跑了多久、收了多少） */
export const douyinLinkSessions = pgTable('douyin_link_sessions', {
  id: serial().primaryKey().notNull(),
  webRid: text('web_rid').notNull(),
  startedAt: doublePrecision('started_at').notNull().default(0),
  endedAt: doublePrecision('ended_at').notNull().default(0),
  messages: integer().notNull().default(0),
  endReason: text('end_reason').notNull().default('')
})

/** 小键值表（零碎元数据） */
export const douyinLinkMeta = pgTable('douyin_link_meta', {
  key: text().primaryKey().notNull(),
  value: text().notNull().default(''),
  updatedAt: doublePrecision('updated_at').notNull().default(0)
})

/**
 * 画像（0.15.11 起）：**一个人可以有多个抖音账号，但画像只有一个**。
 *
 * 为什么要有这张表：抖音 id 才是身份（昵称会改、会重名，匿名时还会被占位串抹掉），
 * 而「同一个人开两个号」在直播场景里很常见——送礼榜/发言榜上他们本来就是两个人，
 * 但画像（RFM 分层、人格侧写、关系网）回答的是「这个人是谁」。绑定关系放这里，
 * 所有按人的聚合都先经 `resolveAccountIds()` 换成 id 集合再查。
 */
export const douyinLinkIdentities = pgTable('douyin_link_identities', {
  id: serial().primaryKey().notNull(),
  /** 画像名（用户可改；空 = 界面上退回主账号的最新昵称） */
  name: text().notNull().default(''),
  note: text().notNull().default(''),
  /** 主账号：界面上拿它的昵称/头像代表这个画像 */
  primaryUserId: text('primary_user_id').notNull().default(''),
  createdAt: doublePrecision('created_at').notNull().default(0),
  updatedAt: doublePrecision('updated_at').notNull().default(0)
})

/**
 * 画像 ↔ 抖音账号（多对一）。`user_id` 是主键 ⇒ **一个 id 只能属于一个画像**：
 * 这就是「关联一律走抖音 id」在数据层的落点（昵称永远不参与关联）。
 */
export const douyinLinkIdentityAccounts = pgTable(
  'douyin_link_identity_accounts',
  {
    userId: text('user_id').primaryKey().notNull(),
    identityId: integer('identity_id').notNull(),
    addedAt: doublePrecision('added_at').notNull().default(0)
  },
  (table) => [index('idx_douyin_link_identity_account_owner').on(table.identityId)]
)

/**
 * AI 画像（大模型生成，0.15.29 起）：**一个人一版，只留最新那一版**。
 *
 * 为什么必须落库（用户 2026-10-13：「需要保存这个画像，不然每一次都要重新生成，会很亏 token」）：
 * 生成一次 = 一次真金白银的模型调用。所以缓存键是主键、内容整份存下来，重开弹窗直接读；
 * `version` 记录「这是第几版」（用户可以不断重新生成、越刷越准），
 * `fingerprint`/`interactions` 记录**生成时的数据侧快照**——之后又攒了新数据时，
 * 界面据此如实提示「数据已更新，可重新生成」，而不是装作画像一直新鲜。
 *
 * 缓存键的口径见 `shared/ai-portrait.ts` 的 `portraitKeyOf`：绑定过多账号的人用画像 id，
 * 与确定性画像 / 礼物日历同口径。
 */
export const douyinLinkUserPortraits = pgTable('douyin_link_user_portraits', {
  /** 缓存键：`identity:<画像 id>:<角色>` 或 `user:<抖音 id>:<角色>` */
  portraitKey: text('portrait_key').primaryKey().notNull(),
  /** 画像锚点（打开弹窗时的那个人） */
  userId: text('user_id').notNull().default(''),
  identityId: integer('identity_id').notNull().default(0),
  /**
   * 这一版分析的角色（`viewer` / `host`）。
   *
   * 用户 2026-10-13：「应该是分析主播（个播、房间播有好多主播的）和用户，两者分开」——
   * 同一份流水按观众口径问和按主播口径问是两个答案，所以角色**必须随画像一起落库**，
   * 否则读回缓存时无法说清「这版到底在说谁」。
   */
  role: text().notNull().default('viewer'),
  /** 第几版（重新生成递增；每个角色各自递增） */
  version: integer().notNull().default(0),
  providerId: integer('provider_id').notNull().default(0),
  providerName: text('provider_name').notNull().default(''),
  model: text().notNull().default(''),
  /** 报告是否是结构化的（否 = 模型没按 JSON 回，正文在 `raw` 里） */
  structured: boolean().notNull().default(false),
  /** 结构化报告的 JSON（`structured = false` 时是空串） */
  report: text().notNull().default(''),
  /** 模型原文（结构化成功也留着：排查与「看原文」用） */
  raw: text().notNull().default(''),
  fingerprint: text().notNull().default(''),
  interactions: integer().notNull().default(0),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  generatedAt: doublePrecision('generated_at').notNull().default(0),
  updatedAt: doublePrecision('updated_at').notNull().default(0)
})
