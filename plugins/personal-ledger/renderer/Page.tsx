import { useCallback, useEffect, useState } from 'react'
import { App, Button, Spin, Tabs, theme } from 'antd'
import { RiAddLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { Dashboard, LedgerState, Transaction, TransactionInput } from '../shared/types'
import api, { type PlansData } from './api'
import AccountsTab from './components/AccountsTab'
import BudgetsTab from './components/BudgetsTab'
import OverviewTab from './components/OverviewTab'
import PlansTab from './components/PlansTab'
import ReportsTab from './components/ReportsTab'
import TransactionForm from './components/TransactionForm'
import TransactionsTab from './components/TransactionsTab'
import { Pane } from './components/ui'

/**
 * 页签栏（`.ant-tabs-nav`）的高度，px —— **这一行高度的唯一真源**。
 *
 * 为什么写在这儿：antd 6 把 `tabBarStyle` 原样交给 rc-tabs，rc-tabs 给这一行合成的内联样式是
 * `style={{ ...styles.header, ...style }}`（`style` 就是我们传的 `tabBarStyle`）——**我们这份排在
 * 后面**，后写胜出。所以这里写多少、DOM 上就是多少：不需要 `!important`，也不会被 `size="small"`
 * 或者别处的语义槽盖掉。
 *
 * 值取 35px：把高度从「antd 隐含给的」变成「我们自己声明的」，以后要调只改这一个数。
 * 高度只影响上下余量：横向 Tabs 的 nav 是 `display:flex; align-items:center`，
 * 页签与右侧的「记一笔」会自动垂直居中。
 */
const TAB_BAR_HEIGHT = 35

/**
 * 个人记账台账 的页面（六个页签：概览 / 明细 / 账户 / 预算 / 计划 / 报表）。
 *
 * 数据只走本插件的主进程通道（./api）：主进程改数据会推
 * `plugin:personal-ledger:data-changed`，这里订阅它做实时刷新——
 * 设置页、AI 工具改了数据，开着的这一页会立刻跟上。
 *
 * 这一层刻意很薄：所有汇总（净资产、预算进度、报表）都由主进程算好（见 main/db/reports.ts），
 * 页面只负责画图与弹窗，避免「页面一套口径、工具另一套口径」。
 *
 * 页签内容区用 `./components/ui` 的 `Pane`（原先是这里的一个本地函数，
 * 与 `ui.tsx` 里那份重复了——布局原语统一收在 `ui.tsx`，页面只负责装配）。
 */
export default function Page(): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = App.useApp()
  // `token` 这个名字已经被「刷新计数」的本地 state 占了（见下面的 setToken），主题取色换个名
  const { token: themeToken } = theme.useToken()
  const [tab, setTab] = useState('overview')
  const [state, setState] = useState<LedgerState | null>(null)
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [plans, setPlans] = useState<PlansData | null>(null)
  const [refundables, setRefundables] = useState<Transaction[]>([])
  const [token, setToken] = useState(0)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Transaction | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const [nextState, nextDashboard, nextPlans, expenses] = await Promise.all([
      api.getState(),
      api.getDashboard(),
      api.getPlans(),
      api.queryTransactions({ limit: 200 })
    ])
    if (nextState) setState(nextState)
    setDashboard(nextDashboard ?? null)
    if (nextPlans) setPlans(nextPlans)
    setRefundables((expenses ?? []).filter((tx) => tx.kind === 'expense' && !tx.refundOfId).slice(0, 40))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 主进程推送：数据变了就重拉（事件通道由插件主进程 registerEvent 声明过才订阅得到）
  useEffect(() => api.onDataChanged(() => void load()), [load])

  const refresh = (): void => {
    setToken((value) => value + 1)
    void load()
  }

  const openForm = (transaction: Transaction | null): void => {
    setEditing(transaction)
    setFormOpen(true)
  }

  const submit = async (input: TransactionInput): Promise<void> => {
    setSaving(true)
    try {
      await api.saveTransaction({ ...input, id: editing?.id })
      setFormOpen(false)
      setEditing(null)
      refresh()
    } catch (err) {
      message.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const saveTemplate = async (name: string, input: TransactionInput): Promise<void> => {
    const templates = [
      ...(state?.settings.templates ?? []).filter((item) => item.name !== name),
      { id: `${Date.now()}`, name, input }
    ]
    await api.setSettings({ templates })
    message.success(t('personal-ledger.form.templateSaved'))
    refresh()
  }

  // 页面最外围的底色 = antd 的「容器底色」（`token.colorBgContainer`），与插件里的 Panel 卡片、
  // 宿主的助手页主区同源（亮色偏白、暗色是比外壳更深一档的灰）。为什么要显式给：这一层不给
  // 底色就是**透明**的，露出来的是 `.custom-frame` 那层外壳灰——整页看着像一块「外壳」而不是
  // 页面，和别的组件不是同一个面。加载中的转圈壳子也用同一个底色，免得状态切换时闪一下灰。
  const pageStyle = { backgroundColor: themeToken.colorBgContainer }

  if (!state) {
    return (
      <div className="flex h-full w-full items-center justify-center px-2 pb-2" style={pageStyle}>
        <Spin />
      </div>
    )
  }

  const emptyPlans: PlansData = { budgets: [], goals: [], recurring: [], debts: [], deposits: [] }

  return (
    // 根节点：撑满宿主给的高度，自己不滚（整页不出现滚动条）。
    // padding 用 px-2 pb-2：左右下各留 8px，让 Panel 不贴窗口边、不蹭到外壳那 6px 圆角；
    // **上面刻意不给**（pt-0），页签栏直接贴顶——这是用户要的，别再补 pt-*。
    // **只垫这一处**，页面内部各页签不再各自加 padding。
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden px-2 pb-2" style={pageStyle}>
      {/* 没有独立标题行：宿主已经给了菜单/页签位，页面再顶一个「个人记账台账」大标题是重复。
          「记一笔」改挂在页签栏的最右侧（tabBarExtraContent.right）——与页签同一行，
          既省一行高度，也不随内容滚动。
          账户为空时**不再**在页签栏上方挂一块「还没有账户」的提示：那是空状态，不该常驻占一整行，
          页签栏也就能一直贴顶。要看「还没有账户」去「账户」页签——那里的表格自带空状态文案。 */}
      <Tabs
        size="small"
        activeKey={tab}
        onChange={setTab}
        className="min-h-0 flex-1"
        tabBarStyle={{ marginBottom: 14, height: TAB_BAR_HEIGHT }}
        // 「记一笔」贴在页签栏最右端（antd 的 extra-content 自带 margin-left:auto）
        tabBarExtraContent={{
          right: (
            <Button size="small" type="primary" icon={<RiAddLine size={14} />} onClick={() => openForm(null)}>
              {t('personal-ledger.page.addTransaction')}
            </Button>
          )
        }}
        // antd 6 的 Tabs 默认不是「撑满高度」的布局，而且**每个页签各自是一个 `.ant-tabs-content`**
        // （老的 `.ant-tabs-content-holder` 结构已经没有了）。所以：
        //   body  → 定位上下文 + 列布局 + 撑满高度；
        //   content（每个 pane）→ 绝对定位铺满 body。
        // 为什么用绝对定位而不是 flex:1：antd 会把「访问过的」页签都留在 DOM 里，
        // 它们若是 flex 项就会一起瓜分高度（访问 6 个页签时当前页只剩 1/6 高，内容被裁）。
        styles={{
          body: {
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0
          },
          content: {
            // 只给定位与溢出，**不要给 display**：
            // antd 用 `.ant-tabs-content-hidden` 隐藏非激活页签，而内联样式优先级更高，
            // 一旦在这里写了 display:flex，隐藏就失效 → 访问过的页签会全部叠在一起画出来。
            // 页面内部要的列布局交给下面的 Pane（h-full + flex 容器由各页签自己建）。
            position: 'absolute',
            inset: 0,
            minHeight: 0,
            overflow: 'hidden'
          }
        }}
        items={[
          {
            key: 'overview',
            label: t('personal-ledger.page.tabs.overview'),
            children: (
              <Pane>
                <OverviewTab
                  state={state}
                  dashboard={dashboard}
                  onOpenTransaction={(transaction) => openForm(transaction)}
                />
              </Pane>
            )
          },
          {
            key: 'transactions',
            label: t('personal-ledger.page.tabs.transactions'),
            children: (
              <Pane>
                <TransactionsTab
                  state={state}
                  refreshToken={token}
                  onEdit={(transaction) => openForm(transaction)}
                  onChanged={refresh}
                />
              </Pane>
            )
          },
          {
            key: 'accounts',
            label: t('personal-ledger.page.tabs.accounts'),
            children: (
              <Pane>
                <AccountsTab state={state} onChanged={refresh} />
              </Pane>
            )
          },
          {
            key: 'budgets',
            label: t('personal-ledger.page.tabs.budgets'),
            children: (
              <Pane>
                <BudgetsTab state={state} budgets={dashboard?.budgets ?? []} onChanged={refresh} />
              </Pane>
            )
          },
          {
            key: 'plans',
            label: t('personal-ledger.page.tabs.plans'),
            children: (
              <Pane>
                <PlansTab state={state} plans={plans ?? emptyPlans} onChanged={refresh} />
              </Pane>
            )
          },
          {
            key: 'reports',
            label: t('personal-ledger.page.tabs.reports'),
            children: (
              <Pane>
                <ReportsTab state={state} refreshToken={token} onChanged={refresh} />
              </Pane>
            )
          }
        ]}
      />

      <TransactionForm
        open={formOpen}
        transaction={editing}
        accounts={state.accounts}
        categories={state.categories}
        tags={state.tags}
        merchants={state.merchants}
        members={state.settings.members}
        baseCurrency={state.settings.baseCurrency}
        rates={state.settings.rates}
        templates={state.settings.templates}
        refundables={refundables}
        saving={saving}
        onCancel={() => {
          setFormOpen(false)
          setEditing(null)
        }}
        onSubmit={(input) => void submit(input)}
        onSaveTemplate={(name, input) => void saveTemplate(name, input)}
      />
    </div>
  )
}
