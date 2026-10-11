import type {
  AiPortraitEvidence,
  AiPortraitReport,
  AiPortraitSection
} from './types'

/**
 * AI 画像的**纯工具**（主进程与渲染层共用一份，防止两边对同一段文本解析出两种结果）：
 *
 * 1. `portraitKeyOf` —— 缓存键（一个人的多个账号共用一版画像）；
 * 2. `portraitFingerprint` / `portraitInteractions` —— 「数据有没有涨」的判据；
 * 3. `extractJsonObject` —— 从模型回话里抠出那个 JSON 对象（模型常常带围栏或前后客套话）；
 * 4. `normalizePortraitReport` —— 把抠出来的东西**逐字段校验**成报告（模型少给/多给字段都不能崩界面）。
 *
 * 这四件事都必须**不依赖 electron / DB / 网络**：渲染层要在 IPC 边界上再兜一次底，
 * 工装（spike）要在纯 Node 里直接跑它们。
 */

/** 生成报告时要判定的字段上限（模型话多时按这个裁，界面排版有保证） */
export const PORTRAIT_LIMITS = {
  /** 分节数 */
  sections: 10,
  /** 每节条目数 */
  sectionItems: 8,
  /** 每节标题字数 */
  titleChars: 24,
  /** 每条条目字数 */
  itemChars: 400,
  /** 标签数 */
  tags: 8,
  /** 证据条数 */
  evidence: 8,
  /** 建议条数 */
  suggestions: 8,
  /** 局限条数 */
  caveats: 6,
  /** 一句话画像 / 类型名 / 总览的字数 */
  headlineChars: 120,
  personaChars: 24,
  overviewChars: 600
} as const

/**
 * 画像的缓存键。
 *
 * 绑定过账号的人（`identityId > 0`）用**画像**做键：他的几个号共用一版 AI 画像——
 * 与 `userAnalysis`（跨账号合并）、礼物日历同一口径（用户 2026-10-10：「换个房间看同一个人结论不变」）。
 * 没绑定的就用 id 自己做键。绑/解绑会换键，旧的那一版留在库里（重新绑回来还能用）。
 */
export function portraitKeyOf(identityId: number, userId: string): string {
  const id = String(userId ?? '').trim()
  if (identityId > 0) return `identity:${identityId}`
  return `user:${id}`
}

/** 指纹用的那几项（字段名与 `UserTotalsRow` / `UserAnalysisData` 对齐：`like` / `follow`） */
export interface PortraitFingerprintInput {
  chat: number
  enter: number
  like: number
  follow: number
  gift: number
  diamonds: number
  /** 最近一次出现（ms） */
  lastSeen: number
}

/**
 * 互动总量（弹幕 + 进场 + 点赞 + 关注 + 送礼条数）。
 *
 * 界面用它说「这份画像基于 N 条互动」，**不是**「消息总数」——礼物按条数算，
 * 与 `main/analysis/portrait.ts` 里 `interactions` 的口径逐字一致。
 */
export function portraitInteractions(input: PortraitFingerprintInput): number {
  const at = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0)
  return at(input.chat) + at(input.enter) + at(input.like) + at(input.follow) + at(input.gift)
}

/**
 * 数据指纹：把**会影响结论的那几个数**拼成一个短串。
 *
 * 只用来回答「这份画像生成之后，数据又涨了吗」——所以它必须是**便宜且稳定**的纯函数
 * （同一天同一份数据 → 同一个串），不能引入随机数、时间戳或对象键顺序。
 * 时间取到「小时」：秒级抖动不该让界面喊「数据已更新」。
 */
export function portraitFingerprint(input: PortraitFingerprintInput): string {
  const at = (value: number): number =>
    Number.isFinite(value) && value > 0 ? Math.round(value) : 0
  const hour = Math.floor(at(input.lastSeen) / 3600000)
  return [
    at(input.chat),
    at(input.enter),
    at(input.like),
    at(input.follow),
    at(input.gift),
    at(input.diamonds),
    hour
  ].join(':')
}

/** 一行文本：掐掉首尾空白、压掉换行与多余空格（模型的条目常常带换行） */
function line(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

/** 一段文本：保留换行（总览那种成段的话），同样限长 */
function paragraph(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\r/g, '').trim()
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

/** 字符串数组：逐条压平 + 限长 + 去重（模型爱重复同一句） */
function lines(value: unknown, maxCount: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    // 模型偶尔把一条写成 {text: '…'} / {title: '…'}：能认就认，认不出就丢
    const raw = typeof item === 'string' ? item : (item as { text?: unknown; title?: unknown } | null)
    const text = line(typeof raw === 'object' && raw !== null ? (raw.text ?? raw.title) : raw, maxChars)
    if (text && !out.includes(text)) out.push(text)
    if (out.length >= maxCount) break
  }
  return out
}

/**
 * 从模型回话里抠出那个 JSON 对象。
 *
 * 真实模型（哪怕提示词里写了「只回 JSON」）常见的三种偏差都要认：
 * 1. 包在 ```json 围栏里；
 * 2. 前后带一句客套（「好的，这是画像：{…}」）；
 * 3. 结构对但键名换成中文/别名（那是 `normalizePortraitReport` 的事，这里只管取出对象）。
 *
 * 做法是**括号配对扫描**（不是在第一个 `{` 和最后一个 `}` 之间截）：字符串里出现的花括号
 * （例如弹幕原话 `{笑}`）会让粗暴截取直接截错，配对扫描会正确地跳过 JSON 字符串内部。
 */
export function extractJsonObject(text: string): unknown {
  const source = String(text ?? '')
  if (!source) return null
  // 先剥围栏：只去掉开头那一段 ``` 语言标记，正文照旧
  const fenced = source.replace(/^\s*```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/, '')
  for (const candidate of [fenced, source]) {
    const json = scanBalanced(candidate)
    if (json.ok) return json.value
  }
  return null
}

/** 括号配对扫描：找到第一个完整的 `{…}` 并 JSON.parse */
function scanBalanced(source: string): { ok: true; value: unknown } | { ok: false } {
  const start = source.indexOf('{')
  if (start < 0) return { ok: false }
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return { ok: true, value: JSON.parse(source.slice(start, index + 1)) }
        } catch {
          return { ok: false }
        }
      }
    }
  }
  return { ok: false }
}

/** 取字段时的大小写/命名容忍（模型可能给 `Headline` / `oneLineSummary` 这类变体） */
function pick(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key]
  }
  return undefined
}

/**
 * 把任意输入校验成报告（**渲染层与主进程都要过这一关**）。
 *
 * 只要还有「一句话画像 / 类型名 / 总览 / 至少一节」就算成功——模型少给建议或局限时，
 * 界面少显示一块即可，不该整份报告作废（作废了用户花掉的 token 就白费了）。
 */
export function normalizePortraitReport(value: unknown): AiPortraitReport | null {
  if (typeof value !== 'object' || value === null) return null
  const source = value as Record<string, unknown>

  const headline = line(pick(source, ['headline', 'oneLine', 'oneLineSummary', '一句话画像', 'summaryLine']), PORTRAIT_LIMITS.headlineChars)
  const persona = line(pick(source, ['persona', 'personaName', 'type', '类型', '人物类型']), PORTRAIT_LIMITS.personaChars)
  const overview = paragraph(pick(source, ['overview', 'summary', '总览', 'profile']), PORTRAIT_LIMITS.overviewChars)

  const sectionsInput = pick(source, ['sections', 'parts', '分节', '章节'])
  const sections: AiPortraitSection[] = []
  if (Array.isArray(sectionsInput)) {
    for (const entry of sectionsInput) {
      if (typeof entry !== 'object' || entry === null) continue
      const item = entry as Record<string, unknown>
      const title = line(pick(item, ['title', 'name', 'label', '标题', '小标题']), PORTRAIT_LIMITS.titleChars)
      const items = lines(pick(item, ['items', 'points', 'bullets', 'content', '条目']), PORTRAIT_LIMITS.sectionItems, PORTRAIT_LIMITS.itemChars)
      if (!title && items.length === 0) continue
      sections.push({ title: title || '—', items })
      if (sections.length >= PORTRAIT_LIMITS.sections) break
    }
  }

  const evidenceInput = pick(source, ['evidence', 'quotes', '证据'])
  const evidence: AiPortraitEvidence[] = []
  if (Array.isArray(evidenceInput)) {
    for (const entry of evidenceInput) {
      if (typeof entry === 'string') {
        const quote = line(entry, PORTRAIT_LIMITS.itemChars)
        if (quote) evidence.push({ quote, note: '' })
      } else if (typeof entry === 'object' && entry !== null) {
        const item = entry as Record<string, unknown>
        const quote = line(pick(item, ['quote', 'text', '原文', '引用']), PORTRAIT_LIMITS.itemChars)
        const note = line(pick(item, ['note', 'why', 'explain', '说明']), PORTRAIT_LIMITS.itemChars)
        if (quote || note) evidence.push({ quote, note })
      }
      if (evidence.length >= PORTRAIT_LIMITS.evidence) break
    }
  }

  const report: AiPortraitReport = {
    headline,
    persona,
    overview,
    tags: lines(pick(source, ['tags', 'labels', '标签']), PORTRAIT_LIMITS.tags, PORTRAIT_LIMITS.titleChars),
    sections,
    evidence,
    suggestions: lines(pick(source, ['suggestions', 'advice', 'recommendations', '建议']), PORTRAIT_LIMITS.suggestions, PORTRAIT_LIMITS.itemChars),
    caveats: lines(pick(source, ['caveats', 'limits', 'uncertainty', '局限', '注意事项']), PORTRAIT_LIMITS.caveats, PORTRAIT_LIMITS.itemChars)
  }

  // 全空 = 这份回话里没有报告（不是「报告很简短」）：宁可退回原文展示，也不给一个空壳
  const hasAny =
    report.headline.length > 0 ||
    report.persona.length > 0 ||
    report.overview.length > 0 ||
    report.sections.length > 0 ||
    report.evidence.length > 0 ||
    report.suggestions.length > 0 ||
    report.caveats.length > 0
  return hasAny ? report : null
}

/** 模型回话 → 报告（抠 JSON + 校验；失败返回 null，调用方退回原文） */
export function parsePortraitReport(text: string): AiPortraitReport | null {
  return normalizePortraitReport(extractJsonObject(text))
}

/* ------------------------------------------------------------------ 流式半成品 */

/**
 * 从**还没写完的** JSON 里读出「已经闭合的那些字段」。
 *
 * 为什么需要它：模型是流式返回的，如果流式界面直接把 raw 文本贴出来，用户看到的就是
 * `{"persona": "夜聊型陪伴者", "headline": "…` 这种半截 JSON 在打字（很丑）。
 * 所以边收边解析：**已闭合**的字段立刻进入同一套结构渲染（类型名、一句话画像、总览、
 * 已经写完的分节会依次长出来），没闭合的一律不显示——既好看，也不会显示半句错话。
 *
 * 容错比 `parsePortraitReport` 更宽：这里只需要「闭合的字符串 / 闭合的对象」，
 * 不要求整体是合法 JSON（正常情况它确实还不是）。
 */
export function partialPortraitReport(text: string): AiPortraitReport | null {
  const source = String(text ?? '')
  if (!source) return null
  const report: AiPortraitReport = {
    headline: closedString(source, ['headline', 'oneLine', 'oneLineSummary', '一句话画像', 'summaryLine']),
    persona: closedString(source, ['persona', 'personaName', 'type', '类型', '人物类型']),
    overview: closedString(source, ['overview', 'summary', '总览', 'profile']),
    tags: closedStrings(source, ['tags', 'labels', '标签'], PORTRAIT_LIMITS.tags),
    sections: [],
    evidence: [],
    suggestions: closedStrings(source, ['suggestions', 'advice', 'recommendations', '建议'], PORTRAIT_LIMITS.suggestions),
    caveats: closedStrings(source, ['caveats', 'limits', 'uncertainty', '局限', '注意事项'], PORTRAIT_LIMITS.caveats)
  }

  const sectionObjects = closedObjects(source, ['sections', 'parts', '分节', '章节'], PORTRAIT_LIMITS.sections)
  for (const object of sectionObjects) {
    const title = closedString(object, ['title', 'name', 'label', '标题', '小标题'])
    const items = closedStrings(object, ['items', 'points', 'bullets', 'content', '条目'], PORTRAIT_LIMITS.sectionItems)
    if (title || items.length > 0) report.sections.push({ title: title || '—', items })
  }

  const evidenceObjects = closedObjects(source, ['evidence', 'quotes', '证据'], PORTRAIT_LIMITS.evidence)
  for (const object of evidenceObjects) {
    const quote = closedString(object, ['quote', 'text', '原文', '引用'])
    const note = closedString(object, ['note', 'why', 'explain', '说明'])
    if (quote || note) report.evidence.push({ quote, note })
  }

  const normalized = normalizePortraitReport(report)
  return normalized
}

/**
 * 取某个键**已经闭合**的字符串值（`"key": "…"` 里那个 `…` 收尾引号已到位）。
 *
 * 用正则而不是半截 JSON.parse：`JSON.parse` 对未闭合的文本必然抛错，而流式文本在
 * 99% 的时间里都是未闭合的。正则只认「引号成对」的那一段，正好就是「这一句写完了」。
 */
function closedString(source: string, keys: string[]): string {
  for (const key of keys) {
    const pattern = new RegExp(`"${escapeKey(key)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm')
    const match = pattern.exec(source)
    if (match) return decodeLiteral(match[1])
  }
  return ''
}

/** 取某个数组里已经闭合的字符串项（数组本身没闭合也没关系） */
function closedStrings(source: string, keys: string[], maxCount: number): string[] {
  for (const key of keys) {
    const start = source.search(new RegExp(`"${escapeKey(key)}"\\s*:\\s*\\[`))
    if (start < 0) continue
    const open = source.indexOf('[', start)
    const bounds = arrayBounds(source, open)
    const body = source.slice(open + 1, bounds.end)
    const out: string[] = []
    const literal = /"((?:[^"\\]|\\.)*)"/g
    let match = literal.exec(body)
    while (match && out.length < maxCount) {
      out.push(decodeLiteral(match[1]))
      match = literal.exec(body)
    }
    if (out.length > 0) return out
  }
  return []
}

/** 取某个数组里已经**整体闭合**的对象（正在写的那一个会被丢掉：它必然缺字段） */
function closedObjects(source: string, keys: string[], maxCount: number): string[] {
  for (const key of keys) {
    const start = source.search(new RegExp(`"${escapeKey(key)}"\\s*:\\s*\\[`))
    if (start < 0) continue
    const open = source.indexOf('[', start)
    const bounds = arrayBounds(source, open)
    const out: string[] = []
    let index = open
    while (index >= 0 && index < bounds.end && out.length < maxCount) {
      const next = source.indexOf('{', index)
      if (next < 0 || next >= bounds.end) break
      const object = balancedObjectAt(source, next)
      if (!object) break
      out.push(object)
      index = next + object.length
    }
    if (out.length > 0) return out
  }
  return []
}

/**
 * 数组的边界：`[` 之后第一个配平的 `]`（字符串里的方括号要跳过）。
 * 还没闭合就返回 `source.length`——此时「后面出现的一切」本来就都属于这个数组（JSON 是流式按序写的）。
 */
function arrayBounds(source: string, open: number): { end: number } {
  if (open < 0 || source[open] !== '[') return { end: source.length }
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) return { end: index }
    }
  }
  return { end: source.length }
}

/** 从 `start`（必须是 `{`）起取出配平的那个对象文本；没配平（还在写）返回 null */
function balancedObjectAt(source: string, start: number): string | null {
  if (source[start] !== '{') return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return null
}

/** 键名进正则（我们的键是固定那几个，转义只为稳妥） */
function escapeKey(key: string): string {
  return key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** JSON 字符串字面量 → 文本（带反斜杠就交给 JSON.parse 解，否则原样返回） */
function decodeLiteral(literal: string): string {
  if (!literal.includes('\\')) return literal
  try {
    return JSON.parse(`"${literal}"`) as string
  } catch {
    return literal
  }
}

/**
 * 报告 → Markdown（「复制」按钮用：用户要把画像贴到别处时，粘出来的是整齐的文本）。
 * 渲染在主进程/渲染层都行——纯函数，放在 shared 里两边一致。
 */
export function reportToMarkdown(report: AiPortraitReport): string {
  const out: string[] = []
  if (report.persona) out.push(`# ${report.persona}`)
  if (report.headline) out.push(`> ${report.headline}`)
  if (report.overview) out.push(report.overview)
  if (report.tags.length > 0) out.push(report.tags.map((tag) => `\`${tag}\``).join(' '))
  for (const section of report.sections) {
    out.push(`## ${section.title}`)
    for (const item of section.items) out.push(`- ${item}`)
  }
  if (report.evidence.length > 0) {
    out.push('## 关键证据')
    for (const item of report.evidence) {
      out.push(item.note ? `- 「${item.quote}」——${item.note}` : `- 「${item.quote}」`)
    }
  }
  if (report.suggestions.length > 0) {
    out.push('## 建议')
    for (const item of report.suggestions) out.push(`- ${item}`)
  }
  if (report.caveats.length > 0) {
    out.push('## 局限')
    for (const item of report.caveats) out.push(`- ${item}`)
  }
  return out.join('\n\n')
}
