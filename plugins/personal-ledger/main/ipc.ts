import * as fs from 'fs'
import * as path from 'path'
import { app, BrowserWindow, dialog } from 'electron'
import { safeSend } from '@host/main/safe-send'
import type {
  Account,
  Budget,
  Category,
  Debt,
  Deposit,
  Goal,
  ImportResult,
  LedgerSettings,
  LedgerState,
  Merchant,
  Recurring,
  Tag,
  TransactionFilter,
  TransactionInput
} from '../shared/types'
import { transactionsFromCsv, transactionsToCsv } from './csv'
import {
  copyTransaction,
  deleteAccount,
  deleteBudget,
  deleteCategory,
  deleteDebt,
  deleteDeposit,
  deleteGoal,
  deleteMerchant,
  deleteRecurring,
  deleteTag,
  deleteTransaction,
  deleteTransactions,
  depositGoal,
  exportSnapshot,
  importTransactions,
  listBudgets,
  listDebts,
  listDeposits,
  listGoals,
  listRecurring,
  listTransactions,
  reconcileAccount,
  runRecurring,
  saveAccount,
  saveBudget,
  saveCategory,
  saveDebt,
  saveDeposit,
  saveGoal,
  saveMerchant,
  saveRecurring,
  saveTag,
  saveTransaction,
  seedIfEmpty,
  today
} from './db/mapper'
import { buildDashboard, buildInitialState, buildReport, monthRange } from './db/reports'
import type { MainPluginContext } from '@host/main/plugins/context'

/**
 * 个人记账台账 的主进程通道（前缀 `plugin:personal-ledger:`，否则装载期就抛）。
 *
 * 分工：**业务数据进数据库**（./db/*，能查询、能被 AI 工具读），**设置进 JSON**
 * （userData/plugin-state/personal-ledger.json——它是配置，不值得为它建表）。
 * 数据一变就推 `plugin:personal-ledger:data-changed`，开着的页面实时刷新。
 *
 * 约定：所有写通道**先落库再广播**，广播失败不影响调用结果（safeSend 向失效帧发送不抛错）。
 */

/** 主进程 → 渲染层：数据变了（只有发送方，必须在 install 里 registerEvent 声明） */
export const DATA_CHANGED = 'plugin:personal-ledger:data-changed'

const SETTINGS_FILE = (): string =>
  path.join(app.getPath('userData'), 'plugin-state', 'personal-ledger.json')

/** 默认设置：新装即有可用的币种（基准人民币）与提醒口径 */
export const DEFAULT_SETTINGS: LedgerSettings = {
  baseCurrency: 'CNY',
  rates: { CNY: 1, USD: 7.2, EUR: 7.8, HKD: 0.92, JPY: 0.048, GBP: 9.1 },
  members: [],
  dailyReminder: '21:00',
  remindersEnabled: true,
  budgetAlertRatio: 0.8,
  largeAmountThreshold: 1000,
  defaultAccountId: null,
  rules: [],
  templates: [],
  lastBackupAt: ''
}

let settings: LedgerSettings = { ...DEFAULT_SETTINGS }

/** 读设置（首次运行没有文件 → 默认值；损坏的文件也不该让插件装不上） */
export function loadSettings(): void {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf-8')
    const saved = JSON.parse(raw) as Partial<LedgerSettings>
    settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      rates: { ...DEFAULT_SETTINGS.rates, ...(saved.rates ?? {}) },
      members: Array.isArray(saved.members) ? saved.members : [],
      rules: Array.isArray(saved.rules) ? saved.rules : [],
      templates: Array.isArray(saved.templates) ? saved.templates : []
    }
  } catch {
    settings = { ...DEFAULT_SETTINGS }
  }
}

/** 写设置（目录不存在就建：数据放 userData，别写用户的工作区） */
function saveSettings(): void {
  const file = SETTINGS_FILE()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf-8')
}

/** 设置快照（工具与通道都读它，避免各自持有一份可变对象） */
export function currentSettings(): LedgerSettings {
  return settings
}

/** 数据变了推给所有窗口（宿主 safe-send：向已失效的渲染帧发送不抛错） */
export function broadcastDataChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win.webContents, DATA_CHANGED, { at: Date.now() })
  }
}

/** 写操作统一包一层：落库 → 广播 */
async function mutate<T>(run: () => Promise<T>): Promise<T> {
  const result = await run()
  broadcastDataChanged()
  return result
}

/** 文件对话框的父窗口（可能没有聚焦窗口 → 用无参重载） */
async function pickSave(options: Electron.SaveDialogOptions): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

async function pickOpen(options: Electron.OpenDialogOptions): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}

/** 汇总页要的基础数据（账户带余额） */
async function buildState(): Promise<LedgerState> {
  const base = await buildInitialState()
  return { ...base, settings: { ...settings } }
}

/** 通道表（install 里交给 ctx.registerIpc；停用时随 ctx.dispose 一并摘除） */
export function createIpcHandlers(): Record<string, (...args: never[]) => unknown> {
  loadSettings()
  return {
    /* ── 初始化 / 设置 ── */
    'plugin:personal-ledger:state-get': () => buildState(),
    'plugin:personal-ledger:settings-get': () => ({ ...settings }),
    'plugin:personal-ledger:settings-set': (patch: Partial<LedgerSettings>) => {
      const next: LedgerSettings = { ...settings }
      if (patch && typeof patch === 'object') {
        if (typeof patch.baseCurrency === 'string' && patch.baseCurrency.trim()) {
          next.baseCurrency = patch.baseCurrency.trim().toUpperCase()
        }
        if (patch.rates && typeof patch.rates === 'object') {
          // rates 是**整表替换**（不是 merge）：设置页现在按「币种 + 汇率」逐行编辑，
          // 删掉一行 = 删掉一个键——merge 语义下这一删是删不掉的（值会留在表里）。
          // 顺手把基准币种钉成 1：折算口径里不该出现「1 CNY = 0.9 CNY」这种事，
          // 而且改基准币种之后，旧的基准币种那一行也不会跟着错。
          next.rates = { ...patch.rates, [next.baseCurrency]: 1 }
        }
        if (Array.isArray(patch.members)) next.members = patch.members.map(String).filter(Boolean)
        if (typeof patch.dailyReminder === 'string') next.dailyReminder = patch.dailyReminder
        if (typeof patch.remindersEnabled === 'boolean') next.remindersEnabled = patch.remindersEnabled
        if (typeof patch.budgetAlertRatio === 'number') next.budgetAlertRatio = patch.budgetAlertRatio
        if (typeof patch.largeAmountThreshold === 'number') {
          next.largeAmountThreshold = patch.largeAmountThreshold
        }
        if (patch.defaultAccountId === null || typeof patch.defaultAccountId === 'number') {
          next.defaultAccountId = patch.defaultAccountId
        }
        if (Array.isArray(patch.rules)) next.rules = patch.rules
        if (Array.isArray(patch.templates)) next.templates = patch.templates
        if (typeof patch.lastBackupAt === 'string') next.lastBackupAt = patch.lastBackupAt
      }
      settings = next
      saveSettings()
      broadcastDataChanged()
      return { ...settings }
    },

    /* ── 交易 ── */
    'plugin:personal-ledger:transactions-query': (filter: TransactionFilter) =>
      listTransactions(filter ?? {}),
    'plugin:personal-ledger:transactions-save': (input: TransactionInput) =>
      mutate(() => saveTransaction(input ?? { kind: 'expense', amount: 0, date: today() }, settings.rules)),
    'plugin:personal-ledger:transactions-delete': (id: number) => mutate(() => deleteTransaction(id)),
    'plugin:personal-ledger:transactions-delete-many': (ids: number[], group = false) =>
      mutate(() => deleteTransactions(ids ?? [], group === true)),
    'plugin:personal-ledger:transactions-copy': (id: number) =>
      mutate(() => copyTransaction(id)),

    /* ── 账户 / 分类 / 标签 / 商家 ── */
    'plugin:personal-ledger:accounts-save': (input: Partial<Account> & { name: string }) =>
      mutate(() => saveAccount(input)),
    'plugin:personal-ledger:accounts-delete': (id: number) => mutate(() => deleteAccount(id)),
    'plugin:personal-ledger:accounts-reconcile': (id: number, actualBalance: number, note = '') =>
      mutate(() => reconcileAccount(id, actualBalance, note)),
    'plugin:personal-ledger:categories-save': (input: Partial<Category> & { name: string }) =>
      mutate(() => saveCategory(input)),
    'plugin:personal-ledger:categories-delete': (id: number) => mutate(() => deleteCategory(id)),
    'plugin:personal-ledger:tags-save': (input: Partial<Tag> & { name: string }) =>
      mutate(() => saveTag(input)),
    'plugin:personal-ledger:tags-delete': (id: number) => mutate(() => deleteTag(id)),
    'plugin:personal-ledger:merchants-save': (input: Partial<Merchant> & { name: string }) =>
      mutate(() => saveMerchant(input)),
    'plugin:personal-ledger:merchants-delete': (id: number) => mutate(() => deleteMerchant(id)),

    /* ── 预算 / 目标 / 周期 / 借还 / 存款 ── */
    'plugin:personal-ledger:plans-get': async () => {
      const [budgets, goals, recurring, debts, deposits] = await Promise.all([
        listBudgets(),
        listGoals(),
        listRecurring(),
        listDebts(),
        listDeposits()
      ])
      return { budgets, goals, recurring, debts, deposits }
    },
    'plugin:personal-ledger:budgets-save': (input: Partial<Budget> & { amount: number }) =>
      mutate(() => saveBudget(input)),
    'plugin:personal-ledger:budgets-delete': (id: number) => mutate(() => deleteBudget(id)),
    'plugin:personal-ledger:goals-save': (input: Partial<Goal> & { name: string }) =>
      mutate(() => saveGoal(input)),
    'plugin:personal-ledger:goals-delete': (id: number) => mutate(() => deleteGoal(id)),
    'plugin:personal-ledger:goals-deposit': (id: number, amount: number) =>
      mutate(() => depositGoal(id, amount)),
    'plugin:personal-ledger:recurring-save': (input: Partial<Recurring> & { name: string }) =>
      mutate(() => saveRecurring(input)),
    'plugin:personal-ledger:recurring-delete': (id: number) => mutate(() => deleteRecurring(id)),
    'plugin:personal-ledger:recurring-run': () => mutate(() => runRecurring()),
    'plugin:personal-ledger:debts-save': (input: Partial<Debt> & { counterparty: string }) =>
      mutate(() => saveDebt(input)),
    'plugin:personal-ledger:debts-delete': (id: number) => mutate(() => deleteDebt(id)),
    /** 结算一笔借还：顺手记一笔流水（lend 收款 = 收入；borrow 还款 = 支出） */
    'plugin:personal-ledger:debts-settle': (id: number, amount: number, accountId: number | null) =>
      mutate(async () => {
        const debts = await listDebts()
        const debt = debts.find((item) => item.id === id)
        if (!debt) throw new Error(`借还款 ${id} 不存在`)
        const pay = Math.min(Math.max(0, Number(amount) || 0), Math.max(0, debt.amount - debt.settled))
        if (pay <= 0) throw new Error('结算金额必须大于 0 且不超过未结清金额')
        await saveTransaction({
          kind: debt.direction === 'lend' ? 'income' : 'expense',
          amount: pay,
          date: today(),
          accountId: accountId ?? null,
          note: `${debt.direction === 'lend' ? '收回借款' : '归还借款'}：${debt.counterparty}`,
          member: ''
        })
        return saveDebt({ ...debt, settled: Math.round((debt.settled + pay) * 100) / 100 })
      }),
    'plugin:personal-ledger:deposits-save': (input: Partial<Deposit> & { name: string }) =>
      mutate(() => saveDeposit(input)),
    'plugin:personal-ledger:deposits-delete': (id: number) => mutate(() => deleteDeposit(id)),

    /* ── 概览 / 报表 ── */
    'plugin:personal-ledger:dashboard-get': () => buildDashboard(settings),
    'plugin:personal-ledger:report-get': (range?: { from?: string; to?: string }) =>
      buildReport({
        from: range?.from || monthRange().from,
        to: range?.to || monthRange().to
      }),

    /* ── 导入 / 导出 ── */
    'plugin:personal-ledger:export-data': async (format: 'csv' | 'json' = 'csv') => {
      const snapshot = await exportSnapshot()
      const day = today()
      if (format === 'json') {
        const file = await pickSave({
          title: '导出记账台账（JSON 备份，可用于恢复）',
          defaultPath: `personal-ledger-${day}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
        if (!file) return { ok: false, path: '', rows: 0, message: '已取消' }
        fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf-8')
        settings = { ...settings, lastBackupAt: new Date().toISOString() }
        saveSettings()
        const rows = Array.isArray(snapshot.transactions) ? snapshot.transactions.length : 0
        return { ok: true, path: file, rows, message: `已导出 ${rows} 条流水（含基础数据）` }
      }
      const transactions = snapshot.transactions as Parameters<typeof transactionsToCsv>[0]
      const names = {
        category: new Map((snapshot.categories as Category[]).map((item) => [item.id, item.name])),
        account: new Map((snapshot.accounts as Account[]).map((item) => [item.id, item.name])),
        merchant: new Map((snapshot.merchants as Merchant[]).map((item) => [item.id, item.name]))
      }
      const csv = transactionsToCsv(transactions, names)
      const file = await pickSave({
        title: '导出流水（CSV，Excel 可直接打开）',
        defaultPath: `personal-ledger-${day}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      })
      if (!file) return { ok: false, path: '', rows: 0, message: '已取消' }
      fs.writeFileSync(file, csv, 'utf-8')
      return {
        ok: true,
        path: file,
        rows: transactions.length,
        message: `已导出 ${transactions.length} 条流水`
      }
    },
    'plugin:personal-ledger:import-data': async (): Promise<ImportResult> => {
      const file = await pickOpen({
        title: '导入账单（CSV / 文本：微信、支付宝、银行导出的都认）',
        properties: ['openFile'],
        filters: [
          { name: 'CSV / 文本', extensions: ['csv', 'txt', 'tsv'] },
          { name: '全部文件', extensions: ['*'] }
        ]
      })
      if (!file) return { total: 0, inserted: 0, skipped: 0, errors: ['已取消'] }
      const text = fs.readFileSync(file, 'utf-8')
      const { rows, errors } = transactionsFromCsv(text)
      if (rows.length === 0) {
        return { total: 0, inserted: 0, skipped: 0, errors: errors.length > 0 ? errors : ['没有可用行'] }
      }
      const inserted = await mutate(() => importTransactions(rows, settings.rules))
      return { total: rows.length, inserted, skipped: rows.length - inserted, errors }
    },
    /** 首次运行灌一份能马上看懂的示例账本（已有账户就什么都不做） */
    'plugin:personal-ledger:seed-demo': () => mutate(() => seedIfEmpty())
  }
}

/** 设置文件路径（清数据时用） */
export function settingsFilePath(): string {
  return SETTINGS_FILE()
}

/** 装载期间把设置读进来，并保证首次运行就落一份文件（放进 ctx.effect：停用即回滚） */
export function initSettings(ctx: MainPluginContext): void {
  ctx.effect(() => {
    loadSettings()
    saveSettings()
    return () => {
      settings = { ...DEFAULT_SETTINGS }
    }
  })
}
