import { useEffect, useMemo, useState } from 'react'
import { DatePicker, Input, InputNumber, Modal, Select, TreeSelect } from 'antd'
import dayjs from 'dayjs'
import { useTranslation } from '@host/renderer/i18n'
import {
  FIELD_WIDTH,
  FORM_CONTENT_WIDTH,
  FORM_GAP,
  FormBody,
  FormField,
  FormRow,
  FormSwitch,
  formModalWidth,
  useFormModalProps,
  useThinScrollbar
} from './form'

/**
 * 通用实体表单（账户 / 分类 / 标签 / 预算 / 目标 / 周期账 / 借还 / 存款共用）。
 *
 * 为什么做成「按 schema 渲染」：这八种实体的字段都是「文本 / 数字 / 下拉 / 树形下拉 / 日期 /
 * 开关 / 多行文本」，各写一个弹窗等于把同一段布局抄八遍；提取成一份之后，改样式只改这里。
 * 校验一律由调用方在 onSubmit 里做（主进程 mapper 也会再兜一层）。
 *
 * **排版与「记一笔」共用 `components/form.tsx` 的原语**（用户反馈：实体表单原来是
 * 「标签在上、控件铺满整宽、一个字段一行」的一列大排面，跟记一笔不像同一个插件，而且太占高度）：
 *   - 字段按宽度**贪心折行**（宽 200 / 180 / 150），一行两三个，行距 12px；
 *   - 弹窗宽度、头脚布局、按钮文案（保存 / 取消）与记一笔一致；
 *   - 开关走 `FormSwitch` 的定宽行——不会被列方向 flex 拉满整宽（「开关被撑开」）；
 *   - 高度上限与细滚动条走 `useFormModalProps()` / `useThinScrollbar()`：
 *     字段多了正文自己滚（「账户」10 个字段），滚动条是细的那一版。
 *
 * 字段清单除了**常量数组**，还可以给一个 **`(draft) => FieldSpec[]`** 的函数（`header` 槽同理）：
 * 「新建账户」就是典型——先让用户选类型（`AccountTypePicker` 走 `header`），再按类型出字段，
 * 而不是把 10 个字段一次性铺给所有人（选「现金」也要面对额度 / 账单日 / 还款日）。
 */
export interface FieldSpec {
  key: string
  /** 允许给 ReactNode（例如带 Tooltip 的问号，或随类型变化的文案） */
  label: React.ReactNode
  type: 'text' | 'number' | 'select' | 'treeSelect' | 'date' | 'switch' | 'textarea'
  options?: { value: string | number; label: string }[]
  /** 树形下拉（`type: 'treeSelect'`）的选项树；层级由缩进表达 */
  treeData?: TreeOption[]
  /** 树形下拉是否默认展开全部层级（默认展开：分类通常只有两三级） */
  treeDefaultExpandAll?: boolean
  placeholder?: string
  min?: number
  max?: number
  step?: number
  /** 数字字段的单位前缀（元 / % / 天） */
  addonBefore?: string
  /** 覆盖默认宽度（不常用；默认按类型取 FIELD_WIDTH） */
  width?: number
}

/** 树形下拉的一个选项：值 + 显示名 + （可选）子选项 */
export interface TreeOption {
  value: string | number
  title: string
  children?: TreeOption[]
}

/** 字段宽度：按控件类型给，0 = 整行独占 */
function widthOf(field: FieldSpec): number {
  return field.width ?? FIELD_WIDTH[field.type] ?? 200
}

/**
 * 把字段按宽度贪心排成行：一行装不下就换行，多行文本自己独占一行。
 * 纯函数、不看真实渲染尺寸——所以不会因为「量得太早/太晚」而抖。
 */
function packRows(fields: FieldSpec[]): FieldSpec[][] {
  const rows: FieldSpec[][] = []
  let row: FieldSpec[] = []
  // 已占宽度（含字段间的 12px 间距）
  let used = 0
  for (const field of fields) {
    const width = widthOf(field)
    if (width === 0) {
      if (row.length > 0) {
        rows.push(row)
        row = []
        used = 0
      }
      rows.push([field])
      continue
    }
    const need = row.length > 0 ? width + FORM_GAP : width
    if (row.length > 0 && used + need > FORM_CONTENT_WIDTH) {
      rows.push(row)
      row = [field]
      used = width
      continue
    }
    row.push(field)
    used += need
  }
  if (row.length > 0) rows.push(row)
  return rows
}

export default function EntityForm(props: {
  open: boolean
  title: string
  /**
   * 字段清单；也可以给一个**由草稿推导**的函数：`draft` 一变就重算，
   * 于是「先选类型、再按类型出字段」这种表单不用再各写一份弹窗
   * （账户表单就是靠这个：选「信用卡」才冒出额度 / 账单日 / 还款日，
   * 「期初余额」的标签也随类型变）。
   */
  fields: FieldSpec[] | ((draft: Record<string, unknown>) => FieldSpec[])
  values: Record<string, unknown>
  saving?: boolean
  /** 正文顶部的一段自定义内容（例如账户的「类型选择卡」）；拿得到草稿与 setter */
  header?: (draft: Record<string, unknown>, set: (key: string, value: unknown) => void) => React.ReactNode
  onCancel: () => void
  onSubmit: (values: Record<string, unknown>) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Record<string, unknown>>(props.values)
  const formModalProps = useFormModalProps()
  const thinScrollbar = useThinScrollbar()

  // 只在「打开」这一刻重置草稿：props.values 每次渲染都是新对象，跟着它走会把用户正在输入的内容冲掉
  useEffect(() => {
    if (props.open) setDraft(props.values)
  }, [props.open])

  const set = (key: string, value: unknown): void => setDraft((prev) => ({ ...prev, [key]: value }))

  const fields = useMemo(
    () => (typeof props.fields === 'function' ? props.fields(draft) : props.fields),
    [props.fields, draft]
  )

  const control = (field: FieldSpec): React.ReactNode => {
    if (field.type === 'text') {
      return (
        <Input
          value={String(draft[field.key] ?? '')}
          placeholder={field.placeholder}
          onChange={(event) => set(field.key, event.target.value)}
        />
      )
    }
    if (field.type === 'textarea') {
      return (
        <Input.TextArea
          rows={2}
          style={thinScrollbar}
          value={String(draft[field.key] ?? '')}
          placeholder={field.placeholder}
          onChange={(event) => set(field.key, event.target.value)}
        />
      )
    }
    if (field.type === 'number') {
      return (
        <InputNumber
          className="w-full"
          value={Number(draft[field.key] ?? 0)}
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          addonBefore={field.addonBefore}
          onChange={(value) => set(field.key, Number(value ?? 0))}
        />
      )
    }
    if (field.type === 'select') {
      return (
        <Select
          allowClear
          className="w-full"
          value={(draft[field.key] as string | number | undefined) ?? undefined}
          placeholder={field.placeholder}
          options={field.options ?? []}
          onChange={(value) => set(field.key, value ?? null)}
        />
      )
    }
    if (field.type === 'treeSelect') {
      return (
        <TreeSelect
          allowClear
          showSearch
          className="w-full"
          value={(draft[field.key] as string | number | undefined) ?? undefined}
          placeholder={field.placeholder}
          treeData={field.treeData ?? []}
          treeDefaultExpandAll={field.treeDefaultExpandAll ?? true}
          // 搜索按显示名匹配（默认按 value，搜「餐饮」什么也搜不到）
          treeNodeFilterProp="title"
          onChange={(value) => set(field.key, value ?? null)}
        />
      )
    }
    if (field.type === 'date') {
      return (
        <DatePicker
          className="w-full"
          value={draft[field.key] ? dayjs(String(draft[field.key])) : null}
          onChange={(value) => set(field.key, value ? value.format('YYYY-MM-DD') : '')}
        />
      )
    }
    return null
  }

  return (
    <Modal
      {...formModalProps}
      open={props.open}
      width={formModalWidth(fields.length)}
      title={props.title}
      okText={t('personal-ledger.common.save')}
      cancelText={t('personal-ledger.common.cancel')}
      confirmLoading={props.saving}
      onCancel={props.onCancel}
      onOk={() => props.onSubmit(draft)}
    >
      <FormBody>
        {props.header ? props.header(draft, set) : null}
        {packRows(fields).map((row, index) => (
          <FormRow key={index}>
            {row.map((field) =>
              field.type === 'switch' ? (
                <FormSwitch
                  key={field.key}
                  label={field.label}
                  checked={draft[field.key] === true}
                  onChange={(value) => set(field.key, value)}
                />
              ) : (
                <FormField
                  key={field.key}
                  label={field.label}
                  width={field.type === 'textarea' ? '100%' : widthOf(field)}
                >
                  {control(field)}
                </FormField>
              )
            )}
          </FormRow>
        ))}
      </FormBody>
    </Modal>
  )
}
