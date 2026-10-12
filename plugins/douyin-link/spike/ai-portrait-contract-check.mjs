/**
 * 离线契约验证：**AI 画像的提示词与解析**（不连库、不连网、不花钱）。
 *
 * 为什么要这个工装：这个功能里唯一「说错话就全错」的地方就是**材料**与**解析**这两段纯逻辑——
 * 材料漏了 → 模型编；材料脏了 → 结论歪；解析脆弱 → 用户花掉的 token 白费（模型明明写了，
 * 界面却解析不出来）。两段都是纯函数，所以可以在这里逐条钉死：
 *
 * 1. **材料真的带上了**：身份 / 累计 / 互动结构 / 算法层事实 / 节律 / 按房间 / 弹幕样本 /
 *    送礼 / 收礼 / 关系网，且数字与样本**逐字**来自输入（不是另算一套）；
 * 2. **引用是可行的**：每一条弹幕样本都逐字出现在材料里（提示词要求模型「引用必须逐字」，
 *    材料里没有的东西它引不出来）；
 * 3. **匿名内部键脱壳**：`anon:111111#dou2056511` 在材料里只出现抖音 id；
 * 4. **两种语言**：中文界面出中文材料与中文指令，英文界面出英文（键逐一对齐）；
 * 5. **解析容错**：围栏 JSON、前后带客套话、字符串里含花括号（弹幕 `{笑}`）、中文键名、
 *    缺字段、彻底坏掉——六种形态都要有确定结果；
 * 6. **流式半成品**：写到一半时只认**已闭合**的字段，最后那个没写完的分节不许露头，
 *    而且后面的字段不许被前一个数组吞掉；
 * 7. **成本**：材料字符数（≈ token 预算）打出来，并断言不超过上限；
 * 8. **观众 / 主播两套**（用户 2026-10-13：「应该是分析主播（个播、房间播有好多主播的）和用户，
 *    两者分开，现在都是按照用户的内容进行分析了」）：同一份数据换角色，**提问、分节标题、
 *    建议对象都要跟着换**，而事实层（数字、样本）一个字都不能变；缓存键也要按角色分开。
 *
 * 跑法（仓库根目录；本工装直接编源码，不需要先 build）：
 *   node plugins/douyin-link/spike/ai-portrait-contract-check.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../../../')
const PLUGIN = join(HERE, '..')

/* --------------------------------------------------- 把纯模块编出来（源码是真源） */

const workDir = mkdtempSync(join(tmpdir(), 'douyin-ai-contract-'))
writeFileSync(
  join(workDir, 'entry.ts'),
  `export { buildPortraitPrompt, portraitProviderSetting } from ${JSON.stringify(join(PLUGIN, 'main/analysis/ai-evidence.ts'))}\n` +
    `export { buildUserAnalysis } from ${JSON.stringify(join(PLUGIN, 'main/analysis/portrait.ts'))}\n` +
    `export { buildRoomContext } from ${JSON.stringify(join(PLUGIN, 'main/analysis/context.ts'))}\n` +
    `export * from ${JSON.stringify(join(PLUGIN, 'shared/ai-portrait.ts'))}\n`,
  'utf8'
)
const outfile = join(workDir, 'pure.mjs')
await build({
  entryPoints: [join(workDir, 'entry.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'warning'
})
const pure = await import(pathToFileURL(outfile).href)

const {
  buildPortraitPrompt,
  buildUserAnalysis,
  buildRoomContext,
  portraitKeyOf,
  portraitFingerprint,
  portraitInteractions,
  parsePortraitReport,
  partialPortraitReport,
  normalizePortraitReport,
  extractJsonObject,
  reportToMarkdown,
  PORTRAIT_LIMITS,
  portraitProviderSetting
} = pure

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : `\n       ${detail}`}`)
}
const eq = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(label, ok, `期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}`)
}
const has = (label, haystack, needle) =>
  check(label, String(haystack).includes(needle), `材料里找不到：${JSON.stringify(needle)}`)
/** 否定断言单独一枚：`check(label, 条件)` 里的条件**必须是「通过时为真」**，写成 includes 会反向 */
const not = (label, haystack, needle) =>
  check(label, !String(haystack).includes(needle), `不该出现却出现了：${JSON.stringify(needle)}`)

/* ------------------------------------------------------------------- 工装数据 */

const NOW = new Date(2026, 9, 13, 21, 30).getTime()
const DAY = 86400000
const ROOM = '880000000001'

/** 一个「像真的」的人：聊得多、爱看才艺、夜里来、给主播送过礼（跨两个直播间） */
function fixtureData() {
  const chatTexts = [
    '[比心] 今晚唱得太好听了',
    '主播吃晚饭了吗，别饿着',
    '点一首《太聪明》可以吗？',
    '哈哈哈哈哈笑死我了',
    '这个高音绝了',
    '我下班了，刚到家',
    '明天还播吗',
    '666 冲',
    '来了来了',
    '生日蛋糕送上',
    '谁在麦上啊',
    '@工装主播 记得喝水',
    '这歌我听了三年了',
    '谢谢主播唱我点的歌',
    '有点emo了今天'
  ]
  return {
    chat: 42,
    enter: 9,
    likes: 120,
    follows: 1,
    gift: 6,
    diamonds: 3200,
    firstSeen: NOW - 26 * DAY,
    lastSeen: NOW - 2 * 3600000,
    hours: Array.from({ length: 24 }, (_v, hour) => (hour >= 20 && hour <= 23 ? 8 - (hour - 20) : hour < 2 ? 2 : 0)),
    activeDays: 11,
    giftKinds: 3,
    topGiftName: '比心',
    topGiftCount: 12,
    topGiftDiamonds: 1200,
    recipients: 2,
    honorLevel: 12,
    fansClubLevel: 8,
    chatTexts,
    giftHours: Array.from({ length: 24 }, (_v, hour) => (hour === 21 ? 4 : hour === 22 ? 2 : 0)),
    giftDays: 4,
    giftMax: 1200,
    giftFirstAt: NOW - 20 * DAY,
    giftLastAt: NOW - 3 * DAY,
    outEdges: [
      { userId: '9001', name: '工装主播', diamonds: 2800, items: 14, hits: 5, lastAt: NOW - 3 * DAY },
      { userId: '9002', name: '另一个主播', diamonds: 400, items: 2, hits: 1, lastAt: NOW - 9 * DAY }
    ],
    inEdges: [{ userId: '9100', name: '送礼的人', diamonds: 500, items: 2, hits: 1, lastAt: NOW - 5 * DAY }],
    sessions: 7,
    sessionSpans: [12 * 60000, 40 * 60000, 75 * 60000, 5 * 60000, 30 * 60000, 60 * 60000, 20 * 60000],
    firstFollowAt: NOW - 18 * DAY
  }
}

function fixtureExtras() {
  const chat = [
    '[比心] 今晚唱得太好听了',
    '点一首《太聪明》可以吗？',
    '哈哈哈哈哈笑死我了',
    '谁在麦上啊',
    '@工装主播 记得喝水'
  ]
  return {
    rooms: [
      {
        webRid: ROOM,
        title: '深夜电台',
        chat: 36,
        enter: 8,
        likes: 110,
        follows: 1,
        gift: 5,
        diamonds: 3000,
        receivedDiamonds: 0,
        firstSeen: NOW - 26 * DAY,
        lastSeen: NOW - 2 * 3600000
      },
      {
        webRid: '880000000002',
        title: '才艺厅',
        chat: 6,
        enter: 1,
        likes: 10,
        follows: 0,
        gift: 1,
        diamonds: 200,
        receivedDiamonds: 500,
        firstSeen: NOW - 9 * DAY,
        lastSeen: NOW - 9 * DAY
      }
    ],
    recentChat: chat.map((content, index) => ({
      atMs: NOW - (index + 1) * 90000,
      webRid: ROOM,
      content,
      count: 0,
      diamonds: 0,
      counterpart: ''
    })),
    sentGifts: [
      { atMs: NOW - 3 * DAY, webRid: ROOM, content: '比心', count: 5, diamonds: 500, counterpart: '工装主播' },
      { atMs: NOW - 9 * DAY, webRid: '880000000002', content: '小心心', count: 2, diamonds: 200, counterpart: '另一个主播' }
    ],
    receivedGifts: [
      { atMs: NOW - 5 * DAY, webRid: '880000000002', content: '大啤酒', count: 2, diamonds: 500, counterpart: '送礼的人' }
    ],
    sentDiamonds: 3200,
    receivedDiamonds: 500,
    firstSeen: NOW - 26 * DAY,
    lastSeen: NOW - 2 * 3600000
  }
}

function fixtureContext() {
  const self = 'anon:111111#dou2056511'
  const rows = [
    { atMs: NOW - 2 * 3600000 - 300000, webRid: ROOM, userId: 'x1', userName: '路过的老王', content: '主播今天嗓子有点哑，注意休息' },
    { atMs: NOW - 2 * 3600000 - 240000, webRid: ROOM, userId: 'x2', userName: '小美', content: '这首歌我也好喜欢' },
    { atMs: NOW - 2 * 3600000 - 120000, webRid: ROOM, userId: self, userName: '夜猫子小张', content: '今晚唱得太好听了' },
    { atMs: NOW - 2 * 3600000 - 90000, webRid: ROOM, userId: 'x3', userName: '阿强', content: '点一首《太聪明》行吗' },
    { atMs: NOW - 2 * 3600000 - 60000, webRid: ROOM, userId: 'x1', userName: '路过的老王', content: '666' },
    { atMs: NOW - 2 * 3600000 - 30000, webRid: ROOM, userId: 'x4', userName: '夜宵摊', content: '每天这个点都来听，习惯了' }
  ]
  return buildRoomContext({
    windows: [{ webRid: ROOM, title: '深夜电台', start: NOW - 3 * 3600000, end: NOW - 3600000 }],
    rows,
    selfIds: [self],
    sampleBudget: 60
  })
}

function fixturePrompt(overrides = {}) {
  const data = fixtureData()
  return buildPortraitPrompt({
    anchor: { userId: 'anon:111111#dou2056511', name: '夜猫子小张' },
    role: 'viewer',
    identity: {
      identityId: 7,
      name: '',
      primaryUserId: '2056511',
      accounts: [
        { userId: '2056511', nickname: '夜猫子小张', displayId: 'zhang_2026', chat: 30, enter: 6, gift: 4 },
        { userId: '2056512', nickname: '小张的小号', displayId: '', chat: 12, enter: 3, gift: 2 }
      ]
    },
    profile: {
      nickname: '夜猫子小张',
      displayId: 'zhang_2026',
      gender: 1,
      city: '杭州',
      signature: '只听歌不说话',
      following: 320,
      follower: 45,
      honorLevel: 12,
      fansClubLevel: 8,
      badges: ['忠实粉丝']
    },
    totals: {
      chat: 42,
      enter: 9,
      like: 120,
      follow: 1,
      gift: 6,
      diamonds: 3200,
      receivedDiamonds: 500,
      firstSeen: NOW - 26 * DAY,
      lastSeen: NOW - 2 * 3600000
    },
    activityHours: data.hours,
    analysis: buildUserAnalysis(data, NOW),
    extras: fixtureExtras(),
    context: fixtureContext(),
    previous: null,
    language: 'zh-CN',
    now: NOW,
    version: 1,
    ...overrides
  })
}

/* ------------------------------------------------------ 1. 材料带全了吗、对不对 */

console.log('=== 1. 材料（模型看到的东西）')
const prompt = fixturePrompt()
const material = prompt.user
check('system 里有角色设定', prompt.system.length > 0)
check('材料有 11+ 个分节', (material.match(/\n## /g) ?? []).length >= 11)
for (const heading of [
  '一、身份与账号',
  '二、跨全部直播间的累计数据',
  '三、互动结构',
  '四、算法层事实',
  '五、活跃节律',
  '六、出现过的直播间',
  '七、房间上下文',
  '八、弹幕样本',
  '九、送礼流水',
  '十、收礼流水',
  '十一、人物关系网'
]) {
  has(`材料含「${heading}」`, material, heading)
}
has('材料头写了「现在」是什么时候', material, '材料生成时间：2026-10-13 21:30')
has('写清了两层数据的口径（累计 vs 流水），避免模型自己编原因', material, '以流水为准')
has('昵称带上', material, '昵称 夜猫子小张')
has('抖音号带上', material, '抖音号 zhang_2026')
has('地区带上', material, '地区 杭州')
has('签名带上', material, '签名: 只听歌不说话')
has('绑定账号逐条列出（同一个人两个号）', material, '同一个人，共 2 个')
has('累计互动数带上', material, '弹幕 42')
has('送出抖币带上', material, '送出抖币 3200')
has('收到抖币带上', material, '收到抖币 500')
has('算法层：行为原型', material, '行为原型')
has('算法层：大五侧写（并写明不是量表）', material, '大五人格侧写（行为侧写，不是心理量表）')
has('算法层：动机结构', material, '动机结构（自我决定论）')
has('算法层：七类情感构成', material, '七类情感构成')
check(
  '节律：24 小时直方图（8 档方块 + 四个时段占比）',
  /（0 → 23 点）· 凌晨 \d+% · 上午 \d+% · 下午 \d+% · 晚上 \d+%/.test(material),
  material.split('\n').find((line) => line.includes('0 → 23')) ?? '(没有那一行)'
)
has('按房间摊开：房间名 + 房间号', material, '深夜电台（880000000001）')
has('按房间摊开：第二个房间也在', material, '才艺厅（880000000002）')
has('送礼流水带礼物名与对方', material, '比心 ×5（500 抖币） → 工装主播')
has('收礼流水带来源', material, '大啤酒 ×2（500 抖币） ← 送礼的人')
has('关系网：送礼最多的人', material, '他送礼最多的人: 工装主播')

console.log('\n=== 1b. 房间上下文（个播主播不说话时的另一半材料）')
has('观察窗写出来（房间名 + 房间号 + 起止）', material, '观察窗: 深夜电台（880000000001')
has('房间整体统计（原始条数 + 说话人数）', material, '房间整体 6 弹幕')
has('房间基线（情绪 / 唤起 / 字数 / 表情）', material, '房间基线')
has('发言最多的人排行', material, '发言最多的人: 路过的老王 2')
has('写清压缩比（原始 → 去重 → 抽样）', material, '代表性弹幕（6 → 6 → 6）')
has('代表弹幕带作者名（不是本人也会标出来）', material, '路过的老王: 主播今天嗓子有点哑，注意休息')
has('本人发言标 ★', material, '★ 夜猫子小张: 今晚唱得太好听了')
not('房间上下文里不泄露匿名内部键', material, 'anon:')

console.log('\n=== 2. 引用可行性：每条弹幕样本都逐字在材料里（含时间）')
for (const row of fixtureExtras().recentChat) {
  const stampText = (() => {
    const date = new Date(row.atMs)
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  })()
  has(`样本「${row.content}」逐字在材料里`, material, `- [${stampText}] ${row.content}`)
}

console.log('\n=== 3. 匿名内部键脱壳 + 不泄露内部前缀')
not('材料里没有 anon: 前缀', material, 'anon:')
has('用的是抖音 id（脱壳后的尾段）', material, '用户 id dou2056511')
has('绑定账号那一行也是脱壳后的 id', material, '（2056512：弹幕 12')

console.log('\n=== 4. 提示词纪律')
has('要求只回一个 JSON 对象', material, '输出**只有一个 JSON 对象**')
has('要求引用逐字取自弹幕样本', material, '取自「弹幕样本」')
has('不许猜现实身份', material, '不要猜测真实姓名')
has('数字必须与材料一致', material, '所有数字必须与材料一致')
has('要求交代数据局限', material, 'caveats 里如实说明样本量')
has('要求不要复述算法层分数（去重叠）', material, '换个说法重抄一遍')
has('要求不要把别人的话当成他说的', material, '不要把别人的话当成他说的')
has('要求区分「房间整体情绪」与「个人情绪」', material, '也不要把房间整体的情绪当成他的情绪')
for (const field of ['"persona"', '"headline"', '"overview"', '"tags"', '"sections"', '"evidence"', '"suggestions"', '"caveats"']) {
  has(`JSON 形状里有 ${field}`, material, field)
}
not('没给上一版时不写「这是一次迭代」', material, '这是一次迭代')

console.log('\n=== 5. 语言：英文界面出英文材料与指令')
const en = fixturePrompt({ language: 'en-US' })
has('英文指令', en.user, 'Write all copy in English.')
has('英文分节', en.user, '## 1. Identity and accounts')
not('英文材料里没有中文分节标题', en.user, '一、身份与账号')
not('中文材料里没有英文分节标题', material, 'behaviour archetype')
not('英文材料里没有中文算法层标签', en.user, '大五人格侧写')

console.log('\n=== 6. 迭代（第 2 版）：上一版喂回去 + 明确要求「不是从零开始」')
const previousReport = {
  persona: '夜聊型陪伴者',
  headline: '深夜来、只聊天少花钱的熟客',
  overview: '他几乎只在 20-23 点出现。',
  tags: ['夜猫子'],
  sections: [{ title: '说话风格', items: ['爱用表情'] }],
  evidence: [{ quote: '今晚唱得太好听了', note: '偏好夸唱' }],
  suggestions: ['固定时段点名'],
  caveats: ['样本 15 条']
}
const second = fixturePrompt({
  previous: { version: 1, generatedAt: NOW - 2 * DAY, report: previousReport, raw: JSON.stringify(previousReport) },
  version: 2
})
has('写明这是第几版', second.user, '这是第 2 版画像')
has('给了上一版内容', second.user, '夜聊型陪伴者')
has('要求迭代而不是重写', second.user, '这是一次迭代（不是从零开始）')
has('要求改正与材料冲突的旧结论', second.user, '与材料冲突的旧说法必须改正')

console.log('\n=== 7. 解析容错（模型回话的六种形态）')
const report = previousReport
const fenced = '```json\n' + JSON.stringify(report) + '\n```'
eq(
  '围栏 JSON 能解析',
  (parsePortraitReport(fenced) ?? {}).persona,
  '夜聊型陪伴者'
)
const chatty = `好的，这是这位观众的画像：\n${JSON.stringify(report)}\n希望对你有帮助。`
eq('前后带客套话也能解析', (parsePortraitReport(chatty) ?? {}).headline, report.headline)
const braceInside = JSON.stringify({ ...report, evidence: [{ quote: '{笑} 这也行', note: '含花括号' }] })
eq(
  '字符串里含花括号不会截错',
  (parsePortraitReport(`说明：${braceInside}`) ?? {}).evidence?.[0]?.quote,
  '{笑} 这也行'
)
const chineseKeys = JSON.stringify({
  人物类型: '闷声打赏的人',
  一句话画像: '很少说话但送得稳',
  总览: '他基本不发言。',
  标签: ['沉默', '稳定'],
  分节: [{ 标题: '消费', 条目: ['每月固定送'] }],
  建议: ['发个感谢']
})
eq('中文键名认得出', (parsePortraitReport(chineseKeys) ?? {}).persona, '闷声打赏的人')
eq(
  '少给字段不整份作废（只少显示未给的块）',
  (() => {
    const parsed = parsePortraitReport(JSON.stringify({ persona: 'X', sections: [{ title: 'A', items: ['b'] }] }))
    return [parsed?.persona, parsed?.suggestions.length, parsed?.caveats.length]
  })(),
  ['X', 0, 0]
)
eq('彻底坏掉的回话 → null（调用方退回原文）', parsePortraitReport('模型今天不想写 JSON'), null)
eq('空对象 → null', parsePortraitReport('{}'), null)
eq('非字符串输入不崩', parsePortraitReport(undefined), null)

console.log('\n=== 8. 归一化：超长/重复/多余字段都被收口')
const messy = normalizePortraitReport({
  persona: 'P'.repeat(80),
  headline: 'H'.repeat(400),
  tags: ['a', 'a', 'b', ...Array.from({ length: 20 }, (_v, i) => `t${i}`)],
  sections: Array.from({ length: 30 }, (_v, i) => ({ title: `S${i}`, items: ['x', 'x'] })),
  evidence: [{ quote: 'q', note: 'n' }, 'plain string'],
  suggestions: { not: 'an array' },
  caveats: ['c1']
})
eq('类型名截到上限', messy.persona.length, PORTRAIT_LIMITS.personaChars + 1)
check('标签去重 + 限量', messy.tags.length <= PORTRAIT_LIMITS.tags && new Set(messy.tags).size === messy.tags.length)
check('分节限量', messy.sections.length <= PORTRAIT_LIMITS.sections)
check('每节条目去重', messy.sections[0].items.length === 1)
eq('evidence 里的裸字符串也认', messy.evidence[1], { quote: 'plain string', note: '' })
eq('suggestions 不是数组 → 空数组（不崩）', messy.suggestions, [])
eq('extractJsonObject 对空串返回 null', extractJsonObject(''), null)

console.log('\n=== 9. 流式半成品：只认已闭合的字段')
const streamed = [
  '{"persona": "夜聊型陪',
  '{"persona": "夜聊型陪伴者", "headline": "深夜来、只聊天少花钱的熟客", "overview": "他几乎只在 20-23 点出现，',
  '{"persona": "夜聊型陪伴者", "headline": "一句话", "tags": ["夜猫子", "话多"], "sections": [{"title": "说话风格", "items": ["爱用表情"]}, {"title": "还',
  '{"persona": "夜聊型陪伴者", "headline": "一句话", "tags": ["夜猫子"], "sections": [{"title": "说话风格", "items": ["爱用表情"]}], "suggestions": ["固定时段点名", "别催他"]}'
]
eq(
  '写到一半时还没有任何完整字段',
  partialPortraitReport(streamed[0]),
  null
)
const second1 = partialPortraitReport(streamed[1])
eq('类型名与一句话画像先出来', [second1?.persona, second1?.headline], ['夜聊型陪伴者', '深夜来、只聊天少花钱的熟客'])
eq('没闭合的总览不显示（不给半句话）', second1?.overview, '')
const third = partialPortraitReport(streamed[2])
eq('已闭合的分节显示、正在写的那个分节丢掉', [third?.sections.length, third?.sections[0].title], [1, '说话风格'])
eq('标签数组整段读到（没被后面的 sections 吞掉）', third?.tags, ['夜猫子', '话多'])
const fourth = partialPortraitReport(streamed[3])
eq('建议数组也读到', fourth?.suggestions, ['固定时段点名', '别催他'])
eq('收尾后与最终解析一致', JSON.stringify(normalizePortraitReport(partialPortraitReport(streamed[3]))), JSON.stringify(fourth))

console.log('\n=== 10. 缓存键 / 指纹 / 互动量 / 设置读取')
eq('绑定过账号用画像做键', portraitKeyOf(7, '2056511'), 'identity:7:viewer')
eq('没绑定用 id 做键', portraitKeyOf(0, '2056511'), 'user:2056511:viewer')
eq('主播那一版是另一个键（同一个人两套画像）', portraitKeyOf(7, '2056511', 'host'), 'identity:7:host')
eq('没绑定的主播键', portraitKeyOf(0, '2056511', 'host'), 'user:2056511:host')
check('观众与主播的键不同', portraitKeyOf(7, 'x', 'viewer') !== portraitKeyOf(7, 'x', 'host'))
check(
  '角色给脏值也当观众（不与主进程的「不认识就当没传」冲突：这里只是兜底）',
  portraitKeyOf(7, 'x', undefined) === 'identity:7:viewer'
)
const sample = { chat: 42, enter: 9, like: 120, follow: 1, gift: 6, diamonds: 3200, lastSeen: NOW }
eq('互动量 = 五类互动条数之和', portraitInteractions(sample), 178)
eq('同一份数据指纹稳定', portraitFingerprint(sample), portraitFingerprint({ ...sample }))
check(
  '数据涨了指纹就变',
  portraitFingerprint(sample) !== portraitFingerprint({ ...sample, gift: 7 })
)
eq('最新出现只差几分钟（同一小时）不算「数据变了」', portraitFingerprint(sample), portraitFingerprint({ ...sample, lastSeen: NOW + 60000 }))
check(
  '跨小时算变了',
  portraitFingerprint(sample) !== portraitFingerprint({ ...sample, lastSeen: NOW + 3600000 })
)
eq('设置里没选模型 = null', portraitProviderSetting({}), null)
eq('设置里选了 0 = null（跟随默认）', portraitProviderSetting({ portraitProviderId: 0 }), null)
eq('设置里选了 12 = 12', portraitProviderSetting({ portraitProviderId: 12 }), 12)
has('Markdown 导出带标题与分节', reportToMarkdown(report), '## 说话风格')

console.log('\n=== 11. 主播那一版：换问题、换标题、不换事实')
const host = fixturePrompt({ role: 'host' })
/*
 * 材料里有几个词两边都会出现（「主播」二字本身），所以断言分两层：
 * 「只有主播那版才有」的句子，以及「事实层必须逐字相同」的那些数字。
 */
has('系统指令说的是主播', host.system, '擅长从主播的直播流水里读出')
has('任务说的是这位主播（不是观众）', host.user, '为这位抖音直播间/语音房的**主播**写一份尽可能全面、可执行的主播画像')
has('明说了不是把他当观众', host.user, '不是把他当观众')
has('多了一条「他本人发的话」的硬性要求', host.user, '不要把观众的发言当成他的表现')
has('写明房间播 / 语音房一场可能有多个主播', host.user, '房间播 / 语音房里同一场可能有多个主播')
has('第八节换成「发言记录样本」', host.user, '八、发言记录样本（他本人在房间里发的话')
has('收礼那一节点明这是他的收益', host.user, '十、收礼流水（别人送给他的，最近 1 条，新 → 旧，这是他的收益）')
has('主播版：房间上下文是他直播效果的现场证据', host.user, '房间上下文那一节里的观众反应')
has('关系网按主播口径问（收入来源）', host.user, '送礼给他最多的人（他的主要收入来源）')
has('关系网按主播口径问（主动维护）', host.user, '他送礼最多的人（他主动维护的关系）')
has('角色说明写进材料（别把别人的行为算到他头上）', host.user, '这份材料分析的是**主播**本人')
has('类型名按主播起（不是「夜聊型陪伴者」那种观众类型）', host.user, '主播类型名，4-10 字，你自己起')
has('建议改成「直接对这位主播说」', host.user, '直接对这位主播说')
has('分节角度换成直播风格 / 话术 / 收益结构', host.user, '直播风格与话术特征')
not('观众那版不出现主播专属的类型名说明', material, '主播类型名')
not('观众那版不出现主播专属的分节角度', material, '留人与转化手段')
not('观众那版没有那句角色说明', material, '这份材料分析的是**主播**本人')
not('观众那版的第七节还是「弹幕样本」', material, '发言记录样本')
/*
 * 换角色**不改事实**：同一份流水、同一批样本、同一批算法层数字，逐字相同。
 * 这条是这次改动最容易做错的地方——「分开分析」很容易顺手把材料也换了一份。
 */
for (const fact of [
  '弹幕 42',
  '送出抖币 3200',
  '收到抖币 500',
  '深夜电台（880000000001）',
  '比心 ×5（500 抖币） → 工装主播',
  '大啤酒 ×2（500 抖币） ← 送礼的人',
  '- [2026-10-13 21:28] [比心] 今晚唱得太好听了',
  '昵称 夜猫子小张',
  '同一个人，共 2 个',
  '行为原型',
  '材料生成时间：2026-10-13 21:30'
]) {
  has(`事实层逐字保留：${fact}`, host.user, fact)
}
eq('两个角色的分节数一样（同一套材料骨架）', (host.user.match(/\n## /g) ?? []).length, (material.match(/\n## /g) ?? []).length)
check('两份提示词确实不同（不是只改了个标题）', host.user !== material)
check('主播那版的成本仍在闸门内（多了一条规则与角色说明）', host.chars.total <= 30000, `实际 ${host.chars.total}`)
console.log(`     主播版材料字符：system ${host.chars.system} + user ${host.chars.user} = ${host.chars.total}`)
const hostEn = fixturePrompt({ role: 'host', language: 'en-US' })
has('英文主播版：任务说的是主播', hostEn.user, '**streamer** profile')
has('英文主播版：发言样本那一节换了标题', hostEn.user, '8. Message samples he himself posted')
not('英文主播版里没有中文残留', hostEn.user, '主播类型名')
not('英文观众版里没有主播专属角度', en.user, 'streaming style and scripting')

console.log('\n=== 12. 成本（材料字符数 ≈ 输入 token 预算）')
const chars = prompt.chars
console.log(
  `     材料字符：system ${chars.system} + user ${chars.user} = ${chars.total}（约 ${Math.round(chars.total / 2)} token 量级）`
)
check('材料不超过 30000 字符（一次生成的成本闸门）', chars.total <= 30000, `实际 ${chars.total}`)
check('材料不小于 1500 字符（别把该给的证据省了）', chars.total >= 1500)

rmSync(workDir, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项未通过`}`)
process.exit(failures === 0 ? 0 : 1)
