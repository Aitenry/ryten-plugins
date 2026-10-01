import { tool } from '@langchain/core/tools'
import { mainFormat } from '@host/main/i18n'
import { HARNESS_TOOL_CONTRIBUTION } from '@host/main/plugins/tool-contract'
import * as z from 'zod/v4'
import {
  deleteTransaction,
  listAccounts,
  listBudgets,
  listDeposits,
  listRecurring,
  listTransactions,
  runRecurring,
  saveTransaction,
  today
} from './db/mapper'
import {
  buildAccountSummaries,
  buildBudgetProgress,
  buildDashboard,
  buildReport,
  monthRange
} from './db/reports'
import { currentSettings } from './ipc'
import { getToolTexts, toolDescriptions } from './tool-texts'

/**
 * 个人记账台账 给助手的 AI 工具。
 *
 * 三条规矩：
 * - 经 **工具贡献点**（HARNESS_TOOL_CONTRIBUTION）注册：插件停用时 harness 拉不到这条贡献，
 *   工具自然从模型面前消失（不需要去改宿主的工具表）；
 * - 工具读的是**本插件自己的 mapper / reports**（与页面同一份数据、同一套口径），
 *   不跨插件直读别人的表；
 * - 只读动作直接返回；写动作（add / remove / recurring）走与页面相同的写通道函数，
 *   因此页面会通过事件推送立刻看到变化。
 *
 * 一个工具多个 action（而不是八九个工具）：记账的动作集合很小，模型学一个 schema 比学九个便宜。
 */
export const LEDGER_TOOL_NAME = 'personal_ledger'

const ACTIONS = [
  'summary',
  'list',
  'add',
  'remove',
  'accounts',
  'budgets',
  'report',
  'reminders',
  'recurring'
] as const

type LedgerAction = (typeof ACTIONS)[number]

const SUPPORTED = ACTIONS.join(', ')

function money(value: number, currency: string): string {
  const rounded = Math.round(value * 100) / 100
  return `${rounded.toFixed(2)} ${currency}`
}

export function createToolContribution(): {
  name: string
  info: { name: string; label: string; description: string; icon: string; color: string }
  build: () => unknown
} {
  const desc = toolDescriptions()
  return {
    name: LEDGER_TOOL_NAME,
    info: {
      name: LEDGER_TOOL_NAME,
      label: '个人记账台账',
      description: desc.zh,
      icon: 'RiWalletLine',
      color: '#f97316'
    },
    build: () =>
      tool(
        async (input: {
          action: LedgerAction
          amount?: number
          kind?: 'expense' | 'income' | 'transfer'
          date?: string
          from?: string
          to?: string
          category?: string
          account?: string
          toAccount?: string
          merchant?: string
          note?: string
          tags?: string[]
          member?: string
          id?: number
          keyword?: string
          limit?: number
          installmentMonths?: number
        }) => {
          const texts = getToolTexts()
          const action = input?.action
          if (!action || !SUPPORTED.includes(String(action))) {
            return mainFormat(texts.common.unknownAction, {
              action: String(action ?? ''),
              supported: SUPPORTED
            })
          }
          const settings = currentSettings()
          const currency = settings.baseCurrency
          const kindLabel = (kind: string): string =>
            kind === 'income'
              ? texts.common.kindIncome
              : kind === 'transfer'
                ? texts.common.kindTransfer
                : texts.common.kindExpense
          try {
            if (action === 'summary') {
              const dashboard = await buildDashboard(settings)
              return [
                mainFormat(texts.ledger.summaryHeader, { currency }),
                mainFormat(texts.ledger.summaryAssets, { assets: money(dashboard.assets, currency) }),
                mainFormat(texts.ledger.summaryLiabilities, {
                  liabilities: money(dashboard.liabilities, currency)
                }),
                mainFormat(texts.ledger.summaryNetWorth, { netWorth: money(dashboard.netWorth, currency) }),
                mainFormat(texts.ledger.summaryMonth, {
                  income: money(dashboard.monthIncome, currency),
                  expense: money(dashboard.monthExpense, currency),
                  balance: money(dashboard.monthBalance, currency)
                }),
                mainFormat(texts.ledger.summaryToday, { today: money(dashboard.todayExpense, currency) }),
                mainFormat(texts.ledger.summaryReimburse, {
                  reimburse: money(dashboard.pendingReimburse, currency),
                  receivable: money(dashboard.receivable, currency),
                  payable: money(dashboard.payable, currency)
                })
              ].join('\n')
            }

            if (action === 'list') {
              const limit = Math.min(Math.max(1, Math.trunc(Number(input.limit) || 10)), 50)
              const items = await listTransactions({
                from: input.from,
                to: input.to,
                keyword: input.keyword,
                limit
              })
              if (items.length === 0) return texts.ledger.listEmpty
              const accounts = await listAccounts()
              const accountName = new Map(accounts.map((account) => [account.id, account.name]))
              const lines = [
                mainFormat(texts.ledger.listHeader, { count: items.length, limit })
              ]
              for (const tx of items) {
                lines.push(
                  mainFormat(texts.ledger.listLine, {
                    id: tx.id,
                    date: tx.date,
                    kind: kindLabel(tx.kind),
                    amount: money(tx.amount, tx.currency),
                    category: tx.note ? ` · ${tx.note}` : '',
                    account: tx.accountId ? ` · ${accountName.get(tx.accountId) ?? ''}` : '',
                    note: ''
                  })
                )
              }
              return lines.join('\n')
            }

            if (action === 'add') {
              const amount = Number(input.amount)
              if (!Number.isFinite(amount) || amount <= 0) {
                return mainFormat(texts.common.failed, { message: 'amount 必须是正数' })
              }
              const created = await saveTransaction(
                {
                  kind: input.kind ?? 'expense',
                  amount,
                  date: input.date || today(),
                  categoryName: input.category,
                  accountName: input.account,
                  toAccountName: input.toAccount,
                  merchantName: input.merchant,
                  note: input.note,
                  tags: input.tags,
                  member: input.member,
                  installmentMonths: input.installmentMonths
                },
                settings.rules
              )
              const head = mainFormat(texts.ledger.added, {
                date: created.date,
                kind: kindLabel(created.kind),
                amount: money(created.amount, created.currency),
                category: input.category ? ` · ${input.category}` : '',
                account: input.account ? ` · ${input.account}` : '',
                id: created.id
              })
              const months = Math.trunc(Number(input.installmentMonths) || 0)
              if (months > 1) {
                return [
                  head,
                  mainFormat(texts.ledger.addedInstallment, {
                    count: months,
                    amount: money(created.amount, created.currency)
                  })
                ].join('\n')
              }
              return head
            }

            if (action === 'remove') {
              const id = Math.trunc(Number(input.id))
              if (!Number.isFinite(id)) {
                return mainFormat(texts.ledger.notFound, { id: String(input.id ?? '') })
              }
              const removed = await deleteTransaction(id)
              return removed
                ? mainFormat(texts.ledger.removed, { id })
                : mainFormat(texts.ledger.notFound, { id })
            }

            if (action === 'accounts') {
              const [accounts, transactions] = await Promise.all([listAccounts(), listTransactions()])
              const summaries = buildAccountSummaries(accounts, transactions)
              if (summaries.length === 0) return texts.ledger.accountsEmpty
              const lines = [mainFormat(texts.ledger.accountsHeader, { count: summaries.length })]
              for (const account of summaries) {
                lines.push(
                  mainFormat(texts.ledger.accountLine, {
                    name: account.name,
                    type: account.type,
                    balance: money(account.balance, currency),
                    liability: account.liability > 0 ? `（欠款 ${money(account.liability, currency)}）` : ''
                  })
                )
              }
              return lines.join('\n')
            }

            if (action === 'budgets') {
              const [budgets, transactions] = await Promise.all([listBudgets(), listTransactions()])
              const progress = buildBudgetProgress(budgets, transactions)
              if (progress.length === 0) return texts.ledger.budgetsEmpty
              const lines = [texts.ledger.budgetsHeader]
              for (const budget of progress) {
                lines.push(
                  mainFormat(texts.ledger.budgetLine, {
                    name: budget.name || budget.scope,
                    spent: money(budget.spent, currency),
                    amount: money(budget.amount, currency),
                    percent: Math.round(budget.ratio * 100),
                    state:
                      budget.remaining >= 0
                        ? mainFormat(texts.ledger.budgetOk, {
                            remaining: money(budget.remaining, currency)
                          })
                        : mainFormat(texts.ledger.budgetOver, {
                            over: money(Math.abs(budget.remaining), currency)
                          })
                  })
                )
              }
              return lines.join('\n')
            }

            if (action === 'report') {
              const range = monthRange()
              const from = input.from || range.from
              const to = input.to || range.to
              const report = await buildReport({ from, to })
              if (report.count === 0) return texts.ledger.reportEmpty
              const lines = [
                mainFormat(texts.ledger.reportHeader, { from, to }),
                mainFormat(texts.ledger.reportTotals, {
                  income: money(report.income, currency),
                  expense: money(report.expense, currency),
                  refund: money(report.refund, currency),
                  balance: money(report.balance, currency)
                })
              ]
              for (const stat of report.categoryStats.slice(0, 8)) {
                lines.push(
                  mainFormat(texts.ledger.reportCategoryLine, {
                    name: stat.name || '（未分类）',
                    amount: money(stat.net, currency),
                    percent: Math.round(stat.ratio * 100)
                  })
                )
              }
              lines.push(
                mainFormat(texts.ledger.reportHealth, {
                  savingsRate: Math.round(report.health.savingsRate * 100),
                  debtRatio: Math.round(report.health.debtRatio * 100),
                  daily: money(report.health.dailyExpense, currency),
                  projected: money(report.health.projectedExpense, currency)
                })
              )
              return lines.join('\n')
            }

            if (action === 'reminders') {
              const dashboard = await buildDashboard(settings)
              const items = dashboard.reminders
              if (items.length === 0) return texts.ledger.remindersEmpty
              const lines = [mainFormat(texts.ledger.reminderHeader, { count: items.length })]
              for (const item of items) {
                lines.push(
                  mainFormat(texts.ledger.reminderLine, {
                    date: item.date,
                    title: item.title,
                    detail: item.detail
                  })
                )
              }
              return lines.join('\n')
            }

            // recurring：把到期的周期账落成流水（幂等：只处理 next_run <= 今天 的）
            const created = await runRecurring()
            const [recurring, deposits] = await Promise.all([listRecurring(), listDeposits()])
            return [
              mainFormat(texts.ledger.recurringRun, { count: created }),
              ...recurring
                .filter((rule) => rule.enabled)
                .slice(0, 10)
                .map((rule) => `- ${rule.name}: ${rule.nextRun} ${money(rule.amount, currency)}`),
              ...deposits
                .filter((deposit) => deposit.maturityDate)
                .slice(0, 5)
                .map((deposit) => `- ${deposit.name}: ${deposit.maturityDate} 到期`)
            ].join('\n')
          } catch (err) {
            return mainFormat(texts.common.failed, { message: (err as Error).message })
          }
        },
        {
          name: LEDGER_TOOL_NAME,
          description: desc.zh,
          schema: z.object({
            action: z.enum(ACTIONS).describe('要执行的动作'),
            amount: z.number().optional().describe('add 时的金额（正数）'),
            kind: z
              .enum(['expense', 'income', 'transfer'])
              .optional()
              .describe('add 时的方向：expense 支出 / income 收入 / transfer 转账'),
            date: z.string().optional().describe('add 时的日期 YYYY-MM-DD，默认今天'),
            from: z.string().optional().describe('list / report 的起始日期 YYYY-MM-DD'),
            to: z.string().optional().describe('list / report 的结束日期 YYYY-MM-DD'),
            category: z.string().optional().describe('add 时的分类名（不存在会自动创建）'),
            account: z.string().optional().describe('add 时的账户名（不存在会自动创建）'),
            toAccount: z.string().optional().describe('add 转账时的目标账户名'),
            merchant: z.string().optional().describe('add 时的商家 / 交易对象'),
            note: z.string().optional().describe('add 时的备注'),
            tags: z.array(z.string()).optional().describe('add 时的标签'),
            member: z.string().optional().describe('add 时的账本成员'),
            id: z.number().optional().describe('remove 时的流水 id'),
            keyword: z.string().optional().describe('list 的关键词（备注 / 商家 / 分类 / 金额都搜）'),
            limit: z.number().optional().describe('list 返回条数，默认 10，最多 50'),
            installmentMonths: z.number().optional().describe('add 时分成几期（>1 才生效）')
          })
        }
      )
  }
}

/** 分类与商家（list 时给备注补名字用；抽出来避免在主流程里堆 await） */
export { HARNESS_TOOL_CONTRIBUTION }
