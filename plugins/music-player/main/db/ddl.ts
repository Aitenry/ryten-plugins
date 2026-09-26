import { sql } from 'drizzle-orm'
import logger from 'electron-log'
import { withOrm } from '@host/main/database/orm'

/**
 * music **自带建表**（独立插件的 DDL 归插件自己）。
 *
 * 同 planner 的理由与约束：语句与当年宿主 baseline 迁移逐列一致、幂等（`IF NOT EXISTS`）、
 * 只建自己的两张表。封面/配图仍存在宿主的 `images` 表里（`image_id` 外键引用）。
 */
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS music_folders (
     id          TEXT PRIMARY KEY,
     path        TEXT NOT NULL UNIQUE,
     name        TEXT NOT NULL,
     description TEXT,
     track_count INTEGER DEFAULT 0,
     image_id    TEXT REFERENCES images(id),
     created_at  TIMESTAMP DEFAULT NOW(),
     updated_at  TIMESTAMP DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS music_tracks (
     id             SERIAL PRIMARY KEY,
     file_path      TEXT NOT NULL,
     file_hash      TEXT NOT NULL,
     folder_id      TEXT NOT NULL,
     title          TEXT NOT NULL,
     artist         TEXT,
     album          TEXT,
     duration       REAL,
     liked          BOOLEAN   DEFAULT FALSE,
     last_played_at TIMESTAMP,
     image_id       TEXT REFERENCES images(id),
     created_at     TIMESTAMP DEFAULT NOW(),
     FOREIGN KEY (folder_id) REFERENCES music_folders(id) ON DELETE CASCADE,
     UNIQUE (folder_id, file_hash)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_music_tracks_folder ON music_tracks(folder_id)`
]

/** 建表承诺：所有数据库访问（mapper / purge）都先 await 它，保证不会跑到建表之前 */
export const schemaReady: Promise<void> = (async () => {
  await withOrm('music.ensureSchema', async (db) => {
    for (const statement of DDL) await db.execute(sql.raw(statement))
  })
  logger.info('[music] 表结构已就绪（music_folders / music_tracks）')
})().catch((err) => {
  logger.error('[music] 建表失败，插件将无法读写数据:', err)
  throw err
})
