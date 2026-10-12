import { useCallback, useEffect, useState } from 'react'
import { Button, Input, InputNumber, Select, Switch, Typography } from 'antd'
import { useTranslation } from '@host/renderer/i18n'
import {
  DANMAKU_KINDS,
  type AiPortraitModel,
  type DanmakuKind,
  type DbStats,
  type LiveSettings
} from '../shared/types'
import { COOKIE_MAX_LENGTH, clampCookie, cookieHealth } from '../shared/cookie'
import api from './api'

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * 抖音直播分析器 的设置页（设置 → 助手 → 本插件）。
 *
 * 观感照 WORKSHOP 6.6：**一行一个字段**，标签在左、控件在右，
 * 不做装饰性分组标题、不加展示面板；说明文字放进字段自己的 hint 里。
 * 改一项存一项（开关/下拉立即存，数字框在改完就存）。
 *
 * 这里的每一项都对应主进程的一个行为（见 `main/monitor/hub.ts` 的 DEFAULT_SETTINGS 注释），
 * 尤其是 **「启动时接着监控上次的房间」（默认关）**：上一版就是启动时自动连上
 * 「上次那个直播间」，用户看到的是「一开应用又冒出原来的直播间」。
 */
export default function Settings(): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const [settings, setSettings] = useState<LiveSettings | null>(null)
  const [stats, setStats] = useState<DbStats | null>(null)
  const [cleaning, setCleaning] = useState(false)
  /** 导入/导出的进行中状态（空串 = 空闲） */
  const [busy, setBusy] = useState<'export' | 'import' | ''>('')
  /** 导入/导出结果提示（一句话；成功与失败共用一行） */
  const [notice, setNotice] = useState('')
  /** 登录态 Cookie 的本地草稿（失焦才存，别每敲一个字就写盘） */
  const [cookieDraft, setCookieDraft] = useState('')
  /**
   * 「AI 画像」可选的模型清单（**不含 api_key**：主进程只挑 id/名字/模型名发过来）。
   * `null` = 还在读（下拉显示 loading）；`[]` = 一个可用供应商都没有（空态给一句说明）。
   */
  const [portraitModels, setPortraitModels] = useState<AiPortraitModel[] | null>(null)
  /**
   * 上一次存盘时**被上限截掉前的字符数**（0 = 没被截）。
   *
   * 为什么要记这个数：截断是主进程做的，存完回来的草稿已经是砍过的那一份——
   * 只在 `cookieDraft.length` 上做判断永远看不出「刚才被砍了」，界面就会安静地骗人
   * （2026-10-10 的 4096 静默截断事故：输入框里看着完整，实际存下去的是前半截）。
   */
  const [cookieClampedFrom, setCookieClampedFrom] = useState(0)

  const load = useCallback(async (): Promise<void> => {
    const [snapshot, db] = await Promise.all([api.snapshot(), api.dbStats()])
    // api 层已归一化；这里只防「这个通道将来换实现」（拿不到就是空态，别炸白屏）
    setSettings(snapshot?.settings ?? null)
    setStats(db ?? null)
  }, [])

  useEffect(() => {
    void load()
    // 模型清单独立于快照：读失败就当「没有可选模型」，不影响设置页其它字段
    void api
      .aiPortraitModels()
      .then((models) => setPortraitModels(models))
      .catch(() => setPortraitModels([]))
  }, [load])

  /** 设置从主进程回来后对齐草稿（外部改动/首次加载） */
  useEffect(() => {
    setCookieDraft(settings?.douyinCookie ?? '')
  }, [settings?.douyinCookie])

  const save = async (patch: Partial<LiveSettings>): Promise<void> => {
    setSettings(await api.setSettings(patch))
  }

  /**
   * 存 Cookie：存完**比一下长度**——短了就是被上限截了（主进程只留前 N 个字符）。
   * 顺便把主进程回来的那份（已归一化）当准：界面显示的就是真正会发出去的那一行。
   */
  const saveCookie = async (): Promise<void> => {
    const draft = cookieDraft
    if (draft === (settings?.douyinCookie ?? '')) return
    const sent = clampCookie(draft).length
    const next = await api.setSettings({ douyinCookie: draft })
    setSettings(next)
    setCookieClampedFrom(sent > next.douyinCookie.length ? sent : 0)
  }

  /**
   * Cookie 那一行底下要说的话（**只在真有问题时说**，平时一个字都不显示）：
   * 被上限截了；或者这份 cookie 里根本没有 `sessionid` / `ttwid`（匿名会话：弹幕能收、礼物收不到）。
   */
  const cookieAlert = ((): string => {
    if (cookieClampedFrom > 0) {
      return t('douyin-link.settingsPage.cookieTruncated', {
        length: cookieClampedFrom,
        max: COOKIE_MAX_LENGTH
      })
    }
    if (!cookieDraft.trim()) return ''
    const health = cookieHealth(cookieDraft)
    if (health.missing.length === 0) return ''
    return t('douyin-link.settingsPage.cookieAnonymous', { missing: health.missing.join(' / ') })
  })()

  /**
   * 「AI 画像模型」下拉里显示哪一个：**存过的就用存过的**，没存过就用**宿主默认**
   * （没有默认就是已启用的第一个）—— 与主进程 `resolveProviderId` 的回退链一致，
   * 所以「显示的」就是「下一次生成实际会用的」。
   */
  const portraitModelId = ((): number | undefined => {
    const stored = settings?.portraitProviderId
    if (typeof stored === 'number' && stored > 0) return stored
    const models = portraitModels ?? []
    return (models.find((model) => model.isDefault) ?? models[0])?.id
  })()

  /** 取消（用户按了取消）与失败用的是同一个提示位，靠 message 键区分 */
  const runExport = (): void => {
    setBusy('export')
    setNotice('')
    void api
      .exportArchive()
      .then((result) => {
        if (result.ok) {
          setNotice(
            t('douyin-link.settingsPage.exportDone', {
              rooms: result.rooms,
              days: result.days,
              messages: result.messages
            })
          )
        } else {
          setNotice(
            result.message === 'cancelled'
              ? t('douyin-link.settingsPage.actionCancelled')
              : t('douyin-link.settingsPage.actionFailed', { detail: result.message ?? '' })
          )
        }
      })
      .finally(() => setBusy(''))
  }

  const runImport = (): void => {
    setBusy('import')
    setNotice('')
    void api
      .importArchive()
      .then((result) => {
        if (result.ok) {
          setNotice(
            t('douyin-link.settingsPage.importDone', {
              rooms: result.rooms,
              messages: result.messages,
              skipped: result.skipped,
              users: result.users
            })
          )
          return load()
        }
        setNotice(
          result.message === 'cancelled'
            ? t('douyin-link.settingsPage.actionCancelled')
            : result.message === 'badFormat'
              ? t('douyin-link.settingsPage.importBadFormat')
              : t('douyin-link.settingsPage.actionFailed', { detail: result.message ?? '' })
        )
      })
      .finally(() => setBusy(''))
  }

  return (
    <div>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {t('douyin-link.settings.title')}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        {t('douyin-link.settingsPage.intro')}
      </Typography.Paragraph>

      <div className="flex max-w-[640px] flex-col gap-4">
        <Row label={t('douyin-link.settingsPage.concurrencyLabel')} hint={t('douyin-link.settingsPage.concurrencyHint')}>
          <InputNumber
            size="small"
            min={1}
            max={8}
            style={{ width: 96 }}
            value={settings?.monitorConcurrency ?? 3}
            onChange={(value) => {
              if (typeof value === 'number') void save({ monitorConcurrency: value })
            }}
          />
        </Row>

        <Row
          label={t('douyin-link.settingsPage.resumeLabel')}
          hint={t('douyin-link.settingsPage.resumeHint')}
        >
          <Switch
            size="small"
            checked={settings?.resumeOnStart ?? false}
            onChange={(value) => void save({ resumeOnStart: value })}
          />
        </Row>

        <Row label={t('douyin-link.settingsPage.maxItemsLabel')}>
          <InputNumber
            size="small"
            min={50}
            max={1000}
            step={50}
            style={{ width: 96 }}
            value={settings?.maxItems ?? 200}
            onChange={(value) => {
              if (typeof value === 'number') void save({ maxItems: value })
            }}
          />
        </Row>

        {/*
          「AI 画像」用哪个模型（用户 2026-10-13：「设置页指定模型」）。
          只列**已启用**的供应商（清单由主进程给，**不含 api_key**）；**不再有「跟随默认模型」那个选项**
          （用户 2026-10-13：「不要有默认模型选项」）—— 没选过时下拉直接显示**实际会用的那一个**
          （宿主默认，没有默认就是第一个启用），选谁就存谁，所见即所用。
          `· 宿主默认` 只是个标记（AI 助手后台任务用的就是它），不是可选项。
        */}
        <Row
          label={t('douyin-link.settingsPage.portraitModelLabel')}
          hint={t('douyin-link.settingsPage.portraitModelHint')}
        >
          {/*
            `data-rb-portrait-model`：给工装一个**稳定钩子**（antd 6 的 Select 内部结构换过名字：
            `.ant-select-selector` → `.ant-select-content`，而页面上有两个 Select，
            按类名取会抓错那一个多选）。仓库里可滚区/可点块也是这么标的（`data-rb-scroll` 等）。
          */}
          <span data-rb-portrait-model="" className="inline-flex">
            <Select
              size="small"
              style={{ width: 360 }}
              loading={portraitModels === null}
              value={portraitModelId}
              onChange={(value) => void save({ portraitProviderId: Number(value) })}
              options={(portraitModels ?? []).map((model) => {
                /**
                 * 本地 Ollama 的供应商常常就用模型名命名（`qwen3.5-9b-32k:latest`），
                 * 那时 `名字（模型）` 会写成「A（A）」——相同就只写一遍。
                 */
                const name = model.name || model.model
                const title = name === model.model ? model.model : `${name}（${model.model}）`
                return {
                  value: model.id,
                  label: `${title}${model.isDefault ? ` · ${t('douyin-link.settingsPage.portraitModelDefault')}` : ''}`
                }
              })}
              notFoundContent={t('douyin-link.settingsPage.portraitModelEmpty')}
            />
          </span>
        </Row>

        {/*
          「关掉本地模型的思考」（用户 2026-10-13 报本地 ollama 模型报错之后加的）。
          实测数字写在 hint 里：思考型小模型会把输出预算全烧在推理上，正文一个字都不出。
        */}
        <Row
          label={t('douyin-link.settingsPage.portraitNoThinkLabel')}
          hint={t('douyin-link.settingsPage.portraitNoThinkHint')}
        >
          <span data-rb-portrait-nothink="" className="inline-flex">
            <Switch
              size="small"
              checked={settings?.portraitDisableThinking === true}
              onChange={(value) => void save({ portraitDisableThinking: value })}
            />
          </span>
        </Row>

        <Row label={t('douyin-link.settingsPage.kindsLabel')}>
          <Select
            size="small"
            mode="multiple"
            style={{ width: 360 }}
            value={settings?.kinds ?? []}
            onChange={(value) => void save({ kinds: value as DanmakuKind[] })}
            options={DANMAKU_KINDS.map((kind) => ({ value: kind, label: t(`douyin-link.kinds.${kind}`) }))}
          />
        </Row>

        <Row label={t('douyin-link.settingsPage.autoScrollLabel')}>
          <Switch
            size="small"
            checked={settings?.autoScroll ?? true}
            onChange={(value) => void save({ autoScroll: value })}
          />
        </Row>

        {/*
          「按人民币显示金额」（用户 2026-10-12）：打开后**整页**金额都按 1 元 = 10 抖币换算展示
          （数值 ÷ 10、单位换「元」），库里仍按抖币原值存——换回来不动任何数据。
          `data-rb-cny-display`：给工装一个稳定钩子（页面上有多个 Switch，按类名取会抓错）。
        */}
        <Row
          label={t('douyin-link.settingsPage.cnyDisplayLabel')}
          hint={t('douyin-link.settingsPage.cnyDisplayHint')}
        >
          <span data-rb-cny-display="" className="inline-flex">
            <Switch
              size="small"
              checked={settings?.cnyDisplay === true}
              onChange={(value) => void save({ cnyDisplay: value })}
            />
          </span>
        </Row>

        <Row
          label={t('douyin-link.settingsPage.cookieLabel')}
          hint={t('douyin-link.settingsPage.cookieHint')}
          alert={cookieAlert}
        >
          <Input.TextArea
            size="small"
            autoSize={{ minRows: 2, maxRows: 5 }}
            style={{ width: 420, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
            placeholder={t('douyin-link.settingsPage.cookiePlaceholder')}
            value={cookieDraft}
            onChange={(event) => setCookieDraft(event.target.value)}
            onBlur={() => void saveCookie()}
          />
        </Row>

        <Row label={t('douyin-link.settingsPage.retentionLabel')} hint={t('douyin-link.settingsPage.retentionHint')}>
          <div className="flex items-center gap-2">
            <InputNumber
              size="small"
              min={0}
              max={365}
              style={{ width: 96 }}
              value={settings?.retentionDays ?? 7}
              onChange={(value) => {
                if (typeof value === 'number') void save({ retentionDays: value })
              }}
            />
            <Button
              size="small"
              loading={cleaning}
              onClick={() => {
                setCleaning(true)
                void api
                  .cleanup()
                  .then(() => load())
                  .finally(() => setCleaning(false))
              }}
            >
              {t('douyin-link.settingsPage.cleanupNow')}
            </Button>
          </div>
        </Row>

        <Row label={t('douyin-link.settingsPage.importExportLabel')} hint={t('douyin-link.settingsPage.importExportHint')}>
          <div className="flex items-center gap-2">
            <Button size="small" loading={busy === 'export'} disabled={busy !== ''} onClick={runExport}>
              {t('douyin-link.settingsPage.exportButton')}
            </Button>
            <Button size="small" loading={busy === 'import'} disabled={busy !== ''} onClick={runImport}>
              {t('douyin-link.settingsPage.importButton')}
            </Button>
          </div>
        </Row>

        {notice ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {notice}
          </Typography.Text>
        ) : null}

        {stats ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('douyin-link.settingsPage.storageHint', {
              rooms: stats.rooms,
              messages: stats.messages,
              users: stats.users,
              minutes: stats.minutes,
              sessions: stats.sessions
            })}
          </Typography.Text>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 一行一个字段：**标签在左、控件在右**（照 WORKSHOP 6.6），说明文字放在**整行的下方**。
 *
 * 为什么说明不放标签那一列（用户 2026-10-10：设置里那个输入框「好丑」时的根因）：
 * 说明往往很长（如 Cookie 那条），挤在标签列里只能窄窄地折成好多行，还会把右侧控件顶到
 * 容器外、显得又挤又乱。放到整行下方就能用满宽度、只占两三行，标签与控件那一行始终清爽。
 *
 * `alert` 是**同一版式下的第二行**，只在真有问题时给（目前只有 Cookie 那条用）：
 * 它说的不是「这个字段怎么用」，而是「你刚填的这一份有问题」——用告警色与说明区分开。
 */
function Row(props: {
  label: string
  hint?: string
  alert?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-4">
        <span className="min-w-0 truncate">{props.label}</span>
        <div className="shrink-0">{props.children}</div>
      </div>
      {props.hint ? (
        <span className="text-xs leading-5" style={{ opacity: 0.6 }}>
          {props.hint}
        </span>
      ) : null}
      {props.alert ? (
        <Typography.Text type="danger" style={{ fontSize: 12, lineHeight: '20px' }}>
          {props.alert}
        </Typography.Text>
      ) : null}
    </div>
  )
}

