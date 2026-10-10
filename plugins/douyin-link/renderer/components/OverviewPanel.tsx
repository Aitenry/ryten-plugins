import { useEffect, useRef, useState } from 'react'
import { Button, Slider, theme } from 'antd'
import { useTranslation } from '@host/renderer/i18n'
import type { GiftRankRow, MonitorSession, RoomRuntime, RoomSummary, UserRankRow } from '../../shared/types'
import api, { normalizeRoomSummary } from '../api'
import { EmptyHint, Panel, ScrollStyle, type PluginPalette, usePluginPalette } from './ui'
import { EChart } from './EChart'
import type { ChartOption } from '../lib/echarts'

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * 统计窗口的候选（分钟）。**0 = 全部**（库里最早一条到现在）——
 * 固定窗口会把更早的礼物从榜上抹掉，看着就像「礼物不断消失」；默认永久保存之后，
 * 「全部」才是这套数据的自然口径。
 */
export const WINDOWS = [15, 60, 360, 1440, 0] as const

/**
 * 概览的**兜底**轮询间隔。
 *
 * 实时更新靠主进程的 `summary` 推送（落库后按界面请求的窗口推一份，见 main/monitor/hub.ts），
 * 所以这里只留一个低频兜底：万一推送通道没挂上（宿主刚升级插件、主进程还是旧模块），
 * 界面最多慢这么多，不会一直停在打开那一刻。
 */
const RELOAD_MS = 30000

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
  /** 点礼物榜里的**名字** → 打开这个人的用户档案 */
  onOpenUser: (userId: string) => void
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
  /** 归一化要用到当前窗口（推送来得比 props 更新晚一拍，用 ref 兜住） */
  const minutesRef = useRef(props.minutes)
  minutesRef.current = props.minutes

  /**
   * 实时更新：订阅主进程的概览推送。
   *
   * 主进程在**落库之后**（每 2 秒一批）按界面请求过的窗口重算一份推过来，这里直接替换——
   * KPI / 分钟趋势 / 类型分布 / 榜单 / 会话摘要全都跟着动，不再等 10 秒一次的轮询。
   * 订阅只跟房间走：换房间时先撤销旧房间的推送，别让它继续为没人看的房间算。
   */
  useEffect(() => {
    if (!webRid) return
    const off = api.onSummary((push) => {
      if (push.webRid !== webRid) return
      setSummary(normalizeRoomSummary(push.summary, push.webRid, minutesRef.current))
      setSessions(Array.isArray(push.sessions) ? push.sessions : [])
    })
    return () => {
      off()
      api.summaryUnwatch(webRid)
    }
  }, [webRid])

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
            <TrendChart series={summary.series} palette={palette} t={t} />
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
            onOpenUser={props.onOpenUser}
          />
        </Panel>
        <Panel className="min-h-0 flex-1" title={t('douyin-link.page.giftSentBoard')}>
          <GiftRankBoard
            rows={summary?.sent ?? []}
            direction="sent"
            t={t}
            palette={palette}
            onOpen={props.onOpenGifts}
            onOpenUser={props.onOpenUser}
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
      {/* 数字与单位**同一行**（单位靠右）：分开两行会把「礼物价值 15,070 抖币」读成两条 */}
      <span className="flex min-w-0 items-baseline justify-between gap-1">
        <span className="truncate text-sm font-semibold" style={{ color: props.accent }}>
          {formatNumber(props.value)}
        </span>
        {props.hint ? <span className="shrink-0 text-[10px] opacity-50">{props.hint}</span> : null}
      </span>
    </div>
  )
}

/** 分钟趋势：堆叠柱（弹幕/进场/点赞/关注/礼物）+ 三条网格线 + 首末时间 */
/** 趋势图的系列：顺序 = 堆叠顺序 = 图例顺序 = 悬浮面板的行顺序（一份定义，三处共用） */
const TREND_KEYS = ['chat', 'member', 'like', 'social', 'gift'] as const
type TrendKey = (typeof TREND_KEYS)[number]

/**
 * 分钟趋势：堆叠柱（弹幕/进场/点赞/关注/礼物）+ 三档网格线 + 首末时间。**用 ECharts 画。**
 *
 * **图例 + 悬浮信息**（用户 2026-10-08：「鼠标放上去需要显示信息，不然我怎么知道是什么东西」）：
 * - 图例常驻（ECharts 原生 legend）：五个色块配名字，不用悬停就知道哪根柱子是什么；
 * - 悬停到某根柱子上：`axis` tooltip 弹出**结构化面板**
 *   （标题行 = 这段时间 + 合计，发丝线，下面按系列左右对齐列数字）。
 */
export function TrendChart(props: {
  series: RoomSummary['series']
  palette: PluginPalette
  t: Translate
}): React.JSX.Element {
  const { series, palette, t } = props
  const { token } = theme.useToken()
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
  const last = buckets.length > 0 ? buckets[buckets.length - 1].at + (bucket - 1) * 60000 : 0
  const spansDays = buckets.length > 0 && new Date(buckets[0].at).toDateString() !== new Date(last).toDateString()
  /** 这一根柱子代表的时间段（合并成粗桶时要写清「从几点到几点」） */
  const bucketLabel = (at: number): string => {
    const head = spansDays ? stamp(at) : clock(at)
    return bucket > 1 ? `${head} → ${clock(at + (bucket - 1) * 60000)}` : head
  }
  const totals = buckets.map((item) => item.chat + item.member + item.like + item.social + item.gift)
  const colors: Record<TrendKey, string> = {
    chat: palette.accent,
    member: palette.up,
    like: palette.down,
    social: palette.axis,
    gift: palette.warn
  }
  const option: ChartOption = {
    animation: false,
    grid: { left: 36, right: 10, top: 24, bottom: 18 },
    legend: {
      top: 0,
      icon: 'roundRect',
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 12,
      textStyle: { color: palette.axis, fontSize: 10 }
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: palette.accent, type: 'dashed', width: 1 } },
      backgroundColor: token.colorBgElevated,
      borderColor: palette.split,
      borderWidth: 1,
      padding: [6, 8],
      textStyle: { color: palette.text, fontSize: 10 },
      extraCssText: `width:148px;border-radius:8px;box-shadow:${token.boxShadowSecondary}`,
      // 结构化悬浮面板：标题行（时间段 + 合计）+ 发丝线 + 各系列左右对齐
      formatter: (params: unknown): string => {
        const first = (Array.isArray(params) ? params[0] : params) as { dataIndex?: number } | undefined
        const index = first?.dataIndex ?? -1
        const bucketItem = buckets[index]
        if (!bucketItem) return ''
        const head = `<div style="display:flex;justify-content:space-between;gap:8px;font-weight:500"><span>${bucketLabel(bucketItem.at)}</span><span style="color:${palette.warn}">${formatNumber(totals[index])}</span></div>`
        const rows = TREND_KEYS.map(
          (key) =>
            `<div style="display:flex;justify-content:space-between;gap:8px"><span><span style="display:inline-block;width:6px;height:6px;border-radius:1px;background:${colors[key]};margin-right:4px"></span>${t(`douyin-link.kinds.${key}`)}</span><span>${formatNumber(bucketItem[key])}</span></div>`
        ).join('')
        return `${head}<div style="margin-top:4px;border-top:1px solid ${palette.split};padding-top:4px">${rows}</div>`
      }
    },
    xAxis: {
      type: 'category',
      data: buckets.map((item) => bucketLabel(item.at)),
      axisLine: { lineStyle: { color: palette.split } },
      axisTick: { show: false },
      axisLabel: { color: palette.axis, fontSize: 10, hideOverlap: true }
    },
    yAxis: {
      type: 'value',
      splitNumber: 3,
      splitLine: { lineStyle: { color: palette.split } },
      axisLabel: { color: palette.axis, fontSize: 10 }
    },
    series: TREND_KEYS.map((key) => ({
      name: t(`douyin-link.kinds.${key}`),
      type: 'bar' as const,
      stack: 'total',
      barMaxWidth: 16,
      itemStyle: { color: colors[key] },
      data: buckets.map((item) => item[key])
    }))
  }
  return <EChart option={option} themeKey={palette.dark ? 'dark' : 'light'} />
}

/** 消息类型分布：横向条形（ECharts），右侧标注「数量 · 占比」 */
function KindBars(props: {
  kinds: Array<{ kind: string; count: number }>
  t: Translate
  palette: PluginPalette
}): React.JSX.Element {
  const { kinds, t, palette } = props
  const { token } = theme.useToken()
  const total = kinds.reduce((sum, entry) => sum + entry.count, 0) || 1
  // ECharts 的类目轴自下而上，倒序后「数量最多的类型」显示在最上方
  const rows = [...kinds].reverse()
  const option: ChartOption = {
    animation: false,
    grid: { left: 4, right: 72, top: 4, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'item',
      backgroundColor: token.colorBgElevated,
      borderColor: palette.split,
      borderWidth: 1,
      padding: [4, 8],
      textStyle: { color: palette.text, fontSize: 10 },
      extraCssText: `border-radius:8px;box-shadow:${token.boxShadowSecondary}`,
      formatter: (params: unknown): string => {
        const item = params as { name?: string; value?: number }
        const value = item.value ?? 0
        return `${item.name ?? ''}：${formatNumber(value)} · ${Math.round((value / total) * 100)}%`
      }
    },
    xAxis: { type: 'value', show: false },
    yAxis: {
      type: 'category',
      data: rows.map((entry) => t(`douyin-link.kinds.${entry.kind}`)),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: palette.axis, fontSize: 10 }
    },
    series: [
      {
        type: 'bar' as const,
        barWidth: 8,
        showBackground: true,
        backgroundStyle: { color: palette.track, borderRadius: 999 },
        itemStyle: { color: palette.accent, borderRadius: 999 },
        label: {
          show: true,
          position: 'right',
          color: palette.text,
          fontSize: 10,
          formatter: (params: unknown): string => {
            const value = (params as { value?: number }).value ?? 0
            return `${formatNumber(value)} · ${Math.round((value / total) * 100)}%`
          }
        },
        data: rows.map((entry) => entry.count)
      }
    ]
  }
  // 类型数量决定高度（这个面板是自适应高度，ECharts 需要显式像素高）
  return (
    <EChart
      option={option}
      className="w-full"
      style={{ height: rows.length * 24 + 8 }}
      themeKey={palette.dark ? 'dark' : 'light'}
    />
  )
}

/**
 * 礼物榜（收礼 / 送礼共用一张）：**一行一个人**——名字 · 件数 · 抖币。
 *
 * 两个点击目标（用户 2026-10-10：「里面的所有名称点击后可查看其信息，即用户档案」）：
 * - 点**名字** → 打开这个人的用户档案（`onOpenUser`）；
 * - 点这一行的**其它地方** → 看他的礼物历史（`onOpen`，原行为不变）。
 * 名字是嵌在行按钮里的 `<span>`（不是第二层 `<button>`，嵌套按钮是非法 HTML），
 * 各自的 `onClick` 里 `stopPropagation` 把两件事分开。
 *
 * 收礼榜的行带麦位号（只列麦上的人）、空态文案、点开的历史方向——两个口径只差这三点。
 * 抖币拿不到（官方没给价）的行显示「价值未知」，不写成 0。
 */
export function GiftRankBoard(props: {
  rows: GiftRankRow[]
  direction: 'sent' | 'received'
  t: Translate
  palette: PluginPalette
  onOpen: (target: { userId: string; name: string; direction: 'sent' | 'received' }) => void
  /** 点名字 → 打开用户档案 */
  onOpenUser: (userId: string) => void
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
              {/* 名字前面**不带「N号」**（用户 2026-10-08：「移除前面的x号的内容」）：
                  榜单按抖币排、也不再只列麦上的人，那个前缀只会误导；麦位去「在线观众」看 */}
              <span
                className="min-w-0 flex-1 truncate hover:underline"
                title={t('douyin-link.page.giftNameHint')}
                onClick={(event) => {
                  event.stopPropagation()
                  if (row.userId) props.onOpenUser(row.userId)
                }}
              >
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
        {props.rows.map((row) => {
          const value = row.stats.chat
          return (
            <div key={row.userId} className="flex min-w-0 items-center gap-2 text-[10px]">
              {/* 名字前面**不带序号**（用户 2026-10-10：「发言榜不需要序号显示」）——
                  与收礼物榜/送礼物榜同一口径，榜单靠条形长度与数字表达排名 */}
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
