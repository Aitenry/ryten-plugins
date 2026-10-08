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
     gift            INTEGER NOT NULL DEFAULT 0,
     diamonds        INTEGER NOT NULL DEFAULT 0,
     enter           INTEGER NOT NULL DEFAULT 0,
     likes           INTEGER NOT NULL DEFAULT 0,
     follows         INTEGER NOT NULL DEFAULT 0,
     first_seen      DOUBLE PRECISION NOT NULL DEFAULT 0,
     last_seen       DOUBLE PRECISION NOT NULL DEFAULT 0
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_douyin_link_user_room ON douyin_link_users (web_rid, user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_douyin_link_user_room_chat ON douyin_link_users (web_rid, chat DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_douyin_link_user_room_diamonds ON douyin_link_users (web_rid, diamonds DESC)`,
  `CREATE TABLE IF NOT EXISTS douyin_link_minutes (
     id       SERIAL PRIMARY KEY,
     web_rid  TEXT NOT NULL,
     minute   INTEGER NOT NULL,
     chat     INTEGER NOT NULL DEFAULT 0,
     gift     INTEGER NOT NULL DEFAULT 0,
     member   INTEGER NOT NULL DEFAULT 0,
     likes    INTEGER NOT NULL DEFAULT 0,
     social   INTEGER NOT NULL DEFAULT 0,
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
  `CREATE TABLE IF NOT EXISTS douyin_link_gifts (
     id         INTEGER PRIMARY KEY,
     name       TEXT NOT NULL DEFAULT '',
     diamonds   INTEGER NOT NULL DEFAULT 0,
     describe   TEXT NOT NULL DEFAULT '',
     icon       TEXT NOT NULL DEFAULT '',
     updated_at DOUBLE PRECISION NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS douyin_link_meta (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL DEFAULT '',
     updated_at DOUBLE PRECISION NOT NULL DEFAULT 0
   )`
]

/** 建表承诺：mapper / purge 都先 await 它，保证不会有访问跑到建表之前 */
export const schemaReady: Promise<void> = (async () => {
  await withOrm('douyin-link.ensureSchema', async (db) => {
    for (const statement of DDL) await db.execute(sql.raw(statement))
  })
  logger.info('[douyin-link] 表结构已就绪（7 张 douyin_link_* 表）')
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
  'douyin_link_gifts',
  'douyin_link_meta',
  'douyin_link_rooms'
]
