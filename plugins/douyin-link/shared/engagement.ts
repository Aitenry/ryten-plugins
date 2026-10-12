import { clamp01, logNorm } from './score'

/**
 * 实时列表行首那两个**按身份算**的指标（纯函数：无 DB / 无 electron）。
 *
 * 用户 2026-10-14：「用户的消费欲望要随时间和进场次数，以及说话频率来构建，不能什么时候都一样；
 * 绩效指标要通过直播间的内容来构建」——所以这里不是「拿一个累计数直接显示」，而是两条**随时间会动**的
 * 确定性公式。两个函数都只吃数字、只吐 0-100 的整数，方便工装逐条断言与将来调参。
 */

/* ------------------------------------------------------------------------- 消费欲望（观众） */

/**
 * 新鲜度的**半衰期**（小时）：距最近出现越久，欲望打折越狠，6 小时掉一半。
 *
 * 为什么以「小时」计而不是「天」：直播间是**实时**场景——两小时前刚来过和三天前来过，
 * 「此刻想不想花钱」完全是两回事。用户要的就是这个「不同时候不一样」。
 */
const DESIRE_HALF_LIFE_H = 6
/** 到访次数的参考量级（跨房间合计到 20 次算满分） */
const DESIRE_ENTER_FULL = 20
/** 说话条数的参考量级（本房间累计到 100 条算满分） */
const DESIRE_CHAT_FULL = 100
/** 每次到访平均说几句算「话密」（3 句以上拉满） */
const DESIRE_TALK_PER_VISIT_FULL = 3
/** 「每次来花多少」的参考量级（本房间：单次到访平均花到 2000 抖币算满分） */
const DESIRE_PER_VISIT_FULL = 2000

export interface ConsumeDesireInput {
  /** 既往消费倾向 0-100（本房间消费评分，见 `shared/score.ts`） */
  spendScore: number
  /** 本房间累计送出抖币（与 `roomVisits` 一起算「每次来花多少」） */
  diamonds: number
  /** 本房间进场次数（算「每次来花多少」用；与 `diamonds` 同口径） */
  roomVisits: number
  /** 跨全部直播间的进场次数合计（到访频次） */
  enterTotal: number
  /** 本房间累计发言条数 */
  chatTotal: number
  /** 距最近一次出现的小时数（负数/NaN 由本函数兜底为 0） */
  hoursSinceLastSeen: number
  /** 此刻还在场 / 今天已经花过钱（真 = 新鲜度不打折） */
  activeNow: boolean
}

/**
 * **消费欲望 0-100** = 意愿 × 时机。
 *
 * 关键取舍（用户 2026-10-14）：「**有一些人是不经常来，也不经常来说话，但是一来就消费很多**」——
 * 所以**消费才是主项，到访与说话只是辅助**，绝不能因为「来得少、不说话」就把一个大金主算成低欲望。
 *
 * - **消费强度 80%**（这才是「欲望」本身）：
 *   - 既往消费倾向 `spendScore`（累计金额 75% + 单次均值 25%，已经花过钱 = 最硬的证据）50%；
 *   - **每次到访花多少** `diamonds / roomVisits`（直接命中「一来就消费很多」这类人）30%；
 * - **参与度 20%**（只用来在同一档消费里再分个高下，**不能反过来压过消费**）：
 *   - 到访频次 `enterTotal`（常来 = 有消费习惯）10%；
 *   - 说话频次 `chatTotal` 6% + **说话密度**（每次到访平均说几句）4%。
 * - **时机**：今天还在场 / 今天花过钱 → 1（不打折）；否则按 `2^(-Δt/6h)` 衰减，
 *   下限 0.5（老观众再久没来，也不至于被算成毫无欲望——他的习惯还在）。
 *
 * 于是「同一个人」在不同时候会得到不同的分数（刚来过/正在说话 → 高，隔了几天 → 低）；
 * 而「很少来但每次来都大额消费」的人，靠「既往消费倾向 + 每次到访消费额」这两项就能**压过**
 * 一个「天天来聊天但从不花钱」的人——这正是用户要的排序。
 */
export function consumeDesire(input: ConsumeDesireInput): number {
  const spendPropensity = clamp01((Number(input.spendScore) || 0) / 100)
  const visits = Math.max(0, input.roomVisits)
  const perVisitSpend = logNorm(Math.max(0, input.diamonds) / Math.max(1, visits), DESIRE_PER_VISIT_FULL)
  const visitFreq = logNorm(Math.max(0, input.enterTotal), DESIRE_ENTER_FULL)
  const talkFreq = logNorm(Math.max(0, input.chatTotal), DESIRE_CHAT_FULL)
  const totalVisits = Math.max(0, input.enterTotal)
  const talkDensity = clamp01(
    Math.max(0, input.chatTotal) / Math.max(DESIRE_TALK_PER_VISIT_FULL, totalVisits) / DESIRE_TALK_PER_VISIT_FULL
  )

  const intent = clamp01(
    0.5 * spendPropensity + 0.3 * perVisitSpend + 0.1 * visitFreq + 0.06 * talkFreq + 0.04 * talkDensity
  )

  const hours = Number.isFinite(input.hoursSinceLastSeen) ? Math.max(0, input.hoursSinceLastSeen) : 0
  const freshness = input.activeNow ? 1 : Math.max(0.5, Math.pow(0.5, hours / DESIRE_HALF_LIFE_H))

  return Math.round(clamp01(intent * freshness) * 100)
}

/* ------------------------------------------------------------------------- 绩效指标（主播） */

/** 今日收入到 20000 抖币算满分 */
const PERF_INCOME_FULL = 20000
/** 本场弹幕到 500 条算满分 */
const PERF_CHAT_FULL = 500
/** 本场独立观众到 200 人算满分 */
const PERF_AUDIENCE_FULL = 200
/** 本场进场到 100 次算满分 */
const PERF_ENTER_FULL = 100
/** 主播本场发言到 100 条算满分 */
const PERF_OUTPUT_FULL = 100

export interface HostPerformanceInput {
  /** 今日（本地自然日）跨房间**收到**的抖币 */
  todayReceived: number
  /** 本场房间弹幕条数（监控会话累计） */
  sessionChat: number
  /** 本场独立观众数（本场出现过的人） */
  audience: number
  /** 本场进场次数 */
  sessionEnter: number
  /** 主播本场自己的发言条数（内容输出的持续性） */
  hostOutput: number
}

/**
 * **绩效指标 0-100**：由**这场直播的内容**构成，四项加权。
 *
 * - **变现 35%**：今日收到的抖币（直播的直接结果）；
 * - **内容热度 30%**：本场弹幕量 60% + 独立观众数 40%
 *   （「有没有人说话、有多少不同的人愿意待着」比单纯人数更能反映内容吸引力）；
 * - **留人 20%**：本场进场次数（内容能持续把人拉进来）；
 * - **输出 15%**：主播自己的发言条数（内容是不是他在持续产出，而不是干坐着）。
 *
 * 没在监控这个房间时，后三项拿不到（都是 0），于是分数主要由今日收入撑起来——
 * 这不是 bug：没有观察到的内容，就不该被凭空评估。
 */
export function hostPerformance(input: HostPerformanceInput): number {
  const income = logNorm(Math.max(0, input.todayReceived), PERF_INCOME_FULL)
  const heat = clamp01(
    0.6 * logNorm(Math.max(0, input.sessionChat), PERF_CHAT_FULL) +
      0.4 * logNorm(Math.max(0, input.audience), PERF_AUDIENCE_FULL)
  )
  const retention = logNorm(Math.max(0, input.sessionEnter), PERF_ENTER_FULL)
  const output = logNorm(Math.max(0, input.hostOutput), PERF_OUTPUT_FULL)

  return Math.round(clamp01(0.35 * income + 0.3 * heat + 0.2 * retention + 0.15 * output) * 100)
}

/**
 * 身份判定用的阈值：收到过这么多条礼物、且**收的比送的多**才算主播（观众也会被回礼）。
 * 与 `main/portrait.ts` 的 `HOST_GIFT_HITS` 同一口径。
 */
export const HOST_GIFT_HITS = 2
