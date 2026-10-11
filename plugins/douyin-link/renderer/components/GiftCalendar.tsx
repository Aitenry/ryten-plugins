import { useEffect, useMemo, useState } from 'react'
import { Button, Modal, Tooltip, theme } from 'antd'
import { RiArrowLeftSLine, RiArrowRightSLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { GiftDayRow } from '../../shared/types'
import { dayRangeOf, monthDays } from '../../shared/gift-calendar'
import api from '../api'
import { ScrollStyle, usePluginPalette, type PluginPalette } from './ui'
import { formatNumber } from './OverviewPanel'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** 一周的表头 key（**周一起**，与日历格子的排列一致；文案走词条，别在组件里硬编码语言） */
const WEEKDAY_KEYS = [
  'douyin-link.users.weekdayMon',
  'douyin-link.users.weekdayTue',
  'douyin-link.users.weekdayWed',
  'douyin-link.users.weekdayThu',
  'douyin-link.users.weekdayFri',
  'douyin-link.users.weekdaySat',
  'douyin-link.users.weekdaySun'
]

/**
 * 档案里「送礼 / 收礼」点开的**每日收益**弹窗（用户 2026-10-11：
 * 「点击后可以查看每一个月的每一天送礼和收礼的抖币，这个内容 UI 向股票的每日收益的样式」）。
 *
 * 版式就是股票 App 的月度收益日历：
 * - 一行一个月份条（`‹ 2026-10 ›` + 这个月的合计），有记录的月份都能翻；
 * - 下面 7 列日历，**一个格子 = 一天**，格子里**上下两行**：送礼（上一行）/ 收礼（下一行）；
 * - 金额按**当月的最大值**给深浅（读数靠数字，颜色只给量级感）；
 * - 点一格 → 打开这一天的礼物明细（复用礼物历史弹窗，`range` 就是那一天）。
 *
 * 口径全部来自主进程（跨全部直播间、按画像的全部账号合计，见 `hub.userGiftCalendar`），
 * 界面不自己聚合。
 */
export function GiftCalendarModal(props: {
  /** 打开的这个人（空串 = 不显示弹窗） */
  userId: string
  /** 档案上的显示名 */
  name: string
  onClose: () => void
  /** 点某一天 → 看那一天的礼物明细 */
  onPickDay: (range: { from: number; to: number }) => void
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate

  const palette = usePluginPalette()
  const { token } = theme.useToken()
  const [month, setMonth] = useState('')
  const [months, setMonths] = useState<string[]>([])
  const [days, setDays] = useState<GiftDayRow[]>([])
  const [loading, setLoading] = useState(false)

  /** 换人 / 第一次打开：月份回到「有记录的最近一个月」（主进程会给这个默认值） */
  useEffect(() => {
    if (!props.userId) {
      setMonth('')
      setMonths([])
      setDays([])
      return
    }
    let alive = true
    setLoading(true)
    void api
      .userGiftCalendar(props.userId, '')
      .then((data) => {
        if (!alive) return
        setMonth(data.month)
        setMonths(data.months)
        setDays(data.days)
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [props.userId])

  /** 翻月：查那一个月（月份清单只在第一次拿，翻页不会变） */
  const goMonth = (next: string): void => {
    if (!props.userId || !next) return
    setLoading(true)
    void api
      .userGiftCalendar(props.userId, next)
      .then((data) => {
        setMonth(data.month)
        if (data.months.length > 0) setMonths(data.months)
        setDays(data.days)
      })
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }

  const byBucket = useMemo(() => new Map(days.map((row) => [row.bucket, row])), [days])
  /** 日历格子：桶号 / 几号 / 日期串（本地口径与主进程同一份实现，见 `shared/gift-calendar.ts`） */
  const layout = useMemo(() => monthDays(month), [month])
  /** 这个月的合计（放在月份条右边；没数据就是两个 0） */
  const totals = useMemo(
    () =>
      days.reduce(
        (acc, row) => ({ sent: acc.sent + row.sent, received: acc.received + row.received }),
        { sent: 0, received: 0 }
      ),
    [days]
  )
  const peak = useMemo(
    () => days.reduce((max, row) => Math.max(max, row.sent, row.received), 0),
    [days]
  )
  /** 有记录的月份（升序）→ 上/下一个月能不能翻 */
  const sorted = useMemo(() => [...months].sort(), [months])
  const index = sorted.indexOf(month)
  const previousMonth = index > 0 ? sorted[index - 1] : ''
  const nextMonth = index >= 0 && index < sorted.length - 1 ? sorted[index + 1] : ''

  /** 星期表头（词条里有中英两份，界面语言由宿主决定） */
  const weekdayLabels = WEEKDAY_KEYS.map((key) => t(key))

  return (
    <Modal
      open={Boolean(props.userId)}
      title={t('douyin-link.users.giftCalendarTitle', { name: props.name })}
      onCancel={props.onClose}
      footer={null}
      /* 比档案弹窗宽一点：7 列日历横向要放得下 */
      width={560}
    >
      <div className="flex flex-col gap-2">
        <ScrollStyle />
        {/* 月份条：‹ 2026-10 › + 本月合计 */}
        <div className="flex min-w-0 items-center gap-2">
          <Button
            size="small"
            type="text"
            disabled={!previousMonth}
            title={t('douyin-link.users.giftCalendarPrev')}
            aria-label={t('douyin-link.users.giftCalendarPrev')}
            icon={<RiArrowLeftSLine size={16} />}
            onClick={() => goMonth(previousMonth)}
          />
          <span className="text-sm font-semibold">{month || '-'}</span>
          <Button
            size="small"
            type="text"
            disabled={!nextMonth}
            title={t('douyin-link.users.giftCalendarNext')}
            aria-label={t('douyin-link.users.giftCalendarNext')}
            icon={<RiArrowRightSLine size={16} />}
            onClick={() => goMonth(nextMonth)}
          />
          <span className="ml-auto min-w-0 truncate text-[11px] opacity-60">
            {t('douyin-link.users.giftCalendarMonthTotal', {
              sent: formatNumber(totals.sent),
              received: formatNumber(totals.received)
            })}
          </span>
        </div>

        {/* 星期表头 */}
        <div className="grid grid-cols-7 gap-1">
          {weekdayLabels.map((label) => (
            <span key={label} className="text-center text-[10px] opacity-50">
              {label}
            </span>
          ))}
        </div>

        {/* 日历本体：一格一天，格内上下两行（送礼 / 收礼） */}
        {days.length === 0 && !loading ? (
          <span className="py-4 text-center text-xs opacity-50">
            {t('douyin-link.users.giftCalendarEmpty')}
          </span>
        ) : (
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: layout.leadingBlanks }, (_value, key) => (
              <span key={`pad-${key}`} />
            ))}
            {layout.days.map((day) => {
              const row = byBucket.get(day.bucket)
              const sent = row?.sent ?? 0
              const received = row?.received ?? 0
              const empty = sent === 0 && received === 0
              /** 悬浮面板：标题行（日期 + 合计）+ 发丝线 + 送/收两行左右对齐（见 WORKSHOP 的浮层规范） */
              const lines: Array<{ label: string; color: string; gifts: number; diamonds: number; key: string }> = [
                {
                  key: 'sent',
                  label: t('douyin-link.users.giftCalendarSentRow'),
                  color: palette.up,
                  gifts: row?.sentGifts ?? 0,
                  diamonds: sent
                },
                {
                  key: 'received',
                  label: t('douyin-link.users.giftCalendarReceivedRow'),
                  color: palette.warn,
                  gifts: row?.receivedGifts ?? 0,
                  diamonds: received
                }
              ]
              return (
                <Tooltip
                  key={day.bucket}
                  mouseEnterDelay={0.15}
                  styles={{ root: { maxWidth: 340 } }}
                  title={
                    <div style={{ minWidth: 200 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                        <span style={{ fontWeight: 500 }}>{day.label}</span>
                        <span style={{ opacity: 0.75 }}>
                          {`${formatNumber(sent + received)} ${t('douyin-link.page.kpiDiamondsUnit')}`}
                        </span>
                      </div>
                      <div style={{ margin: '4px 0', borderTop: `1px solid ${palette.split}` }} />
                      {lines.map((line) => (
                        <div
                          key={line.key}
                          style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}
                        >
                          <span>
                            <span
                              style={{
                                display: 'inline-block',
                                width: 6,
                                height: 6,
                                borderRadius: 1,
                                marginRight: 4,
                                background: line.color
                              }}
                            />
                            {line.label}
                          </span>
                          <span>
                            {line.gifts > 0
                              ? t(
                                  line.key === 'sent'
                                    ? 'douyin-link.users.giftCalendarDaySent'
                                    : 'douyin-link.users.giftCalendarDayReceived',
                                  {
                                    count: formatNumber(line.gifts),
                                    diamonds: formatNumber(line.diamonds)
                                  }
                                )
                              : '-'}
                          </span>
                        </div>
                      ))}
                    </div>
                  }
                >
                  <button
                    type="button"
                    data-rb-row=""
                    className="flex cursor-pointer flex-col items-stretch gap-0.5 rounded px-1 py-1 text-left"
                    style={{
                      backgroundColor: empty ? palette.soft : token.colorFillQuaternary,
                      border: `1px solid ${empty ? 'transparent' : palette.split}`
                    }}
                    onClick={() => props.onPickDay(dayRangeOf(day.bucket))}
                  >
                    <span className={`text-[10px] ${empty ? 'opacity-40' : 'opacity-70'}`}>{day.dayOfMonth}</span>
                    <DayAmount value={sent} peak={peak} color={palette.up} palette={palette} />
                    <DayAmount value={received} peak={peak} color={palette.warn} palette={palette} />
                  </button>
                </Tooltip>
              )
            })}
          </div>
        )}

        {/* 有记录的月份：作为翻页的落点（比只给上/下箭头好找） */}
        {sorted.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1">
            <span className="shrink-0 text-[10px] opacity-50">{t('douyin-link.users.giftCalendarPickMonth')}</span>
            {[...sorted].reverse().map((entry) => (
              <button
                key={entry}
                type="button"
                className="cursor-pointer rounded px-1.5 py-0.5 text-[10px]"
                style={{
                  backgroundColor: entry === month ? palette.accent : palette.soft,
                  color: entry === month ? '#fff' : undefined
                }}
                onClick={() => goMonth(entry)}
              >
                {entry}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

/** 格子里的一个金额：0 显示成一个淡点（不是「0」），有数就按当月峰值给深浅 */
function DayAmount(props: {
  value: number
  peak: number
  color: string
  palette: PluginPalette
}): React.JSX.Element {
  if (props.value <= 0) {
    return <span className="text-[10px] leading-3 opacity-25">·</span>
  }
  /**
   * 量级用**透明度**表达（0.55 → 1），跟数字一起读，不靠色相区分送/收。
   *
   * 下限给到 0.55 而不是更低（第一版是 0.35）：日历里最小的一档往往是几十抖币，
   * 压到 0.35 在这个字号下几乎看不见——深浅只该是「量级感」，不该把数字读没了。
   */
  const ratio = props.peak > 0 ? props.value / props.peak : 1
  return (
    <span
      className="truncate text-[10px] font-medium leading-3"
      style={{ color: props.color, opacity: 0.55 + 0.45 * Math.min(1, ratio) }}
      title={formatNumber(props.value)}
    >
      {compact(props.value)}
    </span>
  )
}

/**
 * 格子里的数字要短：1,234 → `1.2k`、23,456 → `2.3w`。
 *
 * 日历格子只有几十像素宽，写全数字必然被截断成「1,2…」——按量级缩写才能一眼看出哪天多。
 * 悬浮与点开的明细里都是**完整数字**，缩写只出现在格子里。
 */
function compact(value: number): string {
  if (value >= 10000) return `${Math.round(value / 1000) / 10}w`
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`
  return String(Math.round(value))
}
