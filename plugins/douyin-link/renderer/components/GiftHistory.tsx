import { useEffect, useState } from 'react'
import { Button, Modal } from 'antd'
import { RiArrowLeftLine, RiArrowRightLine, RiRefreshLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { GiftHistoryRow } from '../../shared/types'
import api from '../api'
import { ScrollStyle, formModalProps, useMoney, usePluginPalette } from './ui'
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
 *
 * `both = true`（档案「每日收益」日历里点某一天用的那条路）：**送出与收到都列出来**，
 * 逐行标 `→ 对方`（送出）/ `← 对方`（收到）。用户 2026-10-11 报的
 * 「礼物历史只能看见送的，没有收的」就是这条——日历那格同时写着两个数，明细却只给了送的。
 */
export function GiftHistoryModal(props: {
  /** 打开的这个人（空串 = 不显示弹窗） */
  userId: string
  /** 榜上的显示名，拿不到昵称时退回用户 id */
  name?: string
  webRid: string
  direction: 'sent' | 'received'
  /**
   * **两个方向都要**（默认 false）。日历「某一天的明细」用它——那一格本来就有送有收，
   * 只给一个方向等于骗人（榜上写「收礼 3.2k」点开却只有送出的）。
   */
  both?: boolean
  /**
   * **与榜单同一段时间范围**（默认就是「今天这一场」）。
   * 用户 2026-10-08：「点开显示礼物历史送内容，不能直接显示之前的内容，只能是当前的，
   * 今天的历史礼物」——所以这里不给「全部历史」，只翻这一段；榜上写 ×2 / 1,299 抖币，
   * 点开就正好是那两条。
   */
  range: { from: number; to: number } | null
  /** 层叠号（叠在别的弹窗上面时用；见 `modal-z.ts`） */
  zIndex?: number
  onClose: () => void
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const palette = usePluginPalette()
  /** 明细里的金额按当前口径显示（人民币开关） */
  const money = useMoney()
  const [rows, setRows] = useState<GiftHistoryRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  /** 手动刷新：加一就重查（不重挂组件，翻页状态留着） */
  const [tick, setTick] = useState(0)
  /** 实际查询用的方向：`both` 打开时两个方向一起查（主进程逐行标好方向） */
  const query = props.both ? 'both' : props.direction

  useEffect(() => {
    setPage(0)
  }, [props.userId, props.direction, props.both, props.webRid, props.range?.from, props.range?.to])

  useEffect(() => {
    if (!props.userId) {
      setRows([])
      setTotal(0)
      return
    }
    let alive = true
    setLoading(true)
    void api
      .giftHistory(props.webRid, props.userId, query, PAGE_SIZE, page * PAGE_SIZE, props.range)
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

  /**
   * 这一行的**对方**（送礼/收礼的另一头是谁）。
   *
   * 两个方向都要时这一列**不带箭头**：方向已经由行首那个彩色文字标签（收入/支出）说清了，
   * 再画箭头是重复表达（用户 2026-10-11 明确「不要用箭头来显示」）。
   */
  const counterpart = (row: GiftHistoryRow): string => {
    const received = props.both ? row.direction === 'received' : props.direction === 'received'
    const name = received ? row.user : row.toUser
    const id = received ? row.userId : row.toUserId
    return name || (id ? t('douyin-link.page.idOnly', { id }) : '')
  }

  return (
    <Modal
      {...formModalProps}
      open={Boolean(props.userId)}
      title={t('douyin-link.page.giftHistoryTitle')}
      onCancel={props.onClose}
      /* 层叠号由调用方给（叠在日历上面时要 > 日历，见 `modal-z.ts`） */
      zIndex={props.zIndex}
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
                props.both
                  ? 'douyin-link.page.giftHistoryBoth'
                  : props.direction === 'received'
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
            rows.map((row) => {
              /*
               * 方向（只有「两个方向都要」时才有这一列）：**时间前面**一个彩色文字标签，
               * 收入 = 绿（`palette.up`，他收到的）/ 支出 = 琥珀（`palette.warn`，他送出的）——
               * 与日历里送礼/收礼两行、礼物价值那两个数同一套色，颜色本身就是口径。
               * 用户 2026-10-11：「不要用箭头来显示，要放在时间的前面，用文字，收入，支出，来表示，
               * 用不同颜色」。
               */
              const income = row.direction === 'received'
              return (
                <div
                  key={`${row.webRid}-${row.id}`}
                  data-rb-row=""
                  className="flex min-w-0 items-baseline gap-2 rounded px-1 py-0.5 text-xs leading-5"
                >
                  {props.both ? (
                    <span
                      data-rb-gift-direction={income ? 'received' : 'sent'}
                      className="w-8 shrink-0 text-center font-medium"
                      style={{ color: income ? palette.up : palette.warn }}
                    >
                      {t(income ? 'douyin-link.page.giftHistoryIncome' : 'douyin-link.page.giftHistoryExpense')}
                    </span>
                  ) : null}
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
                      ? t('douyin-link.page.giftDiamonds', { count: money.text(row.diamonds), unit: t(money.unitKey) })
                      : t('douyin-link.page.giftValueUnknown')}
                  </span>
                </div>
              )
            })
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
