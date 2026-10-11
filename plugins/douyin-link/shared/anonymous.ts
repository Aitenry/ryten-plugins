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
 *
 * ---------------------------------------------------------------------------
 * 2026-10-12：这里多了一件更要紧的事——**别把不同的匿名用户并成一个人**
 * （用户原话：「匿名用户，内容监控会重复，这么严重的 bug」「所有的内容都重复了，个人主页内容」）。
 *
 * 抖音给「隐藏身份」的人发的 `id` 是**所有人共用的占位串** `111111`（真机批量抓帧实测，
 * 见 `ANONYMOUS_ID`），于是按 id 聚合的一切都会把**互不相干的匿名观众堆成一个人**：
 * 档案弹窗里「互动统计」是几张人头的合计、库里的累计变成 13 条弹幕 / 53 次进场，
 * 「历史弹幕」里把几个马甲名说过的话排成一条时间线，看着就像同一个人把内容重复刷了一遍。
 * 真库证据（2026-10-12 查用户库副本，房间 `108011161837` 等 4 个房间）：
 * `user_id = '111111'` 的 76 行消息里出现了 `dou2056511` / `dou4546310` / `dou1330533` /
 * `dou3710451` 等**十几个不同的马甲名**，它们本来就不是同一个人。
 *
 * 所以规则改成：**匿名的人按「马甲」分开记账**（`anonymousUserId`），
 * 而「他是不是匿名」这一问仍然按**原始抖音 id**回答（`isAnonymousId`）。
 * 马甲名本身是抖音给的、稳定可复现，所以同一个人多次出现仍然会落回同一份档案；
 * 两个马甲名不同的匿名用户则从此互不相干——宁可分成两个人，也不能把两个人并成一个。
 */

/** 出现这些词（忽略空格与大小写）就当作匿名占位名 */
const ANON_NAME_HINTS = ['匿名', 'anonymous', '神秘人'] as const

/**
 * 抖音给「隐藏身份」用户发的**共用占位 id**（2026-10-09 批量抓帧实测，几十条无一例外）。
 *
 * 这种用户帧里 `id` / 抖音号 / `secUid` **全是它**（或为空）：真实账号标识被抖音抹掉了，
 * 拿它去查资料只会 `notFound`。它和「昵称占位」（`匿名`/`神秘人`）是两回事——
 * 但都指向同一个结论：**这条身份在数据里不可还原**。
 */
export const ANONYMOUS_ID = '111111'

/**
 * 合成身份的前缀（`anon:<马甲>`）。
 *
 * 为什么要有前缀：库里 `user_id` 这一列从此装的是**内部身份键**，绝大多数就是抖音 id，
 * 只有匿名的那一小撮是这个合成键。前缀让「这一行是匿名」在库里一眼可辨，也让
 * `rawDouyinId()` 能把真正的抖音 id 换回来（档案弹窗上仍然显示 `111111`）。
 */
export const ANON_ID_PREFIX = 'anon:'

/** 这个 id 是不是「匿名占位」（拿它查资料一定查不到，别浪费一次请求） */
export function isAnonymousId(id: string | null | undefined): boolean {
  const text = String(id ?? '').trim()
  return text === ANONYMOUS_ID || text.startsWith(ANON_ID_PREFIX)
}

/**
 * 一个名字是不是**信息量为零**的占位名（空串 / 「匿名」/「神秘人」/「anonymous」）。
 *
 * 与马甲名（`dou2056511` 这类）的区别：马甲名是抖音**给这个人**的名字，可以用来区分人；
 * 占位名是抖音**给这一类人**的名字，谁看了都是它。所以只有占位名要被丢掉、去别的字段找区分度。
 */
export function isAnonymousName(name: string | null | undefined): boolean {
  const text = String(name ?? '')
    .replace(/\s+/g, '')
    .toLowerCase()
  if (text === '') return true
  return ANON_NAME_HINTS.some((hint) => text.includes(hint.toLowerCase()))
}

/**
 * 换回**展示用的抖音 id**：合成身份（`anon:xxx#马甲`）只取前半段的占位 id，其它原样返回。
 *
 * 界面上的「用户 id」那一栏要的是抖音真正给的串（`111111`），不是我们的内部键。
 */
export function rawDouyinId(id: string | null | undefined): string {
  return baseId(id)
}

/** 一个用户身上能拿来「认人」的字段（`UserInfo` / `DanmakuItem` / 库里那行档案都满足它的子集） */
export interface AnonymousIdentitySource {
  nickname?: string | null
  displayId?: string | null
  secUid?: string | null
  honorLevel?: number | null
  fansClubLevel?: number | null
}

/** 马甲名的长度上限（长过它就走哈希，别把整段昵称塞进主键） */
const MASK_MAX = 24

/**
 * 认人用的「马甲」：优先昵称，其次抖音号，都没有就退回等级组合。
 *
 * 为什么等级组合要留在最后（它其实**不保证唯一**，同一场里两个人等级一模一样是常事）：
 * 总比所有匿名人共用一个 id 强——那必然把所有人并成一个人；这个只在「连名字都没有」的
 * 残缺帧上兜底，而且**不参与展示**（下面 `displayNickname` 把它挡掉了）。
 */
export function anonymousMask(source: AnonymousIdentitySource): string {
  const nickname = cleanMask(source.nickname)
  if (nickname && !isAnonymousName(nickname)) return MASK_MAX < nickname.length ? hashMasks(nickname) : nickname
  const displayId = String(source.displayId ?? '').trim()
  if (displayId && displayId !== ANONYMOUS_ID) return displayId
  const secUid = String(source.secUid ?? '').trim()
  if (secUid) return `sec_${hashMasks(secUid)}`
  const honor = Number(source.honorLevel ?? 0) || 0
  const fans = Number(source.fansClubLevel ?? 0) || 0
  if (honor > 0 || fans > 0) return `lv${honor}_fc${fans}`
  return ''
}

/**
 * 马甲名的规范化：去掉抖音给匿名名挂的**装饰尾巴**（`☞`、`-`、多余空格）再当身份用。
 *
 * 实测帧里同一个人的名字会写成 `☞    dou2056511  -` 这种带一堆空白与破折号的样子；
 * 不归一化的话，同一个人的两次出现会算出两把键、凭空裂成两个人（用户最烦的那种「重复」）。
 * 顺带把「`匿名`」这类占位名归一化成空串，交给 `anonymousMask` 去别的字段找区分度。
 */
function cleanMask(name: string | null | undefined): string {
  return String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
    .trim()
}

/**
 * 这个匿名用户的**内部身份键**；返回空串 = 连马甲都拿不到（照旧不合并，见下）。
 *
 * 拿不到马甲时**不退回共用占位 id**：那正是这次要修的 bug。返回空串，让调用方按
 * 「身份未知」处理（不建档案、不进统计），消息流水照记。
 */
export function anonymousUserId(id: string | null | undefined, source: AnonymousIdentitySource): string {
  if (!isAnonymousId(id)) return String(id ?? '').trim()
  const mask = anonymousMask(source)
  return mask ? `${ANON_ID_PREFIX}${baseId(id)}#${mask}` : ''
}

/**
 * 这一帧该显示的昵称。
 *
 * 占位名（「匿名」/空串）不再硬塞给界面——它没有信息量，还会让十几个人看着像同一个；
 * 真正的马甲名（`dou2056511`）照显，因为那就是抖音给这个人挂的牌子。
 */
export function displayNickname(name: string | null | undefined): string {
  const text = String(name ?? '').trim()
  return !text || isAnonymousName(text) ? '' : text
}

/** 落库时的抖音号：占位名不写进 `display_id`（界面上「抖音号 111111」没有意义） */
export function displayDisplayId(displayId: string | null | undefined): string {
  const text = String(displayId ?? '').trim()
  return text === ANONYMOUS_ID || isAnonymousName(text) ? '' : text
}

/**
 * 合成键里那前半段（占位抖音 id），也让「已经是合成键的 id 再算一次」拿到同一把键。
 *
 * `anon:111111#dou2056511` → `111111`；普通 id 原样返回。
 */
function baseId(id: string | null | undefined): string {
  const text = String(id ?? '').trim()
  return text.startsWith(ANON_ID_PREFIX) ? (text.slice(ANON_ID_PREFIX.length).split('#')[0] ?? '') : text
}

/** 长马甲的短哈希（FNV-1a 32 位，十六进制）——只用于「区分人」，不用于展示 */
function hashMasks(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
