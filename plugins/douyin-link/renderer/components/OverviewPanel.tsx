import { useEffect, useState } from 'react'
import { Segmented } from 'antd'
import { useTranslation } from '@host/renderer/i18n'
import type { MonitorSession, RoomRuntime, RoomSummary, UserRankRow } from '../../shared/types'
import api from '../api'
import { ChartBox, EmptyHint, Panel, type PluginPalette, usePluginPalette } from './ui'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** 统计窗口的候选（分钟） */
export const WINDOWS = [15, 60, 360, 1440] as const

/** 概览多久自动刷一次（监控中是活的，KPI 也要跟着动） */
const RELOAD_MS = 10000

export function windowLabel(t: Translate, minutes: number): string {
  if (minutes <= 15) return t('douyin-link.page.window15')
  if (minutes <= 60) return t('douyin-link.page.window60')
  if (minutes <= 360) return t('douyin-link.page.window6h')
  return t('douyin-link.page.window24h')
}

/**
 * 概览页签：**一个房间的分析报告**（窗口内的 KPI + 分钟趋势 + 类型分布 + 两个榜单）。
 *
 * 数据全部来自数据库（`room-summary` 通道：窗口内的聚合 + 分钟桶 + 用户榜），
 * 页面只负责画——这就是「内容处理搬回主进程」之后的样子：关掉页面数据也不会丢。
 */
export function OverviewPanel(props: {
  room: RoomRuntime | null
  minutes: number
  onMinutes: (minutes: number) => void
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const palette = usePluginPalette()
  const [summary, setSummary] = useState<RoomSummary | null>(null)
  const [sessions, setSessions] = useState<MonitorSession[]>([])
  const [loading, setLoading] = useState(false)
  const webRid = props.room?.webRid ?? ''

  useEffect(() => {
    if (!webRid) {
      setSummary(null)
      setSessions([])
      return
    }
    let alive = true
    const load = (): void => {
      setLoading(true)
      void api
        .roomSummary(webRid, props.minutes)
        .then((next) => {
          if (alive) setSummary(next)
        })
        .catch(() => undefined)
        .finally(() => {
          if (alive) setLoading(false)
        })
      void api
        .sessionsList(webRid, 5)
        .then((rows) => {
          if (alive) setSessions(rows)
        })
        .catch(() => undefined)
    }
    load()
    const timer = window.setInterval(load, RELOAD_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [webRid, props.minutes])

  if (!props.room) return <EmptyHint text={t('douyin-link.page.noActive')} />

  const minutes = windowLabel(t, props.minutes)
  const totals = summary?.totals
  const rate = summary && summary.windowMinutes > 0 ? summary.messages / summary.windowMinutes : 0

  return (
    <div className="grid h-full min-h-0 grid-cols-12 grid-rows-1 gap-3">
      <div className="col-span-8 flex min-h-0 flex-col gap-3">
        <Panel className="shrink-0" title={t('douyin-link.page.kpiTitle', { window: minutes })}>
          <div className="grid grid-cols-4 grid-rows-2 gap-2">
            <Kpi label={t('douyin-link.page.kpiMessages')} value={summary?.messages ?? 0} palette={palette} />
            <Kpi label={t('douyin-link.page.kpiChat')} value={totals?.chat ?? 0} palette={palette} />
            <Kpi
              label={t('douyin-link.page.kpiGift')}
              value={totals?.gift ?? 0}
              hint={t('douyin-link.page.kpiDiamondsValue', { count: totals?.diamonds ?? 0 })}
              palette={palette}
              accent={palette.warn}
            />
            <Kpi label={t('douyin-link.page.kpiMember')} value={totals?.enter ?? 0} palette={palette} />
            <Kpi label={t('douyin-link.page.kpiLike')} value={totals?.like ?? 0} palette={palette} />
            <Kpi label={t('douyin-link.page.kpiSocial')} value={totals?.follow ?? 0} palette={palette} />
            <Kpi label={t('douyin-link.page.kpiUsers')} value={summary?.users ?? 0} palette={palette} />
            <Kpi
              label={t('douyin-link.page.kpiRate')}
              value={Math.round(rate * 10) / 10}
              hint={t('douyin-link.page.perMinute')}
              palette={palette}
            />
          </div>
          <span className="shrink-0 truncate pt-2 text-[10px] opacity-50">
            {sessionsSummary(t, sessions)}
          </span>
        </Panel>

        <Panel className="min-h-0 flex-1" title={t('douyin-link.page.trend')}>
          {!summary || summary.messages === 0 ? (
            <EmptyHint text={loading ? t('douyin-link.page.loading') : t('douyin-link.page.noData')} />
          ) : (
            <ChartBox>
              {(size) => <TrendChart series={summary.series} size={size} palette={palette} />}
            </ChartBox>
          )}
        </Panel>

        <Panel className="shrink-0" title={t('douyin-link.page.kinds')}>
          {!summary || summary.kinds.length === 0 ? (
            <span className="text-xs opacity-50">{t('douyin-link.page.noData')}</span>
          ) : (
            <KindBars kinds={summary.kinds} t={t} palette={palette} />
          )}
        </Panel>
      </div>

      <div className="col-span-4 flex min-h-0 flex-col gap-3">
        <Panel className="min-h-0 flex-1" title={t('douyin-link.page.topChat')}>
          <RankList rows={summary?.topChat ?? []} metric="chat" webRid={webRid} t={t} palette={palette} />
        </Panel>
        <Panel className="min-h-0 flex-1" title={t('douyin-link.page.topGift')}>
          <RankList rows={summary?.topGift ?? []} metric="gift" webRid={webRid} t={t} palette={palette} />
        </Panel>
        <Panel className="shrink-0" title={t('douyin-link.page.range')}>
          <Segmented
            size="small"
            block
            value={props.minutes}
            onChange={(value) => props.onMinutes(Number(value))}
            options={WINDOWS.map((minutes) => ({ value: minutes, label: windowLabel(t, minutes) }))}
          />
        </Panel>
      </div>
    </div>
  )
}

function Kpi(props: {
  label: string
  value: number
  hint?: string
  accent?: string
  palette: PluginPalette
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col rounded-md px-2 py-1.5" style={{ backgroundColor: props.palette.soft }}>
      <span className="truncate text-[10px] opacity-60">{props.label}</span>
      <span className="truncate text-sm font-semibold" style={{ color: props.accent }}>
        {formatNumber(props.value)}
      </span>
      {props.hint ? <span className="truncate text-[10px] opacity-50">{props.hint}</span> : null}
    </div>
  )
}

/** 分钟趋势：堆叠柱（弹幕/礼物/进场/点赞/关注）+ 三条网格线 + 首末时间 */
function TrendChart(props: {
  series: RoomSummary['series']
  size: { width: number; height: number }
  palette: PluginPalette
}): React.JSX.Element {
  const { series, size, palette } = props
  const padLeft = 34
  const padBottom = 16
  const padTop = 8
  const plotWidth = Math.max(10, size.width - padLeft - 8)
  const plotHeight = Math.max(10, size.height - padBottom - padTop)
  // 分钟多的时候合并成桶，柱宽才看得见（最多画 60 根）
  const bucket = Math.max(1, Math.ceil(series.length / 60))
  const buckets: Array<{ at: number; chat: number; gift: number; member: number; like: number; social: number }> = []
  for (let index = 0; index < series.length; index += bucket) {
    const slice = series.slice(index, index + bucket)
    buckets.push({
      at: slice[0]?.minute ?? 0,
      chat: sum(slice, 'chat'),
      gift: sum(slice, 'gift'),
      member: sum(slice, 'member'),
      like: sum(slice, 'like'),
      social: sum(slice, 'social')
    })
  }
  const totals = buckets.map((item) => item.chat + item.gift + item.member + item.like + item.social)
  const max = Math.max(1, ...totals)
  const barWidth = Math.max(1, plotWidth / buckets.length - 1)
  const colors = [palette.accent, palette.warn, palette.up, palette.down, palette.axis]

  return (
    <svg width={size.width} height={size.height} role="img">
      {[0, 0.5, 1].map((ratio) => {
        const y = padTop + plotHeight * ratio
        return (
          <g key={ratio}>
            <line x1={padLeft} x2={size.width - 8} y1={y} y2={y} stroke={palette.split} strokeWidth={1} />
            <text x={padLeft - 6} y={y + 3} textAnchor="end" fontSize={10} fill={palette.axis}>
              {formatNumber(Math.round(max * (1 - ratio)))}
            </text>
          </g>
        )
      })}
      {buckets.map((item, index) => {
        const x = padLeft + index * (plotWidth / buckets.length)
        const parts: Array<[number, string]> = [
          [item.chat, colors[0]],
          [item.gift, colors[1]],
          [item.member, colors[2]],
          [item.like, colors[3]],
          [item.social, colors[4]]
        ]
        let drawn = 0
        return (
          <g key={item.at}>
            {parts.map(([value, color], partIndex) => {
              if (value <= 0) return null
              const height = (value / max) * plotHeight
              const y = padTop + plotHeight - drawn - height
              drawn += height
              return (
                <rect
                  key={partIndex}
                  x={x}
                  y={y}
                  width={barWidth}
                  height={Math.max(0.6, height)}
                  fill={color}
                  opacity={0.85}
                  rx={1}
                />
              )
            })}
          </g>
        )
      })}
      <text x={padLeft} y={size.height - 4} fontSize={10} fill={palette.axis}>
        {clock(buckets[0]?.at ?? 0)}
      </text>
      <text x={size.width - 8} y={size.height - 4} textAnchor="end" fontSize={10} fill={palette.axis}>
        {clock(buckets[buckets.length - 1]?.at ?? 0)}
      </text>
    </svg>
  )
}

function KindBars(props: {
  kinds: Array<{ kind: string; count: number }>
  t: Translate
  palette: PluginPalette
}): React.JSX.Element {
  const max = Math.max(1, ...props.kinds.map((entry) => entry.count))
  const total = props.kinds.reduce((sum, entry) => sum + entry.count, 0) || 1
  return (
    <div className="flex flex-col gap-1.5">
      {props.kinds.map((entry) => (
        <div key={entry.kind} className="flex min-w-0 items-center gap-2 text-[10px]">
          <span className="w-12 shrink-0 truncate opacity-60">{props.t(`douyin-link.kinds.${entry.kind}`)}</span>
          <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full" style={{ backgroundColor: props.palette.track }}>
            <span
              className="block h-full rounded-full"
              style={{ width: `${Math.max(2, (entry.count / max) * 100)}%`, backgroundColor: props.palette.accent }}
            />
          </span>
          <span className="w-20 shrink-0 text-right">
            {formatNumber(entry.count)}
            <span className="opacity-50"> · {Math.round((entry.count / total) * 100)}%</span>
          </span>
        </div>
      ))}
    </div>
  )
}

function RankList(props: {
  rows: UserRankRow[]
  metric: 'chat' | 'gift'
  webRid: string
  t: Translate
  palette: PluginPalette
}): React.JSX.Element {
  if (props.rows.length === 0) return <span className="text-xs opacity-50">{props.t('douyin-link.page.noData')}</span>
  const max = Math.max(
    1,
    ...props.rows.map((row) => (props.metric === 'chat' ? row.stats.chat : row.stats.diamonds))
  )
  return (
    <div className="flex flex-col gap-1.5">
      {props.rows.slice(0, 8).map((row, index) => {
        const value = props.metric === 'chat' ? row.stats.chat : row.stats.diamonds
        return (
          <div key={row.userId} className="flex min-w-0 items-center gap-2 text-[10px]">
            <span className="w-4 shrink-0 text-right opacity-50">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate">{row.nickname || row.userId}</span>
            <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full" style={{ backgroundColor: props.palette.track }}>
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${Math.max(3, (value / max) * 100)}%`,
                  backgroundColor: props.metric === 'chat' ? props.palette.accent : props.palette.warn
                }}
              />
            </span>
            <span className="w-14 shrink-0 text-right font-medium">{formatNumber(value)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** 「监控会话」一行摘要：最近一次跑了多久、收了多少，以及总共监控过几次 */
function sessionsSummary(t: Translate, sessions: MonitorSession[]): string {
  if (sessions.length === 0) return t('douyin-link.page.noSessions')
  const latest = sessions[0]
  const span = latest.endedAt > 0 ? latest.endedAt - latest.startedAt : Date.now() - latest.startedAt
  return t('douyin-link.page.sessionsLine', {
    time: stamp(latest.startedAt),
    duration: duration(span),
    count: latest.messages,
    total: sessions.length
  })
}

function sum(rows: RoomSummary['series'], key: 'chat' | 'gift' | 'member' | 'like' | 'social'): number {
  return rows.reduce((total, row) => total + row[key], 0)
}

export function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

export function clock(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function stamp(at: number): string {
  if (!at) return '-'
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}
