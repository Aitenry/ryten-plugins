import type {
  UserAnalysis,
  UserAnalysisChat,
  UserAnalysisFacts,
  UserAnalysisGifting,
  UserAnalysisInsight,
  UserAnalysisNetwork,
  UserAnalysisPeer,
  UserAnalysisScore
} from '../../shared/types'
import { analyzeChat, type ChatTextSignals } from './text'

/**
 * 用户画像的**纯算法**模块（无 DB / 无 electron 依赖，方便单测与复用）。
 *
 * 需求是「不依赖大模型、不需要人工处理」：所以这里全是**确定性规则**——
 * 同一份数据、同一天，永远得到同一份结论。方法论分四层：
 *
 * 1. **RFM 价值分层**（Recency / Frequency / Monetary）：客户关系管理里最经典的分层模型，
 *    直播场景对应「最近出现 / 出现频次 / 送礼金额」，用来做价值判断与关系阶段；
 * 2. **Bartle 玩家类型学**：把游戏里的社交者 / 成就者等类型重映射为直播场景的
 *    消费型 / 社交型 / 忠诚粉 / 氛围型 / 旁观型，用来给「主画像」定名；
 * 3. **大五人格（Big Five / OCEAN）**：由行为与弹幕做**行为侧写**（behavioral proxy）——
 *    开放性 / 尽责性 / 外向性 / 宜人性 / 情绪稳定性。注意这是「数据里看到的行为倾向」，
 *    不是临床人格判定；
 * 4. **自我决定论（SDT）动机结构**：社交连接（关系需求）/ 身份认同（胜任与地位）/
 *    内容欣赏（自主与兴趣）/ 习惯陪伴（行为习惯化）——解释「他为什么留在这里」。
 * 弹幕文本分析（情绪效价与唤起度、语用主题、语言特征）由 `main/analysis/text.ts` 提供，
 * 既单独成块展示，也作为上面人格与动机的行为证据。
 *
 * 打分链路统一是：**原始计数 → 对数归一化到 0-1 → 加权求和 ×100**。
 * 用 log 而非线性，是因为互动量是长尾分布（头部大佬能比普通观众高 3 个数量级），
 * 线性会把所有人压到 0 附近，log 才能保留区分度。
 */

/** mapper 侧聚合出的一条**关系边**（未算占比；占比由 portrait 按方向总额统一算） */
export interface UserAnalysisEdge {
  /** 对方 userId */
  userId: string
  /** 对方昵称（可能为空） */
  name: string
  /** 抖币总额 */
  diamonds: number
  /** 礼物件数 */
  items: number
  /** 礼物条数 */
  hits: number
  /** 最近一次（ms） */
  lastAt: number
}

/** 打分所需的**输入契约**（由 mapper 聚合产出；定义在此，mapper 反向 import，避免循环依赖） */
export interface UserAnalysisData {
  /** 弹幕条数 */
  chat: number
  /** 进场次数 */
  enter: number
  /** 点赞次数（= like 消息条数） */
  likes: number
  /** 关注次数 */
  follows: number
  /** 送礼次数 */
  gift: number
  /** 累计抖币 */
  diamonds: number
  /** 首次出现（ms） */
  firstSeen: number
  /** 最近出现（ms） */
  lastSeen: number
  /** 24 小时活跃分布（下标 [0..23]，本地时区） */
  hours: number[]
  /** 出现过的天数（本地时区分天，去重） */
  activeDays: number
  /** 送过的礼物种类数 */
  giftKinds: number
  /** 送得最多的礼物名 */
  topGiftName: string
  /** 该礼物的件数 */
  topGiftCount: number
  /** 该礼物的抖币 */
  topGiftDiamonds: number
  /** 送礼对象去重个数 */
  recipients: number
  /** 荣誉等级 */
  honorLevel: number
  /** 粉丝团等级 */
  fansClubLevel: number
  /** 弹幕文本样本（用于弹幕分析与情绪；不落 DTO） */
  chatTexts: string[]
  /** 24 小时送礼分布（下标 [0..23]，本地时区，仅礼物条数） */
  giftHours: number[]
  /** 送过礼的天数（本地时区分天，去重） */
  giftDays: number
  /** 单笔最大抖币 */
  giftMax: number
  /** 首次送礼（ms） */
  giftFirstAt: number
  /** 最近一次送礼（ms） */
  giftLastAt: number
  /** 本人 → 对方的送礼边 */
  outEdges: UserAnalysisEdge[]
  /** 对方 → 本人的送礼边 */
  inEdges: UserAnalysisEdge[]
}

/** 互动太少就不出画像（样本不够时「画像」只是噪声） */
const MIN_INTERACTIONS = 5

/** 把任意数值夹到 0-1 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/** 对数归一化：`log10(1+v) / log10(1+max)`——长尾计数的标准压缩方式 */
function logNorm(value: number, max: number): number {
  const v = Math.max(0, value)
  const m = Math.max(1, max)
  return clamp01(Math.log10(1 + v) / Math.log10(1 + m))
}

/** 机器键 → PascalCase 后缀（`connection` → `Connection`），用于拼动态 i18n 键 */
function pascal(key: string): string {
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : ''
}

/** 取分数最高的一项的键（列表按固定顺序给出，不是排好序的；并列时取先出现的） */
function topKeyOf(list: UserAnalysisScore[]): string {
  let best = ''
  let bestScore = -1
  for (const item of list) {
    if (item.score > bestScore) {
      bestScore = item.score
      best = item.key
    }
  }
  return best
}

/* ------------------------------------------------------------------------------- 子信号 */

/** 归一化后的子信号集合（每个都是 0-1；打分与原型共用，保证口径一致） */
interface Signals {
  spend: number
  avgGift: number
  chat: number
  enter: number
  activity: number
  follows: number
  likes: number
  activeDays: number
  span: number
  honor: number
  fanClub: number
  recipients: number
  emotion: number
  emotionVol: number
  fresh: number
  chatShare: number
  likeShare: number
  giftShare: number
  enterShare: number
  /** 活跃时段集中度（最高峰小时占比，越高越「规律」） */
  regularity: number
  /** 情绪效价（-1..1） */
  valence: number
  /** 情绪唤起度（0-1） */
  arousal: number
  /** 话题广度（0-1） */
  topicDiversity: number
  /** 表情种类丰富度（0-1） */
  emojiVariety: number
  /** 平均字数归一（0-1） */
  length: number
  /** 赞美弹幕占比（0-1） */
  praise: number
  /** 打招呼弹幕占比（0-1） */
  greet: number
  /** 负性弹幕占比（0-1） */
  negRate: number
  /** 外放表达占比（疑问 + 感叹）（0-1） */
  expressive: number
  /** @提及 率（0-1）——直播里「点名回话」是最直接的社交信号 */
  mention: number
  /** 送礼频率（按送礼日归一，0-1） */
  giftSteady: number
  /** 单笔爆发度（最大单笔相对平均单笔的倍数，0-1） */
  giftBurst: number
  /** 送礼对象集中度（最青睐对象的抖币占比，0-1） */
  giftFocus: number
}

interface Derived {
  signals: Signals
  chat: ChatTextSignals
  monetary: number
  interactions: number
  avgGift: number
  spanDays: number
  recencyHours: number
  sentiment: number
  positive: number
  negative: number
  peakHour: number
  /** 送礼时段高峰（0-23；-1 = 无） */
  giftPeakHour: number
  /** 平均每个送礼日的送礼次数 */
  giftPerDay: number
  /** 送礼时间跨度（天） */
  giftSpanDays: number
  /** 最常送的礼物占总抖币比（0-1） */
  topGiftShare: number
}

function derive(data: UserAnalysisData, now: number): Derived {
  const monetary = Math.max(0, data.diamonds)
  const interactions = data.chat + data.enter + data.likes + data.follows + data.gift
  const avgGift = data.gift > 0 ? monetary / data.gift : 0

  const spanDays = Math.max(0, data.lastSeen - data.firstSeen) / 86400000
  const lastSeen = data.lastSeen > 0 ? data.lastSeen : now
  const recencyHours = Math.max(0, (now - lastSeen) / 3600000)

  const chat = analyzeChat(data.chatTexts)
  const sentiment = Math.round(chat.valence * 100)

  const hours = Array.isArray(data.hours) && data.hours.length === 24 ? data.hours : new Array(24).fill(0)
  let peakHour = -1
  let peakValue = 0
  let hourTotal = 0
  for (let i = 0; i < 24; i += 1) {
    const value = Number(hours[i]) || 0
    hourTotal += value
    if (value > peakValue) {
      peakValue = value
      peakHour = i
    }
  }
  const regularity = hourTotal > 0 ? clamp01(peakValue / hourTotal) : 0

  // 送礼时段高峰
  const giftHours = Array.isArray(data.giftHours) && data.giftHours.length === 24 ? data.giftHours : new Array(24).fill(0)
  let giftPeakHour = -1
  let giftPeakValue = 0
  for (let i = 0; i < 24; i += 1) {
    const value = Number(giftHours[i]) || 0
    if (value > giftPeakValue) {
      giftPeakValue = value
      giftPeakHour = i
    }
  }

  // 送礼节律与集中度
  const giftPerDay = data.giftDays > 0 ? data.gift / data.giftDays : data.gift
  const giftSpanDays = data.giftLastAt > data.giftFirstAt ? (data.giftLastAt - data.giftFirstAt) / 86400000 : 0
  const topGiftShare = monetary > 0 ? clamp01(data.topGiftDiamonds / monetary) : 0
  const edgeWeight = (edge: UserAnalysisEdge): number => (edge.diamonds > 0 ? edge.diamonds : edge.items)
  const outTotalWeight = data.outEdges.reduce((acc, edge) => acc + Math.max(0, edgeWeight(edge)), 0)
  const topEdge = data.outEdges.reduce<UserAnalysisEdge | null>(
    (best, edge) => (best === null || edgeWeight(edge) > edgeWeight(best) ? edge : best),
    null
  )
  const topRecipientShare = outTotalWeight > 0 && topEdge ? clamp01(edgeWeight(topEdge) / outTotalWeight) : 0

  const topicCount = (key: string): number => chat.topicCounts.find((item) => item.key === key)?.count ?? 0
  const sample = chat.sampleCount > 0 ? chat.sampleCount : 1

  const total = interactions > 0 ? interactions : 1
  const signals: Signals = {
    spend: logNorm(monetary, 100000),
    avgGift: logNorm(avgGift, 2000),
    chat: logNorm(data.chat, 300),
    enter: logNorm(data.enter, 100),
    activity: logNorm(interactions, 1000),
    follows: logNorm(data.follows, 20),
    likes: logNorm(data.likes, 500),
    activeDays: logNorm(data.activeDays, 30),
    span: logNorm(spanDays, 90),
    honor: logNorm(data.honorLevel, 40),
    fanClub: logNorm(data.fansClubLevel, 20),
    recipients: logNorm(data.recipients, 8),
    emotion: (chat.valence + 1) / 2,
    emotionVol: logNorm(chat.positive + chat.negative, 20),
    fresh: clamp01(1 - recencyHours / (24 * 14)),
    chatShare: clamp01(data.chat / total),
    likeShare: clamp01(data.likes / total),
    giftShare: clamp01(data.gift / total),
    enterShare: clamp01(data.enter / total),
    regularity,
    valence: chat.valence,
    arousal: chat.arousal,
    topicDiversity: chat.topicDiversity,
    emojiVariety: chat.emojiVariety,
    length: logNorm(chat.avgLength, 30),
    praise: clamp01(topicCount('praise') / sample),
    greet: clamp01(topicCount('greet') / sample),
    negRate: chat.negativeRate,
    expressive: clamp01(chat.questionRate + chat.exclaimRate),
    mention: chat.mentionRate,
    giftSteady: logNorm(giftPerDay, 20),
    giftBurst: avgGift > 0 ? clamp01((Math.max(0, data.giftMax) / avgGift - 1) / 4) : 0,
    giftFocus: topRecipientShare
  }

  return {
    signals,
    chat,
    monetary,
    interactions,
    avgGift,
    spanDays,
    recencyHours,
    sentiment,
    positive: chat.positive,
    negative: chat.negative,
    peakHour,
    giftPeakHour,
    giftPerDay,
    giftSpanDays,
    topGiftShare
  }
}

/* --------------------------------------------------------------------------- 六个维度 */

/** 六个固定顺序的行为维度（顺序即界面展示顺序） */
const TRAIT_KEYS = ['spending', 'activity', 'sociability', 'loyalty', 'emotion', 'identity'] as const

function buildTraits(s: Signals): UserAnalysisScore[] {
  const spending = 100 * (0.75 * s.spend + 0.25 * s.avgGift)
  const activity = 100 * (0.45 * s.activity + 0.3 * s.chat + 0.25 * s.enter)
  const sociability = 100 * (0.35 * clamp01(s.chatShare * 2) + 0.25 * s.follows + 0.2 * s.recipients + 0.2 * clamp01(s.mention * 1.5))
  const loyalty = 100 * (0.4 * s.activeDays + 0.3 * s.span + 0.3 * s.fresh)
  const emotion = 100 * (0.5 * s.emotion + 0.3 * s.emotionVol + 0.2 * s.arousal)
  const identity = 100 * (0.55 * s.honor + 0.45 * s.fanClub)
  const values = [spending, activity, sociability, loyalty, emotion, identity]
  return TRAIT_KEYS.map((key, i) => ({ key, score: Math.round(values[i]) }))
}

/* ------------------------------------------------------------------------------- 原型 */

/** 五个行为原型（Bartle 类型学适配直播场景），按分数降序返回 */
function buildArchetypes(s: Signals): UserAnalysisScore[] {
  const raw: Array<{ key: string; value: number }> = [
    // 消费型：重金 + 礼物占比高 + 单次金额高
    { key: 'whale', value: 0.6 * s.spend + 0.25 * clamp01(s.giftShare * 2) + 0.15 * s.avgGift },
    // 社交型：话痨 + 送礼对象多
    { key: 'socializer', value: 0.55 * clamp01(s.chatShare * 2) + 0.25 * s.chat + 0.2 * s.recipients },
    // 忠诚粉：常来 + 关注 + 粉丝团等级
    { key: 'loyalist', value: 0.45 * s.activeDays + 0.3 * s.follows + 0.25 * s.fanClub },
    // 氛围型：点赞多 + 不怎么花钱
    { key: 'supporter', value: 0.5 * clamp01(s.likeShare * 2) + 0.25 * s.likes + 0.25 * (1 - s.spend) },
    // 旁观型：只进场 + 互动少 + 但最近来过
    { key: 'lurker', value: 0.45 * clamp01(s.enterShare * 2) + 0.3 * (1 - s.activity) + 0.25 * s.fresh }
  ]
  return raw
    .map((item) => ({ key: item.key, score: Math.round(clamp01(item.value) * 100) }))
    .sort((a, b) => b.score - a.score)
}

/* ------------------------------------------------------------------------- 大五人格侧写 */

/** 大五人格固定顺序（顺序即界面展示顺序） */
const BIG5_KEYS = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'stability'] as const

/**
 * 大五人格的**行为侧写**（不是临床量表）。
 * 每个维度都从「数据里能看到的行为」出发，权重体现该行为对该维度的解释力：
 * - 开放性：话题广度 + 表情多样 + 表达长度 → 愿意尝试、表达丰富；
 * - 尽责性：活跃天数 + 跨度 + 时段规律 → 有节奏、能坚持；
 * - 外向性：弹幕量 + 社交对象 + 外放表达 + 点赞 → 主动输出、能量向外；
 * - 宜人性：情绪正面 + 赞美 + 打招呼 + 少负面 → 友善、合作；
 * - 情绪稳定性：负性表达与消极效价越低越稳；**没有情绪词时给中性 50 而不是满分**——
 *   「没观察到负面」不等于「情绪很稳」，缺证据就不能当成证据。
 */
function buildPersonality(s: Signals): UserAnalysisScore[] {
  const openness = 100 * (0.4 * s.topicDiversity + 0.3 * s.emojiVariety + 0.3 * s.length)
  const conscientiousness = 100 * (0.4 * s.activeDays + 0.3 * s.span + 0.3 * s.regularity)
  const extraversion = 100 * (0.35 * s.chat + 0.2 * s.recipients + 0.15 * s.expressive + 0.15 * s.likes + 0.15 * s.mention)
  const agreeableness = 100 * (0.4 * s.emotion + 0.3 * s.praise + 0.15 * s.greet + 0.15 * (1 - clamp01(s.negRate * 2)))
  const negSignal = clamp01(0.7 * s.negRate + 0.3 * Math.max(0, -s.valence))
  const stability = 100 * (1 - negSignal) * (0.5 + 0.5 * s.emotionVol)
  const values = [openness, conscientiousness, extraversion, agreeableness, stability]
  return BIG5_KEYS.map((key, i) => ({ key, score: Math.round(values[i]) }))
}

/* ------------------------------------------------------------------------- 动机结构（SDT） */

/** 动机结构固定顺序：社交连接 / 身份认同 / 内容欣赏 / 习惯陪伴 */
const MOTIVATION_KEYS = ['connection', 'identity', 'interest', 'companionship'] as const

/**
 * 由自我决定论（SDT）的基本心理需求派生四类动机：
 * - 社交连接（关系需求）：弹幕互动 + 对象多 + 外放 + 关注 → 通过弹幕建立连接；
 * - 身份认同（胜任与地位）：荣誉 + 粉丝团 + 消费 → 用等级与打赏确证位置；
 * - 内容欣赏（自主与兴趣）：点赞 + 赞美 + 正面情绪 + 话题广度 → 因为喜欢内容而来；
 * - 习惯陪伴（行为习惯化）：活跃天数 + 跨度 + 时段规律 → 把它当成日常的一部分。
 */
function buildMotivations(s: Signals): UserAnalysisScore[] {
  const connection = 100 * (0.3 * s.chat + 0.2 * s.recipients + 0.15 * s.expressive + 0.2 * s.mention + 0.15 * s.follows)
  const identity = 100 * (0.4 * s.honor + 0.25 * s.fanClub + 0.2 * s.spend + 0.15 * s.avgGift)
  const interest = 100 * (0.35 * s.likes + 0.25 * s.praise + 0.2 * s.emotion + 0.2 * s.topicDiversity)
  const companionship = 100 * (0.4 * s.activeDays + 0.3 * s.span + 0.3 * s.regularity)
  const values = [connection, identity, interest, companionship]
  return MOTIVATION_KEYS.map((key, i) => ({ key, score: Math.round(values[i]) }))
}

/* ------------------------------------------------------------------------------- 标签 */

function buildTags(data: UserAnalysisData, s: Signals, f: UserAnalysisFacts, c: ChatTextSignals): string[] {
  const tags: string[] = []
  if (f.monetary >= 10000) tags.push('bigSpender')
  else if (data.gift > 0) tags.push('giver')
  if (data.gift > 0 && s.giftFocus >= 0.6 && f.recipients <= 2) tags.push('devoted')
  if (f.recipients >= 4) tags.push('wideGiver')
  if (s.giftBurst >= 0.5 && f.monetary >= 2000) tags.push('burstGift')
  if (data.chat >= 30) tags.push('chatter')
  if (c.mentionRate >= 0.4) tags.push('mentioner')
  if (c.emojiRate >= 0.4) tags.push('emojiFan')
  if (c.questionRate >= 0.3) tags.push('inquisitive')
  if (data.likes >= 100) tags.push('liker')
  if (data.follows >= 3) tags.push('follower')
  if (s.activity < 0.2) tags.push('silent')
  if (f.activeDays >= 7) tags.push('regular')
  if (data.honorLevel >= 15) tags.push('highHonor')
  if (data.fansClubLevel >= 10) tags.push('fanClub')
  if (f.recencyHours <= 1) tags.push('onlineNow')
  if (f.peakHour >= 0 && (f.peakHour >= 22 || f.peakHour < 6)) tags.push('nightOwl')
  else if (f.peakHour >= 6 && f.peakHour < 12) tags.push('dayActive')
  else if (f.peakHour >= 12 && f.peakHour < 18) tags.push('eveningActive')
  if (f.sentiment >= 30) tags.push('positive')
  else if (f.sentiment <= -30) tags.push('negative')
  if (f.recipients >= 3) tags.push('multiTarget')
  return tags.slice(0, 6)
}

/* ------------------------------------------------------------------------------- 结论 */

function buildInsights(
  f: UserAnalysisFacts,
  c: ChatTextSignals,
  s: Signals,
  motivationTop: string,
  g: UserAnalysisGifting,
  net: UserAnalysisNetwork
): UserAnalysisInsight[] {
  const list: UserAnalysisInsight[] = []

  // 1 价值（RFM 的 Monetary）
  if (f.monetary <= 0) list.push({ key: 'spendNone', params: {} })
  else if (f.monetary < 5000) list.push({ key: 'spendMid', params: { coins: f.monetary, avg: f.avgGift } })
  else list.push({ key: 'spendHigh', params: { coins: f.monetary, avg: f.avgGift } })

  // 2 关系阶段（R + F）
  if (f.activeDays <= 1 && f.recencyHours <= 24) list.push({ key: 'relationNew', params: {} })
  else if (f.recencyHours > 24 * 30) list.push({ key: 'relationRisk', params: { days: Math.round(f.recencyHours / 24) } })
  else if (f.activeDays >= 10 || f.spanDays >= 30) list.push({ key: 'relationDeep', params: { days: f.activeDays, span: Math.round(f.spanDays) } })
  else list.push({ key: 'relationReturning', params: { days: f.activeDays } })

  // 3 送礼习惯与「青睐谁」
  if (f.monetary > 0 || g.giftDays > 0) {
    if (g.topRecipientName && (g.topRecipientShare >= 50 || g.recipients <= 2)) {
      list.push({ key: 'giftingFocus', params: { name: g.topRecipientName, share: g.topRecipientShare } })
    } else if (g.recipients >= 4) {
      list.push({ key: 'giftingSpread', params: { n: g.recipients } })
    }
    if (s.giftBurst >= 0.5) list.push({ key: 'giftingBurst', params: { max: g.maxGift, avg: f.avgGift } })
    else if (g.perDay >= 3) list.push({ key: 'giftingSteady', params: { n: g.perDay } })
    if (g.topGiftShare >= 70 && f.giftKinds <= 3 && f.topGiftName) {
      list.push({ key: 'giftingSingleKind', params: { name: f.topGiftName, share: g.topGiftShare } })
    } else if (f.giftKinds >= 8) {
      list.push({ key: 'giftingVariety', params: { kinds: f.giftKinds } })
    }
    if (g.peakHour >= 0) list.push({ key: 'giftingRhythm', params: { hour: g.peakHour } })
    if (net.inTotal > 0) list.push({ key: 'giftingInbound', params: { coins: net.inTotal } })
  }

  // 4 主导动机（SDT）
  if (motivationTop) list.push({ key: `motivation${pascal(motivationTop)}`, params: {} })

  // 5 活跃节律
  if (f.peakHour >= 0) {
    if (f.peakHour >= 22 || f.peakHour < 6) list.push({ key: 'rhythmNight', params: { hour: f.peakHour } })
    else if (f.peakHour < 12) list.push({ key: 'rhythmDay', params: { hour: f.peakHour } })
    else list.push({ key: 'rhythmEvening', params: { hour: f.peakHour } })
  }

  // 6 弹幕表达风格（样本足够才下结论）
  if (c.sampleCount >= 8) {
    if (c.mentionRate >= 0.4) list.push({ key: 'chatMention', params: { n: Math.round(c.mentionRate * 100) } })
    if (c.avgLength >= 6) list.push({ key: 'chatVerbose', params: { n: Math.round(c.avgLength) } })
    else if (c.avgLength <= 2) list.push({ key: 'chatShort', params: {} })
    if (c.emojiRate >= 0.4) list.push({ key: 'chatEmoji', params: { n: Math.round(c.emojiRate * 100) } })
    if (c.questionRate >= 0.3) list.push({ key: 'chatInquisitive', params: { n: Math.round(c.questionRate * 100) } })
    if (c.arousal >= 0.6) list.push({ key: 'chatHype', params: { n: Math.round(c.arousal * 100) } })
  }

  // 7 情绪
  if (f.sentiment >= 30) list.push({ key: 'moodPositive', params: { pos: f.positive } })
  else if (f.sentiment <= -30) list.push({ key: 'moodNegative', params: { neg: f.negative } })

  // 情绪唤起度（效价 × 唤起度 = 情绪状态）
  if (c.sampleCount >= 8 && c.arousal < 0.25 && s.valence >= 0) list.push({ key: 'calmPositive', params: {} })

  return list.slice(0, 8)
}

/* --------------------------------------------------------------------------- 送礼 / 关系网 */

/** 显示名：优先昵称，空则退回 id 尾号（`#493012`） */
function displayName(name: string, userId: string): string {
  const trimmed = (name || '').trim()
  if (trimmed) return trimmed
  return userId ? `#${userId.slice(-6)}` : ''
}

/**
 * 人物关系网：把两个方向的送礼边各算成一份「占比 + 总额」的名单。
 * 边权优先用抖币（官方没给价时是 0），全为 0 时退回礼物件数——否则「没标价的礼物」
 * 会让所有占比都变成 0，图上就什么都画不出来。
 */
function buildNetwork(data: UserAnalysisData): UserAnalysisNetwork {
  const weight = (edge: UserAnalysisEdge): number => (edge.diamonds > 0 ? edge.diamonds : edge.items)
  const build = (edges: UserAnalysisEdge[]): { peers: UserAnalysisPeer[]; total: number } => {
    const total = edges.reduce((acc, edge) => acc + Math.max(0, weight(edge)), 0)
    const peers = [...edges]
      .filter((edge) => edge.userId)
      .sort((a, b) => weight(b) - weight(a) || b.hits - a.hits)
      .slice(0, 8)
      .map((edge) => ({
        userId: edge.userId,
        name: displayName(edge.name, edge.userId),
        diamonds: Math.max(0, Math.round(edge.diamonds)),
        items: Math.max(0, Math.round(edge.items)),
        hits: Math.max(0, Math.round(edge.hits)),
        share: total > 0 ? Math.round((Math.max(0, weight(edge)) / total) * 100) : 0,
        lastAt: Math.max(0, Math.round(edge.lastAt))
      }))
    return { peers, total: Math.round(total) }
  }
  const out = build(data.outEdges)
  const inbound = build(data.inEdges)
  return { outgoing: out.peers, incoming: inbound.peers, outTotal: out.total, inTotal: inbound.total }
}

/** 送礼习惯 DTO（从派生量与关系网的首位对象拼装） */
function buildGifting(data: UserAnalysisData, d: Derived, network: UserAnalysisNetwork): UserAnalysisGifting {
  const hours =
    Array.isArray(data.giftHours) && data.giftHours.length === 24
      ? data.giftHours.map((value) => Math.max(0, Math.round(Number(value) || 0)))
      : new Array(24).fill(0)
  const top = network.outgoing[0]
  return {
    giftDays: Math.max(0, Math.round(data.giftDays)),
    perDay: Math.round(d.giftPerDay * 10) / 10,
    maxGift: Math.max(0, Math.round(data.giftMax)),
    topGiftShare: Math.round(d.topGiftShare * 100),
    peakHour: d.giftPeakHour,
    spanDays: Math.round(d.giftSpanDays * 10) / 10,
    hours,
    recipients: Math.max(0, Math.round(data.recipients)),
    topRecipientShare: top?.share ?? 0,
    topRecipientName: top?.name ?? ''
  }
}

/* ------------------------------------------------------------------------------- 弹幕 DTO */

function buildChat(c: ChatTextSignals): UserAnalysisChat {
  const total = c.topicCounts.reduce((acc, item) => acc + item.count, 0)
  const topics: UserAnalysisScore[] = c.topicCounts.slice(0, 6).map((item) => ({
    key: item.key,
    score: total > 0 ? Math.round((item.count / total) * 100) : 0
  }))
  return {
    sampleCount: c.sampleCount,
    avgLength: Math.round(c.avgLength * 10) / 10,
    emojiRate: Math.round(c.emojiRate * 100),
    mentionRate: Math.round(c.mentionRate * 100),
    questionRate: Math.round(c.questionRate * 100),
    exclaimRate: Math.round(c.exclaimRate * 100),
    repeatRate: Math.round(c.repeatRate * 100),
    valence: Math.round(c.valence * 100),
    arousal: Math.round(c.arousal * 100),
    topics,
    keywords: c.keywords
  }
}

/* ------------------------------------------------------------------------------- 主函数 */

/**
 * 由聚合数据生成用户画像（纯函数；`now` 显式传入，便于测试与「同一天同一结论」）。
 */
export function buildUserAnalysis(data: UserAnalysisData, now: number): UserAnalysis {
  const d = derive(data, now)
  const s = d.signals

  const facts: UserAnalysisFacts = {
    recencyHours: Math.round(d.recencyHours * 10) / 10,
    activeDays: Math.max(0, Math.round(data.activeDays)),
    spanDays: Math.round(d.spanDays * 10) / 10,
    monetary: Math.round(d.monetary),
    avgGift: Math.round(d.avgGift),
    peakHour: d.peakHour,
    sentiment: d.sentiment,
    positive: d.positive,
    negative: d.negative,
    topGiftName: data.topGiftName || '',
    topGiftCount: Math.max(0, Math.round(data.topGiftCount)),
    topGiftDiamonds: Math.max(0, Math.round(data.topGiftDiamonds)),
    giftKinds: Math.max(0, Math.round(data.giftKinds)),
    recipients: Math.max(0, Math.round(data.recipients))
  }

  const hasData = d.interactions >= MIN_INTERACTIONS || data.gift > 0
  const traits = buildTraits(s)
  const archetypes = buildArchetypes(s)
  const personality = buildPersonality(s)
  const motivations = buildMotivations(s)
  const chat = buildChat(d.chat)
  const network = buildNetwork(data)
  const gifting = buildGifting(data, d, network)

  const sumRaw = archetypes.reduce((acc, item) => acc + item.score, 0)
  const top = archetypes[0]
  let archetype = top.score > 0 ? top.key : 'balanced'
  let confidence = sumRaw > 0 ? Math.round((top.score / sumRaw) * 100) : 0
  // 没有明显主导（最高分太低）→ 归为「均衡型」，置信度改为「均衡程度」
  if (top.score < 25) {
    archetype = 'balanced'
    confidence = Math.round(100 - top.score)
  }

  const personalityTop = topKeyOf(personality)
  const motivationTop = topKeyOf(motivations)

  return {
    hasData,
    archetype,
    confidence,
    archetypes,
    traits,
    personality,
    personalityTop,
    motivations,
    motivationTop,
    chat,
    gifting,
    network,
    tags: hasData ? buildTags(data, s, facts, d.chat) : [],
    insights: hasData ? buildInsights(facts, d.chat, s, motivationTop, gifting, network) : [],
    facts
  }
}
