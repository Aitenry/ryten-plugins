import { getMainLanguage } from '@host/main/i18n'

/**
 * 个人记账台账 工具的返回文案（显示在工具卡片上，跟随界面语言）。
 *
 * 为什么单独一份：模型看到的字符串会原样进对话，**用户也会看到**——
 * 文案随插件走，插件停用就一起消失（别塞进宿主内核的文案表）。
 */
export const zhCNToolTexts = {
  common: {
    unknownAction: '未知动作：{{action}}。支持：{{supported}}',
    failed: '操作失败：{{message}}',
    emptyValue: '（无）',
    kindExpense: '支出',
    kindIncome: '收入',
    kindTransfer: '转账'
  },
  ledger: {
    summaryHeader: '**记账概览**（{{currency}}）',
    summaryAssets: '- 资产合计：{{assets}}',
    summaryLiabilities: '- 负债合计：{{liabilities}}',
    summaryNetWorth: '- 净资产：{{netWorth}}',
    summaryMonth: '- 本月：收入 {{income}}，支出 {{expense}}，结余 {{balance}}',
    summaryToday: '- 今日支出：{{today}}',
    summaryReimburse: '- 待报销：{{reimburse}}；AA 待收：{{receivable}}；待还：{{payable}}',
    listHeader: '**流水**（{{count}} 条，最多显示 {{limit}} 条）',
    listLine: '- [{{id}}] {{date}} {{kind}} {{amount}}{{category}}{{account}}{{note}}',
    listMore: '…还有 {{rest}} 条，可用 from/to/keyword 缩小范围。',
    listEmpty: '没有符合条件的流水。',
    added: '已记账：{{date}} {{kind}} {{amount}}{{category}}{{account}}（id={{id}}）',
    addedInstallment: '已生成 {{count}} 期分期，每期约 {{amount}}（首期含零头）。',
    removed: '已删除流水 id={{id}}。',
    notFound: '没有 id={{id}} 的流水。',
    accountsHeader: '**账户余额**（{{count}} 个）',
    accountLine: '- {{name}}（{{type}}）：{{balance}}{{liability}}',
    accountsEmpty: '还没有账户，先在插件页面加一个。',
    budgetsHeader: '**预算进度**',
    budgetLine: '- {{name}}：已用 {{spent}} / {{amount}}（{{percent}}%），{{state}}',
    budgetOk: '剩余 {{remaining}}',
    budgetOver: '超支 {{over}}',
    budgetsEmpty: '还没有设置预算。',
    reportHeader: '**收支报表** {{from}} ~ {{to}}',
    reportTotals: '- 收入 {{income}}，支出 {{expense}}（其中退款冲减 {{refund}}），结余 {{balance}}',
    reportCategoryLine: '- {{name}}：{{amount}}（{{percent}}%）',
    reportHealth:
      '- 储蓄率 {{savingsRate}}%，负债率 {{debtRatio}}%，日均支出 {{daily}}（预计本月 {{projected}}）',
    reportEmpty: '这个区间没有数据。',
    reminderHeader: '**提醒**（{{count}} 条）',
    reminderLine: '- {{date}} {{title}}：{{detail}}',
    remindersEmpty: '近期没有需要处理的事项。',
    recurringRun: '周期记账已生成 {{count}} 条流水。'
  }
}

export const enUSToolTexts: typeof zhCNToolTexts = {
  common: {
    unknownAction: 'Unknown action: {{action}}. Supported: {{supported}}',
    failed: 'Failed: {{message}}',
    emptyValue: '(none)',
    kindExpense: 'expense',
    kindIncome: 'income',
    kindTransfer: 'transfer'
  },
  ledger: {
    summaryHeader: '**Ledger overview** ({{currency}})',
    summaryAssets: '- Assets: {{assets}}',
    summaryLiabilities: '- Liabilities: {{liabilities}}',
    summaryNetWorth: '- Net worth: {{netWorth}}',
    summaryMonth: '- This month: income {{income}}, expense {{expense}}, net {{balance}}',
    summaryToday: '- Spent today: {{today}}',
    summaryReimburse: '- Pending reimbursement: {{reimburse}}; owed to me (split): {{receivable}}; owed by me: {{payable}}',
    listHeader: '**Transactions** ({{count}} found, showing up to {{limit}})',
    listLine: '- [{{id}}] {{date}} {{kind}} {{amount}}{{category}}{{account}}{{note}}',
    listMore: '…{{rest}} more; narrow it down with from/to/keyword.',
    listEmpty: 'No matching transactions.',
    added: 'Recorded: {{date}} {{kind}} {{amount}}{{category}}{{account}} (id={{id}})',
    addedInstallment: 'Created {{count}} installments of about {{amount}} each (first one takes the remainder).',
    removed: 'Deleted transaction id={{id}}.',
    notFound: 'No transaction with id={{id}}.',
    accountsHeader: '**Account balances** ({{count}})',
    accountLine: '- {{name}} ({{type}}): {{balance}}{{liability}}',
    accountsEmpty: 'No accounts yet - add one in the plugin page.',
    budgetsHeader: '**Budget progress**',
    budgetLine: '- {{name}}: {{spent}} of {{amount}} used ({{percent}}%), {{state}}',
    budgetOk: '{{remaining}} left',
    budgetOver: 'over by {{over}}',
    budgetsEmpty: 'No budgets configured yet.',
    reportHeader: '**Report** {{from}} ~ {{to}}',
    reportTotals: '- Income {{income}}, expense {{expense}} (refunds offset {{refund}}), net {{balance}}',
    reportCategoryLine: '- {{name}}: {{amount}} ({{percent}}%)',
    reportHealth:
      '- Savings rate {{savingsRate}}%, debt ratio {{debtRatio}}%, daily spend {{daily}} (projected month {{projected}})',
    reportEmpty: 'No data in this range.',
    reminderHeader: '**Reminders** ({{count}})',
    reminderLine: '- {{date}} {{title}}: {{detail}}',
    remindersEmpty: 'Nothing needs attention soon.',
    recurringRun: 'Recurring rules generated {{count}} transactions.'
  }
}

/** 当前界面语言对应的文案 */
export function getToolTexts(): typeof zhCNToolTexts {
  return getMainLanguage() === 'en-US' ? enUSToolTexts : zhCNToolTexts
}

/** 工具描述（给模型看的；也显示在设置 → 智能体 → 工具里） */
export function toolDescriptions(): { zh: string; en: string } {
  return {
    zh:
      '个人记账台账：记账（add）、查流水（list）、看概览（summary）、账户余额（accounts）、' +
      '预算进度（budgets）、区间报表（report）、近期提醒（reminders）、生成到期周期账（recurring）。' +
      '金额用正数，方向由 kind（expense/income/transfer）决定；分类与账户可以只给名字，会自动创建。',
    en:
      'Personal ledger: add a transaction (add), list transactions (list), overview (summary), ' +
      'account balances (accounts), budget progress (budgets), range report (report), reminders (reminders), ' +
      'post due recurring items (recurring). Amounts are positive; direction comes from kind ' +
      '(expense/income/transfer); category and account may be given by name and will be created on demand.'
  }
}
