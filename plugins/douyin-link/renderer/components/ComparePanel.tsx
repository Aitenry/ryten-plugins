import { useEffect, useRef, useState } from 'react'
import { Segmented, Tag } from 'antd'
import { RiVolumeUpLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { RoomCompareRow } from '../../shared/types'
import api from '../api'
import { EmptyHint, FitTable, Panel, roomLabel, useMoney, usePluginPalette } from './ui'
import { WINDOWS, formatNumber, windowLabel } from './OverviewPanel'

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * 对比页签：**把所有直播间放在一张表里比**（窗口内的量 + 库里累计 + 相位/声音状态）。
 *
 * 一张表就能回答分析里最常见的问题：哪个房间最热、
 * 哪个房间其实已经半天没消息了（活跃分钟 vs 窗口分钟）、哪个在排队没跑起来。
 * 点一行 = 把分析焦点切过去（声音跟着走）。
 *
 * **数据全部由主进程推**（2026-10-11）：这个页签原来自己每 10 秒查一次，现在改成
 * 「进来查一次（顺带登记窗口）→ 之后落库/相位变了主进程推 `compare` 事件」。
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
  /** 流水表里的抖币列按当前口径显示（人民币开关；本页签当前未挂在页面上，改造与其它面板保持一致） */
  const money = useMoney()
  const [rows, setRows] = useState<RoomCompareRow[]>([])
  const [loading, setLoading] = useState(false)
  /** 推送里带着「这份是按多少分钟算的」：切窗口期间迟到的旧数据要丢掉 */
  const minutesRef = useRef(props.minutes)
  minutesRef.current = props.minutes

  useEffect(() => {
    const off = api.onCompare((push) => {
      if (push.minutes !== minutesRef.current) return
      setRows(push.rows)
      setLoading(false)
    })
    return () => {
      off()
      api.compareUnwatch()
    }
  }, [])

  useEffect(() => {
    let alive = true
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
    return () => {
      alive = false
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
                  <span className={value === 0 ? 'opacity-40' : undefined}>{money.text(value)}</span>
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

