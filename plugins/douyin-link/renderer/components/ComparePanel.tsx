import { useEffect, useState } from 'react'
import { Segmented, Tag } from 'antd'
import { RiVolumeUpLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { RoomCompareRow } from '../../shared/types'
import api from '../api'
import { EmptyHint, FitTable, Panel, roomLabel, usePluginPalette } from './ui'
import { WINDOWS, formatNumber, windowLabel } from './OverviewPanel'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** 概览多久自动刷一次（对比是「现在的横截面」，跟着动才有用） */
const RELOAD_MS = 10000

/**
 * 对比页签：**把所有直播间放在一张表里比**（窗口内的量 + 库里累计 + 相位/声音状态）。
 *
 * 一张表就能回答分析里最常见的问题：哪个房间最热、
 * 哪个房间其实已经半天没消息了（活跃分钟 vs 窗口分钟）、哪个在排队没跑起来。
 * 点一行 = 把分析焦点切过去（声音跟着走）。
 */
export function ComparePanel(props: {
  minutes: number
  onMinutes: (minutes: number) => void
  activeRoom: string
  onSelect: (webRid: string) => void
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const palette = usePluginPalette()
  const [rows, setRows] = useState<RoomCompareRow[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      setLoading(true)
      void api
        .roomsCompare(props.minutes)
        .then((next) => {
          if (alive) setRows(next)
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
  }, [props.minutes])

  return (
    <Panel
      className="h-full"
      title={t('douyin-link.page.compareTitle', { window: windowLabel(t, props.minutes) })}
      extra={
        <Segmented
          size="small"
          value={props.minutes}
          onChange={(value) => props.onMinutes(Number(value))}
          options={WINDOWS.map((minutes) => ({ value: minutes, label: windowLabel(t, minutes) }))}
        />
      }
    >
      {rows.length === 0 ? (
        <EmptyHint text={loading ? t('douyin-link.page.loading') : t('douyin-link.page.noData')} />
      ) : (
        <FitTable<RoomCompareRow>
          table={{
            rowKey: (row) => row.webRid,
            dataSource: rows,
            size: 'small',
            loading,
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
                    ) : row.phase === 'queued' ? (
                      <Tag style={{ marginInlineEnd: 0, lineHeight: '14px' }}>
                        {t('douyin-link.page.phaseQueued')}
                      </Tag>
                    ) : null}
                  </span>
                )
              },
              {
                title: t('douyin-link.page.colMessages'),
                dataIndex: 'messages',
                width: 90,
                align: 'right',
                render: (value: number, row) => (
                  <span>
                    {formatNumber(value)}
                    <span className="opacity-50"> / {Math.round(row.perMinute * 10) / 10}</span>
                  </span>
                )
              },
              { title: t('douyin-link.page.kpiChat'), dataIndex: 'chat', width: 76, align: 'right' },
              { title: t('douyin-link.page.kpiMember'), dataIndex: 'member', width: 70, align: 'right' },
              { title: t('douyin-link.page.kpiLike'), dataIndex: 'like', width: 70, align: 'right' },
              { title: t('douyin-link.page.kpiSocial'), dataIndex: 'social', width: 70, align: 'right' },
              {
                title: t('douyin-link.page.kpiGift'),
                dataIndex: 'gift',
                width: 70,
                align: 'right',
                render: (value: number) => <span className={value === 0 ? 'opacity-40' : undefined}>{value}</span>
              },
              {
                title: t('douyin-link.page.kpiDiamonds'),
                dataIndex: 'diamonds',
                width: 90,
                align: 'right',
                render: (value: number) => (
                  <span className={value === 0 ? 'opacity-40' : undefined}>{formatNumber(value)}</span>
                )
              },
              {
                title: t('douyin-link.page.colActiveUsers'),
                dataIndex: 'users',
                width: 84,
                align: 'right',
                render: (value: number) => <span>{formatNumber(value)}</span>
              },
              {
                title: t('douyin-link.page.colActiveMinutes'),
                dataIndex: 'activeMinutes',
                width: 96,
                align: 'right',
                render: (value: number, row) => (
                  <span className={value === 0 ? 'opacity-40' : 'opacity-80'}>
                    {value}/{row.windowMinutes}
                  </span>
                )
              },
              {
                title: t('douyin-link.page.colStoredTotal'),
                dataIndex: 'totalMessages',
                width: 92,
                align: 'right',
                render: (value: number) => <span className="opacity-70">{formatNumber(value)}</span>
              }
            ]
          }}
        />
      )}
    </Panel>
  )
}
