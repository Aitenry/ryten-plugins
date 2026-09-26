import { sql } from 'drizzle-orm'
import logger from 'electron-log'
import { withOrm } from '@host/main/database/orm'

/**
 * planner **自带建表**（独立插件的 DDL 归插件自己）。
 *
 * 为什么不是宿主迁移：planner 现在是独立仓库里的插件，宿主的 drizzle schema 里不再有
 * `planner_*`——宿主不该知道任何第三方插件的表。插件在装载时幂等地把表补齐：
 *
 * - 语句与当年宿主 baseline 迁移里的 `CREATE TABLE` **逐列一致**（含外键、索引、默认值），
 *   这样老库（表已存在 → `IF NOT EXISTS` 全部命中，什么都不做）与新库（插件建表）
 *   两条路径得到同一张表；
 * - 幂等：`IF NOT EXISTS`；重复装载、升级、卸载后重装都安全；
 * - 只建自己的表，不碰宿主的 `images`（配图/封面在宿主那张表里，靠外键引用）。
 */
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS planner_tasks (
     id         SERIAL PRIMARY KEY,
     parent_id  INTEGER,
     title      TEXT      NOT NULL,
     type       TEXT      NOT NULL DEFAULT 'task',
     progress   INTEGER   DEFAULT 0,
     work_hours INTEGER   DEFAULT 0,
     priority   INTEGER   DEFAULT 0,
     start_date TIMESTAMP,
     end_date   TIMESTAMP,
     sort_order INTEGER   DEFAULT 0,
     created_at TIMESTAMP DEFAULT NOW(),
     updated_at TIMESTAMP DEFAULT NOW(),
     FOREIGN KEY (parent_id) REFERENCES planner_tasks (id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_planner_tasks_parent ON planner_tasks (parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_planner_tasks_type   ON planner_tasks (type)`,
  `CREATE INDEX IF NOT EXISTS idx_planner_tasks_sort   ON planner_tasks (sort_order)`,
  `CREATE TABLE IF NOT EXISTS planner_dependencies (
     id                 SERIAL PRIMARY KEY,
     task_id            INTEGER   NOT NULL,
     depends_on_task_id INTEGER   NOT NULL,
     created_at         TIMESTAMP DEFAULT NOW(),
     FOREIGN KEY (task_id)            REFERENCES planner_tasks (id) ON DELETE CASCADE,
     FOREIGN KEY (depends_on_task_id) REFERENCES planner_tasks (id) ON DELETE CASCADE,
     UNIQUE (task_id, depends_on_task_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_planner_deps_task       ON planner_dependencies (task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_planner_deps_depends_on ON planner_dependencies (depends_on_task_id)`
]

/** 建表承诺：所有数据库访问（mapper / purge）都先 await 它，保证不会跑到建表之前 */
export const schemaReady: Promise<void> = (async () => {
  await withOrm('planner.ensureSchema', async (db) => {
    for (const statement of DDL) await db.execute(sql.raw(statement))
  })
  logger.info('[planner] 表结构已就绪（planner_tasks / planner_dependencies）')
})().catch((err) => {
  logger.error('[planner] 建表失败，插件将无法读写数据:', err)
  throw err
})
