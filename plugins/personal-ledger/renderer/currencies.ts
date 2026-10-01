/**
 * 币种代码的**单一真源**。
 *
 * 为什么收成一份：币种下拉散在三处各写了一遍——设置页写死 6 个（`CNY…GBP`）、
 * 账户表单写死 13 个、记一笔只认汇率表里的币种。用户在设置页想加一个 `SGD` 汇率，
 * 却发现下拉里没有这个选项（得先记住「设置页只认 6 个」这件事）。
 * 现在「常见币种」只有这一份，谁要下拉谁来取。
 *
 * 注意：这里只列**代码**，不列中文名——币种名要逐语言给词条，
 * 而代码本身就是国际通用写法（`CNY`），显示代码反而不会被翻译错。
 */
export const COMMON_CURRENCY_CODES = [
  'CNY',
  'USD',
  'EUR',
  'JPY',
  'HKD',
  'GBP',
  'KRW',
  'AUD',
  'CAD',
  'SGD',
  'TWD',
  'CHF'
]

/**
 * 下拉选项：**调用方给的币种在前**（基准币种、汇率表里已有的），常见币种兜底，按顺序去重。
 *
 * 顺序即优先级：基准币种永远排第一（用户最先看到的应该是自己的口径，
 * 而不是一个按字母排的表）。
 */
export function currencyOptions(
  extra: (string | null | undefined)[] = []
): { value: string; label: string }[] {
  const codes = new Set<string>()
  for (const code of extra) {
    const normalized = code?.trim().toUpperCase()
    if (normalized) codes.add(normalized)
  }
  for (const code of COMMON_CURRENCY_CODES) codes.add(code)
  return [...codes].map((code) => ({ value: code, label: code }))
}
