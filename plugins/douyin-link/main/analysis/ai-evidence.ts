import type {
  AiPortraitReport,
  AiPortraitRole,
  LiveSettings,
  UserAnalysis,
  UserDetail
} from '../../shared/types'
import type { UserPortraitExtras } from '../db/mapper'
import { portraitFingerprint, portraitInteractions } from '../../shared/ai-portrait'

/**
 * AI 画像的**证据打包与提示词**（纯函数：无 DB、无网络、无 electron）。
 *
 * 为什么单独一份、且必须是纯的：
 * 1. 提示词就是**成本**（输入 token 直接等于钱），所以要能离线量出「这份材料多少字」；
 * 2. 它是这个功能里唯一「说错话就全错」的地方（材料漏了 → 模型编；材料脏了 → 结论歪），
 *    放在纯函数里就能用工装拿**真库副本**逐条断言（见 `spike/ai-portrait-prompt-check.mjs`
 *    与 `spike/ai-portrait-db-check.mjs`）；
 * 3. 服务层（`main/portrait.ts`）只负责取数、调模型、落库——不掺文案。
 *
 * 材料的分工是刻意的：
 * - **算法层**（`UserAnalysis`，确定性规则算出来的）给**事实**：六维、大五侧写、动机结构、
 *   情感构成、互动结构、送礼习惯、关系网。模型不该重算这些，只需要**解读**它们；
 * - **原始层**（带时间戳的弹幕样本、礼物流水、按房间摊开的数据）给**上下文**：
 *   模型据此看出语气、场景、他给谁花过钱、什么时候来。没有这一层，画像只能是对数字的复述。
 */

/* ------------------------------------------------------------------------- 文案 */

/**
 * 提示词里的固定措辞：中英两份**逐键对齐**（`typeof ZH` 约束）。
 *
 * 为什么不走渲染层词条：这些字符串只有模型看得到（用户看不到），而且**必须与材料同语言**
 * 才能让模型稳定地按同语言作答（中英混排时模型爱跟着最后一段的语言走）。
 */
const zh = {
  roleViewer: '你是直播运营的数据分析师，擅长从观众的行为流水里读出「这个人是谁、为什么留在这里」。',
  roleHost:
    '你是直播运营的数据分析师，擅长从主播的直播流水里读出「他的直播风格是什么、靠什么留住人、收益从哪里来」。',
  taskViewer: '根据下面这份**真实数据材料**，为这位抖音直播间的观众写一份尽可能全面、可执行的用户画像。',
  taskHost:
    '根据下面这份**真实数据材料**，为这位抖音直播间/语音房的**主播**写一份尽可能全面、可执行的主播画像（分析的是他自己的直播表现，不是把他当观众）。',
  rulesTitle: '硬性要求',
  rules: [
    '只依据材料。材料里没有的事实不要补；不要猜测真实姓名、职业、住址、性别取向等现实身份信息；不要输出政治、宗教、医疗等敏感判断。',
    '引用原话时**必须逐字**取自「{{samples}}」；没有合适的原话就不要引用，不要自己编一句像弹幕的话。',
    '所有数字必须与材料一致（材料里的数字都是**跨全部直播间**的累计值，礼物抖币是平台虚拟币）。',
    '材料不足以支撑的结论要降低措辞强度（例如「从现有样本看」），并在 caveats 里如实说明样本量与不确定项。',
    '输出**只有一个 JSON 对象**：不要 markdown 围栏、不要任何解释性前后文、不要注释。',
    `全部文案用{{language}}书写。`
  ],
  rulesHostExtra:
    '材料里的发言记录是**他本人在房间里发的话**（本插件只记录文字消息，不记录语音），不要把观众的发言当成他的表现；房间播 / 语音房里同一场可能有多个主播，判断某句话是不是他本人输出时以发言人 id 为准，不确定就少说。',
  shapeTitle: '输出 JSON 的形状（字段名必须完全一致）',
  shape: [
    '{',
    '  "persona": "{{persona}}",',
    '  "headline": "一句话画像，不超过 40 字，最精炼的结论",',
    '  "overview": "{{overview}}",',
    '  "tags": ["3-6 个短标签"],',
    '  "sections": [',
    '    { "title": "小标题", "items": ["每条一句话，可带数字"] }',
    '  ],',
    '  "evidence": [ { "quote": "原话或具体数字", "note": "它说明了什么" } ],',
    '  "suggestions": ["{{suggestions}}"],',
    '  "caveats": ["数据局限、样本不足、不确定的地方"]',
    '}'
  ],
  shapePersonaViewer: '人物类型名，4-10 字，你自己起（例如「夜聊型陪伴者」「闷声打赏的老观众」）',
  shapePersonaHost: '主播类型名，4-10 字，你自己起（例如「深夜点歌型」「唠嗑控场型」「安静才艺型」）',
  shapeOverviewViewer: '总览，2-4 句，把这个人整体说清楚（他是什么人、为什么来、处于什么关系阶段）',
  shapeOverviewHost: '总览，2-4 句，把他的直播整体说清楚（做什么内容、什么风格、现在处于什么阶段）',
  shapeSuggestionsViewer: '可执行的维护 / 互动建议（对主播或运营说的话）',
  shapeSuggestionsHost:
    '可执行的直播建议（直接对这位主播说：内容与选题、话术与控场、互动与节奏、留人和转化）',
  samplesShortViewer: '弹幕样本',
  samplesShortHost: '发言记录样本',
  sectionsHintViewer:
    'sections 建议覆盖这些角度（每节 2-5 条，按材料支持程度取舍）：说话风格与语言特征 / 消费与送礼动机 / 社交角色与关系 / 内容偏好与兴趣 / 活跃节律与到访习惯 / 与主播的关系阶段 / 流失或升级信号。',
  sectionsHintHost:
    'sections 建议覆盖这些角度（每节 2-5 条，按材料支持程度取舍）：直播风格与话术特征 / 内容与才艺构成 / 与观众的互动方式（点名、回应、控场） / 留人与转化手段（引导关注、粉丝团、礼物） / 收益与礼物结构 / 与其他主播的连麦与关系 / 开播节律与场次表现 / 成长或瓶颈信号。',
  sectionCount: 'sections 给 4-7 节，evidence 给 3-6 条，suggestions 给 3-6 条，caveats 给 1-4 条。',
  refineTitle: '这是一次迭代（不是从零开始）',
  refine:
    '下面给了**上一版画像**。请保留其中仍然成立的判断，把材料能支持的部分写得更具体（更细的行为证据、更清楚的因果、更有画面感的措辞）；材料里出现了上一版没提到的新信息就补进去；与材料冲突的旧说法必须改正。**不要只是把上一版换个说法重复一遍。**',
  materialTitle: '材料',
  materialNote:
    '口径说明：累计数字来自本插件「用户档案表」的跨房间合计（按批落库），弹幕 / 送礼 / 收礼样本来自消息流水原文。两者偶尔会差一两条（档案还没结算完），以流水为准；若发现出入，请在 caveats 里如实说明，不要自行编造原因。',
  identity: '一、身份与账号',
  totals: '二、跨全部直播间的累计数据',
  behavior: '三、互动结构（五类互动构成）',
  algorithm: '四、算法层事实（确定性规则算出来的，不要重算，只用于解读与印证）',
  rhythm: '五、活跃节律（24 小时分布，本地时区）',
  rooms: '六、出现过的直播间（按房间摊开）',
  chatSamplesViewer: '七、弹幕样本（最近 %s 条，新 → 旧，带时间）',
  chatSamplesHost: '七、发言记录样本（他本人在房间里发的话，最近 %s 条，新 → 旧，带时间）',
  sentGiftsViewer: '八、送礼流水（最近 %s 条，新 → 旧）',
  sentGiftsHost: '八、送礼流水（他自己送出去的，最近 %s 条，新 → 旧）',
  receivedGiftsViewer: '九、收礼流水（最近 %s 条，新 → 旧）',
  receivedGiftsHost: '九、收礼流水（别人送给他的，最近 %s 条，新 → 旧，这是他的收益）',
  network: '十、人物关系网（算法算出的送礼 / 收礼排行）',
  networkOutHost: '他送礼最多的人（他主动维护的关系）',
  networkInHost: '送礼给他最多的人（他的主要收入来源）',
  hostNote:
    '角色说明：这份材料分析的是**主播**本人——他在房间里的发言是他的工作输出，收到的礼物是他的收益；房间播 / 语音房里一场可能有多个主播，别把其他主播或观众的行为算到他头上。',
  previous: '十一、上一版画像（第 %s 版）',
  noData: '（没有）',
  nickname: '昵称',
  douyinId: '抖音号',
  userId: '用户 id',
  gender: '性别',
  city: '地区',
  signature: '签名',
  following: '关注',
  follower: '粉丝',
  honor: '荣誉等级',
  fansClub: '粉丝团等级',
  badge: '徽章',
  firstSeen: '首次出现',
  lastSeen: '最近出现',
  activeDays: '活跃天数',
  spanDays: '时间跨度(天)',
  chat: '弹幕',
  enter: '进场',
  like: '点赞',
  follow: '关注',
  gift: '送礼次数',
  sentDiamonds: '送出抖币',
  receivedDiamonds: '收到抖币',
  roomCount: '出现过的直播间数',
  avgGift: '单次均值(抖币)',
  maxGift: '单笔最大(抖币)',
  giftDays: '送礼天数',
  giftKinds: '礼物种类',
  recipients: '送礼对象数',
  topGift: '最常送的礼物',
  sessions: '到访场次',
  avgStay: '平均停留(分钟)',
  maxStay: '最长停留(分钟)',
  perSession: '每场互动数',
  followDays: '关注转化(天，-1=未关注)',
  hour: '点',
  minutes: '分钟',
  times: '次',
  count: '件',
  coins: '抖币',
  people: '人',
  kindLabels: {
    chat: '弹幕',
    member: '进场',
    like: '点赞',
    social: '关注',
    gift: '礼物'
  } as Record<string, string>,
  traitLabels: {
    spending: '消费力',
    activity: '活跃度',
    sociability: '社交性',
    loyalty: '忠诚度',
    emotion: '情绪热度',
    identity: '身份标识'
  } as Record<string, string>,
  big5Labels: {
    openness: '开放性',
    conscientiousness: '尽责性',
    extraversion: '外向性',
    agreeableness: '宜人性',
    stability: '情绪稳定性'
  } as Record<string, string>,
  motivationLabels: {
    connection: '社交连接',
    identity: '身份认同',
    interest: '内容欣赏',
    companionship: '习惯陪伴'
  } as Record<string, string>,
  archetypeLabels: {
    whale: '消费型',
    socializer: '社交型',
    loyalist: '忠诚粉',
    supporter: '氛围型',
    lurker: '旁观型',
    balanced: '均衡型'
  } as Record<string, string>,
  emotionLabels: {
    joy: '乐',
    like: '好',
    anger: '怒',
    sorrow: '哀',
    fear: '惧',
    disgust: '恶',
    surprise: '惊'
  } as Record<string, string>,
  topicLabels: {
    song: '点歌送歌',
    shopping: '带货购物',
    game: '游戏',
    question: '提问',
    urge: '催促点单',
    thanks: '致谢',
    praise: '赞美',
    cheer: '应援欢呼',
    pk: '连麦PK',
    talent: '才艺',
    farewell: '告别',
    greet: '打招呼',
    banter: '玩梗调侃',
    life: '生活碎聊',
    share: '分享闲谈',
    chat: '日常闲聊',
    mention: '点名回话',
    emoji: '表情'
  } as Record<string, string>,
  archetype: '行为原型',
  confidence: '置信度',
  traits: '六维行为特征',
  big5: '大五人格侧写（行为侧写，不是心理量表）',
  big5Top: '最突出维度',
  motivations: '动机结构（自我决定论）',
  motivationTop: '主导动机',
  chatStats: '弹幕文本分析',
  valence: '情绪效价(-100..100)',
  arousal: '情绪唤起度(0-100)',
  emotions: '七类情感构成(%)',
  topics: '内容主题构成(%)',
  keywords: '高频词',
  gifting: '送礼习惯',
  peakHour: '活跃高峰时段',
  giftPeak: '送礼高峰时段',
  networkOut: '他送礼最多的人',
  networkIn: '送礼给他最多的人',
  share: '占比',
  selfNote: '说明：'
}

/**
 * 英文那份：`typeof zh` 约束「键一致」（删键加键都编译报错）。
 * 这里刻意**不给 `zh` 加 `as const`**：加了会把每个值收窄成中文字面量，英文照着写就整份不兼容
 * （同 `main/tool-texts.ts` 的说明）——要约束的只是键，值本来就是另一种语言。
 */
const en: typeof zh = {
  roleViewer:
    'You are a data analyst for live-streaming operations, skilled at reading who a viewer is and why they stay from their interaction logs.',
  roleHost:
    'You are a data analyst for live-streaming operations, skilled at reading a streamer\u2019s style, how they keep people in the room, and where their revenue comes from.',
  taskViewer:
    'Write the most comprehensive, actionable viewer profile you can for this Douyin live-stream viewer, based only on the real data material below.',
  taskHost:
    'Write the most comprehensive, actionable **streamer** profile you can for this Douyin live-room / voice-room host, based only on the real data material below (analyse his own performance, do not treat him as a viewer).',
  rulesTitle: 'Hard requirements',
  rules: [
    'Use only the material. Do not add facts that are not present; do not guess real names, jobs, addresses or any real-world identity; no political, religious or medical judgements.',
    'Quotes must be **verbatim** from the "{{samples}}" section; if nothing fits, do not quote and do not invent a line that sounds like a comment.',
    'Every number must match the material (numbers are cumulative across all rooms; gift diamonds are platform virtual coins).',
    'Softly word anything the material cannot support (e.g. "based on the current sample") and state sample size and uncertainty honestly in caveats.',
    'Return **exactly one JSON object**: no markdown fences, no prose before or after, no comments.',
    'Write all copy in {{language}}.'
  ],
  rulesHostExtra:
    'The message samples are lines **he himself posted** in the room (this plugin records text messages only, never audio); do not mistake viewer messages for his performance. A voice room may have several hosts in one session \u2014 decide authorship by sender id and stay quiet when unsure.',
  shapeTitle: 'JSON shape (field names must match exactly)',
  shape: [
    '{',
    '  "persona": "{{persona}}",',
    '  "headline": "one-line profile, at most 40 characters",',
    '  "overview": "{{overview}}",',
    '  "tags": ["3-6 short tags"],',
    '  "sections": [',
    '    { "title": "section title", "items": ["one sentence each, numbers welcome"] }',
    '  ],',
    '  "evidence": [ { "quote": "verbatim quote or a concrete number", "note": "what it shows" } ],',
    '  "suggestions": ["{{suggestions}}"],',
    '  "caveats": ["data limits, small samples, uncertainty"]',
    '}'
  ],
  shapePersonaViewer: 'a short viewer type name you coin (e.g. "late-night companion")',
  shapePersonaHost: 'a short streamer type name you coin (e.g. "late-night song host", "chatterbox MC")',
  shapeOverviewViewer: 'overview in 2-4 sentences (who they are, why they come, relationship stage)',
  shapeOverviewHost: 'overview in 2-4 sentences (what he streams, his style, what stage he is at)',
  shapeSuggestionsViewer: 'actionable retention / interaction advice for the streamer or operator',
  shapeSuggestionsHost:
    'actionable advice addressed to this streamer: content and topics, scripting and crowd control, interaction and pacing, retention and conversion',
  samplesShortViewer: 'danmaku samples',
  samplesShortHost: 'message samples',
  sectionsHintViewer:
    'Cover angles like these in sections (2-5 items each, skip what the material cannot support): speaking style and language features / spending and gifting motives / social role and relationships / content interests / activity rhythm and visiting habits / relationship stage with the streamer / churn or upgrade signals.',
  sectionsHintHost:
    'Cover angles like these in sections (2-5 items each, skip what the material cannot support): streaming style and scripting / content and talent mix / how he interacts with viewers (call-outs, replies, crowd control) / retention and conversion tactics (follows, fan club, gifts) / revenue and gifting structure / co-hosting and peer relationships / schedule and per-session performance / growth or plateau signals.',
  sectionCount: 'Give 4-7 sections, 3-6 evidence items, 3-6 suggestions and 1-4 caveats.',
  refineTitle: 'This is an iteration (not a fresh start)',
  refine:
    'The previous version is below. Keep what still holds, make whatever the material supports more specific (finer behavioural evidence, clearer causality, more vivid wording), fold in anything new that the previous version missed, and correct anything the material contradicts. **Do not just rephrase the previous version.**',
  materialTitle: 'Material',
  materialNote:
    'Provenance: the cumulative numbers come from this plugin\u2019s per-user profile rows summed across rooms (written in batches), while the danmaku / sent-gift / received-gift samples are the raw message stream. The two can differ by a row or two while a batch is still settling; treat the stream as the raw source, and if you spot a discrepancy, state it plainly in caveats instead of inventing a reason.',
  identity: '1. Identity and accounts',
  totals: '2. Cumulative numbers across all rooms',
  behavior: '3. Interaction structure (share of the five interaction kinds)',
  algorithm: '4. Algorithmic facts (computed by deterministic rules — do not recompute, use them to interpret and corroborate)',
  rhythm: '5. Activity rhythm (24-hour distribution, local time)',
  rooms: '6. Rooms they appeared in (per room)',
  chatSamplesViewer: '7. Danmaku samples (latest %s, newest first, with timestamps)',
  chatSamplesHost: '7. Message samples he himself posted (latest %s, newest first, with timestamps)',
  sentGiftsViewer: '8. Gifts they sent (latest %s, newest first)',
  sentGiftsHost: '8. Gifts he sent out (latest %s, newest first)',
  receivedGiftsViewer: '9. Gifts they received (latest %s, newest first)',
  receivedGiftsHost: '9. Gifts he received (latest %s, newest first \u2014 this is his revenue)',
  network: '10. Relationship graph (top senders / recipients computed by the algorithm)',
  networkOutHost: 'people he gifts most (relationships he actively maintains)',
  networkInHost: 'people who gift him most (his main revenue source)',
  hostNote:
    'Role note: this material profiles the **streamer** himself \u2014 his messages are his work output and received gifts are his revenue. A voice room may host several streamers in one session, so do not attribute other hosts\u2019 or viewers\u2019 behaviour to him.',
  previous: '11. Previous version (v%s)',
  noData: '(none)',
  nickname: 'nickname',
  douyinId: 'douyin id',
  userId: 'user id',
  gender: 'gender',
  city: 'city',
  signature: 'bio',
  following: 'following',
  follower: 'followers',
  honor: 'honor level',
  fansClub: 'fan club level',
  badge: 'badges',
  firstSeen: 'first seen',
  lastSeen: 'last seen',
  activeDays: 'active days',
  spanDays: 'span (days)',
  chat: 'comments',
  enter: 'joins',
  like: 'likes',
  follow: 'follows',
  gift: 'gifts sent',
  sentDiamonds: 'diamonds sent',
  receivedDiamonds: 'diamonds received',
  roomCount: 'rooms seen in',
  avgGift: 'avg per gift (diamonds)',
  maxGift: 'largest single gift (diamonds)',
  giftDays: 'gift days',
  giftKinds: 'gift kinds',
  recipients: 'recipients',
  topGift: 'most sent gift',
  sessions: 'sessions',
  avgStay: 'avg stay (min)',
  maxStay: 'longest stay (min)',
  perSession: 'interactions per session',
  followDays: 'follow conversion (days, -1 = never followed)',
  hour: 'h',
  minutes: 'min',
  times: 'x',
  count: 'pcs',
  coins: 'coins',
  people: 'ppl',
  kindLabels: { chat: 'comments', member: 'joins', like: 'likes', social: 'follows', gift: 'gifts' },
  traitLabels: {
    spending: 'spending',
    activity: 'activity',
    sociability: 'sociability',
    loyalty: 'loyalty',
    emotion: 'emotional heat',
    identity: 'status signals'
  },
  big5Labels: {
    openness: 'openness',
    conscientiousness: 'conscientiousness',
    extraversion: 'extraversion',
    agreeableness: 'agreeableness',
    stability: 'emotional stability'
  },
  motivationLabels: {
    connection: 'social connection',
    identity: 'identity',
    interest: 'content interest',
    companionship: 'companionship habit'
  },
  archetypeLabels: {
    whale: 'big spender',
    socializer: 'socializer',
    loyalist: 'loyal fan',
    supporter: 'cheer squad',
    lurker: 'lurker',
    balanced: 'all-rounder'
  },
  emotionLabels: {
    joy: 'joy',
    like: 'liking',
    anger: 'anger',
    sorrow: 'sorrow',
    fear: 'fear',
    disgust: 'disgust',
    surprise: 'surprise'
  },
  topicLabels: {
    song: 'song requests',
    shopping: 'shopping',
    game: 'gaming',
    question: 'questions',
    urge: 'urging',
    thanks: 'thanks',
    praise: 'praise',
    cheer: 'cheering',
    pk: 'PK / co-host',
    talent: 'performance',
    farewell: 'goodbyes',
    greet: 'greetings',
    banter: 'banter',
    life: 'daily life',
    share: 'small talk',
    chat: 'chit-chat',
    mention: 'at-mentions',
    emoji: 'emoji'
  },
  archetype: 'behaviour archetype',
  confidence: 'confidence',
  traits: 'six behavioural traits',
  big5: 'Big Five behavioural proxy (not a psychometric test)',
  big5Top: 'most salient dimension',
  motivations: 'motivation structure (self-determination theory)',
  motivationTop: 'dominant motive',
  chatStats: 'danmaku text analysis',
  valence: 'emotional valence (-100..100)',
  arousal: 'emotional arousal (0-100)',
  emotions: 'seven emotions (%)',
  topics: 'content topics (%)',
  keywords: 'top words',
  gifting: 'gifting habits',
  peakHour: 'peak activity hour',
  giftPeak: 'peak gifting hour',
  networkOut: 'people he sends gifts to',
  networkIn: 'people who send gifts to him',
  share: 'share',
  selfNote: 'note: '
}

/** 语言 → 文案（界面语言不是中文时一律走英文那份，别混排） */
function labelsFor(language: string): typeof zh {
  return String(language ?? '').toLowerCase().startsWith('zh') ? zh : en
}

/** 给人看的语言名（写进提示词的「全部文案用 X 书写」） */
function languageName(language: string): string {
  return String(language ?? '').toLowerCase().startsWith('zh') ? '简体中文' : 'English'
}

/* ------------------------------------------------------------------------- 工具 */

/** ms → `YYYY-MM-DD HH:mm`（本地时区；材料里的时间必须是模型能直接读懂的样子） */
export function stamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** 大数字折成「万 / k」：材料要读得动，别塞一串 0 */
function compact(value: number): string {
  const number = Number.isFinite(value) ? Math.round(value) : 0
  if (Math.abs(number) >= 10000) return `${(number / 10000).toFixed(1)}万`
  return String(number)
}

/** `标签 值` 一行（材料里的「点号短句」，与界面上的 FactLine 同款观感） */
function facts(items: Array<[string, string | number]>): string {
  return items
    .map(([label, value]) => {
      const text = typeof value === 'number' ? compact(value) : String(value ?? '').trim()
      return text && text !== '—' ? `${label} ${text}` : ''
    })
    .filter((item) => item.length > 0)
    .join(' · ')
}

/* ------------------------------------------------------------------------- 输入 */

/** 一个人的账号（画像里绑定的全部抖音号；没绑定就是一个） */
export interface PortraitAccount {
  userId: string
  nickname: string
  displayId: string
  chat: number
  enter: number
  gift: number
}

/** 画像弹窗里那个人的身份块（`UserIdentity` 的裁剪版） */
export interface PortraitIdentity {
  identityId: number
  /** 用户改过的画像名（空 = 用主账号昵称） */
  name: string
  primaryUserId: string
  accounts: PortraitAccount[]
}

/** 跨房间累计（与 `userProfile` 的 `stats` 同源） */
export interface PortraitTotals {
  chat: number
  enter: number
  like: number
  follow: number
  gift: number
  diamonds: number
  receivedDiamonds: number
  firstSeen: number
  lastSeen: number
}

/** 上一版画像（迭代生成时的输入） */
export interface PortraitPrevious {
  version: number
  generatedAt: number
  report: AiPortraitReport | null
  raw: string
}

export interface PortraitEvidenceInput {
  /** 弹窗上的那个人（锚点） */
  anchor: { userId: string; name: string }
  /**
   * 这一版要分析的角色（观众 / 主播）。
   *
   * 用户 2026-10-13：「应该是分析主播…和用户，两者分开」——同一个人两种角色的材料侧重、
   * 提问角度与建议对象都不一样，所以角色是**输入的一部分**，不是渲染层换个标题的事。
   */
  role: AiPortraitRole
  identity: PortraitIdentity | null
  /** 档案（昵称/地区/签名/等级…；拿不到就是 null） */
  profile: Pick<
    UserDetail,
    | 'nickname'
    | 'displayId'
    | 'gender'
    | 'city'
    | 'signature'
    | 'following'
    | 'follower'
    | 'honorLevel'
    | 'fansClubLevel'
    | 'badges'
  > | null
  totals: PortraitTotals
  /**
   * 24 小时活跃分布（跨房间，本地时区；来自 `UserAnalysisData.hours`）。
   * `UserAnalysis` 只带礼物时段（`gifting.hours`），活跃时段要调用方把原始桶一起递进来。
   */
  activityHours: number[]
  /** 确定性画像（算法层事实） */
  analysis: UserAnalysis
  /** 原始层材料（按房间摊开 + 带时间戳的流水样本） */
  extras: UserPortraitExtras
  previous: PortraitPrevious | null
  /** 界面语言（决定提示词与输出语言） */
  language: string
  /** 现在（材料开头会写上这个时刻，模型才知道「最近出现」有多近） */
  now: number
  /** 这一版是第几版（写进材料头，让模型知道自己是在迭代还是要从头写） */
  version?: number
}

export interface PortraitPrompt {
  system: string
  user: string
  /** 「数据有没有变」的判据（生成当时的快照） */
  fingerprint: string
  /** 生成时的互动总量（界面据此说「基于 N 条互动」） */
  interactions: number
  /** 材料规模（成本观测：工装直接断言它不超过预算） */
  chars: { system: number; user: number; total: number }
}

/* --------------------------------------------------------------------- 提示词 */

/**
 * 打包证据 + 拼提示词。
 *
 * 材料是**分节纯文本**（不是 JSON）：模型读 markdown 式分节比读一大坨 JSON 更稳，
 * 而且人（排查时）也能一眼看出「模型当时到底看到了什么」——出问题时这是唯一能复盘的东西。
 */
export function buildPortraitPrompt(input: PortraitEvidenceInput): PortraitPrompt {
  const t = labelsFor(input.language)
  const host = input.role === 'host'
  const roleText = host ? t.roleHost : t.roleViewer
  const taskText = host ? t.taskHost : t.taskViewer
  const sectionsHint = host ? t.sectionsHintHost : t.sectionsHintViewer
  const samplesShort = host ? t.samplesShortHost : t.samplesShortViewer
  const chatSamplesTitle = host ? t.chatSamplesHost : t.chatSamplesViewer
  const sentGiftsTitle = host ? t.sentGiftsHost : t.sentGiftsViewer
  const receivedGiftsTitle = host ? t.receivedGiftsHost : t.receivedGiftsViewer
  const networkOutLabel = host ? t.networkOutHost : t.networkOut
  const networkInLabel = host ? t.networkInHost : t.networkIn
  const a = input.analysis
  const factsOf = a.facts
  const lines: string[] = []

  /* 材料头：模型要知道「现在是什么时候」（否则它没法把「最近出现」读成「三天前还是三个月前」） */
  lines.push(
    `材料生成时间：${stamp(input.now)}` +
      (input.version && input.version > 1 ? `　·　这是第 ${input.version} 版画像` : '')
  )

  /* 一、身份与账号 */
  lines.push(`## ${t.identity}`)
  const profile = input.profile
  lines.push(
    facts([
      [t.nickname, input.anchor.name || profile?.nickname || '—'],
      [t.userId, rawIdOf(input.anchor.userId)],
      [t.douyinId, profile?.displayId ?? ''],
      [t.city, profile?.city ?? ''],
      [t.honor, profile?.honorLevel ?? 0],
      [t.fansClub, profile?.fansClubLevel ?? 0]
    ])
  )
  if (profile?.signature) lines.push(`${t.signature}: ${profile.signature}`)
  const accounts = input.identity?.accounts ?? []
  if (accounts.length > 1) {
    lines.push(
      `绑定的账号（同一个人，共 ${accounts.length} 个）：` +
        accounts
          .map(
            (account) =>
              `${account.nickname || rawIdOf(account.userId)}（${rawIdOf(account.userId)}：${t.chat} ${compact(account.chat)} · ${t.enter} ${compact(account.enter)} · ${t.gift} ${compact(account.gift)}）`
          )
          .join('；')
    )
  }
  if (input.identity?.name) lines.push(`画像名（他自己/运营起的）：${input.identity.name}`)

  /* 二、累计数据 */
  lines.push('', `## ${t.totals}`)
  const totals = input.totals
  const activeDays = a.facts.activeDays
  lines.push(
    facts([
      [t.chat, totals.chat],
      [t.enter, totals.enter],
      [t.like, totals.like],
      [t.follow, totals.follow],
      [t.gift, totals.gift],
      [t.sentDiamonds, totals.diamonds],
      [t.receivedDiamonds, totals.receivedDiamonds],
      [t.roomCount, input.extras.rooms.length],
      [t.activeDays, activeDays],
      [t.firstSeen, stamp(input.extras.firstSeen || totals.firstSeen)],
      [t.lastSeen, stamp(input.extras.lastSeen || totals.lastSeen)]
    ])
  )
  lines.push(
    facts([
      [t.avgGift, factsOf.avgGift],
      [t.maxGift, a.gifting.maxGift],
      [t.giftDays, a.gifting.giftDays],
      [t.giftKinds, factsOf.giftKinds],
      [t.recipients, factsOf.recipients],
      [t.topGift, factsOf.topGiftName ? `${factsOf.topGiftName} ×${factsOf.topGiftCount}` : '—']
    ])
  )

  /* 三、互动结构 */
  lines.push('', `## ${t.behavior}`)
  lines.push(
    a.behavior.kinds
      .filter((item) => item.score > 0)
      .map((item) => `${t.kindLabels[item.key] ?? item.key} ${item.score}%`)
      .join(' · ') || t.noData
  )
  lines.push(
    facts([
      [t.sessions, a.behavior.sessions],
      [t.avgStay, a.behavior.avgStayMinutes],
      [t.maxStay, a.behavior.maxStayMinutes],
      [t.perSession, a.behavior.perSession],
      [t.followDays, a.behavior.followDays]
    ])
  )

  /* 四、算法层事实 */
  lines.push('', `## ${t.algorithm}`)
  const archetype = a.archetypes[0]
  lines.push(
    `${t.archetype}: ${t.archetypeLabels[a.archetype] ?? a.archetype}（${t.confidence} ${a.confidence}%）` +
      (archetype && archetype.key !== a.archetype
        ? `；次高：${t.archetypeLabels[archetype.key] ?? archetype.key} ${archetype.score}%`
        : '')
  )
  lines.push(
    `${t.traits}: ` +
      a.traits.map((item) => `${t.traitLabels[item.key] ?? item.key} ${item.score}`).join(' · ')
  )
  lines.push(
    `${t.big5}: ` +
      a.personality.map((item) => `${t.big5Labels[item.key] ?? item.key} ${item.score}`).join(' · ') +
      (a.personalityTop ? `（${t.big5Top}: ${t.big5Labels[a.personalityTop] ?? a.personalityTop}）` : '')
  )
  lines.push(
    `${t.motivations}: ` +
      a.motivations.map((item) => `${t.motivationLabels[item.key] ?? item.key} ${item.score}`).join(' · ') +
      (a.motivationTop ? `（${t.motivationTop}: ${t.motivationLabels[a.motivationTop] ?? a.motivationTop}）` : '')
  )
  lines.push(
    `${t.chatStats}: ${t.valence} ${a.chat.valence} · ${t.arousal} ${a.chat.arousal} · 样本 ${a.chat.sampleCount} 条 · ` +
      `平均 ${a.chat.avgLength} 字 · 表情 ${a.chat.emojiRate}% · @点名 ${a.chat.mentionRate}% · 疑问 ${a.chat.questionRate}% · 感叹 ${a.chat.exclaimRate}% · 重复 ${a.chat.repeatRate}%`
  )
  const emotions = a.chat.emotions.filter((item) => item.score > 0)
  if (emotions.length > 0) {
    lines.push(
      `${t.emotions}: ` + emotions.map((item) => `${t.emotionLabels[item.key] ?? item.key} ${item.score}`).join(' · ')
    )
  }
  const topics = a.chat.topics.filter((item) => item.score > 0)
  if (topics.length > 0) {
    lines.push(
      `${t.topics}: ` + topics.map((item) => `${t.topicLabels[item.key] ?? item.key} ${item.score}`).join(' · ')
    )
  }
  if (a.chat.keywords.length > 0) lines.push(`${t.keywords}: ${a.chat.keywords.join(' / ')}`)
  lines.push(
    `${t.gifting}: ${t.giftDays} ${a.gifting.giftDays} · 每天 ${a.gifting.perDay} ${t.times} · 单笔最大 ${compact(a.gifting.maxGift)} · 最常送占 ${a.gifting.topGiftShare}% · ${t.recipients} ${a.gifting.recipients}`
  )
  lines.push(
    `${t.peakHour}: ${hourText(a.facts.peakHour)} · ${t.giftPeak}: ${hourText(a.gifting.peakHour)}`
  )

  /* 五、活跃节律 */
  lines.push('', `## ${t.rhythm}`)
  lines.push(hourHistogram(input.activityHours, t))
  const giftHours = a.gifting.hours.some((value) => value > 0) ? a.gifting.hours : []
  if (giftHours.length > 0) lines.push(`${t.giftPeak} 分布：${hourHistogram(giftHours, t, false)}`)

  /* 六、按房间摊开 */
  lines.push('', `## ${t.rooms}`)
  if (input.extras.rooms.length === 0) {
    lines.push(t.noData)
  } else {
    for (const room of input.extras.rooms) {
      const name = room.title ? `${room.title}（${room.webRid}）` : room.webRid
      lines.push(
        `- ${name}：${t.chat} ${compact(room.chat)} · ${t.enter} ${compact(room.enter)} · ${t.like} ${compact(room.likes)} · ${t.follow} ${compact(room.follows)} · ${t.gift} ${compact(room.gift)}（${compact(room.diamonds)} ${t.coins}）· ${t.receivedDiamonds} ${compact(room.receivedDiamonds)} · ${stamp(room.firstSeen)} → ${stamp(room.lastSeen)}`
      )
    }
  }

  /* 七、弹幕样本（主播视角下这是他自己的发言记录） */
  lines.push('', `## ${chatSamplesTitle.replace('%s', String(input.extras.recentChat.length))}`)
  if (input.extras.recentChat.length === 0) {
    lines.push(t.noData)
  } else {
    for (const item of input.extras.recentChat) {
      lines.push(`- [${stamp(item.atMs)}] ${squash(item.content)}`)
    }
  }

  /* 八、送礼流水 */
  lines.push('', `## ${sentGiftsTitle.replace('%s', String(input.extras.sentGifts.length))}`)
  if (input.extras.sentGifts.length === 0) {
    lines.push(t.noData)
  } else {
    for (const item of input.extras.sentGifts) {
      lines.push(
        `- [${stamp(item.atMs)}] ${squash(item.content) || '礼物'} ×${item.count > 0 ? item.count : 1}` +
          (item.diamonds > 0 ? `（${compact(item.diamonds)} ${t.coins}）` : '（单价未知）') +
          (item.counterpart ? ` → ${squash(item.counterpart)}` : '')
      )
    }
  }

  /* 九、收礼流水 */
  lines.push('', `## ${receivedGiftsTitle.replace('%s', String(input.extras.receivedGifts.length))}`)
  if (input.extras.receivedGifts.length === 0) {
    lines.push(t.noData)
  } else {
    for (const item of input.extras.receivedGifts) {
      lines.push(
        `- [${stamp(item.atMs)}] ${squash(item.content) || '礼物'} ×${item.count > 0 ? item.count : 1}` +
          (item.diamonds > 0 ? `（${compact(item.diamonds)} ${t.coins}）` : '') +
          (item.counterpart ? ` ← ${squash(item.counterpart)}` : '')
      )
    }
  }

  /* 十、关系网 */
  lines.push('', `## ${t.network}`)
  const outNet = a.network.outgoing.slice(0, 6)
  const inNet = a.network.incoming.slice(0, 6)
  if (outNet.length > 0) {
    lines.push(
      `${networkOutLabel}: ` +
        outNet
          .map((peer) => `${peer.name} ${compact(peer.diamonds)}${peer.diamonds > 0 ? ` ${t.coins}` : ` ${t.count}`}（${t.share} ${peer.share}%）`)
          .join(' · ')
    )
  }
  if (inNet.length > 0) {
    lines.push(
      `${networkInLabel}: ` +
        inNet
          .map((peer) => `${peer.name} ${compact(peer.diamonds)}${peer.diamonds > 0 ? ` ${t.coins}` : ` ${t.count}`}（${t.share} ${peer.share}%）`)
          .join(' · ')
    )
  }
  if (outNet.length === 0 && inNet.length === 0) lines.push(t.noData)

  const material = lines.join('\n')

  /* 十一段：上一版画像（迭代时） */
  const shapeText = t.shape
    .map((line) =>
      line
        .replace('{{persona}}', host ? t.shapePersonaHost : t.shapePersonaViewer)
        .replace('{{overview}}', host ? t.shapeOverviewHost : t.shapeOverviewViewer)
        .replace('{{suggestions}}', host ? t.shapeSuggestionsHost : t.shapeSuggestionsViewer)
    )
    .join('\n')
  const rules = (host ? [...t.rules, t.rulesHostExtra] : t.rules).map((rule, index) =>
    `${index + 1}. ${rule.replace('{{language}}', languageName(input.language)).replace('{{samples}}', samplesShort)}`
  )
  const header: string[] = [
    roleText,
    '',
    taskText,
    '',
    `### ${t.rulesTitle}`,
    ...rules,
    '',
    `### ${t.shapeTitle}`,
    '```',
    shapeText,
    '```',
    sectionsHint,
    t.sectionCount
  ]
  if (input.previous && (input.previous.raw || input.previous.report)) {
    header.push('', `### ${t.refineTitle}`, t.refine)
  }
  header.push('', `### ${t.materialTitle}`, t.materialNote)
  if (host) header.push(t.hostNote)
  header.push(material)

  const previousText = input.previous ? previousBlock(t, input.previous) : ''
  const user = previousText ? `${header.join('\n')}\n\n${previousText}` : header.join('\n')
  const system = `${roleText}\n${t.sectionCount}`

  const interactions = portraitInteractions({
    chat: totals.chat,
    enter: totals.enter,
    like: totals.like,
    follow: totals.follow,
    gift: totals.gift,
    diamonds: totals.diamonds,
    lastSeen: input.extras.lastSeen || totals.lastSeen
  })
  const fingerprint = portraitFingerprint({
    chat: totals.chat,
    enter: totals.enter,
    like: totals.like,
    follow: totals.follow,
    gift: totals.gift,
    diamonds: totals.diamonds,
    lastSeen: input.extras.lastSeen || totals.lastSeen
  })

  return {
    system,
    user,
    fingerprint,
    interactions,
    chars: {
      system: system.length,
      user: user.length,
      total: system.length + user.length
    }
  }
}

/**
 * 24 小时分布：一行紧凑直方图（8 档方块）+ 四个时段的占比。
 *
 * 为什么给直方图而不是只给「高峰 22 点」：模型要能看出「他只在深夜来、一来就待很久」这类
 * **形状**，一个高峰小时是看不出形状的；而方块图只占一行 token，成本可以忽略。
 */
function hourHistogram(hours: number[], t: typeof zh, withParts = true): string {
  const buckets = Array.isArray(hours) && hours.length === 24 ? hours.map((value) => Math.max(0, Number(value) || 0)) : []
  if (buckets.length === 0) return t.noData
  const total = buckets.reduce((acc, value) => acc + value, 0)
  if (total <= 0) return t.noData
  const blocks = '▁▂▃▄▅▆▇█'
  const max = Math.max(...buckets)
  const bar = buckets
    .map((value) => blocks[Math.min(blocks.length - 1, Math.round((value / max) * (blocks.length - 1)))])
    .join('')
  const share = (from: number, to: number): number =>
    Math.round((buckets.slice(from, to).reduce((acc, value) => acc + value, 0) / total) * 100)
  if (!withParts) return bar
  return (
    `${bar}（0 → 23 ${t.hour}）· 凌晨 ${share(0, 6)}% · 上午 ${share(6, 12)}% · ` +
    `下午 ${share(12, 18)}% · 晚上 ${share(18, 24)}%`
  )
}

/** 上一版画像块（JSON 优先：模型读结构化内容最省 token，也最不容易误解） */
function previousBlock(t: typeof zh, previous: PortraitPrevious): string {
  const title = `## ${t.previous.replace('%s', String(previous.version))}`
  const body = previous.report
    ? JSON.stringify(previous.report, null, 1)
    : squash(previous.raw).slice(0, 4000)
  return `${title}\n生成于 ${stamp(previous.generatedAt)}\n\`\`\`json\n${body}\n\`\`\``
}

/** 单行化（材料里每条流水必须占一行：模型靠行来引用原话） */
function squash(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** 小时 → `22:00`（-1 = 没有） */
function hourText(hour: number): string {
  return hour >= 0 ? `${String(hour).padStart(2, '0')}:00` : '—'
}

/**
 * 用户 id 脱壳：匿名的人内部键是 `anon:111111#dou2056511` 这种，材料里给**抖音 id**，
 * 免得模型把内部键当成真实账号（也免得它去猜那串前缀是什么意思）。
 */
function rawIdOf(userId: string): string {
  const text = String(userId ?? '')
  const hash = text.lastIndexOf('#')
  if (text.startsWith('anon:') && hash > 0) return text.slice(hash + 1)
  return text
}

/** 设置里「AI 画像模型」的默认值（null = 跟随宿主默认模型） */
export function portraitProviderSetting(settings: Pick<LiveSettings, 'portraitProviderId'>): number | null {
  const value = settings?.portraitProviderId
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}
