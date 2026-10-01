import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  timestamp
} from 'drizzle-orm/pg-core'

/**
 * 个人记账台账 的表（10 张，全部带 `personal_ledger_` 前缀——一个库里装着所有插件的表，撞名就是事故）。
 *
 * 约定：
 * - JS 键用 camelCase，列名显式给 snake_case（与宿主同规矩），mapper 里同一套键名；
 * - 金额一律 `doublePrecision`（正数，方向看 kind），日期用 TEXT（YYYY-MM-DD，避开时区坑）；
 * - 建表语句在 `./ddl.ts`（独立插件的 DDL 归插件自己，宿主不认识这些表）；
 * - 行类型的单一真源就是这里（`$inferSelect`）。
 */

/** 账户：现金 / 储蓄卡 / 信用卡 / 储值卡 / 投资 / 负债 / 虚拟 */
export const personal_ledger_accounts = pgTable('personal_ledger_accounts', {
  id: serial().primaryKey().notNull(),
  name: text().notNull(),
  type: text().notNull().default('cash'),
  currency: text().notNull().default('CNY'),
  initialBalance: doublePrecision('initial_balance').notNull().default(0),
  creditLimit: doublePrecision('credit_limit').notNull().default(0),
  billDay: integer('bill_day').notNull().default(0),
  repayDay: integer('repay_day').notNull().default(0),
  includeInNetWorth: boolean('include_in_net_worth').notNull().default(true),
  hidden: boolean().notNull().default(false),
  sort: integer().notNull().default(0),
  note: text().notNull().default(''),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow()
})

/** 分类：支出 / 收入，parentId 支持二级及多级 */
export const personal_ledger_categories = pgTable('personal_ledger_categories', {
  id: serial().primaryKey().notNull(),
  name: text().notNull(),
  kind: text().notNull().default('expense'),
  parentId: integer('parent_id'),
  icon: text().notNull().default(''),
  color: text().notNull().default('#8b5cf6'),
  hidden: boolean().notNull().default(false),
  sort: integer().notNull().default(0)
})

/** 标签 */
export const personal_ledger_tags = pgTable('personal_ledger_tags', {
  id: serial().primaryKey().notNull(),
  name: text().notNull(),
  color: text().notNull().default('#60a5fa')
})

/** 商家 / 交易对象 */
export const personal_ledger_merchants = pgTable('personal_ledger_merchants', {
  id: serial().primaryKey().notNull(),
  name: text().notNull(),
  categoryId: integer('category_id'),
  note: text().notNull().default('')
})

/** 交易（支出 / 收入 / 转账；组合支付与分期用 groupId 串起来） */
export const personal_ledger_transactions = pgTable('personal_ledger_transactions', {
  id: serial().primaryKey().notNull(),
  kind: text().notNull(),
  amount: doublePrecision().notNull().default(0),
  date: text().notNull(),
  time: text().notNull().default('00:00'),
  currency: text().notNull().default('CNY'),
  rate: doublePrecision().notNull().default(1),
  categoryId: integer('category_id'),
  accountId: integer('account_id'),
  toAccountId: integer('to_account_id'),
  merchantId: integer('merchant_id'),
  /** JSON 数组文本（标签名） */
  tags: text().notNull().default('[]'),
  note: text().notNull().default(''),
  fee: doublePrecision().notNull().default(0),
  discount: doublePrecision().notNull().default(0),
  member: text().notNull().default(''),
  refundOfId: integer('refund_of_id'),
  reimburseStatus: text('reimburse_status').notNull().default('none'),
  groupId: text('group_id').notNull().default(''),
  installmentIndex: integer('installment_index').notNull().default(0),
  installmentTotal: integer('installment_total').notNull().default(0),
  recurringId: integer('recurring_id'),
  myShare: doublePrecision('my_share').notNull().default(0),
  splitMembers: text('split_members').notNull().default(''),
  /** 余额调整（对账）产生的流水：只影响余额，不进收支统计 */
  adjust: boolean().notNull().default(false),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
})

/** 预算：总预算 / 分类 / 标签 / 账户 / 成员 */
export const personal_ledger_budgets = pgTable('personal_ledger_budgets', {
  id: serial().primaryKey().notNull(),
  name: text().notNull().default(''),
  period: text().notNull().default('month'),
  scope: text().notNull().default('total'),
  /** scope 对应的取值（分类 id / 标签名 / 账户 id / 成员名） */
  ref: text('ref_key').notNull().default(''),
  amount: doublePrecision().notNull().default(0),
  startDate: text('start_date').notNull().default(''),
  endDate: text('end_date').notNull().default(''),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow()
})

/** 储蓄目标（旅行基金 / 应急金 / 买房基金…） */
export const personal_ledger_goals = pgTable('personal_ledger_goals', {
  id: serial().primaryKey().notNull(),
  name: text().notNull(),
  targetAmount: doublePrecision('target_amount').notNull().default(0),
  savedAmount: doublePrecision('saved_amount').notNull().default(0),
  dueDate: text('due_date').notNull().default(''),
  note: text().notNull().default(''),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow()
})

/** 周期记账（房租 / 工资 / 贷款 / 订阅） */
export const personal_ledger_recurring = pgTable('personal_ledger_recurring', {
  id: serial().primaryKey().notNull(),
  name: text().notNull(),
  kind: text().notNull().default('expense'),
  amount: doublePrecision().notNull().default(0),
  categoryId: integer('category_id'),
  accountId: integer('account_id'),
  frequency: text().notNull().default('monthly'),
  nextRun: text('next_run').notNull(),
  enabled: boolean().notNull().default(true),
  note: text().notNull().default(''),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow()
})

/** 借入 / 借出（应收应付台账） */
export const personal_ledger_debts = pgTable('personal_ledger_debts', {
  id: serial().primaryKey().notNull(),
  direction: text().notNull().default('lend'),
  counterparty: text().notNull(),
  amount: doublePrecision().notNull().default(0),
  settled: doublePrecision().notNull().default(0),
  dueDate: text('due_date').notNull().default(''),
  note: text().notNull().default(''),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow()
})

/** 定期存款（到期提醒） */
export const personal_ledger_deposits = pgTable('personal_ledger_deposits', {
  id: serial().primaryKey().notNull(),
  name: text().notNull(),
  accountId: integer('account_id'),
  principal: doublePrecision().notNull().default(0),
  rate: doublePrecision().notNull().default(0),
  startDate: text('start_date').notNull().default(''),
  maturityDate: text('maturity_date').notNull().default(''),
  note: text().notNull().default(''),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow()
})

export type AccountRow = typeof personal_ledger_accounts.$inferSelect
export type CategoryRow = typeof personal_ledger_categories.$inferSelect
export type TagRow = typeof personal_ledger_tags.$inferSelect
export type MerchantRow = typeof personal_ledger_merchants.$inferSelect
export type TransactionRow = typeof personal_ledger_transactions.$inferSelect
export type BudgetRow = typeof personal_ledger_budgets.$inferSelect
export type GoalRow = typeof personal_ledger_goals.$inferSelect
export type RecurringRow = typeof personal_ledger_recurring.$inferSelect
export type DebtRow = typeof personal_ledger_debts.$inferSelect
export type DepositRow = typeof personal_ledger_deposits.$inferSelect
