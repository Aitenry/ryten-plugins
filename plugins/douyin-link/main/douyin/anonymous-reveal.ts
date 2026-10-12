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
 * 命中条件**只看「id 尾段 + 候选自己的昵称尾段」两条**，而且要求**唯一命中**才算数——
 * 不中、或同时撞上好几个，都不给结论（用户 2026-10-14：粉丝 / 关注 / 等级这些会变的字段已不再参与判定）。
 *
 * ---------------------------------------------------------------------------
 * **2026-10-12 真机抓帧的结论：抖音的「匿名」分两类，不能一锅端。**
 *
 * 连了 15 个在播房间、抓 5,087 帧 / 11,820 个 `User` 段（`spike/anon-live-probe.mjs`）后看到：
 *
 * | 类 | 帧里的样子 | 能不能还原 |
 * |---|---|---|
 * | **A：id 被抹成占位** | `id=111111` + 昵称打码 `秋***`（或者更早的马甲 `dou2056511`） | **不能**（见下） |
 * | **B：id 还是真的** | `id=91906055010` + 昵称「匿名」/「神秘人二阶」 | **能**：拿这个 id 直查资料就出来了 |
 *
 * B 类的实证（`spike/anon-mystery-probe.mjs`，同一份 cookie、同一个接口）：
 * - `id=91906055010` 昵称「神秘人二阶」→ 查到真账号**随风而飘**（351 粉 / 173 关注 + 抖音号）；
 * - `id=97987526879` 昵称「匿名」→ 查到账号（昵称就叫「匿名」，16 粉）；
 * - `id=3350907373498030` 昵称「匿名」→ 查到账号（48 粉）。
 *
 * 也就是说：**B 类走的就是神秘人那条现成的链**（`hub.revealMystery` → `revealMysteryProfile`），
 * 本来就能用；而且 B 类的 id 是真的，`shared/anonymous.ts` 的 `isAnonymousId()` 不会把它当匿名
 * （只有 `111111` / `anon:` 前缀才算），所以「按马甲名尾段核对」那套**不会误伤** B 类——
 * 只有昵称**打码**（`秋***`）才会走归桶/还原不了那条路，而打码只出现在 A 类帧里。
 *
 * 换句话说：用户要的「匿名用户也能像神秘人一样拿到信息」**在 B 类上是成立的**，
 * 而 A 类（约占匿名帧的绝大多数）在抖音那边确实还原不了——证据如下。
 *
 * ---------------------------------------------------------------------------
 * A 类为什么还原不了：
 *
 * 匿名帧的 `id` 全是占位 `111111`，**但字段 73 带着一个 `MS4wLj…` 形状的串**（916/923 条都有），
 * 看着就是 `sec_uid`——一度以为「按 sec_uid 查资料」这条路成了。实测**是诱饵**：
 * 同一个接口、同一份登录态 cookie，
 * - 拿**真人自己的** sec_uid 查 → `status_code 0` + 完整资料（对照组，可复现）；
 * - 拿匿名帧字段 73 那个值查 → `status_code 2` + `"UserId不合法"`。
 *
 * 另外试过、也都不通的路（各自有探针，别重复踩）：
 * - 项目内嵌的离线 `X-Bogus` 签名（`main/douyin/sign.ts`）：那是**直播 ws 专用**的，
 *   给 web 资料接口签完照旧 `status_code 2`（`spike/anon-sign-probe.mjs`）；
 * - 换 Electron/Chromium 的网络栈发同一个请求：照样 `UserId不合法`（`spike/anon-netfetch-probe.mjs`）；
 * - `iesdouyin` 分享页、老 web 接口、老 App 接口、webcast 用户接口：全是空 body / 200 但没资料
 *   （`spike/anon-secuid-probe.mjs`）；
 * - 昵称搜索：18 个马甲名一个都搜不到；短 id 反查：`status_code 2`
 *   （`spike/anon-search-probe.mjs` / `anon-shortid-probe.mjs`）。
 *
 * 行业侧的旁证（[精易论坛那帖](https://bbs.ijingyi.com/forum.php?mod=viewthread&action=printable&tid=14803759)）：
 * 抖音「彻底不返回 uid」之后，市面上的做法要么已经失效（番茄系 App）、要么是灰产级的
 * `webcast_uid` 反查（发帖人自己说「风险很大，迟早被起诉」）。**不值得为这个功能去碰。**
 */

/** 本地候选：只需要「id + 昵称」（用户 2026-10-14：不再用会变的字段参与判定） */
export interface AnonymousCandidate {
  userId: string
  nickname: string
}

/**
 * 候选判定：**只看两件事，且都必须成立**（尾段只是索引，昵称尾段才是证据）。
 *
 * - **id 尾段**：马甲名里的数字 = 真实 id 的尾段（真机实测）；
 * - **昵称尾段**：候选自己的昵称也得是同一个马甲名（防止「别的匿名的人」被算进来）。
 *
 * ⚠️ **不再比对粉丝数 / 关注数 / 等级**（用户 2026-10-14：「移除等级，关注，和粉丝匹配，
 * 因为这些内容都是会变化的」）：那三个数逐日变，今天记下的快照拿去和库里对上，本来能中的也常常中不了
 * （对方涨了几个粉 → 判定失败）。去掉之后判定更稳，代价是**可能有多个候选**——
 * 所以调用方必须再过一道「唯一命中」的关（见 `revealAnonymousProfile`），绝不猜。
 */
export function matchAnonymousCandidate(candidate: AnonymousCandidate, target: { mask: string }): boolean {
  const tail = anonymousMaskTail(target.mask)
  if (!tail) return false
  if (!rawDouyinId(candidate.userId).endsWith(tail)) return false
  return anonymousMaskTail(candidate.nickname) === tail
}

/**
 * 匿名档案的「查看真实资料」：先按本地线索找候选人，命中再拿真 id 去查抖音资料。
 *
 * `lookup` 由调用方注入（`hub` 里能查库；这里保持纯逻辑，工装可以直接喂候选）。
 * `onRaw` 与神秘人那条链一致：拿到原始字段就先回填，头像下载失败也不影响。
 */
export async function revealAnonymousProfile(
  input: { webRid: string; userId: string; mask: string },
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
  /**
   * **唯一命中才给结论**：判定不再比粉丝/关注之后，同一尾段可能撞上好几个账号
   * ——这时宁可说「还原不了」，也不挑一个「最像的」交差（口径与「查不到就不编」一致）。
   * 同一个人的档案行是**按房间**存的（一个 id 多行），所以这里按 userId 去重再数。
   */
  const matched = [...new Set(candidates.filter((candidate) => matchAnonymousCandidate(candidate, input)).map((row) => rawDouyinId(row.userId)))]
  if (matched.length !== 1) {
    logger.info(
      `[douyin-link] 匿名身份未还原：尾段 ${tail} 在库里命中 ${matched.length} 个账号（要求唯一）` +
        `${matched.length > 1 ? `：${matched.join(' / ')}` : ''}`
    )
    return { ok: false, code: 'anonymousMasked' }
  }

  const realId = matched[0]
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
