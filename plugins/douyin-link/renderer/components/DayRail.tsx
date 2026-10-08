import { useTranslation } from '@host/renderer/i18n'
import { Panel, ScrollStyle } from './ui'
import { formatNumber, stamp } from './OverviewPanel'
import type { DayRecordRow } from '../../shared/types'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** 这一天是不是本地时间的「今天」（今天那一行要标出来，而且它的右端是活的） */
function isToday(day: string): boolean {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return day === `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** `2026-10-08` → `10-08`（列表里年份太占地方；跨年时补上年份） */
function dayLabel(day: string, t: Translate): string {
  if (isToday(day)) return t('douyin-link.page.dayToday')
  return day.slice(5)
}

/**
 * 「每日记录」：**每一天的直播一行**（用户 2026-10-08 的要求：按天保存、有一个每天的监听列表，
 * 点一行才看那一天的详情）。
 *
 * 一行给的是这一天的量：日期 · 消息数 · 礼物抖币 · 开播次数（一天里下播又重开就多次）；
 * 点一行把详情页（概览）的时间范围切到那一天——数据全部来自库里按天聚合，不是内存里的这一场。
 */
export function DayRail(props: {
  days: DayRecordRow[]
  /** 当前选中的那一天（`''` = 没选，看的是实时/预设窗口） */
  selected: string
  loading: boolean
  onPick: (day: DayRecordRow) => void
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate

  return (
    <Panel
      className="min-h-0 flex-1"
      title={t('douyin-link.page.dayRecords', { count: props.days.length })}
    >
      {props.days.length === 0 ? (
        <span className="text-xs opacity-50">
          {props.loading ? t('douyin-link.page.loading') : t('douyin-link.page.dayRecordsEmpty')}
        </span>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <ScrollStyle />
          <div data-rb-scroll="" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
            {props.days.map((day) => {
              const active = day.day === props.selected
              return (
                <button
                  key={day.day}
                  type="button"
                  data-rb-row=""
                  className="flex min-w-0 cursor-pointer flex-col gap-0.5 rounded px-1.5 py-1 text-left"
                  style={active ? { backgroundColor: 'rgba(128,128,128,0.14)' } : undefined}
                  title={t('douyin-link.page.dayRecordHint', { day: day.day })}
                  onClick={() => props.onPick(day)}
                >
                  <span className="flex min-w-0 items-center gap-2 text-xs">
                    <span className="shrink-0 font-medium">{dayLabel(day.day, t)}</span>
                    {isToday(day.day) ? (
                      <span className="shrink-0 rounded border px-1 text-[10px] opacity-70">
                        {t('douyin-link.page.dayLive')}
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate text-right opacity-70">
                      {day.firstAt > 0 ? `${stamp(day.firstAt)} → ${stamp(day.lastAt)}` : '-'}
                    </span>
                  </span>
                  <span className="flex min-w-0 items-center gap-2 text-[10px] opacity-60">
                    <span>{t('douyin-link.page.dayMessages', { count: formatNumber(day.messages) })}</span>
                    {day.gifts > 0 ? (
                      <span>· {t('douyin-link.page.dayGifts', { count: formatNumber(day.gifts) })}</span>
                    ) : null}
                    {day.diamonds > 0 ? (
                      <span>· {t('douyin-link.page.giftDiamonds', { count: formatNumber(day.diamonds) })}</span>
                    ) : null}
                    {day.sessions > 1 ? (
                      <span>· {t('douyin-link.page.daySessions', { count: day.sessions })}</span>
                    ) : null}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </Panel>
  )
}
