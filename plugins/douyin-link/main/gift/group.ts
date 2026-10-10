import type { DanmakuItem } from '../../shared/types'

/**
 * 连送（combo）去重：把服务端推的**累积数量**换算成**本次增量**。
 *
 * 背景（2026-10 用户反馈「连送重复计数」）：抖音对**同一次连送**会反复推同一个礼物组，
 * 数量字段给的是**累积量**，实测序列像 `1 → 2 → 5 → 5`（乱序回退也出现过）。若逐帧落库，
 * 统计会把 `1+2+5+5` 全加起来 = 13，而实际只送了 5 个。
 *
 * 这里沿用参考项目 `LiukerSun/DouyinDanmu` 的身份模型（`backend/pipeline/event_parser.inc`）：
 * 同一组的身份 = **`group_id` + 送礼人 + 收礼人 + 礼物 id**；对每一组维护**历史最大累积量**，
 * 只把 `本次累积量 − 历史最大` 的**正增量**写进 `count` / `diamonds`；增量为 0 或为负的帧
 * （纯重复/乱序回退）**直接丢弃**，不落库。
 *
 * 这样：`1→2→5→5` 记为 `1、1、3`（丢弃最后那条 0），总数 5，与房间实际一致。
 *
 * 纯函数 + 外部传入的状态（`GiftGroupState`），不碰 electron / 网络，方便 `spike` 断言。
 * 状态由实时通道按房间持有（`main/douyin/push-capture.ts`）。
 */

/** 每组「历史最大累积量」：key = `送礼人|收礼人|礼物id|groupId` → 累积量 */
export type GiftGroupState = Map<string, number>

/** 组状态上限（长期运行别无限涨；超出按插入顺序淘汰最旧的一组） */
const MAX_GROUPS = 2000

/**
 * 一条礼物项的**分组身份**。
 *
 * 只有「真礼物」（有 `giftId` 且 `groupId` 非 0）才参与连送去重；点歌那类（`orderKey`、
 * 无 `groupId`）与单发礼物（`group_id=0`）返回空串 → 原样保留、不做增量换算。
 */
export function giftGroupKey(item: DanmakuItem): string {
  if (item.kind !== 'gift') return ''
  if (!item.userId) return ''
  if (!item.giftId) return ''
  if (!item.groupId || item.groupId === '0') return ''
  return `${item.userId}|${item.toUserId}|${item.giftId}|${item.groupId}`
}

/**
 * 把一批消息里的真礼物按组换算成增量（就地替换 `count` / `diamonds`），丢弃零增量帧。
 *
 * `state` 是**该房间的跨帧状态**（调用方持有）；非礼物项原样返回。
 */
export function applyGiftIncrements(items: DanmakuItem[], state: GiftGroupState): DanmakuItem[] {
  if (items.length === 0) return items
  let out: DanmakuItem[] | null = null
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const key = giftGroupKey(item)
    if (!key) continue

    const previous = state.get(key) ?? 0
    const cumulative = Math.max(0, Math.round(item.count))
    const increment = cumulative > previous ? cumulative - previous : 0

    // 累积量只增不减（乱序回退不覆盖高水位）
    if (cumulative > previous) {
      state.delete(key) // 重新插入 → 把它挪到 Map 末尾（近似 LRU，淘汰时先丢最旧的）
      state.set(key, cumulative)
      if (state.size > MAX_GROUPS) {
        const oldest = state.keys().next().value
        if (oldest !== undefined) state.delete(oldest)
      }
    }

    // 单价 = 解码器给的总额 / 累积量（解码器按「单价 × 累积量」填的 `diamonds`）
    const unit = cumulative > 0 ? item.diamonds / cumulative : 0
    const next: DanmakuItem = { ...item, count: increment, diamonds: Math.round(unit * increment) }

    if (increment <= 0) {
      // 这一帧没有新增（纯重复/回退）：丢掉，否则会把同一次连送重复计数
      if (!out) out = items.slice(0, index)
      continue
    }
    if (out) out.push(next)
    else items[index] = next
  }
  return out ?? items
}