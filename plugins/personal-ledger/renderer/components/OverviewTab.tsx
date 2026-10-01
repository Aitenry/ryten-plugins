import { Empty, Tag, Tooltip } from 'antd'
import { useTranslation } from '@host/renderer/i18n'
import type { Dashboard, LedgerState, Transaction } from '../../shared/types'
import { useLedgerPalette } from '../palette'
import { BarChart } from './Charts'
import { ChartBox, FitList, FitTable, Kpi, Panel, money } from './ui'

/**
 * 概览页：一屏给出「我现在有多少钱 / 这个月花成什么样 / 有什么要处理」。
 *
 * 布局是**固定高度**的：上面一排指标，下面左右两栏各自填满剩余高度。
 * 榜单类内容（提醒、预算）超过可用高度时由 FitList 截断并提示还剩几项，
 * 「最近流水」由 FitTable 按高度决定每页几行——所以整页不会出现滚动条。
 *
 * 数据来自 `dashboard-get`（主进程一次算全）：页面只负责画，
 * 因此 AI 工具看到的数字与这里**必然一致**（同一份口径）。
 */
export default function OverviewTab(props: {
  state: LedgerState
  dashboard: Dashboard | null
  onOpenTransaction: (transaction: Transaction) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const p = useLedgerPalette()
  const currency = props.state.settings.baseCurrency
  const dashboard = props.dashboard

  if (!dashboard) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('personal-ledger.common.empty')} />
  }

  const levelColor: Record<string, string> = {
    info: 'blue',
    warning: 'orange',
    danger: 'red'
  }

  const bars = dashboard.monthCalendar.map((day) => ({
    label: day.date.slice(5),
    income: day.income,
    expense: day.expense
  }))

  const actualDays = Math.max(1, dashboard.monthCalendar.filter((day) => day.expense > 0).length)
  const savingsRate = dashboard.monthIncome > 0 ? Math.round((dashboard.monthBalance / dashboard.monthIncome) * 100) : 0
  const debtRatio = dashboard.assets > 0 ? Math.round((dashboard.liabilities / dashboard.assets) * 100) : 0
  const dailyExpense = dashboard.monthExpense / actualDays

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 指标带：固定一行六格（不做断点换行，换行会把下面的面板挤到溢出） */}
      <div className="grid shrink-0 grid-cols-6 gap-3">
        <Kpi
          label={t('personal-ledger.overview.netWorth')}
          value={`${money(dashboard.netWorth)} ${currency}`}
          tone="accent"
          hint={`${t('personal-ledger.overview.assets')} ${money(dashboard.assets)} · ${t('personal-ledger.overview.liabilities')} ${money(dashboard.liabilities)}`}
        />
        <Kpi
          label={t('personal-ledger.overview.monthIncome')}
          value={`${money(dashboard.monthIncome)} ${currency}`}
          tone="up"
          hint={`${t('personal-ledger.overview.monthBalance')} ${money(dashboard.monthBalance)}`}
        />
        <Kpi
          label={t('personal-ledger.overview.monthExpense')}
          value={`${money(dashboard.monthExpense)} ${currency}`}
          tone="down"
          hint={`${t('personal-ledger.overview.dailyExpense')} ${money(dailyExpense)}`}
        />
        <Kpi label={t('personal-ledger.overview.todayExpense')} value={`${money(dashboard.todayExpense)} ${currency}`} />
        <Kpi
          label={t('personal-ledger.overview.pendingReimburse')}
          value={`${money(dashboard.pendingReimburse)} ${currency}`}
        />
        <Kpi
          label={t('personal-ledger.overview.receivable')}
          value={`${money(dashboard.receivable)} ${currency}`}
          hint={`${t('personal-ledger.overview.payable')} ${money(dashboard.payable)}`}
        />
      </div>

      {/* 左右两栏固定成 8:4（不用断点：一旦在窄窗口退回单列，面板会竖向堆叠、必然溢出）。
          `grid-rows-1` 很关键：不写它的话，隐式行是 `auto`，行高按内容算，内容一高就把网格顶破。 */}
      <div className="grid min-h-0 flex-1 grid-cols-12 grid-rows-1 gap-3">
        {/* 左：本月每日收支（填满）+ 最近流水（按高度分页） */}
        <div className="flex min-h-0 flex-col gap-3 col-span-8">
          <Panel
            className="flex min-h-0 flex-[1.15] flex-col"
            title={t('personal-ledger.overview.monthTrend')}
            extra={
              <span className="flex items-center gap-3 text-xs opacity-70">
                <span className="flex items-center gap-1">
                  <i className="inline-block h-[8px] w-[8px] rounded-full" style={{ backgroundColor: p.income }} />
                  {t('personal-ledger.reports.income')}
                </span>
                <span className="flex items-center gap-1">
                  <i className="inline-block h-[8px] w-[8px] rounded-full" style={{ backgroundColor: p.expense }} />
                  {t('personal-ledger.reports.expense')}
                </span>
              </span>
            }
          >
            <ChartBox>
              {({ width, height }) => <BarChart data={bars} width={width} height={height} />}
            </ChartBox>
          </Panel>

          <Panel className="flex min-h-0 flex-1 flex-col" title={t('personal-ledger.overview.recent')}>
            <FitTable<Transaction>
              table={{
                rowKey: 'id',
                dataSource: dashboard.recent,
                locale: { emptyText: t('personal-ledger.transactions.empty') },
                rowClassName: 'cursor-pointer',
                onRow: (record) => ({ onClick: () => props.onOpenTransaction(record) }),
                columns: [
                  { title: t('personal-ledger.transactions.date'), dataIndex: 'date', width: 100 },
                  {
                    title: t('personal-ledger.transactions.kind'),
                    dataIndex: 'kind',
                    width: 80,
                    render: (value: Transaction['kind']) => t(`personal-ledger.kinds.${value}`)
                  },
                  {
                    title: t('personal-ledger.transactions.amount'),
                    dataIndex: 'amount',
                    width: 130,
                    render: (value: number, row: Transaction) => (
                      <span
                        className="tabular-nums"
                        style={{ color: row.kind === 'income' ? p.up : row.kind === 'expense' ? p.down : undefined }}
                      >
                        {money(value)} {row.currency}
                      </span>
                    )
                  },
                  { title: t('personal-ledger.transactions.note'), dataIndex: 'note', ellipsis: true }
                ]
              }}
            />
          </Panel>
        </div>

        {/* 右：提醒 / 预算进度 / 健康度（都按可用高度自适应） */}
        <div className="flex min-h-0 flex-col gap-3 col-span-4">
          <Panel
            className="flex min-h-0 flex-1 flex-col"
            title={t('personal-ledger.overview.reminders')}
            extra={<span className="text-xs opacity-50">{dashboard.reminders.length}</span>}
          >
            <FitList
              items={dashboard.reminders}
              rowHeight={48}
              keyOf={(item) => `${item.title}-${item.date}`}
              moreLabel={(count) => t('personal-ledger.common.more', { count })}
              empty={<span className="text-xs opacity-60">{t('personal-ledger.overview.noReminders')}</span>}
              renderItem={(item) => (
                <div
                  className="flex items-center justify-between gap-3 rounded border border-solid px-2.5 py-1.5"
                  style={{ borderColor: p.border }}
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs">{item.title}</div>
                    <div className="truncate text-xs opacity-60">{item.detail}</div>
                  </div>
                  <Tag color={levelColor[item.level] ?? 'blue'} variant="filled">
                    {item.date || '-'}
                  </Tag>
                </div>
              )}
            />
          </Panel>

          <Panel
            className="flex min-h-0 flex-1 flex-col"
            title={t('personal-ledger.overview.budgetProgress')}
            extra={<span className="text-xs opacity-50">{dashboard.budgets.length}</span>}
          >
            {dashboard.budgets.length === 0 ? (
              <span className="text-xs opacity-60">{t('personal-ledger.overview.noBudgets')}</span>
            ) : (
              <FitList
                items={dashboard.budgets}
                rowHeight={24}
                keyOf={(item) => item.id}
                moreLabel={(count) => t('personal-ledger.common.more', { count })}
                renderItem={(budget) => {
                  const ratio = budget.amount > 0 ? budget.spent / budget.amount : 0
                  const over = budget.remaining < 0
                  return (
                    <div className="flex items-center gap-3">
                      <span className="w-[110px] shrink-0 truncate text-xs">{budget.name || budget.scope}</span>
                      <div className="min-w-0 flex-1">
                        <Tooltip
                          title={`${money(budget.spent)} / ${money(budget.amount)} ${currency}`}
                        >
                          {/* 进度条：超支变红，一眼能看出问题预算 */}
                          <div
                            className="h-[6px] w-full overflow-hidden rounded-full"
                            style={{ backgroundColor: p.track }}
                          >
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`,
                                backgroundColor: over ? p.down : ratio >= 0.8 ? p.warn : p.accent
                              }}
                            />
                          </div>
                        </Tooltip>
                      </div>
                      <span
                        className="w-[74px] shrink-0 text-right text-xs tabular-nums"
                        style={{ color: over ? p.down : undefined }}
                      >
                        {over ? `+${money(-budget.remaining)}` : money(budget.remaining)}
                      </span>
                    </div>
                  )
                }}
              />
            )}
          </Panel>

          <Panel className="shrink-0" title={t('personal-ledger.overview.health')}>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <MiniStat label={t('personal-ledger.overview.savingsRate')} value={`${savingsRate}%`} tone={savingsRate >= 0 ? 'up' : 'down'} />
              <MiniStat label={t('personal-ledger.overview.debtRatio')} value={`${debtRatio}%`} tone={debtRatio > 60 ? 'down' : 'default'} />
              <MiniStat label={t('personal-ledger.overview.dailyExpense')} value={`${money(dailyExpense)} ${currency}`} />
              <MiniStat
                label={t('personal-ledger.overview.projected')}
                value={`${money(dailyExpense * 30)} ${currency}`}
                tone={dailyExpense * 30 > dashboard.monthIncome ? 'down' : 'default'}
              />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}

/** 健康度里的小指标（两列四格，比 Statistic 省一半高度） */
function MiniStat(props: {
  label: string
  value: React.ReactNode
  tone?: 'default' | 'up' | 'down'
}): React.JSX.Element {
  const p = useLedgerPalette()
  const color = props.tone === 'up' ? p.up : props.tone === 'down' ? p.down : undefined
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="truncate text-xs opacity-60">{props.label}</span>
      <span className="shrink-0 text-xs font-medium tabular-nums" style={{ color }}>
        {props.value}
      </span>
    </div>
  )
}
