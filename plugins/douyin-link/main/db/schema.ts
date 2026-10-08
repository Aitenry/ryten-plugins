import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  uniqueIndex
} from 'drizzle-orm/pg-core'

/**
 * 抖音直播分析器 的表（6 张，全部带 `douyin_link_` 前缀——一个库里装着所有插件的表，撞名就是事故）。
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

/** 消息流水（弹幕/进场/点赞/关注；stats 与系统提示不入库，它们不是互动） */
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
    chat: integer().notNull().default(0),
    enter: integer().notNull().default(0),
    likes: integer().notNull().default(0),
    follows: integer().notNull().default(0),
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
