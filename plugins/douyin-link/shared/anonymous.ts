/**
 * 「这个人是不是匿名的」——**一处定义，主进程与数据库共用**。
 *
 * 背景（用户 2026-10-08 的要求：「可以脱神秘人的衣服，可以知道这个人是谁」）：
 * 抖音在**匿名送礼 / 匿名点歌**时给的名字是一个占位串，实测见过两种（2026-10-08 抓帧）：
 * - 空串（最常见的其实是这个：礼物帧里干脆没有发送者的 `User`，只剩单号串里的 id）；
 * - `☞              匿名  -`（中间一大串空格，昵称就是「匿名」两个字）。
 *
 * 好消息是**用户 id 一直都在**（点歌单号串第一段 / 礼物帧的 `user.id`）。
 * 「还原真名」现在**不再靠我们自己数据里的同名 id 反推**（那只能还原先在本房间露过面的人），
 * 而是拿 id 直接去抖音查资料——见 `main/douyin/mystery.ts` 与用户档案弹窗里的「查看神秘人信息」。
 */

/** 出现这些词（忽略空格与大小写）就当作匿名占位名 */
const ANON_NAME_HINTS = ['匿名', 'anonymous', '神秘人'] as const

/** 去掉所有空白再比：`☞              匿名  -` 这类带一堆空格的名要能认出来 */
export function isAnonymousName(name: string | null | undefined): boolean {
  const text = String(name ?? '')
    .replace(/\s+/g, '')
    .toLowerCase()
  if (text === '') return true
  return ANON_NAME_HINTS.some((hint) => text.includes(hint.toLowerCase()))
}
