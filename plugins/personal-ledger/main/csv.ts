import type { Transaction, TransactionInput } from '../shared/types'

/**
 * 个人记账台账 的 CSV 读写（导出 / 导入都走这里）。
 *
 * 为什么单独一份：导入的脏数据（微信、支付宝、银行导出的账单）几乎都在这一层收拾——
 * 表头前面有十几行说明、金额带 ¥ 和千分位、收/支列写「收入/支出/不计收支」、
 * 分隔符有的是逗号有的是制表符。解析器写得宽容一点，mapper 那边就能一直保持干净。
 */

/** 导出用的列顺序（与导入的表头识别一一对应） */
export const CSV_HEADERS = [
  '日期',
  '时间',
  '类型',
  '金额',
  '币种',
  '分类',
  '账户',
  '目标账户',
  '商家',
  '标签',
  '成员',
  '备注',
  '报销状态',
  '手续费',
  '优惠',
  '我的份额',
  '账单分组'
] as const

/** 单元格转义：含逗号/引号/换行就加引号，引号双写 */
function cell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 把解析好的单元格切成一行（支持引号内的逗号与换行） */
export function parseCsvRows(text: string, delimiter?: string): string[][] {
  const source = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n')
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false
  const sep = delimiter ?? detectDelimiter(source)

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          value += '"'
          i += 1
        } else quoted = false
      } else value += char
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === sep) {
      row.push(value)
      value = ''
    } else if (char === '\n') {
      row.push(value)
      rows.push(row)
      row = []
      value = ''
    } else {
      value += char
    }
  }
  if (value !== '' || row.length > 0) {
    row.push(value)
    rows.push(row)
  }
  return rows.filter((item) => item.some((entry) => entry.trim() !== ''))
}

/** 分隔符判定：表头里逗号多于制表符就用逗号（两种都要认，用户不管从哪导） */
function detectDelimiter(text: string): string {
  const head = text.split('\n').slice(0, 30).join('\n')
  const commas = (head.match(/,/g) ?? []).length
  const tabs = (head.match(/\t/g) ?? []).length
  return tabs > commas ? '\t' : ','
}

const COLUMN_KEYS: { key: string; words: string[] }[] = [
  { key: 'date', words: ['交易时间', '交易日期', '记账日期', '日期', '时间', 'date'] },
  { key: 'kind', words: ['收支', '收/支', '类型', '交易类型', '方向', 'type'] },
  { key: 'amount', words: ['金额', '交易金额', 'amount', 'money'] },
  { key: 'category', words: ['分类', '类别', '交易分类', 'category'] },
  { key: 'account', words: ['支付方式', '账户', '账户名称', '付款方式', 'account'] },
  { key: 'toAccount', words: ['目标账户', '转入账户', '收款账户', 'to account'] },
  { key: 'merchant', words: ['交易对方', '对方', '商家', '商户', 'merchant', 'payee'] },
  { key: 'note', words: ['商品', '备注', '说明', '摘要', '交易说明', 'note', 'memo'] },
  { key: 'tags', words: ['标签', 'tags', 'tag'] },
  { key: 'member', words: ['成员', '记账人', 'member'] },
  { key: 'currency', words: ['币种', '货币', 'currency'] }
]

/** 表头行定位：跳过微信/支付宝账单前面的说明行，认第一行含「时间/日期 + 金额」的行 */
function findHeaderRow(rows: string[][]): number {
  for (let index = 0; index < Math.min(rows.length, 30); index += 1) {
    const line = rows[index].join(' ').toLowerCase()
    const hasDate = /时间|日期|date/.test(line)
    const hasAmount = /金额|amount/.test(line)
    if (hasDate && hasAmount) return index
  }
  return 0
}

/** 表头 → 列下标 */
function mapColumns(header: string[]): Record<string, number> {
  const map: Record<string, number> = {}
  header.forEach((raw, index) => {
    const name = raw.trim().toLowerCase()
    for (const column of COLUMN_KEYS) {
      if (map[column.key] !== undefined) continue
      if (column.words.some((word) => name.includes(word.toLowerCase()))) {
        map[column.key] = index
        break
      }
    }
  })
  return map
}

/** 金额清洗：去掉 ¥ ￥ , 空格，全角括号里的负数也认 */
function parseAmount(raw: string): number {
  const cleaned = raw
    .replace(/[¥￥,\s]/g, '')
    .replace(/[（(]/g, '-')
    .replace(/[）)]/g, '')
    .trim()
  const value = Number(cleaned)
  return Number.isFinite(value) ? Math.abs(value) : 0
}

/** 日期归一化成 YYYY-MM-DD（认 2024/1/5、2024-01-05、2024年1月5日、带时间的） */
function normalizeDate(raw: string): string {
  const text = raw.trim().replace(/[年月]/g, '-').replace(/日/g, '')
  const match = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text)
  if (match) {
    const [, y, m, d] = match
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  return ''
}

/** 时间归一化成 HH:mm */
function normalizeTime(raw: string): string {
  const match = /(\d{1,2}):(\d{2})/.exec(raw)
  if (!match) return ''
  return `${match[1].padStart(2, '0')}:${match[2]}`
}

function normalizeKind(raw: string): TransactionInput['kind'] {
  const text = raw.toLowerCase()
  if (/转账|transfer|内部/.test(text)) return 'transfer'
  if (/收入|收|income|入账|转入/.test(text)) return 'income'
  return 'expense'
}

/**
 * CSV 文本 → 交易入参（列名按关键词认，认不出来的行进 `errors`）。
 *
 * 返回的 rows 直接可以喂给 `importTransactions`：分类 / 账户 / 商家按**名字**给，
 * mapper 那边找不到就自动建，用户不用先建一遍基础数据。
 */
export function transactionsFromCsv(text: string): {
  rows: TransactionInput[]
  errors: string[]
} {
  const errors: string[] = []
  const rows = parseCsvRows(text)
  if (rows.length === 0) return { rows: [], errors: ['文件是空的'] }
  const headerIndex = findHeaderRow(rows)
  const header = rows[headerIndex].map((value) => value.trim())
  const columns = mapColumns(header)
  if (columns.date === undefined || columns.amount === undefined) {
    return {
      rows: [],
      errors: [`认不出表头（需要至少包含「日期/时间」与「金额」两列）：${header.join(' | ')}`]
    }
  }
  const out: TransactionInput[] = []
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const line = rows[index]
    const rawDate = line[columns.date] ?? ''
    const date = normalizeDate(rawDate)
    const amount = parseAmount(line[columns.amount] ?? '')
    if (!date || amount <= 0) {
      errors.push(`第 ${index + 1} 行跳过（日期或金额认不出来）：${line.join(' | ')}`)
      continue
    }
    const kindRaw = columns.kind === undefined ? '' : line[columns.kind] ?? ''
    const kind = normalizeKind(kindRaw)
    const tags = (columns.tags === undefined ? '' : line[columns.tags] ?? '')
      .split(/[;；,，\s]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0)
    out.push({
      kind,
      amount,
      date,
      time: normalizeTime(rawDate) || '00:00',
      currency: (columns.currency === undefined ? '' : line[columns.currency] ?? '').trim() || undefined,
      categoryName: (columns.category === undefined ? '' : line[columns.category] ?? '').trim() || undefined,
      accountName: (columns.account === undefined ? '' : line[columns.account] ?? '').trim() || undefined,
      toAccountName:
        (columns.toAccount === undefined ? '' : line[columns.toAccount] ?? '').trim() || undefined,
      merchantName: (columns.merchant === undefined ? '' : line[columns.merchant] ?? '').trim() || undefined,
      note: (columns.note === undefined ? '' : line[columns.note] ?? '').trim(),
      member: (columns.member === undefined ? '' : line[columns.member] ?? '').trim(),
      tags
    })
  }
  return { rows: out, errors }
}

/** 交易 → CSV 文本（带 BOM，Excel 直接双击打开不乱码） */
export function transactionsToCsv(
  transactions: Transaction[],
  names: {
    category: Map<number, string>
    account: Map<number, string>
    merchant: Map<number, string>
  }
): string {
  const lines: string[] = [CSV_HEADERS.join(',')]
  for (const tx of transactions) {
    lines.push(
      [
        tx.date,
        tx.time,
        tx.kind === 'expense' ? '支出' : tx.kind === 'income' ? '收入' : '转账',
        tx.amount,
        tx.currency,
        tx.categoryId ? names.category.get(tx.categoryId) ?? '' : '',
        tx.accountId ? names.account.get(tx.accountId) ?? '' : '',
        tx.toAccountId ? names.account.get(tx.toAccountId) ?? '' : '',
        tx.merchantId ? names.merchant.get(tx.merchantId) ?? '' : '',
        tx.tags.join(' '),
        tx.member,
        tx.note,
        tx.reimburseStatus,
        tx.fee,
        tx.discount,
        tx.myShare,
        tx.groupId
      ]
        .map(cell)
        .join(',')
    )
  }
  return `\ufeff${lines.join('\n')}`
}
