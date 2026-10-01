import type {
  Account,
  AccountStat,
  AccountSummary,
  Anomaly,
  Budget,
  BudgetProgress,
  CalendarDay,
  CategoryStat,
  Dashboard,
  Debt,
  Deposit,
  HealthReport,
  InvestmentPnl,
  LedgerReport,
  LedgerSettings,
  MemberStat,
  RangeInput,
  RankingItem,
  Recurring,
  ReminderItem,
  Tag,
  Transaction,
  TrendPoint
} from '../../shared/types'
import {
  accountBalances,
  listAccounts,
  listBudgets,
  listCategories,
  listDebts,
  listDeposits,
  listMerchants,
  listRecurring,
  listTags,
  listTransactions,
  today
} from './mapper'

/**
 * 个人记账台账 的统计与报表（首页概览 / 报表页 / 提醒都从这里出）。
 *
 * 为什么把汇总放在主进程：AI 工具、页面、导出用的是**同一套口径**；
 * 口径写两遍迟早会分叉（页面说花了 1000、工具说 1200 是最难查的一类 bug）。
 *
 * 口径（改之前先读）：
 * - 收入 = kind='income' 且不是退款、不是余额调整；
 * - 支出 = kind='expense' 的金额 + 手续费 − 优惠，**AA 分账只算我承担的部分**；
 * - 退款 = kind='income' 且 refundOfId 有值：冲减它的分类支出，不计入收入；
 * - 余额调整（adjust=true）只影响账户余额，不进收支统计；
 * - 转账两边都不进收支（钱只是换了个口袋）。
 */

export const DAY_MS = 24 * 60 * 60 * 1000

function pad(value: number): string {
  return `${value}`.padStart(2, '0')
}

export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function parseDate(value: string): Date {
  const [y, m, d] = value.split('-').map((part) => Number(part))
  return new Date(y || 1970, (m || 1) - 1, d || 1)
}

export function addDays(value: string, days: number): string {
  const date = parseDate(value)
  date.setDate(date.getDate() + days)
  return formatDate(date)
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / DAY_MS)
}

/** 某个周期的起止（week 以周一为一周开始） */
export function periodRange(period: Budget['period'], ref = today()): RangeInput {
  const date = parseDate(ref)
  if (period === 'week') {
    const weekday = (date.getDay() + 6) % 7
    const start = addDays(ref, -weekday)
    return { from: start, to: addDays(start, 6) }
  }
  if (period === 'year') {
    return { from: `${date.getFullYear()}-01-01`, to: `${date.getFullYear()}-12-31` }
  }
  const from = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-01`
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  return { from, to: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(lastDay)}` }
}

/** 当月区间 */
export function monthRange(ref = today()): RangeInput {
  return periodRange('month', ref)
}

/** 基准币种金额 */
export function base(tx: Transaction): number {
  return tx.amount * (tx.rate || 1)
}

/** 一笔支出真正花掉的钱（含手续费、减优惠） */
export function cost(tx: Transaction): number {
  const rate = tx.rate || 1
  return base(tx) + tx.fee * rate - tx.discount * rate
}

/** 计入「我的支出」的金额（AA 分账只算我承担的部分） */
export function myExpense(tx: Transaction): number {
  const rate = tx.rate || 1
  const mine = tx.myShare > 0 ? tx.myShare * rate : cost(tx)
  return mine
}

function isRefund(tx: Transaction): boolean {
  return tx.kind === 'income' && tx.refundOfId !== null
}

function isAdjust(tx: Transaction): boolean {
  return tx.adjust === true
}

/** 收支汇总（不含转账 / 余额调整） */
export function summarize(transactions: Transaction[]): {
  income: number
  expense: number
  refund: number
  balance: number
} {
  let income = 0
  let expense = 0
  let refund = 0
  for (const tx of transactions) {
    if (tx.kind === 'transfer' || isAdjust(tx)) continue
    if (tx.kind === 'income') {
      if (isRefund(tx)) refund += base(tx)
      else income += base(tx) - tx.fee * (tx.rate || 1)
    } else if (tx.kind === 'expense') {
      expense += myExpense(tx)
    }
  }
  return { income, expense, refund, balance: income - expense }
}

/** 账户汇总（余额是流水算出来的，不入库——避免两处真源打架） */
export function buildAccountSummaries(
  accounts: Account[],
  transactions: Transaction[]
): AccountSummary[] {
  const balances = accountBalances(accounts, transactions)
  return accounts.map((account) => {
    const entry = balances.get(account.id) ?? { inflow: 0, outflow: 0, balance: account.initialBalance, txCount: 0 }
    const liability =
      account.type === 'credit' || account.type === 'debt' ? Math.max(0, -entry.balance) : 0
    return {
      ...account,
      balance: Math.round(entry.balance * 100) / 100,
      inflow: Math.round(entry.inflow * 100) / 100,
      outflow: Math.round(entry.outflow * 100) / 100,
      liability,
      txCount: entry.txCount
    }
  })
}

/** 净资产：资产 − 负债（只算 includeInNetWorth 的账户） */
export function netWorth(summaries: AccountSummary[]): { assets: number; liabilities: number; net: number } {
  let assets = 0
  let liabilities = 0
  for (const account of summaries) {
    if (!account.includeInNetWorth) continue
    if (account.type === 'credit' || account.type === 'debt') {
      liabilities += Math.max(0, -account.balance)
      if (account.balance > 0) assets += account.balance
    } else {
      assets += Math.max(0, account.balance)
      liabilities += Math.max(0, -account.balance)
    }
  }
  return { assets, liabilities, net: assets - liabilities }
}

/** 预算进度（按各自周期算花掉了多少） */
export function buildBudgetProgress(
  budgets: Budget[],
  transactions: Transaction[],
  ref = today()
): BudgetProgress[] {
  return budgets.map((budget) => {
    const range =
      budget.period === 'custom' && budget.startDate && budget.endDate
        ? { from: budget.startDate, to: budget.endDate }
        : periodRange(budget.period, ref)
    const inRange = transactions.filter(
      (tx) => tx.date >= range.from && tx.date <= range.to && tx.kind === 'expense' && !isAdjust(tx)
    )
    let spent = 0
    for (const tx of inRange) {
      const mine = myExpense(tx)
      if (budget.scope === 'total') spent += mine
      else if (budget.scope === 'category') {
        if (String(tx.categoryId ?? '') === budget.ref) spent += mine
      } else if (budget.scope === 'tag') {
        if (tx.tags.includes(budget.ref)) spent += mine
      } else if (budget.scope === 'account') {
        if (String(tx.accountId ?? '') === budget.ref) spent += mine
      } else if (budget.scope === 'member') {
        if (tx.member === budget.ref) spent += mine
      }
    }
    const rounded = Math.round(spent * 100) / 100
    const amount = budget.amount
    return {
      ...budget,
      spent: rounded,
      remaining: Math.round((amount - rounded) * 100) / 100,
      ratio: amount > 0 ? Math.round((rounded / amount) * 1000) / 1000 : 0,
      periodFrom: range.from,
      periodTo: range.to
    }
  })
}

/* ────────────────────────────── 报表 ────────────────────────────── */

export async function buildReport(range: RangeInput): Promise<LedgerReport> {
  const [accounts, transactions, categories, merchants] = await Promise.all([
    listAccounts(),
    listTransactions(),
    listCategories(),
    listMerchants()
  ])
  const inRange = transactions.filter((tx) => tx.date >= range.from && tx.date <= range.to)
  const summary = summarize(inRange)
  const summaries = buildAccountSummaries(accounts, transactions)
  const categoryName = new Map(categories.map((c) => [c.id, { name: c.name, color: c.color }]))
  const merchantName = new Map(merchants.map((m) => [m.id, m.name]))

  // 分类统计（同上口径，但这里要在主进程里补齐名字）
  const buckets = new Map<string, { amount: number; net: number; count: number }>()
  for (const tx of inRange) {
    if (isAdjust(tx)) continue
    if (tx.kind === 'expense') {
      const entry = buckets.get(String(tx.categoryId ?? 'none')) ?? { amount: 0, net: 0, count: 0 }
      entry.amount += cost(tx)
      entry.net += myExpense(tx)
      entry.count += 1
      buckets.set(String(tx.categoryId ?? 'none'), entry)
    } else if (tx.kind === 'income' && isRefund(tx)) {
      const entry = buckets.get(String(tx.categoryId ?? 'none')) ?? { amount: 0, net: 0, count: 0 }
      entry.net -= base(tx)
      entry.count += 1
      buckets.set(String(tx.categoryId ?? 'none'), entry)
    }
  }
  const expenseTotal = [...buckets.values()].reduce((sum, entry) => sum + Math.max(0, entry.net), 0)
  const categoryStatsList: CategoryStat[] = [...buckets.entries()]
    .map(([key, entry]) => {
      const id = key === 'none' ? null : Number(key)
      return {
        categoryId: id,
        name: id === null ? '' : categoryName.get(id)?.name ?? '',
        color: id === null ? '#94a3b8' : categoryName.get(id)?.color ?? '#94a3b8',
        amount: Math.round(entry.amount * 100) / 100,
        net: Math.round(entry.net * 100) / 100,
        count: entry.count,
        ratio:
          expenseTotal > 0 ? Math.round((Math.max(0, entry.net) / expenseTotal) * 1000) / 1000 : 0
      }
    })
    .sort((a, b) => b.net - a.net)

  // 账户统计（区间内的进出 + 当前余额）
  const accountStatsList: AccountStat[] = summaries.map((account) => {
    let inflow = 0
    let outflow = 0
    for (const tx of inRange) {
      const rate = tx.rate || 1
      if (tx.accountId === account.id) {
        if (tx.kind === 'income') inflow += base(tx) - tx.fee * rate
        else outflow += cost(tx)
      }
      if (tx.kind === 'transfer' && tx.toAccountId === account.id) inflow += base(tx) - tx.fee * rate
    }
    return {
      accountId: account.id,
      name: account.name,
      type: account.type,
      inflow: Math.round(inflow * 100) / 100,
      outflow: Math.round(outflow * 100) / 100,
      balance: account.balance
    }
  })

  // 成员统计
  const memberBuckets = new Map<string, MemberStat>()
  for (const tx of inRange) {
    if (tx.kind === 'transfer' || isAdjust(tx)) continue
    const key = tx.member || ''
    const entry = memberBuckets.get(key) ?? { member: key, income: 0, expense: 0, balance: 0 }
    if (tx.kind === 'income' && !isRefund(tx)) entry.income += base(tx)
    else if (tx.kind === 'expense') entry.expense += myExpense(tx)
    entry.balance = entry.income - entry.expense
    memberBuckets.set(key, entry)
  }

  // 趋势（区间 <= 62 天按天，否则按月）+ 净资产走势
  const days = Math.max(1, daysBetween(range.from, range.to))
  const byMonth = days > 62
  const trendMap = new Map<string, TrendPoint>()
  const key = (date: string): string => (byMonth ? date.slice(0, 7) : date)
  // 先把空档补齐：没有消费的那天也要在曲线上（否则趋势图会骗人）
  const cursor = parseDate(range.from)
  let guard = 0
  while (formatDate(cursor) <= range.to && guard < 2000) {
    const k = key(formatDate(cursor))
    if (!trendMap.has(k)) trendMap.set(k, { period: k, income: 0, expense: 0, balance: 0, netWorth: 0 })
    if (byMonth) cursor.setMonth(cursor.getMonth() + 1, 1)
    else cursor.setDate(cursor.getDate() + 1)
    guard += 1
  }
  for (const tx of inRange) {
    if (isAdjust(tx) || tx.kind === 'transfer') continue
    const k = key(tx.date)
    const point = trendMap.get(k) ?? { period: k, income: 0, expense: 0, balance: 0, netWorth: 0 }
    if (tx.kind === 'income' && !isRefund(tx)) point.income += base(tx)
    else if (tx.kind === 'expense') point.expense += myExpense(tx)
    point.balance = point.income - point.expense
    trendMap.set(k, point)
  }
  const trend = [...trendMap.values()].sort((a, b) => a.period.localeCompare(b.period))
  // 净资产：期末（区间结束那天）的资产 − 负债
  const upto = transactions.filter((tx) => tx.date <= range.to)
  const nw = netWorth(buildAccountSummaries(accounts, upto))
  if (trend.length > 0) trend[trend.length - 1].netWorth = Math.round(nw.net * 100) / 100

  // 日历（按天）
  const calendarMap = new Map<string, CalendarDay>()
  for (const tx of inRange) {
    if (tx.kind === 'transfer' || isAdjust(tx)) continue
    const entry = calendarMap.get(tx.date) ?? { date: tx.date, income: 0, expense: 0, count: 0 }
    if (tx.kind === 'income' && !isRefund(tx)) entry.income += base(tx)
    else if (tx.kind === 'expense') entry.expense += myExpense(tx)
    entry.count += 1
    calendarMap.set(tx.date, entry)
  }

  // 商家排行
  const merchantBuckets = new Map<string, RankingItem>()
  for (const tx of inRange) {
    if (tx.kind !== 'expense' || isAdjust(tx)) continue
    const k = tx.merchantId ? String(tx.merchantId) : 'none'
    const item = merchantBuckets.get(k) ?? {
      key: k,
      label: tx.merchantId ? merchantName.get(tx.merchantId) ?? '' : '',
      amount: 0,
      count: 0
    }
    item.amount += myExpense(tx)
    item.count += 1
    merchantBuckets.set(k, item)
  }
  const merchantRanking = [...merchantBuckets.values()]
    .map((item) => ({ ...item, amount: Math.round(item.amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10)

  // 最大支出 + 异常识别
  const expenses = inRange
    .filter((tx) => tx.kind === 'expense' && !isAdjust(tx))
    .sort((a, b) => base(b) - base(a))
  const topExpenses: Anomaly[] = expenses.slice(0, 5).map((tx) => ({
    id: tx.id,
    date: tx.date,
    amount: Math.round(base(tx) * 100) / 100,
    note: tx.note,
    reason: 'large'
  }))
  const anomalies = detectAnomalies(expenses)

  const health = buildHealth(summary, categoryStatsList, nw, days)
  const investments = buildInvestments(summaries, transactions)

  return {
    from: range.from,
    to: range.to,
    income: Math.round(summary.income * 100) / 100,
    expense: Math.round(summary.expense * 100) / 100,
    refund: Math.round(summary.refund * 100) / 100,
    balance: Math.round(summary.balance * 100) / 100,
    count: inRange.length,
    categoryStats: categoryStatsList,
    accountStats: accountStatsList,
    memberStats: [...memberBuckets.values()].map((entry) => ({
      ...entry,
      income: Math.round(entry.income * 100) / 100,
      expense: Math.round(entry.expense * 100) / 100,
      balance: Math.round(entry.balance * 100) / 100
    })),
    trend,
    calendar: [...calendarMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    merchantRanking,
    topExpenses,
    anomalies,
    health,
    investments
  }
}

/** 异常消费：大额 / 突增 / 疑似重复扣款 */
function detectAnomalies(expenses: Transaction[]): Anomaly[] {
  if (expenses.length === 0) return []
  const amounts = expenses.map((tx) => base(tx))
  const mean = amounts.reduce((sum, value) => sum + value, 0) / amounts.length
  const variance = amounts.reduce((sum, value) => sum + (value - mean) ** 2, 0) / amounts.length
  const sigma = Math.sqrt(variance)
  const found: Anomaly[] = []
  for (const tx of expenses) {
    const amount = base(tx)
    if (sigma > 0 && amount > mean + 2 * sigma && amount > 100) {
      found.push({ id: tx.id, date: tx.date, amount: Math.round(amount * 100) / 100, note: tx.note, reason: 'large' })
    }
  }
  // 疑似重复扣款：同账户、金额相同、3 天内出现两次以上
  const seen = new Map<string, Transaction[]>()
  for (const tx of expenses) {
    const k = `${tx.accountId ?? 'none'}|${base(tx).toFixed(2)}`
    const list = seen.get(k) ?? []
    list.push(tx)
    seen.set(k, list)
  }
  for (const list of seen.values()) {
    if (list.length < 2) continue
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date))
    for (let i = 1; i < sorted.length; i += 1) {
      if (daysBetween(sorted[i - 1].date, sorted[i].date) <= 3) {
        found.push({
          id: sorted[i].id,
          date: sorted[i].date,
          amount: Math.round(base(sorted[i]) * 100) / 100,
          note: sorted[i].note,
          reason: 'duplicate'
        })
      }
    }
  }
  return found.slice(0, 20)
}

/** 财务健康分析：储蓄率 / 负债率 / 消费结构 */
function buildHealth(
  summary: { income: number; expense: number },
  stats: CategoryStat[],
  nw: { assets: number; liabilities: number; net: number },
  days: number
): HealthReport {
  const savingsRate = summary.income > 0 ? (summary.income - summary.expense) / summary.income : 0
  const debtRatio = nw.assets > 0 ? nw.liabilities / nw.assets : nw.liabilities > 0 ? 1 : 0
  const topCategoryRatio = stats.slice(0, 3).reduce((sum, item) => sum + item.ratio, 0)
  const dailyExpense = days > 0 ? summary.expense / days : 0
  return {
    savingsRate: Math.round(savingsRate * 1000) / 1000,
    debtRatio: Math.round(debtRatio * 1000) / 1000,
    expenseRatio: summary.income > 0 ? Math.round((summary.expense / summary.income) * 1000) / 1000 : 0,
    topCategoryRatio: Math.round(topCategoryRatio * 1000) / 1000,
    dailyExpense: Math.round(dailyExpense * 100) / 100,
    projectedExpense: Math.round(dailyExpense * Math.max(days, 30) * 100) / 100
  }
}

/** 投资账户盈亏：市值（余额） − 期初 − 净投入 */
function buildInvestments(summaries: AccountSummary[], transactions: Transaction[]): InvestmentPnl[] {
  return summaries
    .filter((account) => account.type === 'investment')
    .map((account) => {
      let netIn = 0
      for (const tx of transactions) {
        const rate = tx.rate || 1
        if (tx.accountId === account.id) {
          if (tx.kind === 'income') netIn -= base(tx)
          else netIn += cost(tx)
        }
        if (tx.kind === 'transfer' && tx.toAccountId === account.id) netIn += base(tx)
      }
      const invested = account.initialBalance + netIn
      const profit = account.balance - invested
      return {
        accountId: account.id,
        name: account.name,
        invested: Math.round(invested * 100) / 100,
        value: Math.round(account.balance * 100) / 100,
        profit: Math.round(profit * 100) / 100,
        ratio: invested > 0 ? Math.round((profit / invested) * 1000) / 1000 : 0
      }
    })
}

/* ────────────────────────────── 首页 / 提醒 ────────────────────────────── */

export async function buildDashboard(
  settings: LedgerSettings,
  ref = today()
): Promise<Dashboard> {
  const [accounts, transactions, budgets, recurring, debts, deposits] = await Promise.all([
    listAccounts(),
    listTransactions(),
    listBudgets(),
    listRecurring(),
    listDebts(),
    listDeposits()
  ])
  const summaries = buildAccountSummaries(accounts, transactions)
  const nw = netWorth(summaries)
  const month = monthRange(ref)
  const monthTx = transactions.filter((tx) => tx.date >= month.from && tx.date <= month.to)
  const summary = summarize(monthTx)
  const progress = buildBudgetProgress(budgets, transactions, ref)
  const todaySummary = summarize(transactions.filter((tx) => tx.date === ref))
  const pendingReimburse = transactions
    .filter((tx) => tx.reimburseStatus === 'pending' && tx.kind === 'expense')
    .reduce((sum, tx) => sum + myExpense(tx), 0)
  const receivable = transactions
    .filter((tx) => tx.kind === 'expense' && tx.myShare > 0)
    .reduce((sum, tx) => sum + (cost(tx) - myExpense(tx)), 0)
  const payable = debts
    .filter((debt) => debt.direction === 'borrow')
    .reduce((sum, debt) => sum + Math.max(0, debt.amount - debt.settled), 0)

  const monthCalendar: CalendarDay[] = monthTx
    .filter((tx) => tx.kind !== 'transfer' && !isAdjust(tx))
    .map((tx) => ({
      date: tx.date,
      income: tx.kind === 'income' && !isRefund(tx) ? base(tx) : 0,
      expense: tx.kind === 'expense' ? myExpense(tx) : 0,
      count: 1
    }))

  return {
    assets: round(nw.assets),
    liabilities: round(nw.liabilities),
    netWorth: round(nw.net),
    monthIncome: round(summary.income),
    monthExpense: round(summary.expense),
    monthBalance: round(summary.balance),
    todayExpense: round(todaySummary.expense),
    budgets: progress,
    reminders: buildReminders({
      settings,
      ref,
      budgets: progress,
      recurring,
      debts,
      deposits,
      accounts: summaries,
      transactions,
      pendingReimburse
    }),
    recent: transactions.slice(0, 8),
    pendingReimburse: round(pendingReimburse),
    receivable: round(receivable),
    payable: round(payable),
    monthCalendar: monthCalendar.sort((a, b) => a.date.localeCompare(b.date))
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function nextOccurrence(day: number, ref: string): string {
  if (day <= 0) return ''
  const date = parseDate(ref)
  const candidate = new Date(date.getFullYear(), date.getMonth(), day)
  if (formatDate(candidate) < ref) {
    return formatDate(new Date(date.getFullYear(), date.getMonth() + 1, day))
  }
  return formatDate(candidate)
}

/** 提醒：周期账单、预算超支、还款日、存款到期、待报销、每日记账 */
function buildReminders(input: {
  settings: LedgerSettings
  ref: string
  budgets: BudgetProgress[]
  recurring: Recurring[]
  debts: Debt[]
  deposits: Deposit[]
  accounts: AccountSummary[]
  transactions: Transaction[]
  pendingReimburse: number
}): ReminderItem[] {
  const { settings, ref, budgets, recurring, debts, deposits, accounts, transactions } = input
  const items: ReminderItem[] = []
  const threshold = settings.budgetAlertRatio > 0 ? settings.budgetAlertRatio : 0.8

  for (const budget of budgets) {
    if (budget.ratio >= threshold) {
      items.push({
        id: `budget-${budget.id}`,
        kind: 'budget',
        title: `${budget.name || budget.scope} 预算`,
        detail:
          budget.ratio >= 1
            ? `已超支 ${round(budget.spent - budget.amount)}`
            : `已用 ${Math.round(budget.ratio * 100)}%，剩 ${round(budget.remaining)}`,
        date: budget.periodTo,
        amount: round(budget.spent),
        level: budget.ratio >= 1 ? 'danger' : 'warning'
      })
    }
  }

  for (const rule of recurring) {
    if (!rule.enabled) continue
    const diff = daysBetween(ref, rule.nextRun)
    if (diff <= 7) {
      items.push({
        id: `recurring-${rule.id}`,
        kind: 'recurring',
        title: rule.name,
        detail: `${rule.nextRun} 将自动记账 ${rule.amount}`,
        date: rule.nextRun,
        amount: rule.amount,
        level: diff < 0 ? 'danger' : diff <= 1 ? 'warning' : 'info'
      })
    }
  }

  for (const debt of debts) {
    const open = debt.amount - debt.settled
    if (open <= 0) continue
    const due = debt.dueDate || ''
    const diff = due ? daysBetween(ref, due) : 999
    if (diff <= 7) {
      items.push({
        id: `debt-${debt.id}`,
        kind: 'debt',
        title: `${debt.direction === 'lend' ? '待收' : '待还'}：${debt.counterparty}`,
        detail: `未结清 ${round(open)}${due ? `，到期 ${due}` : ''}`,
        date: due,
        amount: round(open),
        level: diff < 0 ? 'danger' : 'warning'
      })
    }
  }

  for (const deposit of deposits) {
    if (!deposit.maturityDate) continue
    const diff = daysBetween(ref, deposit.maturityDate)
    if (diff <= 30) {
      items.push({
        id: `deposit-${deposit.id}`,
        kind: 'deposit',
        title: deposit.name,
        detail: `${deposit.maturityDate} 到期（本金 ${round(deposit.principal)}，利率 ${deposit.rate}%）`,
        date: deposit.maturityDate,
        amount: round(deposit.principal),
        level: diff < 0 ? 'info' : diff <= 7 ? 'warning' : 'info'
      })
    }
  }

  for (const account of accounts) {
    if (account.type !== 'credit' || account.repayDay <= 0) continue
    const due = nextOccurrence(account.repayDay, ref)
    if (!due) continue
    const diff = daysBetween(ref, due)
    if (diff <= 7) {
      items.push({
        id: `card-${account.id}`,
        kind: 'card',
        title: `${account.name} 还款日`,
        detail: `${due} 前还款，当前欠款 ${round(Math.max(0, -account.balance))}`,
        date: due,
        amount: round(Math.max(0, -account.balance)),
        level: diff <= 1 ? 'danger' : 'warning'
      })
    }
  }

  const pending = transactions.filter((tx) => tx.reimburseStatus === 'pending')
  if (pending.length > 0) {
    items.push({
      id: 'reimburse',
      kind: 'reimburse',
      title: '待报销',
      detail: `${pending.length} 笔，合计 ${round(input.pendingReimburse)}`,
      date: ref,
      amount: round(input.pendingReimburse),
      level: 'info'
    })
  }

  if (settings.dailyReminder) {
    items.push({
      id: 'daily',
      kind: 'daily',
      title: '每日记账提醒',
      detail: `${settings.dailyReminder} 提醒你记今天的账`,
      date: ref,
      amount: 0,
      level: 'info'
    })
  }

  return items.sort((a, b) => a.date.localeCompare(b.date))
}

/** 首页要用的基础数据（页面一次拉全，少几次往返） */
export async function buildInitialState(): Promise<{
  accounts: AccountSummary[]
  categories: Awaited<ReturnType<typeof listCategories>>
  tags: Tag[]
  merchants: Awaited<ReturnType<typeof listMerchants>>
}> {
  const [accounts, categories, tags, merchants, transactions] = await Promise.all([
    listAccounts(),
    listCategories(),
    listTags(),
    listMerchants(),
    listTransactions()
  ])
  return { accounts: buildAccountSummaries(accounts, transactions), categories, tags, merchants }
}
