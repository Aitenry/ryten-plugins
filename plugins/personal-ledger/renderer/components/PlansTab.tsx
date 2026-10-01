import { useState } from 'react'
import { App, Button, Space, Tag as AntTag } from 'antd'
import { RiAddLine, RiDeleteBin6Line, RiPlayLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { Debt, Deposit, Goal, LedgerState, RecurFrequency, Recurring, TxKind } from '../../shared/types'
import api, { type PlansData } from '../api'
import { useLedgerPalette } from '../palette'
import { ProgressBar } from './Charts'
import EntityForm, { type FieldSpec } from './EntityForm'
import { FitList, FitTable, Kpi, Panel, money } from './ui'

/**
 * 计划页：储蓄目标 / 周期记账 / 借入借出（应收应付）/ 定期存款。
 *
 * 高度策略：上面一排汇总（应收 / 应付 / 存款本金 / 目标进度），下面 2×2 四个面板
 * 各自吃掉四分之一高度，表与列表都按可用高度自适应——四块内容互不挤压，
 * 也不用滚动条。
 *
 * 这四件事的共同点是「**未来的钱**」——它们不是流水，但都会生成提醒：
 * 周期账到点自动落成流水（幂等，靠 next_run 推进），借还结算时才记一笔真流水。
 */
export default function PlansTab(props: {
  state: LedgerState
  plans: PlansData
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const p = useLedgerPalette()
  const [busy, setBusy] = useState(false)
  const [goalDraft, setGoalDraft] = useState<Record<string, unknown> | null>(null)
  const [goalDeposit, setGoalDeposit] = useState<Goal | null>(null)
  const [recurringDraft, setRecurringDraft] = useState<Record<string, unknown> | null>(null)
  const [debtDraft, setDebtDraft] = useState<Record<string, unknown> | null>(null)
  const [settle, setSettle] = useState<Debt | null>(null)
  const [depositDraft, setDepositDraft] = useState<Record<string, unknown> | null>(null)
  const currency = props.state.settings.baseCurrency

  const accountOptions = props.state.accounts.map((account) => ({ value: account.id, label: account.name }))
  const categoryOptions = props.state.categories.map((category) => ({ value: category.id, label: category.name }))

  const goalTarget = props.plans.goals.reduce((sum, goal) => sum + goal.targetAmount, 0)
  const goalSaved = props.plans.goals.reduce((sum, goal) => sum + goal.savedAmount, 0)
  const receivable = props.plans.debts
    .filter((debt) => debt.direction === 'lend')
    .reduce((sum, debt) => sum + Math.max(0, debt.amount - debt.settled), 0)
  const payable = props.plans.debts
    .filter((debt) => debt.direction === 'borrow')
    .reduce((sum, debt) => sum + Math.max(0, debt.amount - debt.settled), 0)
  const principal = props.plans.deposits.reduce((sum, deposit) => sum + deposit.principal, 0)

  const goalFields: FieldSpec[] = [
    { key: 'name', label: t('personal-ledger.plans.goals'), type: 'text' },
    { key: 'targetAmount', label: t('personal-ledger.plans.targetAmount'), type: 'number', step: 1000 },
    { key: 'savedAmount', label: t('personal-ledger.plans.savedAmount'), type: 'number', step: 100 },
    { key: 'dueDate', label: t('personal-ledger.plans.dueDate'), type: 'date' },
    { key: 'note', label: t('personal-ledger.transactions.note'), type: 'textarea' }
  ]

  const recurringFields: FieldSpec[] = [
    { key: 'name', label: t('personal-ledger.plans.recurring'), type: 'text' },
    {
      key: 'kind',
      label: t('personal-ledger.transactions.kind'),
      type: 'select',
      options: (['expense', 'income'] as TxKind[]).map((value) => ({
        value,
        label: t(`personal-ledger.kinds.${value}`)
      }))
    },
    { key: 'amount', label: t('personal-ledger.transactions.amount'), type: 'number', step: 10 },
    { key: 'categoryId', label: t('personal-ledger.transactions.category'), type: 'select', options: categoryOptions },
    { key: 'accountId', label: t('personal-ledger.transactions.account'), type: 'select', options: accountOptions },
    {
      key: 'frequency',
      label: t('personal-ledger.plans.frequency'),
      type: 'select',
      options: (['daily', 'weekly', 'monthly', 'yearly'] as RecurFrequency[]).map((value) => ({
        value,
        label: t(`personal-ledger.frequencies.${value}`)
      }))
    },
    { key: 'nextRun', label: t('personal-ledger.plans.nextRun'), type: 'date' },
    { key: 'enabled', label: t('personal-ledger.common.enable'), type: 'switch' },
    { key: 'note', label: t('personal-ledger.transactions.note'), type: 'text' }
  ]

  const debtFields: FieldSpec[] = [
    {
      key: 'direction',
      label: t('personal-ledger.transactions.kind'),
      type: 'select',
      options: [
        { value: 'lend', label: t('personal-ledger.debts.lend') },
        { value: 'borrow', label: t('personal-ledger.debts.borrow') }
      ]
    },
    { key: 'counterparty', label: t('personal-ledger.form.merchant'), type: 'text' },
    { key: 'amount', label: t('personal-ledger.transactions.amount'), type: 'number', step: 100 },
    { key: 'settled', label: t('personal-ledger.plans.unsettled'), type: 'number', step: 100 },
    { key: 'dueDate', label: t('personal-ledger.plans.dueDate'), type: 'date' },
    { key: 'note', label: t('personal-ledger.transactions.note'), type: 'text' }
  ]

  const depositFields: FieldSpec[] = [
    { key: 'name', label: t('personal-ledger.plans.deposits'), type: 'text' },
    { key: 'accountId', label: t('personal-ledger.transactions.account'), type: 'select', options: accountOptions },
    { key: 'principal', label: t('personal-ledger.plans.principal'), type: 'number', step: 1000 },
    { key: 'rate', label: t('personal-ledger.plans.rate'), type: 'number', step: 0.1 },
    { key: 'startDate', label: t('personal-ledger.budgets.startDate'), type: 'date' },
    { key: 'maturityDate', label: t('personal-ledger.plans.maturityDate'), type: 'date' },
    { key: 'note', label: t('personal-ledger.transactions.note'), type: 'text' }
  ]

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="grid shrink-0 grid-cols-4 gap-3">
        <Kpi
          label={t('personal-ledger.plans.goals')}
          value={`${money(goalSaved)} / ${money(goalTarget)}`}
          tone="accent"
          hint={
            goalTarget > 0
              ? `${Math.round((goalSaved / goalTarget) * 100)}% · ${currency}`
              : currency
          }
        />
        <Kpi label={t('personal-ledger.debts.lend')} value={`${money(receivable)} ${currency}`} tone="up" />
        <Kpi label={t('personal-ledger.debts.borrow')} value={`${money(payable)} ${currency}`} tone="down" />
        <Kpi label={t('personal-ledger.plans.principal')} value={`${money(principal)} ${currency}`} />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-3">
        {/* 储蓄目标 */}
        <Panel
          className="flex min-h-0 flex-col"
          title={t('personal-ledger.plans.goals')}
          extra={
            <Button
              size="small"
              icon={<RiAddLine size={14} />}
              onClick={() => setGoalDraft({ name: '', targetAmount: 10000, savedAmount: 0, dueDate: '', note: '' })}
            >
              {t('personal-ledger.page.addGoal')}
            </Button>
          }
        >
          <FitList
            items={props.plans.goals}
            rowHeight={40}
            keyOf={(goal) => goal.id}
            moreLabel={(count) => t('personal-ledger.common.more', { count })}
            empty={<span className="text-xs opacity-60">{t('personal-ledger.plans.goalEmpty')}</span>}
            renderItem={(goal) => (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate">
                    {goal.name}
                    {goal.dueDate ? <span className="ml-2 text-xs opacity-60">{goal.dueDate}</span> : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 tabular-nums opacity-70">
                    {money(goal.savedAmount)} / {money(goal.targetAmount)}
                    <Button size="small" type="link" onClick={() => setGoalDeposit(goal)}>
                      {t('personal-ledger.common.deposit')}
                    </Button>
                    <Button size="small" type="link" onClick={() => setGoalDraft({ ...goal, id: goal.id })}>
                      {t('personal-ledger.common.edit')}
                    </Button>
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<RiDeleteBin6Line size={12} />}
                      onClick={() => void api.removeGoal(goal.id).then(() => props.onChanged())}
                    />
                  </span>
                </div>
                <ProgressBar ratio={goal.targetAmount > 0 ? goal.savedAmount / goal.targetAmount : 0} />
              </div>
            )}
          />
        </Panel>

        {/* 周期记账 */}
        <Panel
          className="flex min-h-0 flex-col"
          title={t('personal-ledger.plans.recurring')}
          extra={
            <Space size={4}>
              <Button
                size="small"
                icon={<RiPlayLine size={14} />}
                onClick={async () => {
                  const created = await api.runRecurring()
                  message.success(t('personal-ledger.plans.autoPosted', { count: created ?? 0 }))
                  props.onChanged()
                }}
              >
                {t('personal-ledger.page.runRecurring')}
              </Button>
              <Button
                size="small"
                icon={<RiAddLine size={14} />}
                onClick={() =>
                  setRecurringDraft({
                    name: '',
                    kind: 'expense',
                    amount: 0,
                    categoryId: null,
                    accountId: null,
                    frequency: 'monthly',
                    nextRun: '',
                    enabled: true,
                    note: ''
                  })
                }
              >
                {t('personal-ledger.page.addRecurring')}
              </Button>
            </Space>
          }
        >
          <FitTable<Recurring>
            table={{
              rowKey: 'id',
              dataSource: props.plans.recurring,
              locale: { emptyText: t('personal-ledger.common.empty') },
              columns: [
                { title: t('personal-ledger.plans.recurring'), dataIndex: 'name', ellipsis: true },
                {
                  title: t('personal-ledger.transactions.kind'),
                  dataIndex: 'kind',
                  width: 70,
                  render: (value: TxKind) => t(`personal-ledger.kinds.${value}`)
                },
                {
                  title: t('personal-ledger.transactions.amount'),
                  dataIndex: 'amount',
                  width: 100,
                  render: (value: number) => <span className="tabular-nums">{money(value)}</span>
                },
                {
                  title: t('personal-ledger.plans.frequency'),
                  dataIndex: 'frequency',
                  width: 84,
                  render: (value: RecurFrequency) => t(`personal-ledger.frequencies.${value}`)
                },
                { title: t('personal-ledger.plans.nextRun'), dataIndex: 'nextRun', width: 104 },
                {
                  title: t('personal-ledger.common.enable'),
                  dataIndex: 'enabled',
                  width: 76,
                  render: (value: boolean) => (
                    <AntTag color={value ? 'green' : 'default'} variant="filled">
                      {value ? t('personal-ledger.common.enable') : t('personal-ledger.common.disable')}
                    </AntTag>
                  )
                },
                {
                  title: t('personal-ledger.common.actions'),
                  key: 'actions',
                  width: 96,
                  render: (_value, row) => (
                    <Space size={2}>
                      <Button size="small" type="text" onClick={() => setRecurringDraft({ ...row, id: row.id })}>
                        {t('personal-ledger.common.edit')}
                      </Button>
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<RiDeleteBin6Line size={14} />}
                        onClick={() => void api.removeRecurring(row.id).then(() => props.onChanged())}
                      />
                    </Space>
                  )
                }
              ]
            }}
          />
        </Panel>

        {/* 借入借出 */}
        <Panel
          className="flex min-h-0 flex-col"
          title={t('personal-ledger.page.addDebt')}
          extra={
            <Button
              size="small"
              icon={<RiAddLine size={14} />}
              onClick={() =>
                setDebtDraft({ direction: 'lend', counterparty: '', amount: 0, settled: 0, dueDate: '', note: '' })
              }
            >
              {t('personal-ledger.page.addDebt')}
            </Button>
          }
        >
          <FitTable<Debt>
            table={{
              rowKey: 'id',
              dataSource: props.plans.debts,
              locale: { emptyText: t('personal-ledger.plans.debtEmpty') },
              columns: [
                {
                  title: t('personal-ledger.transactions.kind'),
                  dataIndex: 'direction',
                  width: 130,
                  render: (value: Debt['direction']) => (
                    <AntTag color={value === 'lend' ? 'green' : 'orange'} variant="filled">
                      {t(`personal-ledger.debts.${value}`)}
                    </AntTag>
                  )
                },
                { title: t('personal-ledger.form.merchant'), dataIndex: 'counterparty', ellipsis: true },
                {
                  title: t('personal-ledger.transactions.amount'),
                  dataIndex: 'amount',
                  width: 104,
                  render: (value: number) => <span className="tabular-nums">{money(value)}</span>
                },
                {
                  title: t('personal-ledger.plans.unsettled'),
                  key: 'open',
                  width: 96,
                  render: (_value, row) => (
                    <span className="tabular-nums" style={{ color: p.down }}>{money(row.amount - row.settled)}</span>
                  )
                },
                { title: t('personal-ledger.plans.dueDate'), dataIndex: 'dueDate', width: 104 },
                {
                  title: t('personal-ledger.common.actions'),
                  key: 'actions',
                  width: 128,
                  render: (_value, row) => (
                    <Space size={2}>
                      <Button size="small" type="text" onClick={() => setSettle(row)}>
                        {t('personal-ledger.common.settle')}
                      </Button>
                      <Button size="small" type="text" onClick={() => setDebtDraft({ ...row, id: row.id })}>
                        {t('personal-ledger.common.edit')}
                      </Button>
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<RiDeleteBin6Line size={14} />}
                        onClick={() => void api.removeDebt(row.id).then(() => props.onChanged())}
                      />
                    </Space>
                  )
                }
              ]
            }}
          />
        </Panel>

        {/* 定期存款 */}
        <Panel
          className="flex min-h-0 flex-col"
          title={t('personal-ledger.plans.deposits')}
          extra={
            <Button
              size="small"
              icon={<RiAddLine size={14} />}
              onClick={() =>
                setDepositDraft({
                  name: '',
                  accountId: null,
                  principal: 50000,
                  rate: 2,
                  startDate: '',
                  maturityDate: '',
                  note: ''
                })
              }
            >
              {t('personal-ledger.page.addDeposit')}
            </Button>
          }
        >
          <FitTable<Deposit>
            table={{
              rowKey: 'id',
              dataSource: props.plans.deposits,
              locale: { emptyText: t('personal-ledger.plans.depositEmpty') },
              columns: [
                { title: t('personal-ledger.plans.deposits'), dataIndex: 'name', ellipsis: true },
                {
                  title: t('personal-ledger.plans.principal'),
                  dataIndex: 'principal',
                  width: 116,
                  render: (value: number) => <span className="tabular-nums">{money(value)}</span>
                },
                {
                  title: t('personal-ledger.plans.rate'),
                  dataIndex: 'rate',
                  width: 84,
                  render: (value: number) => `${value}%`
                },
                { title: t('personal-ledger.plans.maturityDate'), dataIndex: 'maturityDate', width: 110 },
                {
                  title: t('personal-ledger.common.actions'),
                  key: 'actions',
                  width: 96,
                  render: (_value, row) => (
                    <Space size={2}>
                      <Button size="small" type="text" onClick={() => setDepositDraft({ ...row, id: row.id })}>
                        {t('personal-ledger.common.edit')}
                      </Button>
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<RiDeleteBin6Line size={14} />}
                        onClick={() => void api.removeDeposit(row.id).then(() => props.onChanged())}
                      />
                    </Space>
                  )
                }
              ]
            }}
          />
        </Panel>
      </div>

      {/* ── 弹窗 ── */}
      <EntityForm
        open={goalDraft !== null}
        title={goalDraft?.id ? t('personal-ledger.common.edit') : t('personal-ledger.page.addGoal')}
        fields={goalFields}
        values={goalDraft ?? {}}
        saving={busy}
        onCancel={() => setGoalDraft(null)}
        onSubmit={async (values) => {
          if (!String(values.name ?? '').trim()) return
          setBusy(true)
          try {
            await api.saveGoal({
              id: values.id as number | undefined,
              name: String(values.name),
              targetAmount: Number(values.targetAmount ?? 0),
              savedAmount: Number(values.savedAmount ?? 0),
              dueDate: String(values.dueDate ?? ''),
              note: String(values.note ?? '')
            })
            setGoalDraft(null)
            props.onChanged()
          } finally {
            setBusy(false)
          }
        }}
      />

      <EntityForm
        open={goalDeposit !== null}
        title={`${t('personal-ledger.common.deposit')}：${goalDeposit?.name ?? ''}`}
        fields={[{ key: 'amount', label: t('personal-ledger.transactions.amount'), type: 'number', step: 100 }]}
        values={{ amount: 500 }}
        saving={busy}
        onCancel={() => setGoalDeposit(null)}
        onSubmit={async (values) => {
          if (!goalDeposit) return
          setBusy(true)
          try {
            await api.depositGoal(goalDeposit.id, Number(values.amount ?? 0))
            setGoalDeposit(null)
            props.onChanged()
          } finally {
            setBusy(false)
          }
        }}
      />

      <EntityForm
        open={recurringDraft !== null}
        title={recurringDraft?.id ? t('personal-ledger.common.edit') : t('personal-ledger.page.addRecurring')}
        fields={recurringFields}
        values={recurringDraft ?? {}}
        saving={busy}
        onCancel={() => setRecurringDraft(null)}
        onSubmit={async (values) => {
          if (!String(values.name ?? '').trim()) return
          setBusy(true)
          try {
            await api.saveRecurring({
              id: values.id as number | undefined,
              name: String(values.name),
              kind: (values.kind as TxKind) ?? 'expense',
              amount: Number(values.amount ?? 0),
              categoryId: (values.categoryId as number | null) ?? null,
              accountId: (values.accountId as number | null) ?? null,
              frequency: (values.frequency as RecurFrequency) ?? 'monthly',
              nextRun: String(values.nextRun ?? ''),
              enabled: values.enabled === true,
              note: String(values.note ?? '')
            })
            setRecurringDraft(null)
            props.onChanged()
          } finally {
            setBusy(false)
          }
        }}
      />

      <EntityForm
        open={debtDraft !== null}
        title={debtDraft?.id ? t('personal-ledger.common.edit') : t('personal-ledger.page.addDebt')}
        fields={debtFields}
        values={debtDraft ?? {}}
        saving={busy}
        onCancel={() => setDebtDraft(null)}
        onSubmit={async (values) => {
          if (!String(values.counterparty ?? '').trim()) return
          setBusy(true)
          try {
            await api.saveDebt({
              id: values.id as number | undefined,
              direction: values.direction === 'borrow' ? 'borrow' : 'lend',
              counterparty: String(values.counterparty),
              amount: Number(values.amount ?? 0),
              settled: Number(values.settled ?? 0),
              dueDate: String(values.dueDate ?? ''),
              note: String(values.note ?? '')
            })
            setDebtDraft(null)
            props.onChanged()
          } finally {
            setBusy(false)
          }
        }}
      />

      <EntityForm
        open={settle !== null}
        title={`${t('personal-ledger.common.settle')}：${settle?.counterparty ?? ''}`}
        fields={[
          {
            key: 'amount',
            label: t('personal-ledger.plans.settleAmount'),
            type: 'number',
            step: 100,
            min: 0
          },
          { key: 'accountId', label: t('personal-ledger.transactions.account'), type: 'select', options: accountOptions }
        ]}
        values={{ amount: settle ? settle.amount - settle.settled : 0, accountId: null }}
        saving={busy}
        onCancel={() => setSettle(null)}
        onSubmit={async (values) => {
          if (!settle) return
          setBusy(true)
          try {
            await api.settleDebt(settle.id, Number(values.amount ?? 0), (values.accountId as number | null) ?? null)
            setSettle(null)
            props.onChanged()
          } finally {
            setBusy(false)
          }
        }}
      />

      <EntityForm
        open={depositDraft !== null}
        title={depositDraft?.id ? t('personal-ledger.common.edit') : t('personal-ledger.page.addDeposit')}
        fields={depositFields}
        values={depositDraft ?? {}}
        saving={busy}
        onCancel={() => setDepositDraft(null)}
        onSubmit={async (values) => {
          if (!String(values.name ?? '').trim()) return
          setBusy(true)
          try {
            await api.saveDeposit({
              id: values.id as number | undefined,
              name: String(values.name),
              accountId: (values.accountId as number | null) ?? null,
              principal: Number(values.principal ?? 0),
              rate: Number(values.rate ?? 0),
              startDate: String(values.startDate ?? ''),
              maturityDate: String(values.maturityDate ?? ''),
              note: String(values.note ?? '')
            })
            setDepositDraft(null)
            props.onChanged()
          } finally {
            setBusy(false)
          }
        }}
      />
    </div>
  )
}
