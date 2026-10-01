import { randomUUID } from 'node:crypto'
import { asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { withOrm } from '@host/main/database/orm'
import type {
  Account,
  Budget,
  Category,
  ClassifyRule,
  Debt,
  Deposit,
  Goal,
  Merchant,
  Recurring,
  Tag,
  Transaction,
  TransactionFilter,
  TransactionInput
} from '../../shared/types'
import { schemaReady } from './ddl'
import {
  personal_ledger_accounts,
  personal_ledger_budgets,
  personal_ledger_categories,
  personal_ledger_debts,
  personal_ledger_deposits,
  personal_ledger_goals,
  personal_ledger_merchants,
  personal_ledger_recurring,
  personal_ledger_tags,
  personal_ledger_transactions,
  type AccountRow,
  type BudgetRow,
  type CategoryRow,
  type DebtRow,
  type DepositRow,
  type GoalRow,
  type MerchantRow,
  type RecurringRow,
  type TagRow,
  type TransactionRow
} from './schema'

/**
 * 个人记账台账 的数据访问层（全部读写都从这里走）。
 *
 * 规矩（与宿主 mapper 一致）：
 * - **每个函数先 `await schemaReady`**：插件装载即建表，但不保证建表先于第一次查询；
 * - 一律走 `withOrm`：拿到 drizzle 实例、异常统一记日志；
 * - 行类型只在插件内部流转，出这一层就转成 `shared/types.ts` 的 DTO（渲染层不认识 drizzle）；
 * - 个人账本的数据量级（万级流水）用「取出来在 JS 里算」比堆 SQL 聚合更好维护，
 *   因此汇总类逻辑集中在 `./reports.ts`，本文件只负责存储与规范化。
 */

/* ────────────────────────────── 行 → DTO ────────────────────────────── */

export function toAccountDto(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    type: (row.type as Account['type']) ?? 'cash',
    currency: row.currency,
    initialBalance: Number(row.initialBalance ?? 0),
    creditLimit: Number(row.creditLimit ?? 0),
    billDay: Number(row.billDay ?? 0),
    repayDay: Number(row.repayDay ?? 0),
    includeInNetWorth: row.includeInNetWorth !== false,
    hidden: row.hidden === true,
    sort: Number(row.sort ?? 0),
    note: row.note ?? '',
    createdAt: row.createdAt ?? null
  }
}

export function toCategoryDto(row: CategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'income' ? 'income' : 'expense',
    parentId: row.parentId ?? null,
    icon: row.icon ?? '',
    color: row.color || '#8b5cf6',
    hidden: row.hidden === true,
    sort: Number(row.sort ?? 0)
  }
}

export function toTagDto(row: TagRow): Tag {
  return { id: row.id, name: row.name, color: row.color || '#60a5fa' }
}

export function toMerchantDto(row: MerchantRow): Merchant {
  return { id: row.id, name: row.name, categoryId: row.categoryId ?? null, note: row.note ?? '' }
}

/** 标签在库里是 JSON 数组文本：读的时候容错，写的时候一律 `JSON.stringify` */
function parseTags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.map((t) => String(t)).filter((t) => t.length > 0) : []
  } catch {
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  }
}

export function toTransactionDto(row: TransactionRow): Transaction {
  return {
    id: row.id,
    kind: (row.kind as Transaction['kind']) ?? 'expense',
    amount: Number(row.amount ?? 0),
    date: row.date,
    time: row.time || '00:00',
    currency: row.currency || 'CNY',
    rate: Number(row.rate ?? 1) || 1,
    categoryId: row.categoryId ?? null,
    accountId: row.accountId ?? null,
    toAccountId: row.toAccountId ?? null,
    merchantId: row.merchantId ?? null,
    tags: parseTags(row.tags),
    note: row.note ?? '',
    fee: Number(row.fee ?? 0),
    discount: Number(row.discount ?? 0),
    member: row.member ?? '',
    refundOfId: row.refundOfId ?? null,
    reimburseStatus: (row.reimburseStatus as Transaction['reimburseStatus']) ?? 'none',
    groupId: row.groupId ?? '',
    installmentIndex: Number(row.installmentIndex ?? 0),
    installmentTotal: Number(row.installmentTotal ?? 0),
    recurringId: row.recurringId ?? null,
    myShare: Number(row.myShare ?? 0),
    splitMembers: row.splitMembers ?? '',
    adjust: row.adjust === true,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null
  }
}

export function toBudgetDto(row: BudgetRow): Budget {
  return {
    id: row.id,
    name: row.name ?? '',
    period: (row.period as Budget['period']) ?? 'month',
    scope: (row.scope as Budget['scope']) ?? 'total',
    ref: row.ref ?? '',
    amount: Number(row.amount ?? 0),
    startDate: row.startDate ?? '',
    endDate: row.endDate ?? '',
    createdAt: row.createdAt ?? null
  }
}

export function toGoalDto(row: GoalRow): Goal {
  return {
    id: row.id,
    name: row.name,
    targetAmount: Number(row.targetAmount ?? 0),
    savedAmount: Number(row.savedAmount ?? 0),
    dueDate: row.dueDate ?? '',
    note: row.note ?? '',
    createdAt: row.createdAt ?? null
  }
}

export function toRecurringDto(row: RecurringRow): Recurring {
  return {
    id: row.id,
    name: row.name,
    kind: (row.kind as Recurring['kind']) ?? 'expense',
    amount: Number(row.amount ?? 0),
    categoryId: row.categoryId ?? null,
    accountId: row.accountId ?? null,
    frequency: (row.frequency as Recurring['frequency']) ?? 'monthly',
    nextRun: row.nextRun,
    enabled: row.enabled !== false,
    note: row.note ?? '',
    createdAt: row.createdAt ?? null
  }
}

export function toDebtDto(row: DebtRow): Debt {
  return {
    id: row.id,
    direction: row.direction === 'borrow' ? 'borrow' : 'lend',
    counterparty: row.counterparty,
    amount: Number(row.amount ?? 0),
    settled: Number(row.settled ?? 0),
    dueDate: row.dueDate ?? '',
    note: row.note ?? '',
    createdAt: row.createdAt ?? null
  }
}

export function toDepositDto(row: DepositRow): Deposit {
  return {
    id: row.id,
    name: row.name,
    accountId: row.accountId ?? null,
    principal: Number(row.principal ?? 0),
    rate: Number(row.rate ?? 0),
    startDate: row.startDate ?? '',
    maturityDate: row.maturityDate ?? '',
    note: row.note ?? '',
    createdAt: row.createdAt ?? null
  }
}

/* ────────────────────────────── 小工具 ────────────────────────────── */

/** 本地日期 YYYY-MM-DD（不用 toISOString：那是 UTC，跨时区会差一天） */
export function today(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = `${now.getMonth() + 1}`.padStart(2, '0')
  const d = `${now.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 时间 HH:mm */
export function nowTime(now: Date = new Date()): string {
  return `${`${now.getHours()}`.padStart(2, '0')}:${`${now.getMinutes()}`.padStart(2, '0')}`
}

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value)
}

/** 交易对基准币种的折算金额（rate = 1 单位币种折合基准币种） */
export function toBase(tx: Transaction): number {
  return tx.amount * (tx.rate || 1)
}

/** 一笔支出实际花掉的钱（含手续费、减优惠；转账也按金额算成本） */
export function expenseCost(tx: Transaction): number {
  const rate = tx.rate || 1
  const gross = tx.kind === 'income' ? tx.amount : tx.amount
  const fee = tx.fee * rate
  const discount = tx.discount * rate
  return gross * rate + fee - discount
}

/* ────────────────────────────── 账户 ────────────────────────────── */

export async function listAccounts(): Promise<Account[]> {
  await schemaReady
  const rows = await withOrm('personal-ledger.listAccounts', async (db) =>
    db
      .select()
      .from(personal_ledger_accounts)
      .orderBy(asc(personal_ledger_accounts.sort), asc(personal_ledger_accounts.id))
  )
  return rows.map(toAccountDto)
}

export async function saveAccount(input: Partial<Account> & { name: string }): Promise<Account> {
  await schemaReady
  const name = str(input.name).trim()
  if (!name) throw new Error('账户名不能为空')
  const values = {
    name,
    type: str(input.type, 'cash'),
    currency: str(input.currency, 'CNY'),
    initialBalance: num(input.initialBalance),
    creditLimit: num(input.creditLimit),
    billDay: Math.trunc(num(input.billDay)),
    repayDay: Math.trunc(num(input.repayDay)),
    includeInNetWorth: input.includeInNetWorth !== false,
    hidden: input.hidden === true,
    sort: Math.trunc(num(input.sort)),
    note: str(input.note)
  }
  if (input.id) {
    const rows = await withOrm('personal-ledger.saveAccount', async (db) =>
      db
        .update(personal_ledger_accounts)
        .set(values)
        .where(eq(personal_ledger_accounts.id, input.id as number))
        .returning()
    )
    if (!rows[0]) throw new Error(`账户 ${input.id} 不存在`)
    return toAccountDto(rows[0])
  }
  const rows = await withOrm('personal-ledger.saveAccount', async (db) =>
    db.insert(personal_ledger_accounts).values(values).returning()
  )
  return toAccountDto(rows[0])
}

/**
 * 对账：用户说「这个账户其实有 X 元」，差额记一笔**余额调整**（adjust=true）。
 *
 * 为什么不直接改期初余额：期初是历史事实，改它等于篡改过去的账；
 * 调整流水能留下「什么时候对过账、差了多少」的痕迹，而且不进收支统计。
 * 返回 null = 差额为 0，不需要调整。
 */
export async function reconcileAccount(
  id: number,
  actualBalance: number,
  note = ''
): Promise<Transaction | null> {
  await schemaReady
  const [accounts, transactions] = await Promise.all([listAccounts(), listTransactions()])
  const account = accounts.find((item) => item.id === id)
  if (!account) throw new Error(`账户 ${id} 不存在`)
  const balances = accountBalances(accounts, transactions)
  const current = balances.get(id)?.balance ?? account.initialBalance
  const diff = Math.round((num(actualBalance) - current) * 100) / 100
  if (Math.abs(diff) < 0.01) return null
  return saveTransaction({
    kind: diff > 0 ? 'income' : 'expense',
    amount: Math.abs(diff),
    date: today(),
    time: nowTime(),
    accountId: id,
    note: note ? `余额调整：${note}` : '余额调整',
    adjust: true
  })
}

/** 删账户：连同这个账户的流水一起删（余额是流水算出来的，留着会变成孤儿数据） */export async function deleteAccount(id: number): Promise<number> {
  await schemaReady
  const removed = await withOrm('personal-ledger.deleteAccount', async (db) =>
    db
      .delete(personal_ledger_transactions)
      .where(
        sql`${personal_ledger_transactions.accountId} = ${id} OR ${personal_ledger_transactions.toAccountId} = ${id}`
      )
      .returning({ id: personal_ledger_transactions.id })
  )
  await withOrm('personal-ledger.deleteAccount', async (db) =>
    db.delete(personal_ledger_accounts).where(eq(personal_ledger_accounts.id, id))
  )
  return removed.length
}

/* ────────────────────────────── 分类 / 标签 / 商家 ────────────────────────────── */

export async function listCategories(): Promise<Category[]> {
  await schemaReady
  const rows = await withOrm('personal-ledger.listCategories', async (db) =>
    db
      .select()
      .from(personal_ledger_categories)
      .orderBy(asc(personal_ledger_categories.sort), asc(personal_ledger_categories.id))
  )
  return rows.map(toCategoryDto)
}

export async function saveCategory(input: Partial<Category> & { name: string }): Promise<Category> {
  await schemaReady
  const name = str(input.name).trim()
  if (!name) throw new Error('分类名不能为空')
  const values = {
    name,
    kind: input.kind === 'income' ? 'income' : 'expense',
    parentId: input.parentId ?? null,
    icon: str(input.icon),
    color: str(input.color, '#8b5cf6'),
    hidden: input.hidden === true,
    sort: Math.trunc(num(input.sort))
  }
  if (input.id) {
    const rows = await withOrm('personal-ledger.saveCategory', async (db) =>
      db
        .update(personal_ledger_categories)
        .set(values)
        .where(eq(personal_ledger_categories.id, input.id as number))
        .returning()
    )
    if (!rows[0]) throw new Error(`分类 ${input.id} 不存在`)
    return toCategoryDto(rows[0])
  }
  const rows = await withOrm('personal-ledger.saveCategory', async (db) =>
    db.insert(personal_ledger_categories).values(values).returning()
  )
  return toCategoryDto(rows[0])
}

/** 删分类：子分类上提一级，流水的分类置空（不删流水） */
export async function deleteCategory(id: number): Promise<void> {
  await schemaReady
  await withOrm('personal-ledger.deleteCategory', async (db) => {
    await db
      .update(personal_ledger_categories)
      .set({ parentId: null })
      .where(eq(personal_ledger_categories.parentId, id))
    await db
      .update(personal_ledger_transactions)
      .set({ categoryId: null })
      .where(eq(personal_ledger_transactions.categoryId, id))
    await db.delete(personal_ledger_categories).where(eq(personal_ledger_categories.id, id))
  })
}

export async function listTags(): Promise<Tag[]> {
  await schemaReady
  const rows = await withOrm('personal-ledger.listTags', async (db) =>
    db.select().from(personal_ledger_tags).orderBy(asc(personal_ledger_tags.name))
  )
  return rows.map(toTagDto)
}

export async function saveTag(input: Partial<Tag> & { name: string }): Promise<Tag> {
  await schemaReady
  const name = str(input.name).trim()
  if (!name) throw new Error('标签名不能为空')
  const values = { name, color: str(input.color, '#60a5fa') }
  if (input.id) {
    const rows = await withOrm('personal-ledger.saveTag', async (db) =>
      db
        .update(personal_ledger_tags)
        .set(values)
        .where(eq(personal_ledger_tags.id, input.id as number))
        .returning()
    )
    if (!rows[0]) throw new Error(`标签 ${input.id} 不存在`)
    return toTagDto(rows[0])
  }
  const rows = await withOrm('personal-ledger.saveTag', async (db) =>
    db.insert(personal_ledger_tags).values(values).returning()
  )
  return toTagDto(rows[0])
}

/** 删标签：流水里的标签是按名字存的，顺手从 JSON 数组里摘掉 */
export async function deleteTag(id: number): Promise<void> {
  await schemaReady
  const rows = await withOrm('personal-ledger.deleteTag', async (db) =>
    db.select().from(personal_ledger_tags).where(eq(personal_ledger_tags.id, id))
  )
  const name = rows[0]?.name
  await withOrm('personal-ledger.deleteTag', async (db) => {
    await db.delete(personal_ledger_tags).where(eq(personal_ledger_tags.id, id))
  })
  if (!name) return
  const all = await listTransactions()
  const touched = all.filter((tx) => tx.tags.includes(name))
  for (const tx of touched) {
    const next = tx.tags.filter((t) => t !== name)
    await withOrm('personal-ledger.deleteTag', async (db) =>
      db
        .update(personal_ledger_transactions)
        .set({ tags: JSON.stringify(next) })
        .where(eq(personal_ledger_transactions.id, tx.id))
    )
  }
}

export async function listMerchants(): Promise<Merchant[]> {
  await schemaReady
  const rows = await withOrm('personal-ledger.listMerchants', async (db) =>
    db.select().from(personal_ledger_merchants).orderBy(asc(personal_ledger_merchants.name))
  )
  return rows.map(toMerchantDto)
}

export async function saveMerchant(
  input: Partial<Merchant> & { name: string }
): Promise<Merchant> {
  await schemaReady
  const name = str(input.name).trim()
  if (!name) throw new Error('商家名不能为空')
  const values = { name, categoryId: input.categoryId ?? null, note: str(input.note) }
  if (input.id) {
    const rows = await withOrm('personal-ledger.saveMerchant', async (db) =>
      db
        .update(personal_ledger_merchants)
        .set(values)
        .where(eq(personal_ledger_merchants.id, input.id as number))
        .returning()
    )
    if (!rows[0]) throw new Error(`商家 ${input.id} 不存在`)
    return toMerchantDto(rows[0])
  }
  const rows = await withOrm('personal-ledger.saveMerchant', async (db) =>
    db.insert(personal_ledger_merchants).values(values).returning()
  )
  return toMerchantDto(rows[0])
}

export async function deleteMerchant(id: number): Promise<void> {
  await schemaReady
  await withOrm('personal-ledger.deleteMerchant', async (db) => {
    await db
      .update(personal_ledger_transactions)
      .set({ merchantId: null })
      .where(eq(personal_ledger_transactions.merchantId, id))
    await db.delete(personal_ledger_merchants).where(eq(personal_ledger_merchants.id, id))
  })
}

/* ────────────────────────────── 交易 ────────────────────────────── */

/** 全部流水（新的在前）；过滤放在 JS 里做，条件再多也一眼看得懂 */
export async function listTransactions(filter: TransactionFilter = {}): Promise<Transaction[]> {
  await schemaReady
  const rows = await withOrm('personal-ledger.listTransactions', async (db) =>
    db
      .select()
      .from(personal_ledger_transactions)
      .orderBy(
        desc(personal_ledger_transactions.date),
        desc(personal_ledger_transactions.time),
        desc(personal_ledger_transactions.id)
      )
  )
  let items = rows.map(toTransactionDto)
  if (filter.from) items = items.filter((tx) => tx.date >= filter.from!)
  if (filter.to) items = items.filter((tx) => tx.date <= filter.to!)
  if (filter.kind) items = items.filter((tx) => tx.kind === filter.kind)
  if (filter.categoryId !== undefined && filter.categoryId !== null) {
    items = items.filter((tx) => tx.categoryId === filter.categoryId)
  }
  if (filter.accountId !== undefined && filter.accountId !== null) {
    items = items.filter(
      (tx) => tx.accountId === filter.accountId || tx.toAccountId === filter.accountId
    )
  }
  if (filter.tag) items = items.filter((tx) => tx.tags.includes(filter.tag as string))
  if (filter.member) items = items.filter((tx) => tx.member === filter.member)
  if (filter.reimburseStatus) {
    items = items.filter((tx) => tx.reimburseStatus === filter.reimburseStatus)
  }
  if (filter.minAmount !== undefined && filter.minAmount !== null) {
    items = items.filter((tx) => toBase(tx) >= filter.minAmount!)
  }
  if (filter.maxAmount !== undefined && filter.maxAmount !== null) {
    items = items.filter((tx) => toBase(tx) <= filter.maxAmount!)
  }
  if (filter.keyword) {
    const keyword = filter.keyword.trim().toLowerCase()
    const [categories, merchants] = await Promise.all([listCategories(), listMerchants()])
    const categoryName = new Map(categories.map((c) => [c.id, c.name]))
    const merchantName = new Map(merchants.map((m) => [m.id, m.name]))
    items = items.filter((tx) => {
      const haystack = [
        tx.note,
        tx.member,
        tx.currency,
        tx.date,
        String(tx.amount),
        tx.tags.join(' '),
        tx.categoryId ? categoryName.get(tx.categoryId) ?? '' : '',
        tx.merchantId ? merchantName.get(tx.merchantId) ?? '' : ''
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(keyword)
    })
  }
  const offset = Math.max(0, Math.trunc(num(filter.offset)))
  if (offset > 0) items = items.slice(offset)
  if (filter.limit && filter.limit > 0) items = items.slice(0, Math.trunc(filter.limit))
  return items
}

/** 按名字找账户 / 分类 / 商家，找不到就建一个（导入与冒烟都靠它，省掉「先建再记」） */
async function ensureCategory(name: string, kind: 'expense' | 'income'): Promise<number> {
  const clean = name.trim()
  const existing = (await listCategories()).find((c) => c.name === clean && c.kind === kind)
  if (existing) return existing.id
  const created = await saveCategory({ name: clean, kind })
  return created.id
}

async function ensureAccount(name: string): Promise<number> {
  const clean = name.trim()
  const existing = (await listAccounts()).find((a) => a.name === clean)
  if (existing) return existing.id
  const created = await saveAccount({ name: clean, type: 'cash' })
  return created.id
}

async function ensureMerchant(name: string): Promise<number> {
  const clean = name.trim()
  const existing = (await listMerchants()).find((m) => m.name === clean)
  if (existing) return existing.id
  const created = await saveMerchant({ name: clean })
  return created.id
}

/** 标签是补充维度：记流水时顺手把不存在的标签建出来 */
async function ensureTags(names: string[]): Promise<string[]> {
  const clean = names.map((n) => n.trim()).filter((n) => n.length > 0)
  if (clean.length === 0) return []
  const existing = new Set((await listTags()).map((t) => t.name))
  for (const name of clean) {
    if (!existing.has(name)) {
      await saveTag({ name })
      existing.add(name)
    }
  }
  return clean
}

/** 自动分类规则：按商家名 / 备注关键词把没分类的流水归到分类 */
function applyRules(input: TransactionInput, rules: ClassifyRule[] | undefined): number | null {
  if (!rules || rules.length === 0) return null
  const haystack = `${input.merchantName ?? ''} ${input.note ?? ''}`.toLowerCase()
  if (!haystack.trim()) return null
  for (const rule of rules) {
    const keyword = rule.keyword.trim().toLowerCase()
    if (!keyword) continue
    if (rule.kind !== input.kind) continue
    if (haystack.includes(keyword)) return rule.categoryId
  }
  return null
}

function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map((part) => Number(part))
  const base = new Date(y, (m - 1) + months, d)
  if (base.getDate() !== d) base.setDate(0)
  return today(base)
}

/** 每期金额：除不尽的零头放在第一期（总额与用户输入一致） */
function splitAmount(total: number, parts: number): number[] {
  if (parts <= 1) return [total]
  const base = Math.floor((total / parts) * 100) / 100
  const rest = Math.round((total - base * parts) * 100) / 100
  return [Math.round((base + rest) * 100) / 100, ...Array.from({ length: parts - 1 }, () => base)]
}

/**
 * 新建 / 修改一笔交易。
 *
 * 一个入参可能落成多行流水：
 * - `installmentMonths > 1` → 分期，按月顺延，groupId 相同；
 * - `payments.length > 1` → 组合支付，每段一个账户，groupId 相同；
 * - 其余 → 一行。
 *
 * 返回第一条（也是调用方最关心的那条）。
 */
export async function saveTransaction(
  input: TransactionInput,
  rules?: ClassifyRule[]
): Promise<Transaction> {
  await schemaReady
  const amount = num(input.amount)
  if (amount < 0) throw new Error('金额不能为负')
  const kind = input.kind === 'income' || input.kind === 'transfer' ? input.kind : 'expense'
  const date = str(input.date, today())
  const time = str(input.time, nowTime())
  const currency = str(input.currency, 'CNY')
  const rate = num(input.rate, 1) || 1

  let categoryId = input.categoryId ?? null
  if (!categoryId && input.categoryName) {
    categoryId = await ensureCategory(str(input.categoryName), kind === 'income' ? 'income' : 'expense')
  }
  if (!categoryId && kind !== 'transfer') {
    const ruled = applyRules({ ...input, kind }, rules)
    if (ruled) categoryId = ruled
  }

  let accountId = input.accountId ?? null
  if (!accountId && input.accountName) accountId = await ensureAccount(str(input.accountName))
  let toAccountId = input.toAccountId ?? null
  if (!toAccountId && input.toAccountName) toAccountId = await ensureAccount(str(input.toAccountName))

  let merchantId = input.merchantId ?? null
  if (!merchantId && input.merchantName) merchantId = await ensureMerchant(str(input.merchantName))

  const tags = await ensureTags(input.tags ?? [])
  const base = {
    kind,
    date,
    time,
    currency,
    rate,
    categoryId,
    merchantId,
    tags: JSON.stringify(tags),
    note: str(input.note),
    fee: num(input.fee),
    discount: num(input.discount),
    member: str(input.member),
    refundOfId: input.refundOfId ?? null,
    reimburseStatus: input.reimburseStatus ?? 'none',
    myShare: num(input.myShare),
    splitMembers: str(input.splitMembers),
    adjust: input.adjust === true,
    recurringId: input.recurringId ?? null,
    updatedAt: new Date().toISOString()
  }

  // 修改：只改这一行（组合支付/分期的其它片段要改就整组删了重记）
  if (input.id) {
    const rows = await withOrm('personal-ledger.saveTransaction', async (db) =>
      db
        .update(personal_ledger_transactions)
        .set({ ...base, amount, accountId, toAccountId })
        .where(eq(personal_ledger_transactions.id, input.id as number))
        .returning()
    )
    if (!rows[0]) throw new Error(`交易 ${input.id} 不存在`)
    return toTransactionDto(rows[0])
  }

  const rowsToInsert: (typeof personal_ledger_transactions.$inferInsert)[] = []
  const months = Math.trunc(num(input.installmentMonths))
  if (months > 1) {
    const groupId = randomUUID()
    const parts = splitAmount(amount, months)
    parts.forEach((part, index) => {
      rowsToInsert.push({
        ...base,
        amount: part,
        accountId,
        toAccountId,
        groupId,
        installmentIndex: index + 1,
        installmentTotal: months,
        date: addMonths(date, index)
      })
    })
  } else if (input.payments && input.payments.length > 1) {
    const groupId = randomUUID()
    for (const payment of input.payments) {
      rowsToInsert.push({
        ...base,
        amount: num(payment.amount),
        accountId: num(payment.accountId) || null,
        toAccountId: null,
        groupId
      })
    }
  } else {
    rowsToInsert.push({ ...base, amount, accountId, toAccountId, groupId: '' })
  }

  const rows = await withOrm('personal-ledger.saveTransaction', async (db) =>
    db.insert(personal_ledger_transactions).values(rowsToInsert).returning()
  )
  return toTransactionDto(rows[0])
}

export async function deleteTransaction(id: number): Promise<boolean> {
  await schemaReady
  const rows = await withOrm('personal-ledger.deleteTransaction', async (db) =>
    db
      .delete(personal_ledger_transactions)
      .where(eq(personal_ledger_transactions.id, id))
      .returning({ id: personal_ledger_transactions.id })
  )
  return rows.length > 0
}

/** 批量删除（勾选后的删除）；group 传 true 时同组（组合支付 / 分期）一起删 */
export async function deleteTransactions(ids: number[], group = false): Promise<number> {
  await schemaReady
  const clean = ids.map((id) => Math.trunc(num(id))).filter((id) => id > 0)
  if (clean.length === 0) return 0
  if (!group) {
    const rows = await withOrm('personal-ledger.deleteTransactions', async (db) =>
      db
        .delete(personal_ledger_transactions)
        .where(inArray(personal_ledger_transactions.id, clean))
        .returning({ id: personal_ledger_transactions.id })
    )
    return rows.length
  }
  const all = await listTransactions()
  const groups = new Set(all.filter((tx) => clean.includes(tx.id) && tx.groupId).map((tx) => tx.groupId))
  const targetIds = new Set(clean)
  for (const tx of all) {
    if (tx.groupId && groups.has(tx.groupId)) targetIds.add(tx.id)
  }
  return deleteTransactions([...targetIds], false)
}

/** 复制一笔（“再来一单”：日期换成今天，其余照抄） */
export async function copyTransaction(id: number): Promise<Transaction | null> {
  await schemaReady
  const rows = await withOrm('personal-ledger.copyTransaction', async (db) =>
    db.select().from(personal_ledger_transactions).where(eq(personal_ledger_transactions.id, id))
  )
  if (!rows[0]) return null
  const source = toTransactionDto(rows[0])
  return saveTransaction({
    kind: source.kind,
    amount: source.amount,
    date: today(),
    time: nowTime(),
    currency: source.currency,
    rate: source.rate,
    categoryId: source.categoryId,
    accountId: source.accountId,
    toAccountId: source.toAccountId,
    merchantId: source.merchantId,
    tags: source.tags,
    note: source.note,
    fee: source.fee,
    discount: source.discount,
    member: source.member,
    myShare: source.myShare,
    splitMembers: source.splitMembers
  })
}

/* ────────────────────────────── 预算 ────────────────────────────── */

export async function listBudgets(): Promise<Budget[]> {
  await schemaReady
  const rows = await withOrm('personal-ledger.listBudgets', async (db) =>
    db.select().from(personal_ledger_budgets).orderBy(asc(personal_ledger_budgets.id))
  )
  return rows.map(toBudgetDto)
}

export async function saveBudget(input: Partial<Budget> & { amount: number }): Promise<Budget> {
  await schemaReady
  const values = {
    name: str(input.name),
    period: str(input.period, 'month'),
    scope: str(input.scope, 'total'),
    ref: str(input.ref),
    amount: num(input.amount),
    startDate: str(input.startDate),
    endDate: str(input.endDate)
  }
  if (input.id) {
    const rows = await withOrm('personal-ledger.saveBudget', async (db) =>
      db
        .update(personal_ledger_budgets)
        .set(values)
        .where(eq(personal_ledger_budgets.id, input.id as number))
        .returning()
    )
    if (!rows[0]) throw new Error(`预算 ${input.id} 不存在`)
    return toBudgetDto(rows[0])
  }
  const rows = await withOrm('personal-ledger.saveBudget', async (db) =>
    db.insert(personal_ledger_budgets).values(values).returning()
  )
  return toBudgetDto(rows[0])
}

export async function deleteBudget(id: number): Promise<boolean> {
  await schemaReady
  const rows = await withOrm('personal-ledger.deleteBudget', async (db) =>
    db
      .delete(personal_ledger_budgets)
      .where(eq(personal_ledger_budgets.id, id))
      .returning({ id: personal_ledger_budgets.id })
  )
  return rows.length > 0
}

/* ────────────────────────────── 目标 ────────────────────────────── */

export async function listGoals(): Promise<Goal[]> {
  await schemaReady
  const rows = await withOrm('personal-ledger.listGoals', async (db) =>
    db.select().from(personal_ledger_goals).orderBy(asc(personal_ledger_goals.id))
  )
  return rows.map(toGoalDto)
}

export async function saveGoal(input: Partial<Goal> & { name: string }): Promise<Goal> {
  await schemaReady
  const name = str(input.name).trim()
  if (!name) throw new Error('目标名不能为空')
  const values = {
    name,
    targetAmount: num(input.targetAmount),
    savedAmount: num(input.savedAmount),
    dueDate: str(input.dueDate),
    note: str(input.note)
  }
  if (input.id) {
    const rows = await withOrm('personal-ledger.saveGoal', async (db) =>
      db
        .update(personal_ledger_goals)
        .set(values)
        .where(eq(personal_ledger_goals.id, input.id as number))
        .returning()
    )
    if (!rows[0]) throw new Error(`目标 ${input.id} 不存在`)
    return toGoalDto(rows[0])
  }
  const rows = await withOrm('personal-ledger.saveGoal', async (db) =>
    db.insert(personal_ledger_goals).values(values).returning()
  )
  return toGoalDto(rows[0])
}

/** 往目标里存一笔（不记流水：目标是「心里的钱」，流水是「实际的钱」） */
export async function depositGoal(id: number, amount: number): Promise<Goal | null> {
  await schemaReady
  const rows = await withOrm('personal-ledger.depositGoal', async (db) =>
    db.select().from(personal_ledger_goals).where(eq(personal_ledger_goals.id, id))
  )
  if (!rows[0]) return null
  const next = Math.max(0, Number(rows[0].savedAmount ?? 0) + num(amount))
  const updated = await withOrm('personal-ledger.depositGoal', async (db) =>
    db
      .update(personal_ledger_goals)
      .set({ savedAmount: next })
      .where(eq(personal_ledger_goals.id, id))
      .returning()
  )
  return updated[0] ? toGoalDto(updated[0]) : null
}

export async function deleteGoal(id: number): Promise<boolean> {
  await schemaReady
  const rows = await withOrm('personal-ledger.deleteGoal', async (db) =>
    db.delete(personal_ledger_goals).where(eq(personal_ledger_goals.id, id)).returning({ id: personal_ledger_goals.id })
  )
  return rows.length > 0
}

/* ────────────────────────────── 周期记账 ────────────────────────────── */

export async function listRecurring(): Promise<Recurring[]> {
  await schemaReady
  const rows = await withOrm('personal-ledger.listRecurring', async (db) =>
    db.select().from(personal_ledger_recurring).orderBy(asc(personal_ledger_recurring.nextRun))
  )
  return rows.map(toRecurringDto)
}

export async function saveRecurring(input: Partial<Recurring> & { name: string }): Promise<Recurring> {
  await schemaReady
  const name = str(input.name).trim()
  if (!name) throw new Error('名称不能为空')
  const values = {
    name,
    kind: str(input.kind, 'expense'),
    amount: num(input.amount),
    categoryId: input.categoryId ?? null,
    accountId: input.accountId ?? null,
    frequency: str(input.frequency, 'monthly'),
    nextRun: str(input.nextRun, today()),
    enabled: input.enabled !== false,
    note: str(input.note)
  }
  if (input.id) {
    const rows = await withOrm('personal-ledger.saveRecurring', async (db) =>
      db
        .update(personal_ledger_recurring)
        .set(values)
        .where(eq(personal_ledger_recurring.id, input.id as number))
        .returning()
    )
    if (!rows[0]) throw new Error(`周期规则 ${input.id} 不存在`)
    return toRecurringDto(rows[0])
  }
  const rows = await withOrm('personal-ledger.saveRecurring', async (db) =>
    db.insert(personal_ledger_recurring).values(values).returning()
  )
  return toRecurringDto(rows[0])
}

export async function deleteRecurring(id: number): Promise<boolean> {
  await schemaReady
  const rows = await withOrm('personal-ledger.deleteRecurring', async (db) =>
    db
      .delete(personal_ledger_recurring)
      .where(eq(personal_ledger_recurring.id, id))
      .returning({ id: personal_ledger_recurring.id })
  )
  return rows.length > 0
}

function advance(date: string, frequency: Recurring['frequency']): string {
  const [y, m, d] = date.split('-').map((part) => Number(part))
  const base = new Date(y, m - 1, d)
  if (frequency === 'daily') base.setDate(base.getDate() + 1)
  else if (frequency === 'weekly') base.setDate(base.getDate() + 7)
  else if (frequency === 'yearly') base.setFullYear(base.getFullYear() + 1)
  else base.setMonth(base.getMonth() + 1)
  return today(base)
}

/**
 * 把到期的周期规则落成真实流水（房租、工资、订阅…）。
 *
 * 幂等性靠 `nextRun` 推进：只有 `nextRun <= 今天` 才生成，生成后把 nextRun 推到下一次，
 * 因此重复调用不会重复记账。返回新生成的条数。
 */
export async function runRecurring(): Promise<number> {
  await schemaReady
  const rules = (await listRecurring()).filter((rule) => rule.enabled && rule.nextRun <= today())
  let created = 0
  for (const rule of rules) {
    let nextRun = rule.nextRun
    let guard = 0
    while (nextRun <= today() && guard < 60) {
      await saveTransaction({
        kind: rule.kind,
        amount: rule.amount,
        date: nextRun,
        categoryId: rule.categoryId,
        accountId: rule.accountId,
        note: rule.note || rule.name,
        tags: [],
        recurringId: rule.id
      } as TransactionInput)
      created += 1
      nextRun = advance(nextRun, rule.frequency)
      guard += 1
    }
    await withOrm('personal-ledger.runRecurring', async (db) =>
      db
        .update(personal_ledger_recurring)
        .set({ nextRun })
        .where(eq(personal_ledger_recurring.id, rule.id))
    )
  }
  return created
}

/* ────────────────────────────── 借入借出 ────────────────────────────── */

export async function listDebts(): Promise<Debt[]> {
  await schemaReady
  const rows = await withOrm('personal-ledger.listDebts', async (db) =>
    db.select().from(personal_ledger_debts).orderBy(asc(personal_ledger_debts.id))
  )
  return rows.map(toDebtDto)
}

export async function saveDebt(input: Partial<Debt> & { counterparty: string }): Promise<Debt> {
  await schemaReady
  const counterparty = str(input.counterparty).trim()
  if (!counterparty) throw new Error('对方不能为空')
  const values = {
    direction: input.direction === 'borrow' ? 'borrow' : 'lend',
    counterparty,
    amount: num(input.amount),
    settled: num(input.settled),
    dueDate: str(input.dueDate),
    note: str(input.note)
  }
  if (input.id) {
    const rows = await withOrm('personal-ledger.saveDebt', async (db) =>
      db
        .update(personal_ledger_debts)
        .set(values)
        .where(eq(personal_ledger_debts.id, input.id as number))
        .returning()
    )
    if (!rows[0]) throw new Error(`借还款 ${input.id} 不存在`)
    return toDebtDto(rows[0])
  }
  const rows = await withOrm('personal-ledger.saveDebt', async (db) =>
    db.insert(personal_ledger_debts).values(values).returning()
  )
  return toDebtDto(rows[0])
}

export async function deleteDebt(id: number): Promise<boolean> {
  await schemaReady
  const rows = await withOrm('personal-ledger.deleteDebt', async (db) =>
    db.delete(personal_ledger_debts).where(eq(personal_ledger_debts.id, id)).returning({ id: personal_ledger_debts.id })
  )
  return rows.length > 0
}

/* ────────────────────────────── 定期存款 ────────────────────────────── */

export async function listDeposits(): Promise<Deposit[]> {
  await schemaReady
  const rows = await withOrm('personal-ledger.listDeposits', async (db) =>
    db.select().from(personal_ledger_deposits).orderBy(asc(personal_ledger_deposits.maturityDate))
  )
  return rows.map(toDepositDto)
}

export async function saveDeposit(input: Partial<Deposit> & { name: string }): Promise<Deposit> {
  await schemaReady
  const name = str(input.name).trim()
  if (!name) throw new Error('名称不能为空')
  const values = {
    name,
    accountId: input.accountId ?? null,
    principal: num(input.principal),
    rate: num(input.rate),
    startDate: str(input.startDate, today()),
    maturityDate: str(input.maturityDate),
    note: str(input.note)
  }
  if (input.id) {
    const rows = await withOrm('personal-ledger.saveDeposit', async (db) =>
      db
        .update(personal_ledger_deposits)
        .set(values)
        .where(eq(personal_ledger_deposits.id, input.id as number))
        .returning()
    )
    if (!rows[0]) throw new Error(`存款 ${input.id} 不存在`)
    return toDepositDto(rows[0])
  }
  const rows = await withOrm('personal-ledger.saveDeposit', async (db) =>
    db.insert(personal_ledger_deposits).values(values).returning()
  )
  return toDepositDto(rows[0])
}

export async function deleteDeposit(id: number): Promise<boolean> {
  await schemaReady
  const rows = await withOrm('personal-ledger.deleteDeposit', async (db) =>
    db
      .delete(personal_ledger_deposits)
      .where(eq(personal_ledger_deposits.id, id))
      .returning({ id: personal_ledger_deposits.id })
  )
  return rows.length > 0
}

/* ────────────────────────────── 导入 / 清空 ────────────────────────────── */

/** 批量导入（CSV / Excel 转出来的行）；返回实际入库条数 */
export async function importTransactions(
  rows: TransactionInput[],
  rules?: ClassifyRule[]
): Promise<number> {
  await schemaReady
  let inserted = 0
  for (const row of rows) {
    await saveTransaction(row, rules)
    inserted += 1
  }
  return inserted
}

/** 首次运行 / 示例数据：给一份能马上看懂的起步账本 */
export async function seedIfEmpty(): Promise<boolean> {
  await schemaReady
  const accounts = await listAccounts()
  if (accounts.length > 0) return false
  const cash = await saveAccount({ name: '现金', type: 'cash', initialBalance: 500, sort: 1 })
  const bank = await saveAccount({ name: '储蓄卡', type: 'debit', initialBalance: 12000, sort: 2 })
  await saveAccount({
    name: '信用卡',
    type: 'credit',
    initialBalance: 0,
    creditLimit: 20000,
    billDay: 5,
    repayDay: 20,
    sort: 3
  })
  const food = await saveCategory({ name: '餐饮', kind: 'expense', color: '#f97316', icon: 'RiRestaurantLine', sort: 1 })
  const traffic = await saveCategory({ name: '交通', kind: 'expense', color: '#0ea5e9', icon: 'RiBusLine', sort: 2 })
  const shopping = await saveCategory({ name: '购物', kind: 'expense', color: '#ec4899', icon: 'RiShoppingBagLine', sort: 3 })
  await saveCategory({ name: '餐饮外卖', kind: 'expense', parentId: food.id, color: '#fb923c', sort: 1 })
  await saveCategory({ name: '工资', kind: 'income', color: '#22c55e', icon: 'RiWalletLine', sort: 1 })
  await saveCategory({ name: '理财收益', kind: 'income', color: '#10b981', sort: 2 })
  await saveCategory({ name: '其它', kind: 'expense', color: '#94a3b8', sort: 9 })
  await saveTag({ name: '必要支出', color: '#ef4444' })
  await saveTag({ name: '可省', color: '#22c55e' })
  await saveMerchant({ name: '楼下便利店', categoryId: shopping.id })
  await saveMerchant({ name: '地铁', categoryId: traffic.id })
  const day = today()
  await saveTransaction({
    kind: 'expense',
    amount: 28.5,
    date: day,
    categoryId: food.id,
    accountId: cash.id,
    merchantName: '楼下便利店',
    note: '午餐',
    tags: ['必要支出']
  })
  await saveTransaction({
    kind: 'expense',
    amount: 6,
    date: day,
    categoryId: traffic.id,
    accountId: bank.id,
    note: '地铁',
    tags: ['必要支出']
  })
  await saveTransaction({
    kind: 'income',
    amount: 15000,
    date: day,
    categoryId: (await ensureCategory('工资', 'income')),
    accountId: bank.id,
    note: '本月工资',
    member: '我'
  })
  await saveBudget({ name: '每月总预算', period: 'month', scope: 'total', amount: 6000 })
  await saveBudget({
    name: '餐饮预算',
    period: 'month',
    scope: 'category',
    ref: String(food.id),
    amount: 1500
  })
  await saveGoal({ name: '应急金', targetAmount: 30000, savedAmount: 8000, note: '6 个月生活费' })
  await saveRecurring({
    name: '房租',
    kind: 'expense',
    amount: 2500,
    categoryId: null,
    accountId: bank.id,
    frequency: 'monthly',
    nextRun: addMonths(day, 1),
    note: '每月房租'
  })
  await saveDebt({ direction: 'lend', counterparty: '小王', amount: 800, settled: 0, note: '垫付团建' })
  await saveDeposit({
    name: '三年定期',
    accountId: bank.id,
    principal: 50000,
    rate: 2.6,
    startDate: day,
    maturityDate: addMonths(day, 36)
  })
  return true
}

/** 清空本插件的全部数据（卸载清数据；不动表结构，迁移记录必须保持一致） */
export async function deleteAllData(): Promise<number> {
  await schemaReady
  const tables = [
    personal_ledger_transactions,
    personal_ledger_accounts,
    personal_ledger_categories,
    personal_ledger_tags,
    personal_ledger_merchants,
    personal_ledger_budgets,
    personal_ledger_goals,
    personal_ledger_recurring,
    personal_ledger_debts,
    personal_ledger_deposits
  ]
  let removed = 0
  for (const table of tables) {
    const rows = await withOrm('personal-ledger.deleteAllData', async (db) =>
      db.delete(table).returning()
    )
    removed += rows.length
  }
  return removed
}

/** 导出用：一次性把所有表读出来（JSON 备份的口径） */
export async function exportSnapshot(): Promise<Record<string, unknown>> {
  await schemaReady
  const [accounts, categories, tags, merchants, transactions, budgets, goals, recurring, debts, deposits] =
    await Promise.all([
      listAccounts(),
      listCategories(),
      listTags(),
      listMerchants(),
      listTransactions(),
      listBudgets(),
      listGoals(),
      listRecurring(),
      listDebts(),
      listDeposits()
    ])
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts,
    categories,
    tags,
    merchants,
    transactions,
    budgets,
    goals,
    recurring,
    debts,
    deposits
  }
}

/** 供 reports 用的轻量聚合：账户余额（期初 ± 流水 + 转入转出） */
export function accountBalances(
  accounts: Account[],
  transactions: Transaction[]
): Map<number, { inflow: number; outflow: number; balance: number; txCount: number }> {
  const result = new Map<number, { inflow: number; outflow: number; balance: number; txCount: number }>()
  for (const account of accounts) {
    result.set(account.id, { inflow: 0, outflow: 0, balance: account.initialBalance, txCount: 0 })
  }
  for (const tx of transactions) {
    const rate = tx.rate || 1
    const face = tx.amount * rate
    if (tx.accountId && result.has(tx.accountId)) {
      const entry = result.get(tx.accountId)!
      entry.txCount += 1
      if (tx.kind === 'income') {
        entry.inflow += face - tx.fee * rate
        entry.balance += face - tx.fee * rate
      } else {
        const cost = face + tx.fee * rate - tx.discount * rate
        entry.outflow += cost
        entry.balance -= cost
      }
    }
    if (tx.kind === 'transfer' && tx.toAccountId && result.has(tx.toAccountId)) {
      const entry = result.get(tx.toAccountId)!
      entry.txCount += 1
      const net = face - tx.fee * rate
      entry.inflow += net
      entry.balance += net
    }
  }
  return result
}
