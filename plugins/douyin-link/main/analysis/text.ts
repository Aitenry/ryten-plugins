/**
 * 弹幕文本分析（**纯算法**：无 DB / 无 electron / 无大模型）。
 *
 * 全部是确定性的**词典法 + 规则统计**，同一批文本永远得到同一份结果。
 *
 * 词典与规则是**照着真实库里的弹幕校准**的（`RytenBenchDB` 的 `douyin_link_messages`，
 * kind='chat'），不是想当然写的。抖音弹幕的三个真实特征决定了这里的设计：
 *
 * 1. **表情是方括号文本，不是 unicode emoji**：`[捂脸]`、`[打call]`、`[比心]`、`[思考]`……
 *    最高频的一条就是 `[捂脸]`。只按码点找 emoji 会**一个都抓不到**，所以这里专门解析 `[名字]`；
 * 2. **`@昵称` 点名是主要说话方式**（大量弹幕是 `@某人` 或 `@某人 内容`），所以
 *    提及率单独作为信号，且**先把 @提及 与 [表情] 剥掉**再算平均字数与关键词，
 *    否则「打字量」会被昵称长度带偏；
 * 3. **语音厅/点歌房有点歌消息**（`一首《太聪明》送给小猪熊…`），单独成一个主题。
 *
 * 四块产出：
 * - **情绪效价 valence**（正负词 + `[表情]` + unicode emoji）；
 * - **情绪唤起度 arousal**（感叹号 / 叠字 / 强化词 / 表情密度）——与效价构成 Russell 情绪环状模型两轴；
 * - **语用主题 topic**（点歌 / 点名 / 纯表情 / 提问 / 催促 / 致谢 / 赞美 / 应援 / 告别 / 打招呼 / 玩梗 / 分享 / 闲聊）；
 * - **语言特征**（平均字数 / 表情率 / 提及率 / 疑问率 / 外放率 / 重复率 / 关键词）。
 *
 * 之所以用「词典 + 规则」而不是模型：需求明确要求**不依赖大模型、无需人工处理**，
 * 且词典法的判定可解释、可复现、可测试——对「画像」这种要讲道理的场景比黑箱更合适。
 */

/** 一段文本的正负命中计数 */
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
  /** 情绪效价（-1..1） */
  valence: number
  /** 情绪唤起度（0..1） */
  arousal: number
  /** 正面命中总数 */
  positive: number
  /** 负面命中总数 */
  negative: number
  /** 负性弹幕（负面命中多于正面）的占比（0-1） */
  negativeRate: number
  /** 主题 → 条数（含 `chat` 兜底桶） */
  topicCounts: Array<{ key: string; count: number }>
  /** 话题广度（0-1：命中主题数取对数归一，与主题表长度无关） */
  topicDiversity: number
  /** 出现过的不同表情种数归一（0-1） */
  emojiVariety: number
  /** 常用词（纯展示；小样本时可能只出现 1 次） */
  keywords: string[]
}

/* ------------------------------------------------------------------------------- 情绪词典 */

/** 正面词（按真实弹幕取词：直播/语音厅高频的夸奖与致谢） */
const POSITIVE_WORDS = [
  '好听', '好看', '帅', '好美', '美女', '可爱', '厉害', '牛', '棒', '赞',
  '喜欢', '爱了', '爱你', '开心', '高兴', '笑死', '笑鼠', '优秀', '温柔', '完美',
  '幸福', '支持', '加油', '佩服', '辛苦', '谢谢', '感谢', '蟹蟹', '谢了', '大气',
  '有品', '到位', '治愈', '卡哇伊', '绝了', '给力', '舒服', '满足', '哈哈', '好乖', '有福', '欢迎'
]

/** 负面词 */
const NEGATIVE_WORDS = [
  '难看', '难听', '难喝', '难受', '烦', '讨厌', '恶心', '无语', '尴尬', '生气',
  '火大', '诅咒', '吵架', '好吵', '吵闹', '臭', '丑', '垃圾', '无聊', '拉黑',
  '举报', '完了', '破产', '哭', '呜呜', '委屈', 'emo', '不开心', '心疼', '作孽',
  '衰', '毁', '骗', '滚', '闭嘴', '笨蛋', '傻', '蠢', '拉稀', '气死', '失望'
]

/** unicode emoji（少见，但仍有人发） */
const POSITIVE_EMOJI = ['😀', '😁', '😂', '🤣', '😍', '🥰', '😘', '👍', '👏', '❤', '💖', '🔥', '🎉', '😆', '😊', '🤩', '💪', '🌟', '⭐', '🙌']
const NEGATIVE_EMOJI = ['😡', '😠', '🤬', '😭', '😢', '👎', '💔', '😞', '😩', '😫', '🙄', '😒', '🤮', '😓']

/**
 * 抖音**方括号表情**的词性表。真实弹幕里最高频的就是这些（`[捂脸]` 22 次、
 * `[打call]` 十余次），不认它们等于丢掉了最大的一类情绪线索。
 * 只收**词性明确**的；像 `[捂脸]` `[看]` `[思考]` `[奸笑]` 这类中性/自嘲的**不计数**，
 * 免得把满屏 `[捂脸]` 判成负面。
 */
const POSITIVE_BRACKET = [
  '打call', '比心', '爱心', '好开心', '愉快', '喜欢', '666', '赞', '酷', '酷拽',
  '送心', '鲜花', '玫瑰', '鼓掌', '庆祝', '亲亲', '抱抱', '求抱抱', '星星眼', '送花',
  '加油', '厉害', '优秀', '憨笑', '调皮', '色', '胜利', '撒花', '干杯', '咖啡',
  '闪光', '耶', '好棒', '棒棒', '摸头', '欣慰'
]

/** 负面方括号表情 */
const NEGATIVE_BRACKET = [
  '流泪', '大哭', '哭哭', '委屈', '快哭了', '翻白眼', '打脸', '鄙视', '咒骂', '你不大行',
  '无语', '叹气', '汗', '尬笑', '裂开', '裂', '吐', '生气', '发怒', '嫌弃',
  '菜', '敲打', '惊恐', '骷髅', '抠鼻', '怒', '被打脸', '想哭', '哭泣'
]

/** 方括号表情的匹配：`[名字]`（1-10 字，不含嵌套方括号） */
const BRACKET_RE = /\[([^[\]]{1,10})\]/g

/** 属于「应援/欢呼」的方括号表情（纯表情弹幕里这些要归到应援，而不是「纯表情」） */
const CHEER_BRACKET = ['打call', '鼓掌', '胜利', '耶', '干杯', '666', '撒花', '加油']

/** @提及 的匹配（昵称里不带 @；含空格的昵称只能剥到第一个空格，可接受） */
const MENTION_RE = /@[^\s@]+/g

/** unicode emoji 的码点判定 */
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

/** 文本里的 unicode emoji 字符集合 */
function unicodeEmojiOf(text: string): Set<string> {
  const set = new Set<string>()
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp !== undefined && isEmojiCodePoint(cp)) set.add(ch)
  }
  return set
}

/** 统计一段文本命中的正 / 负词数（词、方括号表情、unicode emoji 三路相加） */
export function scoreText(text: string): TextPolarity {
  let positive = 0
  let negative = 0
  for (const word of POSITIVE_WORDS) if (text.includes(word)) positive += 1
  for (const word of NEGATIVE_WORDS) if (text.includes(word)) negative += 1
  for (const name of bracketsOf(text)) {
    if (POSITIVE_BRACKET.includes(name)) positive += 1
    else if (NEGATIVE_BRACKET.includes(name)) negative += 1
  }
  for (const [, ch] of text) {
    if (POSITIVE_EMOJI.includes(ch)) positive += 1
    else if (NEGATIVE_EMOJI.includes(ch)) negative += 1
  }
  return { positive, negative }
}

/* ------------------------------------------------------------------------------- 语用主题 */

/**
 * 内容主题规则（**顺序即优先级**，每条弹幕只归入第一个命中的主题）。
 * 入参是**剥掉 @提及 与 [表情] 之后的正文**——纯 `@某人` 与纯表情在上层单独归类，
 * 不在这里判。
 */
const TOPIC_RULES: Array<{ key: string; words: string[] }> = [
  // 点歌/送歌（语音厅特有：`一首《太聪明》送给小猪熊…`）
  { key: 'song', words: ['一首', '点歌', '送给', '《', '点一首', '唱一首', '听歌', '首歌'] },
  // 提问
  { key: 'question', words: ['？', '?', '吗', '什么', '怎么', '为什么', '哪', '多少', '谁', '几点', '为啥', '咋', '能不能', '可不可以', '请问'] },
  // 催促/点单
  { key: 'urge', words: ['快点', '赶紧', '再来', '继续', '别停', '安排', '催', '多久', '下一个', '下播', '还不', '快唱', '给我', '点点', '申请'] },
  // 致谢
  { key: 'thanks', words: ['谢谢', '感谢', '蟹蟹', '谢了', '谢你', '辛苦'] },
  // 赞美
  { key: 'praise', words: ['好听', '好看', '好帅', '太帅', '帅', '美', '厉害', '牛', '棒', '优秀', '绝了', '太强', '喜欢', '可爱', '神仙', '完美', '温柔', '有品'] },
  // 应援/欢呼
  { key: 'cheer', words: ['加油', '冲', '支持', '666', '打卡', '应援', '打call', '牛'] },
  // 告别/退场
  { key: 'farewell', words: ['走了', '拜拜', '告辞', '撤了', '溜了', '下线', '睡了', '我走了', '下班'] },
  // 打招呼
  { key: 'greet', words: ['你好', '哈喽', '大家好', '晚上好', '早上好', '下午好', '在吗', '新人', '第一次', '路过', '欢迎', '泥嚎', 'hello', '午好', '来了'] },
  // 玩梗/调侃
  { key: 'banter', words: ['哈哈', '笑死', '笑鼠', '狗头', '离谱', '整活', '抽象', '绷不住', '蚌埠', '啊这', '无语', 'emo', '逗'] },
  // 分享/闲谈
  { key: 'share', words: ['我觉得', '其实', '说实话', '感觉', '好像', '以前', '记得', '因为', '所以', '然后', '我以为'] },
  // 附和/应答（短回应；放最后，只捞前面的规则没接住的）
  { key: 'ack', words: ['对呀', '对啊', '对的', '是呀', '是的', '嗯嗯', '嗯呢', '好嘟', '好的', '好哒', '可以', '没有', '没事', '不知道', '不行', '不用'] }
]

/** 兜底主题 */
const FALLBACK_TOPIC = 'chat'
/** 纯点名 / 纯表情（正文为空时的两个桶） */
const MENTION_TOPIC = 'mention'
const EMOJI_TOPIC = 'emoji'

function classifyTopic(body: string): string {
  for (const rule of TOPIC_RULES) {
    for (const word of rule.words) if (body.includes(word)) return rule.key
  }
  return FALLBACK_TOPIC
}

/* ------------------------------------------------------------------------------- 语言特征词典 */

/** 外放 / 激动信号词 */
const EXCLAIM_WORDS = ['太', '超级', '非常', '好想', '巨', '爆', '炸', '啊啊', '呜呜', '绝了', '顶不住']

/** 关键词表：直播/语音厅高频内容词（不做分词，直接整词命中；只用于展示） */
const KEYWORD_LEXICON = [
  '好听', '好看', '好帅', '唱歌', '点歌', '一首', '感谢', '谢谢', '哥哥', '妹妹',
  '姐姐', '老板', '少爷', '帅哥', '美女', '头像', '爱心', '小心心', '直播间', '语音厅',
  '上麦', '吃饭', '外卖', '上班', '下班', '休息', '熬夜', '游戏', '生日', '关注',
  '点赞', '加油', '连麦', '开播', '下播', '榜一', '粉丝团', '打卡', '新人', '亲亲'
]

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

/* ------------------------------------------------------------------------------- 主函数 */

/**
 * 分析一批弹幕文本，产出 `ChatTextSignals`。
 * 空样本返回全零（`sampleCount = 0`），由上层决定「无弹幕」的展示。
 */
export function analyzeChat(texts: string[]): ChatTextSignals {
  const samples = Array.isArray(texts) ? texts.filter((text) => typeof text === 'string' && text.length > 0) : []
  const sampleCount = samples.length
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
      negativeRate: 0,
      topicCounts: [],
      topicDiversity: 0,
      emojiVariety: 0,
      keywords: []
    }
  }

  let positive = 0
  let negative = 0
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
    const hit = scoreText(text)
    positive += hit.positive
    negative += hit.negative
    if (hit.negative > hit.positive) negativeSamples += 1

    const brackets = bracketsOf(text)
    const unicodeEmoji = unicodeEmojiOf(text)
    const hasEmoji = brackets.length > 0 || unicodeEmoji.size > 0
    if (hasEmoji) emojiSamples += 1
    for (const name of brackets) emojiAll.add(name)
    for (const ch of unicodeEmoji) emojiAll.add(ch)

    const hasMention = MENTION_RE.test(text)
    MENTION_RE.lastIndex = 0
    if (hasMention) mentionSamples += 1

    // 正文 = 剥掉 @提及、剥掉 [表情]、压掉空白 —— 平均字数与主题都基于它
    const body = text
      .replace(MENTION_RE, ' ')
      .replace(BRACKET_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    lengthSum += [...body].length

    const question = body.includes('？') || body.includes('?') || /吗|什么|怎么|哪|多少|谁|几点|为啥|咋|请问/.test(body) || brackets.includes('疑问')
    if (question) questionSamples += 1

    // 外放 / 激动（`!`、叠字、强化词、纯应援表情——只要沾一项就算「外放」）
    const exclaimWord = EXCLAIM_WORDS.some((word) => text.includes(word))
    const cheerEmoji = brackets.some((name) => CHEER_BRACKET.includes(name))
    const exclaim = text.includes('!') || text.includes('！') || hasRepeatedRun(text) || exclaimWord || cheerEmoji
    if (exclaim) exclaimSamples += 1

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
    let topic: string
    if (body.length === 0) {
      topic = cheerEmoji && !hasMention ? 'cheer' : hasMention ? MENTION_TOPIC : hasEmoji ? EMOJI_TOPIC : FALLBACK_TOPIC
    } else {
      topic = classifyTopic(body)
    }
    topicMap.set(topic, (topicMap.get(topic) ?? 0) + 1)

    for (const word of KEYWORD_LEXICON) {
      if (body.includes(word)) keywordMap.set(word, (keywordMap.get(word) ?? 0) + 1)
    }

    normalized.set(text.trim().toLowerCase(), (normalized.get(text.trim().toLowerCase()) ?? 0) + 1)
  }

  const emotionTotal = positive + negative
  const valence = emotionTotal === 0 ? 0 : Math.max(-1, Math.min(1, (positive - negative) / emotionTotal))
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
    negativeRate: negativeSamples / sampleCount,
    topicCounts,
    topicDiversity: logNorm(new Set(topicMap.keys()).size, 8),
    emojiVariety: logNorm(emojiAll.size, 12),
    keywords
  }
}
