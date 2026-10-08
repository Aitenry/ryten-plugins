import { useEffect, useState } from 'react'
import { Button, Segmented } from 'antd'
import { RiArrowLeftLine, RiArrowRightLine, RiRefreshLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { RoomRuntime, StoredMessage } from '../../shared/types'
import api from '../api'
import { kindColor } from './DanmakuFeed'
import { ScrollStyle, usePluginPalette } from './ui'
import { formatNumber, stamp } from './OverviewPanel'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** 每页条数：列表自己有高度上限，翻页比一次画几百行稳 */
const PAGE_SIZE = 30
/** 列表高度上限（用内联样式，避免往 plugin.css 里引新类名） */
const LIST_MAX_HEIGHT = 216

/** 查询范围：本房间 / 全部房间（`webRid` 空串就是跨房间） */
type Scope = 'room' | 'all'
/** 类型范围：只看弹幕 / 全部互动 */
type KindScope = 'chat' | 'any'

/**
 * 用户的历史消息：**这个人在库里发过什么**。
 *
 * 入口是「点用户」——实时弹幕里点昵称、用户榜里点一行，都会打开用户档案弹窗，
 * 这一块挂在弹窗最底下，所以两个入口拿到的是同一份东西。
 *
 * 三个决定：
 * 1. **数据是查库的，不是内存里攒的**：所以关掉应用、过了几天再点开，历史还在
 *    （内存里只有这几分钟的最近弹幕）；
 * 2. 范围能切到「全部房间」：消息流水按 `userId` 就能跨房间查，而用户统计是**按房间**存的，
 *    两边口径不同——用户榜上的发言数只算这个房间，这里翻的可以是他在所有直播间的发言；
 * 3. 只画一页（默认 30 条、倒序 = 最新在前）并自带细滚动条：弹窗高度有限，
 *    一页页翻比一次性把几千条塞进 DOM 稳。
 *
 * 空态只有一句：库被清过、还没监控过、这个人没发过消息，用户看到的都是「没有」。
 */
export function UserHistory(props: {
  /** 档案所属房间；切到「全部房间」时查询会丢掉它 */
  webRid: string
  userId: string
  /** 跨房间时把 webRid 翻成直播间名（拿不到就显示房间号） */
  rooms?: RoomRuntime[]
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const palette = usePluginPalette()
  const [scope, setScope] = useState<Scope>('room')
  const [kindScope, setKindScope] = useState<KindScope>('chat')
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<StoredMessage[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  /** 手动刷新：加一就重查（不重挂组件，翻页状态留着） */
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!props.userId) {
      setRows([])
      setTotal(0)
      return
    }
    let alive = true
    setLoading(true)
    void api
      .userMessages(scope === 'all' ? '' : props.webRid, props.userId, {
        kind: kindScope === 'chat' ? 'chat' : '',
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE
      })
      .then((result) => {
        if (!alive) return
        setRows(result.rows)
        setTotal(result.total)
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [props.webRid, props.userId, scope, kindScope, page, tick])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // 数据变少（换了范围、或旧消息超了保留期）时把页码收回来，别停在空页上
  useEffect(() => {
    if (page > 0 && page >= pages) setPage(pages - 1)
  }, [page, pages])

  const roomLabel = (webRid: string): string =>
    props.rooms?.find((room) => room.webRid === webRid)?.title || webRid

  return (
    <div className="flex flex-col gap-1">
      <ScrollStyle />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium">
          {t('douyin-link.users.historyTitle', { count: formatNumber(total) })}
        </span>
        <div className="flex min-w-0 items-center gap-2">
          <Segmented
            size="small"
            value={scope}
            onChange={(value) => {
              setPage(0)
              setScope(value as Scope)
            }}
            options={[
              { value: 'room', label: t('douyin-link.users.historyRoom') },
              { value: 'all', label: t('douyin-link.users.historyAllRooms') }
            ]}
          />
          <Segmented
            size="small"
            value={kindScope}
            onChange={(value) => {
              setPage(0)
              setKindScope(value as KindScope)
            }}
            options={[
              { value: 'chat', label: t('douyin-link.users.historyChat') },
              { value: 'any', label: t('douyin-link.users.historyAny') }
            ]}
          />
          <Button
            size="small"
            type="text"
            loading={loading}
            title={t('douyin-link.users.historyRefresh')}
            icon={<RiRefreshLine size={13} />}
            onClick={() => setTick((previous) => previous + 1)}
          />
        </div>
      </div>

      <div
        data-rb-scroll=""
        className="flex flex-col gap-1 overflow-y-auto pr-1"
        style={{ maxHeight: LIST_MAX_HEIGHT, minHeight: 44 }}
      >
        {rows.length === 0 ? (
          <span className="px-1 py-2 text-xs opacity-50">
            {loading ? t('douyin-link.page.loading') : t('douyin-link.users.historyEmpty')}
          </span>
        ) : (
          rows.map((row) => (
            <div
              key={`${row.webRid}-${row.id}`}
              data-rb-row=""
              className="flex min-w-0 items-baseline gap-2 rounded px-1 py-0.5 text-xs leading-5"
            >
              <span className="shrink-0 opacity-60">{stamp(row.at)}</span>
              {scope === 'all' ? (
                <span className="shrink-0 max-w-[92px] truncate opacity-50">{roomLabel(row.webRid)}</span>
              ) : null}
              {kindScope === 'any' ? (
                <span
                  className="shrink-0 rounded border px-1 text-[10px]"
                  style={{ color: kindColor(row.kind, palette), borderColor: kindColor(row.kind, palette) }}
                >
                  {t(`douyin-link.kinds.${row.kind}`)}
                </span>
              ) : null}
              {/* 正文可能很长：单行截断 + 原生 title 兜全文（列表要的是「扫一眼」） */}
              <span className="min-w-0 flex-1 truncate" title={row.text}>
                {row.text || '-'}
              </span>
              {row.count > 1 ? <span className="shrink-0 opacity-60">×{row.count}</span> : null}
              {row.diamonds > 0 ? (
                <span className="shrink-0" style={{ color: palette.warn }}>
                  {t('douyin-link.page.giftDiamonds', { count: row.diamonds })}
                </span>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs opacity-50">{t('douyin-link.page.total', { count: formatNumber(total) })}</span>
        <div className="flex items-center gap-2">
          <Button
            size="small"
            icon={<RiArrowLeftLine size={13} />}
            disabled={page <= 0}
            onClick={() => setPage((previous) => Math.max(0, previous - 1))}
          >
            {t('douyin-link.page.prev')}
          </Button>
          <span className="text-xs opacity-50">
            {t('douyin-link.page.pageOf', { page: page + 1, pages })}
          </span>
          <Button
            size="small"
            icon={<RiArrowRightLine size={13} />}
            disabled={page + 1 >= pages}
            onClick={() => setPage((previous) => Math.min(pages - 1, previous + 1))}
          >
            {t('douyin-link.page.next')}
          </Button>
        </div>
      </div>
    </div>
  )
}
