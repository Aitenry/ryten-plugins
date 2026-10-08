import { useEffect, useState } from 'react'
import { Button, Input, Radio, Select } from 'antd'
import { RiArrowLeftLine, RiArrowRightLine, RiSearchLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import { DANMAKU_KINDS, type DanmakuKind, type RoomRuntime, type StoredMessage } from '../../shared/types'
import api from '../api'
import { EmptyHint, FitTable, Panel } from './ui'
import { formatNumber, stamp } from './OverviewPanel'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** 每页条数（多拿一点，FitTable 按容器高度自己决定画几行） */
const PAGE_SIZE = 100

/** 时间窗候选（0 = 不限） */
const RANGES = [
  { value: 60, key: 'douyin-link.page.window60' },
  { value: 360, key: 'douyin-link.page.window6h' },
  { value: 1440, key: 'douyin-link.page.window24h' },
  { value: 10080, key: 'douyin-link.page.window7d' },
  { value: 0, key: 'douyin-link.page.windowAll' }
]

/**
 * 检索页签：**在自己的库里翻历史消息**（关键词 / 类型 / 房间 / 时间窗）。
 *
 * 这是这一版最实用的能力：上一版的「最近弹幕」只在内存里（页面一刷新就没了、
 * 关掉应用更是没了），现在每条消息都按批写进 `douyin_link_messages`，
 * 翻页与统计都由数据库做（`messages-query` 通道）。
 */
export function SearchPanel(props: {
  rooms: RoomRuntime[]
  activeRoom: string
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const [webRid, setWebRid] = useState(props.activeRoom)
  const [kind, setKind] = useState<DanmakuKind | ''>('')
  const [keyword, setKeyword] = useState('')
  const [range, setRange] = useState(1440)
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<StoredMessage[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  /** 换房间时跟随（用户没手动选过就一直跟着分析中的房间） */
  const [manual, setManual] = useState(false)

  useEffect(() => {
    if (!manual && props.activeRoom && props.activeRoom !== webRid) setWebRid(props.activeRoom)
  }, [props.activeRoom, manual, webRid])

  const run = (targetPage = page): void => {
    setLoading(true)
    const from = range > 0 ? Date.now() - range * 60000 : 0
    void api
      .messagesQuery({ webRid, kind, keyword: keyword.trim(), from, limit: PAGE_SIZE, offset: targetPage * PAGE_SIZE })
      .then((result) => {
        setRows(result.rows)
        setTotal(result.total)
      })
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }

  // 条件变了就重新查（翻页也走这里，页码从 0 开始）
  useEffect(() => {
    run(page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webRid, kind, range, page])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <Panel className="h-full" title={t('douyin-link.page.searchTitle')}>
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Select
            size="small"
            style={{ width: 180 }}
            value={webRid}
            onChange={(value) => {
              setManual(true)
              setPage(0)
              setWebRid(value)
            }}
            options={[
              { value: '', label: t('douyin-link.page.roomAny') },
              ...props.rooms.map((room) => ({ value: room.webRid, label: room.title || room.webRid }))
            ]}
          />
          <Select
            size="small"
            style={{ width: 120 }}
            value={kind}
            onChange={(value) => {
              setPage(0)
              setKind(value as DanmakuKind | '')
            }}
            options={[
              { value: '', label: t('douyin-link.page.kindAny') },
              ...DANMAKU_KINDS.filter((entry) => entry !== 'control' && entry !== 'system' && entry !== 'stats').map(
                (entry) => ({ value: entry, label: t(`douyin-link.kinds.${entry}`) })
              )
            ]}
          />
          <Input
            size="small"
            allowClear
            className="min-w-0 flex-1"
            prefix={<RiSearchLine size={13} />}
            placeholder={t('douyin-link.page.keywordPlaceholder')}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onPressEnter={() => {
              setPage(0)
              run(0)
            }}
          />
          <Button
            size="small"
            type="primary"
            loading={loading}
            onClick={() => {
              setPage(0)
              run(0)
            }}
          >
            {t('douyin-link.page.search')}
          </Button>
        </div>

        <div className="shrink-0">
          <Radio.Group
            size="small"
            value={range}
            onChange={(event) => {
              setPage(0)
              setRange(Number(event.target.value))
            }}
            options={RANGES.map((entry) => ({ value: entry.value, label: t(entry.key) }))}
            optionType="button"
          />
        </div>

        {rows.length === 0 && !loading ? (
          <EmptyHint text={t('douyin-link.page.noMatches')} />
        ) : (
          <FitTable<StoredMessage>
            table={{
              rowKey: (row) => `${row.webRid}-${row.id}`,
              dataSource: rows,
              size: 'small',
              loading,
              pagination: false,
              columns: [
                {
                  title: t('douyin-link.page.colTime'),
                  dataIndex: 'at',
                  width: 118,
                  render: (value: number) => <span className="min-w-0 truncate opacity-70">{stamp(value)}</span>
                },
                {
                  title: t('douyin-link.page.colRoom'),
                  dataIndex: 'webRid',
                  width: 108,
                  ellipsis: true,
                  render: (value: string) => (
                    <span className="min-w-0 truncate opacity-70">
                      {props.rooms.find((room) => room.webRid === value)?.title || value}
                    </span>
                  )
                },
                {
                  title: t('douyin-link.page.colKind'),
                  dataIndex: 'kind',
                  width: 68,
                  render: (value: DanmakuKind) => (
                    <span className="min-w-0 truncate">{t(`douyin-link.kinds.${value}`)}</span>
                  )
                },
                {
                  title: t('douyin-link.page.colUser'),
                  dataIndex: 'user',
                  width: 140,
                  ellipsis: true,
                  render: (value: string) => <span className="min-w-0 truncate">{value || '-'}</span>
                },
                {
                  title: t('douyin-link.page.colText'),
                  dataIndex: 'text',
                  ellipsis: true,
                  render: (_value, row) => (
                    <span className="min-w-0 truncate">
                      {row.text}
                      {row.count > 1 ? <span className="opacity-60"> ×{row.count}</span> : null}
                      {row.diamonds > 0 ? (
                        <span className="opacity-60"> · {t('douyin-link.page.kpiDiamondsValue', { count: row.diamonds })}</span>
                      ) : null}
                    </span>
                  )
                }
              ]
            }}
          />
        )}

        <div className="flex shrink-0 items-center justify-between gap-2">
          <span className="text-xs opacity-60">{t('douyin-link.page.total', { count: formatNumber(total) })}</span>
          <div className="flex items-center gap-2">
            <Button
              size="small"
              icon={<RiArrowLeftLine size={13} />}
              disabled={page <= 0}
              onClick={() => setPage((previous) => Math.max(0, previous - 1))}
            >
              {t('douyin-link.page.prev')}
            </Button>
            <span className="text-xs opacity-60">
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
    </Panel>
  )
}
