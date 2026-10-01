import { useTranslation } from '@host/renderer/i18n'
import {
  RiBankCard2Line,
  RiBankCardLine,
  RiCoupon3Line,
  RiLineChartLine,
  RiMoneyCnyCircleLine,
  RiMoneyDollarBoxLine,
  RiShieldCheckLine
} from '@remixicon/react'
import type { AccountType } from '../../shared/types'
import { useLedgerPalette } from '../palette'

/**
 * 「新建账户」的**类型选择卡**：7 种类型各一张小卡（图标 + 名字），选中态用主色描边 + 淡底。
 *
 * 为什么不用下拉框（原来是 `Select` 的「类型」字段）：账户的表单形状**完全由类型决定**——
 * 只有信用卡/负债才谈得上额度与账单日，虚拟账户默认不计入净资产。所以类型不该和
 * 「账户名」并排挤在一行里当第 2 个下拉，而应该是这张表单的**第一步**：
 * 卡片一眼看全 7 种、点一下就换整套字段，下面还有一行说明当前类型的含义
 * （`accounts.typeHint.*`，例如「信用卡：期初余额填欠款（负数）」）。
 *
 * 颜色全走 `useLedgerPalette()`（主色 accent / 边框 border / 软底 soft），
 * 亮暗主题都跟着 antd token 走——不写任何字面量色值。
 * 布局用 `grid grid-cols-7`（类名字面量，工坊扫得到）而不是百分比宽度：
 * 卡片宽度由弹窗内容宽（632）均分，窄窗口下也不会挤成两行。
 */

/** 类型顺序 = `AccountType` 的声明顺序（现金 → 储蓄卡 → 信用卡 → 储值卡 → 投资 → 负债 → 虚拟） */
const ACCOUNT_TYPE_ORDER: AccountType[] = [
  'cash',
  'debit',
  'credit',
  'prepaid',
  'investment',
  'debt',
  'virtual'
]

/**
 * 类型 → 图标（图标名都在宿主的 `@remixicon/react` 里存在，构建期就能验出来）。
 *
 * 类型写宽一档 `{ size?: string | number }`：Remixicon 的 `size` 允许字符串，
 * 收成 `number` 会在 `defaultProps` 上对不上（组件类型是逆变检查的）。
 */
const TYPE_ICON: Record<AccountType, React.ComponentType<{ size?: string | number }>> = {
  cash: RiMoneyCnyCircleLine,
  debit: RiBankCardLine,
  credit: RiBankCard2Line,
  prepaid: RiCoupon3Line,
  investment: RiLineChartLine,
  debt: RiMoneyDollarBoxLine,
  virtual: RiShieldCheckLine
}

export default function AccountTypePicker(props: {
  value: AccountType
  onChange: (type: AccountType) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const p = useLedgerPalette()
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs leading-4 opacity-60">{t('personal-ledger.accounts.typeTitle')}</span>
      <div className="grid grid-cols-7 gap-2">
        {ACCOUNT_TYPE_ORDER.map((type) => {
          const Icon = TYPE_ICON[type]
          const selected = props.value === type
          return (
            <button
              key={type}
              type="button"
              aria-pressed={selected}
              onClick={() => props.onChange(type)}
              className="flex flex-col items-center gap-1.5 rounded-lg border border-solid px-1 py-2 transition-colors"
              style={{
                borderColor: selected ? p.accent : p.border,
                // 淡底：主色 hex 加两位 alpha（1f=12%）——比另开一档 token 稳，且亮暗都成立
                backgroundColor: selected ? `${p.accent}1f` : p.soft
              }}
            >
              <span style={{ color: selected ? p.accent : p.axis }}>
                <Icon size={18} />
              </span>
              <span
                className="truncate text-xs leading-4"
                style={{ color: selected ? p.accent : undefined, fontWeight: selected ? 600 : 400 }}
              >
                {t(`personal-ledger.accountTypes.${type}`)}
              </span>
            </button>
          )
        })}
      </div>
      <span className="text-xs leading-4 opacity-60">{t(`personal-ledger.accounts.typeHint.${props.value}`)}</span>
    </div>
  )
}
