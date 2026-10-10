import { useEffect, useState } from 'react'
import { Button, DatePicker, Select, Segmented } from 'antd'
import { RiArrowLeftLine, RiArrowRightLine, RiRefreshLine } from '@remixicon/react'
import type { Dayjs } from 'dayjs'
import { useTranslation } from '@host/renderer/i18n'
import type { RoomRuntime, StoredMessage } from '../../shared/types'
import api from '../api'
import { kindColor, giftRecipientText } from './DanmakuFeed'
import { ScrollStyle, roomLabel, usePluginPalette } from './ui'
import { formatNumber, stamp } from './OverviewPanel'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** 每页条数：列表自己有高度上限，翻页比一次画几百行稳 */
const PAGE_SIZE = 30
/** 列表高度上限（用内联样式，避免往 plugin.css 里引新类名） */
const LIST_MAX_HEIGHT = 216

/** 类型范围：只看弹幕 / 全部互动 */
type KindScope = 'chat' | 'any'

/**
 * 用户的历史消息：**这个人在库里发过什么**。
 *
 * 入口是「点用户」——实时弹幕里点昵称、用户榜里点一行，都会打开用户档案弹窗，
 * 这一块挂在弹窗最底下，所以两个入口拿到的是同一份东西。
 *
 * 四个决定：
 * 1. **数据是查库的，不是内存里攒的**：所以关掉应用、过了几天再点开，历史还在；
 * 2. **可按房间（容器）选**（用户 2026-10-10：「历史发言也要按照容器来选择」）：
 *    下拉里「全部房间」= 跨房间查，选具体房间 = 只看他在那个直播间的发言；默认选中当前房间；
 * 3. **可按时间区间选**（用户 2026-10-10：「查看历史区间的发言」）：日期区间按**本地自然日**
 *    取整（起 = 那天 00:00、止 = 那一天 23:59:59.999），清空 = 不限区间；
 * 4. 只画一页（默认 30 条、倒序 = 最新在前）并自带细滚动条：弹窗高度有限。
 *
 * 空态只有一句：库被清过、还没监控过、这个人没发过消息，用户看到的都是「没有」。
 */
export function UserHistory(props: {
  /** 档案所属房间；作为房间下拉的默认选中项 */
  webRid: string
  userId: string
  /** 房间下拉的可选项（拿不到就只有一个「全部房间」+ 当前房间号） */
  rooms?: RoomRuntime[]
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const palette = usePluginPalette()
  const [roomSel, setRoomSel] = useState(props.webRid)
  const [kindScope, setKindScope] = useState<KindScope>('chat')
  const [dates, setDates] = useState<[Dayjs | null, Dayjs | null] | null>(null)
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<StoredMessage[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  /** 手动刷新：加一就重查（不重挂组件，翻页状态留着） */
  const [tick, setTick] = useState(0)

  /** 由日期选择得来的时间区间（本地自然日边界；两端都选了才算区间） */
  const range =
    dates && dates[0] && dates[1]
      ? { from: dates[0].startOf('day').valueOf(), to: dates[1].endOf('day').valueOf() }
      : null

  // 换用户 / 换房间（外部传入的当前房间变了）时，把房间选择对齐并回到第一页
  useEffect(() => {
    setRoomSel(props.webRid)
    setPage(0)
  }, [props.webRid, props.userId])

  useEffect(() => {
    if (!props.userId) {
      setRows([])
      setTotal(0)
      return
    }
    let alive = true
    setLoading(true)
    void api
      .userMessages(roomSel, props.userId, {
        kind: kindScope === 'chat' ? 'chat' : '',
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        from: range?.from,
        to: range?.to
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
  }, [props.userId, roomSel, kindScope, page, range, tick])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // 数据变少（换了范围、或旧消息超了保留期）时把页码收回来，别停在空页上
  useEffect(() => {
    if (page > 0 && page >= pages) setPage(pages - 1)
  }, [page, pages])

  /** 房间号 → 展示名（`名字 · id`：同名直播间只有 id 分得清，见 ui 的 roomLabel） */
  const labelForRoom = (webRid: string): string => {
    const room = props.rooms?.find((entry) => entry.webRid === webRid)
    return room ? roomLabel(room) : webRid
  }

  /** 房间下拉的可选项：全部房间 + 已知的房间（当前房间不在清单里也补上，避免下拉显示成裸 id） */
  const roomOptions: Array<{ value: string; label: string }> = [
    { value: '', label: t('douyin-link.users.historyAllRooms') }
  ]
  const known = props.rooms ?? []
  if (props.webRid && !known.some((room) => room.webRid === props.webRid)) {
    roomOptions.push({ value: props.webRid, label: props.webRid })
  }
  for (const room of known) roomOptions.push({ value: room.webRid, label: roomLabel(room) })

  return (
    <div className="flex flex-col gap-1">
      <ScrollStyle />
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium">
            {t('douyin-link.users.historyTitle', { count: formatNumber(total) })}
          </span>
          <div className="flex min-w-0 items-center gap-2">
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
        {/* 房间（容器）+ 时间区间：两个都能自由选，选了就重查 */}
        <div className="flex flex-wrap items-center gap-2">
          <Select
            size="small"
            className="min-w-[140px] flex-1"
            value={roomSel}
            onChange={(value) => {
              setPage(0)
              setRoomSel(value)
            }}
            options={roomOptions}
          />
          <DatePicker.RangePicker
            size="small"
            allowClear
            value={dates}
            onChange={(next) => {
              setPage(0)
              setDates(next as [Dayjs | null, Dayjs | null] | null)
            }}
            placeholder={[t('douyin-link.users.historyFrom'), t('douyin-link.users.historyTo')]}
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
              {roomSel === '' ? (
                <span className="shrink-0 max-w-[92px] truncate opacity-50">{labelForRoom(row.webRid)}</span>
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
                {giftRecipientText(t, row) ? (
                  <span className="opacity-60"> {giftRecipientText(t, row)}</span>
                ) : null}
              </span>
              {row.count > 1 ? <span className="shrink-0 opacity-60">×{row.count}</span> : null}
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