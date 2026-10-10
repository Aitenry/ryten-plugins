import { useCallback, useEffect, useState } from 'react'
import { Button, Input, InputNumber, Select, Switch, Typography } from 'antd'
import { useTranslation } from '@host/renderer/i18n'
import {
  DANMAKU_KINDS,
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

