import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  Checkbox,
  DatePicker,
  Divider,
  Input,
  InputNumber,
  Modal,
  Select,
  Tag as AntTag,
  TimePicker,
  Tooltip
} from 'antd'
import { RiAddLine, RiDeleteBin6Line } from '@remixicon/react'
import dayjs from 'dayjs'
import { useTranslation } from '@host/renderer/i18n'
import { FORM_MODAL_WIDTH, FormBody, FormRow, useFormModalProps } from './form'
import type {
  AccountSummary,
  Category,
  Merchant,
  QuickTemplate,
  Tag,
  Transaction,
  TransactionInput,
  TxKind
} from '../../shared/types'

/**
 * 记一笔 / 编辑流水的弹窗。
 *
 * 为什么拆出来：表单是整个插件**状态最多的一块**（类型、币种、组合支付、分期、AA、
 * 退款关联、模板），塞在页面里会让列表跟着一起重渲染。
 * 组件只认 props 与本插件自己的 DTO，不认识任何通道名。
 *
 * 组合支付 / 分期在提交时才会被主进程拆成多行流水（`payments` / `installmentMonths`）。
 *
 * 高度上限与正文滚动条走 `components/form.tsx`（`useFormModalProps` / `useThinScrollbar`）：
 * 这一份是插件里最高的表单之一（含组合支付时还能再长），不限制的话矮窗口下「保存」会被顶到
 * 视口外，得先滚整个弹窗才点得到。
 *
 * 这一份同时是插件表单的**排版基准**：行间距（`FormRow` 的 12px）、弹窗宽度
 * （`FORM_MODAL_WIDTH`）、按钮文案（保存 / 取消）都由 `components/form.tsx` 定，
 * 实体表单（EntityForm）用的是同一套原语——改样式只改那一个文件。
 */
export default function TransactionForm(props: {
  open: boolean
  /** 传了就是编辑，没传就是新建 */
  transaction?: Transaction | null
  accounts: AccountSummary[]
  categories: Category[]
  tags: Tag[]
  merchants: Merchant[]
  members: string[]
  baseCurrency: string
  rates: Record<string, number>
  templates: QuickTemplate[]
  /** 可以作为退款原单的支出（最近若干条） */
  refundables: Transaction[]
  saving: boolean
  onCancel: () => void
  onSubmit: (input: TransactionInput) => void
  onSaveTemplate: (name: string, input: TransactionInput) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const formModalProps = useFormModalProps()
  const [kind, setKind] = useState<TxKind>('expense')
  const [amount, setAmount] = useState<number | null>(null)
  const [date, setDate] = useState<string>(dayjs().format('YYYY-MM-DD'))
  const [time, setTime] = useState<string>(dayjs().format('HH:mm'))
  const [currency, setCurrency] = useState<string>(props.baseCurrency)
  const [rate, setRate] = useState<number>(props.rates[props.baseCurrency] ?? 1)
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [accountId, setAccountId] = useState<number | null>(null)
  const [toAccountId, setToAccountId] = useState<number | null>(null)
  const [merchantName, setMerchantName] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [member, setMember] = useState('')
  const [fee, setFee] = useState<number>(0)
  const [discount, setDiscount] = useState<number>(0)
  const [refundOfId, setRefundOfId] = useState<number | null>(null)
  const [reimburseStatus, setReimburseStatus] = useState<'none' | 'pending' | 'done'>('none')
  const [installmentMonths, setInstallmentMonths] = useState<number>(1)
  const [myShare, setMyShare] = useState<number>(0)
  const [splitMembers, setSplitMembers] = useState('')
  const [splitPayment, setSplitPayment] = useState(false)
  const [payments, setPayments] = useState<{ accountId: number | null; amount: number | null }[]>([])
  const [templateName, setTemplateName] = useState('')

  // 每次打开都用当前这条记录（或默认值）重置草稿：关掉再打开不能留着上一次的输入
  useEffect(() => {
    if (!props.open) return
    const source = props.transaction
    setKind(source?.kind ?? 'expense')
    setAmount(source ? source.amount : null)
    setDate(source?.date ?? dayjs().format('YYYY-MM-DD'))
    setTime(source?.time && source.time !== '00:00' ? source.time : dayjs().format('HH:mm'))
    setCurrency(source?.currency ?? props.baseCurrency)
    setRate(source?.rate ?? props.rates[props.baseCurrency] ?? 1)
    setCategoryId(source?.categoryId ?? null)
    setAccountId(source?.accountId ?? props.accounts[0]?.id ?? null)
    setToAccountId(source?.toAccountId ?? null)
    setMerchantName(
      source?.merchantId ? props.merchants.find((m) => m.id === source.merchantId)?.name ?? '' : ''
    )
    setSelectedTags(source?.tags ?? [])
    setNote(source?.note ?? '')
    setMember(source?.member ?? props.members[0] ?? '')
    setFee(source?.fee ?? 0)
    setDiscount(source?.discount ?? 0)
    setRefundOfId(source?.refundOfId ?? null)
    setReimburseStatus(source?.reimburseStatus ?? 'none')
    setInstallmentMonths(source?.installmentTotal && source.installmentTotal > 1 ? source.installmentTotal : 1)
    setMyShare(source?.myShare ?? 0)
    setSplitMembers(source?.splitMembers ?? '')
    setSplitPayment(false)
    setPayments([{ accountId: null, amount: null }])
    setTemplateName('')
  }, [props.open, props.transaction, props.accounts, props.merchants, props.members, props.baseCurrency, props.rates])

  const categoryOptions = useMemo(
    () =>
      props.categories
        .filter((category) => category.kind === (kind === 'income' ? 'income' : 'expense'))
        .map((category) => ({
          value: category.id,
          label: `${category.parentId ? '└ ' : ''}${category.name}`
        })),
    [props.categories, kind]
  )

  const accountOptions = useMemo(
    () => props.accounts.map((account) => ({ value: account.id, label: `${account.name}` })),
    [props.accounts]
  )

  const currencyOptions = useMemo(
    () =>
      [props.baseCurrency, ...Object.keys(props.rates)].map((code) => ({
        value: code,
        label: code
      })),
    [props.baseCurrency, props.rates]
  )

  const buildInput = (): TransactionInput => {
    const isSplit = splitPayment && kind !== 'transfer' && payments.some((p) => p.accountId && p.amount)
    return {
      id: props.transaction?.id,
      kind,
      amount: Number(amount ?? 0),
      date,
      time,
      currency,
      rate,
      categoryId: kind === 'transfer' ? null : categoryId,
      accountId: isSplit ? null : accountId,
      toAccountId: kind === 'transfer' ? toAccountId : null,
      merchantName: merchantName.trim() || undefined,
      tags: selectedTags,
      note: note.trim(),
      fee,
      discount,
      member,
      refundOfId: kind === 'income' ? refundOfId : null,
      reimburseStatus,
      installmentMonths: props.transaction ? 1 : installmentMonths,
      myShare: kind === 'expense' ? myShare : 0,
      splitMembers: kind === 'expense' ? splitMembers : '',
      payments: isSplit
        ? payments
            .filter((payment) => payment.accountId && payment.amount)
            .map((payment) => ({ accountId: Number(payment.accountId), amount: Number(payment.amount) }))
        : undefined
    }
  }

  const applyTemplate = (templateId: string): void => {
    const template = props.templates.find((item) => item.id === templateId)
    if (!template) return
    const input = template.input
    setKind(input.kind)
    setAmount(input.amount)
    setCategoryId(input.categoryId ?? null)
    setAccountId(input.accountId ?? null)
    setToAccountId(input.toAccountId ?? null)
    setNote(input.note ?? '')
    setSelectedTags(input.tags ?? [])
    setMember(input.member ?? '')
    setMerchantName(input.merchantName ?? '')
    setMyShare(input.myShare ?? 0)
  }

  const submit = (): void => {
    props.onSubmit(buildInput())
  }

  return (
    <Modal
      {...formModalProps}
      open={props.open}
      width={FORM_MODAL_WIDTH}
      title={props.transaction ? t('personal-ledger.form.editTitle') : t('personal-ledger.form.createTitle')}
      okText={t('personal-ledger.common.save')}
      cancelText={t('personal-ledger.common.cancel')}
      confirmLoading={props.saving}
      okButtonProps={{ disabled: !amount || Number(amount) <= 0 }}
      onCancel={props.onCancel}
      onOk={submit}
    >
      <FormBody>
        {props.templates.length > 0 ? (
          <Select
            allowClear
            placeholder={t('personal-ledger.form.template')}
            options={props.templates.map((item) => ({ value: item.id, label: item.name }))}
            onChange={(value) => value && applyTemplate(value as string)}
            style={{ maxWidth: 240 }}
          />
        ) : null}

        <FormRow>
          <Select
            value={kind}
            style={{ width: 120 }}
            onChange={(value) => setKind(value as TxKind)}
            options={[
              { value: 'expense', label: t('personal-ledger.kinds.expense') },
              { value: 'income', label: t('personal-ledger.kinds.income') },
              { value: 'transfer', label: t('personal-ledger.kinds.transfer') }
            ]}
          />
          <InputNumber
            value={amount}
            min={0}
            step={1}
            style={{ width: 160 }}
            placeholder={t('personal-ledger.form.amount')}
            onChange={(value) => setAmount(value === null ? null : Number(value))}
          />
          <Select
            value={currency}
            style={{ width: 96 }}
            onChange={(value) => {
              setCurrency(value as string)
              setRate(props.rates[value as string] ?? 1)
            }}
            options={currencyOptions}
          />
          {currency !== props.baseCurrency ? (
            <InputNumber
              value={rate}
              min={0}
              step={0.01}
              style={{ width: 120 }}
              addonBefore={t('personal-ledger.form.rate')}
              onChange={(value) => setRate(Number(value ?? 1))}
            />
          ) : null}
        </FormRow>

        <FormRow>
          <DatePicker
            value={dayjs(date)}
            allowClear={false}
            onChange={(value) => value && setDate(value.format('YYYY-MM-DD'))}
          />
          <TimePicker
            value={dayjs(`${date} ${time}`)}
            format="HH:mm"
            allowClear={false}
            onChange={(value) => value && setTime(value.format('HH:mm'))}
          />
          {kind !== 'transfer' ? (
            <Select
              allowClear
              value={categoryId}
              style={{ minWidth: 180 }}
              placeholder={t('personal-ledger.form.category')}
              options={categoryOptions}
              onChange={(value) => setCategoryId((value as number) ?? null)}
            />
          ) : null}
        </FormRow>

        <FormRow>
          {!splitPayment ? (
            <Select
              allowClear
              value={accountId}
              style={{ minWidth: 180 }}
              placeholder={t('personal-ledger.form.account')}
              options={accountOptions}
              onChange={(value) => setAccountId((value as number) ?? null)}
            />
          ) : null}
          {kind === 'transfer' ? (
            <Select
              allowClear
              value={toAccountId}
              style={{ minWidth: 180 }}
              placeholder={t('personal-ledger.form.toAccount')}
              options={accountOptions}
              onChange={(value) => setToAccountId((value as number) ?? null)}
            />
          ) : null}
          <Input
            value={merchantName}
            style={{ width: 200 }}
            placeholder={t('personal-ledger.form.merchant')}
            onChange={(event) => setMerchantName(event.target.value)}
          />
        </FormRow>

        <FormRow>
          <Select
            mode="tags"
            value={selectedTags}
            style={{ minWidth: 240 }}
            placeholder={t('personal-ledger.form.tags')}
            options={props.tags.map((tag) => ({ value: tag.name, label: tag.name }))}
            onChange={(value) => setSelectedTags(value as string[])}
          />
          {props.members.length > 0 ? (
            <Select
              allowClear
              value={member || undefined}
              style={{ minWidth: 140 }}
              placeholder={t('personal-ledger.form.member')}
              options={props.members.map((name) => ({ value: name, label: name }))}
              onChange={(value) => setMember((value as string) ?? '')}
            />
          ) : null}
          <Input
            value={note}
            style={{ width: 240 }}
            placeholder={t('personal-ledger.form.note')}
            onChange={(event) => setNote(event.target.value)}
          />
        </FormRow>

        <FormRow>
          <InputNumber
            value={fee}
            min={0}
            step={0.5}
            addonBefore={t('personal-ledger.form.fee')}
            onChange={(value) => setFee(Number(value ?? 0))}
          />
          <InputNumber
            value={discount}
            min={0}
            step={0.5}
            addonBefore={t('personal-ledger.form.discount')}
            onChange={(value) => setDiscount(Number(value ?? 0))}
          />
        </FormRow>

        {/* 分期 / 报销 / 退款 / AA —— 都是「一笔账的附加信息」，收在一处 */}
        <Divider style={{ margin: '4px 0' }} />
        <FormRow>
          {kind === 'expense' ? (
            <Tooltip title={t('personal-ledger.form.installmentHint')}>
              <InputNumber
                value={installmentMonths}
                min={1}
                max={60}
                disabled={Boolean(props.transaction)}
                addonBefore={t('personal-ledger.form.installmentMonths')}
                onChange={(value) => setInstallmentMonths(Math.max(1, Number(value ?? 1)))}
              />
            </Tooltip>
          ) : null}
          <Select
            value={reimburseStatus}
            style={{ width: 150 }}
            onChange={(value) => setReimburseStatus(value as 'none' | 'pending' | 'done')}
            options={[
              { value: 'none', label: t('personal-ledger.reimburse.none') },
              { value: 'pending', label: t('personal-ledger.reimburse.pending') },
              { value: 'done', label: t('personal-ledger.reimburse.done') }
            ]}
          />
          {kind === 'income' ? (
            <Select
              allowClear
              value={refundOfId}
              style={{ minWidth: 220 }}
              placeholder={t('personal-ledger.form.refundOf')}
              options={props.refundables.map((item) => ({
                value: item.id,
                label: `${item.date} ${item.amount} ${item.note || ''}`
              }))}
              onChange={(value) => setRefundOfId((value as number) ?? null)}
            />
          ) : null}
        </FormRow>

        {kind === 'expense' ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <AntTag color="purple" bordered={false}>
                {t('personal-ledger.form.splitTitle')}
              </AntTag>
              <InputNumber
                value={myShare}
                min={0}
                style={{ width: 140 }}
                addonBefore={t('personal-ledger.form.myShare')}
                onChange={(value) => setMyShare(Number(value ?? 0))}
              />
              <Input
                value={splitMembers}
                style={{ width: 220 }}
                placeholder={t('personal-ledger.form.splitMembers')}
                onChange={(event) => setSplitMembers(event.target.value)}
              />
            </div>
            <div className="flex items-center gap-3">
              <Checkbox
                checked={splitPayment}
                onChange={(event) => setSplitPayment(event.target.checked)}
              >
                {t('personal-ledger.form.paymentsTitle')}
              </Checkbox>
              {splitPayment ? (
                <Button
                  size="small"
                  type="link"
                  icon={<RiAddLine size={14} />}
                  onClick={() => setPayments((prev) => [...prev, { accountId: null, amount: null }])}
                >
                  {t('personal-ledger.form.addPayment')}
                </Button>
              ) : null}
            </div>
            {splitPayment ? (
              <div className="flex flex-col gap-3">
                {payments.map((payment, index) => (
                  <div key={index} className="flex items-center gap-3">
                    <Select
                      value={payment.accountId}
                      style={{ width: 200 }}
                      placeholder={t('personal-ledger.form.paymentAccount')}
                      options={accountOptions}
                      onChange={(value) =>
                        setPayments((prev) =>
                          prev.map((item, i) => (i === index ? { ...item, accountId: value as number } : item))
                        )
                      }
                    />
                    <InputNumber
                      value={payment.amount}
                      min={0}
                      style={{ width: 160 }}
                      placeholder={t('personal-ledger.form.paymentAmount')}
                      onChange={(value) =>
                        setPayments((prev) =>
                          prev.map((item, i) => (i === index ? { ...item, amount: Number(value ?? 0) } : item))
                        )
                      }
                    />
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<RiDeleteBin6Line size={14} />}
                      onClick={() => setPayments((prev) => prev.filter((_, i) => i !== index))}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 存为快捷模板：把「常用账单」一键变出来 */}
        <div className="flex items-center gap-3">
          <Input
            value={templateName}
            style={{ width: 200 }}
            placeholder={t('personal-ledger.form.templateName')}
            onChange={(event) => setTemplateName(event.target.value)}
          />
          <Button
            size="small"
            disabled={!templateName.trim() || !amount}
            onClick={() => {
              props.onSaveTemplate(templateName.trim(), buildInput())
              setTemplateName('')
            }}
          >
            {t('personal-ledger.form.templateSave')}
          </Button>
        </div>
      </FormBody>
    </Modal>
  )
}
