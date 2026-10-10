import { useEffect, useRef, useState } from 'react'
import { Tag } from 'antd'
import { RiVolumeUpLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { AllRoomsAnalysis, GiftBreakdownRow, RoomCompareRow } from '../../shared/types'
import api, { normalizeAllRoomsAnalysis } from '../api'
import { EmptyHint, FitTable, Panel, ScrollStyle, type PluginPalette, roomLabel, usePluginPalette } from './ui'
import { GiftRankBoard, TrendChart, formatNumber } from './OverviewPanel'

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * 全局分析的**兜底**轮询间隔。
 *
 * 实时更新靠主进程的 `all-analysis` 推送（落库后按界面请求的窗口重算一份推过来，
 * 见 main/monitor/hub.ts 的全局推送管线），这里只留一个低频兜底：万一推送没挂上，
 * 界面最多慢这么多，不会一直停在打开那一刻。
 */
const RELOAD_MS = 30000

/**
 * 数据大屏 · 全局分析页签：**所有直播间合起来**的分析报告。
 *
 * 与概览页签（单房间）相对：
 * - KPI / 全局趋势是各房间窗口聚合的合计（趋势按分钟跨房相加）；
 * - 两张按人的礼物榜**跨房合并**（同一个人一行），点一行看他的跨房礼物历史；
 * - 「直播间流水分析」一张表把每个房间横着比（口径同对比页签），点一行切到那个房间。
 *
 * 数据全部来自主进程（`all-analysis` 通道 + `all` 事件推送），页面只负责画。
 */
export function AllRoomsPanel(props: {
  /** 数据大屏的时间区间（用户在头部选的，默认「今天」） */
  range: { from: number; to: number }
  /** 点流水表的一行 → 切到那个直播间（由 Page 切回单房间模式） */
  onSelectRoom: (webRid: string) => void
  /** 点礼物榜的一行 → 打开这个人的跨房礼物历史 */
  onOpenGifts: (target: { userId: string; name: string; direction: 'sent' | 'received' }) => void
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const palette = usePluginPalette()
  const [analysis, setAnalysis] = useState<AllRoomsAnalysis | null>(null)
  const [loading, setLoading] = useState(false)
  /** 区间换算出的分钟数：给主进程当兜底窗口、也给推送结果的归一化用 */
  const minutes = Math.max(1, Math.round((props.range.to - props.range.from) / 60000))
  const minutesRef = useRef(minutes)
  minutesRef.current = minutes

  /** 实时更新：订阅主进程的全局分析推送；卸载时撤销登记（没人看就不再算跨房聚合） */
  useEffect(() => {
    const off = api.onAllAnalysis((push) => {
      setAnalysis(normalizeAllRoomsAnalysis(push.analysis, minutesRef.current))
    })
    return () => {
      off()
      api.allAnalysisUnwatch()
    }
  }, [])

  /** 首次 / 换区间时查一次（`allAnalysis` 顺带登记这个区间），并留一个低频兜底轮询 */
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

  const emptyText = loading ? t('douyin-link.page.loading') : t('douyin-link.page.noData')

  return (
    <div className="grid h-full min-h-0 grid-cols-12 grid-rows-1 gap-3">
      <div className="col-span-8 flex min-h-0 flex-col gap-3">
        <Panel
          className="shrink-0"
          title={t('douyin-link.page.allKpiTitle', { window: rangeText(props.range) })}
        >
          <div className="grid grid-cols-3 grid-rows-3 gap-2">
            <Kpi
              label={t('douyin-link.page.allKpiRooms')}
              value={analysis?.rooms ?? 0}
              hint={t('douyin-link.page.allKpiLive', { count: analysis?.liveRooms ?? 0 })}
              palette={palette}
            />
            <Kpi label={t('douyin-link.page.kpiMessages')} value={analysis?.messages ?? 0} palette={palette} />
            <Kpi label={t('douyin-link.page.kpiChat')} value={analysis?.chat ?? 0} palette={palette} />
            <Kpi label={t('douyin-link.page.kpiMember')} value={analysis?.member ?? 0} palette={palette} />
            <Kpi label={t('douyin-link.page.kpiLike')} value={analysis?.like ?? 0} palette={palette} />
            <Kpi label={t('douyin-link.page.kpiSocial')} value={analysis?.social ?? 0} palette={palette} />
            <Kpi
              label={t('douyin-link.page.kpiGift')}
              value={analysis?.gift ?? 0}
              accent={palette.warn}
              palette={palette}
            />
            <Kpi
              label={t('douyin-link.page.kpiDiamonds')}
              value={analysis?.diamonds ?? 0}
              hint={t('douyin-link.page.kpiDiamondsUnit')}
              accent={palette.warn}
              palette={palette}
            />
            <Kpi label={t('douyin-link.page.kpiUsers')} value={analysis?.users ?? 0} palette={palette} />
          </div>
        </Panel>

        <Panel className="min-h-0 flex-1" title={t('douyin-link.page.allTrendTitle')}>
          {!analysis || analysis.messages === 0 ? (
            <EmptyHint text={emptyText} />
          ) : (
            <TrendChart series={analysis.series} palette={palette} t={t} />
          )}
        </Panel>

        <Panel className="min-h-0 flex-1" title={t('douyin-link.page.allFlowTitle')}>
          {analysis && analysis.perRoom.length > 0 ? (
            <FlowTable rows={analysis.perRoom} activeRoom="" t={t} palette={palette} onSelect={props.onSelectRoom} />
          ) : (
            <EmptyHint text={emptyText} />
          )}
        </Panel>
      </div>

      <div className="col-span-4 flex min-h-0 flex-col gap-3">
        <Panel className="min-h-0 flex-1" title={t('douyin-link.page.allGiftReceivedBoard')}>
          <GiftRankBoard
            rows={analysis?.received ?? []}
            direction="received"
            t={t}
            palette={palette}
            onOpen={props.onOpenGifts}
          />
        </Panel>
        <Panel className="min-h-0 flex-1" title={t('douyin-link.page.allGiftSentBoard')}>
          <GiftRankBoard
            rows={analysis?.sent ?? []}
            direction="sent"
            t={t}
            palette={palette}
            onOpen={props.onOpenGifts}
          />
        </Panel>
        <Panel className="min-h-0 flex-1" title={t('douyin-link.page.allGiftTypesBoard')}>
          <GiftTypeList rows={analysis?.gifts ?? []} t={t} palette={palette} />
        </Panel>
      </div>
    </div>
  )
}

/** 时间区间的可读文本：同一天只写这一天，跨天写 `起 → 止`（本地日期） */
function rangeText(range: { from: number; to: number }): string {
  const day = (at: number): string => {
    const date = new Date(at)
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }
  const from = day(range.from)
  const to = day(range.to)
  return from === to ? from : `${from} → ${to}`
}

/** KPI 小方块（与概览页同款：label 灰、数字加粗、可选提示/强调色） */
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

/**
 * 直播间流水分析：每个房间一行（口径与对比页签一致），点一行切到那个直播间。
 * 列比对比页少一点，只留「流水」相关的量，避免一张表塞太满。
 */
function FlowTable(props: {
  rows: RoomCompareRow[]
  activeRoom: string
  t: Translate
  palette: PluginPalette
  onSelect: (webRid: string) => void
}): React.JSX.Element {
  const { rows, t, palette } = props
  return (
    <FitTable<RoomCompareRow>
      table={{
        rowKey: (row) => row.webRid,
        dataSource: rows,
        size: 'small',
        pagination: false,
        onRow: (row) => ({
          onClick: () => props.onSelect(row.webRid),
          style: {
            cursor: 'pointer',
            backgroundColor: row.webRid === props.activeRoom ? palette.soft : undefined
          }
        }),
        columns: [
          {
            title: t('douyin-link.page.colRoomTitle'),
            dataIndex: 'title',
            ellipsis: true,
            render: (_value, row) => (
              <span className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 truncate">{roomLabel(row)}</span>
                {row.audio ? (
                  <span className="shrink-0" style={{ color: palette.accent }}>
                    <RiVolumeUpLine size={12} />
                  </span>
                ) : null}
                {row.phase === 'live' ? (
                  <Tag color="green" style={{ marginInlineEnd: 0, lineHeight: '14px' }}>
                    {t('douyin-link.page.phaseLive')}
                  </Tag>
                ) : row.phase === 'error' ? (
                  <Tag color="red" style={{ marginInlineEnd: 0, lineHeight: '14px' }}>
                    {t('douyin-link.page.phaseError')}
                  </Tag>
                ) : null}
              </span>
            )
          },
          {
            title: t('douyin-link.page.colMessages'),
            dataIndex: 'messages',
            width: 92,
            align: 'right',
            render: (value: number, row) => (
              <span>
                {formatNumber(value)}
                <span className="opacity-50"> / {Math.round(row.perMinute * 10) / 10}</span>
              </span>
            )
          },
          { title: t('douyin-link.page.kpiChat'), dataIndex: 'chat', width: 70, align: 'right' },
          { title: t('douyin-link.page.kpiMember'), dataIndex: 'member', width: 66, align: 'right' },
          { title: t('douyin-link.page.kpiLike'), dataIndex: 'like', width: 66, align: 'right' },
          { title: t('douyin-link.page.kpiSocial'), dataIndex: 'social', width: 66, align: 'right' },
          {
            title: t('douyin-link.page.kpiGift'),
            dataIndex: 'gift',
            width: 66,
            align: 'right',
            render: (value: number) => <span className={value === 0 ? 'opacity-40' : undefined}>{value}</span>
          },
          {
            title: t('douyin-link.page.kpiDiamonds'),
            dataIndex: 'diamonds',
            width: 88,
            align: 'right',
            render: (value: number) => (
              <span className={value === 0 ? 'opacity-40' : undefined}>{formatNumber(value)}</span>
            )
          },
          {
            title: t('douyin-link.page.colActiveUsers'),
            dataIndex: 'users',
            width: 80,
            align: 'right',
            render: (value: number) => <span>{formatNumber(value)}</span>
          },
          {
            title: t('douyin-link.page.colActiveMinutes'),
            dataIndex: 'activeMinutes',
            width: 90,
            align: 'right',
            render: (value: number, row) => (
              <span className={value === 0 ? 'opacity-40' : 'opacity-80'}>
                {value}/{row.windowMinutes}
              </span>
            )
          }
        ]
      }}
    />
  )
}

/** 礼物种类榜：跨房按礼物名聚合（送了什么、多少件、值多少抖币、多少人送过） */
function GiftTypeList(props: {
  rows: GiftBreakdownRow[]
  t: Translate
  palette: PluginPalette
}): React.JSX.Element {
  const { rows, t, palette } = props
  if (rows.length === 0) return <span className="text-xs opacity-50">{t('douyin-link.page.allGiftTypesEmpty')}</span>
  const max = Math.max(1, ...rows.map((row) => (row.diamonds > 0 ? row.diamonds : row.count)))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollStyle />
      <div data-rb-scroll="" className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
        {rows.map((row) => {
          const value = row.diamonds > 0 ? row.diamonds : row.count
          return (
            <div
              key={row.name || '(unknown)'}
              data-rb-row=""
              className="flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-[10px]"
            >
              <span className="min-w-0 flex-1 truncate" title={row.name || t('douyin-link.page.giftNameUnknown')}>
                {row.name || t('douyin-link.page.giftNameUnknown')}
              </span>
              <span className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full" style={{ backgroundColor: palette.track }}>
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
            </div>
          )
        })}
      </div>
    </div>
  )
}