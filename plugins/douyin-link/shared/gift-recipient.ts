/**
 * 「这份礼物是送给谁的」——**帧里没写收礼人时**的推断口径（纯函数，双端共用）。
 *
 * 为什么必须有这一层（2026-10-11 用户报障「个播没有显示收礼物榜内容」，真库副本实测）：
 * 抖音**不保证** `WebcastGiftMessage` 里带 `toUser`（字段 8）。用户库里同一份数据是这样的
 * （`douyin_link_messages`，`kind='gift'`）：
 *
 * | 房间 | 礼物行 | 带收礼人 | 说明 |
 * | --- | --- | --- | --- |
 * | `108011161837`（语音房） | 750 | 750 | 每一帧都带收礼人 |
 * | `895805895016`（语音房） | 504 | 504 | 同上 |
 * | `41498419462`（报障的个播） | 4133 | 9 | **绝大多数帧不带**收礼人 |
 *
 * 收礼物榜按 `to_user_id` 分组（`mapper.giftRankByPerson`），空串的行会被 `<> ''` 滤掉——
 * 于是**礼物明明在库里、榜上一个人都没有**（用户截图里 KPI 有 4,072 件礼物 / 6,315 抖币，
 * 收礼物榜却写着「这段时间里还没有人收到礼物」）。这一层把「收礼人」在**落库之前**补齐：
 * 帧里有就用帧里的（唯一权威），帧里没有才按下表的顺序推断，推不出来就**保持空**（不编数据）。
 *
 * 推断顺序（前一条能定就用前一条）：
 * 1. **帧里的收礼人**：`WebcastGiftMessage.toUser` / 点歌帧里的歌手——永远优先；
 * 2. **麦上只有一个人**：那他/她必然是收礼人（不管是不是主播）；
 * 3. **个播（没有麦位表）** → **主播**：这是个播的物理事实（房间里只有主播一个能收礼的人），
 *    但要等 `GIFT_RECIPIENT_GRACE_MS` 的观察窗口——语音房的麦位表是**异步同步**过来的，
 *    刚连上时它和「个播」长得一模一样，急着认主播就会把麦上别人的礼物记到主播头上。
 *
 * ⚠️ 同一个房间里这两种帧**会混着来**（报障的那个房间 4133 条里就有 9 条带收礼人），
 * 所以这不是「房间类型开关」，而是**逐帧**判断：带的用带的，不带的才推断。
 */

/** 麦位观察窗口（ms）：这段窗口里一个麦位都没同步到，才敢把「没有收礼人」当成个播 */
export const GIFT_RECIPIENT_GRACE_MS = 60_000

/** 房间在这一刻的已知信息（recorder 维护；未知一律空串 / 空表） */
export interface GiftRoomContext {
  /** 主播 id（解析房间时拿到；未知 = 空串） */
  anchorId: string
  /** 主播昵称（同上） */
  anchorName: string
  /** 当前麦位（按麦位序；非语音房/还没同步 = 空表） */
  micUsers: string[]
  /** **第一次看到没有收礼人的礼物帧**的时刻（0 = 还没见过）——观察窗口从这一刻算起 */
  noRecipientSince: number
}

/** 帧里带着的收礼人（`WebcastGiftMessage.toUser` 解的；没有就是空串） */
export interface GiftFrameRecipient {
  id: string
  name: string
}

/** 推断结果：`toUserId` 为主键（空 = 不知道，收礼榜上就不该有这一行） */
export interface ResolvedGiftRecipient {
  toUserId: string
  toUserName: string
}

/**
 * 这一帧的收礼人。
 *
 * @param frame 帧里解出来的收礼人（`decodeProtoGift` 的产物）
 * @param room  房间此刻的已知信息（见 `GiftRoomContext`）
 * @param now   当前时刻（ms；测试注入虚拟时钟用）
 */
export function resolveGiftRecipient(
  frame: GiftFrameRecipient,
  room: GiftRoomContext,
  now: number
): ResolvedGiftRecipient {
  // 1. 帧里的收礼人是唯一权威：它说给谁就是给谁（哪怕跟主播不一样）
  if (frame.id) return { toUserId: frame.id, toUserName: frame.name }

  // 2. 麦上只有一个人 → 收礼人只可能是他（语音房里常见的「麦上单人收礼」）
  const mic = room.micUsers.filter((id) => Boolean(id))
  if (mic.length === 1) {
    const id = mic[0]
    return {
      toUserId: id,
      toUserName: id === room.anchorId ? room.anchorName : ''
    }
  }

  // 3. 个播兜底：**必须是「从没同步过麦位」且已经过了观察窗口**（见文件头）
  if (room.anchorId && room.noRecipientSince > 0 && now - room.noRecipientSince >= GIFT_RECIPIENT_GRACE_MS) {
    return { toUserId: room.anchorId, toUserName: room.anchorName }
  }

  // 4. 定不了就不认（收礼榜上宁可少一行，也不给人安一个错的收礼人）
  return { toUserId: '', toUserName: '' }
}
