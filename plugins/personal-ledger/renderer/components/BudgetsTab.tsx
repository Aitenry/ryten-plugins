import { useState } from 'react'
import { Button, Space } from 'antd'
import { RiAddLine, RiDeleteBin6Line } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { BudgetPeriod, BudgetProgress, BudgetScope, LedgerState } from '../../shared/types'
import api from '../api'
import { useLedgerPalette } from '../palette'
import { ProgressBar } from './Charts'
import EntityForm, { type FieldSpec } from './EntityForm'
import { FitList, FitTable, Kpi, Panel, money, useSize } from './ui'

/**
 * 进度单元格：**按自己的可用宽度换排版**，保证内容永远压不到隔壁「操作」列上。
 *
 * 为什么必须自适应：表格是 `table-layout: fixed`（只要有列写了 `ellipsis` 就会这样），
 * 没写 `width` 的「进度」列只能分到**剩下的**宽度——1200 宽的窗口里只剩 ~106px，
 * 而「一行放满」至少要 ~216px（进度条 + 两个数字）。`td` 的 overflow 又是 visible，
 * 于是数字直接糊在「操作」列的编辑/删除按钮上（实测溢出 112px）。
 * 所以这里量一次自己的宽度：够宽（≥250）就一行放满、数字右对齐；
 * 不够就「进度条一行、数字一行」两行放，数字一律 `min-w-0 truncate` 兜底——
 * 最坏只是省略号，绝不会越界。
 *
 * 注意：一行 / 两行是按**列宽**选的（同一列所有行同宽 → 同一排版），
 * 于是每行高度一致，FitTable 量出来的行高对每一行都成立。
 */
function ProgressCell(props: {
  ratio: number
  spent: number
  amount: number
  remaining: number
  over: boolean
}): React.JSX.Element {
  const [ref, size] = useSize<HTMLDivElement>()
  const p = useLedgerPalette()
  const moneyText = `${money(props.spent)} / ${money(props.amount)}`
  const restText = props.over ? `+${money(-props.remaining)}` : money(props.remaining)
  const wide = size.width >= 250

  return (
    <div ref={ref} className={`flex w-full min-w-0 ${wide ? 'items-center gap-3' : 'flex-col gap-1'}`}>
      <div className={wide ? 'min-w-[24px] flex-1' : 'w-full shrink-0'}>
        <ProgressBar ratio={props.ratio} label={`${moneyText} · ${restText}`} />
      </div>
      <div className={`flex min-w-0 items-center gap-3 ${wide ? '' : 'w-full justify-between'}`}>
        <span className="min-w-0 flex-1 truncate text-xs tabular-nums" title={moneyText}>
          {moneyText}
        </span>
        <span
          className="shrink-0 text-right text-xs tabular-nums"
          style={{ color: props.over ? p.down : undefined }}
          title={restText}
        >
          {restText}
        </span>
      </div>
    </div>
  )
}

/**
 * 预算页：总预算 / 分类 / 标签 / 账户 / 成员五个维度的额度与进度。
 *
 * 高度策略：上面一排汇总，下面「明细表 + 使用率榜」两栏填满剩余高度。
 * 使用率榜按超支优先排序，且用横向条而不是饼图——多条预算比大小的场景，
 * 同一条基线上的长度差比角度差好读得多。
 *
 * 进度来自 `dashboard-get`（主进程按每个预算自己的周期算），
 * 因此「预算页看到的已用金额」与「AI 工具报的已用金额」是同一个数。
 *
 * `ref` 故意让用户填名字（分类名 / 标签名 / 账户名 / 成员名）：填 id 太反人类，
 * 主进程按名字解析成对应的 id。
 */
export default function BudgetsTab(props: {
  state: LedgerState
  budgets: BudgetProgress[]
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const p = useLedgerPalette()
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState(false)
  const currency = props.state.settings.baseCurrency

  const fields: FieldSpec[] = [
    { key: 'name', label: t('personal-ledger.budgets.name'), type: 'text' },
    {
      key: 'period',
      label: t('personal-ledger.budgets.period'),
      type: 'select',
      options: (['week', 'month', 'year', 'custom'] as BudgetPeriod[]).map((value) => ({
        value,
        label: t(`personal-ledger.periods.${value}`)
      }))
    },
    {
      key: 'scope',
      label: t('personal-ledger.budgets.scope'),
      type: 'select',
      options: (['total', 'category', 'tag', 'account', 'member'] as BudgetScope[]).map((value) => ({
        value,
        label: t(`personal-ledger.scopes.${value}`)
      }))
    },
    {
      key: 'ref',
      label: t('personal-ledger.budgets.ref'),
      type: 'text',
      placeholder: t('personal-ledger.budgets.ref')
    },
    { key: 'amount', label: t('personal-ledger.budgets.amount'), type: 'number', step: 100 },
    { key: 'startDate', label: t('personal-ledger.budgets.startDate'), type: 'date' },
    { key: 'endDate', label: t('personal-ledger.budgets.endDate'), type: 'date' }
  ]

  const limit = props.budgets.reduce((sum, budget) => sum + budget.amount, 0)
  const spent = props.budgets.reduce((sum, budget) => sum + budget.spent, 0)
  const overCount = props.budgets.filter((budget) => budget.remaining < 0).length
  const ranking = [...props.budgets].sort((a, b) => {
    const ra = a.amount > 0 ? a.spent / a.amount : 0
    const rb = b.amount > 0 ? b.spent / b.amount : 0
    return rb - ra
  })

  /** 把「用户填的名字」解析成 scope 对应的取值 */
  const resolveRef = (scope: BudgetScope, raw: string): string => {
    const value = raw.trim()
    if (!value || scope === 'total') return ''
    if (scope === 'category') {
      if (/^\d+$/.test(value)) return value
      const category = props.state.categories.find((item) => item.name === value)
      return category ? String(category.id) : value
    }
    if (scope === 'account') {
      if (/^\d+$/.test(value)) return value
      const account = props.state.accounts.find((item) => item.name === value)
      return account ? String(account.id) : value
    }
    return value
  }

  const scopeLabel = (budget: BudgetProgress): string => {
    if (budget.scope === 'category') {
      return props.state.categories.find((item) => String(item.id) === budget.ref)?.name ?? budget.ref
    }
    if (budget.scope === 'account') {
      return props.state.accounts.find((item) => String(item.id) === budget.ref)?.name ?? budget.ref
    }
    return budget.ref
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="grid shrink-0 grid-cols-4 gap-3">
        <Kpi label={t('personal-ledger.page.tabs.budgets')} value={props.budgets.length} />
        <Kpi label={t('personal-ledger.budgets.amount')} value={`${money(limit)} ${currency}`} />
        <Kpi
          label={t('personal-ledger.budgets.spent')}
          value={`${money(spent)} ${currency}`}
          tone="down"
          hint={`${t('personal-ledger.budgets.remaining')} ${money(limit - spent)}`}
        />
        <Kpi
          label={t('personal-ledger.budgets.over')}
          value={overCount}
          tone={overCount > 0 ? 'down' : 'up'}
          hint={`${t('personal-ledger.reports.thisMonth')}`}
        />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-12 grid-rows-1 gap-3">
        <Panel
          className="flex min-h-0 flex-col col-span-7"
          title={t('personal-ledger.budgets.progress')}
          extra={
            <Button
              size="small"
              type="primary"
              icon={<RiAddLine size={14} />}
              onClick={() =>
                setDraft({
                  name: '',
                  period: 'month',
                  scope: 'total',
                  ref: '',
                  amount: 1000,
                  startDate: '',
                  endDate: ''
                })
              }
            >
              {t('personal-ledger.page.addBudget')}
            </Button>
          }
        >
          <FitTable<BudgetProgress>
            table={{
              rowKey: 'id',
              dataSource: props.budgets,
              locale: { emptyText: t('personal-ledger.budgets.empty') },
              columns: [
                { title: t('personal-ledger.budgets.name'), dataIndex: 'name', width: 120, ellipsis: true },
                {
                  title: t('personal-ledger.budgets.scope'),
                  key: 'scope',
                  width: 118,
                  ellipsis: true,
                  render: (_value, row) => `${t(`personal-ledger.scopes.${row.scope}`)} ${scopeLabel(row)}`.trim()
                },
                {
                  title: t('personal-ledger.budgets.period'),
                  key: 'period',
                  width: 92,
                  ellipsis: true,
                  render: (_value, row) =>
                    row.period === 'custom'
                      ? `${row.startDate} ~ ${row.endDate}`
                      : t(`personal-ledger.periods.${row.period}`)
                },
                {
                  title: t('personal-ledger.budgets.progress'),
                  key: 'progress',
                  render: (_value, row) => (
                    <ProgressCell
                      ratio={row.ratio}
                      spent={row.spent}
                      amount={row.amount}
                      remaining={row.remaining}
                      over={row.remaining < 0}
                    />
                  )
                },
                {
                  title: t('personal-ledger.common.actions'),
                  key: 'actions',
                  width: 92,
                  render: (_value, row) => (
                    <Space size={2}>
                      <Button
                        size="small"
                        type="text"
                        onClick={() =>
                          setDraft({
                            id: row.id,
                            name: row.name,
                            period: row.period,
                            scope: row.scope,
                            ref: scopeLabel(row),
                            amount: row.amount,
                            startDate: row.startDate,
                            endDate: row.endDate
                          })
                        }
                      >
                        {t('personal-ledger.common.edit')}
                      </Button>
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<RiDeleteBin6Line size={14} />}
                        onClick={() => void api.removeBudget(row.id).then(() => props.onChanged())}
                      />
                    </Space>
                  )
                }
              ]
            }}
          />
        </Panel>

        <Panel
          className="flex min-h-0 flex-col col-span-5"
          title={t('personal-ledger.budgets.usage')}
          extra={<span className="text-xs opacity-50">{ranking.length}</span>}
        >
          <FitList
            items={ranking}
            rowHeight={34}            keyOf={(budget) => budget.id}
            moreLabel={(count) => t('personal-ledger.common.more', { count })}
            empty={<span className="text-xs opacity-60">{t('personal-ledger.budgets.empty')}</span>}
            renderItem={(budget) => {
              const ratio = budget.amount > 0 ? budget.spent / budget.amount : 0
              const over = budget.remaining < 0
              return (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="min-w-0 truncate">{budget.name || scopeLabel(budget) || budget.scope}</span>
                    <span className="shrink-0 tabular-nums" style={{ color: over ? p.down : undefined }}>
                      {Math.round(ratio * 100)}%
                    </span>
                  </div>
                  <ProgressBar
                    ratio={ratio}
                    size="md"
                    label={`${money(budget.spent)} / ${money(budget.amount)} ${currency}`}
                  />
                </div>
              )
            }}
          />
        </Panel>
      </div>

      <EntityForm
        open={draft !== null}
        title={draft?.id ? t('personal-ledger.common.edit') : t('personal-ledger.page.addBudget')}
        fields={fields}
        values={draft ?? {}}
        saving={busy}
        onCancel={() => setDraft(null)}
        onSubmit={async (values) => {
          setBusy(true)
          try {
            const scope = (values.scope as BudgetScope) ?? 'total'
            await api.saveBudget({
              id: values.id as number | undefined,
              name: String(values.name ?? ''),
              period: (values.period as BudgetPeriod) ?? 'month',
              scope,
              ref: resolveRef(scope, String(values.ref ?? '')),
              amount: Number(values.amount ?? 0),
              startDate: String(values.startDate ?? ''),
              endDate: String(values.endDate ?? '')
            })
            setDraft(null)
            props.onChanged()
          } finally {
            setBusy(false)
          }
        }}
      />
    </div>
  )
}
