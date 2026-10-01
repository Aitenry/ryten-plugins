import { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Card, Input, InputNumber, Select, Space, Switch, Table, TimePicker, Typography } from 'antd'
import { RiAddLine, RiDeleteBin6Line, RiDownloadLine, RiUploadLine } from '@remixicon/react'
import dayjs from 'dayjs'
import { useTranslation } from '@host/renderer/i18n'
import type { ClassifyRule, LedgerSettings, LedgerState } from '../shared/types'
import api from './api'
import { COMMON_CURRENCY_CODES, currencyOptions } from './currencies'

/**
 * 「HH:mm」→ TimePicker 的值（空 / 坏值给 null）。
 *
 * 为什么不直接 `dayjs('21:00')`：dayjs 解析这种**不带日期**的字符串要 `customParseFormat`
 * 插件，而插件产物里只有 dayjs 本体（没有插件）——直接解析会得到 Invalid Date，
 * TimePicker 会显示成空白。所以自己拼一个「今天的那一分钟」。
 */
function timeValue(value: string): ReturnType<typeof dayjs> | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim())
  if (!match) return null
  return dayjs().hour(Number(match[1])).minute(Number(match[2])).second(0)
}

/**
 * 个人记账台账 的设置页（设置 → 助手 → 本插件）。
 *
 * 这里放的都是**配置**（基准币种、汇率、成员、提醒、自动分类规则、快捷模板），
 * 所以存 JSON 而不进表；业务数据（流水 / 账户 / 预算…）在页面里维护。
 * 界面文案一律走词条（locales/），不写死在组件里。
 *
 * 币种这一块为什么要重做（用户反馈：「基准币种不能用逗号隔开什么的，还搞个输入框在那里」）：
 * 原来一张卡里塞了三样东西——基准币种下拉、「每行 `USD=7.2`」的多行文本框（汇率）、
 * 逗号分隔的成员输入框。等于要求用户**手写一种谁也想不到的文本格式**才能配汇率，
 * 而且文本框是合并语义、删掉一行其实删不掉（`settings-set` 的 rates 原来是 merge）。
 * 现在：
 *   - 基准币种 = 一个**可选可搜的下拉**（常见币种 + 汇率表已有 + 输入 3 位代码即时新建）；
 *   - 汇率 = 一张**逐行的表**（币种下拉 + 汇率数字框 + 删除），删行就是删键（主进程改成整表替换）；
 *   - 账本成员 = `mode="tags"` 的标签框（回车/逗号成标签，× 删除），不再让用户对分隔符负责。
 * 控件宽度与「记一笔」同档（下拉 120~200、数字 150），不铺满整宽。
 */
export default function Settings(): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const [settings, setSettings] = useState<LedgerSettings | null>(null)
  const [state, setState] = useState<LedgerState | null>(null)
  /** 汇率表的编辑态（按行改，改完一行才落盘；也是删除键的依据） */
  const [ratesDraft, setRatesDraft] = useState<Record<string, number>>({})
  /** 基准币种下拉里当前敲进去的字符（用来把「输入 3 位代码」变成一个可选的新建项） */
  const [currencyQuery, setCurrencyQuery] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const [nextSettings, nextState] = await Promise.all([api.getSettings(), api.getState()])
    setSettings(nextSettings)
    setState(nextState)
    setRatesDraft(nextSettings.rates ?? {})
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const baseCurrency = settings?.baseCurrency ?? ''
  const rates = settings?.rates ?? {}

  /** 基准币种下拉：常见币种 + 汇率表已有；另外把「敲进去的 3 位代码」变成一个可选的新建项 */
  const baseCurrencyOptions = useMemo(() => {
    const list = currencyOptions([baseCurrency, ...Object.keys(rates)])
    const typed = currencyQuery.trim().toUpperCase()
    if (/^[A-Z]{3}$/.test(typed) && !list.some((option) => option.value === typed)) {
      return [{ value: typed, label: t('personal-ledger.settingsPage.customCurrency', { code: typed }) }, ...list]
    }
    return list
  }, [baseCurrency, rates, currencyQuery, t])

  /** 汇率表（按币种排序；基准币种恒为 1，不进这张表） */
  const rateRows = useMemo(
    () =>
      Object.entries(ratesDraft)
        .filter(([code]) => code !== baseCurrency)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([code, rate]) => ({ code, rate })),
    [ratesDraft, baseCurrency]
  )

  if (!settings) {
    return (
      <div>
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          {t('personal-ledger.settings.title')}
        </Typography.Title>
      </div>
    )
  }

  /**
   * 汇率表落盘：整表替换（主进程对 `rates` 就是这个语义），所以「删掉一行」真的删得掉。
   * 顺手把当前基准币种钉成 1——页面上不显示这一行，但折算要用。
   */
  const saveRates = (draft: Record<string, number>): void => {
    const next = { ...draft, [settings.baseCurrency]: 1 }
    setRatesDraft(next)
    void save({ rates: next })
  }

  const save = async (patch: Partial<LedgerSettings>): Promise<void> => {
    setBusy(true)
    try {
      const next = await api.setSettings(patch)
      setSettings(next)
      setRatesDraft(next.rates ?? {})
      message.success(t('personal-ledger.settingsPage.saved'))
    } finally {
      setBusy(false)
    }
  }

  /** 加一行汇率：优先补第一个还没用到的常见币种（用户接着用下拉改代码即可） */
  const addRateRow = (): void => {
    const code = COMMON_CURRENCY_CODES.find((item) => !(item in ratesDraft))
    if (!code) {
      message.info(t('personal-ledger.settingsPage.allRatesAdded'))
      return
    }
    saveRates({ ...ratesDraft, [code]: 1 })
  }

  /** 改一行的币种 = 换键（值跟着走），避免出现两个同币种的行 */
  const renameRate = (from: string, to: string): void => {
    const draft: Record<string, number> = {}
    for (const [code, rate] of Object.entries(ratesDraft)) {
      draft[code === from ? to : code] = code === from ? (ratesDraft[from] ?? 1) : rate
    }
    saveRates(draft)
  }

  const rules: ClassifyRule[] = settings.rules ?? []

  return (
    <div className="flex flex-col gap-3">
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {t('personal-ledger.settings.title')}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {t('personal-ledger.settingsPage.intro')}
      </Typography.Paragraph>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <Card size="small" title={t('personal-ledger.settingsPage.baseCurrency')}>
            <div className="flex flex-col gap-2">
              <Select
                showSearch
                style={{ width: 200 }}
                value={settings.baseCurrency}
                options={baseCurrencyOptions}
                placeholder={t('personal-ledger.settingsPage.currencyPlaceholder')}
                onSearch={setCurrencyQuery}
                // 只按**代码前缀**过滤：默认的 label 模糊匹配会把「输入 3 位新建」那项滤掉
                filterOption={(input, option) => String(option?.value ?? '').startsWith(input.trim().toUpperCase())}
                onChange={(value) => {
                  setCurrencyQuery('')
                  void save({ baseCurrency: value as string })
                }}
              />
              <span className="text-xs opacity-60">{t('personal-ledger.settingsPage.baseCurrencyHint')}</span>
            </div>
          </Card>

          <Card size="small" title={t('personal-ledger.settingsPage.rates')}>
            <div className="flex flex-col gap-1">
              <Table<{ code: string; rate: number }>
                size="small"
                rowKey="code"
                pagination={false}
                dataSource={rateRows}
                locale={{ emptyText: t('personal-ledger.settingsPage.ratesEmpty') }}
                columns={[
                  {
                    title: t('personal-ledger.settingsPage.rateCurrency'),
                    dataIndex: 'code',
                    width: 130,
                    render: (code: string) => (
                      <Select
                        size="small"
                        showSearch
                        style={{ width: '100%' }}
                        value={code}
                        // 别的行已占用的币种不再出现在下拉里，避免两行同币种
                        options={currencyOptions([baseCurrency, ...Object.keys(ratesDraft)]).filter(
                          (option) => option.value === code || !(option.value in ratesDraft)
                        )}
                        filterOption={(input, option) =>
                          String(option?.value ?? '').startsWith(input.trim().toUpperCase())
                        }
                        onChange={(value) => renameRate(code, value as string)}
                      />
                    )
                  },
                  {
                    title: t('personal-ledger.settingsPage.rateValue', { base: settings.baseCurrency }),
                    dataIndex: 'rate',
                    render: (rate: number, row) => (
                      <InputNumber
                        size="small"
                        min={0}
                        step={0.01}
                        style={{ width: 150 }}
                        value={rate}
                        onChange={(value) => setRatesDraft((prev) => ({ ...prev, [row.code]: Number(value ?? 0) }))}
                        onBlur={() => saveRates(ratesDraft)}
                      />
                    )
                  },
                  {
                    title: t('personal-ledger.common.actions'),
                    key: 'actions',
                    width: 60,
                    render: (_value, row) => {
                      const next = { ...ratesDraft }
                      delete next[row.code]
                      return (
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<RiDeleteBin6Line size={14} />}
                          onClick={() => saveRates(next)}
                        />
                      )
                    }
                  }
                ]}
              />
              <span className="text-xs opacity-60">{t('personal-ledger.settingsPage.ratesHint')}</span>
              <Button size="small" type="link" icon={<RiAddLine size={14} />} onClick={addRateRow}>
                {t('personal-ledger.settingsPage.addRate')}
              </Button>
            </div>
          </Card>

          <Card size="small" title={t('personal-ledger.settingsPage.members')}>
            <div className="flex flex-col gap-2">
              <Select
                mode="tags"
                // 成员是「自己起名字」，没有可选项 → 关掉下拉，只留标签本身
                open={false}
                suffixIcon={null}
                tokenSeparators={[',', '，']}
                style={{ width: '100%', maxWidth: 320 }}
                value={settings.members}
                placeholder={t('personal-ledger.settingsPage.membersHint')}
                onChange={(value) => void save({ members: value as string[] })}
              />
              <span className="text-xs opacity-60">{t('personal-ledger.settingsPage.membersAddHint')}</span>
            </div>
          </Card>
        </div>

        <Card size="small" title={t('personal-ledger.overview.reminders')}>
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span>{t('personal-ledger.settingsPage.remindersEnabled')}</span>
              <Switch
                size="small"
                checked={settings.remindersEnabled}
                onChange={(value) => void save({ remindersEnabled: value })}
              />
            </div>
            <div className="flex items-center justify-between">
              <span>{t('personal-ledger.settingsPage.dailyReminder')}</span>
              <TimePicker
                format="HH:mm"
                allowClear
                style={{ width: 120 }}
                value={timeValue(settings.dailyReminder)}
                onChange={(value) => void save({ dailyReminder: value ? value.format('HH:mm') : '' })}
              />
            </div>
            <div className="flex items-center justify-between">
              <span>{t('personal-ledger.settingsPage.budgetAlertRatio')}</span>
              <InputNumber
                min={0.1}
                max={2}
                step={0.05}
                value={settings.budgetAlertRatio}
                onChange={(value) => void save({ budgetAlertRatio: Number(value ?? 0.8) })}
              />
            </div>
            <div className="flex items-center justify-between">
              <span>{t('personal-ledger.settingsPage.largeAmountThreshold')}</span>
              <InputNumber
                min={0}
                step={100}
                value={settings.largeAmountThreshold}
                onChange={(value) => void save({ largeAmountThreshold: Number(value ?? 0) })}
              />
            </div>
            <div className="flex items-center justify-between">
              <span>{t('personal-ledger.settingsPage.defaultAccountId')}</span>
              <Select
                allowClear
                style={{ width: 180 }}
                value={settings.defaultAccountId ?? undefined}
                options={(state?.accounts ?? []).map((account) => ({ value: account.id, label: account.name }))}
                onChange={(value) => void save({ defaultAccountId: (value as number) ?? null })}
              />
            </div>
          </div>
        </Card>
      </div>

      <Card size="small" title={t('personal-ledger.settingsPage.rules')}>
        <Table<ClassifyRule>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={rules}
          locale={{ emptyText: t('personal-ledger.common.empty') }}
          columns={[
            {
              title: t('personal-ledger.settingsPage.ruleKeyword'),
              dataIndex: 'keyword',
              render: (value: string, row) => (
                <Input
                  size="small"
                  value={value}
                  onChange={(event) =>
                    void save({
                      rules: rules.map((rule) =>
                        rule.id === row.id ? { ...rule, keyword: event.target.value } : rule
                      )
                    })
                  }
                />
              )
            },
            {
              title: t('personal-ledger.settingsPage.ruleCategory'),
              dataIndex: 'categoryId',
              width: 200,
              render: (value: number, row) => (
                <Select
                  size="small"
                  style={{ width: '100%' }}
                  value={value}
                  options={(state?.categories ?? []).map((category) => ({
                    value: category.id,
                    label: category.name
                  }))}
                  onChange={(next) =>
                    void save({
                      rules: rules.map((rule) => (rule.id === row.id ? { ...rule, categoryId: next as number } : rule))
                    })
                  }
                />
              )
            },
            {
              title: t('personal-ledger.common.actions'),
              key: 'actions',
              width: 70,
              render: (_value, row) => (
                <Button
                  size="small"
                  type="text"
                  danger
                  icon={<RiDeleteBin6Line size={14} />}
                  onClick={() => void save({ rules: rules.filter((rule) => rule.id !== row.id) })}
                />
              )
            }
          ]}
        />
        <Button
          size="small"
          type="link"
          icon={<RiAddLine size={14} />}
          onClick={() =>
            void save({
              rules: [
                ...rules,
                {
                  id: `${Date.now()}`,
                  keyword: '',
                  categoryId: state?.categories[0]?.id ?? 0,
                  kind: 'expense'
                }
              ]
            })
          }
        >
          {t('personal-ledger.settingsPage.addRule')}
        </Button>
      </Card>

      <Card size="small" title={t('personal-ledger.settingsPage.templates')}>
        {(settings.templates ?? []).length === 0 ? (
          <span className="text-xs opacity-60">{t('personal-ledger.settingsPage.noTemplates')}</span>
        ) : (
          <div className="flex flex-col gap-1">
            {(settings.templates ?? []).map((template) => (
              <div key={template.id} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {template.name} · {t(`personal-ledger.kinds.${template.input.kind}`)} {template.input.amount}
                </span>
                <Button
                  size="small"
                  type="text"
                  danger
                  icon={<RiDeleteBin6Line size={12} />}
                  onClick={() =>
                    void save({ templates: (settings.templates ?? []).filter((item) => item.id !== template.id) })
                  }
                />
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card size="small" title={t('personal-ledger.settingsPage.data')}>
        <Space wrap>
          <Button
            icon={<RiDownloadLine size={14} />}
            loading={busy}
            onClick={async () => {
              const result = await api.exportData('csv')
              if (result?.ok) message.success(t('personal-ledger.reports.exportDone', { path: result.path }))
            }}
          >
            {t('personal-ledger.reports.exportCsv')}
          </Button>
          <Button
            icon={<RiDownloadLine size={14} />}
            loading={busy}
            onClick={async () => {
              const result = await api.exportData('json')
              if (result?.ok) message.success(t('personal-ledger.reports.exportDone', { path: result.path }))
            }}
          >
            {t('personal-ledger.reports.exportJson')}
          </Button>
          <Button
            icon={<RiUploadLine size={14} />}
            loading={busy}
            onClick={async () => {
              const result = await api.importData()
              if (result) {
                message.success(
                  t('personal-ledger.reports.importResult', {
                    total: result.total,
                    inserted: result.inserted
                  })
                )
              }
            }}
          >
            {t('personal-ledger.reports.importCsv')}
          </Button>
        </Space>
        <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>
          {t('personal-ledger.settingsPage.storageHint')}
        </Typography.Paragraph>
      </Card>
    </div>
  )
}
