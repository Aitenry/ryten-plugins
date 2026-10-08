import type {
  DanmakuItem,
  DanmakuKind,
  LiveInteractions,
  UserInfo,
  UserProfile,
  UserStats
} from '../../shared/types'
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
const COUNTED: DanmakuKind[] = ['chat', 'gift', 'member', 'like', 'social']

/** 速率滑窗（最近 60 秒的消息时刻） */
const RATE_WINDOW_MS = 60000
/** 一个房间的内存用户上限（一场直播几万人进场，不设上限就是泄漏） */
const USER_CAP = 4000
/** 单次 flush 最多写多少行消息（剩下的留到下一轮） */
export const FLUSH_ROWS = 200

const emptyCounters = (): LiveInteractions => ({
  chat: 0,
  gift: 0,
  diamonds: 0,
  enter: 0,
  like: 0,
  follow: 0
})

const emptyStats = (): UserStats => ({ chat: 0, gift: 0, diamonds: 0, enter: 0, like: 0, follow: 0 })

/** 本场里的一个用户：静态信息（本场见到的最新值）+ 本场的增量统计 */
interface SessionUser {
  profile: UserProfile
  delta: UserStats
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
  private messages: MessageRow[] = []
  private minutes = new Map<number, MinuteDeltaRow>()
  private minuteUsers = new Map<number, Set<string>>()

  constructor(webRid: string) {
    this.webRid = webRid
  }

  /** 开始一次监控会话：本场数字清零，库里的累计不动 */
  begin(sessionId: number, cap: number, startedAt = Date.now()): void {
    this.sessionId = sessionId
    this.cap = Math.max(50, cap)
    this.startedAt = startedAt
    this.counters = emptyCounters()
    this.received = 0
    this.rateMarks = []
    this.userMap.clear()
    this.touched.clear()
    this.sessionUserIds.clear()
    this.messages = []
    this.minutes.clear()
    this.minuteUsers.clear()
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
    const now = Date.now()
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
    const now = Date.now()

    for (const info of users) {
      if (!info.id) continue
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
      existing.profile = merged
      this.touched.add(info.id)
    }

    for (const item of items) {
      this.received += 1
      this.recent.push(item)
      if (item.userId) {
        this.sessionUserIds.add(item.userId)
        const minuteBucket = this.minuteUsers.get(minuteOf(item.at)) ?? new Set<string>()
        minuteBucket.add(item.userId)
        this.minuteUsers.set(minuteOf(item.at), minuteBucket)
      }

      const counted = COUNTED.includes(item.kind)
      if (!counted) continue
      this.rateMarks.push(item.at)
      this.bumpCounters(item)
      this.pushMinute(item)
      this.messages.push({
        webRid: this.webRid,
        sessionId: this.sessionId,
        kind: item.kind,
        userId: item.userId,
        userName: item.user,
        content: item.text,
        count: item.count,
        diamonds: item.diamonds,
        atMs: item.at
      })
      const user = item.userId ? this.userMap.get(item.userId) : undefined
      if (user) {
        switch (item.kind) {
          case 'chat':
            user.delta.chat += 1
            break
          case 'gift':
            user.delta.gift += 1
            user.delta.diamonds += item.diamonds
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
          default:
            break
        }
        this.touched.add(item.userId)
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

  /** 取走待写的消息行（最多 FLUSH_ROWS 行，剩下的下一轮） */
  takeMessages(): MessageRow[] {
    if (this.messages.length === 0) return []
    const rows = this.messages.slice(0, FLUSH_ROWS)
    this.messages = this.messages.slice(rows.length)
    return rows
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
   * 取走用户增量：只有**本场真出现过**的用户才写库
   * （静态信息可能是从别人那批里带出来的，但统计为 0 的行没必要每次都写）。
   */
  takeUserDeltas(limit = 400): UserDeltaRow[] {
    const rows: UserDeltaRow[] = []
    for (const [id, entry] of this.userMap) {
      if (rows.length >= limit) break
      const delta = entry.delta
      const active =
        delta.chat + delta.gift + delta.enter + delta.like + delta.follow > 0 || this.sessionUserIds.has(id)
      if (!active) continue
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
    }
    // 写过的增量清零（静态信息留着，下一批继续补空字段）
    for (const id of this.sessionUserIds) {
      const entry = this.userMap.get(id)
      if (entry) entry.delta = emptyStats()
    }
    return rows
  }

  /** 释放（房间被忘掉/插件停用） */
  dispose(): void {
    this.recent = []
    this.userMap.clear()
    this.touched.clear()
    this.messages = []
    this.minutes.clear()
    this.minuteUsers.clear()
    this.sessionUserIds.clear()
  }

  /* --------------------------------------------------------- 内部 */

  private bumpCounters(item: DanmakuItem): void {
    switch (item.kind) {
      case 'chat':
        this.counters.chat += 1
        break
      case 'gift':
        this.counters.gift += 1
        this.counters.diamonds += item.diamonds
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
      default:
        break
    }
  }

  private pushMinute(item: DanmakuItem): void {
    const minute = minuteOf(item.at)
    const row =
      this.minutes.get(minute) ??
      ({
        webRid: this.webRid,
        minute,
        chat: 0,
        gift: 0,
        member: 0,
        likes: 0,
        social: 0,
        diamonds: 0,
        messages: 0,
        users: 0
      } satisfies MinuteDeltaRow)
    row.messages += 1
    switch (item.kind) {
      case 'chat':
        row.chat += 1
        break
      case 'gift':
        row.gift += 1
        row.diamonds += item.diamonds
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
    }
  }
}

/** ms → 分钟桶号（floor(ms / 60000)，Postgres 侧直接用同一个数） */
export function minuteOf(at: number): number {
  return Math.floor(at / 60000)
}
