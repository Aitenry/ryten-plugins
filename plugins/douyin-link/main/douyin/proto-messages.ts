import logger from 'electron-log'
import type { DanmakuItem, DanmakuKind, UserInfo } from '../../shared/types'
import type { GiftResolver } from '../gift/catalog'
import {
  getBytes,
  getMessage,
  getMessages,
  getString,
  getVarint,
  getVarintString,
  pickString,
  pickVarintInRange,
  readMessage,
  type PbMessage
} from './protobuf'

/**
 * `im/fetch` 的 **protobuf** 推送 → 与 JSON 那条路完全一样的批次结构（纯函数）。
 *
 * 为什么必须有这一份（用户 2026-10 实测「实时里面没有任何内容」的根因）：
 * 同一个 `im/fetch` 接口，**`resp_content_type=json`（默认）只回「房间级」消息**
 * （`WebcastRoomMessage` / `WebcastRoomDataSyncMessage`），
 * 而 `resp_content_type=protobuf` 回**全量**：`WebcastMemberMessage`（进场）、
 * `WebcastRoomStatsMessage`（在线人数）、直播排行、连麦小玩法……
 * 两个房间连着采 40 轮对比：JSON 模式 0 条用户消息，protobuf 模式一次就 21 条消息。
 * 所以 protobuf 才是主路，JSON 只当兜底。
 *
 * 顺带：protobuf 响应里还带着服务端下发的 **`push_server`（字段 10/14）与 `fetch_type=1`**
 * ——也就是「去这个 wss 地址收推送」的官方指示（`./danmaku.ts` 用它尝试升级到 websocket）。
 *
 * 字段号来源：老版本用 CDP 截真机 ws 帧时 dump 出来的（见文件末尾对照表），
 * 这次的 protobuf 实测又核对了一遍（MemberMessage 的 2=user、3=memberCount 等）。
 */

/** WebcastResponse 顶层里我们要的东西 */
export interface ProtoResponse {
  batch: ProtoBatch
  /** 服务端下发的推送地址（没有则为空串） */
  pushServer: string
  /** `fetch_type`：1 = Socket（服务端在示意可以升级到 ws） */
  fetchType: number
  /** 增量游标（字段 2） */
  cursor: string
  /** 增量上下文（字段 5）：下一次请求要带回去 */
  internalExt: string
  /** 服务端建议的轮询间隔（字段 3，毫秒） */
  intervalMs: number
}

export interface ProtoBatch {
  items: DanmakuItem[]
  users: UserInfo[]
  roomEnded: boolean
  micUserIds: string[] | null
  methods: Record<string, number>
}

let nextId = 1

/** 解一份 protobuf 响应（永不抛错：单条解不动只跳过那一条） */
export function decodeProtoResponse(buf: Buffer, gifts?: GiftResolver): ProtoResponse {
  const empty: ProtoBatch = { items: [], users: [], roomEnded: false, micUserIds: null, methods: {} }
  const fallback: ProtoResponse = {
    batch: empty,
    pushServer: '',
    fetchType: 0,
    cursor: '',
    internalExt: '',
    intervalMs: 0
  }
  if (!buf || buf.length === 0) return fallback
  try {
    const root = readMessage(buf)
    const items: DanmakuItem[] = []
    const users = new Map<string, UserInfo>()
    const methods: Record<string, number> = {}
    let roomEnded = false
    let micUserIds: string[] | null = null
    for (const message of getMessages(root, 1)) {
      const method = getString(message, 1, 64) ?? ''
      const payload = getBytes(message, 2)
      if (!method || !payload) continue
      methods[method] = (methods[method] ?? 0) + 1
      const decoded = decodeProtoMessage(method, payload, gifts)
      if (!decoded) continue
      for (const user of decoded.users) if (user.id) users.set(user.id, user)
      if (decoded.roomEnded) roomEnded = true
      if (decoded.micUserIds) micUserIds = decoded.micUserIds
      if (decoded.item) items.push(decoded.item)
    }
    const interval = getVarint(root, 3) ?? 0
    return {
      batch: { items, users: [...users.values()], roomEnded, micUserIds, methods },
      pushServer: getString(root, 10, 300) ?? getString(root, 14, 300) ?? '',
      fetchType: getVarint(root, 6) ?? 0,
      cursor: getString(root, 2, 300) ?? '',
      internalExt: getString(root, 5, 500) ?? '',
      intervalMs: interval > 0 ? interval : 0
    }
  } catch {
    return fallback
  }
}

interface ProtoDecoded {
  item: DanmakuItem | null
  users: UserInfo[]
  roomEnded: boolean
  micUserIds: string[] | null
}

const nothing = (): ProtoDecoded => ({ item: null, users: [], roomEnded: false, micUserIds: null })

/** 每种消息里的 `User` 位置（真机 dump 实测；认不出来再用扫描兜底） */
const USER_FIELDS: Record<string, number[]> = {
  WebcastChatMessage: [2],
  WebcastEmojiChatMessage: [2],
  WebcastMemberMessage: [2],
  WebcastSocialMessage: [2],
  WebcastLikeMessage: [5, 2],
  WebcastGiftMessage: [7, 2]
}

/** 单条消息 → 一行 + 里面的用户（不认识的 method 返回 null） */
export function decodeProtoMessage(
  method: string,
  payload: Buffer,
  gifts?: GiftResolver
): ProtoDecoded | null {
  let msg: PbMessage
  try {
    msg = readMessage(payload)
  } catch {
    return null
  }
  const user = findUser(msg, method)
  const nickname = user?.nickname ?? ''
  const userId = user?.id ?? ''
  const withUser = (users: UserInfo[]): UserInfo[] => users

  switch (method) {
    case 'WebcastChatMessage':
    case 'WebcastEmojiChatMessage': {
      const text = pickString(msg, [3, 4, 5], 200) ?? ''
      if (!text && !nickname) return null
      return { ...nothing(), item: item('chat', nickname, userId, text, 0), users: withUser(user ? [user] : []) }
    }
    case 'WebcastMemberMessage': {
      const count = getVarint(msg, 3) ?? 0
      return { ...nothing(), item: item('member', nickname, userId, '', count), users: withUser(user ? [user] : []) }
    }
    case 'WebcastLikeMessage': {
      const count = pickVarintInRange(msg, [2, 3], 0, 100000) ?? 0
      return { ...nothing(), item: item('like', nickname, userId, '', count), users: withUser(user ? [user] : []) }
    }
    case 'WebcastSocialMessage':
      return { ...nothing(), item: item('social', nickname, userId, '', 0), users: withUser(user ? [user] : []) }
    case 'WebcastGiftMessage':
      return decodeProtoGift(msg, user, gifts)
    case 'WebcastLinkmicOrderSingMessage':
      // 语音房「点歌」：房间里显示成「X 送了 想听 Y 演唱」，归到礼物这一类（见下面的解码器）
      return decodeProtoOrderSing(msg, gifts)
    case 'WebcastRoomStatsMessage': {
      // 在线人数（JSON 模式根本收不到这条）：4 是展示串（"31在线观众"），5 是数字
      const total = pickVarintInRange(msg, [5, 9], 0, 100000000) ?? 0
      const text = pickString(msg, [4], 24) ?? (total > 0 ? String(total) : '')
      if (!text) return null
      return { ...nothing(), item: item('stats', '', '', text, total) }
    }
    case 'WebcastRoomUserSeqMessage': {
      // 7 = totalUserStr（"32在线观众"）、3 = popStr；拿不到就用数字
      const total = getVarint(msg, 2) ?? 0
      const text = pickString(msg, [7, 3], 24) ?? (total ? String(total) : '')
      if (!text) return null
      return { ...nothing(), item: item('stats', '', '', text, total) }
    }
    case 'WebcastRoomMessage': {
      // 房间级提示（进房欢迎语等）：**空内容不要占一行**（消息体很常见地只带个空串）
      const text = getString(msg, 2, 200) ?? ''
      if (!text.trim()) return null
      return { ...nothing(), item: item('system', '', '', text, 0) }
    }
    case 'WebcastControlMessage': {
      const status = getVarint(msg, 2) ?? 0
      return { ...nothing(), item: item('control', '', '', status === 3 ? 'ended' : 'changed', status) }
    }
    case 'WebcastRoomDataSyncMessage':
      return decodeProtoDataSync(msg)
    default:
      maybeDumpUnknown(method, payload)
      return null
  }
}

/**
 * 礼物消息（`WebcastGiftMessage`）。
 *
 * ⚠️ 字段号的来源要说清楚（本仓库的纪律是「宁可没有，不给错数」）：
 * 这几条**不是**本机抓到的真帧量出来的——2026-10 对着语音房连采了两条通道（HTTP 轮询与页面 ws，
 * 各几十分钟），`WebcastGiftMessage` **一条都没出现**（房间里肉眼可见的「X 送了…」是点歌，
 * 见下面的 `decodeProtoOrderSing`）。所以这里的 `5 = repeatCount`、`6 = comboCount`、`7 = user`、
 * `15 = gift(GiftStruct)`，以及 `GiftStruct` 的 `2 = describe`、`12 = diamondCount`、`16 = name`，
 * 取的是社区公开的 webcast proto 定义（与抖音服务端一致的那份字段号表），
 * 并按「猜错也不给错数」的口径实现：**只有 `diamondCount` 明确解出来才显示价值，否则一律 0 = 未知**。
 *
 * 抓到真礼物帧之后要做的第一件事：用 `spike/decoder-check.mjs --frame=WebcastGiftMessage:<hex>`
 * 把它喂回这里，核对上面这几个字段号，再把这段注释改成「实测」。
 *
 * 显示口径：
 * - 正文 = 礼物名（`name`，拿不到退回 `describe`；两个都没有就留空，行上只显示昵称）；
 * - 数量 = `repeatCount`（缺省 1：免费礼物/单发消息常常不带这个字段）；
 * - 抖币价值 = `diamondCount × 数量`；`diamondCount` 拿不到就是 **0 = 未知**，
 *   界面据此显示「价值未知」而不是「0 抖币」；
 * - **收礼人** = `8 = toUser`（谁收到了这份礼物）。
 *
 * 连击不单独成一列：`repeatEnd = 0` 的连击服务端会**逐条推增量**，逐条落库本来就是逐条明细，
 * 再合成一列反而会把「这一条到底送了几个」搞乱。
 */
function decodeProtoGift(msg: PbMessage, user: UserInfo | null, gifts?: GiftResolver): ProtoDecoded {
  const gift = getMessage(msg, 15)
  const nickname = user?.nickname ?? ''
  const toUser = parseProtoUser(getMessage(msg, 8))
  const frameName = (gift ? (pickString(gift, [16, 2], 40) ?? '') : '').trim()
  const frameUnit = gift ? (pickVarintInRange(gift, [12], 0, 1000000) ?? 0) : 0
  const giftId = (gift ? (getVarint(gift, 5) ?? 0) : 0) || (getVarint(msg, 2) ?? 0)
  const hit = giftId > 0 ? gifts?.resolve(giftId) : undefined
  // 帧里同时给了 id 和价：顺手做一次「帧 vs 官方目录」的运行时自检（不一致会在日志里 warn）
  if (giftId > 0 && frameUnit > 0) gifts?.noteFramePrice?.(giftId, frameUnit)
  const name = frameName || hit?.name || ''
  const unit = frameUnit || hit?.diamonds || 0
  const repeat = pickVarintInRange(msg, [5], 1, 100000) ?? 1
  if (!name && !nickname) return nothing()
  const base = item('gift', nickname, user?.id ?? '', name, repeat, unit * repeat)
  return {
    ...nothing(),
    item: { ...base, toUser: toUser?.nickname ?? '', toUserId: toUser?.id ?? '' },
    users: [...(user ? [user] : []), ...(toUser ? [toUser] : [])]
  }
}

/**
 * 点歌（`WebcastLinkmicOrderSingMessage`）：语音/聊天室里「点了歌」那条礼物栏消息。
 *
 * **为什么把它归到礼物这一类**（而不是新开一个类型）：房间里它的显示就是
 * 「X 送了 想听 Y 演唱」——用户看到的那一条就在礼物栏里；而真正的 `WebcastGiftMessage`
 * 在这类房间的推送里实测**一条都没有**（2026-10：HTTP 轮询 420s 收到 28 种消息、
 * 页面 ws 收到 79 帧/100s，两边都没见过礼物帧，但房间里肉眼能看到送礼/点歌）。
 * 只做后者，这个房间的「礼物」页签会永远是空的。
 *
 * 两条通道**都**会推这条点歌消息（实测：HTTP 抓 3 条、ws 抓 3 条，msgId 能对上），
 * 所以解码放在这里（两条通道共用 `decodeProtoResponse`）就够，不必依赖 ws。
 *
 * 字段号实测（2026-10，真帧喂回 `spike/decoder-check.mjs --frame=…` 核对过）：顶层 `2` 是**事件类型**，
 * 同一首歌会连着来几种：
 * - `2 = 4`：**点歌本身**，payload 在 `6` —— `6.1` 单号串 `发送者id_歌手id_单号_0_歌曲id_1_Normal`、
 *   `6.2` 歌曲状态、`6.3` **歌手的完整 `User`**、`6.4` 时间（秒）、`6.6` 歌曲封面。**这条才解码**；
 * - `2 = 5`：这首歌的**播放状态变更**（payload 在 `7`：`7.2` 歌曲/MV、`7.3` 状态文案如「MV已被切换」、
 *   `7.4` 同一个单号串、`7.5` 歌手 id）——它不是一条新点歌，解出来只会把列表刷满，所以**跳过**。
 *
 * 单号串的第一段就是**送出这份点唱礼物的人**（`item.userId`）。这不是猜的，同一份抓帧日志里能对上两次
 * （2026-10，`spike/ws-spike.mjs` 的 `WebcastRoomRankMessage` 里带着用户 id→昵称）：
 * - 单号串 `58709692971_7667087264728728634_…`（歌手 `摇尾乞怜ఇ`）+ 榜单里 `58709692971 = 皓晨`
 *   → 房间里显示的就是「皓晨 送了 想听 摇尾乞怜ఇ 演唱」（用户当时看到的正是这条）；
 * - 单号串 `3540905398897175_2965843922913211_…`（歌手 `困ఇ`）+ 榜单里 `3540905398897175 = 无Wei`
 *   → 「无Wei 送了 想听 困ఇ 演唱」。
 *
 * 三条诚实性约束：
 * - **送礼人的昵称在这一帧里，但要往下挖两层**：`6.5.1.2` 是送礼人的完整 `User`
 *   （实测：`6.5.1.2.1 = 97531140566`、`6.5.1.2.3 = 「少走点弯路🪀」`，与单号串第一段同一个 id），
 *   `6.5.1.1` 是**收礼人**（= 歌手，`6.5.1.1.1 = 1249525342678500 = 「VVఇ」`，也就是 `6.3`）。
 *   两个 `User` 都记下来；万一老帧里没有这份记录，退回单号串第一段当 id，
 *   昵称再由中枢用我们自己的数据补（`main/monitor/hub.ts` 的 `resolveGiftSenders`）；
 * - **点唱礼物的名字与价格以官方目录为准**：帧里只有礼物 id（`6.5.1.5`，实测 3200）和一个
 *   **场景标签**（`6.5.1.10` = 「点唱礼物」——它**不是**礼物名：同一房间里不同的人点歌用的是
 *   不同的礼物）。名字与价格按 id 查 `../gift/catalog.ts`（官方 `webcast/gift/list/`，
 *   1282 件、免签名）：实测 `id = 3200` = 「爱的纸鹤 = 99 抖币」，与帧里 `6.5.1.6 = 99` 一致；
 *   目录查不到时才退回帧里的标签与价格。帧价与目录不一致会由目录那边写一条 warn（运行时自检）。
 *   `6.5.2 = { 2: 1000, 3: 4 }` 至今没有对得上的解释，**不用**；
 * - `2 = 5` 那几帧也带同一个单号串，但它们是播放状态变更，不是新的送礼——照旧跳过。
 */
function decodeProtoOrderSing(msg: PbMessage, gifts?: GiftResolver): ProtoDecoded {
  const payload = getMessage(msg, 6)
  if (!payload) return nothing()
  const singer = parseProtoUser(getMessage(payload, 3))
  // 6.5 = 这份点歌礼物的记录；6.5.1 = 记录本体
  // （1 收礼人 User、2 送礼人 User、3 单号串、5 礼物 id、6 单个抖币价、10 场景标签）
  const envelope = getMessage(payload, 5)
  const record = envelope ? getMessage(envelope, 1) : undefined
  const recipient = (record ? parseProtoUser(getMessage(record, 1)) : null) ?? singer
  const sender = record ? parseProtoUser(getMessage(record, 2)) : null
  const key = (record ? getString(record, 3, 160) : '') || (getString(payload, 1, 160) ?? '')
  const label = (record ? getString(record, 10, 40) : '') ?? ''
  const giftId = record ? (getVarint(record, 5) ?? 0) : 0
  const frameUnit = record ? (pickVarintInRange(record, [6], 0, 10000000) ?? 0) : 0
  /**
   * 同一个点歌单会**反复推**：只有「刚点下去」那条带礼物记录（`6.5.1`），后面几条只有单号串与歌手
   * （实测：同一单号串先来带记录的、后来不带；库里因此出现「同一单两行、一行没名字」）。
   * 所以这里**按单号串去重**：已经有过带记录的那条，就不再为同一单号串补一条没有名字的。
   */
  const orderKey = orderSingKey(key)
  if (!record && orderKey && seenOrders.has(orderKey)) return nothing()
  if (record && orderKey) {
    seenOrders.add(orderKey)
    if (seenOrders.size > ORDER_MEMORY) {
      const oldest = seenOrders.values().next().value
      if (oldest) seenOrders.delete(oldest)
    }
  }
  /**
   * 名字与价格**以官方目录为准**（帧里只有 id 和一个场景标签「点唱礼物」，
   * 而同一个房间里不同的人点歌用的是不同的礼物——截图里就有独角兽/跑车两种）。
   * 目录查不到时退回帧里的标签与价格；连礼物记录都没有的帧退回房间自己的说法
   * 「想听 X 演唱」（别留一行空白正文）。
   */
  const hit = giftId > 0 ? gifts?.resolve(giftId) : undefined
  if (giftId > 0 && frameUnit > 0) gifts?.noteFramePrice?.(giftId, frameUnit)
  const name = hit?.name || label || (recipient?.nickname ? `想听 ${recipient.nickname} 演唱` : '')
  const unit = hit?.diamonds || frameUnit
  const senderId = sender?.id ?? orderSingSenderId(key)
  const base = item('gift', sender?.nickname ?? '', senderId, name, 1, unit)
  const users = [sender, recipient, singer].filter((entry): entry is UserInfo => Boolean(entry?.id))
  const unique = new Map(users.map((entry) => [entry.id, entry]))
  return {
    ...nothing(),
    item: { ...base, toUser: recipient?.nickname ?? '', toUserId: recipient?.id ?? '' },
    users: [...unique.values()]
  }
}

/** 「最近见过的点歌单号串」的上限（只为去重，一场直播几千单也不至于涨到哪去） */
const ORDER_MEMORY = 300
const seenOrders = new Set<string>()

/** 单号串去掉「歌曲 id」那段之前的整串都算同一单（`6.1` 与 `6.5.1.3` 是同一个串） */
function orderSingKey(key: string): string {
  return /^\d+_\d+_\d+/.test(key) ? key : ''
}

/**
 * 单号串 `发送者id_歌手id_点歌单id_0_歌曲id_1_Normal` 的第一段（送出礼物的人）。
 * 只在它**确实是一串数字**时才认（认不出来就返回空串，界面上显示未知用户，而不是写半截垃圾）。
 */
function orderSingSenderId(key: string): string {
  const first = key.split('_')[0] ?? ''
  return /^\d{4,}$/.test(first) ? first : ''
}

/**
 * 榜单/贡献类消息的字段号**仍未实测**（`WebcastRoomRankMessage` / `WebcastLinkerContributeMessage` /
 * `WebcastGuestBattleMessage` / `WebcastRanklistHourEntranceMessage`）。
 *
 * 为什么先只做「dump」不做解码：这些结构给的是**本房间累计值**，字段号猜错就是把错误数字写进
 * 用户榜（本插件的原则是宁可没有、不给错数）。所以先用环境变量开诊断，真机跑一轮把字段号钉死，
 * 再回来补解码器。
 *
 * 开法：`DOUYIN_DUMP_UNKNOWN=1` 启动应用，日志里会出现 `[douyin-link][dump] <method> …`。
 */
const DUMP_METHODS = new Set([
  'WebcastRoomRankMessage',
  'WebcastLinkerContributeMessage',
  'WebcastGuestBattleMessage',
  'WebcastRanklistHourEntranceMessage',
  'WebcastLinkmicOrderSingScoreMessage'
])

function maybeDumpUnknown(method: string, payload: Buffer): void {
  if (process.env.DOUYIN_DUMP_UNKNOWN !== '1') return
  if (!DUMP_METHODS.has(method)) return
  try {
    const msg = readMessage(payload)
    const fields = [...msg.fields.entries()]
      .map(([no, list]) => `${no}:${list.map((value) => (value.kind === 'bytes' ? `b(${value.value.length})` : value.kind === 'varint' ? `v(${value.value})` : value.kind)).join('|')}`)
      .join(' ')
    logger.info(`[douyin-link][dump] ${method} len=${payload.length} fields=${fields}`)
    logger.info(`[douyin-link][dump] ${method} hex=${payload.subarray(0, 256).toString('hex')}`)
  } catch {
    /* dump 只是诊断，失败无所谓 */
  }
}

/** 房间数据同步：麦位表（`syncKey` 在 3，`payload` 在 5） */
function decodeProtoDataSync(msg: PbMessage): ProtoDecoded {
  const syncKey = getString(msg, 3, 64) ?? ''
  const out = nothing()
  if (!/MicDisplayInfo/i.test(syncKey)) return out
  const payload = getMessage(msg, 5)
  if (!payload) return out
  out.micUserIds = collectMicUserIds(payload)
  return out
}

/**
 * 从麦位同步结构里收集用户 id：逐层下钻 `field 2`，直到某一层是「重复的麦位条目」。
 *
 * 判据（包装层与条目层的区别）：包装层的 `field 2` 子消息里有 `field 1`（房间 id），
 * 而麦位条目的 `field 2` 子消息里没有。只看「字段 1 是不是大数字」会撞上房间 id
 * （19 位，和用户 id 一样长），所以必须用结构判据。
 */
function collectMicUserIds(root: PbMessage): string[] {
  let node: PbMessage | undefined = root
  for (let depth = 0; depth < 5 && node; depth += 1) {
    const entries = getMessages(node, 2)
    if (entries.length > 0 && entries.every(isSeatEntry)) {
      return entries.map((entry) => getVarintString(entry, 1) ?? '').filter((id) => id.length > 0)
    }
    node = getMessage(node, 2)
  }
  return []
}

function isSeatEntry(entry: PbMessage): boolean {
  const id = getVarintString(entry, 1)
  if (!id || id === '0') return false
  const meta = getMessage(entry, 2)
  if (!meta) return false
  return getVarint(meta, 1) === undefined
}

/** 找消息里的 `User`：先按实测字段号取，取不到再扫一遍字节字段认「字段 3 是合法昵称」的那个 */
function findUser(msg: PbMessage, method: string): UserInfo | null {
  for (const field of USER_FIELDS[method] ?? []) {
    const parsed = parseProtoUser(getMessage(msg, field))
    if (parsed?.nickname) return parsed
  }
  for (const list of msg.fields.values()) {
    for (const value of list) {
      if (value.kind !== 'bytes' || value.value.length < 4) continue
      const sub = readMessage(value.value)
      const nickname = getString(sub, 3, 60)
      if (nickname) {
        const parsed = parseProtoUser(sub)
        if (parsed) return parsed
      }
    }
  }
  return null
}

/** `User`（protobuf）→ 静态信息（字段号真机 dump 实测，见文件末尾对照表） */
export function parseProtoUser(user: PbMessage | undefined): UserInfo | null {
  if (!user) return null
  const id = getVarintString(user, 1) ?? ''
  if (!id || id === '0') return null
  const shortId = getVarintString(user, 2) ?? ''
  const follow = getMessage(user, 22)
  const payGrade = getMessage(user, 23)
  let honorLevel = payGrade ? (getVarint(payGrade, 6) ?? 0) : 0
  const fansClub = getMessage(user, 24)
  const fansClubData = fansClub ? getMessage(fansClub, 1) : undefined
  let fansClubLevel = fansClubData ? (getVarint(fansClubData, 2) ?? 0) : 0

  const badges: string[] = []
  for (const fieldNo of [61, 21]) {
    for (const badge of getMessages(user, fieldNo)) {
      const info = getMessage(badge, 8)
      const text = info ? (getString(info, 4, 40) ?? '') : ''
      const level = info ? (getVarint(info, 3) ?? 0) : 0
      const type = getVarint(badge, 6) ?? 0
      if (type === 1 && level > 0 && honorLevel === 0) honorLevel = level
      if (type === 7 && level > 0 && fansClubLevel === 0) fansClubLevel = level
      if (text && !badges.includes(text)) badges.push(text)
    }
    if (badges.length > 0) break
  }

  return {
    id,
    displayId: getString(user, 38, 40) ?? shortId,
    nickname: getString(user, 3, 60) ?? getString(user, 68, 60) ?? '',
    gender: getVarint(user, 4) ?? 0,
    signature: getString(user, 5, 200) ?? '',
    city: pickString(user, [14, 63], 40) ?? '',
    avatar: pickProtoAvatar(user),
    following: follow ? (getVarint(follow, 1) ?? 0) : 0,
    follower: follow ? (getVarint(follow, 2) ?? 0) : 0,
    honorLevel,
    fansClubLevel,
    badges: badges.slice(0, 4),
    secUid: getString(user, 46, 200) ?? ''
  }
}

/** 头像：优先大图（11），退化到中图（10）/ 缩略图（9）；只认 https 的那条 url_list */
function pickProtoAvatar(user: PbMessage): string {
  for (const fieldNo of [11, 10, 9]) {
    const image = getMessage(user, fieldNo)
    if (!image) continue
    const urls: string[] = []
    for (const list of image.fields.values()) {
      for (const value of list) {
        if (value.kind !== 'bytes') continue
        const text = value.value.toString('utf8')
        if (text.startsWith('http')) urls.push(text)
      }
    }
    const https = urls.find((url) => url.startsWith('https://'))
    if (https) return https.slice(0, 300)
    if (urls.length > 0) return urls[0].slice(0, 300)
  }
  return ''
}

function item(
  kind: DanmakuKind,
  user: string,
  userId: string,
  text: string,
  count: number,
  diamonds = 0
): DanmakuItem {
  // 收礼人只有礼物用得到，先给空串；礼物那两个解码器再补 `toUser` / `toUserId`
  return { id: nextId++, kind, user, userId, text, count, diamonds, toUser: '', toUserId: '', at: Date.now() }
}

/** 测试用：重置自增序号与「见过的点歌单」 */
export function __resetProtoIds(): void {
  nextId = 1
  seenOrders.clear()
}

/**
 * 字段号对照（**真机 dump 实测**，2026-10 又用 protobuf 响应核对过一遍）：
 *
 * WebcastResponse: 1 messages, 2 cursor, 3 fetchInterval, 5 internalExt, 6 fetchType,
 *                  10/14 pushServer
 * Message: 1 method, 2 payload
 * Common: 1 method, 2 msgId, 3 roomId, 4 createTime, 6 →（成员消息里是 1）
 * User: 1 id, 2 shortId, 3 nickname, 4 gender, 5 signature, 9/10/11 avatar(thumb/medium/large),
 *       14|63 city, 21|61 badges{ 1 image, 6 type, 8.3 level, 8.4 desc }, 22 followInfo,
 *       23 payGrade{ 6 level }, 24 fansClub{ 1 data{ 2 level } }, 38 displayId, 46 secUid, 68 nickname(备用)
 * WebcastChatMessage: 2 user, 3 content
 * WebcastMemberMessage: 2 user, **3 memberCount**（实测 31 = 在线人数）
 * WebcastLikeMessage: 2 count, 3 total, 5 user
 * WebcastSocialMessage: 2 user
 * WebcastGiftMessage: 2 giftId, 5 repeatCount, 6 comboCount, 7 user, 8 toUser, 9 repeatEnd,
 *                     15 gift(GiftStruct: 2 describe, 5 id, 11 type, 12 diamondCount, 16 name)
 *                     —— 来源是社区公开的 webcast proto（本机**还没抓到真礼物帧**，见 decodeProtoGift）
 * WebcastLinkmicOrderSingMessage: 顶层 2 = 事件类型（**4 = 点歌**，payload 在 6：单号串 6.1、
 *                     歌手 User 6.3、封面 6.6；**5 = 播放状态变更**，payload 在 7，跳过不解码）
 *                     —— 实测；发送者的 User 不在帧里
 * WebcastGiftMessage 的字段号来源见 `decodeProtoGift` 上方（社区 proto，本机尚未抓到真礼物帧）
 * WebcastRoomStatsMessage: 2/3/4 展示串（"31"、"31在线观众"）, 5 count（JSON 模式收不到这条）
 * WebcastRoomUserSeqMessage: 2 total, 3 popStr, 7 totalUserStr, 8 totalStr
 * WebcastRoomMessage: 2 content（进房欢迎语这类房间级提示）
 * WebcastRoomDataSyncMessage: 2 roomID, 3 syncKey, 4 version, 5 payload（麦位表在
 *                      syncKey=RoomLinkmicMicDisplayInfoSyncData 的 payload 里）
 * WebcastControlMessage: 2 status（3 = 关播）
 */