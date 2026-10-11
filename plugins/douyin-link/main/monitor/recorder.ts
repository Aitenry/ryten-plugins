import type {
  DanmakuItem,
  DanmakuKind,
  LiveInteractions,
  UserInfo,
  UserProfile,
  UserStats
} from '../../shared/types'
import { resolveGiftRecipient } from '../../shared/gift-recipient'
import type { MessageRow, MinuteDeltaRow, UserDeltaRow } from '../db/mapper'

/**
 * 一个房间的**记录器**：把采集器吐出来的消息，变成三类可以批量落库的增量
 * （消息流水 / 分钟桶 / 用户统计），同时维护界面要用的内存视图（最近弹幕、本场计数、速率）。
 *
 * 为什么按批攒、不逐条写库：弹幕是秒级流水（一次监控几十分钟就上万条），
 * 一条一条 INSERT 会把 PGlite 打满；这里只把增量放在内存里，由主进程中枢每 2 秒
 * （或攒够 200 行）统一 flush 一次。
 *
 * 两个口径要记住（界面上的两套数字就是它们）：
 * - **本场**（`counters` / `received` / `rate`）：这次监控从开始到现在的数字，重启清零；
 * - **累计**：库里的数字（跨会话累加），由数据库查询给出，不在这里维护。
 */

/** 参与互动计数的类型（stats / control / system 不入库：它们不是互动，是状态） */
const COUNTED: DanmakuKind[] = ['chat', 'member', 'like', 'social', 'gift']

/** 速率滑窗（最近 60 秒的消息时刻） */
const RATE_WINDOW_MS = 60000
/** 一个房间的内存用户上限（一场直播几万人进场，不设上限就是泄漏） */
const USER_CAP = 4000
/** 在场清单上限（「在线观众」页签只按需展示，但也不该无限涨） */
const PRESENCE_CAP = 3000
/** 单次 flush 最多写多少行消息（剩下的留到下一轮） */
export const FLUSH_ROWS = 200

/**
 * 记录器内部取「现在」的唯一入口。
 *
 * 为什么要包一层（2026-10-11 加工装时踩到的）：收礼人推断带一个**观察窗口**（见
 * `shared/gift-recipient.ts`），而窗口是「落库那一刻 − 这一帧进来的时刻」——
 * 工装要验的正是跨过窗口之后的行为。原来各处直接 `Date.now()`，而 `ingest` 把时刻**捕获在闭包里**，
 * 于是「先把钟拨快、再 takeMessages」这种顺序根本验不出来（工装读到的两个时刻一样，
 * 窗口永远不过期）。现在统一走这里，工装可以 `setNow()` 注入虚拟时钟。
 */
let clock: () => number = () => Date.now()

/** 测试用：注入虚拟时钟（传 `null` 恢复真实时钟） */
export function setNow(source: (() => number) | null): void {
  clock = source ?? ((): number => Date.now())
}

const emptyCounters = (): LiveInteractions => ({
  chat: 0,
  enter: 0,
  like: 0,
  follow: 0,
  gift: 0
})

const emptyStats = (): UserStats => ({ chat: 0, enter: 0, like: 0, follow: 0, gift: 0, diamonds: 0 })

/** 本场某个用户：静态信息（本场见到的最新值）+ 本场的增量统计 + **本场送出的抖币总额** */
interface SessionUser {
  profile: UserProfile
  delta: UserStats
}

/** 在场证据：本场这个人第一次/最后一次出现（「在线观众」的「本场」那一列用它） */
export interface PresenceEntry {
  userId: string
  firstSeen: number
  lastSeen: number
}

export class RoomRecorder {
  readonly webRid: string
  /** 最近弹幕（旧 → 新；界面拿它做首屏与「切回房间」） */
  recent: DanmakuItem[] = []
  counters: LiveInteractions = emptyCounters()
  /** 本场收到的消息条数（含不入库的 stats/control） */
  received = 0
  /** 本场出现过的用户数 */
  users = 0
  /** 本场在库里的会话 id */
  sessionId = 0
  startedAt = 0
  /** 本场出现的用户 id（分钟桶的「活跃用户」与用户榜的筛选都用它） */
  readonly sessionUserIds = new Set<string>()

  private cap = 400
  private rateMarks: number[] = []
  private userMap = new Map<string, SessionUser>()
  private touched = new Set<string>()
  /**
   * **待写库的用户**（出队语义，见 `takeUserDeltas`）：统计有变化、或静态字段有更新时加进来。
   *
   * 口径与旧版一致——**只有在本场真发过言/进过场的人**才写档案（同一帧里顺带带出来的
   * 送礼对象那种「只有资料、没有互动」的人不写）。为什么要有这个集合：老版本靠
   * 「扫 userMap 取前 400 个」决定写谁，结果前 400 个固定占满配额、后面出现的人永远写不进库
   * （2026-10-11 修的 bug，真库证据见 `takeUserDeltas` 的注释）。
   */
  private pendingUsers = new Set<string>()
  /**
   * 待写库的消息行。礼物多带一个**推算用的时刻**（`noRecipientSince`）：
   * 帧里没给收礼人时，收礼人要到 `takeMessages()` 才定（见那里的注释），
   * 而「观察窗口」的起点是**这一帧进来的时刻**，所以要跟着行走。
   */
  private messages: Array<MessageRow & { noRecipientSince?: number }> = []
  private minutes = new Map<number, MinuteDeltaRow>()
  private minuteUsers = new Map<number, Set<string>>()
  /** 本场「在场」证据（≠ sessionUserIds：只有 id 的来源也要记，见 PresenceEntry） */
  private presence = new Map<string, PresenceEntry>()
  /** 麦位：用户 id → 麦位序号（1 起）。聊天室才有，重连后由推送刷新 */
  private micSeats = new Map<string, number>()
  /**
   * **收礼人推断的房间上下文**（见 `shared/gift-recipient.ts`）。
   *
   * 帧里不给收礼人时（个播一律不给，真库实测 4077/4077），落库前得补上，否则收礼物榜整张空着。
   * 主播与窗内麦位表由中枢通过 `setAnchor` / `setMicUsers` 灌进来。
   */
  private anchorId = ''
  private anchorName = ''
  /** 这一场**第一次**看到没有收礼人的礼物帧的时刻（0 = 还没见过；观察窗口从它算起） */
  private noRecipientSince = 0
  /** 麦位表是否同步到过（判断「没有麦位」是「个播」还是「语音房还没同步」） */
  private micSynced = false
  /**
   * 点歌单号 → 这一单**已经算进本场数字**的抖币。同一个单会推两次（先没记录、后带记录），
   * 本场礼物条数只能算一次，抖币按差额补（见 `orderContribution`）。
   */
  private orderGifts = new Map<string, number>()

  constructor(webRid: string) {
    this.webRid = webRid
  }

  /** 开始一次监控会话：本场数字清零，库里的累计不动 */
  begin(sessionId: number, cap: number, startedAt = clock()): void {
    this.sessionId = sessionId
    this.cap = Math.max(50, cap)
    this.startedAt = startedAt
    this.counters = emptyCounters()
    this.received = 0
    this.rateMarks = []
    this.userMap.clear()
    this.touched.clear()
    this.pendingUsers.clear()
    this.sessionUserIds.clear()
    this.messages = []
    this.minutes.clear()
    this.minuteUsers.clear()
    this.presence.clear()
    this.micSeats.clear()
    this.micSynced = false
    this.noRecipientSince = 0
    this.orderGifts.clear()
  }

  /**
   * 更新麦位（聊天室的 `RoomLinkmicMicDisplayInfoSyncData`）。
   *
   * 整份替换：这份同步是「当前麦位表」的全量快照，不是增量——留着旧的会让下麦的人永远在麦上。
   * 同时把这些 id 记进「在场」（他们一定在这个房间里）。
   */
  setMicUsers(userIds: string[], at = clock()): void {
    this.micSynced = true
    this.micSeats.clear()
    userIds.forEach((id, index) => {
      if (!id) return
      if (!this.micSeats.has(id)) this.micSeats.set(id, index + 1)
      this.notePresence(id, at)
    })
  }

  /**
   * 记下主播（收礼人推断的兜底人选，见 `shared/gift-recipient.ts`）。
   *
   * 由中枢在**解析到主播资料之后**调用（`applyResolved`）与**开会话时**调用——两处都得调：
   * `begin()` 会清掉上下文（见上），而主播资料可能比会话先到。
   *
   * 顺带把主播写进用户档案表（只有 id + 昵称、统计全 0）：榜上的收礼人是**按 id 聚合**的，
   * 昵称走「消息里的 `to_user_name` → 用户表的 `nickname`」这条兜底链——不写这一行，
   * 个播的收礼物榜就会显示成一串抖音号。
   */
  setAnchor(user: UserInfo | null | undefined): void {
    if (!user?.id) return
    this.anchorId = user.id
    this.anchorName = user.nickname || this.anchorName
    if (this.userMap.has(user.id)) return
    this.userMap.set(user.id, {
      profile: { ...user, firstSeen: 0, lastSeen: 0, stats: emptyStats() },
      delta: emptyStats()
    })
    // 只排这一行档案（统计全 0）；具体什么时候出队由 `takeUserDeltas` 决定
    this.pendingUsers.add(user.id)
  }

  /** 麦位表（按麦位序） */
  micList(): Array<{ userId: string; seat: number }> {
    return [...this.micSeats.entries()]
      .map(([userId, seat]) => ({ userId, seat }))
      .sort((a, b) => a.seat - b.seat)
  }

  /** 某人的麦位序号（0 = 不在麦上） */
  seatOf(userId: string): number {
    return this.micSeats.get(userId) ?? 0
  }

  /** 本场的在场清单（「在线观众」用；按最近出现倒序） */
  presenceList(): PresenceEntry[] {
    return [...this.presence.values()].sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /** 清空内存里的最近弹幕（界面上的「清空」；库里的数据不动） */
  clearRecent(): void {
    this.recent = []
  }

  setCap(cap: number): void {
    this.cap = Math.max(50, cap)
    this.trim()
  }

  /** 本场速率（条/分，最近 60 秒的滑窗） */
  get rate(): number {
    const now = clock()
    this.rateMarks = this.rateMarks.filter((mark) => now - mark < RATE_WINDOW_MS)
    return this.rateMarks.length
  }

  /**
   * 收一批消息（采集器给的那一批），返回**有变化的用户 id**（中枢节流后推给界面）。
   *
   * 静态信息按「非空才覆盖」合并：同一个人这次出现在聊天里（不带勋章），
   * 上次出现在进场消息里（带等级），不能把记下的等级抹掉。
   */
  ingest(items: DanmakuItem[], users: UserInfo[], cap?: number): string[] {
    if (typeof cap === 'number') this.setCap(cap)
    const now = clock()

    for (const info of users) {
      if (!info.id) continue
      this.notePresence(info.id, now)
      const existing = this.userMap.get(info.id)
      if (!existing) {
        this.userMap.set(info.id, {
          profile: { ...info, firstSeen: now, lastSeen: now, stats: emptyStats() },
          delta: emptyStats()
        })
        this.touched.add(info.id)
        continue
      }
      const merged = {
        ...existing.profile,
        displayId: info.displayId || existing.profile.displayId,
        nickname: info.nickname || existing.profile.nickname,
        gender: info.gender || existing.profile.gender,
        signature: info.signature || existing.profile.signature,
        city: info.city || existing.profile.city,
        avatar: info.avatar || existing.profile.avatar,
        following: info.following || existing.profile.following,
        follower: info.follower || existing.profile.follower,
        honorLevel: info.honorLevel || existing.profile.honorLevel,
        fansClubLevel: info.fansClubLevel || existing.profile.fansClubLevel,
        secUid: info.secUid || existing.profile.secUid,
        badges: info.badges.length > 0 ? info.badges : existing.profile.badges,
        lastSeen: now
      }
      const before = existing.profile
      existing.profile = merged
      this.touched.add(info.id)
      // 静态字段真变了才排队写库（每一帧都无脑排队的话，忙房间里等于每 2 秒把同一批人重写一遍）
      if (staticChanged(before, merged)) this.pendingUsers.add(info.id)
    }

    for (const item of items) {
      this.received += 1
      this.recent.push(item)
      if (item.userId) {
        this.sessionUserIds.add(item.userId)
        this.notePresence(item.userId, item.at)
        const minuteBucket = this.minuteUsers.get(minuteOf(item.at)) ?? new Set<string>()
        minuteBucket.add(item.userId)
        this.minuteUsers.set(minuteOf(item.at), minuteBucket)
      }
      const counted = COUNTED.includes(item.kind)
      if (!counted) continue
      this.rateMarks.push(item.at)
      /** 点歌一单推两次 → 本场数字只算一次（见 `orderContribution`） */
      const order = this.orderContribution(item)
      this.bumpCounters(item, order)
      this.pushMinute(item, order)
      const recipient = this.recipientHint(item, now)
      this.messages.push({
        webRid: this.webRid,
        sessionId: this.sessionId,
        kind: item.kind,
        userId: item.userId,
        userName: item.user,
        content: item.text,
        count: item.count,
        diamonds: item.diamonds,
        toUserId: recipient.toUserId,
        toUserName: recipient.toUserName,
        orderKey: item.orderKey ?? '',
        giftRecord: item.giftRecord ?? false,
        atMs: item.at,
        ...(recipient.inferred ? { noRecipientSince: now } : {})
      })
      const user = item.userId ? this.userMap.get(item.userId) : undefined
      if (user) {
        switch (item.kind) {
          case 'chat':
            user.delta.chat += 1
            break
          case 'member':
            user.delta.enter += 1
            break
          case 'like':
            user.delta.like += 1
            break
          case 'social':
            user.delta.follow += 1
            break
          case 'gift':
            user.delta.gift += order.count
            user.delta.diamonds += order.diamonds
            break
          default:
            break
        }
        this.touched.add(item.userId)
        // 统计变了：这个人的档案行要跟着更新（累加值只有写库时才算数）
        this.pendingUsers.add(item.userId)
      }
    }

    this.trim()
    this.users = this.sessionUserIds.size
    return [...this.touched]
  }

  /** 本场某个用户的档案（界面用；累计数字要去库里查） */
  profile(userId: string): UserProfile | undefined {
    const hit = this.userMap.get(userId)
    if (!hit) return undefined
    return { ...hit.profile, stats: { ...hit.delta } }
  }

  /** 本场出现过、且有变化的用户档案（一批一批推给界面） */
  takeTouched(limit = 120): UserProfile[] {
    const ids = [...this.touched].slice(0, limit)
    this.touched.clear()
    return ids.map((id) => this.profile(id)).filter((profile): profile is UserProfile => Boolean(profile))
  }

  /* --------------------------------------------------- 落库用的增量 */

  /**
   * 取走待写的消息行（最多 FLUSH_ROWS 行，剩下的下一轮）。
   *
   * **收礼人在这里才最终定**（不是 ingest 的时候）：帧里不带收礼人的房间（个播）要走
   * 「观察窗口 → 主播」这条推断，而窗口是**按时间**算的——刚连上的头几十秒谁都不敢认。
   * 若在 ingest 时就把空值写死，窗口内的那些礼物就永远进不了收礼物榜（工装
   * `gift-recipient-check.mjs` 第一版就是这么抓出来的）。所以待写行只记住「帧里给没给」，
   * 落库这一刻用**房间此刻的上下文**（可能已经知道主播 / 已经同步到麦位）算一遍。
   */
  takeMessages(): MessageRow[] {
    if (this.messages.length === 0) return []
    const pending = this.messages.slice(0, FLUSH_ROWS)
    this.messages = this.messages.slice(pending.length)
    const now = clock()
    return pending.map((row) => {
      if (row.kind !== 'gift' || row.toUserId) return row
      /** 这一帧进来时观察窗口的起点（`recipientHint` 记的；理论上一定有，兜底 0 = 不过期） */
      const since = this.micSynced ? 0 : this.windowOrigin(row)
      const resolved = resolveGiftRecipient(
        { id: '', name: '' },
        {
          anchorId: this.anchorId,
          anchorName: this.anchorName,
          micUsers: [...this.micSeats.keys()],
          // 麦位同步过 = 语音房：窗口不再生效（麦上没人就说明这会儿真没人收）
          noRecipientSince: since
        },
        now
      )
      if (!resolved.toUserId) return row
      return { ...row, toUserId: resolved.toUserId, toUserName: resolved.toUserName }
    })
  }

  get pending(): number {
    return this.messages.length
  }

  /** 取走待写的分钟桶增量（补齐 `users` 计数） */
  takeMinutes(): MinuteDeltaRow[] {
    if (this.minutes.size === 0) return []
    const rows: MinuteDeltaRow[] = []
    for (const [minute, row] of this.minutes) {
      const bucket = this.minuteUsers.get(minute)
      rows.push({ ...row, users: bucket ? bucket.size : 0 })
    }
    this.minutes.clear()
    this.minuteUsers.clear()
    return rows
  }

  /**
   * 取走用户增量：**待写集合出队**，每轮最多 `limit` 个（没轮到的留到下一轮）。
   *
   * 为什么不是「扫一遍 userMap 取前 N 个」（2026-10-11 修的 bug，真库实测）：
   * 旧版按 userMap 的**插入序**扫，取够 400 个就 `break`，而「本场出现过」的人
   * （`sessionUserIds`，只在 `begin()` 里清）**永远**满足 active 条件 ——
   * 于是前 400 个固定占满配额，**第 401 个之后出现的人一辈子写不进库**：
   * 消息流水照写（另一条队列），档案表里没有他，档案弹窗就报「没有这个用户的档案」，
   * 而按 id 去抖音查还能查到人（那是实时接口，与本地库无关）。
   *
   * 真库证据（用户库副本，2026-10-11 排查）：
   * - 报障的那位（`108011161837` / `100400732623`）有 2 条弹幕、档案 0 行，
   *   他在那一场里是**第 554 个**首次出现的用户；
   * - 按「本场首次出现」排名切一刀：rank ≤ 400 的 400 人**全部**有档案行，
   *   rank > 400 的 244 人只有 17 人有（那 17 个来自更早的会话）；
   * - 本场人数不到 400 的会话，缺失为 0 —— 阈值吻合。
   *
   * 现在的口径：谁「有新东西要写」谁进 `pendingUsers`（发过言/进过场 → 统计变化；
   * 这一帧带来了更全的静态字段 → 字段更新），出队时**从集合里删掉**，并且**只清出队这些人的增量**。
   * 副作用是顺带干掉了旧版「前 400 个人每 2 秒被无条件 UPDATE 一遍」的空转写（忙房间约 200 行/秒）。
   */
  takeUserDeltas(limit = 400): UserDeltaRow[] {
    const rows: UserDeltaRow[] = []
    for (const id of this.pendingUsers) {
      if (rows.length >= limit) break
      // 出队：这个人的这份增量交给调用方了（写不写得成是调用方的事，不留在这里反复写）
      this.pendingUsers.delete(id)
      const entry = this.userMap.get(id)
      // 已经被内存上限挤掉的人（见 trim）：没有可写的增量了，跳过
      if (!entry) continue
      const delta = entry.delta
      rows.push({
        webRid: this.webRid,
        userId: id,
        displayId: entry.profile.displayId,
        nickname: entry.profile.nickname,
        gender: entry.profile.gender,
        signature: entry.profile.signature,
        city: entry.profile.city,
        avatar: entry.profile.avatar,
        following: entry.profile.following,
        follower: entry.profile.follower,
        honorLevel: entry.profile.honorLevel,
        fansClubLevel: entry.profile.fansClubLevel,
        badges: JSON.stringify(entry.profile.badges),
        secUid: entry.profile.secUid,
        delta: { ...delta },
        firstSeen: entry.profile.firstSeen,
        lastSeen: entry.profile.lastSeen
      })
      // 写过的增量清零（静态信息留着，下次他有新帧时再补空字段）
      entry.delta = emptyStats()
    }
    return rows
  }

  /** 释放（房间被忘掉/插件停用） */
  dispose(): void {
    this.recent = []
    this.userMap.clear()
    this.touched.clear()
    this.pendingUsers.clear()
    this.messages = []
    this.minutes.clear()
    this.minuteUsers.clear()
    this.sessionUserIds.clear()
    this.presence.clear()
    this.micSeats.clear()
  }

  /* --------------------------------------------------------- 内部 */

  /** 记一次「在场」。上限兜底：一场大直播几万人进场，不设上限就是泄漏（界面上只按需展示） */
  private notePresence(userId: string, at: number): void {
    if (!userId) return
    const hit = this.presence.get(userId)
    if (hit) {
      hit.lastSeen = Math.max(hit.lastSeen, at)
      return
    }
    if (this.presence.size >= PRESENCE_CAP) {
      // 满了先丢最早的那些（他们也已经不在场了）
      let oldestId = ''
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [id, entry] of this.presence) {
        if (entry.lastSeen < oldestAt) {
          oldestAt = entry.lastSeen
          oldestId = id
        }
      }
      if (oldestId) this.presence.delete(oldestId)
    }
    this.presence.set(userId, { userId, firstSeen: at, lastSeen: at })
  }

  /**
   * 这一行落库时该用的**观察窗口起点**。
   *
   * 取「本场第一次见到无收礼人礼物帧」的时刻，和「这一帧进来时窗口已经走了多久」两者里**更早**的那个：
   * - 只用本场起点：窗口内进来、窗口外才落库的礼物会被算成「窗外」，直接记到主播头上
   *   （其实它们在窗口内，本该等麦位表说话）；
   * - 只用每行自己的盖章：同一场的礼物分批进来时，后一批的章更晚，`now - 章` 被算小，
   *   窗口永远过不去——**个播的收礼榜又会空掉**（2026-10-11 加工装时实测到的就是这个）。
   */
  private windowOrigin(row: { noRecipientSince?: number }): number {
    const own = row.noRecipientSince ?? 0
    const session = this.noRecipientSince
    if (own > 0 && session > 0) return Math.min(own, session)
    return own || session
  }

  /**
   * 这一条消息**该给本场数字加多少**（礼物条数 / 抖币）。
   *
   * 只有点歌那一类要特殊处理：同一个单会推两次（先一条没礼物记录的、后一条带记录的，
   * 见 `../gift/merge.ts`），而界面上「本场礼物」是照礼物榜的行数核对的——
   * 一单算两次，KPI 就比榜单多出一条。所以：**条数只算第一帧，抖币按差额补**
   * （记录帧迟到时把 0 → 99 的差价补上；万一先来的那条数字更大，只补差额不为负）。
   */
  private orderContribution(item: DanmakuItem): { count: number; diamonds: number } {
    const key = item.kind === 'gift' ? (item.orderKey ?? '') : ''
    if (!key) return { count: 1, diamonds: item.diamonds }
    const before = this.orderGifts.get(key)
    if (before === undefined) {
      this.orderGifts.set(key, item.diamonds)
      return { count: 1, diamonds: item.diamonds }
    }
    if (item.diamonds > before) this.orderGifts.set(key, item.diamonds)
    return { count: 0, diamonds: Math.max(0, item.diamonds - before) }
  }

  /**
   * 这一条要落库的**收礼人候选**。
   *
   * 非礼物恒为空；礼物帧里带了收礼人就直接用它（唯一权威，也是**唯一不在落库时重算**的一种）；
   * 帧里没带就留空 + 标 `inferred`，等 `takeMessages()` 那一刻按房间上下文定（见那里的注释）。
   * 观察窗口的起点也在这里记：第一次见到「没有收礼人的礼物帧」的时刻。
   */
  private recipientHint(
    item: DanmakuItem,
    now: number
  ): { toUserId: string; toUserName: string; inferred: boolean } {
    if (item.kind !== 'gift') return { toUserId: item.toUserId, toUserName: item.toUser, inferred: false }
    if (item.toUserId) return { toUserId: item.toUserId, toUserName: item.toUser, inferred: false }
    if (this.noRecipientSince === 0) this.noRecipientSince = now
    return { toUserId: '', toUserName: '', inferred: true }
  }

  private bumpCounters(item: DanmakuItem, order: { count: number; diamonds: number }): void {
    switch (item.kind) {
      case 'chat':
        this.counters.chat += 1
        break
      case 'member':
        this.counters.enter += 1
        break
      case 'like':
        this.counters.like += 1
        break
      case 'social':
        this.counters.follow += 1
        break
      case 'gift':
        this.counters.gift += order.count
        break
      default:
        break
    }
  }

  private pushMinute(item: DanmakuItem, order: { count: number; diamonds: number }): void {
    const minute = minuteOf(item.at)
    const row =
      this.minutes.get(minute) ??
      ({
        webRid: this.webRid,
        minute,
        chat: 0,
        member: 0,
        likes: 0,
        social: 0,
        gift: 0,
        diamonds: 0,
        messages: 0,
        users: 0
      } satisfies MinuteDeltaRow)
    row.messages += 1
    switch (item.kind) {
      case 'chat':
        row.chat += 1
        break
      case 'member':
        row.member += 1
        break
      case 'like':
        row.likes += 1
        break
      case 'social':
        row.social += 1
        break
      case 'gift':
        row.gift += order.count
        row.diamonds += order.diamonds
        break
      default:
        break
    }
    this.minutes.set(minute, row)
  }

  private trim(): void {
    if (this.recent.length > this.cap) this.recent = this.recent.slice(-this.cap)
    if (this.userMap.size <= USER_CAP) return
    const sorted = [...this.userMap.values()].sort((a, b) => a.profile.lastSeen - b.profile.lastSeen)
    for (const entry of sorted.slice(0, this.userMap.size - USER_CAP)) {
      this.userMap.delete(entry.profile.id)
      this.touched.delete(entry.profile.id)
      // 人已经从内存里挤掉了：待写队列里也留不住他（写不出增量），别让它无限涨
      this.pendingUsers.delete(entry.profile.id)
    }
  }
}

/**
 * 静态字段**有没有真变化**（决定这个人要不要再排一次队去写库）。
 *
 * 为什么需要（见 `takeUserDeltas`）：本场每个用户第一次出现时已经写过一次档案，
 * 之后只在「这一帧带来了新东西」时才值得再写一次——旧版不管有没有变化，
 * 都把前 400 个人每 2 秒无条件 UPDATE 一遍（忙房间 ≈200 行/秒的纯空转）。
 */
function staticChanged(before: UserProfile, after: UserProfile): boolean {
  return (
    before.displayId !== after.displayId ||
    before.nickname !== after.nickname ||
    before.gender !== after.gender ||
    before.signature !== after.signature ||
    before.city !== after.city ||
    before.avatar !== after.avatar ||
    before.following !== after.following ||
    before.follower !== after.follower ||
    before.honorLevel !== after.honorLevel ||
    before.fansClubLevel !== after.fansClubLevel ||
    before.secUid !== after.secUid ||
    before.badges.length !== after.badges.length ||
    before.badges.some((badge, index) => badge !== after.badges[index])
  )
}

/** ms → 分钟桶号（floor(ms / 60000)，Postgres 侧直接用同一个数） */
export function minuteOf(at: number): number {
  return Math.floor(at / 60000)
}
