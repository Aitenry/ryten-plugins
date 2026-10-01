import { useCallback, useEffect, useState } from 'react'
import { App, Button, DatePicker, Empty, Segmented, Space, Tag as AntTag } from 'antd'
import { RiDownloadLine, RiRefreshLine, RiUploadLine } from '@remixicon/react'
import dayjs from 'dayjs'
import { useTranslation } from '@host/renderer/i18n'
import type { LedgerReport, LedgerState } from '../../shared/types'
import api from '../api'
import { useLedgerPalette } from '../palette'
import { BarChart, Legend, LineChart, PieChart, type Slice } from './Charts'
import { ChartBox, FitTable, Kpi, Panel, money, useSize } from './ui'

/**
 * 报表页：区间统计 + 图表 + 日历视图 + 排行榜 + 异常识别 + 导入导出。
 *
 * 高度策略（一屏装下四个「问题」）：
 *   左栏：收支趋势（柱）+ 余额走势（线）→ 日历热力图
 *   右栏：分类占比（环形 + 图例）→ 洞察（账户 / 成员 / 大额 / 异常 / 投资，用 Segmented 切）
 * 图按容器尺寸重画，日历格子按行数等分高度，所以区间选半年也不会溢出。
 *
 * 所有聚合都在主进程的 `report-get` 里算（与 AI 工具同一套口径），这一层只画图。
 * 图表是手写 SVG（见 Charts.tsx）：插件产物里没有图表库可用。
 */
export default function ReportsTab(props: {
  state: LedgerState
  refreshToken: number
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const p = useLedgerPalette()
  const [preset, setPreset] = useState<'month' | 'lastMonth' | 'last90' | 'year' | 'custom'>('month')
  const [from, setFrom] = useState(dayjs().startOf('month').format('YYYY-MM-DD'))
  const [to, setTo] = useState(dayjs().endOf('month').format('YYYY-MM-DD'))
  const [report, setReport] = useState<LedgerReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)
  const [insight, setInsight] = useState<'account' | 'member' | 'top' | 'anomaly' | 'invest'>('account')
  const currency = props.state.settings.baseCurrency

  const applyPreset = useCallback(
    (value: 'month' | 'lastMonth' | 'last90' | 'year' | 'custom'): void => {
      setPreset(value)
      const now = dayjs()
      if (value === 'month') {
        setFrom(now.startOf('month').format('YYYY-MM-DD'))
        setTo(now.endOf('month').format('YYYY-MM-DD'))
      } else if (value === 'lastMonth') {
        const last = now.subtract(1, 'month')
        setFrom(last.startOf('month').format('YYYY-MM-DD'))
        setTo(last.endOf('month').format('YYYY-MM-DD'))
      } else if (value === 'last90') {
        setFrom(now.subtract(89, 'day').format('YYYY-MM-DD'))
        setTo(now.format('YYYY-MM-DD'))
      } else if (value === 'year') {
        setFrom(now.startOf('year').format('YYYY-MM-DD'))
        setTo(now.endOf('year').format('YYYY-MM-DD'))
      }
    },
    []
  )

  useEffect(() => {
    let alive = true
    setLoading(true)
    void api
      .getReport({ from, to })
      .then((data) => {
        if (alive) setReport(data ?? null)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [from, to, tick, props.refreshToken])

  const slices = (report?.categoryStats ?? []).slice(0, 8).map((item) => ({
    label: item.name || t('personal-ledger.transactions.uncategorized'),
    value: Math.max(0, item.net),
    color: item.color
  }))

  const trendBars = (report?.trend ?? []).map((point) => ({
    label: point.period.slice(5),
    income: point.income,
    expense: point.expense
  }))

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 工具条：区间 + 刷新 + 导入导出 */}
      <Panel
        className="shrink-0"
        title={t('personal-ledger.reports.range')}
        extra={
          <Space size={4}>
            <Button
              size="small"
              icon={<RiRefreshLine size={14} />}
              loading={loading}
              onClick={() => setTick((value) => value + 1)}
            >
              {t('personal-ledger.common.refresh')}
            </Button>
            <Button
              size="small"
              icon={<RiDownloadLine size={14} />}
              onClick={async () => {
                const result = await api.exportData('csv')
                if (result?.ok) message.success(t('personal-ledger.reports.exportDone', { path: result.path }))
              }}
            >
              {t('personal-ledger.reports.exportCsv')}
            </Button>
            <Button
              size="small"
              icon={<RiDownloadLine size={14} />}
              onClick={async () => {
                const result = await api.exportData('json')
                if (result?.ok) message.success(t('personal-ledger.reports.exportDone', { path: result.path }))
              }}
            >
              {t('personal-ledger.reports.exportJson')}
            </Button>
            <Button
              size="small"
              icon={<RiUploadLine size={14} />}
              onClick={async () => {
                const result = await api.importData()
                if (result) {
                  message.success(
                    t('personal-ledger.reports.importResult', {
                      total: result.total,
                      inserted: result.inserted
                    })
                  )
                  props.onChanged()
                }
              }}
            >
              {t('personal-ledger.reports.importCsv')}
            </Button>
          </Space>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            value={preset}
            onChange={(value) => applyPreset(value as typeof preset)}
            options={[
              { value: 'month', label: t('personal-ledger.reports.thisMonth') },
              { value: 'lastMonth', label: t('personal-ledger.reports.lastMonth') },
              { value: 'last90', label: t('personal-ledger.reports.last90') },
              { value: 'year', label: t('personal-ledger.reports.thisYear') }
            ]}
          />
          <DatePicker.RangePicker
            value={[dayjs(from), dayjs(to)]}
            allowClear={false}
            onChange={(values) => {
              if (!values || !values[0] || !values[1]) return
              setPreset('custom')
              setFrom(values[0].format('YYYY-MM-DD'))
              setTo(values[1].format('YYYY-MM-DD'))
            }}
          />
          <span className="ml-auto text-xs opacity-60">
            {t('personal-ledger.transactions.count', { count: report?.count ?? 0 })}
          </span>
        </div>
      </Panel>

      {!report || report.count === 0 ? (
        <Panel className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('personal-ledger.reports.noData')} />
          </div>
        </Panel>
      ) : (
        <>
          <div className="grid shrink-0 grid-cols-5 gap-3">
            <Kpi label={t('personal-ledger.reports.income')} value={`${money(report.income)} ${currency}`} tone="up" />
            <Kpi label={t('personal-ledger.reports.expense')} value={`${money(report.expense)} ${currency}`} tone="down" />
            <Kpi
              label={t('personal-ledger.reports.balance')}
              value={`${money(report.balance)} ${currency}`}
              tone={report.balance >= 0 ? 'accent' : 'down'}
            />
            <Kpi label={t('personal-ledger.reports.refund')} value={`${money(report.refund)} ${currency}`} />
            <Kpi label={t('personal-ledger.reports.avg')} value={`${money(report.count > 0 ? report.expense / report.count : 0)} ${currency}`} />
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-12 grid-rows-1 gap-3">
            {/* 左栏：趋势 + 余额走势 + 日历 */}
            <div className="flex min-h-0 flex-col gap-3 col-span-8">
              {/* 收支趋势与余额走势合住一个面板：省掉一套标题栏与内边距，
                  让日历面板在矮窗口下也能分到高度 */}
              <Panel
                className="flex min-h-0 flex-[1.2] flex-col"
                title={t('personal-ledger.reports.trend')}
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
                    <span className="flex items-center gap-1">
                      <i className="inline-block h-[8px] w-[8px] rounded-full" style={{ backgroundColor: p.accent }} />
                      {t('personal-ledger.reports.balance')}
                    </span>
                  </span>
                }
              >
                <ChartBox className="flex-[1.5]">
                  {({ width, height }) => <BarChart data={trendBars} width={width} height={height} />}
                </ChartBox>
                <div className="my-1 h-px shrink-0" style={{ backgroundColor: p.split }} />
                <ChartBox>
                  {({ width, height }) => (
                    <LineChart
                      values={report.trend.map((point) => point.balance)}
                      labels={report.trend.map((point) => point.period.slice(5))}
                      width={width}
                      height={height}
                      color={p.accent}
                    />
                  )}
                </ChartBox>
              </Panel>

              <Panel className="flex min-h-0 flex-1 flex-col" title={t('personal-ledger.reports.calendar')}>
                <CalendarGrid
                  days={report.calendar}
                  from={report.from}
                  to={report.to}
                  labels={{
                    income: t('personal-ledger.calendar.income'),
                    expense: t('personal-ledger.calendar.expense'),
                    detail: t('personal-ledger.calendar.detail')
                  }}
                />
              </Panel>
            </div>

            {/* 右栏：分类占比 + 洞察（切换式，避免堆一屏表格） */}
            <div className="flex min-h-0 flex-col gap-3 col-span-4">
              <Panel className="flex min-h-0 flex-[1.1] flex-col" title={t('personal-ledger.reports.categoryRanking')}>
                <CategoryDonut
                  data={slices}
                  currency={currency}
                  centerLabel={t('personal-ledger.reports.expense')}
                />
              </Panel>

              <Panel
                className="flex min-h-0 flex-1 flex-col"
                title={t('personal-ledger.reports.insights')}
                extra={
                  <Segmented
                    size="small"
                    value={insight}
                    onChange={(value) => setInsight(value as typeof insight)}
                    options={[
                      { value: 'account', label: t('personal-ledger.reports.account') },
                      { value: 'member', label: t('personal-ledger.reports.member') },
                      { value: 'top', label: t('personal-ledger.reports.top') },
                      { value: 'anomaly', label: t('personal-ledger.reports.anomaly') },
                      { value: 'invest', label: t('personal-ledger.reports.investShort') }
                    ]}
                  />
                }
              >
                <InsightTable kind={insight} report={report} />
              </Panel>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * 分类占比：环形图 + 图例。
 * 环形图直径跟着面板高度走（96～170px），所以面板变矮时是变小而不是溢出。
 */
function CategoryDonut(props: {
  data: Slice[]
  currency: string
  centerLabel: string
}): React.JSX.Element {
  const [ref, size] = useSize()
  // 直径跟着可用高度走，且**不设下限**：容器矮到放不下就只留图例
  const diameter = Math.min(170, Math.max(0, Math.round(size.height)))
  const total = props.data.reduce((sum, item) => sum + Math.max(0, item.value), 0)
  return (
    <div ref={ref} className="flex min-h-0 flex-1 items-center gap-3">
      {diameter >= 64 ? (
        <PieChart
          data={props.data}
          size={diameter}
          centerLabel={props.centerLabel}
          centerValue={money(total, 0)}
        />
      ) : null}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Legend data={props.data} currency={props.currency} />
      </div>
    </div>
  )
}

/** 洞察表：按 Segmented 切换数据源与列（同一块地方回答三个问题，省一屏高度） */
function InsightTable(props: {
  kind: 'account' | 'member' | 'top' | 'anomaly' | 'invest'
  report: LedgerReport
}): React.JSX.Element {
  const { t } = useTranslation()
  const p = useLedgerPalette()
  const nameOf = (value: string): string => value || '-'
  const num = (value: number): React.JSX.Element => <span className="tabular-nums">{money(value)}</span>

  if (props.kind === 'account') {
    return (
      <FitTable
        table={{
          rowKey: 'accountId',
          dataSource: props.report.accountStats,
          locale: { emptyText: t('personal-ledger.common.empty') },
          columns: [
            { title: t('personal-ledger.transactions.account'), dataIndex: 'name', ellipsis: true },
            { title: t('personal-ledger.accounts.inflow'), dataIndex: 'inflow', width: 96, render: num },
            { title: t('personal-ledger.accounts.outflow'), dataIndex: 'outflow', width: 96, render: num },
            { title: t('personal-ledger.accounts.balance'), dataIndex: 'balance', width: 104, render: num }
          ]
        }}
      />
    )
  }

  if (props.kind === 'member') {
    return (
      <FitTable
        table={{
          rowKey: 'member',
          dataSource: props.report.memberStats,
          locale: { emptyText: t('personal-ledger.common.empty') },
          columns: [
            {
              title: t('personal-ledger.transactions.member'),
              dataIndex: 'member',
              ellipsis: true,
              render: nameOf
            },
            { title: t('personal-ledger.reports.income'), dataIndex: 'income', width: 96, render: num },
            { title: t('personal-ledger.reports.expense'), dataIndex: 'expense', width: 96, render: num },
            { title: t('personal-ledger.reports.balance'), dataIndex: 'balance', width: 96, render: num }
          ]
        }}
      />
    )
  }

  if (props.kind === 'top') {
    return (
      <FitTable
        table={{
          rowKey: 'id',
          dataSource: props.report.topExpenses,
          locale: { emptyText: t('personal-ledger.common.empty') },
          columns: [
            { title: t('personal-ledger.transactions.date'), dataIndex: 'date', width: 96 },
            { title: t('personal-ledger.transactions.amount'), dataIndex: 'amount', width: 104, render: num },
            { title: t('personal-ledger.transactions.note'), dataIndex: 'note', ellipsis: true }
          ]
        }}
      />
    )
  }

  if (props.kind === 'invest') {
    return (
      <FitTable
        table={{
          rowKey: 'accountId',
          dataSource: props.report.investments,
          locale: { emptyText: t('personal-ledger.common.empty') },
          columns: [
            { title: t('personal-ledger.transactions.account'), dataIndex: 'name', ellipsis: true },
            { title: t('personal-ledger.reports.invested'), dataIndex: 'invested', width: 100, render: num },
            { title: t('personal-ledger.reports.value'), dataIndex: 'value', width: 100, render: num },
            {
              title: t('personal-ledger.reports.profit'),
              dataIndex: 'profit',
              width: 116,
              render: (value: number, row: { ratio: number }) => (
                <span className="tabular-nums" style={{ color: value >= 0 ? p.up : p.down }}>
                  {money(value)}（{Math.round(row.ratio * 100)}%）
                </span>
              )
            }
          ]
        }}
      />
    )
  }

  return (
    <FitTable
      table={{
        rowKey: (row) => `${row.id}-${row.reason}`,
        dataSource: props.report.anomalies,
        locale: { emptyText: t('personal-ledger.common.empty') },
        columns: [
          { title: t('personal-ledger.transactions.date'), dataIndex: 'date', width: 96 },
          {
            title: t('personal-ledger.transactions.kind'),
            dataIndex: 'reason',
            width: 116,
            render: (value: string) => (
              <AntTag color={value === 'duplicate' ? 'red' : 'orange'} variant="filled">
                {value === 'duplicate'
                  ? t('personal-ledger.reports.anomalyDuplicate')
                  : t('personal-ledger.reports.anomalyLarge')}
              </AntTag>
            )
          },
          { title: t('personal-ledger.transactions.amount'), dataIndex: 'amount', width: 104, render: num },
          { title: t('personal-ledger.transactions.note'), dataIndex: 'note', ellipsis: true }
        ]
      }}
    />
  )
}

/**
 * 日历热力图：按「周一到周日」铺格子，颜色深浅 = 当天支出占区间最大值的比例。
 * 行数按实际天数算并用 `1fr` 等分高度——区间选整年也会自动压扁，不会溢出。
 * 格子太矮时（<34px）自动隐藏金额，只留日期与颜色。
 */
function CalendarGrid(props: {
  days: { date: string; income: number; expense: number }[]
  from: string
  to: string
  labels: { income: string; expense: string; detail: string }
}): React.JSX.Element {
  const [ref, size] = useSize()
  const p = useLedgerPalette()
  const map = new Map(props.days.map((day) => [day.date, day]))
  const start = dayjs(props.from)
  const end = dayjs(props.to)
  const cells: { date: string; inRange: boolean }[] = []
  const firstWeekday = (start.day() + 6) % 7
  for (let i = 0; i < firstWeekday; i += 1) cells.push({ date: '', inRange: false })
  let cursor = start
  let guard = 0
  while (cursor.isBefore(end) || cursor.isSame(end, 'day')) {
    cells.push({ date: cursor.format('YYYY-MM-DD'), inRange: true })
    cursor = cursor.add(1, 'day')
    guard += 1
    if (guard > 400) break
  }
  const rows = Math.max(1, Math.ceil(cells.length / 7))
  const cellHeight = size.height > 0 ? size.height / rows : 32
  // 三档降级：够高才显示金额，再矮只显示日期，连日期都放不下就只留颜色块
  const showAmount = cellHeight >= 52
  const showDate = cellHeight >= 26
  const maxExpense = Math.max(1, ...props.days.map((day) => day.expense))

  return (
    <div ref={ref} className="min-h-0 flex-1">
      <div
        className="grid h-full grid-cols-7 gap-1"
        style={{ gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
      >
        {cells.map((cell, index) => {
          if (!cell.inRange) return <div key={`blank-${index}`} className="rounded" />
          const day = map.get(cell.date)
          const intensity = day ? Math.min(1, day.expense / maxExpense) : 0
          return (
            <div
              key={cell.date}
              className={`flex min-h-0 flex-col overflow-hidden rounded ${
                showDate ? 'border border-solid px-1 py-[2px] text-[10px] leading-4' : ''
              }`}
              style={{
                backgroundColor: intensity > 0 ? `rgba(249, 115, 22, ${0.08 + intensity * 0.4})` : undefined,
                borderColor: showDate ? p.border : undefined
              }}
              title={
                day
                  ? props.labels.detail
                      .replace('{{date}}', cell.date)
                      .replace('{{income}}', day.income.toFixed(2))
                      .replace('{{expense}}', day.expense.toFixed(2))
                  : cell.date
              }
            >
              {showDate ? <span className="opacity-70">{cell.date.slice(8)}</span> : null}
              {showAmount && day && day.income > 0 ? (
                <span className="truncate" style={{ color: p.up }}>+{day.income.toFixed(0)}</span>
              ) : null}
              {showAmount && day && day.expense > 0 ? (
                <span className="truncate" style={{ color: p.expense }}>-{day.expense.toFixed(0)}</span>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
