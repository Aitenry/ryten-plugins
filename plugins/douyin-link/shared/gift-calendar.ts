/**
 * 「本地自然日 / 本地月份」的桶算法（双端共用）。
 *
 * 为什么必须只有一份：数据库里的分天口径是 SQL 表达式
 * `floor((at_ms + 时区偏移) / 86400000)`，而**每日收益日历**要按界面上的「几号」排格子、
 * 点在格子上要算出「那一天的 00:00 ~ 23:59」去查明细。三处（SQL / 主进程 / 渲染层）
 * 各写一遍必然会错位一天（尤其跨夏令时的月份），所以统一收在这里。
 *
 * 约定：偏移取「该时刻的本地偏移」，所以**同一个本地日的 at_ms 一定落进同一个桶**；
 * 用 UTC 语义构造零点（`Date.UTC`）再加回偏移，是为了让「本地某天的零点」可复现。
 */

/** 一天（ms） */
export const DAY_MS = 86400000

/** 某个时刻的本地时区偏移（ms；东八区 = +28800000） */
export function localOffsetMs(at: number = Date.now()): number {
  return -new Date(at).getTimezoneOffset() * 60000
}

/** 某个时刻落在哪个本地日桶（与 SQL 的 `floor((at_ms + 偏移) / 86400000)` 同一个数） */
export function dayBucketOf(at: number): number {
  return Math.floor((at + localOffsetMs(at)) / DAY_MS)
}

/**
 * 一个本地月份（`YYYY-MM`）的日桶范围：`from` = 1 号、`to` = 最后一天。
 *
 * 别用 `dayBucketOf(本地零点)` 去算（第一版就是那么写的，工装立刻抓出来整体差一天）：
 * 桶号是 `floor((at_ms + 偏移) / 86400000)`，把**本地**零点代进去会被 8 小时的偏移推回前一天。
 * 桶号本身是「从 1970-01-01 起数到那一天的**日期序号**」，所以直接用
 * `Date.UTC(年, 月, 日) / 86400000` 就是它——与偏移无关。偏移只在把桶号换回时刻时才用得上
 * （见 `dayRangeOf`）。非法月份回 `from > to` 的空范围。
 */
export function monthBucketRange(month: string): { from: number; to: number } {
  const parts = parseMonth(month)
  if (!parts) return { from: 0, to: -1 }
  const { year, index } = parts
  return {
    from: Math.floor(Date.UTC(year, index, 1) / DAY_MS),
    to: Math.floor(Date.UTC(year, index + 1, 0) / DAY_MS)
  }
}

/**
 * 一个日桶 → 那一天的**起止毫秒**（本地 00:00:00.000 → 23:59:59.999）。
 *
 * 界面点日历格子要拿它去查明细（`gift-history` 的 `from`/`to`）。偏移按**那一天**取，
 * 所以跨夏令时的那一天也能对得上。
 */
export function dayRangeOf(bucket: number): { from: number; to: number } {
  const utcMidnight = bucket * DAY_MS
  const offset = localOffsetMs(utcMidnight)
  const from = utcMidnight - offset
  return { from, to: from + DAY_MS - 1 }
}

/** 解析 `YYYY-MM`（非法回 null） */
function parseMonth(month: string): { year: number; index: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month ?? ''))
  if (!match) return null
  const year = Number(match[1])
  const index = Number(match[2]) - 1
  if (!Number.isFinite(year) || index < 0 || index > 11) return null
  return { year, index }
}

/** 某个时刻的本地月份（`YYYY-MM`） */
export function monthOf(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 一个本地日桶摊成日历格子要的东西：这个月每一天的桶号 / 几号 / `YYYY-MM-DD`。
 *
 * 界面用它画日历（前面补几个空格由 `leadingBlanks` 给，**周一起**，与表头一致）。
 */
export function monthDays(month: string): {
  leadingBlanks: number
  days: Array<{ bucket: number; dayOfMonth: number; label: string }>
} {
  const parts = parseMonth(month)
  if (!parts) return { leadingBlanks: 0, days: [] }
  const { year, index } = parts
  const first = new Date(year, index, 1)
  // getDay()：0 = 周日；表头是周一起，所以周日排最后（+6 mod 7）
  const leadingBlanks = (first.getDay() + 6) % 7
  const lastDay = new Date(year, index + 1, 0).getDate()
  const days: Array<{ bucket: number; dayOfMonth: number; label: string }> = []
  for (let day = 1; day <= lastDay; day += 1) {
    days.push({
      // 桶号就是「从 1970-01-01 数到这一天的日期序号」（见 `monthBucketRange` 的说明）
      bucket: Math.floor(Date.UTC(year, index, day) / DAY_MS),
      dayOfMonth: day,
      label: `${year}-${String(index + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    })
  }
  return { leadingBlanks, days }
}
