import { useEffect, useState } from 'react'
import { Button, Input, Segmented, Tooltip } from 'antd'
import { RiDeleteBin6Line, RiRefreshLine, RiSearchLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { GiftBreakdownRow, RoomRuntime, UserRankRow } from '../../shared/types'
import api from '../api'
import { clearAvatarCache } from './UserAvatar'
import { EmptyHint, FitTable, Panel, type PluginPalette, usePluginPalette } from './ui'
import { formatNumber, stamp } from './OverviewPanel'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** 用户榜每页条数的**初始估算**；真实值由 FitTable 量出容器能放下几行后回填（见 onCapacity） */
const PAGE_SIZE_FALLBACK = 20

/**
 * 用户页签：**这个房间的用户榜**（跨会话累计，数据来自数据库）。
 *
 * 与上一版的区别：上一版只有「弹幕里出现过的人」的一张内存表，
 * 现在每个房间有自己的一份档案（同一个人在 A 房与 B 房的发言数当然不同），
 * 而且**关掉应用也不会丢**——它是库里的行，不是内存里的对象。
 *
 * 三条纪律（2026-10-10 按用户反馈调）：
 * 1. **服务端分页**：以前固定取前 300 条，排在第 300 名之后的人永远翻不到——现在按页查，
 *    `total` 决定页数（用户：「用户榜不能固定 300」）；
 * 2. **不再被用户事件拖着一直重查**：以前开着的页签会被 `onUsers`（最多 1.5s 一次）反复触发刷新，
 *    列表一直跳（用户：「不要一直刷新列表」）——现在只在换房间/排序/搜索/翻页时查，其余靠手动「刷新」；
 * 3. 排序（最近出现 / 发言最多 / 刷礼物最多）与搜索（昵称 / 抖音号 / 用户 id）都走数据库查询。
 */
export function UsersPanel(props: {
  room: RoomRuntime | null
  onOpenUser: (userId: string) => void
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const palette = usePluginPalette()
  const [sort, setSort] = useState<'recent' | 'chat' | 'gift'>('chat')
  const [keyword, setKeyword] = useState('')
  const [rows, setRows] = useState<UserRankRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  /** 每页条数：先给一个估算值，FitTable 量出容器容量后回填（一页正好铺满，不撑破面板） */
  const [pageSize, setPageSize] = useState(PAGE_SIZE_FALLBACK)
  const [loading, setLoading] = useState(false)
  /** 手动刷新：加一就重查（不重挂组件，翻页/搜索状态留着） */
  const [tick, setTick] = useState(0)
  const webRid = props.room?.webRid ?? ''

  useEffect(() => {
    if (!webRid) {
      setRows([])
      setTotal(0)
      return
    }
    let alive = true
    setLoading(true)
    const timer = window.setTimeout(() => {
      void api
        .usersList(webRid, sort, keyword, { limit: pageSize, offset: page * pageSize })
        .then((next) => {
          if (!alive) return
          setRows(next.rows)
          setTotal(next.total)
        })
        .catch(() => undefined)
        .finally(() => {
          if (alive) setLoading(false)
        })
    }, 200)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [webRid, sort, keyword, page, pageSize, tick])

  /** 换房间 / 改排序 / 改关键词 / 每页条数变了：回到第一页（否则可能停在越界的页码上） */
  useEffect(() => {
    setPage(0)
  }, [webRid, sort, keyword, pageSize])

  const pages = Math.max(1, Math.ceil(total / pageSize))
  useEffect(() => {
    if (page > 0 && page >= pages) setPage(pages - 1)
  }, [page, pages])

  if (!props.room) return <EmptyHint text={t('douyin-link.page.noActive')} />

  return (
    <Panel
      className="h-full"
      title={t('douyin-link.page.usersTitle', { count: total })}
      extra={
        <span className="flex items-center gap-1">
          <Button
            size="small"
            type="text"
            loading={loading}
            icon={<RiRefreshLine size={13} />}
            onClick={() => setTick((previous) => previous + 1)}
          >
            {t('douyin-link.page.usersRefresh')}
          </Button>
          <Button
            size="small"
            type="text"
            danger
            icon={<RiDeleteBin6Line size={13} />}
            onClick={() => {
              void api.usersClear(webRid).then(() => {
                clearAvatarCache()
                setRows([])
                setTotal(0)
              })
            }}
          >
            {t('douyin-link.page.clearUsers')}
          </Button>
        </span>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Input
            size="small"
            allowClear
            className="min-w-0 flex-1"
            prefix={<RiSearchLine size={13} />}
            placeholder={t('douyin-link.page.searchUsersPlaceholder')}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
          <Segmented
            size="small"
            value={sort}
            onChange={(value) => setSort(value as 'recent' | 'chat' | 'gift')}
            options={[
              { value: 'recent', label: t('douyin-link.page.sortRecent') },
              { value: 'chat', label: t('douyin-link.page.sortChat') },
              { value: 'gift', label: t('douyin-link.page.sortGift') }
            ]}
          />
        </div>
        <FitTable<UserRankRow>
          onCapacity={(capacity, hasPager) => {
            // 只有真的画出了分页器才把它当每页条数（空间不足时 FitTable 会退化，别跟着变 1 行）
            if (hasPager && capacity > 0) setPageSize((previous) => (previous === capacity ? previous : capacity))
          }}
          table={{
            rowKey: (row) => row.userId,
            dataSource: rows,
            size: 'small',
            loading,
            pagination: {
              current: page + 1,
              pageSize,
              total,
              showSizeChanger: false,
              onChange: (next) => setPage(Math.max(0, next - 1))
            },
            onRow: (row) => ({ onClick: () => props.onOpenUser(row.userId), style: { cursor: 'pointer' } }),
            columns: [
              {
                title: t('douyin-link.page.colUser'),
                dataIndex: 'nickname',
                ellipsis: true,
                width: 180,
                // 单元格内容一律 min-w-0 + truncate 兜底：ellipsis 会让表格变 fixed 布局
                render: (_value, row) => (
                  <span className="flex min-w-0 items-center gap-1.5">
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
                title: t('douyin-link.page.colDisplayId'),
                dataIndex: 'displayId',
                width: 110,
                ellipsis: true,
                render: (value: string) => <span className="min-w-0 truncate opacity-70">{value || '-'}</span>
              },
              {
                title: t('douyin-link.page.colChat'),
                dataIndex: 'chat',
                width: 76,
                align: 'right',
                render: (_value, row) => <span>{formatNumber(row.stats.chat)}</span>
              },
              {
                title: t('douyin-link.page.colEnter'),
                dataIndex: 'enter',
                width: 70,
                align: 'right',
                render: (_value, row) => <span>{formatNumber(row.stats.enter)}</span>
              },
              {
                title: t('douyin-link.page.colLike'),
                dataIndex: 'like',
                width: 70,
                align: 'right',
                render: (_value, row) => <span>{formatNumber(row.stats.like)}</span>
              },
              {
                title: t('douyin-link.page.colGift'),
                dataIndex: 'gift',
                width: 70,
                align: 'right',
                render: (_value, row) => (
                  <UserGiftsTip webRid={webRid} userId={row.userId} t={t} palette={palette}>
                    <span
                      className="cursor-help"
                      style={row.stats.gift > 0 ? { color: palette.warn } : undefined}
                    >
                      {formatNumber(row.stats.gift)}
                    </span>
                  </UserGiftsTip>
                )
              },
              {
                title: t('douyin-link.page.colDiamonds'),
                dataIndex: 'diamonds',
                width: 84,
                align: 'right',
                render: (_value, row) => (
                  <span className={row.stats.diamonds > 0 ? undefined : 'opacity-40'}>
                    {formatNumber(row.stats.diamonds)}
                  </span>
                )
              },
              {
                title: t('douyin-link.page.colLastSeen'),
                dataIndex: 'lastSeen',
                width: 100,
                render: (value: number) => <span className="min-w-0 truncate opacity-70">{stamp(value)}</span>
              }
            ]
          }}
        />
      </div>
    </Panel>
  )
}

/**
 * 用户榜里「礼物」那格的悬停明细：**这个人送过哪些礼物、各多少件、值多少抖币**。
 *
 * 为什么要专门给一块：表格里只有一列「礼物 N 次」，列宽塞不下礼物名；
 * 而「送了什么、值多少」正是用户点进这一列时想知道的事（2026-10-08 反馈
 * 「还是不能获取礼物名称，和金额显示，没有地方看，只有送礼物的次数」）。
 * 结构照设置页的浮层规矩：标题行 + 发丝线 + 左右对齐的 dt/dd 明细，不拼成一行字符串。
 * 明细**按需查库**（悬停才查一次，之后缓存），不给榜单页加常驻查询。
 */
function UserGiftsTip(props: {
  webRid: string
  userId: string
  t: Translate
  palette: PluginPalette
  children: React.ReactNode
}): React.JSX.Element {
  const [rows, setRows] = useState<GiftBreakdownRow[] | null>(null)

  const load = (): void => {
    if (rows !== null) return
    void api
      .userGifts(props.webRid, props.userId)
      .then((next) => setRows(next))
      .catch(() => setRows([]))
  }

  const total = (rows ?? []).reduce(
    (sum, row) => ({ count: sum.count + row.count, diamonds: sum.diamonds + row.diamonds }),
    { count: 0, diamonds: 0 }
  )

  return (
    <Tooltip
      onOpenChange={(open) => {
        if (open) load()
      }}
      title={
        <div className="min-w-[220px]">
          <div className="flex items-baseline justify-between gap-3 text-xs font-medium">
            <span>{props.t('douyin-link.page.userGiftsTitle')}</span>
            <span style={{ color: props.palette.warn }}>
              {props.t('douyin-link.page.userGiftsTotal', {
                count: formatNumber(total.count),
                diamonds: formatNumber(total.diamonds)
              })}
            </span>
          </div>
          <div className="mt-1.5 border-t pt-1.5" style={{ borderColor: props.palette.split }}>
            {rows === null ? (
              <span className="text-xs opacity-60">{props.t('douyin-link.page.loading')}</span>
            ) : rows.length === 0 ? (
              <span className="text-xs opacity-60">{props.t('douyin-link.page.giftBoardEmpty')}</span>
            ) : (
              rows.map((row) => (
                <div key={row.name || '(unknown)'} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate">{row.name || props.t('douyin-link.page.giftNameUnknown')}</span>
                  <span className="shrink-0 opacity-80">
                    ×{formatNumber(row.count)}
                    <span className="opacity-60">
                      {' · '}
                      {row.diamonds > 0
                        ? props.t('douyin-link.page.giftDiamonds', { count: formatNumber(row.diamonds) })
                        : props.t('douyin-link.page.giftValueUnknown')}
                    </span>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      }
    >
      {props.children}
    </Tooltip>
  )
}
