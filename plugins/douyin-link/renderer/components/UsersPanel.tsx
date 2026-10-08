import { useEffect, useState } from 'react'
import { Button, Input, Segmented } from 'antd'
import { RiDeleteBin6Line, RiSearchLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { RoomRuntime, UserRankRow } from '../../shared/types'
import api from '../api'
import { clearAvatarCache } from './UserAvatar'
import { EmptyHint, FitTable, Panel, usePluginPalette } from './ui'
import { formatNumber, stamp } from './OverviewPanel'

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * 用户页签：**这个房间的用户榜**（跨会话累计，数据来自数据库）。
 *
 * 与上一版的区别：上一版只有「弹幕里出现过的人」的一张内存表，
 * 现在每个房间有自己的一份档案（同一个人在 A 房与 B 房的发言数当然不同），
 * 而且**关掉应用也不会丢**——它是库里的行，不是内存里的对象。
 *
 * 排序（最近出现 / 发言最多）与搜索（昵称 / 抖音号 / 用户 id）都走数据库查询。
 */
export function UsersPanel(props: {
  room: RoomRuntime | null
  /** 主进程推来新档案时递增，用来触发刷新（不做增量合并，榜单要重新排序） */
  reloadKey: number
  onOpenUser: (userId: string) => void
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const palette = usePluginPalette()
  const [sort, setSort] = useState<'recent' | 'chat' | 'gift'>('chat')
  const [keyword, setKeyword] = useState('')
  const [rows, setRows] = useState<UserRankRow[]>([])
  const [loading, setLoading] = useState(false)
  const webRid = props.room?.webRid ?? ''

  useEffect(() => {
    if (!webRid) {
      setRows([])
      return
    }
    let alive = true
    setLoading(true)
    const timer = window.setTimeout(() => {
      void api
        .usersList(webRid, sort, keyword, 300)
        .then((next) => {
          if (alive) setRows(next)
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
  }, [webRid, sort, keyword, props.reloadKey])

  if (!props.room) return <EmptyHint text={t('douyin-link.page.noActive')} />

  return (
    <Panel
      className="h-full"
      title={t('douyin-link.page.usersTitle', { count: rows.length })}
      extra={
        <Button
          size="small"
          type="text"
          danger
          icon={<RiDeleteBin6Line size={13} />}
          onClick={() => {
            void api.usersClear(webRid).then(() => {
              clearAvatarCache()
              setRows([])
            })
          }}
        >
          {t('douyin-link.page.clearUsers')}
        </Button>
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
          table={{
            rowKey: (row) => row.userId,
            dataSource: rows,
            size: 'small',
            loading,
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
                  <span style={row.stats.gift > 0 ? { color: palette.warn } : undefined}>
                    {formatNumber(row.stats.gift)}
                  </span>
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
