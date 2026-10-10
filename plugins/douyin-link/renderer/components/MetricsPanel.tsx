import { useEffect, useMemo, useRef, useState } from 'react'
import { theme } from 'antd'
import { useTranslation } from '@host/renderer/i18n'
import type { AllRoomsAnalysis, RoomSeriesRow } from '../../shared/types'
import api, { normalizeAllRoomsAnalysis } from '../api'
import { EmptyHint, Panel, ScrollStyle, type PluginPalette, roomLabel, usePluginPalette } from './ui'
import { EChart } from './EChart'
import type { ChartOption } from '../lib/echarts'
import { clock, formatNumber } from './OverviewPanel'

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * 数据大屏 · 「指标」页签：**直播间之间横向比**的细节分析图。
 *
 * 与「全局分析」相对：那一页把所有房间**合**成一份报告（跨房合计 + 两张跨房榜单）；
 * 这一页反过来，把每个房间**拆开并排**，看「谁的抖币收入涨得最快 / 钱是怎么来的」这类
 * **结构性问题**——对齐用户给的 echarts 官方示例观感：
 * - **直播间动态收入排序**（原 bar race）：房间按窗口内的累计抖币收入排序，**只显示最新一帧**、
 *   不循环播放；新数据进来时柱子自己滑到新名次（换位有过渡动画），右下角一枚时间水印；
 * - **日内走势图**（对照 `intraday-breaks-1`）：每个房间一条曲线、面积填充，带竖向网格线与底部滑块；
 * - **收入排行**：横截面，谁挣得多、占比多少（点一行切到那个直播间）。
 *
 * 数据全部来自主进程（`all-analysis` 通道 + `all` 事件推送，与全局分析同一份快照，
 * 只是多带了 `roomSeries`——每房一条分钟序列），页面只负责画。
 */
export function MetricsPanel(props: {
  /** 数据大屏的时间区间（头部选择器，默认「今天」） */
  range: { from: number; to: number }
  /** 点收入排行的一行 → 切到那个直播间（由 Page 切回单房间模式） */
  onSelectRoom: (webRid: string) => void
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const palette = usePluginPalette()
  const [analysis, setAnalysis] = useState<AllRoomsAnalysis | null>(null)
  const [loading, setLoading] = useState(false)
  const minutes = Math.max(1, Math.round((props.range.to - props.range.from) / 60000))
  const minutesRef = useRef(minutes)
  minutesRef.current = minutes

  /** 实时更新：与全局分析同一条推送（登记 / 撤销也共用，见 AllRoomsPanel 的说明） */
  useEffect(() => {
    const off = api.onAllAnalysis((push) => {
      setAnalysis(normalizeAllRoomsAnalysis(push.analysis, minutesRef.current))
    })
    return () => {
      off()
      api.allAnalysisUnwatch()
    }
  }, [])

  /** 首次 / 换区间时查一次（顺带登记这个区间），并留一个低频兜底轮询 */
  useEffect(() => {
    let alive = true
    const load = (): void => {
      setLoading(true)
      void api
        .allAnalysis(minutes, props.range)
        .then((next) => {
          if (alive) setAnalysis(next)
        })
        .catch(() => undefined)
        .finally(() => {
          if (alive) setLoading(false)
        })
    }
    load()
    const timer = window.setInterval(load, RELOAD_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.range.from, props.range.to])

  /**
   * 有礼物流水的房间（主进程已按窗口抖币降序排好），以及它们的**固定配色**——
   * 三张图共用同一份配色，同一房间在不同图里颜色一致，横向对照才不费眼。
   */
  const rooms = analysis?.roomSeries ?? []
  const colorOf = useMemo(() => {
    const map = new Map<string, string>()
    rooms.forEach((room, index) => map.set(room.webRid, SERIES_COLORS[index % SERIES_COLORS.length]))
    return map
  }, [rooms])

  const empty = !analysis || rooms.length === 0
  const emptyText = loading ? t('douyin-link.page.loading') : t('douyin-link.page.metrics.empty')

  /** 窗口抖币总额（KPI 与占比的分母） */
  const totalDiamonds = useMemo(
    () => rooms.reduce((sum, room) => sum + sumSeries(room.series), 0),
    [rooms]
  )
  /** 窗口礼物总件数（与抖币总额一起，给出「钱多」与「量大」两个维度） */
  const totalGifts = useMemo(
    () => rooms.reduce((sum, room) => sum + countGifts(room.series), 0),
    [rooms]
  )

  return (
    <div className="grid h-full min-h-0 grid-cols-12 grid-rows-1 gap-3">
      <div className="col-span-8 flex min-h-0 flex-col gap-3">
        <Panel className="shrink-0" title={t('douyin-link.page.metrics.kpiTitle')}>
          <div className="grid grid-cols-4 gap-2">
            <Kpi
              label={t('douyin-link.page.kpiDiamonds')}
              value={formatNumber(totalDiamonds)}
              hint={t('douyin-link.page.kpiDiamondsUnit')}
              accent={palette.warn}
              palette={palette}
            />
            <Kpi
              label={t('douyin-link.page.metrics.roomsWithGift')}
              value={formatNumber(rooms.length)}
              accent={palette.accent}
              palette={palette}
            />
            <Kpi
              label={t('douyin-link.page.metrics.totalGifts')}
              value={formatNumber(totalGifts)}
              hint={t('douyin-link.page.metrics.totalGiftsUnit')}
              accent={palette.up}
              palette={palette}
            />
            <Kpi
              label={t('douyin-link.page.metrics.topRoom')}
              value={rooms[0] ? roomLabel(rooms[0]) : '-'}
              palette={palette}
            />
          </div>
        </Panel>

        <Panel className="min-h-0 flex-1" title={t('douyin-link.page.metrics.raceTitle')}>
          {empty ? (
            <EmptyHint text={emptyText} />
          ) : (
            <BarRace rooms={rooms} colorOf={colorOf} palette={palette} t={t} />
          )}
        </Panel>

        <Panel className="min-h-0 flex-1" title={t('douyin-link.page.metrics.intradayTitle')}>
          {empty ? (
            <EmptyHint text={emptyText} />
          ) : (
            <IntradayChart rooms={rooms} colorOf={colorOf} palette={palette} t={t} />
          )}
        </Panel>
      </div>

      <div className="col-span-4 flex min-h-0 flex-col gap-3">
        <Panel className="min-h-0 flex-1" title={t('douyin-link.page.metrics.rankTitle')}>
          {empty ? (
            <EmptyHint text={emptyText} />
          ) : (
            <RevenueRank rooms={rooms} total={totalDiamonds} colorOf={colorOf} t={t} palette={palette} onSelect={props.onSelectRoom} />
          )}
        </Panel>
      </div>
    </div>
  )
}

/**
 * 兜底轮询间隔：与全局分析一致（实时更新靠 `all` 推送，这里只防「推送没挂上」）。
 */
const RELOAD_MS = 30000

/** 动态排序柱状图一次展示多少个房间（名次再往后就挤成一条线了） */
const RACE_TOP = 8
/** 名次换位时的过渡时长（ms）：太快看不清换位，太慢又显得卡 */
const RACE_ANIM_MS = 400
/** 日内走势图最多画几条线（再多就是一团毛线，剩下的在右侧排行里看） */
const LINE_MAX = 8

/** 房间配色（横向对比图共用）：挑的是亮暗主题下都成立的中间调色 */
const SERIES_COLORS = [
  '#8b5cf6',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
  '#f97316',
  '#6366f1',
  '#14b8a6'
]

/** 一条房间序列的抖币合计 */
function sumSeries(series: RoomSeriesRow['series']): number {
  return series.reduce((sum, point) => sum + point.diamonds, 0)
}

/** 一条房间序列的礼物件数合计 */
function countGifts(series: RoomSeriesRow['series']): number {
  return series.reduce((sum, point) => sum + point.gift, 0)
}

/**
 * 直播间收入排序（原「动态排序柱状图」）：房间按**窗口内的累计抖币收入**横向排序。**用 ECharts 画。**
 *
 * 为什么不保留播放（用户 2026-10-10）：「不要循环播放，我只要最新的内容」——
 * 所以这里**只画最后一格**（窗口里最新的那一分钟），不再有游标、不再回到起点重播。
 * 但保留 `realtimeSort` + `animationDurationUpdate`：新数据一到，柱子会**自己滑到新名次**，
 * 「动态」体现在换位的过渡上，而不是把历史重放一遍。
 * 房间集合固定为「窗口总抖币前 `RACE_TOP` 名」，不随中间过程增减（否则行列会跳）。
 */
function BarRace(props: {
  rooms: RoomSeriesRow[]
  colorOf: Map<string, string>
  palette: PluginPalette
  t: Translate
}): React.JSX.Element {
  const { rooms, colorOf, palette, t } = props
  const racers = useMemo(() => rooms.slice(0, RACE_TOP), [rooms])
  const length = useMemo(() => racers.reduce((max, room) => Math.max(max, room.series.length), 1), [racers])
  /** 每个房间的累计抖币：`cumulative[r][i]` = 前 i 格（含）之和 */
  const cumulative = useMemo(
    () =>
      racers.map((room) => {
        const out = new Array<number>(length).fill(0)
        let sum = 0
        for (let index = 0; index < length; index += 1) {
          sum += room.series[index]?.diamonds ?? 0
          out[index] = sum
        }
        return out
      }),
    [racers, length]
  )

  /** 只画最后一格：窗口里最新的那一分钟 */
  const at = Math.max(0, length - 1)
  /** 当前这一格的时刻标签（用第一条序列的分钟起点；各房分桶口径一致） */
  const atLabel = racers[0]?.series[at]?.minute ?? 0

  /** 这一帧：房间按累计值降序（并列时按固定房间顺序，避免同分时来回抖） */
  const option: ChartOption = useMemo(() => {
    const ordered = racers
      .map((room, index) => ({ room, value: cumulative[index][at] ?? 0 }))
      .sort((a, b) => b.value - a.value)
    return {
      animation: true,
      grid: { left: 8, right: 48, top: 6, bottom: 6, containLabel: true },
      xAxis: { type: 'value', show: false },
      yAxis: {
        type: 'category',
        inverse: true,
        max: Math.max(0, racers.length - 1),
        data: ordered.map((entry) => roomLabel(entry.room)),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: palette.axis, fontSize: 10, width: 96, overflow: 'truncate' },
        animationDuration: 300,
        animationDurationUpdate: RACE_ANIM_MS
      },
      series: [
        {
          type: 'bar' as const,
          realtimeSort: true,
          barWidth: 12,
          data: ordered.map((entry) => ({
            value: entry.value,
            itemStyle: {
              color: colorOf.get(entry.room.webRid) ?? palette.accent,
              borderRadius: [0, 3, 3, 0]
            }
          })),
          label: {
            show: true,
            position: 'right',
            color: palette.text,
            fontSize: 10,
            formatter: (params: unknown): string => formatNumber((params as { value?: number }).value ?? 0)
          }
        }
      ],
      // 右下角的大号时间水印（对照 echarts bar-race-country 里的年份数字）：随播放推进而变
      graphic: [
        {
          type: 'text',
          right: 26,
          bottom: 0,
          silent: true,
          style: {
            text: atLabel ? clock(atLabel) : '',
            fontFamily: 'monospace',
            fontSize: 52,
            fontWeight: 'bold',
            fill: palette.text,
            opacity: 0.14
          }
        }
      ]
    }
  }, [racers, cumulative, at, atLabel, colorOf, palette])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <span className="shrink-0 text-[10px] opacity-60">
        {t('douyin-link.page.metrics.raceAt', { time: atLabel ? clock(atLabel) : '-' })}
      </span>
      <EChart option={option} notMerge={false} themeKey={palette.dark ? 'dark' : 'light'} />
    </div>
  )
}

/**
 * 日内走势图：每个房间一条折线（**每分钟**抖币收入，不累计——累计看上面的赛跑图）。**用 ECharts 画。**
 *
 * 观感对照 echarts 的 `intraday-breaks-1`：**面积填充 + 竖向网格线 + 底部 dataZoom 滑块**，
 * 时间轴拉长后可以拖滑块看局部。悬浮时打一条竖线，tooltip 里按值**降序**列出**所有线**在该时刻的值，
 * 这样一屏就能读出「这一刻谁的流水高」。
 */
function IntradayChart(props: {
  rooms: RoomSeriesRow[]
  colorOf: Map<string, string>
  palette: PluginPalette
  t: Translate
}): React.JSX.Element {
  const { rooms, colorOf, palette, t } = props
  const { token } = theme.useToken()
  const series = useMemo(() => rooms.slice(0, LINE_MAX), [rooms])
  const labels = series[0]?.series.map((point) => clock(point.minute)) ?? []
  /** 竖向网格线 / 标签的稀疏步长（约 8 格；分钟级数据逐格画会糊成一片） */
  const step = Math.max(1, Math.round(labels.length / 8))

  /**
   * 记住用户拖出来的区间（百分比）。
   *
   * 有这个 ref 是因为：每分钟都有一格新数据进来 → `option` 整个重建 → 走 EChart 的
   * `setOption(option, { notMerge: true })` 整体替换，dataZoom 会被**重置回全选**，
   * 于是用户刚拖好的可见范围时不时被弹回去（用户 2026-10-10 反馈的正是这个）。
   * 现在把 `datazoom` 事件的 start/end 存下来，重建 option 时原样写回去，范围就不再丢。
   */
  const zoomRef = useRef<{ start: number; end: number } | null>(null)
  const zoom = zoomRef.current ?? undefined
  const events = useMemo(
    () => ({
      datazoom: (params: unknown): void => {
        const raw = params as { start?: number; end?: number }
        if (typeof raw.start === 'number' && typeof raw.end === 'number') {
          zoomRef.current = { start: raw.start, end: raw.end }
        }
      }
    }),
    []
  )
  const option: ChartOption = {
    animation: false,
    grid: { left: 46, right: 10, top: 8, bottom: 42 },
    legend: {
      top: 0,
      type: 'scroll',
      icon: 'roundRect',
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 10,
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
      extraCssText: `width:160px;border-radius:8px;box-shadow:${token.boxShadowSecondary}`,
      formatter: (params: unknown): string => {
        const first = (Array.isArray(params) ? params[0] : params) as { dataIndex?: number } | undefined
        const index = first?.dataIndex ?? -1
        if (index < 0) return ''
        const minute = series[0]?.series[index]?.minute ?? 0
        const rows = [...series]
          .map((room) => ({ room, value: room.series[index]?.diamonds ?? 0 }))
          .sort((a, b) => b.value - a.value)
        const head = `<div style="font-weight:500;margin-bottom:4px">${minute ? clock(minute) : '-'}</div>`
        const body = rows
          .map(
            (row) =>
              `<div style="display:flex;justify-content:space-between;gap:8px"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span style="display:inline-block;width:6px;height:6px;border-radius:1px;background:${colorOf.get(row.room.webRid) ?? palette.accent};margin-right:4px"></span>${roomLabel(row.room)}</span><span style="flex-shrink:0">${formatNumber(row.value)}</span></div>`
          )
          .join('')
        return `${head}<div style="border-top:1px solid ${palette.split};padding-top:4px">${body}</div>`
      }
    },
    // 底部滑块（对照 intraday-breaks-1）：滚轮 / 拖动看局部时段。
    // `...zoom`：把用户拖过的区间带回去，否则每次重建 option 都会被重置（见上面的 zoomRef）
    dataZoom: [
      { type: 'inside', throttle: 60, ...zoom },
      {
        type: 'slider',
        height: 16,
        bottom: 2,
        ...zoom,
        borderColor: palette.split,
        backgroundColor: 'transparent',
        fillerColor: palette.soft,
        handleStyle: { color: palette.accent, borderColor: palette.accent },
        moveHandleStyle: { color: palette.accent, opacity: 0.4 },
        dataBackground: {
          lineStyle: { color: palette.axis, opacity: 0.25 },
          areaStyle: { color: palette.axis, opacity: 0.08 }
        },
        selectedDataBackground: {
          lineStyle: { color: palette.accent, opacity: 0.6 },
          areaStyle: { color: palette.accent, opacity: 0.15 }
        },
        textStyle: { color: palette.axis, fontSize: 9 }
      }
    ],
    xAxis: {
      type: 'category',
      data: labels,
      boundaryGap: false,
      axisLine: { lineStyle: { color: palette.split } },
      axisTick: { show: false },
      axisLabel: { color: palette.axis, fontSize: 10, interval: step },
      // 竖向网格线（对照 intraday-breaks-1）：与刻度标签同密度
      splitLine: { show: true, interval: step, lineStyle: { color: palette.split, opacity: 0.6 } }
    },
    yAxis: {
      type: 'value',
      splitNumber: 3,
      splitLine: { lineStyle: { color: palette.split } },
      axisLabel: { color: palette.axis, fontSize: 10 }
    },
    series: series.map((room) => {
      const color = colorOf.get(room.webRid) ?? palette.accent
      return {
        name: roomLabel(room),
        type: 'line' as const,
        showSymbol: false,
        lineStyle: { width: 1.6, color },
        itemStyle: { color },
        // 面积填充：单一色相向下渐隐，多条线叠加也不会糊
        areaStyle: {
          opacity: 0.22,
          color: {
            type: 'linear' as const,
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color },
              { offset: 1, color: 'rgba(0,0,0,0)' }
            ]
          }
        },
        data: room.series.map((point) => point.diamonds)
      }
    })
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EChart option={option} themeKey={palette.dark ? 'dark' : 'light'} onEvents={events} />
      <span className="shrink-0 text-[10px] opacity-50">
        {t('douyin-link.page.metrics.intradayHint', { count: LINE_MAX })}
      </span>
    </div>
  )
}

/** 收入排行：一行一个房间——名字 · 条形 · 抖币（+占比），点一行切到那个直播间 */
function RevenueRank(props: {
  rooms: RoomSeriesRow[]
  total: number
  colorOf: Map<string, string>
  t: Translate
  palette: PluginPalette
  onSelect: (webRid: string) => void
}): React.JSX.Element {
  const { rooms, total, colorOf, t, palette } = props
  const max = Math.max(1, ...rooms.map((room) => sumSeries(room.series)))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollStyle />
      <div data-rb-scroll="" className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
        {rooms.map((room) => {
          const value = sumSeries(room.series)
          const share = total > 0 ? Math.round((value / total) * 100) : 0
          return (
            <button
              key={room.webRid}
              type="button"
              data-rb-row=""
              className="flex min-w-0 cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left text-[10px]"
              title={t('douyin-link.page.metrics.rankHint')}
              onClick={() => props.onSelect(room.webRid)}
            >
              <span className="min-w-0 flex-1 truncate" title={roomLabel(room)}>
                {roomLabel(room)}
              </span>
              <span className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full" style={{ backgroundColor: palette.track }}>
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${Math.max(3, (value / max) * 100)}%`,
                    backgroundColor: colorOf.get(room.webRid) ?? palette.warn
                  }}
                />
              </span>
              <span className="w-16 shrink-0 text-right font-medium" style={{ color: palette.warn }}>
                {formatNumber(value)}
              </span>
              <span className="w-8 shrink-0 text-right opacity-50">{share}%</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** KPI 小方块（与全局分析同款：label 灰、数字加粗、可选强调色） */
function Kpi(props: {
  label: string
  value: string
  hint?: string
  accent?: string
  palette: PluginPalette
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col rounded-md px-2 py-1.5" style={{ backgroundColor: props.palette.soft }}>
      <span className="truncate text-[10px] opacity-60">{props.label}</span>
      <span className="flex min-w-0 items-baseline justify-between gap-1">
        <span className="min-w-0 truncate text-sm font-semibold" style={{ color: props.accent }}>
          {props.value}
        </span>
        {props.hint ? <span className="shrink-0 text-[10px] opacity-50">{props.hint}</span> : null}
      </span>
    </div>
  )
}