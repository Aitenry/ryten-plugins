/**
 * **消费评分**：把「花了多少」压成 0-100 的一个数，与画像里的「消费力」分项**同一套算法**。
 *
 * 为什么要抽到 `shared/`：同一个数现在有两处要用——
 * - 用户画像（`main/analysis/portrait.ts` 的 `spending` 维度，跨全部直播间口径）；
 * - 实时列表里每一行的行内小字（本房间累计口径，见 `renderer/components/DanmakuFeed.tsx`）。
 *
 * 两处口径**刻意保持一致**（同样的权重与同样的参考量级），否则同一个人在画像里写 87、
 * 在弹幕行里写 40，用户没法解释。范围不同（跨房 vs 本房间）是唯一差别，界面上的文案要区分开。
 *
 * 算法（与画像一致）：
 * - `logNorm(v, max) = log10(1+v) / log10(1+max)`，夹到 0-1 —— 长尾计数的标准压缩
 *   （线性会把普通人全压到 0 附近，头部又拉满）；
 * - 消费力 = **0.75 × 累计抖币** + **0.25 × 单次均值**：金额为主、顺手区分「一次一大笔」与「细水长流」；
 * - 参考量级：累计 100000 抖币、单次 2000 抖币算满分（与画像里的常数一致）。
 */

/** 把任意数值夹到 0-1 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/** 对数归一化：`log10(1+v) / log10(1+max)`——长尾计数的标准压缩方式 */
export function logNorm(value: number, max: number): number {
  const v = Math.max(0, value)
  const m = Math.max(1, max)
  return clamp01(Math.log10(1 + v) / Math.log10(1 + m))
}

/** 消费评分用的两个参考量级（与 `main/analysis/portrait.ts` 的 `spend` / `avgGift` 一致） */
export const SPEND_FULL_COINS = 100000
export const GIFT_AVG_FULL_COINS = 2000

/**
 * 消费评分（0-100，四舍五入到整数）。
 *
 * @param diamonds 累计送出的抖币（0 = 没送过，或官方没给价）
 * @param giftCount 送礼次数（用来算单次均值；0 时均值按 0 计）
 */
export function spendScore(diamonds: number, giftCount: number): number {
  const coins = Math.max(0, Number.isFinite(diamonds) ? diamonds : 0)
  const count = Math.max(0, Number.isFinite(giftCount) ? giftCount : 0)
  const average = count > 0 ? coins / count : 0
  const score = 100 * (0.75 * logNorm(coins, SPEND_FULL_COINS) + 0.25 * logNorm(average, GIFT_AVG_FULL_COINS))
  return Math.round(clamp01(score / 100) * 100)
}
