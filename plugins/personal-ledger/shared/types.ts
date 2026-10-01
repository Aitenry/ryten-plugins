/**
 * 个人记账台账 的跨进程契约（主进程 mapper / 渲染层组件共用）。
 *
 * 规矩：**不 import drizzle / electron / node**——渲染层也要 import 它，
 * 带上任何一端的东西都会把那一端打进另一端的产物。
 *
 * 记账口径（全插件统一，改之前先读）：
 * - 金额一律存**正数**，方向由 `kind` 决定（expense 支出 / income 收入 / transfer 转账）；
 * - 转账：钱从 `accountId` 出、进 `toAccountId`，两边都以记账币种记一笔；
 * - `currency` + `rate`：rate = 1 单位该币种折合基准币种的值，汇总时一律换算成基准币种；
 * - 退款：kind='income' 且带 `refundOfId`，统计时**冲减**原分类的支出（不重复计入收入）；
 * - AA 分账：`myShare` 是我该承担的部分，统计口径按 myShare 计支出，差额算「待收」。
 */

/** 账户类型：现金 / 储蓄卡 / 信用卡 / 储值卡 / 投资 / 负债 / 虚拟（公积金社保等） */
export type AccountType = 'cash' | 'debit' | 'credit' | 'prepaid' | 'investment' | 'debt' | 'virtual'

/** 交易类型：支出 / 收入 / 转账 */
export type TxKind = 'expense' | 'income' | 'transfer'

/** 报销状态：不报销 / 待报销 / 已报销 */
export type ReimburseStatus = 'none' | 'pending' | 'done'

/** 预算周期 */
export type BudgetPeriod = 'week' | 'month' | 'year' | 'custom'

/** 预算作用维度 */
export type BudgetScope = 'total' | 'category' | 'tag' | 'account' | 'member'

/** 周期记账频率 */
export type RecurFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly'

/** 借入借出方向：lend = 别人欠我（应收）；borrow = 我欠别人（应付） */
export type DebtDirection = 'lend' | 'borrow'

/** 账户（表 personal_ledger_accounts 的一行 + 汇总出来的余额） */
export interface Account {
  id: number
  name: string
  type: AccountType
  currency: string
  /** 期初余额 */
  initialBalance: number
  /** 信用卡额度（type='credit' 时有意义） */
  creditLimit: number
  /** 账单日 / 还款日（1-31；0 = 未设置） */
  billDay: number
  repayDay: number
  /** 是否计入净资产（virtual 类常关掉） */
  includeInNetWorth: boolean
  hidden: boolean
  sort: number
  note: string
  createdAt: string | null
}

/** 账户 + 由流水算出来的余额（只读，不入库） */
export interface AccountSummary extends Account {
  /** 当前余额（期初 + 流入 − 流出 − 转出 + 转入） */
  balance: number
  /** 自开户以来累计流入 / 流出（基准币种） */
  inflow: number
  outflow: number
  /** 负债账户：正数表示欠款 */
  liability: number
  txCount: number
}

/** 分类（支出 / 收入；parentId 支持多级） */
export interface Category {
  id: number
  name: string
  kind: 'expense' | 'income'
  parentId: number | null
  /** Remixicon 名字（如 RiRestaurantLine）或 emoji */
  icon: string
  color: string
  hidden: boolean
  sort: number
}

/** 标签（分类之外的补充维度） */
export interface Tag {
  id: number
  name: string
  color: string
}

/** 商家 / 交易对象 */
export interface Merchant {
  id: number
  name: string
  categoryId: number | null
  note: string
}

/** 一笔交易 */
export interface Transaction {
  id: number
  kind: TxKind
  /** 原始币种金额（正数） */
  amount: number
  /** 记账日期 YYYY-MM-DD */
  date: string
  /** 记账时间 HH:mm */
  time: string
  currency: string
  /** 1 单位 currency 折合基准币种的值 */
  rate: number
  categoryId: number | null
  accountId: number | null
  /** 转账的目标账户 */
  toAccountId: number | null
  merchantId: number | null
  tags: string[]
  note: string
  /** 手续费 / 优惠（正数；优惠冲减支出） */
  fee: number
  discount: number
  /** 账本成员（家庭账本用） */
  member: string
  /** 退款指向的原交易 id */
  refundOfId: number | null
  reimburseStatus: ReimburseStatus
  /** 组合支付 / 分期：同一组的标识 */
  groupId: string
  /** 分期：第几期 / 共几期（0 = 不分期） */
  installmentIndex: number
  installmentTotal: number
  /** 周期记账生成的来源 id */
  recurringId: number | null
  /** AA 分账：我承担的部分（0 = 不分账，全额算我） */
  myShare: number
  /** AA 分账：参与人（逗号分隔） */
  splitMembers: string
  /** 余额调整（对账）产生的流水：只影响余额，不进收支统计 */
  adjust: boolean
  createdAt: string | null
  updatedAt: string | null
}

/** 新建 / 修改交易的入参（id 与时间戳由数据库管） */
export interface TransactionInput {
  id?: number
  kind: TxKind
  amount: number
  date: string
  time?: string
  currency?: string
  rate?: number
  categoryId?: number | null
  /** 分类名（导入 / 冒烟用：按名字找，找不到就新建） */
  categoryName?: string
  accountId?: number | null
  /** 账户名（同上） */
  accountName?: string
  toAccountId?: number | null
  toAccountName?: string
  merchantId?: number | null
  merchantName?: string
  tags?: string[]
  note?: string
  fee?: number
  discount?: number
  member?: string
  refundOfId?: number | null
  reimburseStatus?: ReimburseStatus
  /** 组合支付：每段一个账户 + 金额 */
  payments?: { accountId: number; amount: number }[]
  /** 分期：分成几期（>1 才生效，按月顺延） */
  installmentMonths?: number
  myShare?: number
  splitMembers?: string
  /** 余额调整（对账用；页面不暴露给用户手填） */
  adjust?: boolean
  /** 周期记账生成（工具 / 内部用） */
  recurringId?: number | null
}

/** 明细查询条件（全部可选，主进程在内存里过滤——个人账本量级足够） */
export interface TransactionFilter {
  from?: string
  to?: string
  kind?: TxKind
  categoryId?: number
  accountId?: number
  tag?: string
  member?: string
  keyword?: string
  minAmount?: number
  maxAmount?: number
  reimburseStatus?: ReimburseStatus
  limit?: number
  offset?: number
}

/** 预算 */
export interface Budget {
  id: number
  name: string
  period: BudgetPeriod
  scope: BudgetScope
  /** scope 对应的取值：分类 id / 标签名 / 账户 id / 成员名；total 时为空 */
  ref: string
  amount: number
  /** custom 周期用；其它周期可空（按当前自然周期算） */
  startDate: string
  endDate: string
  createdAt: string | null
}

/** 预算 + 花掉的进度 */
export interface BudgetProgress extends Budget {
  spent: number
  remaining: number
  ratio: number
  /** 当前周期的起止（展示用） */
  periodFrom: string
  periodTo: string
}

/** 储蓄目标 */
export interface Goal {
  id: number
  name: string
  targetAmount: number
  savedAmount: number
  dueDate: string
  note: string
  createdAt: string | null
}

/** 周期记账规则 */
export interface Recurring {
  id: number
  name: string
  kind: TxKind
  amount: number
  categoryId: number | null
  accountId: number | null
  frequency: RecurFrequency
  /** 下一次生成的日期 YYYY-MM-DD */
  nextRun: string
  enabled: boolean
  note: string
  createdAt: string | null
}

/** 借入 / 借出（应收应付） */
export interface Debt {
  id: number
  direction: DebtDirection
  counterparty: string
  amount: number
  /** 已结清金额 */
  settled: number
  dueDate: string
  note: string
  createdAt: string | null
}

/** 定期存款 */
export interface Deposit {
  id: number
  name: string
  accountId: number | null
  principal: number
  /** 年化利率（%） */
  rate: number
  startDate: string
  maturityDate: string
  note: string
  createdAt: string | null
}

/** 自动分类规则（按关键词 / 商家归到分类） */
export interface ClassifyRule {
  id: string
  keyword: string
  categoryId: number
  kind: 'expense' | 'income'
}

/** 快捷记账模板 */
export interface QuickTemplate {
  id: string
  name: string
  input: TransactionInput
}

/** 插件设置（存 userData/plugin-state/personal-ledger.json，不进表） */
export interface LedgerSettings {
  /** 基准币种 */
  baseCurrency: string
  /** 汇率表：币种 → 折合基准币种的值 */
  rates: Record<string, number>
  /** 账本成员（家庭共享账本） */
  members: string[]
  /** 每日记账提醒（HH:mm，空 = 关闭） */
  dailyReminder: string
  /** 账单 / 预算 / 还款提醒开关 */
  remindersEnabled: boolean
  /** 超支预警阈值（0.8 = 用到 80% 就提醒） */
  budgetAlertRatio: number
  /** 单笔大额提醒阈值（基准币种；0 = 关闭） */
  largeAmountThreshold: number
  /** 默认账户 */
  defaultAccountId: number | null
  /** 自动分类规则 */
  rules: ClassifyRule[]
  /** 快捷记账模板 */
  templates: QuickTemplate[]
  /** 上次备份时间（导出时写入） */
  lastBackupAt: string
}

/** 页面初始化一次性要的全部基础数据 */
export interface LedgerState {
  accounts: AccountSummary[]
  categories: Category[]
  tags: Tag[]
  merchants: Merchant[]
  settings: LedgerSettings
}

/** 统计区间 */
export interface RangeInput {
  from: string
  to: string
}

/** 分类统计（饼图 / 排行） */
export interface CategoryStat {
  categoryId: number | null
  name: string
  color: string
  amount: number
  /** 退款冲减后的净额 */
  net: number
  count: number
  ratio: number
}

/** 账户统计 */
export interface AccountStat {
  accountId: number
  name: string
  type: AccountType
  inflow: number
  outflow: number
  balance: number
}

/** 成员统计 */
export interface MemberStat {
  member: string
  income: number
  expense: number
  balance: number
}

/** 趋势点（按日或按月） */
export interface TrendPoint {
  period: string
  income: number
  expense: number
  balance: number
  netWorth: number
}

/** 日历视图的一天 */
export interface CalendarDay {
  date: string
  income: number
  expense: number
  count: number
}

/** 消费排行 / 异常消费 */
export interface RankingItem {
  key: string
  label: string
  amount: number
  count: number
}

export interface Anomaly {
  id: number
  date: string
  amount: number
  note: string
  reason: 'large' | 'spike' | 'duplicate'
}

/** 财务健康分析 */
export interface HealthReport {
  /** 储蓄率 = (收入 − 支出) / 收入 */
  savingsRate: number
  /** 负债 / 资产 */
  debtRatio: number
  /** 支出占收入比 */
  expenseRatio: number
  /** 最大的三个支出分类占比合计 */
  topCategoryRatio: number
  /** 日均支出 */
  dailyExpense: number
  /** 预计月底支出（按当前日均推算） */
  projectedExpense: number
}

/** 投资账户盈亏 */
export interface InvestmentPnl {
  accountId: number
  name: string
  invested: number
  value: number
  profit: number
  ratio: number
}

/** 报表（一次算全，渲染层只负责画） */
export interface LedgerReport {
  from: string
  to: string
  income: number
  expense: number
  /** 退款冲减掉的支出 */
  refund: number
  balance: number
  count: number
  categoryStats: CategoryStat[]
  accountStats: AccountStat[]
  memberStats: MemberStat[]
  trend: TrendPoint[]
  /** 按日汇总（日历视图） */
  calendar: CalendarDay[]
  merchantRanking: RankingItem[]
  topExpenses: Anomaly[]
  anomalies: Anomaly[]
  health: HealthReport
  investments: InvestmentPnl[]
}

/** 提醒（首页「待办」区） */
export interface ReminderItem {
  id: string
  kind: 'recurring' | 'budget' | 'debt' | 'deposit' | 'card' | 'reimburse' | 'daily'
  title: string
  detail: string
  date: string
  amount: number
  level: 'info' | 'warning' | 'danger'
}

/** 首页概览 */
export interface Dashboard {
  assets: number
  liabilities: number
  netWorth: number
  monthIncome: number
  monthExpense: number
  monthBalance: number
  todayExpense: number
  budgets: BudgetProgress[]
  reminders: ReminderItem[]
  recent: Transaction[]
  pendingReimburse: number
  receivable: number
  payable: number
  monthCalendar: CalendarDay[]
}

/** 导入结果 */
export interface ImportResult {
  total: number
  inserted: number
  skipped: number
  errors: string[]
}

/** 导出结果 */
export interface ExportResult {
  ok: boolean
  path: string
  rows: number
  message: string
}
