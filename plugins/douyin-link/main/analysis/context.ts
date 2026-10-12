import { analyzeChat, type ChatTextSignals } from './text'

/**
 * **时段上下文材料**的构建机制（纯函数：无 DB / 无 electron / 无大模型）。
 *
 * 要解决的问题（用户 2026-10-13）：
 * 1. 原来的分析只喂「被分析者本人」发的弹幕——可大多数人根本不说话，
 *    个播主播本人更是一句话都不发，于是材料近乎为空，模型/算法只能瞎猜；
 * 2. 但也不能反过来把整个直播间的弹幕一股脑塞进输入——一场直播几千上万条，
 *    直接拼进去既爆 token、又淹没重点。
 *
 * 所以这里做的是一件**压缩**的事：把「观察窗内房间里的全部弹幕」先摊平、去重、按时间分桶，
 * 再从每个桶里挑出**最有信息量**的少数几条作为代表，配合**整体统计**（房间基线）一起交给上层。
 * 这样：
 * - **输入不设上限**：窗口内有多少条就以多少条参与统计（`totalMessages` / `baseline` 都是全量算的）；
 * - **输出有预算**：代表样本数按预算收敛（`sampleBudget`），数据越多分桶越细、但条数不失控；
 * - **重点不丢**：与本人发言时间接近的弹幕、字多信息量大的弹幕优先入选，重复刷屏只留一条。
 */

/** 一条房间弹幕（DB 取出来的原始形状） */
export interface ContextDanmakuRow {
  atMs: number
  webRid: string
  userId: string
  userName: string
  content: string
}

/** 一个观察窗：某直播间在哪一段时间里被观察（观众 = 他自己的会话窗口；主播 = 房间的直播场次） */
export interface ContextWindow {
  webRid: string
  /** 房间标题（拿不到就是空串） */
  title: string
  start: number
  end: number
}

/** 抽样后的一条代表性弹幕 */
export interface RoomContextSample {
  atMs: number
  webRid: string
  author: string
  content: string
  /** 是不是被分析者本人发的 */
  self: boolean
}

/** 房间上下文（喂给 AI 提示词 / 用来校准确定性算法） */
export interface RoomContext {
  windows: ContextWindow[]
  /** 观察窗内的房间弹幕总量（未抽样；「输入不设上限」的落点） */
  totalMessages: number
  /** 参与的独立说话人数 */
  totalSpeakers: number
  /** 房间里发言最多的人（前若干个；标注是不是本人） */
  speakers: Array<{ name: string; count: number; self: boolean }>
  /** 房间整体文本分析（对**全部**弹幕跑词典法）——「房间基线」，用来判断个体相对房间的偏移 */
  baseline: ChatTextSignals
  /** 抽样后的代表性弹幕（去重 + 分桶 + 择优） */
  samples: RoomContextSample[]
  /** 参与抽样的去重后条数（说明压缩比：`totalMessages` → `sampledFrom` → `samples.length`） */
  sampledFrom: number
}

export interface RoomContextInput {
  windows: ContextWindow[]
  rows: ContextDanmakuRow[]
  /** 被分析者的全部账号 id（标记 `self`，并在房间统计里把本人单独标出来） */
  selfIds: string[]
  /**
   * 代表样本的目标条数（机制会把大量输入**收敛**到这个量级，而不是截断原始输入）。
   * 数据量越大分桶越细，但总量始终不超过它——这是成本闸门，不是「只看最近 N 条」。
   */
  sampleBudget?: number
}

/** 每个时间桶的目标原始条数（桶数 = 去重条数 / 这个值，再夹到预算与下限之间） */
const BUCKET_TARGET = 6
/** 默认代表样本预算（条） */
const DEFAULT_SAMPLE_BUDGET = 160
/** 预算的硬边界：太小学不到东西，太大失去压缩意义 */
const MIN_BUDGET = 40
const MAX_BUDGET = 400
/** 「跟本人发言挨得近」的时间半径（ms）：这一小段里的弹幕才是真正的对话上下文 */
const SELF_NEAR_MS = 120_000
/** 发言排行取前几名 */
const SPEAKER_TOP = 12

/** 去重用的规范化：压掉空白与零宽字符（同一句刷屏归一条） */
function normalize(text: string): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 剥掉方括号表情 / @提及 / unicode emoji，只留「真正打了字」的部分 */
function bodyOf(text: string): string {
  return text
    .replace(/\[[^[\]]{1,10}\]/g, ' ')
    .replace(/@[^\s@]+/g, ' ')
    .replace(/[\u{1f000}-\u{1faff}\u{2600}-\u{27bf}\u{2b00}-\u{2bff}\u{fe00}-\u{fe0f}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 取房间标题（没有就退回房间号） */
function roomLabel(window: ContextWindow): string {
  const title = String(window.title ?? '').trim()
  return title || window.webRid
}

/**
 * 一条弹幕的**信息量**打分（越大越值得作为代表留下）。
 *
 * 不是「越热门越好」——刷屏的「6666」「哈哈哈哈」热度最高但信息量最低，所以：
 * - 正文（剥掉表情/提及后的真正文字）越长越值钱；
 * - 带疑问/感叹这类语用标记的加分（能看出他在干什么）；
 * - 与本人发言时间接近的**场景上下文**大幅加分（「他说话的时候房间里在聊什么」才是关键）。
 */
function informativeScore(row: ContextDanmakuRow, selfTimes: number[]): number {
  const body = bodyOf(row.content)
  let score = 0
  if (body.length >= 2) score += 1
  if (body.length >= 6) score += 2
  if (body.length >= 12) score += 2
  if (body.length >= 24) score += 1
  if (/[？?]/.test(row.content)) score += 0.8
  if (/[！!]/.test(row.content)) score += 0.4
  if (body.length === 0) score -= 1 // 纯表情兜底：只有没别的可选时才用
  if (selfTimes.length > 0) {
    let nearest = Infinity
    for (const time of selfTimes) {
      const gap = Math.abs(time - row.atMs)
      if (gap < nearest) nearest = gap
    }
    if (nearest <= SELF_NEAR_MS) score += 2
  }
  return score
}

/**
 * 把「观察窗内的房间弹幕」压成一份上下文材料。
 *
 * 过程（每一步都是确定性的，同一份数据必然同一份结果）：
 * 1. **全量统计**：总条数、独立说话人数、发言排行、房间基线（对全部弹幕跑 `analyzeChat`）；
 * 2. **去重**：按规范化后的正文去重（刷屏只留第一条），得到样本池；
 * 3. **分桶**：按时间把样本池切成若干桶（桶数随数据量自适应，夹在预算内）；
 * 4. **择优**：每桶按信息量取前若干条，合并后按时间排序，总量不超过预算。
 */
export function buildRoomContext(input: RoomContextInput): RoomContext {
  const windows = Array.isArray(input.windows) ? input.windows.filter((w) => w && w.end >= w.start) : []
  const rows = Array.isArray(input.rows) ? input.rows.filter((row) => row && normalize(row.content).length > 0) : []
  const selfSet = new Set((input.selfIds ?? []).map((id) => String(id ?? '')).filter((id) => id.length > 0))
  const budget = Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Math.round(input.sampleBudget ?? DEFAULT_SAMPLE_BUDGET)))

  const baseline = analyzeChat(rows.map((row) => row.content))

  // ---- 1. 全量统计（说话人排行）
  const bySpeaker = new Map<string, { name: string; count: number; self: boolean }>()
  for (const row of rows) {
    const id = String(row.userId ?? '')
    const self = selfSet.has(id)
    const key = id || row.userName || '—'
    const hit = bySpeaker.get(key)
    if (hit) {
      hit.count += 1
      if (!hit.name && row.userName) hit.name = row.userName
    } else {
      bySpeaker.set(key, { name: String(row.userName ?? ''), count: 1, self })
    }
  }
  const speakers = [...bySpeaker.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, SPEAKER_TOP)

  if (rows.length === 0) {
    return {
      windows,
      totalMessages: 0,
      totalSpeakers: 0,
      speakers: [],
      baseline,
      samples: [],
      sampledFrom: 0
    }
  }

  // ---- 2. 去重（刷屏只留一条；保留时间顺序）
  const sorted = [...rows].sort((a, b) => a.atMs - b.atMs)
  const seen = new Set<string>()
  const unique: ContextDanmakuRow[] = []
  for (const row of sorted) {
    const key = normalize(row.content)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(row)
  }

  // ---- 3. 分桶（桶数随数据量自适应，但不超预算）
  const bucketCount = Math.min(budget, Math.max(1, Math.ceil(unique.length / BUCKET_TARGET)))
  const first = unique[0].atMs
  const last = unique[unique.length - 1].atMs
  const span = Math.max(1, last - first)
  const buckets: ContextDanmakuRow[][] = Array.from({ length: bucketCount }, () => [])
  for (const row of unique) {
    const index = Math.min(bucketCount - 1, Math.floor(((row.atMs - first) / span) * bucketCount))
    buckets[index].push(row)
  }

  // ---- 4. 择优（每桶按信息量取前若干条）
  const selfTimes = unique.filter((row) => selfSet.has(String(row.userId ?? ''))).map((row) => row.atMs)
  const perBucket = Math.max(1, Math.floor(budget / bucketCount))
  const picked: ContextDanmakuRow[] = []
  for (const bucket of buckets) {
    if (bucket.length === 0) continue
    const ranked = [...bucket].sort(
      (a, b) => informativeScore(b, selfTimes) - informativeScore(a, selfTimes) || a.atMs - b.atMs
    )
    for (const row of ranked.slice(0, perBucket)) picked.push(row)
  }

  const samples: RoomContextSample[] = picked
    .sort((a, b) => a.atMs - b.atMs)
    .slice(0, budget)
    .map((row) => ({
      atMs: row.atMs,
      webRid: row.webRid,
      author: String(row.userName ?? '').trim() || (selfSet.has(String(row.userId ?? '')) ? '本人' : '—'),
      content: normalize(row.content),
      self: selfSet.has(String(row.userId ?? ''))
    }))

  return {
    windows,
    totalMessages: rows.length,
    totalSpeakers: bySpeaker.size,
    speakers,
    baseline,
    samples,
    sampledFrom: unique.length
  }
}

/** 房间基线的精简形状（喂给确定性算法做「相对房间」的校准；不进材料文本） */
export interface RoomBaseline {
  sampleCount: number
  avgLength: number
  emojiRate: number
  questionRate: number
  exclaimRate: number
  mentionRate: number
  arousal: number
  valence: number
}

/** 从上下文里抽一份房间基线（没有弹幕就是 null） */
export function roomBaselineOf(context: RoomContext | null): RoomBaseline | null {
  if (!context || context.baseline.sampleCount <= 0) return null
  const b = context.baseline
  return {
    sampleCount: b.sampleCount,
    avgLength: b.avgLength,
    emojiRate: b.emojiRate,
    questionRate: b.questionRate,
    exclaimRate: b.exclaimRate,
    mentionRate: b.mentionRate,
    arousal: b.arousal,
    valence: b.valence
  }
}
