import { useCallback, useEffect, useState } from 'react'
import { Button, InputNumber, Select, Switch, Typography } from 'antd'
import { useTranslation } from '@host/renderer/i18n'
import {
  DANMAKU_KINDS,
  type DanmakuKind,
  type DbStats,
  type LiveSettings
} from '../shared/types'
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

  const load = useCallback(async (): Promise<void> => {
    const [snapshot, db] = await Promise.all([api.snapshot(), api.dbStats()])
    // api 层已归一化；这里只防「这个通道将来换实现」（拿不到就是空态，别炸白屏）
    setSettings(snapshot?.settings ?? null)
    setStats(db ?? null)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (patch: Partial<LiveSettings>): Promise<void> => {
    setSettings(await api.setSettings(patch))
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

        <Row label={t('douyin-link.settingsPage.realtimeLabel')} hint={t('douyin-link.settingsPage.realtimeHint')}>
          <Switch
            size="small"
            checked={settings?.realtimeStream ?? true}
            onChange={(value) => void save({ realtimeStream: value })}
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

function Row(props: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col">
        <span>{props.label}</span>
        {props.hint ? (
          <span className="text-xs" style={{ opacity: 0.6 }}>
            {props.hint}
          </span>
        ) : null}
      </div>
      <div className="shrink-0">{props.children}</div>
    </div>
  )
}

