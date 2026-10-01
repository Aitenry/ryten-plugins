import { useMemo, useState } from 'react'
import { App, Button, Space, Tag as AntTag, Tooltip } from 'antd'
import { RiAddLine, RiDeleteBin6Line, RiEditLine, RiScalesLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { AccountSummary, AccountType, LedgerState } from '../../shared/types'
import api from '../api'
import { currencyOptions } from '../currencies'
import { useLedgerPalette } from '../palette'
import AccountTypePicker from './AccountTypePicker'
import CategoryTree from './CategoryTree'
import { buildCategoryTreeOptions } from './categoryTreeModel'
import EntityForm, { type FieldSpec } from './EntityForm'
import { FitList, FitTable, Panel, money } from './ui'

/**
 * 账户页：账户余额 / 负债 / 对账 + 分类、标签、商家的维护入口。
 *
 * 高度策略：账户表吃掉大部分高度（按高度分页），下面三个维护面板各占一栏——
 * 标签 / 商家用 FitList 按高度截断，分类那栏是**树**、显示全部分类并让面板内部自己滚
 * （用户反馈：分类不要「还有 N 项」，要看全）。整页仍然不出滚动条。
 *
 * 余额永远是**流水算出来的**（不让用户手改余额）：对账的差额会被记成一笔
 * 「余额调整」流水（adjust=true），既留痕又不进收支统计——这是记账软件最容易做错的一处。
 */
export default function AccountsTab(props: {
  state: LedgerState
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const p = useLedgerPalette()
  const [accountDraft, setAccountDraft] = useState<Record<string, unknown> | null>(null)
  const [reconcile, setReconcile] = useState<AccountSummary | null>(null)
  const [reconcileValue, setReconcileValue] = useState<number>(0)
  const [categoryDraft, setCategoryDraft] = useState<Record<string, unknown> | null>(null)
  const [tagDraft, setTagDraft] = useState<Record<string, unknown> | null>(null)
  const [merchantDraft, setMerchantDraft] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState(false)
  const currency = props.state.settings.baseCurrency

  /** 账户余额合计（含负债账户，负数就是欠款）——只做展示，口径来自同一个 mapper */
  const totalBalance = useMemo(
    () => props.state.accounts.reduce((sum, account) => sum + account.balance, 0),
    [props.state.accounts]
  )

  /** 币种下拉：基准币种 + 汇率表里的币种 + 常见币种（去重；原来是个自由文本框） */
  const currencyChoices = useMemo(
    () =>
      currencyOptions([props.state.settings.baseCurrency, ...Object.keys(props.state.settings.rates ?? {})]),
    [props.state.settings.baseCurrency, props.state.settings.rates]
  )

  /** 账单日 / 还款日下拉：0 = 未设置（原来是个 0~31 的数字框，得自己记住范围） */
  const dayOptions = useMemo(
    () =>
      Array.from({ length: 32 }, (_, day) => ({
        value: day,
        label: day === 0 ? t('personal-ledger.common.none') : t('personal-ledger.accounts.daySuffix', { day })
      })),
    [t]
  )

  /**
   * 账户表单的字段**由当前选中的类型推导**（EntityForm 的 `fields` 收一个 `(draft) => FieldSpec[]`）。
   *
   * 用户反馈：「新建账户要按类型来构建表单」——原先把 10 个字段一次性铺给所有人，
   * 建一个「现金」账户也要面对信用额度 / 账单日 / 还款日，既长又不像在「建账户」。
   * 现在：
   *   - 只有 `credit`（信用卡 / 花呗）才出**额度 / 账单日 / 还款日**；
   *   - 「期初余额」的文案随类型变（现金=期初现金、信用卡 / 负债=期初欠款、投资=初始投入）；
   *   - 金额字段带**币种前缀**（`addonBefore` 取当前草稿的币种，改了币种前缀跟着变）；
   *   - 币种从文本框改成**下拉**（基准币种 + 汇率表 + 常见币种），账单日 / 还款日从
   *     「0~31 的数字框」改成**下拉**（0 显示「（无）」）——这两处原来是最「简陋」的地方。
   * 类型选择卡放在正文顶部（`header` 槽），见 `AccountTypePicker`。
   */
  const accountFields = useMemo(
    () =>
      (draft: Record<string, unknown>): FieldSpec[] => {
        const type = (draft.type as AccountType) ?? 'cash'
        const code = String(draft.currency ?? currency)
        const fields: FieldSpec[] = [
          { key: 'name', label: t('personal-ledger.accounts.name'), type: 'text', width: 220 },
          {
            key: 'currency',
            label: t('personal-ledger.accounts.currency'),
            type: 'select',
            width: 130,
            options: currencyChoices
          },
          {
            key: 'initialBalance',
            label: t(`personal-ledger.accounts.initialBalanceByType.${type}`),
            type: 'number',
            width: 190,
            step: 100,
            addonBefore: code
          }
        ]
        if (type === 'credit') {
          fields.push(
            {
              key: 'creditLimit',
              label: t('personal-ledger.accounts.creditLimit'),
              type: 'number',
              width: 190,
              step: 1000,
              min: 0,
              addonBefore: code
            },
            {
              key: 'billDay',
              label: t('personal-ledger.accounts.billDay'),
              type: 'select',
              width: 120,
              options: dayOptions
            },
            {
              key: 'repayDay',
              label: t('personal-ledger.accounts.repayDay'),
              type: 'select',
              width: 120,
              options: dayOptions
            }
          )
        }
        fields.push(
          {
            key: 'includeInNetWorth',
            label: t('personal-ledger.accounts.includeInNetWorth'),
            type: 'switch'
          },
          { key: 'hidden', label: t('personal-ledger.accounts.hidden'), type: 'switch' },
          { key: 'note', label: t('personal-ledger.accounts.note'), type: 'textarea' }
        )
        return fields
      },
    [t, currency, currencyChoices, dayOptions]
  )

  const categoryFields = (draft: Record<string, unknown>): FieldSpec[] => [
    { key: 'name', label: t('personal-ledger.categories.name'), type: 'text' },
    {
      key: 'kind',
      label: t('personal-ledger.categories.kind'),
      type: 'select',
      options: [
        { value: 'expense', label: t('personal-ledger.kinds.expense') },
        { value: 'income', label: t('personal-ledger.kinds.income') }
      ]
    },
    {
      key: 'parentId',
      label: t('personal-ledger.categories.parent'),
      type: 'treeSelect',
      // 比普通下拉略宽：下拉框里要显示缩进后的层级，太窄连「餐饮 / 外卖」都显示不全
      width: 200,
      // 排除自己与整棵子树：否则能把「餐饮」的上级改成它自己的下级，分类表里出现环，
      // 环上的分类在树里再也画不出来（看着像凭空消失）
      treeData: buildCategoryTreeOptions(props.state.categories, (draft.id as number | undefined) ?? null)
    },
    { key: 'icon', label: t('personal-ledger.categories.icon'), type: 'text', placeholder: 'RiWalletLine' },
    { key: 'color', label: t('personal-ledger.categories.color'), type: 'text', placeholder: '#8b5cf6' },
    { key: 'hidden', label: t('personal-ledger.categories.hidden'), type: 'switch' }
  ]

  const tagFields: FieldSpec[] = [
    { key: 'name', label: t('personal-ledger.categories.tags'), type: 'text' },
    { key: 'color', label: t('personal-ledger.categories.color'), type: 'text', placeholder: '#60a5fa' }
  ]

  const merchantFields: FieldSpec[] = [
    { key: 'name', label: t('personal-ledger.categories.merchants'), type: 'text' },
    {
      key: 'categoryId',
      label: t('personal-ledger.transactions.category'),
      type: 'select',
      options: props.state.categories.map((category) => ({ value: category.id, label: category.name }))
    },
    { key: 'note', label: t('personal-ledger.transactions.note'), type: 'text' }
  ]

  const saveAccount = async (values: Record<string, unknown>): Promise<void> => {
    if (!String(values.name ?? '').trim()) return
    setBusy(true)
    try {
      await api.saveAccount({
        id: values.id as number | undefined,
        name: String(values.name),
        type: values.type as AccountType,
        currency: String(values.currency ?? currency),
        initialBalance: Number(values.initialBalance ?? 0),
        creditLimit: Number(values.creditLimit ?? 0),
        billDay: Number(values.billDay ?? 0),
        repayDay: Number(values.repayDay ?? 0),
        includeInNetWorth: values.includeInNetWorth === true,
        hidden: values.hidden === true,
        note: String(values.note ?? '')
      })
      setAccountDraft(null)
      props.onChanged()
    } finally {
      setBusy(false)
    }
  }

  /**
   * 分类 / 标签 / 商家三栏共用的行样式。
   *
   * 悬停底色用**中性灰半透明**（而不是写死的浅色 `#fafafa`）：半透明叠在主题底色上，
   * 亮色与暗色都恰好「亮一点/暗一点」，不用为主题各写一份（配色见 palette.ts）。
   */
  const rowClass = 'flex items-center gap-3 rounded px-1 py-[3px] hover:bg-[rgba(128,128,128,0.12)]'

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Panel
        className="flex min-h-0 flex-[1.2] flex-col"
        title={t('personal-ledger.page.tabs.accounts')}
        extra={
          <Space size={8}>
            <span className="text-xs opacity-70">
              {t('personal-ledger.common.total')} {money(totalBalance)} {currency}
            </span>
            <Button
              size="small"
              type="primary"
              icon={<RiAddLine size={14} />}
              onClick={() =>
                setAccountDraft({
                  name: '',
                  type: 'cash',
                  currency,
                  initialBalance: 0,
                  creditLimit: 0,
                  billDay: 0,
                  repayDay: 0,
                  includeInNetWorth: true,
                  hidden: false,
                  note: ''
                })
              }
            >
              {t('personal-ledger.page.addAccount')}
            </Button>
          </Space>
        }
      >
        <FitTable<AccountSummary>
          table={{
            rowKey: 'id',
            dataSource: props.state.accounts,
            locale: { emptyText: t('personal-ledger.accounts.empty') },
            columns: [
              {
                title: t('personal-ledger.accounts.name'),
                dataIndex: 'name',
                ellipsis: true,
                render: (value: string, row: AccountSummary) => (
                  <span className="flex items-center gap-3">
                    <span className="truncate">{value}</span>
                    {row.hidden ? <AntTag variant="filled">{t('personal-ledger.accounts.hiddenBadge')}</AntTag> : null}
                  </span>
                )
              },
              {
                title: t('personal-ledger.accounts.type'),
                dataIndex: 'type',
                width: 96,
                render: (value: AccountType) => t(`personal-ledger.accountTypes.${value}`)
              },
              {
                title: t('personal-ledger.accounts.balance'),
                dataIndex: 'balance',
                width: 140,
                sorter: (a, b) => a.balance - b.balance,
                render: (value: number, row: AccountSummary) => (
                  <span className="font-medium tabular-nums" style={{ color: value < 0 ? p.down : undefined }}>
                    {money(value)} {row.currency}
                  </span>
                )
              },
              {
                title: t('personal-ledger.accounts.inflow'),
                dataIndex: 'inflow',
                width: 110,
                render: (value: number) => (
                  <span className="tabular-nums" style={{ color: p.up }}>{money(value)}</span>
                )
              },
              {
                title: t('personal-ledger.accounts.outflow'),
                dataIndex: 'outflow',
                width: 110,
                render: (value: number) => (
                  <span className="tabular-nums" style={{ color: p.expense }}>{money(value)}</span>
                )
              },
              { title: t('personal-ledger.accounts.txCount'), dataIndex: 'txCount', width: 84, align: 'right' },
              {
                title: t('personal-ledger.common.actions'),
                key: 'actions',
                width: 96,
                render: (_value, row: AccountSummary) => (
                  <Space size={2}>
                    <Tooltip title={t('personal-ledger.common.edit')}>
                      <Button
                        size="small"
                        type="text"
                        aria-label={t('personal-ledger.common.edit')}
                        icon={<RiEditLine size={14} />}
                        onClick={() => setAccountDraft({ ...row, id: row.id })}
                      />
                    </Tooltip>
                    <Tooltip title={t('personal-ledger.accounts.reconcile')}>
                      <Button
                        size="small"
                        type="text"
                        icon={<RiScalesLine size={14} />}
                        onClick={() => {
                          setReconcile(row)
                          setReconcileValue(row.balance)
                        }}
                      />
                    </Tooltip>
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<RiDeleteBin6Line size={14} />}
                      onClick={() => {
                        void api.removeAccount(row.id).then(() => props.onChanged())
                      }}
                    />
                  </Space>
                )
              }
            ]
          }}
        />
      </Panel>

      <div className="grid min-h-0 flex-1 grid-cols-3 grid-rows-1 gap-3">
        <Panel
          className="flex min-h-0 flex-col"
          title={t('personal-ledger.categories.manage')}
          extra={
            <Button
              size="small"
              icon={<RiAddLine size={14} />}
              onClick={() =>
                setCategoryDraft({ name: '', kind: 'expense', parentId: null, icon: '', color: '#8b5cf6', hidden: false })
              }
            >
              {t('personal-ledger.page.addCategory')}
            </Button>
          }
        >
          <CategoryTree
            categories={props.state.categories}
            onEdit={(category) => setCategoryDraft({ ...category, id: category.id })}
            onDelete={(category) => void api.removeCategory(category.id).then(() => props.onChanged())}
          />
        </Panel>

        <Panel
          className="flex min-h-0 flex-col"
          title={t('personal-ledger.categories.tags')}
          extra={
            <Button
              size="small"
              icon={<RiAddLine size={14} />}
              onClick={() => setTagDraft({ name: '', color: '#60a5fa' })}
            >
              {t('personal-ledger.page.addTag')}
            </Button>
          }
        >
          <FitList
            items={props.state.tags}
            rowHeight={34}
            keyOf={(tag) => tag.id}
            moreLabel={(count) => t('personal-ledger.common.more', { count })}
            renderItem={(tag) => (
              <div className={rowClass}>
                <span
                  className="inline-block h-[8px] w-[8px] shrink-0 rounded-full"
                  style={{ backgroundColor: tag.color }}
                />
                <span className="min-w-0 flex-1 truncate text-xs">{tag.name}</span>
                <Tooltip title={t('personal-ledger.common.edit')}>
                  <Button
                    size="small"
                    type="text"
                    aria-label={t('personal-ledger.common.edit')}
                    icon={<RiEditLine size={13} />}
                    onClick={() => setTagDraft({ ...tag, id: tag.id })}
                  />
                </Tooltip>
                <Button
                  size="small"
                  type="text"
                  danger
                  icon={<RiDeleteBin6Line size={12} />}
                  onClick={() => void api.removeTag(tag.id).then(() => props.onChanged())}
                />
              </div>
            )}
          />
        </Panel>

        <Panel
          className="flex min-h-0 flex-col"
          title={t('personal-ledger.categories.merchants')}
          extra={
            <Button
              size="small"
              icon={<RiAddLine size={14} />}
              onClick={() => setMerchantDraft({ name: '', categoryId: null, note: '' })}
            >
              {t('personal-ledger.page.addMerchant')}
            </Button>
          }
        >
          <FitList
            items={props.state.merchants}
            rowHeight={34}
            keyOf={(merchant) => merchant.id}
            moreLabel={(count) => t('personal-ledger.common.more', { count })}
            renderItem={(merchant) => (
              <div className={rowClass}>
                <span className="min-w-0 flex-1 truncate text-xs">{merchant.name}</span>
                <Tooltip title={t('personal-ledger.common.edit')}>
                  <Button
                    size="small"
                    type="text"
                    aria-label={t('personal-ledger.common.edit')}
                    icon={<RiEditLine size={13} />}
                    onClick={() => setMerchantDraft({ ...merchant, id: merchant.id })}
                  />
                </Tooltip>
                <Button
                  size="small"
                  type="text"
                  danger
                  icon={<RiDeleteBin6Line size={12} />}
                  onClick={() => void api.removeMerchant(merchant.id).then(() => props.onChanged())}
                />
              </div>
            )}
          />
        </Panel>
      </div>

      <EntityForm
        open={accountDraft !== null}
        title={accountDraft?.id ? t('personal-ledger.common.edit') : t('personal-ledger.page.addAccount')}
        fields={accountFields}
        values={accountDraft ?? {}}
        saving={busy}
        header={(draft, set) => (
          <AccountTypePicker
            value={(draft.type as AccountType) ?? 'cash'}
            onChange={(type) => {
              set('type', type)
              // 新建时按类型给「默认值」（虚拟账户默认不计入净资产）；编辑时不动用户已有的设置
              if (!draft.id) set('includeInNetWorth', type !== 'virtual')
            }}
          />
        )}
        onCancel={() => setAccountDraft(null)}
        onSubmit={(values) => void saveAccount(values)}
      />

      <EntityForm
        open={categoryDraft !== null}
        title={categoryDraft?.id ? t('personal-ledger.common.edit') : t('personal-ledger.page.addCategory')}
        fields={categoryFields}
        values={categoryDraft ?? {}}
        saving={busy}
        onCancel={() => setCategoryDraft(null)}
        onSubmit={async (values) => {
          if (!String(values.name ?? '').trim()) return
          setBusy(true)
          try {
            await api.saveCategory({
              id: values.id as number | undefined,
              name: String(values.name),
              kind: values.kind === 'income' ? 'income' : 'expense',
              parentId: (values.parentId as number | null) ?? null,
              icon: String(values.icon ?? ''),
              color: String(values.color ?? '#8b5cf6'),
              hidden: values.hidden === true
            })
            setCategoryDraft(null)
            props.onChanged()
          } finally {
            setBusy(false)
          }
        }}
      />

      <EntityForm
        open={tagDraft !== null}
        title={tagDraft?.id ? t('personal-ledger.common.edit') : t('personal-ledger.page.addTag')}
        fields={tagFields}
        values={tagDraft ?? {}}
        saving={busy}
        onCancel={() => setTagDraft(null)}
        onSubmit={async (values) => {
          if (!String(values.name ?? '').trim()) return
          setBusy(true)
          try {
            await api.saveTag({
              id: values.id as number | undefined,
              name: String(values.name),
              color: String(values.color ?? '#60a5fa')
            })
            setTagDraft(null)
            props.onChanged()
          } finally {
            setBusy(false)
          }
        }}
      />

      <EntityForm
        open={merchantDraft !== null}
        title={merchantDraft?.id ? t('personal-ledger.common.edit') : t('personal-ledger.page.addMerchant')}
        fields={merchantFields}
        values={merchantDraft ?? {}}
        saving={busy}
        onCancel={() => setMerchantDraft(null)}
        onSubmit={async (values) => {
          if (!String(values.name ?? '').trim()) return
          setBusy(true)
          try {
            await api.saveMerchant({
              id: values.id as number | undefined,
              name: String(values.name),
              categoryId: (values.categoryId as number | null) ?? null,
              note: String(values.note ?? '')
            })
            setMerchantDraft(null)
            props.onChanged()
          } finally {
            setBusy(false)
          }
        }}
      />

      {/* 对账：只填「实际余额」，差额由主进程记成余额调整流水 */}
      <EntityForm
        open={reconcile !== null}
        title={`${t('personal-ledger.accounts.reconcileTitle')}：${reconcile?.name ?? ''}`}
        fields={[
          {
            key: 'actualBalance',
            label: t('personal-ledger.accounts.actualBalance'),
            type: 'number',
            step: 0.01,
            placeholder: t('personal-ledger.accounts.reconcileHint')
          }
        ]}
        values={{ actualBalance: reconcileValue }}
        saving={busy}
        onCancel={() => setReconcile(null)}
        onSubmit={async (values) => {
          if (!reconcile) return
          const actual = Number(values.actualBalance)
          if (!Number.isFinite(actual)) return
          setBusy(true)
          try {
            const created = await api.reconcileAccount(reconcile.id, actual)
            message.success(
              created ? t('personal-ledger.accounts.reconcileDone') : t('personal-ledger.accounts.reconcileNone')
            )
            setReconcile(null)
            props.onChanged()
          } finally {
            setBusy(false)
          }
        }}
      />
    </div>
  )
}
