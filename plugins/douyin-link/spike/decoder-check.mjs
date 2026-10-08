/**
 * 解码器自检（dev-only，不参与打包）：把**按官方/实测字段号手搓的 protobuf 帧**喂给
 * **真实的解码器**（`main/douyin/proto-messages.ts`、`main/douyin/json.ts`），
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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
 * 6.1 = `发送者_歌手_单号_0_歌曲_1_Normal`、6.2 = 状态、6.3 = 歌手的 User、6.4 = 时间（秒）；
 * 6.5.1 = 点唱礼物记录（1 收礼人 User、2 送礼人 User、3 单号串、5 礼物 id、6 抖币价、10 礼物名）。
 */
const orderSingFrame = ({ sender = '送礼的人', singer = '唱歌的人', songId = 13564, price = 99, giftId = 3200 } = {}) =>
  Buffer.concat([
    pbVarint(2, 4),
    pbMessage(
      6,
      Buffer.concat([
        pbString(1, `58709692971_7667087264728728634_10000037694256230482760723_0_${songId}_1_Normal`),
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
              pbString(3, `58709692971_7667087264728728634_10000037694256230482760723_0_${songId}_1_Normal`),
              pbVarint(5, giftId),
              pbVarint(6, price),
              pbString(10, '点唱礼物')
            ])
          )
        )
      ])
    )
  ])

/**
 * 假的礼物目录（真目录是 `main/gift/catalog.ts` 从官方接口拉的 1282 件）：
 * 自检只关心「按 id 查名字与价格」这条链，所以这里给一件真礼物 + 一件虚构礼物。
 */
const fakeCatalog = (pairs = {}) => {
  const warned = []
  return {
    warned,
    resolve: (id) => pairs[id],
    noteFramePrice: (id, framePrice) => {
      const hit = pairs[id]
      if (hit && hit.diamonds !== framePrice) warned.push(`${id}:${framePrice}≠${hit.diamonds}`)
    }
  }
}

/** 一条普通弹幕（用来验证「别的消息不该带出抖币」） */
const chatFrame = ({ nickname = '说话的人', text = '你好' } = {}) =>
  Buffer.concat([pbMessage(2, user(7000000000000000001n, nickname)), pbString(3, text)])

/* ------------------------------------------------------------------ 打补丁 */

const stubPath = join(workDir, 'electron-log-stub.mjs')
writeFileSync(
  stubPath,
  'const noop = () => {}\nexport default { info: noop, warn: noop, error: noop, debug: noop }\n',
  'utf8'
)

async function bundle(entry) {
  const outfile = join(workDir, `${entry.replace(/[^\w]/g, '_')}.mjs`)
  await build({
    entryPoints: [join(ROOT, 'plugins/douyin-link/main/douyin', entry)],
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

/* -------------------------------------------------------------------- 断言 */

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`)
}

const proto = await bundle('proto-messages.ts')
const json = await bundle('json.ts')

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

/* 点歌：送礼人/收礼人的 User、礼物 id、抖币价都在 6.5.1 那份记录里；
   名字与价格**以官方目录为准**（帧里只有 id 和场景标签「点唱礼物」） */
const sing = proto.decodeProtoMessage(
  'WebcastLinkmicOrderSingMessage',
  orderSingFrame({ sender: '少走点弯路', singer: '摇尾乞怜', price: 99, giftId: 3200 })
)
check('点歌 → kind', sing.item.kind, 'gift')
check('点歌 → 送礼人（6.5.1.2 的 User）', [sing.item.user, sing.item.userId], ['少走点弯路', '58709692971'])
check('点歌 → 收礼人（6.5.1.1 的 User，= 歌手）', [sing.item.toUser, sing.item.toUserId], ['摇尾乞怜', '7667087264728728634'])
check('点歌 → 没有目录时退回帧里的标签与价', [sing.item.text, sing.item.diamonds], ['点唱礼物', 99])
check('点歌 → 送礼人 + 收礼人都进用户库', sing.users.map((u) => u.nickname).sort(), ['少走点弯路', '摇尾乞怜'])

/* 有目录时：名字与价格取自目录（real 例子：id 4353 = 跑车 = 1200 抖币） */
const catalog = fakeCatalog({ 3200: { name: '爱的纸鹤', diamonds: 99 }, 4353: { name: '跑车', diamonds: 1200 } })
const named = proto.decodeProtoMessage(
  'WebcastLinkmicOrderSingMessage',
  orderSingFrame({ giftId: 4353, price: 1200, singer: 'Snow' }),
  catalog
)
check('点歌 + 目录 → 礼物名（不是「点唱礼物」这种场景标签）', named.item.text, '跑车')
check('点歌 + 目录 → 抖币价', named.item.diamonds, 1200)
check('点歌 + 目录 → 价格一致时不告警', catalog.warned, [])

/* 帧价与目录不符 → 自检必须报警（这条读法只做过一次交叉核对） */
const mismatch = fakeCatalog({ 3200: { name: '爱的纸鹤', diamonds: 99 } })
const wrong = proto.decodeProtoMessage('WebcastLinkmicOrderSingMessage', orderSingFrame({ price: 5 }), mismatch)
check('点歌 + 目录价不符 → 写一条自检告警', mismatch.warned, ['3200:5≠99'])
check('点歌 + 目录价不符 → 仍以目录为准', wrong.item.diamonds, 99)

/* 没有那份礼物记录的老帧：礼物名/价格留空，送礼人退回单号串第一段，收礼人退回歌手 */
const oldStyle = proto.decodeProtoMessage(
  'WebcastLinkmicOrderSingMessage',
  Buffer.concat([
    pbVarint(2, 4),
    pbMessage(
      6,
      Buffer.concat([
        pbString(1, '58709692971_7667087264728728634_10000037694256230482760723_0_13564_1_Normal'),
        pbMessage(3, user(7667087264728728634n, '歌手'))
      ])
    )
  ])
)
check('老帧点歌 → 送礼人 id 仍在', oldStyle.item.userId, '58709692971')
check('老帧点歌 → 没有礼物名/价格', [oldStyle.item.text, oldStyle.item.diamonds], ['', 0])
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

/* 别的消息不该带出抖币 */
const chat = proto.decodeProtoMessage('WebcastChatMessage', chatFrame())
check('弹幕 → kind / 抖币 0', [chat.item.kind, chat.item.diamonds], ['chat', 0])

/* JSON 那条路（服务端忽略 resp_content_type 时才会走到）也得有同样的口径 */
const jsonGift = json.decodeMessageJson('WebcastGiftMessage', {
  gift: { name: '玫瑰', diamond_count: 1 },
  repeat_count: 3,
  user: { id_str: '7694190253011159818', nickname: '送花的人' }
})
check('JSON 礼物 → 名字 / 数量 / 总额', [jsonGift.item.text, jsonGift.item.count, jsonGift.item.diamonds], ['玫瑰', 3, 3])
check('JSON 弹幕 → 抖币 0', json.decodeMessageJson('WebcastChatMessage', { content: 'hi', user: { id_str: '1', nickname: 'a' } }).item.diamonds, 0)

rmSync(workDir, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项不通过`)
process.exit(failures === 0 ? 0 : 1)
