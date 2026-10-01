import { sql } from 'drizzle-orm'
import logger from 'electron-log'
import { withOrm } from '@host/main/database/orm'

/**
 * 个人记账台账 **自带建表**（独立插件的 DDL 归插件自己，宿主不认识这些表）。
 *
 * 两条约束：
 * - **幂等**：一律 `IF NOT EXISTS`，插件每次装载都会跑一遍；
 * - **只动自己的表**：表名一律带 `personal_ledger_` 前缀，绝不碰别的插件或宿主的表。
 *
 * 列的口径与 `./schema.ts` 的 drizzle 定义**逐一对齐**（改一处必须改另一处）。
 */
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS personal_ledger_accounts (
     id                   SERIAL PRIMARY KEY,
     name                 TEXT NOT NULL,
     type                 TEXT NOT NULL DEFAULT 'cash',
     currency             TEXT NOT NULL DEFAULT 'CNY',
     initial_balance      DOUBLE PRECISION NOT NULL DEFAULT 0,
     credit_limit         DOUBLE PRECISION NOT NULL DEFAULT 0,
     bill_day             INTEGER NOT NULL DEFAULT 0,
     repay_day            INTEGER NOT NULL DEFAULT 0,
     include_in_net_worth BOOLEAN NOT NULL DEFAULT TRUE,
     hidden               BOOLEAN NOT NULL DEFAULT FALSE,
     sort                 INTEGER NOT NULL DEFAULT 0,
     note                 TEXT NOT NULL DEFAULT '',
     created_at           TIMESTAMP DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS personal_ledger_categories (
     id        SERIAL PRIMARY KEY,
     name      TEXT NOT NULL,
     kind      TEXT NOT NULL DEFAULT 'expense',
     parent_id INTEGER,
     icon      TEXT NOT NULL DEFAULT '',
     color     TEXT NOT NULL DEFAULT '#8b5cf6',
     hidden    BOOLEAN NOT NULL DEFAULT FALSE,
     sort      INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS personal_ledger_tags (
     id    SERIAL PRIMARY KEY,
     name  TEXT NOT NULL,
     color TEXT NOT NULL DEFAULT '#60a5fa'
   )`,
  `CREATE TABLE IF NOT EXISTS personal_ledger_merchants (
     id          SERIAL PRIMARY KEY,
     name        TEXT NOT NULL,
     category_id INTEGER,
     note        TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE TABLE IF NOT EXISTS personal_ledger_transactions (
     id                SERIAL PRIMARY KEY,
     kind              TEXT NOT NULL,
     amount            DOUBLE PRECISION NOT NULL DEFAULT 0,
     date              TEXT NOT NULL,
     time              TEXT NOT NULL DEFAULT '00:00',
     currency          TEXT NOT NULL DEFAULT 'CNY',
     rate              DOUBLE PRECISION NOT NULL DEFAULT 1,
     category_id       INTEGER,
     account_id        INTEGER,
     to_account_id     INTEGER,
     merchant_id       INTEGER,
     tags              TEXT NOT NULL DEFAULT '[]',
     note              TEXT NOT NULL DEFAULT '',
     fee               DOUBLE PRECISION NOT NULL DEFAULT 0,
     discount          DOUBLE PRECISION NOT NULL DEFAULT 0,
     member            TEXT NOT NULL DEFAULT '',
     refund_of_id      INTEGER,
     reimburse_status  TEXT NOT NULL DEFAULT 'none',
     group_id          TEXT NOT NULL DEFAULT '',
     installment_index INTEGER NOT NULL DEFAULT 0,
     installment_total INTEGER NOT NULL DEFAULT 0,
     recurring_id      INTEGER,
     my_share          DOUBLE PRECISION NOT NULL DEFAULT 0,
     split_members     TEXT NOT NULL DEFAULT '',
     adjust            BOOLEAN NOT NULL DEFAULT FALSE,
     created_at        TIMESTAMP DEFAULT NOW(),
     updated_at        TIMESTAMP DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS personal_ledger_budgets (
     id         SERIAL PRIMARY KEY,
     name       TEXT NOT NULL DEFAULT '',
     period     TEXT NOT NULL DEFAULT 'month',
     scope      TEXT NOT NULL DEFAULT 'total',
     ref_key    TEXT NOT NULL DEFAULT '',
     amount     DOUBLE PRECISION NOT NULL DEFAULT 0,
     start_date TEXT NOT NULL DEFAULT '',
     end_date   TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMP DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS personal_ledger_goals (
     id            SERIAL PRIMARY KEY,
     name          TEXT NOT NULL,
     target_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
     saved_amount  DOUBLE PRECISION NOT NULL DEFAULT 0,
     due_date      TEXT NOT NULL DEFAULT '',
     note          TEXT NOT NULL DEFAULT '',
     created_at    TIMESTAMP DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS personal_ledger_recurring (
     id          SERIAL PRIMARY KEY,
     name        TEXT NOT NULL,
     kind        TEXT NOT NULL DEFAULT 'expense',
     amount      DOUBLE PRECISION NOT NULL DEFAULT 0,
     category_id INTEGER,
     account_id  INTEGER,
     frequency   TEXT NOT NULL DEFAULT 'monthly',
     next_run    TEXT NOT NULL,
     enabled     BOOLEAN NOT NULL DEFAULT TRUE,
     note        TEXT NOT NULL DEFAULT '',
     created_at  TIMESTAMP DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS personal_ledger_debts (
     id           SERIAL PRIMARY KEY,
     direction    TEXT NOT NULL DEFAULT 'lend',
     counterparty TEXT NOT NULL,
     amount       DOUBLE PRECISION NOT NULL DEFAULT 0,
     settled      DOUBLE PRECISION NOT NULL DEFAULT 0,
     due_date     TEXT NOT NULL DEFAULT '',
     note         TEXT NOT NULL DEFAULT '',
     created_at   TIMESTAMP DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS personal_ledger_deposits (
     id            SERIAL PRIMARY KEY,
     name          TEXT NOT NULL,
     account_id    INTEGER,
     principal     DOUBLE PRECISION NOT NULL DEFAULT 0,
     rate          DOUBLE PRECISION NOT NULL DEFAULT 0,
     start_date    TEXT NOT NULL DEFAULT '',
     maturity_date TEXT NOT NULL DEFAULT '',
     note          TEXT NOT NULL DEFAULT '',
     created_at    TIMESTAMP DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_personal_ledger_tx_date ON personal_ledger_transactions(date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_personal_ledger_tx_account ON personal_ledger_transactions(account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_personal_ledger_tx_category ON personal_ledger_transactions(category_id)`,
  `CREATE INDEX IF NOT EXISTS idx_personal_ledger_tx_group ON personal_ledger_transactions(group_id)`
]

/** 建表承诺：mapper / purge 都先 await 它，保证不会有访问跑到建表之前 */
export const schemaReady: Promise<void> = (async () => {
  await withOrm('personal-ledger.ensureSchema', async (db) => {
    for (const statement of DDL) await db.execute(sql.raw(statement))
  })
  logger.info('[personal-ledger] 表结构已就绪（10 张 personal_ledger_* 表）')
})().catch((err) => {
  logger.error('[personal-ledger] 建表失败，插件将无法读写数据:', err)
  throw err
})
