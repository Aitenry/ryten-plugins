import type {
  Account,
  Budget,
  Category,
  Debt,
  Deposit,
  ExportResult,
  Goal,
  ImportResult,
  LedgerReport,
  LedgerSettings,
  LedgerState,
  Merchant,
  Recurring,
  Tag,
  Transaction,
  TransactionFilter,
  TransactionInput
} from '../shared/types'

/**
 * 个人记账台账 主进程通道的薄封装。
 *
 * 组件里**不直接写通道名**：改通道只动这一处，类型也只有这一处需要维护。
 * 走的是 preload 唯一暴露的通用桥（`window.api.plugin.invoke` / `.on`）。
 *
 * 防御性的一点：桥不存在时返回 null 而不是抛错——宿主渲染层探针会在「还没装好桥」
 * 的环境里 import 这个模块，模块顶层抛错会让整个插件装载失败（白屏）。
 */
type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>
type Listener = (channel: string, handler: (data: unknown) => void) => () => void

function bridge(): { invoke: Invoker; on: Listener } | null {
  const api = (window as unknown as { api?: { plugin?: { invoke?: Invoker; on?: Listener } } }).api
  if (!api?.plugin?.invoke || !api.plugin.on) return null
  return { invoke: api.plugin.invoke, on: api.plugin.on }
}

const call = <T,>(channel: string, ...args: unknown[]): Promise<T> => {
  const instance = bridge()
  if (!instance) return Promise.resolve(null as unknown as T)
  return instance.invoke(channel, ...args) as Promise<T>
}

export interface PlansData {
  budgets: Budget[]
  goals: Goal[]
  recurring: Recurring[]
  debts: Debt[]
  deposits: Deposit[]
}

export const api = {
  /* ── 初始化 / 设置 ── */
  getState: () => call<LedgerState>('plugin:personal-ledger:state-get'),
  getSettings: () => call<LedgerSettings>('plugin:personal-ledger:settings-get'),
  setSettings: (patch: Partial<LedgerSettings>) =>
    call<LedgerSettings>('plugin:personal-ledger:settings-set', patch),

  /* ── 流水 ── */
  queryTransactions: (filter: TransactionFilter = {}) =>
    call<Transaction[]>('plugin:personal-ledger:transactions-query', filter),
  saveTransaction: (input: TransactionInput) =>
    call<Transaction>('plugin:personal-ledger:transactions-save', input),
  removeTransaction: (id: number) =>
    call<boolean>('plugin:personal-ledger:transactions-delete', id),
  removeTransactions: (ids: number[], group = false) =>
    call<number>('plugin:personal-ledger:transactions-delete-many', ids, group),
  copyTransaction: (id: number) => call<Transaction | null>('plugin:personal-ledger:transactions-copy', id),

  /* ── 账户 / 分类 / 标签 / 商家 ── */
  saveAccount: (input: Partial<Account> & { name: string }) =>
    call<Account>('plugin:personal-ledger:accounts-save', input),
  removeAccount: (id: number) => call<number>('plugin:personal-ledger:accounts-delete', id),
  reconcileAccount: (id: number, actualBalance: number, note = '') =>
    call<Transaction | null>('plugin:personal-ledger:accounts-reconcile', id, actualBalance, note),
  saveCategory: (input: Partial<Category> & { name: string }) =>
    call<Category>('plugin:personal-ledger:categories-save', input),
  removeCategory: (id: number) => call<void>('plugin:personal-ledger:categories-delete', id),
  saveTag: (input: Partial<Tag> & { name: string }) =>
    call<Tag>('plugin:personal-ledger:tags-save', input),
  removeTag: (id: number) => call<void>('plugin:personal-ledger:tags-delete', id),
  saveMerchant: (input: Partial<Merchant> & { name: string }) =>
    call<Merchant>('plugin:personal-ledger:merchants-save', input),
  removeMerchant: (id: number) => call<void>('plugin:personal-ledger:merchants-delete', id),

  /* ── 预算 / 目标 / 周期 / 借还 / 存款 ── */
  getPlans: () => call<PlansData>('plugin:personal-ledger:plans-get'),
  saveBudget: (input: Partial<Budget> & { amount: number }) =>
    call<Budget>('plugin:personal-ledger:budgets-save', input),
  removeBudget: (id: number) => call<boolean>('plugin:personal-ledger:budgets-delete', id),
  saveGoal: (input: Partial<Goal> & { name: string }) =>
    call<Goal>('plugin:personal-ledger:goals-save', input),
  removeGoal: (id: number) => call<boolean>('plugin:personal-ledger:goals-delete', id),
  depositGoal: (id: number, amount: number) =>
    call<Goal | null>('plugin:personal-ledger:goals-deposit', id, amount),
  saveRecurring: (input: Partial<Recurring> & { name: string }) =>
    call<Recurring>('plugin:personal-ledger:recurring-save', input),
  removeRecurring: (id: number) => call<boolean>('plugin:personal-ledger:recurring-delete', id),
  runRecurring: () => call<number>('plugin:personal-ledger:recurring-run'),
  saveDebt: (input: Partial<Debt> & { counterparty: string }) =>
    call<Debt>('plugin:personal-ledger:debts-save', input),
  removeDebt: (id: number) => call<boolean>('plugin:personal-ledger:debts-delete', id),
  settleDebt: (id: number, amount: number, accountId: number | null) =>
    call<Debt>('plugin:personal-ledger:debts-settle', id, amount, accountId),
  saveDeposit: (input: Partial<Deposit> & { name: string }) =>
    call<Deposit>('plugin:personal-ledger:deposits-save', input),
  removeDeposit: (id: number) => call<boolean>('plugin:personal-ledger:deposits-delete', id),

  /* ── 概览 / 报表 ── */
  getDashboard: () => call<import('../shared/types').Dashboard>('plugin:personal-ledger:dashboard-get'),
  getReport: (range: { from: string; to: string }) =>
    call<LedgerReport>('plugin:personal-ledger:report-get', range),

  /* ── 导入 / 导出 ── */
  exportData: (format: 'csv' | 'json') =>
    call<ExportResult>('plugin:personal-ledger:export-data', format),
  importData: () => call<ImportResult>('plugin:personal-ledger:import-data'),

  /** 数据变了（主进程推送）——返回取消订阅的函数 */
  onDataChanged: (callback: () => void): (() => void) => {
    const instance = bridge()
    if (!instance) return () => undefined
    return instance.on('plugin:personal-ledger:data-changed', () => callback())
  }
}

export default api
