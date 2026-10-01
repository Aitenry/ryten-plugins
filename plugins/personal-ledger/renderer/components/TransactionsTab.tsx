import { useEffect, useMemo, useState } from 'react'
import { Button, DatePicker, Input, InputNumber, Select, Space, Tag as AntTag, Tooltip } from 'antd'
import { RiAddLine, RiDeleteBin6Line, RiFileCopyLine, RiRefreshLine } from '@remixicon/react'
import dayjs from 'dayjs'
import { useTranslation } from '@host/renderer/i18n'
import type { LedgerState, Transaction, TransactionFilter, TxKind } from '../../shared/types'
import api from '../api'
import { useLedgerPalette } from '../palette'
import { FitTable, Panel } from './ui'

/**
 * 明细页：多条件筛选 + 排序 + 批量删除 + 复制（「再来一单」）。
 *
 * 高度策略：筛选条固定在顶部（它是「输入区」，不该被挤），表格吃掉剩下的高度并
 * **按可用高度决定每页几行**——所以翻页而不是滚动，整页不会出现滚动条。
 *
 * 查询条件直接喂给主进程的 `transactions-query`（过滤在主进程做，页面只拿结果），
 * 因此全局搜索（备注 / 商家 / 分类 / 金额 / 标签 / 日期）与关键词口径只有一份。
 */
export default function TransactionsTab(props: {
  state: LedgerState
  refreshToken: number
  /** 传 null = 新建 */
  onEdit: (transaction: Transaction | null) => void
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const p = useLedgerPalette()
  const [items, setItems] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<number[]>([])
  const [keyword, setKeyword] = useState('')
  const [kind, setKind] = useState<TxKind | undefined>(undefined)
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined)
  const [accountId, setAccountId] = useState<number | undefined>(undefined)
  const [tag, setTag] = useState<string | undefined>(undefined)
  const [member, setMember] = useState<string | undefined>(undefined)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [minAmount, setMinAmount] = useState<number | null>(null)
  const [maxAmount, setMaxAmount] = useState<number | null>(null)

  const filter: TransactionFilter = useMemo(
    () => ({
      keyword: keyword.trim() || undefined,
      kind,
      categoryId,
      accountId,
      tag,
      member,
      from: from || undefined,
      to: to || undefined,
      minAmount: minAmount ?? undefined,
      maxAmount: maxAmount ?? undefined
    }),
    [keyword, kind, categoryId, accountId, tag, member, from, to, minAmount, maxAmount]
  )

  useEffect(() => {
    let alive = true
    setLoading(true)
    void api
      .queryTransactions(filter)
      .then((rows) => {
        if (alive) setItems(rows ?? [])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [filter, props.refreshToken])

  const categoryName = (id: number | null): string =>
    id ? props.state.categories.find((category) => category.id === id)?.name ?? '' : ''
  const accountName = (id: number | null): string =>
    id ? props.state.accounts.find((account) => account.id === id)?.name ?? '' : ''
  const merchantName = (id: number | null): string =>
    id ? props.state.merchants.find((merchant) => merchant.id === id)?.name ?? '' : ''

  const reset = (): void => {
    setKeyword('')
    setKind(undefined)
    setCategoryId(undefined)
    setAccountId(undefined)
    setTag(undefined)
    setMember(undefined)
    setFrom('')
    setTo('')
    setMinAmount(null)
    setMaxAmount(null)
  }

  const removeSelected = async (): Promise<void> => {
    if (selected.length === 0) return
    await api.removeTransactions(selected, true)
    setSelected([])
    props.onChanged()
  }

  const field = 'w-full'

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 筛选区：两行放下，宽度靠栅格自适应 */}
      <Panel
        className="shrink-0"
        title={t('personal-ledger.common.search')}
        extra={
          <Space size={4}>
            {selected.length > 0 ? (
              <>
                <span className="text-xs opacity-70">
                  {t('personal-ledger.transactions.selected', { count: selected.length })}
                </span>
                <Button
                  size="small"
                  danger
                  icon={<RiDeleteBin6Line size={14} />}
                  onClick={() => void removeSelected()}
                >
                  {t('personal-ledger.transactions.deleteSelected')}
                </Button>
              </>
            ) : null}
            <Button size="small" icon={<RiRefreshLine size={14} />} onClick={reset}>
              {t('personal-ledger.common.reset')}
            </Button>
            <Button
              size="small"
              type="primary"
              icon={<RiAddLine size={14} />}
              onClick={() => props.onEdit(null)}
            >
              {t('personal-ledger.page.addTransaction')}
            </Button>
          </Space>
        }
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Input.Search
            allowClear
            className={field}
            value={keyword}
            placeholder={t('personal-ledger.transactions.searchPlaceholder')}
            onChange={(event) => setKeyword(event.target.value)}
          />
          <Select
            allowClear
            className={field}
            value={kind}
            placeholder={t('personal-ledger.transactions.kind')}
            options={[
              { value: 'expense', label: t('personal-ledger.kinds.expense') },
              { value: 'income', label: t('personal-ledger.kinds.income') },
              { value: 'transfer', label: t('personal-ledger.kinds.transfer') }
            ]}
            onChange={(value) => setKind(value as TxKind | undefined)}
          />
          <Select
            allowClear
            className={field}
            value={categoryId}
            placeholder={t('personal-ledger.transactions.category')}
            options={props.state.categories.map((category) => ({ value: category.id, label: category.name }))}
            onChange={(value) => setCategoryId(value as number | undefined)}
          />
          <Select
            allowClear
            className={field}
            value={accountId}
            placeholder={t('personal-ledger.transactions.account')}
            options={props.state.accounts.map((account) => ({ value: account.id, label: account.name }))}
            onChange={(value) => setAccountId(value as number | undefined)}
          />
          <Select
            allowClear
            className={field}
            value={tag}
            placeholder={t('personal-ledger.transactions.tags')}
            options={props.state.tags.map((item) => ({ value: item.name, label: item.name }))}
            onChange={(value) => setTag(value as string | undefined)}
          />
          {props.state.settings.members.length > 0 ? (
            <Select
              allowClear
              className={field}
              value={member}
              placeholder={t('personal-ledger.transactions.member')}
              options={props.state.settings.members.map((name) => ({ value: name, label: name }))}
              onChange={(value) => setMember(value as string | undefined)}
            />
          ) : (
            <span />
          )}
        </div>

        <div className="mt-2 grid grid-cols-2 items-center gap-3 md:grid-cols-4 xl:grid-cols-6">
          <DatePicker
            className="w-full"
            value={from ? dayjs(from) : null}
            placeholder="from"
            onChange={(value) => setFrom(value ? value.format('YYYY-MM-DD') : '')}
          />
          <DatePicker
            className="w-full"
            value={to ? dayjs(to) : null}
            placeholder="to"
            onChange={(value) => setTo(value ? value.format('YYYY-MM-DD') : '')}
          />
          <InputNumber
            className="w-full"
            value={minAmount}
            min={0}
            placeholder="min"
            onChange={(value) => setMinAmount(value === null ? null : Number(value))}
          />
          <InputNumber
            className="w-full"
            value={maxAmount}
            min={0}
            placeholder="max"
            onChange={(value) => setMaxAmount(value === null ? null : Number(value))}
          />
          <span className="text-xs opacity-60 xl:col-span-2 xl:text-right">
            {t('personal-ledger.transactions.count', { count: items.length })}
          </span>
        </div>
      </Panel>

      {/* 表格：填满剩余高度，行数按高度算（翻页替代滚动） */}
      <Panel className="flex min-h-0 flex-1 flex-col">
        <FitTable<Transaction>
          table={{
            rowKey: 'id',
            loading,
            dataSource: items,
            locale: { emptyText: t('personal-ledger.transactions.empty') },
            rowClassName: 'cursor-pointer',
            rowSelection: {
              selectedRowKeys: selected,
              onChange: (keys) => setSelected(keys.map((key) => Number(key)))
            },
            onRow: (record) => ({ onDoubleClick: () => props.onEdit(record) }),
            columns: [
              { title: t('personal-ledger.transactions.date'), dataIndex: 'date', width: 96 },
              {
                title: t('personal-ledger.transactions.kind'),
                dataIndex: 'kind',
                width: 74,
                filters: [
                  { text: t('personal-ledger.kinds.expense'), value: 'expense' },
                  { text: t('personal-ledger.kinds.income'), value: 'income' },
                  { text: t('personal-ledger.kinds.transfer'), value: 'transfer' }
                ],
                onFilter: (value, row) => row.kind === String(value),
                render: (value: Transaction['kind']) => t(`personal-ledger.kinds.${value}`)
              },
              {
                title: t('personal-ledger.transactions.amount'),
                dataIndex: 'amount',
                width: 132,
                sorter: (a, b) => a.amount - b.amount,
                render: (value: number, row: Transaction) => (
                  <span
                    className="tabular-nums"
                    style={{
                      color: row.kind === 'income' ? p.up : row.kind === 'expense' ? p.down : undefined
                    }}
                  >
                    {value.toFixed(2)} {row.currency}
                  </span>
                )
              },
              {
                title: t('personal-ledger.transactions.category'),
                dataIndex: 'categoryId',
                width: 110,
                ellipsis: true,
                render: (value: number | null) =>
                  categoryName(value) || t('personal-ledger.transactions.uncategorized')
              },
              {
                title: t('personal-ledger.transactions.account'),
                dataIndex: 'accountId',
                width: 130,
                ellipsis: true,
                render: (value: number | null, row: Transaction) =>
                  row.kind === 'transfer'
                    ? `${accountName(value)} → ${accountName(row.toAccountId)}`
                    : accountName(value)
              },
              {
                title: t('personal-ledger.transactions.merchant'),
                dataIndex: 'merchantId',
                width: 110,
                ellipsis: true,
                render: (value: number | null) => merchantName(value)
              },
              {
                title: t('personal-ledger.transactions.tags'),
                dataIndex: 'tags',
                width: 140,
                render: (value: string[]) => (
                  <span className="flex flex-wrap gap-1">
                    {value.slice(0, 2).map((item) => (
                      <AntTag key={item} variant="filled">
                        {item}
                      </AntTag>
                    ))}
                    {value.length > 2 ? <span className="text-xs opacity-50">+{value.length - 2}</span> : null}
                    {value.length === 0 ? <span className="opacity-40">-</span> : null}
                  </span>
                )
              },
              {
                title: t('personal-ledger.transactions.note'),
                dataIndex: 'note',
                ellipsis: true,
                render: (value: string, row: Transaction) => (
                  <span className="flex items-center gap-1">
                    {row.refundOfId ? (
                      <AntTag color="green" variant="filled">
                        {t('personal-ledger.transactions.refundTag')}
                      </AntTag>
                    ) : null}
                    {row.adjust ? (
                      <AntTag variant="filled">{t('personal-ledger.transactions.adjustTag')}</AntTag>
                    ) : null}
                    {row.installmentTotal > 1 ? (
                      <AntTag color="blue" variant="filled">
                        {t('personal-ledger.transactions.installmentTag', {
                          index: row.installmentIndex,
                          total: row.installmentTotal
                        })}
                      </AntTag>
                    ) : null}
                    <span className="truncate">{value}</span>
                  </span>
                )
              },
              {
                title: t('personal-ledger.common.actions'),
                key: 'actions',
                width: 118,
                render: (_value, row: Transaction) => (
                  <Space size={2}>
                    <Button size="small" type="text" onClick={() => props.onEdit(row)}>
                      {t('personal-ledger.common.edit')}
                    </Button>
                    <Tooltip title={t('personal-ledger.common.copy')}>
                      <Button
                        size="small"
                        type="text"
                        icon={<RiFileCopyLine size={14} />}
                        onClick={async () => {
                          await api.copyTransaction(row.id)
                          props.onChanged()
                        }}
                      />
                    </Tooltip>
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<RiDeleteBin6Line size={14} />}
                      onClick={async () => {
                        await api.removeTransaction(row.id)
                        props.onChanged()
                      }}
                    />
                  </Space>
                )
              }
            ]
          }}
        />
      </Panel>
    </div>
  )
}
