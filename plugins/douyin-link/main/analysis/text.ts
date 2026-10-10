/**
 * 弹幕文本分析（**纯算法**：无 DB / 无 electron / 无大模型）。词表在 `./lexicon.ts`。
 *
 * 分析链路照「基于情感词典」的标准做法（见 `lexicon.ts` 注释里的来源）：
 *
 * ```
 * 正文 → 最长优先扫描命中情感词 → 向左 4 字窗口找程度副词/否定词 → 加权得到分值
 *      → 正负极性（valence） + 7 大类情感分布 + 语言特征
 * ```
 *
 * 与上一版的三个关键差别（都是「更准」的直接来源）：
 * 1. **情感词带强度与类别**：不再是「命中就 +1」，而是 `强度(1/3/5/7/9) × 程度权重`，
 *    且每个词归入大连理工的 7 大类之一 → 能给出**情感细类分布**，不再只有一根正负轴；
 * 2. **否定 + 程度副词**：`不好听` → 负、`太好听了` → 更强、`不太喜欢` → 弱负。
 *    上一版完全没有这一层，「不 + 正面词」会被当成正面，这是最大的准确性漏洞；
 * 3. **最长优先**：`好听哭了` 不会被拆成 `好听` + `哭` 两条互相抵消。
 *
 * 性能：扫描是 `O(文本长度 × 最长词长)` 的哈希查表（不是「词表 × 文本」的 includes），
 * 所以词表到**万条量级**也不会变慢——个人画像常见几十条、全量也就两千条弹幕，在毫秒级。
 * 词表本身分两层（人工领域层 + 自动生成的通用层，共 1.4 万条）见 `./lexicon.ts`。
 */
import {
  BRACKET_EMOTION,
  DEGREE_WORDS,
  EMOTION_WORDS,
  EXCLAIM_WORDS,
  EXTRA_DEGREE_WORDS,
  EXTRA_EMOTION_WORDS,
  EXTRA_NEGATION_WORDS,
  EXTRA_NEGATIVE_WORDS,
  EXTRA_POSITIVE_WORDS,
  GENERATED_STRENGTH,
  KEYWORD_LEXICON,
  NEGATION_WORDS,
  NEGATIVE_CATEGORIES,
  POSITIVE_CATEGORIES,
  TOPIC_RULES,
  UNICODE_EMOTION,
  type EmotionKey
} from './lexicon'

/** 一条文本的正负命中计数（对外保留，方便单测） */
export interface TextPolarity {
  positive: number
  negative: number
}

/** 弹幕文本分析的全部信号（都是原始计数或 0-1 比例，交给 portrait.ts 决定权重） */
export interface ChatTextSignals {
  /** 参与分析的样本数 */
  sampleCount: number
  /** 平均字数（已剥掉 @提及 与 [表情]，反映真正的「打字量」） */
  avgLength: number
  /** 用表情的比例（0-1）：`[名字]` 方括号表情或 unicode emoji */
  emojiRate: number
  /** 带 @提及 的比例（0-1） */
  mentionRate: number
  /** 疑问句比例（0-1） */
  questionRate: number
  /** 外放表达比例（0-1） */
  exclaimRate: number
  /** 重复刷屏比例（0-1） */
  repeatRate: number
  /** 情绪效价（-1..1）：由加权正负分算，已含程度副词与否定 */
  valence: number
  /** 情绪唤起度（0..1） */
  arousal: number
  /** 正面命中次数（句内逐次计） */
  positive: number
  /** 负面命中次数 */
  negative: number
  /** 正面加权总分（含程度/否定） */
  positiveScore: number
  /** 负面加权总分 */
  negativeScore: number
  /** 负性弹幕（加权负分 > 正分）的占比（0-1） */
  negativeRate: number
  /** 7 大类情感的累计强度（未归一；否定过的词不计入，避免「不好笑」被算进「乐」） */
  emotionIntensity: Record<EmotionKey, number>
  /** 主题 → 条数（含 `chat` 兜底桶） */
  topicCounts: Array<{ key: string; count: number }>
  /** 话题广度（0-1：命中主题数取对数归一） */
  topicDiversity: number
  /** 出现过的不同表情种数归一（0-1） */
  emojiVariety: number
  /** 常用词（纯展示；小样本时可能只出现 1 次） */
  keywords: string[]
}

/* --------------------------------------------------------------------------------- 匹配器 */

/** 情感词表按「词长 → 词」建桶，扫描时从长到短试，天然做到最长优先 */
const MAX_WORD_LEN = 6
/** 允许单字情感词（`帅` `牛` `烦` `滚`…）——词表里收录的单字都是直播语境下词性明确的 */
const MIN_WORD_LEN = 1
/** 否定 / 程度副词只往情感词**左边**看这么多字（`不太好听` 的窗口是 `不太好`） */
const WINDOW = 4

/** 一条情感词表项：`polarity` 决定正负，`category` 决定进不进 7 大类情感构成 */
interface EmotionEntry {
  /** 极性：1 正 / -1 负 / 0 不计极性（「惊」） */
  polarity: 1 | -1 | 0
  /** 7 大类归属；通用层的知网词只有极性、没有类别，这里为 null */
  category: EmotionKey | null
  strength: number
}

/**
 * 建表：**人工领域层在前**（同词冲突时人工标注胜出），然后是通用层的 7 大类词，
 * 最后是通用层的纯极性词。三层都是「先写入者胜」。
 */
const EMOTION_BUCKETS: Array<Map<string, EmotionEntry>> = (() => {
  const buckets: Array<Map<string, EmotionEntry>> = []
  for (let len = 0; len <= MAX_WORD_LEN; len += 1) buckets.push(new Map())
  const put = (word: string, entry: EmotionEntry): void => {
    const len = word.length
    if (len < MIN_WORD_LEN || len > MAX_WORD_LEN) return
    const bucket = buckets[len]
    if (!bucket.has(word)) bucket.set(word, entry)
  }

  // 1) 领域层：类别、强度都是人工标过的
  for (const key of Object.keys(EMOTION_WORDS) as EmotionKey[]) {
    const polarity = polarityOf(key)
    for (const [word, strength] of EMOTION_WORDS[key]) put(word, { polarity, category: key, strength })
  }
  // 2) 通用层 7 大类：类别已知、强度取常规档
  for (const key of Object.keys(EXTRA_EMOTION_WORDS) as EmotionKey[]) {
    const polarity = polarityOf(key)
    for (const word of EXTRA_EMOTION_WORDS[key]) {
      put(word, { polarity, category: key, strength: GENERATED_STRENGTH })
    }
  }
  // 3) 通用层纯极性：知网不提供 7 大类归属，只参与正负
  for (const word of EXTRA_POSITIVE_WORDS) {
    put(word, { polarity: 1, category: null, strength: GENERATED_STRENGTH })
  }
  for (const word of EXTRA_NEGATIVE_WORDS) {
    put(word, { polarity: -1, category: null, strength: GENERATED_STRENGTH })
  }
  return buckets
})()

/** 程度副词：窗口里出现多个时取最强的一档（`超级超级好听` → 2）。领域层与通用层合并 */
const ALL_DEGREE_WORDS: Array<[string, number]> = [...DEGREE_WORDS, ...EXTRA_DEGREE_WORDS]

/** 否定词：领域层 + 通用层 */
const ALL_NEGATION_WORDS: string[] = [...NEGATION_WORDS, ...EXTRA_NEGATION_WORDS]

/** 程度副词：窗口里出现多个时取最强的一档（`超级超级好听` → 2） */
function degreeOf(window: string): number {
  let weight = 1
  for (const [word, value] of ALL_DEGREE_WORDS) {
    if (value > weight && window.includes(word)) weight = value
  }
  return weight
}

/** 窗口里出现任一个否定词即为否定 */
function isNegated(window: string): boolean {
  for (const word of ALL_NEGATION_WORDS) if (window.includes(word)) return true
  return false
}

/** 一次情感命中（`score` = 强度 × 程度 × 极性 × 否定） */
interface EmotionHit {
  /** 命中的词（诊断用） */
  word: string
  category: EmotionKey | null
  strength: number
  score: number
  /** 是否被否定过：否定的词不进情感细类分布（它表达的是「没有这种情绪」，不是这种情绪） */
  negated: boolean
}

/** 词所属大类的极性：`surprise` 不计极性（大连理工本体里「惊」多为极性 0），得 0 分 */
function polarityOf(category: EmotionKey): 1 | -1 | 0 {
  if (POSITIVE_CATEGORIES.includes(category)) return 1
  if (NEGATIVE_CATEGORIES.includes(category)) return -1
  return 0
}

/** 最长优先扫描：命中的词会「吃掉」自己的字数，不会被拆成更短的词重复计分 */
function scanEmotions(hay: string): EmotionHit[] {
  const hits: EmotionHit[] = []
  let index = 0
  const length = hay.length
  while (index < length) {
    const maxLen = Math.min(MAX_WORD_LEN, length - index)
    let matched = false
    for (let len = maxLen; len >= MIN_WORD_LEN; len -= 1) {
      const word = hay.slice(index, index + len)
      const entry = EMOTION_BUCKETS[len].get(word)
      if (!entry) continue
      const window = hay.slice(Math.max(0, index - WINDOW), index)
      const degree = degreeOf(window)
      const negated = isNegated(window)
      const strength = entry.strength * degree
      // 极性来自词条本身（乐/好为正，怒/哀/惧/恶为负，惊为 0），否定再把符号翻一次
      const score = strength * entry.polarity * (negated ? -1 : 1)
      hits.push({ word, category: entry.category, strength, score, negated })
      index += len
      matched = true
      break
    }
    if (!matched) index += 1
  }
  return hits
}

/**
 * **诊断用**：把一段文本的命中逐条摊开（命中的词、所属大类、加权后的分值）。
 *
 * 词表是「通用层 + 领域层」合并出来的，误判只可能来自某个具体词——
 * 调词表时先在这里看是哪个词干的，比猜快得多。生产逻辑不依赖它。
 */
export function explainText(text: string): Array<{ word: string; category: EmotionKey | null; score: number }> {
  const body = text
    .replace(MENTION_RE, ' ')
    .replace(BRACKET_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return scanEmotions(body.toLowerCase()).map((hit) => ({
    word: hit.word,
    category: hit.category,
    score: Math.round(hit.score * 10) / 10
  }))
}

/* ------------------------------------------------------------------------------- 文本解析 */

/** 抖音**方括号表情**：`[捂脸]`（1-10 字，不含嵌套方括号） */
const BRACKET_RE = /\[([^[\]]{1,10})\]/g
/** @提及（昵称里不带 @；含空格的昵称只能剥到第一个空格，可接受） */
const MENTION_RE = /@[^\s@]+/g

/** 判断一个码点是不是 emoji / 装饰符号 */
function isEmojiCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b00 && cp <= 0x2bff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x2b50
  )
}

/** 文本里的方括号表情名（`[捂脸][打call]` → `['捂脸','打call']`） */
function bracketsOf(text: string): string[] {
  const names: string[] = []
  BRACKET_RE.lastIndex = 0
  let match = BRACKET_RE.exec(text)
  while (match !== null) {
    names.push(match[1])
    match = BRACKET_RE.exec(text)
  }
  return names
}

/** 文本里的 unicode emoji */
function unicodeEmojiOf(text: string): string[] {
  const found: string[] = []
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp !== undefined && isEmojiCodePoint(cp)) found.push(ch)
  }
  return found
}

/** 是否有「叠字」爆发（连续 3 个相同字符，如 啊啊啊 / 哈哈哈哈） */
function hasRepeatedRun(text: string): boolean {
  let run = 1
  let prev = ''
  for (const ch of text) {
    if (ch === prev) {
      run += 1
      if (run >= 3) return true
    } else {
      run = 1
      prev = ch
    }
  }
  return false
}

/** 属于「应援/欢呼」的方括号表情（纯表情弹幕里这些要归到应援，而不是「纯表情」） */
const CHEER_BRACKET = ['打call', '鼓掌', '胜利', '耶', '干杯', '666', '撒花', '加油']

/** 兜底主题 / 纯点名 / 纯表情 */
const FALLBACK_TOPIC = 'chat'
const MENTION_TOPIC = 'mention'
const EMOJI_TOPIC = 'emoji'

function classifyTopic(body: string): string {
  for (const rule of TOPIC_RULES) {
    for (const word of rule.words) if (body.includes(word)) return rule.key
  }
  return FALLBACK_TOPIC
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function logNorm(value: number, max: number): number {
  const v = Math.max(0, value)
  const m = Math.max(1, max)
  return clamp01(Math.log10(1 + v) / Math.log10(1 + m))
}

function emptyIntensity(): Record<EmotionKey, number> {
  return { joy: 0, like: 0, anger: 0, sorrow: 0, fear: 0, disgust: 0, surprise: 0 }
}

/* -------------------------------------------------------------------------------- 打分 */

/**
 * 给一段文本打分（词 + 方括号表情 + unicode emoji 三路相加）。
 * 返回正负**命中次数**与**加权分值**，以及各类情感的强度。
 */
export function scoreText(text: string): TextPolarity {
  const hits = scanEmotions(text.toLowerCase())
  let positive = 0
  let negative = 0
  for (const hit of hits) {
    if (hit.score > 0) positive += 1
    else if (hit.score < 0) negative += 1
  }
  for (const name of bracketsOf(text)) {
    const entry = BRACKET_EMOTION[name]
    if (!entry) continue
    if (POSITIVE_CATEGORIES.includes(entry[0])) positive += 1
    else if (NEGATIVE_CATEGORIES.includes(entry[0])) negative += 1
  }
  for (const ch of unicodeEmojiOf(text)) {
    const entry = UNICODE_EMOTION[ch]
    if (!entry) continue
    if (POSITIVE_CATEGORIES.includes(entry[0])) positive += 1
    else if (NEGATIVE_CATEGORIES.includes(entry[0])) negative += 1
  }
  return { positive, negative }
}

/* ------------------------------------------------------------------------------- 主函数 */

/**
 * 分析一批弹幕文本，产出 `ChatTextSignals`。
 * 空样本返回全零（`sampleCount = 0`），由上层决定「无弹幕」的展示。
 */
export function analyzeChat(texts: string[]): ChatTextSignals {
  const samples = Array.isArray(texts) ? texts.filter((text) => typeof text === 'string' && text.length > 0) : []
  const sampleCount = samples.length
  const emotionIntensity = emptyIntensity()
  if (sampleCount === 0) {
    return {
      sampleCount: 0,
      avgLength: 0,
      emojiRate: 0,
      mentionRate: 0,
      questionRate: 0,
      exclaimRate: 0,
      repeatRate: 0,
      valence: 0,
      arousal: 0,
      positive: 0,
      negative: 0,
      positiveScore: 0,
      negativeScore: 0,
      negativeRate: 0,
      emotionIntensity,
      topicCounts: [],
      topicDiversity: 0,
      emojiVariety: 0,
      keywords: []
    }
  }

  let positive = 0
  let negative = 0
  let positiveScore = 0
  let negativeScore = 0
  let lengthSum = 0
  let emojiSamples = 0
  let mentionSamples = 0
  let questionSamples = 0
  let exclaimSamples = 0
  let negativeSamples = 0
  let arousalSum = 0

  const emojiAll = new Set<string>()
  const topicMap = new Map<string, number>()
  const keywordMap = new Map<string, number>()
  const normalized = new Map<string, number>()

  for (const text of samples) {
    const brackets = bracketsOf(text)
    const unicodeEmoji = unicodeEmojiOf(text)
    const hasEmoji = brackets.length > 0 || unicodeEmoji.length > 0
    if (hasEmoji) emojiSamples += 1
    for (const name of brackets) emojiAll.add(name)
    for (const ch of unicodeEmoji) emojiAll.add(ch)

    const hasMention = MENTION_RE.test(text)
    MENTION_RE.lastIndex = 0
    if (hasMention) mentionSamples += 1

    // 正文 = 剥掉 @提及、剥掉 [表情]、压掉空白 —— 平均字数、主题、常用词都基于它
    const body = text
      .replace(MENTION_RE, ' ')
      .replace(BRACKET_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    lengthSum += [...body].length

    // 情感词（含程度副词与否定）
    let messagePositive = 0
    let messageNegative = 0
    for (const hit of scanEmotions(body.toLowerCase())) {
      // 没被否定的情绪才进细类分布：「不好笑」表达的是「没有好笑」，不是「乐」；
      // 「惊」也在分布里（它只是不参与正负极性）。通用层里没有 7 大类归属的词（category 为 null）
      // 只贡献极性，不进情感构成。
      if (hit.category !== null && !hit.negated) emotionIntensity[hit.category] += hit.strength
      if (hit.score > 0) {
        positive += 1
        messagePositive += hit.score
      } else if (hit.score < 0) {
        negative += 1
        messageNegative += -hit.score
      }
    }

    // 方括号表情 + unicode emoji（没有否定窗口，直接用强度计入）
    const emojiScores: Array<[EmotionKey, number]> = []
    for (const name of brackets) {
      const entry = BRACKET_EMOTION[name]
      if (entry) emojiScores.push(entry)
    }
    for (const ch of unicodeEmoji) {
      const entry = UNICODE_EMOTION[ch]
      if (entry) emojiScores.push(entry)
    }
    for (const [category, strength] of emojiScores) {
      emotionIntensity[category] += strength
      if (POSITIVE_CATEGORIES.includes(category)) {
        positive += 1
        messagePositive += strength
      } else if (NEGATIVE_CATEGORIES.includes(category)) {
        negative += 1
        messageNegative += strength
      }
    }

    positiveScore += messagePositive
    negativeScore += messageNegative
    if (messageNegative > messagePositive) negativeSamples += 1

    const question =
      body.includes('？') ||
      body.includes('?') ||
      /吗|什么|怎么|哪|多少|谁|几点|为啥|咋|请问/.test(body) ||
      brackets.includes('疑问')
    if (question) questionSamples += 1

    // 外放 / 激动（`!`、叠字、强化词、纯应援表情——只要沾一项就算「外放」）
    const exclaimWord = EXCLAIM_WORDS.some((word) => text.includes(word))
    const cheerEmoji = brackets.some((name) => CHEER_BRACKET.includes(name))
    if (text.includes('!') || text.includes('！') || hasRepeatedRun(text) || exclaimWord || cheerEmoji) {
      exclaimSamples += 1
    }

    // 唤起度：多条线索叠加（≥3 条 → 拉满）
    let arousal = 0
    if (text.includes('!') || text.includes('！')) arousal += 1
    if (hasRepeatedRun(text)) arousal += 1
    if (hasEmoji) arousal += 1
    if (text.includes('啊') || text.includes('呀') || text.includes('哇')) arousal += 1
    if (exclaimWord) arousal += 1
    if (brackets.length >= 3) arousal += 1
    if (cheerEmoji) arousal += 1
    arousalSum += clamp01(arousal / 3)

    // 主题：正文为空时按「纯应援 / 纯点名 / 纯表情」归类
    const topic =
      body.length === 0
        ? cheerEmoji && !hasMention
          ? 'cheer'
          : hasMention
            ? MENTION_TOPIC
            : hasEmoji
              ? EMOJI_TOPIC
              : FALLBACK_TOPIC
        : classifyTopic(body)
    topicMap.set(topic, (topicMap.get(topic) ?? 0) + 1)

    for (const word of KEYWORD_LEXICON) {
      if (body.includes(word)) keywordMap.set(word, (keywordMap.get(word) ?? 0) + 1)
    }

    normalized.set(text.trim().toLowerCase(), (normalized.get(text.trim().toLowerCase()) ?? 0) + 1)
  }

  // 效价做**证据平滑**：分母补一个常数，避免「只发过一句谢谢」就得出 100% 积极。
  // 常数 10 意味着「要有约 10 分情感量，效价才接近原始比例」——样本越少越靠近中性。
  const VALENCE_SMOOTHING = 10
  const emotionTotal = positiveScore + negativeScore
  const valence =
    emotionTotal === 0
      ? 0
      : Math.max(-1, Math.min(1, (positiveScore - negativeScore) / (emotionTotal + VALENCE_SMOOTHING)))
  const topicCounts = [...topicMap.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))

  // 常用词阈值随样本量走：小样本（个人画像常见几十条）放宽到 1 次，大样本要求 ≥2 次
  const minKeywordCount = sampleCount >= 100 ? 2 : 1
  const keywords = [...keywordMap.entries()]
    .filter(([, count]) => count >= minKeywordCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([word]) => word)

  return {
    sampleCount,
    avgLength: lengthSum / sampleCount,
    emojiRate: emojiSamples / sampleCount,
    mentionRate: mentionSamples / sampleCount,
    questionRate: questionSamples / sampleCount,
    exclaimRate: exclaimSamples / sampleCount,
    repeatRate: clamp01(1 - normalized.size / sampleCount),
    valence,
    arousal: clamp01(arousalSum / sampleCount),
    positive,
    negative,
    positiveScore: Math.round(positiveScore),
    negativeScore: Math.round(negativeScore),
    negativeRate: negativeSamples / sampleCount,
    emotionIntensity,
    topicCounts,
    topicDiversity: logNorm(new Set(topicMap.keys()).size, 8),
    emojiVariety: logNorm(emojiAll.size, 12),
    keywords
  }
}
