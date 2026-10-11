import { sql } from 'drizzle-orm'
import logger from 'electron-log'
import { withOrm } from '@host/main/database/orm'

/**
 * 抖音直播分析器 自带建表（独立插件的 DDL 归插件自己，宿主不认识这些表）。
 *
 * 两条约束：
 * - **幂等**：一律 `IF NOT EXISTS`，插件每次装载都会跑一遍；
 * - **只动自己的表**：表名一律带 `douyin_link_` 前缀。
 *
 * 列的口径与 `./schema.ts` 的 drizzle 定义**逐一对齐**（改一处必须改另一处）。
 * 宿主用的是 PGlite（进程内 Postgres），所以走 Postgres 方言：`BIGSERIAL` / `DOUBLE PRECISION`。
 */
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS douyin_link_rooms (
     web_rid        TEXT PRIMARY KEY,
     room_id        TEXT NOT NULL DEFAULT '',
     title          TEXT NOT NULL DEFAULT '',
     anchor         TEXT NOT NULL DEFAULT '',
     cover          TEXT NOT NULL DEFAULT '',
     online_text    TEXT NOT NULL DEFAULT '',
     status         TEXT NOT NULL DEFAULT 'unknown',
     note           TEXT NOT NULL DEFAULT '',
     monitor        BOOLEAN NOT NULL DEFAULT FALSE,
     added_at       DOUBLE PRECISION NOT NULL DEFAULT 0,
     last_active_at DOUBLE PRECISION NOT NULL DEFAULT 0,
     last_seen_at   DOUBLE PRECISION NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS douyin_link_messages (
     id         BIGSERIAL PRIMARY KEY,
     web_rid    TEXT NOT NULL,
     session_id INTEGER NOT NULL DEFAULT 0,
     kind       TEXT NOT NULL,
     user_id    TEXT NOT NULL DEFAULT '',
     user_name  TEXT NOT NULL DEFAULT '',
     content    TEXT NOT NULL DEFAULT '',
     count      INTEGER NOT NULL DEFAULT 0,
     diamonds   INTEGER NOT NULL DEFAULT 0,
     to_user_id   TEXT NOT NULL DEFAULT '',
     to_user_name TEXT NOT NULL DEFAULT '',
     order_key    TEXT NOT NULL DEFAULT '',
     at_ms      DOUBLE PRECISION NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_douyin_link_msg_room_time ON douyin_link_messages (web_rid, at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_douyin_link_msg_time ON douyin_link_messages (at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_douyin_link_msg_room_kind ON douyin_link_messages (web_rid, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_douyin_link_msg_room_user ON douyin_link_messages (web_rid, user_id)`,
  `CREATE TABLE IF NOT EXISTS douyin_link_users (
     id              SERIAL PRIMARY KEY,
     web_rid         TEXT NOT NULL,
     user_id         TEXT NOT NULL,
     display_id      TEXT NOT NULL DEFAULT '',
     nickname        TEXT NOT NULL DEFAULT '',
     gender          INTEGER NOT NULL DEFAULT 0,
     signature       TEXT NOT NULL DEFAULT '',
     city            TEXT NOT NULL DEFAULT '',
     avatar          TEXT NOT NULL DEFAULT '',
     following       INTEGER NOT NULL DEFAULT 0,
     follower        INTEGER NOT NULL DEFAULT 0,
     honor_level     INTEGER NOT NULL DEFAULT 0,
     fans_club_level INTEGER NOT NULL DEFAULT 0,
     badges          TEXT NOT NULL DEFAULT '[]',
     sec_uid         TEXT NOT NULL DEFAULT '',
     chat            INTEGER NOT NULL DEFAULT 0,
     enter           INTEGER NOT NULL DEFAULT 0,
     likes           INTEGER NOT NULL DEFAULT 0,
     follows         INTEGER NOT NULL DEFAULT 0,
     gift            INTEGER NOT NULL DEFAULT 0,
     diamonds        INTEGER NOT NULL DEFAULT 0,
     first_seen      DOUBLE PRECISION NOT NULL DEFAULT 0,
     last_seen       DOUBLE PRECISION NOT NULL DEFAULT 0
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_douyin_link_user_room ON douyin_link_users (web_rid, user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_douyin_link_user_room_chat ON douyin_link_users (web_rid, chat DESC)`,
  `CREATE TABLE IF NOT EXISTS douyin_link_minutes (
     id       SERIAL PRIMARY KEY,
     web_rid  TEXT NOT NULL,
     minute   INTEGER NOT NULL,
     chat     INTEGER NOT NULL DEFAULT 0,
     member   INTEGER NOT NULL DEFAULT 0,
     likes    INTEGER NOT NULL DEFAULT 0,
     social   INTEGER NOT NULL DEFAULT 0,
     gift     INTEGER NOT NULL DEFAULT 0,
     diamonds INTEGER NOT NULL DEFAULT 0,
     messages INTEGER NOT NULL DEFAULT 0,
     users    INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_douyin_link_minute ON douyin_link_minutes (web_rid, minute)`,
  `CREATE TABLE IF NOT EXISTS douyin_link_sessions (
     id         SERIAL PRIMARY KEY,
     web_rid    TEXT NOT NULL,
     started_at DOUBLE PRECISION NOT NULL DEFAULT 0,
     ended_at   DOUBLE PRECISION NOT NULL DEFAULT 0,
     messages   INTEGER NOT NULL DEFAULT 0,
     end_reason TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS idx_douyin_link_session_room ON douyin_link_sessions (web_rid, started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS douyin_link_meta (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL DEFAULT '',
     updated_at DOUBLE PRECISION NOT NULL DEFAULT 0
   )`,
  /**
   * **画像**（0.15.11 起）：一个人可以有多个抖音账号，但画像只有一个。
   *
   * 两处刻意的设计：
   * - `identity_accounts.user_id` 是**主键**：一个抖音 id 只能属于一个画像（id 才是身份，
   *   昵称会改、会重名，所以关联一律走 id）；
   * - 影像是**全局**的（不带 `web_rid`）：画像回答的是「这个人在这个平台什么样」，
   *   同一个人在 A 房和 B 房是同一个人（与 `userAnalysis` 的跨房口径一致）。
   */
  `CREATE TABLE IF NOT EXISTS douyin_link_identities (
     id              BIGSERIAL PRIMARY KEY,
     name            TEXT NOT NULL DEFAULT '',
     note            TEXT NOT NULL DEFAULT '',
     primary_user_id TEXT NOT NULL DEFAULT '',
     created_at      DOUBLE PRECISION NOT NULL DEFAULT 0,
     updated_at      DOUBLE PRECISION NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS douyin_link_identity_accounts (
     user_id     TEXT PRIMARY KEY,
     identity_id BIGINT NOT NULL,
     added_at    DOUBLE PRECISION NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_douyin_link_identity_account_owner ON douyin_link_identity_accounts (identity_id)`,
  /**
   * **AI 画像**（大模型生成，0.15.29 起）：一个人一版、只留最新。
   *
   * 生成一次要花 token，所以整份报告落库（`report` 是结构化 JSON，`raw` 是模型原文）；
   * `fingerprint`/`interactions` 是生成当时的数据侧快照，用来判断「之后数据又涨了」。
   * 缓存键（`portrait_key`）口径见 `shared/ai-portrait.ts`。
   */
  `CREATE TABLE IF NOT EXISTS douyin_link_user_portraits (
     portrait_key  TEXT PRIMARY KEY,
     user_id       TEXT NOT NULL DEFAULT '',
     identity_id   BIGINT NOT NULL DEFAULT 0,
     role          TEXT NOT NULL DEFAULT 'viewer',
     version       INTEGER NOT NULL DEFAULT 0,
     provider_id   INTEGER NOT NULL DEFAULT 0,
     provider_name TEXT NOT NULL DEFAULT '',
     model         TEXT NOT NULL DEFAULT '',
     structured    BOOLEAN NOT NULL DEFAULT FALSE,
     report        TEXT NOT NULL DEFAULT '',
     raw           TEXT NOT NULL DEFAULT '',
     fingerprint   TEXT NOT NULL DEFAULT '',
     interactions  INTEGER NOT NULL DEFAULT 0,
     input_tokens  INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     generated_at  DOUBLE PRECISION NOT NULL DEFAULT 0,
     updated_at    DOUBLE PRECISION NOT NULL DEFAULT 0
   )`,
  /**
   * AI 画像的**角色**（0.15.32 起）：`viewer` = 观众画像，`host` = 主播画像。
   *
   * 用户 2026-10-13：「应该是分析主播（个播、房间播有好多主播的）和用户，两者分开」。
   * 角色进了缓存键（`identity:<id>:<viewer|host>`），老库里 `identity:<id>` 那样的旧行自然过期，
   * 不需要迁移内容；这条 ALTER 只保证**已有库**也有这一列（旧行按观众读）。
   */
  `ALTER TABLE douyin_link_user_portraits ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'viewer'`,
  /**
   * 礼物功能的列迁移（**幂等**，0.7.1 起）。
   *
   * 背景：0.7.0 曾把礼物整体下线，并在这里 `DROP COLUMN` 掉了这些列（含「收礼人」两列）。
   * 0.7.1 把礼物接回来、0.7.4 又把**收礼人**接回来（点歌那一帧里既有送礼人也有收礼人的
   * `User`，见 `main/douyin/proto-messages.ts`），所以要：
   * - 把 0.7.0 那几条 `DROP COLUMN` 换成 `ADD COLUMN IF NOT EXISTS`——
   *   `CREATE TABLE IF NOT EXISTS` 对**已存在的旧库完全无效**，不加这几条，老库永远缺列，
   *   写库时会直接报「column does not exist」；
   * - **不要再删 `kind = 'gift'` 的历史行**（0.7.0 那句 `DELETE` 必须去掉，否则每次启动都把
   *   刚收到的礼物记录清掉）。
   *
   * `douyin_link_gifts`（0.5.7 的礼物目录缓存）不再需要：礼物名与价格现在直接从推送帧里解，
   * 所以那张表继续 DROP，不再重建。
   */
  `ALTER TABLE douyin_link_messages ADD COLUMN IF NOT EXISTS diamonds INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE douyin_link_messages ADD COLUMN IF NOT EXISTS to_user_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE douyin_link_messages ADD COLUMN IF NOT EXISTS to_user_name TEXT NOT NULL DEFAULT ''`,
  /**
   * 点歌单号（0.7.8 起）：同一单会推好几帧——不带礼物记录的先到（只能解出「想听 X 演唱」），
   * 带记录的后到（有礼物名/价格）——两帧的**单号完全相同**，靠它合并成一行（见 `mapper.insertMessages`）。
   */
  `ALTER TABLE douyin_link_messages ADD COLUMN IF NOT EXISTS order_key TEXT NOT NULL DEFAULT ''`,
  `CREATE INDEX IF NOT EXISTS idx_douyin_link_msg_room_order ON douyin_link_messages (web_rid, order_key)`,
  `ALTER TABLE douyin_link_users ADD COLUMN IF NOT EXISTS gift INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE douyin_link_users ADD COLUMN IF NOT EXISTS diamonds INTEGER NOT NULL DEFAULT 0`,
  /**
   * **见过他在麦上**（0.15.32 起，粘性）：AI 画像要分清主播与观众（用户 2026-10-13）。
   * 麦位是运行态（`recorder.micSeats`），关掉应用就没了，所以把「见过他在麦上」落成布尔列，
   * 写入端只做 `on_mic OR EXCLUDED.on_mic`（一旦 true 不再回退）。
   */
  `ALTER TABLE douyin_link_users ADD COLUMN IF NOT EXISTS on_mic BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE douyin_link_minutes ADD COLUMN IF NOT EXISTS gift INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE douyin_link_minutes ADD COLUMN IF NOT EXISTS diamonds INTEGER NOT NULL DEFAULT 0`,
  `DROP INDEX IF EXISTS idx_douyin_link_user_room_diamonds`,
  /**
   * 「按人跨房间」的两个查询（0.15.13：实时列表行首的等级/消费评分/入场次数/今日消费）：
   * - `douyin_link_users (user_id)`：跨房间把某个人的档案行一次捞出来（入场次数合计、本房间档案）；
   * - `douyin_link_messages (user_id, at_ms DESC)`：跨房间按人 + 时间范围筛（「今天消费」的补种）。
   *
   * 已有的是 `(web_rid, user_id)` 与 `(web_rid, at_ms)` 那几条——**房间在前**，按人查用不上。
   */
  `CREATE INDEX IF NOT EXISTS idx_douyin_link_user_id ON douyin_link_users (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_douyin_link_msg_user_time ON douyin_link_messages (user_id, at_ms DESC)`,
  `DROP TABLE IF EXISTS douyin_link_gifts`
]

/** 建表承诺：mapper / purge 都先 await 它，保证不会有访问跑到建表之前 */
export const schemaReady: Promise<void> = (async () => {
  await withOrm('douyin-link.ensureSchema', async (db) => {
    for (const statement of DDL) await db.execute(sql.raw(statement))
  })
  logger.info('[douyin-link] 表结构已就绪（9 张 douyin_link_* 表）')
})().catch((error) => {
  logger.error('[douyin-link] 建表失败，插件将无法读写数据:', error)
  throw error
})

/** 清数据用：把插件自己的表清空（表结构留着，下次装载照旧能写） */
export const PURGE_TABLES = [
  'douyin_link_messages',
  'douyin_link_users',
  'douyin_link_minutes',
  'douyin_link_sessions',
  'douyin_link_meta',
  'douyin_link_rooms',
  // 画像与账号绑定也算「这个插件的数据」：卸载时勾了删数据就一起清（不给用户留残影）
  'douyin_link_identity_accounts',
  'douyin_link_identities',
  // AI 画像（大模型花的 token 换来的结果）同理：勾了删数据就一起清
  'douyin_link_user_portraits'
]
