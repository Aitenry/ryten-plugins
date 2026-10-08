/**
 * 「这个人是不是匿名的」——**一处定义，主进程与数据库共用**。
 *
 * 背景（用户 2026-10-08 的要求：「可以脱神秘人的衣服，可以知道这个人是谁」）：
 * 抖音在**匿名送礼 / 匿名点歌**时给的名字是一个占位串，实测见过两种（2026-10-08 抓帧）：
 * - 空串（最常见的其实是这个：礼物帧里干脆没有发送者的 `User`，只剩单号串里的 id）；
 * - `☞              匿名  -`（中间一大串空格，昵称就是「匿名」两个字）。
 *
 * 好消息是**用户 id 一直都在**（点歌单号串第一段 / 礼物帧的 `user.id`），而这个人只要在房间里
 * 说过话、进过场、上过房榜，我们的库里就记着他的真名——同一 id 一对就能把马甲脱掉
 * （实测：`1671723870326936` 那条匿名「跑车」礼物，13 分钟后同一个人用「河里的大白鲨」发言）。
 */

/** 出现这些词（忽略空格与大小写）就当作匿名占位名 */
export const ANON_NAME_HINTS = ['匿名', 'anonymous', '神秘人'] as const

/** 去掉所有空白再比：`☞              匿名  -` 这类带一堆空格的名要能认出来 */
export function isAnonymousName(name: string | null | undefined): boolean {
  const text = String(name ?? '')
    .replace(/\s+/g, '')
    .toLowerCase()
  if (text === '') return true
  return ANON_NAME_HINTS.some((hint) => text.includes(hint.toLowerCase()))
}

/**
 * SQL 侧的同一口径：给出「这一列是空或匿名」的谓词（列名由调用方拼，只接受我们自己写的字面量）。
 *
 * `ILIKE` 是大小写不敏感的（`anonymous` / `Anonymous` 都算），中文那几个词不受影响。
 */
export function anonymousSqlPredicate(column: string): string {
  const likes = ANON_NAME_HINTS.map((hint) => `${column} ILIKE '%${hint}%'`).join(' OR ')
  return `(${column} = '' OR ${likes})`
}
