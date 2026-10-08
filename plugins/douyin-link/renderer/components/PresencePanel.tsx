import { useEffect, useMemo, useState } from 'react'
import { Button, Tooltip } from 'antd'
import { RiRefreshLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { PresenceRow, PresenceSnapshot, RoomRuntime } from '../../shared/types'
import api from '../api'
import { UserAvatar } from './UserAvatar'
import { EmptyHint, FitTable, Panel, usePluginPalette } from './ui'
import { formatNumber, stamp } from './OverviewPanel'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** 面板自己的刷新节奏（不走事件推送：只在面板可见时拉，见 api.presenceList 的说明） */
const REFRESH_MS = 5000

/**
 * 在线观众页签：**这个房间里现在有谁**，以及「聊天室里谁在麦上」。
 *
 * 三条来源合并（主进程 `analyzerHub.presence()` 已经合好，这里只负责展示）：
 * - **麦上**（`seat > 0`）：语音聊天室的麦位表（`RoomLinkmicMicDisplayInfoSyncData`），
 *   按麦位序排在最前——他们是房间里最核心的一群人；
 * - **成员**（`listed`）：直播间接口给的房间成员名单（固定 30 位，实测不随观众进出变化）；
 * - **本场**（`lastSeen > 0`）：这次监控里发言/进场/点赞过的人。
 *
 * 排序与标记都在主进程定好（麦上 → 主播 → 本场最近出现），这一层不重排。
 *
 * **三种「空」要分清楚**（0.6.0 用户实测反馈「面板全是 0」之后加的）：
 * 主进程没响应（通道拿不到）／房间信息还没解析（插件刚装载、宿主刚升级完插件）／
 * 解析过了但确实还没有数据（没开监控就没有麦位与本场）。三种都各说各的话，
 * 绝不用「全 0」冒充「这个房间没人」。
 */
export function PresencePanel(props: {
  room: RoomRuntime | null
  /** 用户事件来了就顺手刷一次（本场互动数字要跟手） */
  reloadKey: number
  onOpenUser: (userId: string) => void
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const palette = usePluginPalette()
  const [snapshot, setSnapshot] = useState<PresenceSnapshot | null>(null)
  /** 主进程没回话（通道拿不到 / 还在装载）：与「拿到了但没人」必须分开 */
  const [offline, setOffline] = useState(false)
  const [loading, setLoading] = useState(false)
  const webRid = props.room?.webRid ?? ''

  useEffect(() => {
    if (!webRid) {
      setSnapshot(null)
      setOffline(false)
      return
    }
    let alive = true
    const load = (): void => {
      void api
        .presenceList(webRid)
        .then((next) => {
          if (!alive) return
          setSnapshot(next)
          setOffline(next === null)
        })
        .catch(() => {
          if (alive) setOffline(true)
        })
        .finally(() => {
          if (alive) setLoading(false)
        })
    }
    setLoading(true)
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [webRid, props.reloadKey])

  const rows = useMemo(() => snapshot?.rows ?? [], [snapshot])
  const micRows = useMemo(() => rows.filter((row) => row.seat > 0), [rows])

  if (!props.room) return <EmptyHint text={t('douyin-link.page.noActive')} />

  /**
   * 还没拿到快照时（通道拿不到 / 第一次还没回来）**不显示任何数字**：
   * 「麦上 0 · 成员 0 · 本场 0」看起来像数据，其实是没连上——那才是用户看到「全是 0」的由来。
   */
  const ready = Boolean(snapshot) && !offline
  const title = ready
    ? t('douyin-link.page.presenceTitle', {
        mic: snapshot?.micCount ?? 0,
        listed: snapshot?.listedCount ?? 0,
        active: snapshot?.activeCount ?? 0
      })
    : t('douyin-link.page.presenceTitlePlain')

  /** 空态文案：三种「空」分开说（见组件头注释） */
  const emptyText = offline
    ? t('douyin-link.failure.bridgeUnavailable')
    : !snapshot
      ? t('douyin-link.page.presenceLoading')
      : !snapshot.hasInfo
        ? t('douyin-link.page.presenceResolving')
        : props.room.monitor
          ? t('douyin-link.page.presenceEmpty')
          : t('douyin-link.page.presenceIdle')

  return (
    <Panel
      className="h-full"
      title={title}
      extra={
        <span className="flex items-center gap-2">
          <span className="text-[11px] opacity-60">
            {ready
              ? [
                  snapshot?.voice ? t('douyin-link.page.presenceVoice') : t('douyin-link.page.presenceNoVoice'),
                  props.room.monitor ? '' : t('douyin-link.page.presenceNotMonitored'),
                  snapshot?.updatedAt ? t('douyin-link.page.presenceUpdated', { time: stamp(snapshot.updatedAt) }) : ''
                ]
                  .filter(Boolean)
                  .join(' · ')
              : offline
                ? t('douyin-link.page.presenceOffline')
                : t('douyin-link.page.presenceLoading')}
          </span>
          <Button
            size="small"
            type="text"
            icon={<RiRefreshLine size={13} />}
            loading={loading}
            onClick={() => {
              if (!webRid) return
              setLoading(true)
              void api
                .presenceList(webRid)
                .then((next) => {
                  setSnapshot(next)
                  setOffline(next === null)
                })
                .catch(() => setOffline(true))
                .finally(() => setLoading(false))
            }}
          >
            {t('douyin-link.page.presenceRefresh')}
          </Button>
        </span>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <span className="shrink-0 text-[11px] leading-4 opacity-60">{t('douyin-link.page.presenceHint')}</span>
        {micRows.length > 0 ? (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {micRows.map((row) => (
              <span
                key={row.userId}
                className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px]"
                style={{ border: `1px solid ${palette.accent}`, color: palette.accent }}
                title={row.nickname || row.userId}
              >
                <UserAvatar webRid={webRid} userId={row.userId} nickname={row.nickname} size={16} />
                <span className="max-w-[120px] truncate">{row.nickname || row.userId}</span>
                <span className="opacity-70">{t('douyin-link.page.seatLabel', { seat: row.seat })}</span>
              </span>
            ))}
          </div>
        ) : null}
        <FitTable<PresenceRow>
          table={{
            rowKey: (row) => row.userId,
            dataSource: rows,
            size: 'small',
            loading,
            // antd 的默认空态是英文：这里换成自己的文案（三种「空」分开说）
            locale: { emptyText },
            onRow: (row) => ({ onClick: () => props.onOpenUser(row.userId), style: { cursor: 'pointer' } }),
            columns: [
              {
                title: t('douyin-link.page.colPresenceUser'),
                dataIndex: 'nickname',
                ellipsis: true,
                width: 200,
                render: (_value, row) => (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <UserAvatar webRid={webRid} userId={row.userId} nickname={row.nickname} size={18} />
                    <span className="min-w-0 truncate font-medium">{row.nickname || row.userId}</span>
                    {row.honorLevel > 0 ? (
                      <span className="shrink-0 text-[10px]" style={{ color: palette.warn }}>
                        L{row.honorLevel}
                      </span>
                    ) : null}
                  </span>
                )
              },
              {
                title: t('douyin-link.page.colPresenceSeat'),
                dataIndex: 'seat',
                width: 74,
                render: (_value, row) => (
                  <span style={{ color: row.seat > 0 ? palette.accent : undefined }}>
                    {row.seat > 0 ? t('douyin-link.page.seatLabel', { seat: row.seat }) : t('douyin-link.page.seatNone')}
                  </span>
                )
              },
              {
                title: t('douyin-link.page.colPresenceSource'),
                dataIndex: 'userId',
                width: 150,
                render: (_value, row) => (
                  <span className="flex min-w-0 items-center gap-1">
                    {row.anchor ? <Tag text={t('douyin-link.page.tagAnchor')} color={palette.warn} /> : null}
                    {row.seat > 0 ? <Tag text={t('douyin-link.page.tagMic')} color={palette.accent} /> : null}
                    {row.listed ? <Tag text={t('douyin-link.page.tagListed')} color={palette.axis} /> : null}
                    {row.lastSeen > 0 ? <Tag text={t('douyin-link.page.tagActive')} color={palette.up} /> : null}
                  </span>
                )
              },
              {
                title: t('douyin-link.page.colPresenceSession'),
                dataIndex: 'userId',
                width: 130,
                align: 'right',
                render: (_value, row) => (
                  <Tooltip
                    title={t('douyin-link.page.interactions', {
                      chat: row.session.chat,
                      enter: row.session.enter,
                      follow: row.session.follow,
                      like: row.session.like
                    })}
                  >
                    <span>
                      {formatNumber(row.session.chat)} · {formatNumber(row.session.enter)}
                    </span>
                  </Tooltip>
                )
              },
              {
                title: t('douyin-link.page.colPresenceStored'),
                dataIndex: 'userId',
                width: 120,
                align: 'right',
                render: (_value, row) => <span>{formatNumber(row.stats.chat)}</span>
              },
              {
                title: t('douyin-link.page.colPresenceLastSeen'),
                dataIndex: 'lastSeen',
                width: 104,
                render: (value: number) => <span className="min-w-0 truncate opacity-70">{value ? stamp(value) : '-'}</span>
              }
            ]
          }}
        />
      </div>
    </Panel>
  )
}

/** 来源小标记（麦上/主播/成员/本场） */
function Tag(props: { text: string; color: string }): React.JSX.Element {
  return (
    <span
      className="shrink-0 rounded px-1 text-[10px] leading-4"
      style={{ color: props.color, border: `1px solid ${props.color}`, opacity: 0.9 }}
    >
      {props.text}
    </span>
  )
}