import { useEffect, useState } from 'react'
import { Button, Slider, theme } from 'antd'
import { useTranslation } from '@host/renderer/i18n'
import type { GiftRankRow, MonitorSession, RoomRuntime, RoomSummary, UserRankRow } from '../../shared/types'
import api from '../api'
import { ChartBox, EmptyHint, Panel, ScrollStyle, type PluginPalette, usePluginPalette } from './ui'

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * 统计窗口的候选（分钟）。**0 = 全部**（库里最早一条到现在）——
 * 固定窗口会把更早的礼物从榜上抹掉，看着就像「礼物不断消失」；默认永久保存之后，
 * 「全部」才是这套数据的自然口径。
 */
export const WINDOWS = [15, 60, 360, 1440, 0] as const

/** 概览多久自动刷一次（监控中是活的，KPI 也要跟着动） */
const RELOAD_MS = 10000

export function windowLabel(t: Translate, minutes: number): string {
  if (minutes <= 0) return t('douyin-link.page.windowAll')
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
  /** 时间范围（进度条拖出来的那一段；`null` = 用最近 `minutes` 分钟的预设） */
  range: { from: number; to: number } | null
  onRange: (range: { from: number; to: number } | null) => void
  /** 进度条两端：这个房间库里最早/最近的消息（没数据时 null） */
  bounds: { first: number; last: number } | null
  minutes: number
  /**
   * 点礼物榜的一行 → 打开这个人的礼物历史。
   * 参数就是榜上那一行（`userId` / 昵称 / 方向：`sent` = 他送的、`received` = 他收到的）。
   */
  onOpenGifts: (target: { userId: string; name: string; direction: 'sent' | 'received' }) => void
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const palette = usePluginPalette()
  const [summary, setSummary] = useState<RoomSummary | null>(null)
  const [sessions, setSessions] = useState<MonitorSession[]>([])
  const [loading, setLoading] = useState(false)
  const webRid = props.room?.webRid ?? ''
  const rangeFrom = props.range?.from ?? 0
  const rangeTo = props.range?.to ?? 0

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
        .roomSummary(
          webRid,
          props.minutes,
          rangeFrom > 0 && rangeTo > rangeFrom ? { from: rangeFrom, to: rangeTo } : undefined
        )
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
  }, [webRid, props.minutes, rangeFrom, rangeTo])

  if (!props.room) return <EmptyHint text={t('douyin-link.page.noActive')} />

  /**
   * 标题上的「看的是哪一段」：**同一天**只写一次日期（`10-09 00:00 → 00:23`）——
   * 进度条只在一天之内，所以跨天那种写法基本见不到（真跨了就两段都带日期，不藏信息）。
   */
  const sameDay = rangeFrom > 0 && new Date(rangeFrom).toDateString() === new Date(rangeTo).toDateString()
  const rangeText =
    rangeFrom > 0 && rangeTo > rangeFrom
      ? sameDay
        ? `${stamp(rangeFrom)} → ${clock(rangeTo)}`
        : `${stamp(rangeFrom)} → ${stamp(rangeTo)}`
      : t('douyin-link.page.kpiRecent', { window: windowLabel(t, props.minutes) })
  const totals = summary?.totals
  /**
   * 「平均速率」的分母：有明确区间就用区间长度，否则用窗口分钟数；**全部**模式（windowMinutes = 0）
   * 按库里首末消息的实际跨度算（否则除零得到 Infinity）。
   */
  const spanMinutes =
    rangeFrom > 0 && rangeTo > rangeFrom
      ? (rangeTo - rangeFrom) / 60000
      : summary && summary.windowMinutes > 0
        ? summary.windowMinutes
        : summary && summary.lastAt > summary.firstAt
          ? (summary.lastAt - summary.firstAt) / 60000
          : 0
  const rate = summary && spanMinutes > 0 ? summary.messages / spanMinutes : 0

  return (
    <div className="grid h-full min-h-0 grid-cols-12 grid-rows-1 gap-3">
      <div className="col-span-8 flex min-h-0 flex-col gap-3">
        <Panel className="shrink-0" title={t('douyin-link.page.kpiTitle', { window: rangeText })}>
          <div className="grid grid-cols-3 grid-rows-3 gap-2">
            <Kpi label={t('douyin-link.page.kpiMessages')} value={summary?.messages ?? 0} palette={palette} />
            <Kpi label={t('douyin-link.page.kpiChat')} value={totals?.chat ?? 0} palette={palette} />
            <Kpi label={t('douyin-link.page.kpiMember')} value={totals?.enter ?? 0} palette={palette} />
            <Kpi label={t('douyin-link.page.kpiLike')} value={totals?.like ?? 0} palette={palette} />
            <Kpi label={t('douyin-link.page.kpiSocial')} value={totals?.follow ?? 0} palette={palette} />
            <Kpi
              label={t('douyin-link.page.kpiGift')}
              value={totals?.gift ?? 0}
              accent={palette.warn}
              palette={palette}
            />
            <Kpi
              label={t('douyin-link.page.kpiDiamonds')}
              value={summary?.diamonds ?? 0}
              hint={t('douyin-link.page.kpiDiamondsUnit')}
              accent={palette.warn}
              palette={palette}
            />
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
              {(size) => <TrendChart series={summary.series} size={size} palette={palette} t={t} />}
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
          <RankList rows={summary?.topChat ?? []} webRid={webRid} t={t} palette={palette} />
        </Panel>
        {/*
          收礼物榜 / 送礼物榜（用户 2026-10-08 的要求）：
          「礼物榜（送了什么 · 值多少）」那种按礼物名的榜单去掉了括号里的说明，拆成两张**按人**的榜：
          - 收礼物榜**只要麦上的人**（谁在麦上收了礼物、收了多少值），点一行看他收到的礼物历史；
          - 送礼物榜是谁送出的最值钱，点一行看他送出的礼物历史。
        */}
        <Panel className="min-h-0 flex-1" title={t('douyin-link.page.giftReceivedBoard')}>
          <GiftRankBoard
            rows={summary?.received ?? []}
            direction="received"
            t={t}
            palette={palette}
            onOpen={props.onOpenGifts}
          />
        </Panel>
        <Panel className="min-h-0 flex-1" title={t('douyin-link.page.giftSentBoard')}>
          <GiftRankBoard
            rows={summary?.sent ?? []}
            direction="sent"
            t={t}
            palette={palette}
            onOpen={props.onOpenGifts}
          />
        </Panel>
        {/*
          时间范围：**一条时间进度条**（用户 2026-10-08：「统计窗口按照时间进度条来构建」）。
          两端是这个房间库里最早/最近的消息，拖两个把手就是选一段；「每日记录」点一天也走同一段区间
          （所以「看某一天」不需要另一套控件）。取消选择 = 回到最近 `minutes` 分钟的预设。
        */}
        <Panel className="shrink-0" title={t('douyin-link.page.range')}>
          {props.bounds && props.bounds.last > props.bounds.first ? (
            <div className="flex flex-col gap-1">
              <Slider
                range
                min={props.bounds.first}
                max={props.bounds.last}
                value={[
                  rangeFrom > 0 ? rangeFrom : Math.max(props.bounds.first, props.bounds.last - 3600 * 1000),
                  rangeTo > 0 ? rangeTo : props.bounds.last
                ]}
                tooltip={{ formatter: (value) => stamp(Number(value)) }}
                onChange={(value) => {
                  const [from, to] = value as number[]
                  props.onRange(from > 0 && to > from ? { from, to } : null)
                }}
              />
              <div className="flex items-center justify-between gap-2 text-[10px] opacity-60">
                <span className="shrink-0">{stamp(props.bounds.first)}</span>
                <span className="min-w-0 truncate font-medium">{rangeText}</span>
                <span className="shrink-0">{stamp(props.bounds.last)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] opacity-50">
                  {t('douyin-link.page.rangeSpan', { duration: duration((rangeTo || props.bounds.last) - (rangeFrom || props.bounds.first)) })}
                </span>
                {/* 重置 = 「这一天全部」（时间范围不跨天，所以回到的不是「最近 N 分钟」而是整段这一天） */}
                {props.range ? (
                  <Button size="small" type="text" onClick={() => props.onRange(null)}>
                    {t('douyin-link.page.rangeWholeDay')}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <span className="text-xs opacity-50">{t('douyin-link.page.rangeEmpty')}</span>
          )}
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

/** 分钟趋势：堆叠柱（弹幕/进场/点赞/关注/礼物）+ 三条网格线 + 首末时间 */
/** 趋势图的系列：顺序 = 堆叠顺序 = 图例顺序 = 悬浮面板的行顺序（一份定义，三处共用） */
const TREND_KEYS = ['chat', 'member', 'like', 'social', 'gift'] as const
type TrendKey = (typeof TREND_KEYS)[number]

/**
 * 分钟趋势：堆叠柱（弹幕/进场/点赞/关注/礼物）+ 三条网格线 + 首末时间。
 *
 * **图例 + 悬浮信息**（用户 2026-10-08：「鼠标放上去需要显示信息，不然我怎么知道是什么东西」）：
 * - 图例常驻在图上方：五个色块配名字，不用悬停就知道哪根柱子是什么；
 * - 悬停到某根柱子上：柱子上打一条竖线、那一根提亮，旁边弹出**结构化面板**
 *   （标题行 = 这段时间 + 合计，发丝线，下面按系列左右对齐列数字）。
 */
function TrendChart(props: {
  series: RoomSummary['series']
  size: { width: number; height: number }
  palette: PluginPalette
  t: Translate
}): React.JSX.Element {
  const { series, size, palette, t } = props
  const { token } = theme.useToken()
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null)
  const legendHeight = 18
  const padLeft = 34
  const padBottom = 16
  const padTop = 8
  const svgHeight = Math.max(48, size.height - legendHeight)
  const plotWidth = Math.max(10, size.width - padLeft - 8)
  const plotHeight = Math.max(10, svgHeight - padBottom - padTop)
  // 分钟多的时候合并成桶，柱宽才看得见（最多画 60 根）
  const bucket = Math.max(1, Math.ceil(series.length / 60))
  const buckets: Array<{ at: number; chat: number; member: number; like: number; social: number; gift: number }> = []
  for (let index = 0; index < series.length; index += bucket) {
    const slice = series.slice(index, index + bucket)
    buckets.push({
      at: slice[0]?.minute ?? 0,
      chat: sum(slice, 'chat'),
      member: sum(slice, 'member'),
      like: sum(slice, 'like'),
      social: sum(slice, 'social'),
      gift: sum(slice, 'gift')
    })
  }
  const totals = buckets.map((item) => item.chat + item.member + item.like + item.social + item.gift)
  const max = Math.max(1, ...totals)
  const step = plotWidth / Math.max(1, buckets.length)
  const barWidth = Math.max(1, step - 1)
  const colors: Record<TrendKey, string> = {
    chat: palette.accent,
    member: palette.up,
    like: palette.down,
    social: palette.axis,
    gift: palette.warn
  }
  const last = buckets.length > 0 ? buckets[buckets.length - 1].at + (bucket - 1) * 60000 : 0
  const spansDays = buckets.length > 0 && new Date(buckets[0].at).toDateString() !== new Date(last).toDateString()
  /** 这一根柱子代表的时间段（合并成粗桶时要写清「从几点到几点」） */
  const bucketLabel = (at: number): string => {
    const head = spansDays ? stamp(at) : clock(at)
    return bucket > 1 ? `${head} → ${clock(at + (bucket - 1) * 60000)}` : head
  }
  const hovered = hover ? buckets[hover.index] : null
  const hoveredIndex = hover?.index ?? -1

  return (
    /* 显式尺寸 + relative：悬浮面板是 absolute，参照物必须是图表自己的盒子
       （父容器 ChartBox 的高度是 flex 算出来的，`h-full` 会退化成 0，面板就会跑到面板外面去） */
    <div className="relative" style={{ width: size.width, height: size.height }}>
      {/* 图例：五个系列的名字与颜色（悬浮面板里是同一份顺序） */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px]" style={{ height: legendHeight }}>
        {TREND_KEYS.map((key) => (
          <span key={key} className="flex items-center gap-1" style={{ color: palette.axis }}>
            <span className="inline-block rounded-sm" style={{ width: 8, height: 8, backgroundColor: colors[key] }} />
            {t(`douyin-link.kinds.${key}`)}
          </span>
        ))}
      </div>
      <svg
        width={size.width}
        height={svgHeight}
        role="img"
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const x = event.clientX - rect.left
          const y = event.clientY - rect.top
          const index = Math.floor((x - padLeft) / step)
          if (index < 0 || index >= buckets.length) setHover(null)
          else setHover({ index, x, y })
        }}
        onMouseLeave={() => setHover(null)}
      >
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
          const x = padLeft + index * step
          let drawn = 0
          return (
            <g key={item.at}>
              {TREND_KEYS.map((key) => {
                const value = item[key]
                if (value <= 0) return null
                const height = (value / max) * plotHeight
                const y = padTop + plotHeight - drawn - height
                drawn += height
                return (
                  <rect
                    key={key}
                    x={x}
                    y={y}
                    width={barWidth}
                    height={Math.max(0.6, height)}
                    fill={colors[key]}
                    // 悬停的那一根提亮，别让它融在一堆柱子里
                    opacity={hoveredIndex < 0 || hoveredIndex === index ? 0.9 : 0.45}
                    rx={1}
                  />
                )
              })}
            </g>
          )
        })}
        {hover ? (
          <line
            x1={padLeft + hover.index * step + step / 2}
            x2={padLeft + hover.index * step + step / 2}
            y1={padTop}
            y2={padTop + plotHeight}
            stroke={palette.accent}
            strokeWidth={1}
            strokeDasharray="2 2"
            opacity={0.7}
          />
        ) : null}
        <text x={padLeft} y={svgHeight - 4} fontSize={10} fill={palette.axis}>
          {clock(buckets[0]?.at ?? 0)}
        </text>
        <text x={size.width - 8} y={svgHeight - 4} textAnchor="end" fontSize={10} fill={palette.axis}>
          {clock(last)}
        </text>
      </svg>
      {/* 悬浮面板：标题行 + 发丝线 + 左右对齐的明细（不用一行字符串 tooltip） */}
      {hovered && hover ? (
        <div
          className="pointer-events-none absolute rounded-md px-2 py-1.5 text-[10px]"
          style={{
            left: Math.min(Math.max(4, hover.x + 14), Math.max(4, size.width - 152)),
            top:
              hover.y + 14 + 104 > size.height
                ? Math.max(2, hover.y - 104 - 8)
                : hover.y + 14,
            width: 148,
            backgroundColor: token.colorBgElevated,
            border: `1px solid ${palette.split}`,
            boxShadow: token.boxShadowSecondary,
            color: palette.text
          }}
        >
          <div className="flex items-baseline justify-between gap-2 font-medium">
            <span className="min-w-0 truncate">{bucketLabel(hovered.at)}</span>
            <span style={{ color: palette.warn }}>{formatNumber(totals[hover.index])}</span>
          </div>
          <div className="mt-1 border-t pt-1" style={{ borderColor: palette.split }}>
            {TREND_KEYS.map((key) => (
              <div key={key} className="flex items-baseline justify-between gap-2">
                <span className="flex items-center gap-1" style={{ color: palette.axis }}>
                  <span
                    className="inline-block rounded-sm"
                    style={{ width: 6, height: 6, backgroundColor: colors[key] }}
                  />
                  {t(`douyin-link.kinds.${key}`)}
                </span>
                <span>{formatNumber(hovered[key])}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
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

/**
 * 礼物榜（收礼 / 送礼共用一张）：**一行一个人**——名字 · 件数 · 抖币，点一行看他的礼物历史。
 *
 * 两个口径的差别只有三点：收礼榜的行带麦位号（只列麦上的人）、空态文案、点开的历史方向。
 * 抖币拿不到（官方没给价）的行显示「价值未知」，不写成 0。
 */
function GiftRankBoard(props: {
  rows: GiftRankRow[]
  direction: 'sent' | 'received'
  t: Translate
  palette: PluginPalette
  onOpen: (target: { userId: string; name: string; direction: 'sent' | 'received' }) => void
}): React.JSX.Element {
  const { rows, direction, t, palette } = props
  if (rows.length === 0) {
    return (
      <span className="text-xs opacity-50">
        {t(direction === 'received' ? 'douyin-link.page.giftReceivedEmpty' : 'douyin-link.page.giftSentEmpty')}
      </span>
    )
  }
  const max = Math.max(1, ...rows.map((row) => (row.diamonds > 0 ? row.diamonds : row.count)))
  return (
    /* 榜长超过面板高度时**面板内自己滚**（不放滚动条就会把下面的行截掉、看不见）；
       行数上限交给数据库（每张榜最多 30 行），这里不再 slice。 */
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollStyle />
      <div data-rb-scroll="" className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
        {rows.map((row) => {
          const value = row.diamonds > 0 ? row.diamonds : row.count
          return (
            <button
              key={row.userId}
              type="button"
              data-rb-row=""
              className="flex min-w-0 cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left text-[10px]"
              title={t('douyin-link.page.giftRowHint')}
              onClick={() => props.onOpen({ userId: row.userId, name: row.name, direction })}
            >
              {direction === 'received' ? (
                <span
                  className="w-6 shrink-0 truncate opacity-50"
                  title={t('douyin-link.page.seatLabel', { seat: row.seat })}
                >
                  {row.seat > 0 ? `${row.seat}号` : ''}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate" title={row.name || row.userId}>
                {row.name || row.userId}
              </span>
              <span
                className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full"
                style={{ backgroundColor: palette.track }}
              >
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${Math.max(3, (value / max) * 100)}%`, backgroundColor: palette.warn }}
                />
              </span>
              <span className="w-8 shrink-0 text-right opacity-60">×{formatNumber(row.count)}</span>
              <span className="w-16 shrink-0 text-right font-medium" style={{ color: palette.warn }}>
                {row.diamonds > 0
                  ? t('douyin-link.page.giftDiamonds', { count: formatNumber(row.diamonds) })
                  : t('douyin-link.page.giftValueUnknown')}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function RankList(props: {
  rows: UserRankRow[]
  webRid: string
  t: Translate
  palette: PluginPalette
}): React.JSX.Element {
  if (props.rows.length === 0) return <span className="text-xs opacity-50">{props.t('douyin-link.page.noData')}</span>
  const max = Math.max(1, ...props.rows.map((row) => row.stats.chat))
  return (
    /* 与礼物榜同一个口径：行多了面板内自己滚，别把超出部分截掉 */
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollStyle />
      <div data-rb-scroll="" className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
        {props.rows.map((row, index) => {
          const value = row.stats.chat
          return (
            <div key={row.userId} className="flex min-w-0 items-center gap-2 text-[10px]">
              <span className="w-4 shrink-0 text-right opacity-50">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate">{row.nickname || row.userId}</span>
              <span
                className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full"
                style={{ backgroundColor: props.palette.track }}
              >
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${Math.max(3, (value / max) * 100)}%`,
                    backgroundColor: props.palette.accent
                  }}
                />
              </span>
              <span className="w-14 shrink-0 text-right font-medium">{formatNumber(value)}</span>
            </div>
          )
        })}
      </div>
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

function sum(rows: RoomSummary['series'], key: 'chat' | 'member' | 'like' | 'social' | 'gift'): number {
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
