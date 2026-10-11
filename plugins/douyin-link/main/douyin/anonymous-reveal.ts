import logger from 'electron-log'
import { revealMysteryProfile, type RawUserProfile } from './mystery'
import { anonymousMaskTail, rawDouyinId } from '../../shared/anonymous'
import type { MysteryReveal, UserRankRow } from '../../shared/types'

/**
 * **匿名观众的「查看真实资料」（2026-10-12，用户要求：「我需要匿名用户，可以和神秘人一样获取其信息」）。**
 *
 * 结论先说：真机实测下来**匿名身份在抖音那边不可还原**。但用户要的是「和神秘人一样点一下」，
 * 所以这里把「点一下」这条路真的走通——按钮有、点了真查、查不到**如实说**，
 * 而不是像 0.15.22 那样干脆不给按钮、只留一句「数据里查不到这个人」。
 *
 * 三条实测死路（都在 `spike/anon-reveal-probe.mjs` 与 `spike/anon-search-probe.mjs` 里跑过，不是推理）：
 * 1. **直接拿占位 id `111111` 查资料**：`aweme/v1/web/user/profile/other/` 回
 *    `status_code 3170` + 一个字段全是 null 的空壳 user（连 `nickname` 都没有）→ 占用位 id 查不到；
 * 2. **马甲名尾段反查**：`dou2056511` 里的 `2056511` 确实是**真实 id 的尾段**
 *    （真库里没有任何真 id 以它结尾），但补全前面的位是 1e4~1e12 量级的枚举；
 *    按前缀小池子扫了几百次之后抖音开始回 **200 空 body**（风控）——既不可靠，也不该由插件来跑；
 * 3. **按昵称搜**：`aweme/v1/web/discover/search/` 搜 `dou2056511` 返回的 10 条里**一条都不是它**
 *    （抖音的搜索不收录马甲名；搜 `111111` 出来的只是十几个真叫这个名字的人）。
 *
 * 剩下唯一**不猜数字**的一步是本地核对：把马甲名尾段拿去比我们库里**已经有的**真实 id
 * （`mapper.getAnonymousCandidates` 按「id 以尾段结尾」或「昵称就是马甲名」收窄），
 * 并且必须**尾段 + 昵称尾段 + 粉丝 + 关注四条全中**才算命中——不中就不给结论。
 */

/** 本地候选：需要的东西全在 `UserRankRow` 里（`toRankRow` 已经带上粉丝/关注） */
export interface AnonymousCandidate {
  userId: string
  nickname: string
  follower: number
  following: number
}

/**
 * 候选判定：**四条全中才算同一个人**（尾段只是索引，不是证据）。
 *
 * - id 尾段：马甲名里的数字 = 真实 id 的尾段（实测）；
 * - 昵称尾段：候选自己的昵称也得是同一个马甲名（防止「别的匿名的人」被算进来）；
 * - 粉丝 / 关注：匿名档案行里已经记着这两个数，必须一致。
 */
export function matchAnonymousCandidate(
  candidate: AnonymousCandidate,
  target: { mask: string; follower: number; following: number }
): boolean {
  const tail = anonymousMaskTail(target.mask)
  if (!tail) return false
  if (!rawDouyinId(candidate.userId).endsWith(tail)) return false
  if (anonymousMaskTail(candidate.nickname) !== tail) return false
  return candidate.follower === target.follower && candidate.following === target.following
}

/**
 * 匿名档案的「查看真实资料」：先按本地线索找候选人，命中再拿真 id 去查抖音资料。
 *
 * `lookup` 由调用方注入（`hub` 里能查库；这里保持纯逻辑，工装可以直接喂候选）。
 * `onRaw` 与神秘人那条链一致：拿到原始字段就先回填，头像下载失败也不影响。
 */
export async function revealAnonymousProfile(
  input: { webRid: string; userId: string; mask: string; follower: number; following: number },
  lookup: () => Promise<UserRankRow[]>,
  onRaw?: (profile: RawUserProfile) => Promise<void> | void
): Promise<MysteryReveal> {
  const tail = anonymousMaskTail(input.mask)
  /**
   * 占位 id 直查是**已知死路**（`status_code 3170`），连马甲名都没有的匿名帧更是无从下手：
   * 省掉这次请求，免得界面转一圈再报同一个失败（也少一次可能被风控盯上的调用）。
   */
  if (!tail) {
    logger.info(`[douyin-link] 匿名身份没有可用线索（id=${input.userId} 昵称=${input.mask || '(空)'}）`)
    return { ok: false, code: 'anonymousMasked' }
  }

  let candidates: UserRankRow[] = []
  try {
    candidates = await lookup()
  } catch (error) {
    logger.warn('[douyin-link] 匿名身份：本地核对失败（按查不到处理）:', describe(error))
  }
  const hit = candidates.find((candidate) => matchAnonymousCandidate(candidate, input))
  if (!hit) {
    logger.info(
      `[douyin-link] 匿名身份未还原：尾段 ${tail} 在库里没有「昵称尾段 + 粉丝 ${input.follower} + 关注 ${input.following}」全中的账号`
    )
    return { ok: false, code: 'anonymousMasked' }
  }

  const realId = rawDouyinId(hit.userId)
  const result = await revealMysteryProfile(realId, onRaw)
  if (result.ok) {
    logger.info(`[douyin-link] 匿名身份已还原：${input.userId} → ${realId}`)
    return result
  }
  /** 本地核上了、抖音却不认（例如账号已注销）：照实说查不到，不把「我们猜的那个人」当结论 */
  logger.info(`[douyin-link] 匿名身份：本地命中 ${realId}，但抖音资料查询失败（${result.code}）`)
  return { ok: false, code: 'anonymousMasked' }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)
}
