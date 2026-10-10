import { useEffect, useState } from 'react'
import { Button, Modal } from 'antd'
import { RiArrowLeftLine, RiArrowRightLine, RiRefreshLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { StoredMessage } from '../../shared/types'
import api from '../api'
import { ScrollStyle, formModalProps, usePluginPalette } from './ui'
import { formatNumber, stamp } from './OverviewPanel'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** 每页条数（弹窗有高度上限，翻页比一次画几百行稳） */
const PAGE_SIZE = 30
/** 列表高度上限（内联样式，避免往 plugin.css 里引新类名） */
const LIST_MAX_HEIGHT = 260

/**
 * 礼物榜点一行后的**礼物历史**弹窗：这个人送出去的 / 收到的礼物明细。
 *
 * 数据是查库的（`plugin:douyin-link:gift-history` → 消息流水的 `userId` / `toUserId` 过滤），
 * 所以关掉应用、过几天再点开，历史还在——礼物名与抖币就是当时解出来的那两个值。
 *
 * 一行 = 一条礼物记录：时间 · 礼物名 · 对方（收礼/送礼口径随榜单）· 件数 · 抖币；
 * 抖币为 0 的显示「价值未知」（官方没给价，不写成 0）。
 */
export function GiftHistoryModal(props: {
  /** 打开的这个人（空串 = 不显示弹窗） */
  userId: string
  /** 榜上的显示名，拿不到昵称时退回用户 id */
  name?: string
  webRid: string
  direction: 'sent' | 'received'
  /**
   * **与榜单同一段时间范围**（默认就是「今天这一场」）。
   * 用户 2026-10-08：「点开显示礼物历史送内容，不能直接显示之前的内容，只能是当前的，
   * 今天的历史礼物」——所以这里不给「全部历史」，只翻这一段；榜上写 ×2 / 1,299 抖币，
   * 点开就正好是那两条。
   */
  range: { from: number; to: number } | null
  onClose: () => void
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const palette = usePluginPalette()
  const [rows, setRows] = useState<StoredMessage[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  /** 手动刷新：加一就重查（不重挂组件，翻页状态留着） */
  const [tick, setTick] = useState(0)

  useEffect(() => {
    setPage(0)
  }, [props.userId, props.direction, props.webRid, props.range?.from, props.range?.to])

  useEffect(() => {
    if (!props.userId) {
      setRows([])
      setTotal(0)
      return
    }
    let alive = true
    setLoading(true)
    void api
      .giftHistory(props.webRid, props.userId, props.direction, PAGE_SIZE, page * PAGE_SIZE, props.range)
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
  }, [props.webRid, props.userId, props.direction, props.range?.from, props.range?.to, page, tick])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  // 数据变少（旧消息超了保留期）时把页码收回来，别停在空页上
  useEffect(() => {
    if (page > 0 && page >= pages) setPage(pages - 1)
  }, [page, pages])

  const counterpart = (row: StoredMessage): string => {
    const name = props.direction === 'received' ? row.user : row.toUser
    const id = props.direction === 'received' ? row.userId : row.toUserId
    return name || (id ? t('douyin-link.page.idOnly', { id }) : '')
  }

  return (
    <Modal
      {...formModalProps}
      open={Boolean(props.userId)}
      title={t('douyin-link.page.giftHistoryTitle')}
      onCancel={props.onClose}
      /* 没有页脚：底部那个「关闭」跟右上角的 × 是同一件事，去掉后正文多出一行高度 */
      footer={null}
    >
      <div className="flex flex-col gap-2">
        <ScrollStyle />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs">
            <span className="font-medium">{props.name || t('douyin-link.page.unknownUser')}</span>
            <span className="opacity-60">
              {' · '}
              {t(
                props.direction === 'received'
                  ? 'douyin-link.page.giftHistoryReceived'
                  : 'douyin-link.page.giftHistorySent'
              )}
              {' · '}
              {t('douyin-link.page.total', { count: formatNumber(total) })}
              {/* 写清这一页翻的是哪一段（今天这一场 / 选中的那一段），免得以为是全部历史 */}
              {props.range && props.range.to > props.range.from ? (
                <span className="opacity-70">
                  {' · '}
                  {t('douyin-link.page.giftHistoryRange', {
                    from: stamp(props.range.from),
                    to: stamp(props.range.to)
                  })}
                </span>
              ) : null}
            </span>
          </span>
          <Button
            size="small"
            type="text"
            loading={loading}
            title={t('douyin-link.users.historyRefresh')}
            icon={<RiRefreshLine size={13} />}
            onClick={() => setTick((previous) => previous + 1)}
          />
        </div>

        <div
          data-rb-scroll=""
          className="flex flex-col gap-1 overflow-y-auto pr-1"
          style={{ maxHeight: LIST_MAX_HEIGHT, minHeight: 44 }}
        >
          {rows.length === 0 ? (
            <span className="px-1 py-2 text-center text-xs opacity-50">
              {loading ? t('douyin-link.page.loading') : t('douyin-link.page.giftHistoryEmpty')}
            </span>
          ) : (
            rows.map((row) => (
              <div
                key={`${row.webRid}-${row.id}`}
                data-rb-row=""
                className="flex min-w-0 items-baseline gap-2 rounded px-1 py-0.5 text-xs leading-5"
              >
                <span className="shrink-0 opacity-60">{stamp(row.at)}</span>
                <span className="min-w-0 flex-1 truncate" title={row.text}>
                  {row.text || t('douyin-link.page.giftNameUnknown')}
                </span>
                <span className="max-w-[110px] shrink-0 truncate opacity-60" title={counterpart(row)}>
                  {counterpart(row)}
                </span>
                {row.count > 1 ? <span className="shrink-0 opacity-60">×{row.count}</span> : null}
                <span className="w-16 shrink-0 text-right font-medium" style={{ color: palette.warn }}>
                  {row.diamonds > 0
                    ? t('douyin-link.page.giftDiamonds', { count: formatNumber(row.diamonds) })
                    : t('douyin-link.page.giftValueUnknown')}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs opacity-50">{t('douyin-link.page.pageOf', { page: page + 1, pages })}</span>
          <div className="flex items-center gap-2">
            <Button
              size="small"
              icon={<RiArrowLeftLine size={13} />}
              disabled={page <= 0}
              onClick={() => setPage((previous) => Math.max(0, previous - 1))}
            >
              {t('douyin-link.page.prev')}
            </Button>
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
    </Modal>
  )
}
