/**
 * 点歌「一单一行」的合并规则。
 *
 * 背景（2026-10-08 按用户库里的真实数据修）：同一个点歌订单服务端会推**好几帧**——
 * 一条**没有礼物记录**的（只有单号串与歌手，正文只能写成「想听 X 演唱」、价格只能是 0），
 * 一条**带礼物记录**的（`6.5.1`，那一条才有礼物 id、礼物名与抖币价），两条相隔 16 秒~3.5 分钟，
 * 而且**先来哪条都出现过**。它们带着同一个单号串（`DanmakuItem.orderKey`），所以落库时合成一行。
 *
 * 为什么不能「后来的直接覆盖」：没记录的那一帧若覆盖掉已经查到的礼物名与价格，
 * 界面上就变成「（礼物名未知）· 价值未知」——正是用户反馈的那个现象。
 *
 * 这个文件**故意不碰数据库**（纯函数）：`spike/decoder-check.mjs` 会把它单独打包起来断言，
 * 真机数据上出过的两种先后顺序都在那里跑一遍。
 */

/** 合并只关心这几个字段（待写行 / 库里已有的行都取这个形状） */
export interface GiftMergeInput {
  /** 正文（礼物名；没记录的那帧是「想听 X 演唱」或空串） */
  content: string
  count: number
  /** 抖币总额（0 = 未知） */
  diamonds: number
  userId: string
  userName: string
  toUserId: string
  toUserName: string
  /**
   * 这一帧有没有带着礼物记录（`giftRecord`）——**只用于判断「谁能覆盖正文」**，不是表里的列。
   * 库里那行没有这个信息，按「有正文或有价」推断（见 `storedGiftMergeInput`）。
   */
  giftRecord: boolean
  atMs: number
}

/** 合并结果：与 `douyin_link_messages` 的列一一对应（**没有** `giftRecord`），可直接喂给 `.set()` */
export type GiftMergeResult = Omit<GiftMergeInput, 'giftRecord'>

/**
 * 库里已有的那一行 → 合并输入。
 *
 * `giftRecord` 的推断口径：**有正文或有价**就当成「带着礼物记录的那一帧写下的」。
 * 这样两种先后顺序都不会把信息抹掉——先到的没记录（正文空、价 0）会被后到的记录覆盖；
 * 先到的有记录（有名字/有价）则会挡住后到的那条「想听 X 演唱」。
 */
export function storedGiftMergeInput(row: GiftMergeResult): GiftMergeInput {
  return { ...row, giftRecord: row.content !== '' || row.diamonds > 0 }
}

/**
 * 同一单两帧的合并规则：
 * - 正文：**只让带礼物记录的那一帧**说了算（两边都没记录就保留先到的非空值）；
 * - 价格 / 数量：取两者较大（价格只可能来自记录帧；连击帧可能只带增量）；
 * - 收礼人 / 送礼人：谁有值用谁（收礼人只有记录帧才有）；
 * - 时间取**先到**的那一刻（这一单第一次出现的时间，不是补记录的时间）。
 */
export function mergeGiftRows(current: GiftMergeInput, next: GiftMergeInput): GiftMergeResult {
  const winner = next.giftRecord ? next : current.giftRecord ? current : undefined
  return {
    content: winner?.content || next.content || current.content,
    count: Math.max(current.count, next.count),
    diamonds: Math.max(current.diamonds, next.diamonds),
    userId: next.userId || current.userId,
    userName: next.userName || current.userName,
    toUserId: next.toUserId || current.toUserId,
    toUserName: next.toUserName || current.toUserName,
    atMs: Math.min(current.atMs || next.atMs, next.atMs || current.atMs)
  }
}
