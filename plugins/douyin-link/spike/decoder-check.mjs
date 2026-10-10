/**
 * 解码器自检（dev-only，不参与打包）：把**按官方/实测字段号手搓的 protobuf 帧**喂给
 * **真实的解码器**（`main/douyin/proto-messages.ts`），
 * 断言礼物与点歌解出来的东西对不对。
 *
 * 为什么要有它：这个插件的两条纪律是「字段号必须实测」和「宁可没有，不给错数」，
 * 而礼物这一类正好踩在两条上——解码器一旦把 `diamondCount` 读成别的字段，
 * 界面上就会出现一个看起来很确定的错误价格。跑一次这个自检（1 秒）比盯界面对半天靠谱。
 *
 * 怎么跑（仓库根目录；需要 esbuild，它已经在 devDependencies 里）：
 *
 *   node plugins/douyin-link/spike/decoder-check.mjs
 *
 * 它做三件事：
 * 1. 用 esbuild 把两个 TS 解码器打成临时 ESM（`electron-log` 换成一个空壳，探针不需要日志）；
 * 2. 手搓几帧（礼物 / 点歌 / 弹幕 / 送礼物的 JSON 版本）；
 * 3. 断言 `decodeProtoMessage` / `decodeMessageJson` 的输出，失败就 `exit 1`。
 *
 * 另外一个用法：**把探针抓到的真帧喂回解码器**（对字段号存疑时的第一手段）——
 * 从 `live-probe.mjs --hex` 的日志里把 `hex=` 那串拷出来：
 *
 *   node plugins/douyin-link/spike/decoder-check.mjs --frame=WebcastGiftMessage:0a2a0a16...
 *
 * 它只打印这个 method 解出来的东西（一行 + 用户）与原始字段树，不做断言、不改任何状态。
 *
 * 真帧核对过一次（2026-10，`ws-spike.mjs` 抓的 `WebcastLinkmicOrderSingMessage`）：同一个点歌单会连着来
 * 几帧，顶层 `2 = 4` 那帧才是点歌（带歌手的 User），`2 = 5` 是播放状态变更（payload 在 `7`）——
 * 后者解出 null 是**预期**，不是 bug。
 *
 * 帧里的字段号来源：礼物 = 社区里公开的 `WebcastGiftMessage`/`GiftStruct` 定义（见
 * `proto-messages.ts` 的字段对照表）；点歌 = **本机实测**（`spike/live-probe.mjs` 抓的真帧，
 * `6.1` 单号串 / `6.3` 歌手的 User）。真帧里带真人昵称，所以**不入库、只在日志里看过**，
 * 这里用同名结构的合成帧代替。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { dumpTree } from './pb.mjs'

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const workDir = mkdtempSync(join(tmpdir(), 'douyin-decoder-check-'))

/* --------------------------------------------------------- 极简 protobuf 写 */

const varint = (value) => {
  const out = []
  let rest = BigInt(value)
  while (rest > 0x7fn) {
    out.push(Number((rest & 0x7fn) | 0x80n))
    rest >>= 7n
  }
  out.push(Number(rest))
  return Buffer.from(out)
}

const tag = (field, wire) => varint(field * 8 + wire)
const pbVarint = (field, value) => Buffer.concat([tag(field, 0), varint(value)])
const pbBytes = (field, buf) => Buffer.concat([tag(field, 2), varint(buf.length), buf])
const pbString = (field, text) => pbBytes(field, Buffer.from(text, 'utf8'))
const pbMessage = (field, buf) => pbBytes(field, buf)

/** 一个最简 `User`：只有 1 id（解码器要求有 id 才认）与 3 昵称 */
const user = (id, nickname) =>
  Buffer.concat([pbVarint(1, id), pbString(3, nickname)])

/**
 * `WebcastGiftMessage`（字段号见 proto-messages.ts 的对照表）：
 * 5 repeatCount、6 comboCount、7 user、15 gift{ 2 describe, 12 diamondCount, 16 name }
 */
const giftFrame = ({ nickname = '送礼的人', unit = 10, repeat = 5, name = '小心心' } = {}) =>
  Buffer.concat([
    pbVarint(2, 10990), // giftId
    pbVarint(5, repeat),
    pbVarint(6, repeat),
    pbMessage(7, user(7694190253011159818n, nickname)),
    pbMessage(
      15,
      Buffer.concat([pbString(2, '一颗小心心'), pbVarint(12, unit), pbString(16, name)])
    )
  ])

/**
 * `WebcastLinkmicOrderSingMessage`（**实测字段号**）：
 * 6.1 = `发送者_歌手_单号_0_<礼物 id>_1_Normal`、6.2 = 状态、6.3 = 歌手的 User、6.4 = 时间（秒）；
 * 6.5.1 = 点唱礼物记录（1 收礼人 User、2 送礼人 User、3 单号串、5 **房间固定的点唱礼物 id**、
 * 6 它的价、10 场景标签）。
 *
 * 两个礼物来源**不是一回事**（2026-10-08 扫 40 条真帧才发现，见 `main/douyin/proto-messages.ts`
 * 的 `orderSingGiftId`）：`keyGift`（单号串第 5 段）才是用户**实际送的那件**，
 * `recordGift` 实测永远是 3200（爱的纸鹤 99 = 点唱服务费）。所以 fixture 两个都给，
 * 默认让它们一致（3200），要测「不一致时听谁的」就显式传两个不同的值。
 */
const orderSingFrame = ({
  sender = '送礼的人',
  singer = '唱歌的人',
  keyGift = 3200,
  recordGift = 3200,
  price = 99,
  orderId = '10000037694256230482760723'
} = {}) => {
  const key = `58709692971_7667087264728728634_${orderId}_0_${keyGift}_1_Normal`
  return Buffer.concat([
    pbVarint(2, 4),
    pbMessage(
      6,
      Buffer.concat([
        pbString(1, key),
        pbVarint(2, 6),
        pbMessage(3, user(7667087264728728634n, singer)),
        pbVarint(4, 1791458632),
        pbMessage(
          5,
          pbMessage(
            1,
            Buffer.concat([
              pbMessage(1, user(7667087264728728634n, singer)),
              pbMessage(2, user(58709692971n, sender)),
              pbString(3, key),
              pbVarint(5, recordGift),
              pbVarint(6, price),
              pbString(10, '点唱礼物')
            ])
          )
        )
      ])
    )
  ])
}

/** 同一单号串的「后一条」帧：只有单号串与歌手，没有 6.5 礼物记录（实测服务端会这么重复推） */
const orderSingFollowUpFrame = ({
  singer = '唱歌的人',
  orderId = '10000037694256230482760723',
  keyGift = 13564
} = {}) =>
  Buffer.concat([
    pbVarint(2, 4),
    pbMessage(
      6,
      Buffer.concat([
        pbString(1, `58709692971_7667087264728728634_${orderId}_0_${keyGift}_1_Normal`),
        pbVarint(2, 3),
        pbMessage(3, user(7667087264728728634n, singer))
      ])
    )
  ])

/**
 * 假的礼物目录（真目录是 `main/gift/catalog.ts` 从官方接口拉的 1282 件）：
 * 自检只关心「按 id 查名字与价格」这条链，所以这里给一件真礼物 + 一件虚构礼物。
 * 也实现 `resolveByName`：真礼物帧按字段号解不出名字时的兜底靠它。
 */
const fakeCatalog = (pairs = {}) => {
  const names = new Map(Object.values(pairs).map((gift) => [gift.name, gift]))
  return {
    resolve: (id) => pairs[id],
    resolveByName: (name) => names.get(name)
  }
}

/**
 * 一件「结构未知」的真礼物帧：字段号全按社区 proto 猜错的样子——顶层 `7`/`8` 仍是 user/toUser，
 * 但礼物结构放在别的字段（`23`），名字与价格埋在更深一层。用来验证「帧里出现了目录礼物名」的兜底。
 */
const unknownGiftFrame = ({ sender = '失眠了', to = '不乖', name = '爱的纸鹤', unit = 99 } = {}) =>
  Buffer.concat([
    pbMessage(7, user(7694190253011159818n, sender)),
    pbMessage(8, user(7694190253011159819n, to)),
    pbVarint(5, 1),
    pbMessage(23, pbMessage(4, Buffer.concat([pbVarint(2, unit), pbString(9, name)])))
  ])

/** 一条普通弹幕（用来验证「别的消息不该带出抖币」） */
const chatFrame = ({ nickname = '说话的人', text = '你好' } = {}) =>
  Buffer.concat([pbMessage(2, user(7000000000000000001n, nickname)), pbString(3, text)])

/* ------------------------------------------------------------------ 打补丁 */

const stubPath = join(workDir, 'electron-log-stub.mjs')
writeFileSync(
  stubPath,
  // 日志不是空壳而是**探针**：诊断日志有没有真的打出来，靠它来断言（别只信「代码里写了」）。
  // 用 globalThis 存调用记录：esbuild 可能把这个 stub 内联进 bundle，那样「另一个实例」就看不到记录了。
  `const calls = (globalThis.__DOUYIN_LOG_CALLS__ ??= [])\n` +
    `export { calls }\n` +
    `const push = (level) => (...args) => { calls.push([level, args.map((a) => String(a)).join(' ')]) }\n` +
    `export default { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }\n`,
  'utf8'
)

async function bundle(entry, sub = 'main/douyin') {
  const outfile = join(workDir, `${entry.replace(/[^\w]/g, '_')}.mjs`)
  await build({
    entryPoints: [join(ROOT, 'plugins/douyin-link', sub, entry)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    plugins: [
      {
        name: 'stub-electron-log',
        setup(buildApi) {
          buildApi.onResolve({ filter: /^electron-log$/ }, () => ({ path: stubPath }))
        }
      }
    ]
  })
  return import(pathToFileURL(outfile).href)
}

/** 取日志探针记下的行（诊断断言用；stub 把记录挂在 globalThis 上，内联与否都看得到） */
async function logCalls() {
  return globalThis.__DOUYIN_LOG_CALLS__ ?? []
}

/* -------------------------------------------------------------------- 断言 */

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`)
}

const proto = await bundle('proto-messages.ts')
/** 落库时「同一单两帧合并成一行」的规则（纯函数，见 main/gift/merge.ts） */
const mergeMod = await bundle('merge.ts', 'main/gift')
/** 连送（combo）累积量 → 本次增量 的去重（纯函数，见 main/gift/group.ts） */
const groupMod = await bundle('group.ts', 'main/gift')

/** `--frame=Method:hex`：把真帧喂回解码器，只看它解出什么（不做断言） */
const frameArg = process.argv.find((arg) => arg.startsWith('--frame='))
if (frameArg) {
  const [method, hex] = frameArg.slice('--frame='.length).split(':')
  if (!method || !hex) {
    console.error('用法：--frame=WebcastGiftMessage:0a2a0a16…')
    process.exit(2)
  }
  const decoded = proto.decodeProtoMessage(method, Buffer.from(hex, 'hex'))
  console.log(`${method} →`)
  console.log('  item :', JSON.stringify(decoded?.item ?? null))
  console.log('  users:', JSON.stringify((decoded?.users ?? []).map((u) => ({ id: u.id, nickname: u.nickname, displayId: u.displayId }))))
  console.log('  原始字段树：')
  // 深一点（8 层）：点歌那种帧真正的料埋在 6.5.1.x 里，浅了看不到
  dumpTree(Buffer.from(hex, 'hex'), 1, '', console.log, 8)
  rmSync(workDir, { recursive: true, force: true })
  // 只做「看一眼」，不是断言：解不出东西（例如点歌的**播放状态变更**帧，见 proto-messages.ts）也退 0
  process.exit(0)
}

/* 礼物：名字 / 数量 / 抖币总额（单价 × 数量） */
const gift = proto.decodeProtoMessage('WebcastGiftMessage', giftFrame())
check('礼物 → kind', gift.item.kind, 'gift')
check('礼物 → 名字', gift.item.text, '小心心')
check('礼物 → 数量', gift.item.count, 5)
check('礼物 → 抖币总额 = 10 × 5', gift.item.diamonds, 50)
check('礼物 → 送礼人昵称', gift.item.user, '送礼的人')
check('礼物 → 带出用户档案', gift.users.map((u) => u.nickname), ['送礼的人'])

/* 单价拿不到（老帧 / 免费礼物）：抖币必须是 0，而不是编一个数 */
const priceless = proto.decodeProtoMessage(
  'WebcastGiftMessage',
  Buffer.concat([
    pbVarint(5, 1),
    pbMessage(7, user(7694190253011159819n, '没带价的人')),
    pbMessage(15, pbString(16, '免费小心心'))
  ])
)
check('礼物没带价格 → 抖币 0', priceless.item.diamonds, 0)
check('礼物没带价格 → 数量缺省 1', priceless.item.count, 1)

/* 点歌：送礼人/收礼人的 User 在 6.5.1 那份记录里；名字与价格**以官方目录为准** */
const sing = proto.decodeProtoMessage(
  'WebcastLinkmicOrderSingMessage',
  orderSingFrame({ sender: '少走点弯路', singer: '摇尾乞怜', price: 99, recordGift: 3200, keyGift: 3200 })
)
check('点歌 → kind', sing.item.kind, 'gift')
check('点歌 → 送礼人（6.5.1.2 的 User）', [sing.item.user, sing.item.userId], ['少走点弯路', '58709692971'])
check('点歌 → 收礼人（6.5.1.1 的 User，= 歌手）', [sing.item.toUser, sing.item.toUserId], ['摇尾乞怜', '7667087264728728634'])
check('点歌 → 没有目录时退回房间的说法（不拿场景标签当礼物名）', [sing.item.text, sing.item.diamonds], ['想听 摇尾乞怜 演唱', 99])
check('点歌 → 送礼人 + 收礼人都进用户库', sing.users.map((u) => u.nickname).sort(), ['少走点弯路', '摇尾乞怜'])

/* 有目录时：名字与价格取自目录（real 例子：id 4353 = 跑车 = 1200 抖币） */
const catalog = fakeCatalog({ 3200: { name: '爱的纸鹤', diamonds: 99 }, 4353: { name: '跑车', diamonds: 1200 } })

/*
 * 用户 2026-10-08 反馈的核心场景：房间里有人送「跑车」，插件显示未知/爱的纸鹤。
 * 真帧里「跑车」写在**单号串第 5 段**（4353），而记录里的 5 永远是 3200（点唱礼物 99）。
 * 两条断言：只有记录帧时要认跑车；**连记录都没有**（占大多数的那条推送）也要认跑车。
 */
const keyWins = proto.decodeProtoMessage(
  'WebcastLinkmicOrderSingMessage',
  orderSingFrame({ keyGift: 4353, recordGift: 3200, price: 99, singer: 'Snow' }),
  catalog
)
check('点歌 → 用户送的礼物以单号串为准（跑车，不是记录里的爱的纸鹤）', [keyWins.item.text, keyWins.item.diamonds], ['跑车', 1200])
check('点歌 → 价格也按单号串那件查（不是记录里的 99）', keyWins.item.diamonds, 1200)

const noRecordKeyGift = proto.decodeProtoMessage(
  'WebcastLinkmicOrderSingMessage',
  orderSingFollowUpFrame({ singer: 'Snow', orderId: '55500000000000000000000077', keyGift: 4353 }),
  catalog
)
check('没有礼物记录的帧 → 也能从单号串认出跑车与价', [noRecordKeyGift.item.text, noRecordKeyGift.item.diamonds], ['跑车', 1200])
check('没有礼物记录的帧 → 记录标记仍是 false（落库时不许覆盖）', noRecordKeyGift.item.giftRecord, false)

/* 单号串第 5 段认不出来（不在目录里）→ 退回记录里那份，而不是显示一个查不到的 id */
const recordFallback = proto.decodeProtoMessage(
  'WebcastLinkmicOrderSingMessage',
  orderSingFrame({ keyGift: 13564, recordGift: 4353, price: 1200, singer: 'Snow' }),
  catalog
)
check('单号串那段不在目录里 → 退回记录里的礼物', [recordFallback.item.text, recordFallback.item.diamonds], ['跑车', 1200])

/* 点歌的价以**目录**为准（记录里的价永远是那件固定点唱礼物的，与用户实际送的那件无关） */
const mismatch = fakeCatalog({ 3200: { name: '爱的纸鹤', diamonds: 99 } })
const wrong = proto.decodeProtoMessage('WebcastLinkmicOrderSingMessage', orderSingFrame({ price: 5 }), mismatch)
check('点歌 → 忽略记录里的固定礼物价，用目录价', wrong.item.diamonds, 99)

/* 结构未知的真礼物帧：按字段号解不出名字时，靠「帧里出现的目录礼物名」兜底 */
const unknown = proto.decodeProtoMessage('WebcastGiftMessage', unknownGiftFrame(), catalog)
check('未知结构的真礼物 → 靠帧里的礼物名认出礼物', unknown.item.text, '爱的纸鹤')
check('未知结构的真礼物 → 价格取自目录', unknown.item.diamonds, 99)
check('未知结构的真礼物 → 送礼人/收礼人照旧', [unknown.item.user, unknown.item.toUser], ['失眠了', '不乖'])

/* 目录里没有这件礼物的名字：不许编，正文留空（界面显示「礼物名未知」） */
const unknownNoCatalog = proto.decodeProtoMessage('WebcastGiftMessage', unknownGiftFrame(), fakeCatalog({}))
check('目录对不上名字 → 不编名字', unknownNoCatalog.item.text, '')
check('真礼物 → trace=proto-gift', unknownNoCatalog.item.trace, 'proto-gift')

/* 诊断日志必须**真的打出来**（探针记录；别只信代码里写了） */
const giftLogs = (await logCalls()).filter(([, text]) => text.includes('gift-unknown'))
check('真礼物解不出名字 → 写了 [gift-unknown] 日志', giftLogs.length >= 2, true)
check('日志里有原始帧 hex', giftLogs.some(([, text]) => text.includes('hex=')), true)

/* 点歌帧解不出礼物名时也要留证据（这条以前是静默的）：
   送礼人/歌手都只有 id、没有昵称，记录里也没有礼物信息 → 名字必然是空 */
proto.__resetProtoIds()
proto.decodeProtoMessage(
  'WebcastLinkmicOrderSingMessage',
  Buffer.concat([
    pbVarint(2, 4),
    pbMessage(
      6,
      Buffer.concat([
        pbString(1, '58709692971_7667087264728728634_55500000000000000000000009_0_13564_1_Normal'),
        pbMessage(3, pbVarint(1, 7667087264728728634n))
      ])
    )
  ])
)
const orderLogs = (await logCalls()).filter(([, text]) => text.includes('gift-empty-order'))
check('点歌解不出名字 → 写了 [gift-empty-order] 日志', orderLogs.length >= 2, true)
check(
  '点歌日志带 giftId/label + 原始帧 hex',
  orderLogs.some(([, text]) => text.includes('giftId=') && text.includes('label=')) &&
    orderLogs.some(([, text]) => text.includes('hex=')),
  true
)

/* 同一个点歌单的后续帧（没有礼物记录）必须被丢掉：否则库里会出现「同一单两行、一行没名字」 */
proto.__resetProtoIds()
proto.decodeProtoMessage('WebcastLinkmicOrderSingMessage', orderSingFrame({ orderId: '55500000000000000000000001' }))
check(
  '同一单的后续帧 → 丢弃（不重复记一行）',
  proto.decodeProtoMessage(
    'WebcastLinkmicOrderSingMessage',
    orderSingFollowUpFrame({ orderId: '55500000000000000000000001', keyGift: 3200 })
  )?.item ?? null,
  null
)

/* 没见过的单号串、且帧里没有礼物记录：名字退回房间的说法「想听 X 演唱」，价格未知 */
const bare = proto.decodeProtoMessage(
  'WebcastLinkmicOrderSingMessage',
  orderSingFollowUpFrame({ singer: 'Snow', orderId: '55500000000000000000000002' })
)
check('无记录的帧 → 名字退回「想听 X 演唱」', bare.item.text, '想听 Snow 演唱')
check('无记录的帧 → 收礼人仍是歌手', bare.item.toUser, 'Snow')
check('无记录的帧 → 价格未知', bare.item.diamonds, 0)

/* 没有那份礼物记录的老帧（全新单号串）：礼物名/价格留空，送礼人退回单号串第一段 */
const oldStyle = proto.decodeProtoMessage(
  'WebcastLinkmicOrderSingMessage',
  Buffer.concat([
    pbVarint(2, 4),
    pbMessage(
      6,
      Buffer.concat([
        pbString(1, '58709692971_7667087264728728634_55500000000000000000000003_0_13564_1_Normal'),
        pbMessage(3, user(7667087264728728634n, '歌手'))
      ])
    )
  ])
)
check('老帧点歌 → 送礼人 id 仍在', oldStyle.item.userId, '58709692971')
check('老帧点歌 → 礼物记录缺失时退回「想听 X 演唱」+ 价格未知', [oldStyle.item.text, oldStyle.item.diamonds], [
  '想听 歌手 演唱',
  0
])
check('老帧点歌 → 收礼人退回歌手', oldStyle.item.toUser, '歌手')

/* 单号串第一段不是数字（结构变了/看错了）时，不许写半截垃圾进 userId */
const weird = proto.decodeProtoMessage(
  'WebcastLinkmicOrderSingMessage',
  Buffer.concat([
    pbVarint(2, 4),
    pbMessage(6, Buffer.concat([pbString(1, 'abc_def'), pbMessage(3, user(7667087264728728634n, '歌手'))]))
  ])
)
check('点歌 → 单号串认不出来时 userId 为空', weird.item.userId, '')

/* ------------------------------------------------------------------ 同一单 → 一行 */
/*
 * 真机库里出过成对的「`content=''`（16 秒~3.5 分钟后）`content='爱的纸鹤'`」两行，礼物榜里就多出
 * 「（礼物名未知）」。两帧带的是**同一个单号串**，落库必须合成一行（见 main/gift/merge.ts）。
 * 这里用真帧的两种先后顺序把规则跑一遍（先来哪条都出现过）。
 */
const sameOrderId = '55500000000000000000000005'
const weak = proto.decodeProtoMessage(
  'WebcastLinkmicOrderSingMessage',
  orderSingFollowUpFrame({ orderId: sameOrderId, singer: 'Snow', keyGift: 4353 })
)
const strong = proto.decodeProtoMessage(
  'WebcastLinkmicOrderSingMessage',
  orderSingFrame({ orderId: sameOrderId, singer: 'Snow', keyGift: 4353, recordGift: 4353, price: 1200 }),
  catalog
)
check('同一单两帧 → 单号串一致且非空', weak.item.orderKey === strong.item.orderKey && weak.item.orderKey.length > 0, true)
check('同一单两帧 → 记录标记分得开', [strong.item.giftRecord, weak.item.giftRecord], [true, false])
check('带记录的那帧 → 目录名 + 价', [strong.item.text, strong.item.diamonds, strong.item.toUser], ['跑车', 1200, 'Snow'])

/** 库里的一行 = 合并结果（**没有** giftRecord 这个字段，和表里的列一致） */
const toStoredRow = (row) => {
  const { giftRecord, ...rest } = row
  return rest
}
/** 按 `main/db/mapper.insertMessages` 的口径模拟落库：同一单号串永远只留一行 */
const storeOrder = (frames) => {
  let current = null
  frames.forEach((frame, index) => {
    const row = {
      content: frame.item.text,
      count: frame.item.count,
      diamonds: frame.item.diamonds,
      userId: frame.item.userId,
      userName: frame.item.user,
      toUserId: frame.item.toUserId,
      toUserName: frame.item.toUser,
      giftRecord: frame.item.giftRecord,
      // 解码器不填到达时刻（那是中枢收到帧时补的），这里按先后给两个时刻：1000 → 2000
      atMs: 1000 * (index + 1)
    }
    current = current ? mergeMod.mergeGiftRows(mergeMod.storedGiftMergeInput(current), row) : toStoredRow(row)
  })
  return current
}

/* 顺序一：没记录的先到（真机库里就是这个顺序，先落了一行空正文） */
const weakFirst = storeOrder([weak, strong])
check('先到没记录、后到带记录 → 礼物名与价格补上', [weakFirst.content, weakFirst.diamonds], ['跑车', 1200])
check('先到没记录、后到带记录 → 收礼人补上', [weakFirst.toUserName, weakFirst.toUserId], ['Snow', '7667087264728728634'])
check('合并结果里没有 giftRecord 这种非列字段', Object.keys(weakFirst).includes('giftRecord'), false)
check('时间取先到的那一刻', weakFirst.atMs, 1000)

/* 顺序二：带记录的先到——后到的那条**不许**把礼物名抹成「想听 X 演唱」 */
const strongFirst = storeOrder([strong, weak])
check('先到带记录、后到没记录 → 礼物名不被抹掉', [strongFirst.content, strongFirst.diamonds], ['跑车', 1200])

/* 两条都没记录：不留空正文，退回房间的说法；价格仍是「未知」而不是 0 抖币 */
const allWeak = storeOrder([weak, weak])
check('两条都没记录 → 正文退回「想听 X 演唱」', [allWeak.content, allWeak.diamonds], ['想听 Snow 演唱', 0])

/* 真礼物（有记录的另一种来源）也带记录标记，合并时才有资格覆盖 */
check('真礼物帧 → giftRecord=true', [gift.item.giftRecord, unknown.item.giftRecord], [true, true])

/* 真礼物的**单价以帧里的 `diamondCount`(12) 为准**（升级礼物/活动价与目录标准价不同） */
const priced = proto.decodeProtoMessage(
  'WebcastGiftMessage',
  giftFrame({ unit: 7, repeat: 3, name: '玫瑰' }),
  fakeCatalog({ 10990: { name: '玫瑰', diamonds: 99 } })
)
check('真礼物 → 帧价优先于目录（升级/活动价）', [priced.item.text, priced.item.diamonds], ['玫瑰', 21])
check('真礼物 → 带出礼物 id（连送分组用）', priced.item.giftId, 10990)

/* 别的消息不该带出抖币 */
const chat = proto.decodeProtoMessage('WebcastChatMessage', chatFrame())
check('弹幕 → kind / 抖币 0', [chat.item.kind, chat.item.diamonds], ['chat', 0])

/* 连送去重：服务端推**累积量** 1→2→5→5，落库的应是增量 1、1、3，最后那条重复帧被丢弃 */
{
  const state = new Map()
  const mk = (cumulative, unit) => ({
    id: 1, kind: 'gift', user: 'a', userId: '1', text: '玫瑰',
    count: cumulative, diamonds: unit * cumulative, toUser: '', toUserId: '2',
    giftId: 999, groupId: '7', at: 0
  })
  const counts = []
  let totalDiamonds = 0
  for (const cumulative of [1, 2, 5, 5]) {
    const out = groupMod.applyGiftIncrements([mk(cumulative, 10)], state)
    counts.push(out.length > 0 ? out[0].count : 0)
    if (out.length > 0) totalDiamonds += out[0].diamonds
  }
  check('连送累积 1,2,5,5 → 增量 1,1,3,0', counts, [1, 1, 3, 0])
  check('连送总额 = 10×(1+1+3) = 50', totalDiamonds, 50)
}

/* 不同 group_id 是不同的一次连送：不该互相抵消 */
{
  const state = new Map()
  const mk = (groupId, cumulative, unit) => ({
    id: 1, kind: 'gift', user: 'a', userId: '1', text: '玫瑰',
    count: cumulative, diamonds: unit * cumulative, toUser: '', toUserId: '2',
    giftId: 999, groupId: String(groupId), at: 0
  })
  const a = groupMod.applyGiftIncrements([mk(1, 3, 10)], state)
  const b = groupMod.applyGiftIncrements([mk(2, 3, 10)], state)
  check('不同 group_id 各自计首帧增量', [a[0].count, b[0].count], [3, 3])
}

/* ------------------------------------------------------- 真帧回放（--replay=探针日志） */
/*
 * 为什么要有这一段：上面的断言用的都是**手搓的**帧。手搓的帧只能证明「代码按我想的跑」，
 * 证明不了「真机推来的帧也是这个结构」。而用户要的是「礼物 tab 里能看见礼物名和价格」，
 * 所以拿 `live-probe.mjs --hex --dump-all` 抓下来的**真帧**（同一房间、同一条通道）整段回放一遍：
 * 每条点歌帧走真解码器（真目录查名字与价），再走真合并规则，最后逐行检查——
 * 只要还有一行没名字，就说明修没修好。
 */
const replayArg = process.argv.find((arg) => arg.startsWith('--replay='))
if (replayArg) {
  const logPath = replayArg.slice('--replay='.length)
  const catalogArg = process.argv.find((arg) => arg.startsWith('--catalog='))
  const catalogPath =
    catalogArg?.slice('--catalog='.length) ?? join(process.env.TEMP ?? tmpdir(), 'dy-catalog-map.json')
  const logBuf = readFileSync(logPath)
  // 探针日志是 PowerShell `*>` 写的 **UTF-16LE**（读成 utf8 会一条都匹配不上，踩过）
  const logText =
    logBuf[0] === 0xff && logBuf[1] === 0xfe
      ? logBuf.subarray(2).toString('utf16le')
      : logBuf[0] === 0xfe && logBuf[1] === 0xff
        ? logBuf.subarray(2).swap16().toString('utf16le')
        : logBuf.toString('utf8')
  let catalogPairs = {}
  try {
    catalogPairs = JSON.parse(readFileSync(catalogPath, 'utf8'))
  } catch {
    console.log(`! 读不到礼物目录 ${catalogPath}（用空目录继续：名字会退回帧里的标签）`)
  }
  const replayCatalog = fakeCatalog(catalogPairs)

  const frames = []
  let truncated = 0
  const lines = logText.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const head = /^=== dump #\d+ (\w+) len=(\d+) ===$/.exec(lines[index] ?? '')
    if (!head) continue
    const hexLine = /^hex=([0-9a-fA-F]+)$/.exec((lines[index + 1] ?? '').trim())
    if (!hexLine) continue
    const body = Buffer.from(hexLine[1], 'hex')
    if (body.length !== Number(head[2])) {
      truncated += 1
      continue
    }
    frames.push({ method: head[1], body })
  }

  const probeBefore = (await logCalls()).length
  const orderRows = new Map()
  const plainRows = []
  const decoded = { gift: 0, order: 0, dropped: 0 }
  /** 每个单号：服务端推了几次、见过最大的价、有没有见过带礼物记录的那一帧 */
  const keyStats = new Map()
  let arrival = 0
  for (const frame of frames) {
    arrival += 1
    const result = proto.decodeProtoMessage(frame.method, frame.body, replayCatalog)
    const item = result?.item
    if (!item) {
      decoded.dropped += 1
      continue
    }
    if (item.kind !== 'gift') continue
    if (frame.method === 'WebcastGiftMessage') decoded.gift += 1
    if (frame.method === 'WebcastLinkmicOrderSingMessage') decoded.order += 1
    const row = {
      content: item.text,
      count: item.count,
      diamonds: item.diamonds,
      userId: item.userId,
      userName: item.user,
      toUserId: item.toUserId,
      toUserName: item.toUser,
      giftRecord: item.giftRecord,
      atMs: arrival
    }
    if (!item.orderKey) {
      plainRows.push(row)
      continue
    }
    const stat = keyStats.get(item.orderKey) ?? { pushes: 0, maxDiamonds: 0, hadRecord: false }
    stat.pushes += 1
    stat.maxDiamonds = Math.max(stat.maxDiamonds, item.diamonds)
    stat.hadRecord = stat.hadRecord || Boolean(item.giftRecord)
    keyStats.set(item.orderKey, stat)
    const current = orderRows.get(item.orderKey)
    orderRows.set(
      item.orderKey,
      current ? mergeMod.mergeGiftRows(mergeMod.storedGiftMergeInput(current), row) : toStoredRow(row)
    )
  }
  const replayRows = [...orderRows.values(), ...plainRows]
  const unnamed = replayRows.filter((row) => !row.content)
  const priced = replayRows.filter((row) => row.diamonds > 0)
  const repeated = [...keyStats.entries()].filter(([, stat]) => stat.pushes > 1)
  const recordKeys = [...keyStats.entries()].filter(([, stat]) => stat.hadRecord).map(([key]) => key)
  const probeAfter = await logCalls()
  const replayDiagnostics = probeAfter
    .slice(probeBefore)
    .filter(([, text]) => text.includes('gift-empty') || text.includes('gift-unknown'))

  console.log(
    `\n真帧回放：${logPath}\n  可解码帧 ${frames.length}（跳过截断帧 ${truncated}）· ` +
      `真礼物 ${decoded.gift} · 点歌 ${decoded.order} · 解码器丢弃 ${decoded.dropped}\n` +
      `  目录 ${Object.keys(catalogPairs).length} 件 · 合并后礼物行 ${replayRows.length}` +
      `（其中 ${repeated.length} 单是推送过多次）· 有价 ${priced.length} 行`
  )
  console.log('  行样例（最多 12 行）：')
  for (const row of replayRows.slice(-12)) {
    console.log(
      `    ${row.diamonds > 0 ? `${row.diamonds} 抖币` : '价值未知'}  ${row.content}  ` +
        `${row.userName || row.userId || '（无送礼人）'} → ${row.toUserName || '（无收礼人）'}`
    )
  }
  /*
   * 抓帧窗口里**有没有**带礼物记录（`6.5.1`）的帧，是服务端说了算——2026-10-08 实测同一个房间
   * 有的时段每单都带、有的时段一条都不带。所以跟记录有关的断言必须**有条件**，
   * 否则一段安静的抓帧会让这条检查变成假警报（那比没有检查更糟：会让人开始忽略 FAIL）。
   */
  const pricedOrders = [...orderRows.entries()].filter(([, row]) => row.diamonds > 0)
  check('真帧回放 → 每一行都有礼物名（不能是「礼物名未知」）', unnamed.length, 0)
  check('真帧回放 → 解码器不再写「解不出名字」的诊断', replayDiagnostics.length, 0)
  if (repeated.length > 0) {
    check(
      '真帧回放 → 同一单推多次也只留一行，且价取最大',
      repeated.every(([key, stat]) => orderRows.get(key).diamonds === stat.maxDiamonds),
      true
    )
  } else {
    console.log('  · 这次抓帧里没有「同一单推多次」的情况，合并那条断言跳过')
  }
  if (recordKeys.length > 0) {
    check('真帧回放 → 见过礼物记录的单都查到了目录价', recordKeys.every((key) => orderRows.get(key).diamonds > 0), true)
    check('真帧回放 → 有价的行数不超过单数（没编价）', pricedOrders.length <= orderRows.size, true)
  } else {
    console.log(
      '  · 这次抓帧里没有任何带礼物记录（6.5.1）的帧：这几单在服务端就是「没带礼物」，' +
        '只能显示「想听 X 演唱」+ 价值未知（不是解码器的问题）'
    )
  }
}

rmSync(workDir, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项不通过`)
process.exit(failures === 0 ? 0 : 1)
