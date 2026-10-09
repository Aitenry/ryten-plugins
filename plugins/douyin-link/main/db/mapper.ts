import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from 'drizzle-orm'
import logger from 'electron-log'
import { withOrm } from '@host/main/database/orm'
import type {
  DanmakuKind,
  DayRecordRow,
  DbStats,
  GiftBreakdownRow,
  GiftRankRow,
  LiveRoomInfo,
  MessagePage,
  MessageQuery,
  MonitorSession,
  RoomCompareRow,
  StoredMessage,
  UserRankRow,
  UserStats
} from '../../shared/types'
import {
  douyinLinkMessages,
  douyinLinkMeta,
  douyinLinkMinutes,
  douyinLinkRooms,
  douyinLinkSessions,
  douyinLinkUsers
} from './schema'
import { schemaReady } from './ddl'
import { mergeGiftRows, storedGiftMergeInput } from '../gift/merge'

/**
 * 抖音直播分析器 的数据访问层。
 *
 * 规矩（照 WORKSHOP 5b）：
 * - 每个函数先 `await schemaReady`，再 `withOrm(op, fn)`——宿主统一记异常，别自己拿连接；
 * - 高频写入一律**批量**：弹幕是秒级流水，一条一条 insert 会把 PGlite 打满，
 *   所以消息按批插、分钟桶按桶 upsert、用户统计按增量加；
 * - 行 → DTO 的转换只在这里发生（`toStoredMessage` / `toRankRow`）；
 * - 时间统一是 **ms epoch 的 number**（列是 DOUBLE PRECISION）。
 */

const MSG_CHUNK = 300

/** 一行消息（主进程攒批时用的形状，字段名与列对齐） */
export interface MessageRow {
  webRid: string
  sessionId: number
  kind: DanmakuKind
  userId: string
  userName: string
  content: string
  count: number
  /** 礼物的抖币总价值（非礼物 0） */
  diamonds: number
  /** 收礼人（礼物才有） */
  toUserId: string
  toUserName: string
  /**
   * 点歌单号串（只有点歌那类有）。同一单的几次推送靠它**合并成一行**：
   * 不带礼物记录的那条先到、带记录的后到，落库时后者**更新**前者，而不是再插一行。
   */
  orderKey: string
  /**
   * **这一帧里带着礼物记录**（能解出礼物名与价格）。只用于落库时决定「谁覆盖谁」，
   * **不是表里的列**——写库前由 `toMessageInsert` 剥掉。
   */
  giftRecord: boolean
  atMs: number
}

/** 一个用户的增量（统计是「加」上去的，静态字段是「补空 + 覆盖」的） */
export interface UserDeltaRow {
  webRid: string
  userId: string
  displayId: string
  nickname: string
  gender: number
  signature: string
  city: string
  avatar: string
  following: number
  follower: number
  honorLevel: number
  fansClubLevel: number
  badges: string
  secUid: string
  delta: UserStats
  firstSeen: number
  lastSeen: number
}

/** 一分钟桶的增量 */
export interface MinuteDeltaRow {
  webRid: string
  minute: number
  chat: number
  member: number
  likes: number
  social: number
  /** 该分钟的礼物条数与抖币总额 */
  gift: number
  diamonds: number
  messages: number
  users: number
}

const EMPTY_STATS = (): UserStats => ({ chat: 0, enter: 0, like: 0, follow: 0, gift: 0, diamonds: 0 })

/* ------------------------------------------------------------------ 房间 */

/** 库里的一行房间（列名与 DTO 不同，转换在这一层做） */
export interface RoomRow {
  webRid: string
  roomId: string
  title: string
  anchor: string
  cover: string
  onlineText: string
  status: 'live' | 'ended' | 'unknown'
  note: string
  monitor: boolean
  addedAt: number
  lastActiveAt: number
  lastSeenAt: number
}

export async function listRooms(): Promise<RoomRow[]> {
  await schemaReady
  return withOrm('douyin-link.listRooms', async (db) => {
    const rows = await db.select().from(douyinLinkRooms).orderBy(desc(douyinLinkRooms.lastActiveAt))
    return rows.map((row) => ({
      webRid: row.webRid,
      roomId: row.roomId,
      title: row.title,
      anchor: row.anchor,
      cover: row.cover,
      onlineText: row.onlineText,
      status: (row.status === 'live' || row.status === 'ended' ? row.status : 'unknown') as RoomRow['status'],
      note: row.note,
      monitor: row.monitor,
      addedAt: row.addedAt,
      lastActiveAt: row.lastActiveAt,
      lastSeenAt: row.lastSeenAt
    }))
  })
}

/** 新增/刷新一个房间的静态信息（**不动** note 与 monitor） */
export async function upsertRoom(info: LiveRoomInfo, now = Date.now()): Promise<void> {
  await schemaReady
  await withOrm('douyin-link.upsertRoom', async (db) => {
    await db
      .insert(douyinLinkRooms)
      .values({
        webRid: info.webRid,
        roomId: info.roomId,
        title: info.title,
        anchor: info.anchor,
        cover: info.cover,
        onlineText: info.onlineText,
        status: info.status,
        addedAt: now,
        lastSeenAt: now
      })
      .onConflictDoUpdate({
        target: douyinLinkRooms.webRid,
        set: {
          roomId: sql`excluded.room_id`,
          title: sql`excluded.title`,
          anchor: sql`excluded.anchor`,
          cover: sql`excluded.cover`,
          onlineText: sql`excluded.online_text`,
          status: sql`excluded.status`,
          lastSeenAt: sql`excluded.last_seen_at`
        }
      })
  })
}

export async function setRoomMonitor(webRid: string, monitor: boolean): Promise<void> {
  await schemaReady
  await withOrm('douyin-link.setRoomMonitor', async (db) => {
    await db.update(douyinLinkRooms).set({ monitor }).where(eq(douyinLinkRooms.webRid, webRid))
  })
}

export async function setRoomNote(webRid: string, note: string): Promise<void> {
  await schemaReady
  await withOrm('douyin-link.setRoomNote', async (db) => {
    await db.update(douyinLinkRooms).set({ note }).where(eq(douyinLinkRooms.webRid, webRid))
  })
}

export async function touchRoom(webRid: string, patch: { active?: boolean; seen?: boolean }, now = Date.now()): Promise<void> {
  await schemaReady
  await withOrm('douyin-link.touchRoom', async (db) => {
    const set: Record<string, unknown> = {}
    if (patch.active) set.lastActiveAt = now
    if (patch.seen) set.lastSeenAt = now
    if (Object.keys(set).length === 0) return
    await db.update(douyinLinkRooms).set(set).where(eq(douyinLinkRooms.webRid, webRid))
  })
}

/** 忘掉一个房间：房间行 + 它的全部历史（消息/用户/分钟桶/会话） */
export async function forgetRoom(webRid: string): Promise<void> {
  await schemaReady
  await withOrm('douyin-link.forgetRoom', async (db) => {
    await db.delete(douyinLinkMessages).where(eq(douyinLinkMessages.webRid, webRid))
    await db.delete(douyinLinkUsers).where(eq(douyinLinkUsers.webRid, webRid))
    await db.delete(douyinLinkMinutes).where(eq(douyinLinkMinutes.webRid, webRid))
    await db.delete(douyinLinkSessions).where(eq(douyinLinkSessions.webRid, webRid))
    await db.delete(douyinLinkRooms).where(eq(douyinLinkRooms.webRid, webRid))
  })
}

/* ------------------------------------------------------------------ 消息 */

/**
 * 批量插消息（按批分片，别让一条 INSERT 的参数个数顶到上限）。
 *
 * **带单号串的点歌行要「一单一行」**（2026-10-08 按用户库里的真实数据修）：
 * 同一个订单服务端会推好几次——一条**没有礼物记录**的（只有单号串与歌手）、
 * 一条**带礼物记录**的（那一条才有礼物名与抖币价），两条相隔 16 秒~3.5 分钟，
 * **先来哪条都出现过**。用户库里因此出现成对的「`content=''` + `content='爱的纸鹤'`」两行，
 * 礼物榜里就多出「（礼物名未知）」。所以这里：带单号串的行先按 `(web_rid, order_key)` 找那一行，
 * 找到就**合并**（`mergeGiftRows`）、找不到才插——同一单永远只有一行。
 */
export async function insertMessages(rows: MessageRow[]): Promise<void> {
  if (rows.length === 0) return
  await schemaReady
  await withOrm('douyin-link.insertMessages', async (db) => {
    const ordered = rows.filter((row) => row.kind === 'gift' && row.orderKey)
    const plain = rows.filter((row) => !(row.kind === 'gift' && row.orderKey))
    for (const row of ordered) {
      const found = await db
        .select()
        .from(douyinLinkMessages)
        .where(
          and(
            eq(douyinLinkMessages.webRid, row.webRid),
            eq(douyinLinkMessages.kind, 'gift'),
            eq(douyinLinkMessages.orderKey, row.orderKey)
          )
        )
        .orderBy(asc(douyinLinkMessages.id))
        .limit(1)
      const current = found[0]
      if (!current) {
        await db.insert(douyinLinkMessages).values(toMessageInsert(row))
        continue
      }
      await db
        .update(douyinLinkMessages)
        .set(mergeGiftRows(storedGiftMergeInput(current), row))
        .where(eq(douyinLinkMessages.id, current.id))
    }
    for (let index = 0; index < plain.length; index += MSG_CHUNK) {
      await db.insert(douyinLinkMessages).values(plain.slice(index, index + MSG_CHUNK).map(toMessageInsert))
    }
  })
}

/** 只留表里真有的列（`giftRecord` 是合并信号，塞进 `values()` 会被当成未知列） */
function toMessageInsert(row: MessageRow): Omit<MessageRow, 'giftRecord'> {
  return {
    webRid: row.webRid,
    sessionId: row.sessionId,
    kind: row.kind,
    userId: row.userId,
    userName: row.userName,
    content: row.content,
    count: row.count,
    diamonds: row.diamonds,
    toUserId: row.toUserId,
    toUserName: row.toUserName,
    orderKey: row.orderKey,
    atMs: row.atMs
  }
}

/** 条件检索（跨房间也行：`webRid` 空 = 所有房间） */
export async function queryMessages(query: MessageQuery): Promise<MessagePage> {
  await schemaReady
  return withOrm('douyin-link.queryMessages', async (db) => {
    const filters = []
    if (query.webRid) filters.push(eq(douyinLinkMessages.webRid, query.webRid))
    if (query.kind) filters.push(eq(douyinLinkMessages.kind, query.kind))
    if (query.userId) filters.push(eq(douyinLinkMessages.userId, query.userId))
    // 收礼人（礼物才有）：某人「收到的礼物历史」就是 kind='gift' + 这个条件
    if (query.toUserId) filters.push(eq(douyinLinkMessages.toUserId, query.toUserId))
    if (typeof query.from === 'number' && query.from > 0) filters.push(gte(douyinLinkMessages.atMs, query.from))
    if (typeof query.to === 'number' && query.to > 0) filters.push(lte(douyinLinkMessages.atMs, query.to))
    const keyword = (query.keyword ?? '').trim()
    if (keyword) {
      const pattern = `%${keyword}%`
      filters.push(
        or(ilike(douyinLinkMessages.content, pattern), ilike(douyinLinkMessages.userName, pattern))!
      )
    }
    const where = filters.length > 0 ? and(...filters) : undefined
    const limit = Math.min(Math.max(1, Math.round(query.limit ?? 100)), 500)
    const offset = Math.max(0, Math.round(query.offset ?? 0))

    const totals = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(douyinLinkMessages)
      .where(where)
    const rows = await db
      .select()
      .from(douyinLinkMessages)
      .where(where)
      .orderBy(desc(douyinLinkMessages.atMs), desc(douyinLinkMessages.id))
      .limit(limit)
      .offset(offset)

    return { rows: rows.map(toStoredMessage), total: totals[0]?.value ?? 0 }
  })
}

/** 清空某个房间（或全部房间）的消息流水 */
export async function clearMessages(webRid = ''): Promise<number> {
  await schemaReady
  return withOrm('douyin-link.clearMessages', async (db) => {
    const before = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(douyinLinkMessages)
      .where(webRid ? eq(douyinLinkMessages.webRid, webRid) : undefined)
    await db
      .delete(douyinLinkMessages)
      .where(webRid ? eq(douyinLinkMessages.webRid, webRid) : undefined)
    return before[0]?.value ?? 0
  })
}

/** 按保留期清旧消息（返回删了多少条） */
export async function deleteMessagesBefore(cutoffMs: number): Promise<number> {
  // 0 / NaN / 负数都当「不清理」：永久保存是默认口径，绝不能让一个坏参数把整张表清空
  if (!(cutoffMs > 0)) return 0
  await schemaReady
  return withOrm('douyin-link.deleteMessagesBefore', async (db) => {
    const before = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(douyinLinkMessages)
      .where(lte(douyinLinkMessages.atMs, cutoffMs))
    const rows = await db
      .delete(douyinLinkMessages)
      .where(lte(douyinLinkMessages.atMs, cutoffMs))
      .returning({ id: douyinLinkMessages.id })
    return rows.length > 0 ? rows.length : (before[0]?.value ?? 0)
  })
}

/** 按保留期清旧分钟桶（趋势图的历史也跟着保留期走） */
export async function deleteMinutesBefore(minute: number): Promise<number> {
  // 同 deleteMessagesBefore：非正数一律不清理（永久保存是默认口径）
  if (!(minute > 0)) return 0
  await schemaReady
  return withOrm('douyin-link.deleteMinutesBefore', async (db) => {
    const rows = await db
      .delete(douyinLinkMinutes)
      .where(lte(douyinLinkMinutes.minute, minute))
      .returning({ id: douyinLinkMinutes.id })
    return rows.length
  })
}

/* ------------------------------------------------------------- 分钟桶 */

/** 分钟桶增量 upsert（`ON CONFLICT` 累加：一张表就能撑趋势图，不必扫消息流水） */
export async function bumpMinutes(rows: MinuteDeltaRow[]): Promise<void> {
  if (rows.length === 0) return
  await schemaReady
  await withOrm('douyin-link.bumpMinutes', async (db) => {
    for (let index = 0; index < rows.length; index += MSG_CHUNK) {
      const chunk = rows.slice(index, index + MSG_CHUNK)
      const values = sql.join(
        chunk.map(
          (row) =>
            sql`(${row.webRid}, ${row.minute}, ${row.chat}, ${row.member}, ${row.likes}, ${row.social}, ${row.gift}, ${row.diamonds}, ${row.messages}, ${row.users})`
        ),
        sql`, `
      )
      await db.execute(sql`
        INSERT INTO douyin_link_minutes (web_rid, minute, chat, member, likes, social, gift, diamonds, messages, users)
        VALUES ${values}
        ON CONFLICT (web_rid, minute) DO UPDATE SET
          chat = douyin_link_minutes.chat + EXCLUDED.chat,
          member = douyin_link_minutes.member + EXCLUDED.member,
          likes = douyin_link_minutes.likes + EXCLUDED.likes,
          social = douyin_link_minutes.social + EXCLUDED.social,
          gift = douyin_link_minutes.gift + EXCLUDED.gift,
          diamonds = douyin_link_minutes.diamonds + EXCLUDED.diamonds,
          messages = douyin_link_minutes.messages + EXCLUDED.messages,
          users = GREATEST(douyin_link_minutes.users, EXCLUDED.users)
      `)
    }
  })
}

export interface MinuteRow {
  minute: number
  chat: number
  member: number
  likes: number
  social: number
  gift: number
  diamonds: number
  messages: number
  users: number
}

/** 取窗口内的分钟序列（趋势图） */
export async function minuteSeries(webRid: string, fromMinute: number, toMinute: number): Promise<MinuteRow[]> {
  await schemaReady
  return withOrm('douyin-link.minuteSeries', async (db) => {
    const rows = await db
      .select()
      .from(douyinLinkMinutes)
      .where(
        and(
          eq(douyinLinkMinutes.webRid, webRid),
          gte(douyinLinkMinutes.minute, fromMinute),
          lte(douyinLinkMinutes.minute, toMinute)
        )
      )
      .orderBy(asc(douyinLinkMinutes.minute))
    return rows.map((row) => ({
      minute: row.minute,
      chat: row.chat,
      member: row.member,
      likes: row.likes,
      social: row.social,
      gift: row.gift,
      diamonds: row.diamonds,
      messages: row.messages,
      users: row.users
    }))
  })
}

/* ------------------------------------------------------------- 用户 */

/**
 * 用户增量 upsert。
 *
 * 静态字段用「非空才覆盖 + 数字取大」：同一个人这次出现在聊天里（不带勋章），
 * 上次出现在进场消息里（带等级），**不能把已记下的等级抹掉**（上一版在内存里就是这套规则）；
 * 统计字段一律累加。
 */
export async function upsertUserDeltas(rows: UserDeltaRow[]): Promise<void> {
  if (rows.length === 0) return
  await schemaReady
  await withOrm('douyin-link.upsertUserDeltas', async (db) => {
    for (let index = 0; index < rows.length; index += MSG_CHUNK) {
      const chunk = rows.slice(index, index + MSG_CHUNK)
      await db
        .insert(douyinLinkUsers)
        .values(
          chunk.map((row) => ({
            webRid: row.webRid,
            userId: row.userId,
            displayId: row.displayId,
            nickname: row.nickname,
            gender: row.gender,
            signature: row.signature,
            city: row.city,
            avatar: row.avatar,
            following: row.following,
            follower: row.follower,
            honorLevel: row.honorLevel,
            fansClubLevel: row.fansClubLevel,
            badges: row.badges,
            secUid: row.secUid,
            chat: row.delta.chat,
            enter: row.delta.enter,
            likes: row.delta.like,
            follows: row.delta.follow,
            gift: row.delta.gift,
            diamonds: row.delta.diamonds,
            firstSeen: row.firstSeen,
            lastSeen: row.lastSeen
          }))
        )
        .onConflictDoUpdate({
          target: [douyinLinkUsers.webRid, douyinLinkUsers.userId],
          set: {
            displayId: keepNonEmpty('display_id'),
            nickname: keepNonEmpty('nickname'),
            signature: keepNonEmpty('signature'),
            city: keepNonEmpty('city'),
            avatar: keepNonEmpty('avatar'),
            secUid: keepNonEmpty('sec_uid'),
            badges: sql`CASE WHEN excluded.badges <> '[]' THEN excluded.badges ELSE douyin_link_users.badges END`,
            gender: greatest('gender'),
            following: greatest('following'),
            follower: greatest('follower'),
            honorLevel: greatest('honor_level'),
            fansClubLevel: greatest('fans_club_level'),
            chat: sql`douyin_link_users.chat + EXCLUDED.chat`,
            enter: sql`douyin_link_users.enter + EXCLUDED.enter`,
            likes: sql`douyin_link_users.likes + EXCLUDED.likes`,
            follows: sql`douyin_link_users.follows + EXCLUDED.follows`,
            gift: sql`douyin_link_users.gift + EXCLUDED.gift`,
            diamonds: sql`douyin_link_users.diamonds + EXCLUDED.diamonds`,
            firstSeen: sql`LEAST(douyin_link_users.first_seen, EXCLUDED.first_seen)`,
            lastSeen: sql`GREATEST(douyin_link_users.last_seen, EXCLUDED.last_seen)`
          }
        })
    }
  })
}

export type UserSort = 'recent' | 'chat' | 'gift'

/** 某个房间的用户榜（`keyword` 匹配昵称/抖音号/id） */
export async function listUsers(
  webRid: string,
  sort: UserSort = 'recent',
  keyword = '',
  limit = 200
): Promise<UserRankRow[]> {
  await schemaReady
  return withOrm('douyin-link.listUsers', async (db) => {
    const filters = [eq(douyinLinkUsers.webRid, webRid)]
    const needle = keyword.trim()
    if (needle) {
      const pattern = `%${needle}%`
      filters.push(
        or(
          ilike(douyinLinkUsers.nickname, pattern),
          ilike(douyinLinkUsers.displayId, pattern),
          ilike(douyinLinkUsers.userId, pattern)
        )!
      )
    }
    const order =
      sort === 'chat'
        ? [desc(douyinLinkUsers.chat), desc(douyinLinkUsers.lastSeen)]
        : /**
           * 刷礼物榜先按**抖币**排（十连小心心和一个大礼物谁更值，只有抖币说得清），
           * 抖币并列或拿不到价（语音房的点歌就是没价格的那类）时退到**送礼次数**，
           * 免得整张榜在所有价格都未知时变成「按最近出现」排。
           */
          sort === 'gift'
          ? [desc(douyinLinkUsers.diamonds), desc(douyinLinkUsers.gift), desc(douyinLinkUsers.lastSeen)]
          : [desc(douyinLinkUsers.lastSeen)]
    const rows = await db
      .select()
      .from(douyinLinkUsers)
      .where(and(...filters))
      .orderBy(...order)
      .limit(Math.min(Math.max(1, limit), 1000))
    return rows.map(toRankRow)
  })
}

/** 一个用户的档案（按房间；`webRid` 空 = 取他最近出现的那一行） */
export async function getUser(webRid: string, userId: string): Promise<UserRankRow | null> {
  await schemaReady
  return withOrm('douyin-link.getUser', async (db) => {
    const filters = [eq(douyinLinkUsers.userId, userId)]
    if (webRid) filters.push(eq(douyinLinkUsers.webRid, webRid))
    const rows = await db
      .select()
      .from(douyinLinkUsers)
      .where(and(...filters))
      .orderBy(desc(douyinLinkUsers.lastSeen))
      .limit(1)
    return rows.length > 0 ? toRankRow(rows[0]) : null
  })
}

/**
 * 一次查一批用户（「在线观众」按 id 列表取档案用）。
 *
 * 为什么要有批量版：那一页可能一次要 30~300 个 id，一个个 `getUser` 就是几百次往返，
 * 跑在宿主的 PGlite 上会把别的写入挤停（用户实测过的卡顿就是这么来的）。
 * `inArray` 一次查完，分片是为了别让参数个数顶到上限。
 */
export async function getUsers(webRid: string, userIds: string[]): Promise<Map<string, UserRankRow>> {
  const out = new Map<string, UserRankRow>()
  const ids = [...new Set(userIds.filter((id) => id.length > 0))]
  if (!webRid || ids.length === 0) return out
  await schemaReady
  await withOrm('douyin-link.getUsers', async (db) => {
    for (let index = 0; index < ids.length; index += MSG_CHUNK) {
      const slice = ids.slice(index, index + MSG_CHUNK)
      const rows = await db
        .select()
        .from(douyinLinkUsers)
        .where(and(eq(douyinLinkUsers.webRid, webRid), inArray(douyinLinkUsers.userId, slice)))
      for (const row of rows) out.set(row.userId, toRankRow(row))
    }
  })
  return out
}

export async function clearUsers(webRid = ''): Promise<void> {
  await schemaReady
  await withOrm('douyin-link.clearUsers', async (db) => {
    await db.delete(douyinLinkUsers).where(webRid ? eq(douyinLinkUsers.webRid, webRid) : undefined)
  })
}

/* ------------------------------------------------------------ 会话 */

export async function openSession(webRid: string, startedAt = Date.now()): Promise<number> {
  await schemaReady
  return withOrm('douyin-link.openSession', async (db) => {
    const rows = await db
      .insert(douyinLinkSessions)
      .values({ webRid, startedAt, endedAt: 0, messages: 0, endReason: '' })
      .returning({ id: douyinLinkSessions.id })
    return rows[0]?.id ?? 0
  })
}

export async function closeSession(id: number, messages: number, endReason: string, endedAt = Date.now()): Promise<void> {
  if (!id) return
  await schemaReady
  await withOrm('douyin-link.closeSession', async (db) => {
    await db
      .update(douyinLinkSessions)
      .set({ endedAt, messages, endReason })
      .where(eq(douyinLinkSessions.id, id))
  })
}

export async function listSessions(webRid: string, limit = 20): Promise<MonitorSession[]> {
  await schemaReady
  return withOrm('douyin-link.listSessions', async (db) => {
    const rows = await db
      .select()
      .from(douyinLinkSessions)
      .where(webRid ? eq(douyinLinkSessions.webRid, webRid) : undefined)
      .orderBy(desc(douyinLinkSessions.startedAt))
      .limit(Math.min(Math.max(1, limit), 200))
    return rows.map((row) => ({
      id: row.id,
      webRid: row.webRid,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      messages: row.messages,
      endReason: row.endReason
    }))
  })
}

/* ------------------------------------------------- 聚合（分析用查询） */

export interface RoomStore {
  messages: number
  users: number
  sessions: number
}

/** 每个房间在库里的累计量（房间列表的 KPI 用；三条聚合查询拼起来） */
export async function roomStores(): Promise<Map<string, RoomStore>> {
  await schemaReady
  return withOrm('douyin-link.roomStores', async (db) => {
    const out = new Map<string, RoomStore>()
    const ensure = (webRid: string): RoomStore => {
      const hit = out.get(webRid)
      if (hit) return hit
      const created: RoomStore = { messages: 0, users: 0, sessions: 0 }
      out.set(webRid, created)
      return created
    }
    const messages = await db
      .select({
        webRid: douyinLinkMessages.webRid,
        messages: sql<number>`count(*)::int`
      })
      .from(douyinLinkMessages)
      .groupBy(douyinLinkMessages.webRid)
    for (const row of messages) {
      const store = ensure(row.webRid)
      store.messages = row.messages
    }
    const users = await db
      .select({ webRid: douyinLinkUsers.webRid, users: sql<number>`count(*)::int` })
      .from(douyinLinkUsers)
      .groupBy(douyinLinkUsers.webRid)
    for (const row of users) ensure(row.webRid).users = row.users
    const sessions = await db
      .select({ webRid: douyinLinkSessions.webRid, sessions: sql<number>`count(*)::int` })
      .from(douyinLinkSessions)
      .groupBy(douyinLinkSessions.webRid)
    for (const row of sessions) ensure(row.webRid).sessions = row.sessions
    return out
  })
}

/** 窗口内按房间聚合（对比页签；用户在库里的归属也是按房间算的） */
export async function windowAggregates(fromMs: number, toMs: number): Promise<Map<string, RoomCompareRow>> {
  await schemaReady
  return withOrm('douyin-link.windowAggregates', async (db) => {
    const rows = await db
      .select({
        webRid: douyinLinkMessages.webRid,
        messages: sql<number>`count(*)::int`,
        chat: sql<number>`(count(*) filter (where ${douyinLinkMessages.kind} = 'chat'))::int`,
        member: sql<number>`(count(*) filter (where ${douyinLinkMessages.kind} = 'member'))::int`,
        likes: sql<number>`(count(*) filter (where ${douyinLinkMessages.kind} = 'like'))::int`,
        social: sql<number>`(count(*) filter (where ${douyinLinkMessages.kind} = 'social'))::int`,
        gift: sql<number>`(count(*) filter (where ${douyinLinkMessages.kind} = 'gift'))::int`,
        diamonds: sql<number>`(coalesce(sum(${douyinLinkMessages.diamonds}) filter (where ${douyinLinkMessages.kind} = 'gift'), 0))::int`,
        users: sql<number>`count(distinct nullif(${douyinLinkMessages.userId}, ''))::int`
      })
      .from(douyinLinkMessages)
      .where(and(gte(douyinLinkMessages.atMs, fromMs), lte(douyinLinkMessages.atMs, toMs)))
      .groupBy(douyinLinkMessages.webRid)

    const out = new Map<string, RoomCompareRow>()
    for (const row of rows) {
      out.set(row.webRid, {
        webRid: row.webRid,
        title: '',
        anchor: '',
        status: 'unknown',
        phase: 'off',
        audio: false,
        activeMinutes: 0,
        windowMinutes: Math.max(1, Math.round((toMs - fromMs) / 60000)),
        messages: row.messages,
        chat: row.chat,
        member: row.member,
        like: row.likes,
        social: row.social,
        gift: row.gift,
        diamonds: row.diamonds,
        users: row.users,
        perMinute: 0,
        totalMessages: row.messages
      })
    }
    return out
  })
}

/** 窗口内有数据的分钟数（对比页签的「活跃分钟」） */
export async function activeMinutes(fromMinute: number, toMinute: number): Promise<Map<string, number>> {
  await schemaReady
  return withOrm('douyin-link.activeMinutes', async (db) => {
    const rows = await db
      .select({
        webRid: douyinLinkMinutes.webRid,
        minutes: sql<number>`count(*)::int`
      })
      .from(douyinLinkMinutes)
      .where(and(gte(douyinLinkMinutes.minute, fromMinute), lte(douyinLinkMinutes.minute, toMinute)))
      .groupBy(douyinLinkMinutes.webRid)
    const out = new Map<string, number>()
    for (const row of rows) out.set(row.webRid, row.minutes)
    return out
  })
}

/** 窗口内的消息条数（房间列表的速率与概览 KPI 的兜底） */
export async function messageCount(webRid: string, fromMs: number, toMs: number): Promise<number> {
  await schemaReady
  return withOrm('douyin-link.messageCount', async (db) => {
    const rows = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(douyinLinkMessages)
      .where(
        and(
          eq(douyinLinkMessages.webRid, webRid),
          gte(douyinLinkMessages.atMs, fromMs),
          lte(douyinLinkMessages.atMs, toMs)
        )
      )
    return rows[0]?.value ?? 0
  })
}

/**
 * 礼物流水按**礼物名**聚合（概览的礼物榜）。
 *
 * 排序按抖币（值钱在前），价格未知（点歌这类目录没给价的）退到按件数——
 * 否则一个全是「价格未知」的窗口会变成随机顺序。
 */
export async function giftBreakdown(
  webRid: string,
  fromMs: number,
  toMs: number,
  limit = 40
): Promise<GiftBreakdownRow[]> {
  await schemaReady
  return withOrm('douyin-link.giftBreakdown', async (db) => {
    const rows = await db
      .select({
        name: douyinLinkMessages.content,
        count: sql<number>`count(*)::int`,
        diamonds: sql<number>`coalesce(sum(${douyinLinkMessages.diamonds}), 0)::int`,
        users: sql<number>`count(distinct nullif(${douyinLinkMessages.userId}, ''))::int`
      })
      .from(douyinLinkMessages)
      .where(
        and(
          eq(douyinLinkMessages.webRid, webRid),
          eq(douyinLinkMessages.kind, 'gift'),
          gte(douyinLinkMessages.atMs, fromMs),
          lte(douyinLinkMessages.atMs, toMs)
        )
      )
      .groupBy(douyinLinkMessages.content)
      .orderBy(desc(sql`coalesce(sum(${douyinLinkMessages.diamonds}), 0)`), desc(sql`count(*)`))
      .limit(Math.min(Math.max(1, limit), 200))
    return rows.map((row) => ({
      name: row.name,
      count: row.count,
      diamonds: row.diamonds,
      users: row.users
    }))
  })
}

/**
 * **每一天的直播记录**（左侧「每日记录」列表）。
 *
 * 分天按**本地时区**：SQL 里把 `at_ms` 平移本地偏移再按 86400000 取整（Postgres 的
 * `to_char` / `timestamptz` 依赖会话时区，嵌入式 PGlite 默认是 UTC——直接用会把一天的边界
 * 落到 UTC 00:00 上，国内的直播会被劈成两半）。偏移在主进程算一次传进来。
 *
 * 两条聚合：消息流水给出条数/首末/用户数/礼物，会话表给出这一天开播了几次
 * （一天里下播又重开也如实计数）。
 */
export async function dayRecords(webRid: string, limit = 90): Promise<DayRecordRow[]> {
  if (!webRid) return []
  await schemaReady
  const offsetMs = -new Date().getTimezoneOffset() * 60000
  return withOrm('douyin-link.dayRecords', async (db) => {
    /**
     * 时区偏移用**字面量**而不是绑定参数：`GROUP BY` 与 `ORDER BY` 会各渲染一次这个表达式，
     * 绑定参数会变成 $1 / $3 两个不同的占位符，Postgres 就认为它们不是同一个表达式而报
     * 「at_ms must appear in the GROUP BY clause」。偏移是我们自己算出来的整数，拼字面量是安全的。
     */
    const offset = sql.raw(String(Math.trunc(offsetMs)))
    const buckets = sql`floor((${douyinLinkMessages.atMs} + ${offset}) / 86400000)`
    const rows = await db
      .select({
        bucket: sql<number>`(${buckets})::int`,
        firstAt: sql<number>`min(${douyinLinkMessages.atMs})::double precision`,
        lastAt: sql<number>`max(${douyinLinkMessages.atMs})::double precision`,
        messages: sql<number>`count(*)::int`,
        gifts: sql<number>`count(*) filter (where ${douyinLinkMessages.kind} = 'gift')::int`,
        diamonds: sql<number>`coalesce(sum(${douyinLinkMessages.diamonds}), 0)::int`,
        users: sql<number>`count(distinct nullif(${douyinLinkMessages.userId}, ''))::int`
      })
      .from(douyinLinkMessages)
      .where(eq(douyinLinkMessages.webRid, webRid))
      .groupBy(buckets)
      .orderBy(desc(buckets))
      .limit(Math.min(Math.max(1, limit), 400))
    const sessionBuckets = sql`floor((${douyinLinkSessions.startedAt} + ${offset}) / 86400000)`
    const sessionRows = await db
      .select({ bucket: sql<number>`(${sessionBuckets})::int`, sessions: sql<number>`count(*)::int` })
      .from(douyinLinkSessions)
      .where(eq(douyinLinkSessions.webRid, webRid))
      .groupBy(sessionBuckets)
    const sessions = new Map(sessionRows.map((row) => [row.bucket, row.sessions]))
    return rows.map((row) => ({
      day: new Date(row.bucket * 86400000).toISOString().slice(0, 10),
      firstAt: row.firstAt,
      lastAt: row.lastAt,
      messages: row.messages,
      gifts: row.gifts,
      diamonds: row.diamonds,
      users: row.users,
      sessions: sessions.get(row.bucket) ?? 0
    }))
  })
}

/** 某个人送过的礼物（按礼物名聚合；用户榜悬停看明细用） */
export async function userGiftBreakdown(
  webRid: string,
  userId: string,
  limit = 12
): Promise<GiftBreakdownRow[]> {
  if (!webRid || !userId) return []
  await schemaReady
  return withOrm('douyin-link.userGiftBreakdown', async (db) => {
    const rows = await db
      .select({
        name: douyinLinkMessages.content,
        count: sql<number>`count(*)::int`,
        diamonds: sql<number>`coalesce(sum(${douyinLinkMessages.diamonds}), 0)::int`
      })
      .from(douyinLinkMessages)
      .where(
        and(
          eq(douyinLinkMessages.webRid, webRid),
          eq(douyinLinkMessages.userId, userId),
          eq(douyinLinkMessages.kind, 'gift')
        )
      )
      .groupBy(douyinLinkMessages.content)
      .orderBy(desc(sql`coalesce(sum(${douyinLinkMessages.diamonds}), 0)`), desc(sql`count(*)`))
      .limit(Math.min(Math.max(1, limit), 50))
    return rows.map((row) => ({ name: row.name, count: row.count, diamonds: row.diamonds, users: 1 }))
  })
}

/**
 * 礼物榜的**按人**聚合（收礼物榜 / 送礼物榜共用）。
 *
 * `by = 'recipient'` 按收礼人（`to_user_id`）分组、`by = 'sender'` 按送礼人（`user_id`）分组。
 * 只统计 `kind = 'gift'`；分组列是空串的行直接排除（不知道是谁的礼物不该出现在榜单上，
 * 对应 SQL 里的 `<> ''`）。排序：抖币在前，价格未知的按件数兜底，再按最近时间。
 */
export async function giftRankByPerson(
  webRid: string,
  by: 'sender' | 'recipient',
  fromMs: number,
  toMs: number,
  limit = 30
): Promise<Array<Omit<GiftRankRow, 'seat'>>>
{
  if (!webRid) return []
  await schemaReady
  const idColumn = by === 'recipient' ? douyinLinkMessages.toUserId : douyinLinkMessages.userId
  const nameColumn = by === 'recipient' ? douyinLinkMessages.toUserName : douyinLinkMessages.userName
  return withOrm(`douyin-link.giftRank.${by}`, async (db) => {
    const rows = await db
      .select({
        userId: idColumn,
        /**
         * 昵称优先用消息里记的那份；点歌那类帧里常常**只有送礼人 id、没有昵称**
         * （他后来在别处发的消息/礼物里才带上名字），所以再退回用户表里的昵称——
         * 不这么做，送礼榜上就会出现一串 `1671723870326936` 这样的裸 id。
         */
        name: sql<string>`coalesce(nullif(max(${nameColumn}), ''), max(${douyinLinkUsers.nickname}), '')`,
        count: sql<number>`count(*)::int`,
        diamonds: sql<number>`coalesce(sum(${douyinLinkMessages.diamonds}), 0)::int`,
        lastAt: sql<number>`max(${douyinLinkMessages.atMs})::double precision`
      })
      .from(douyinLinkMessages)
      .leftJoin(
        douyinLinkUsers,
        and(eq(douyinLinkUsers.webRid, douyinLinkMessages.webRid), eq(douyinLinkUsers.userId, idColumn))
      )
      .where(
        and(
          eq(douyinLinkMessages.webRid, webRid),
          eq(douyinLinkMessages.kind, 'gift'),
          ne(idColumn, ''),
          gte(douyinLinkMessages.atMs, fromMs),
          lte(douyinLinkMessages.atMs, toMs)
        )
      )
      .groupBy(idColumn)
      .orderBy(
        desc(sql`coalesce(sum(${douyinLinkMessages.diamonds}), 0)`),
        desc(sql`count(*)`),
        desc(sql`max(${douyinLinkMessages.atMs})`)
      )
      .limit(Math.min(Math.max(1, limit), 200))
    return rows.map((row) => ({
      userId: row.userId,
      name: row.name ?? '',
      count: row.count,
      diamonds: row.diamonds,
      lastAt: row.lastAt
    }))
  })
}

/* ------------------------------------------------- 跨直播间聚合（数据大屏） */

/**
 * 跨直播间**按人**聚合的礼物榜（数据大屏的「总送 / 总收礼物榜」）。
 *
 * 与 `giftRankByPerson` 的唯一区别是**不按 webRid 过滤**：分组键只有人
 * （`sender` 用 `user_id`、`recipient` 用 `to_user_id`），所以同一个人在多个直播间的礼物
 * 会合并成一行。昵称回退逻辑不变：优先消息里记的名字，再退回用户表。
 */
export async function giftRankByPersonAll(
  by: 'sender' | 'recipient',
  fromMs: number,
  toMs: number,
  limit = 30
): Promise<Array<Omit<GiftRankRow, 'seat'>>> {
  await schemaReady
  const idColumn = by === 'recipient' ? douyinLinkMessages.toUserId : douyinLinkMessages.userId
  const nameColumn = by === 'recipient' ? douyinLinkMessages.toUserName : douyinLinkMessages.userName
  return withOrm(`douyin-link.giftRankAll.${by}`, async (db) => {
    const rows = await db
      .select({
        userId: idColumn,
        name: sql<string>`coalesce(nullif(max(${nameColumn}), ''), max(${douyinLinkUsers.nickname}), '')`,
        count: sql<number>`count(*)::int`,
        diamonds: sql<number>`coalesce(sum(${douyinLinkMessages.diamonds}), 0)::int`,
        lastAt: sql<number>`max(${douyinLinkMessages.atMs})::double precision`
      })
      .from(douyinLinkMessages)
      .leftJoin(
        douyinLinkUsers,
        and(eq(douyinLinkUsers.webRid, douyinLinkMessages.webRid), eq(douyinLinkUsers.userId, idColumn))
      )
      .where(
        and(
          eq(douyinLinkMessages.kind, 'gift'),
          ne(idColumn, ''),
          gte(douyinLinkMessages.atMs, fromMs),
          lte(douyinLinkMessages.atMs, toMs)
        )
      )
      .groupBy(idColumn)
      .orderBy(
        desc(sql`coalesce(sum(${douyinLinkMessages.diamonds}), 0)`),
        desc(sql`count(*)`),
        desc(sql`max(${douyinLinkMessages.atMs})`)
      )
      .limit(Math.min(Math.max(1, limit), 200))
    return rows.map((row) => ({
      userId: row.userId,
      name: row.name ?? '',
      count: row.count,
      diamonds: row.diamonds,
      lastAt: row.lastAt
    }))
  })
}

/** 跨直播间的礼物种类榜（按礼物名聚合，不按房间过滤） */
export async function giftBreakdownAll(fromMs: number, toMs: number, limit = 40): Promise<GiftBreakdownRow[]> {
  await schemaReady
  return withOrm('douyin-link.giftBreakdownAll', async (db) => {
    const rows = await db
      .select({
        name: douyinLinkMessages.content,
        count: sql<number>`count(*)::int`,
        diamonds: sql<number>`coalesce(sum(${douyinLinkMessages.diamonds}), 0)::int`,
        users: sql<number>`count(distinct nullif(${douyinLinkMessages.userId}, ''))::int`
      })
      .from(douyinLinkMessages)
      .where(
        and(
          eq(douyinLinkMessages.kind, 'gift'),
          gte(douyinLinkMessages.atMs, fromMs),
          lte(douyinLinkMessages.atMs, toMs)
        )
      )
      .groupBy(douyinLinkMessages.content)
      .orderBy(desc(sql`coalesce(sum(${douyinLinkMessages.diamonds}), 0)`), desc(sql`count(*)`))
      .limit(Math.min(Math.max(1, limit), 200))
    return rows.map((row) => ({ name: row.name, count: row.count, diamonds: row.diamonds, users: row.users }))
  })
}

/**
 * 跨直播间的分钟序列（数据大屏的全局趋势）：把各房间**同一分钟**的计数相加。
 *
 * `users` 跨房相加没有意义（那是每房的去重人数），固定给 0；全局人数由 `activeUsersAll` 单独算。
 */
export async function minuteSeriesAll(fromMinute: number, toMinute: number): Promise<MinuteRow[]> {
  await schemaReady
  return withOrm('douyin-link.minuteSeriesAll', async (db) => {
    const rows = await db
      .select({
        minute: douyinLinkMinutes.minute,
        chat: sql<number>`coalesce(sum(${douyinLinkMinutes.chat}), 0)::int`,
        member: sql<number>`coalesce(sum(${douyinLinkMinutes.member}), 0)::int`,
        likes: sql<number>`coalesce(sum(${douyinLinkMinutes.likes}), 0)::int`,
        social: sql<number>`coalesce(sum(${douyinLinkMinutes.social}), 0)::int`,
        gift: sql<number>`coalesce(sum(${douyinLinkMinutes.gift}), 0)::int`,
        diamonds: sql<number>`coalesce(sum(${douyinLinkMinutes.diamonds}), 0)::int`,
        messages: sql<number>`coalesce(sum(${douyinLinkMinutes.messages}), 0)::int`
      })
      .from(douyinLinkMinutes)
      .where(and(gte(douyinLinkMinutes.minute, fromMinute), lte(douyinLinkMinutes.minute, toMinute)))
      .groupBy(douyinLinkMinutes.minute)
      .orderBy(asc(douyinLinkMinutes.minute))
    return rows.map((row) => ({
      minute: row.minute,
      chat: row.chat,
      member: row.member,
      likes: row.likes,
      social: row.social,
      gift: row.gift,
      diamonds: row.diamonds,
      messages: row.messages,
      users: 0
    }))
  })
}

/** 窗口内跨直播间**去重**的活跃用户数（数据大屏的「活跃用户」KPI） */
export async function activeUsersAll(fromMs: number, toMs: number): Promise<number> {
  await schemaReady
  return withOrm('douyin-link.activeUsersAll', async (db) => {
    const rows = await db
      .select({ value: sql<number>`count(distinct nullif(${douyinLinkMessages.userId}, ''))::int` })
      .from(douyinLinkMessages)
      .where(and(gte(douyinLinkMessages.atMs, fromMs), lte(douyinLinkMessages.atMs, toMs)))
    return rows[0]?.value ?? 0
  })
}

/** 类型分布 + 时间范围（概览页签） */export async function kindBreakdown(
  webRid: string,
  fromMs: number,
  toMs: number
): Promise<{ kinds: Array<{ kind: DanmakuKind; count: number }>; firstAt: number; lastAt: number; users: number }> {
  await schemaReady
  return withOrm('douyin-link.kindBreakdown', async (db) => {
    const rows = await db
      .select({ kind: douyinLinkMessages.kind, value: sql<number>`count(*)::int` })
      .from(douyinLinkMessages)
      .where(
        and(
          eq(douyinLinkMessages.webRid, webRid),
          gte(douyinLinkMessages.atMs, fromMs),
          lte(douyinLinkMessages.atMs, toMs)
        )
      )
      .groupBy(douyinLinkMessages.kind)
      .orderBy(desc(sql`count(*)`))
    const span = await db
      .select({
        first: sql<number>`coalesce(min(${douyinLinkMessages.atMs}), 0)`,
        last: sql<number>`coalesce(max(${douyinLinkMessages.atMs}), 0)`,
        users: sql<number>`count(distinct nullif(${douyinLinkMessages.userId}, ''))::int`
      })
      .from(douyinLinkMessages)
      .where(
        and(
          eq(douyinLinkMessages.webRid, webRid),
          gte(douyinLinkMessages.atMs, fromMs),
          lte(douyinLinkMessages.atMs, toMs)
        )
      )
    return {
      kinds: rows.map((row) => ({ kind: row.kind as DanmakuKind, count: row.value })),
      firstAt: span[0]?.first ?? 0,
      lastAt: span[0]?.last ?? 0,
      users: span[0]?.users ?? 0
    }
  })
}

/** 窗口内的互动合计（概览 KPI） */
export async function windowTotals(
  webRid: string,
  fromMs: number,
  toMs: number
): Promise<{ totals: UserStats; messages: number }> {
  const rows = await windowAggregates(fromMs, toMs)
  const hit = rows.get(webRid)
  const totals = EMPTY_STATS()
  if (hit) {
    totals.chat = hit.chat
    totals.enter = hit.member
    totals.like = hit.like
    totals.follow = hit.social
    totals.gift = hit.gift
    totals.diamonds = hit.diamonds
  }
  return { totals, messages: hit?.messages ?? 0 }
}

/** 库里行数统计（设置页与概览页脚的「数据库」一栏） */
export async function dbStats(): Promise<DbStats> {
  await schemaReady
  return withOrm('douyin-link.dbStats', async (db) => {
    const count = async (table: 'rooms' | 'messages' | 'users' | 'minutes' | 'sessions'): Promise<number> => {
      const mapping = {
        rooms: douyinLinkRooms,
        messages: douyinLinkMessages,
        users: douyinLinkUsers,
        minutes: douyinLinkMinutes,
        sessions: douyinLinkSessions
      } as const
      const rows = await db.select({ value: sql<number>`count(*)::int` }).from(mapping[table])
      return rows[0]?.value ?? 0
    }
    const span = await db
      .select({
        first: sql<number>`coalesce(min(${douyinLinkMessages.atMs}), 0)`,
        last: sql<number>`coalesce(max(${douyinLinkMessages.atMs}), 0)`
      })
      .from(douyinLinkMessages)
    return {
      rooms: await count('rooms'),
      messages: await count('messages'),
      users: await count('users'),
      minutes: await count('minutes'),
      sessions: await count('sessions'),
      firstMessageAt: span[0]?.first ?? 0,
      lastMessageAt: span[0]?.last ?? 0
    }
  })
}

/* ------------------------------------------------------------------ 键值 */

export async function getMeta(key: string): Promise<string> {
  await schemaReady
  return withOrm('douyin-link.getMeta', async (db) => {
    const rows = await db.select().from(douyinLinkMeta).where(eq(douyinLinkMeta.key, key)).limit(1)
    return rows[0]?.value ?? ''
  })
}

export async function setMeta(key: string, value: string): Promise<void> {
  await schemaReady
  await withOrm('douyin-link.setMeta', async (db) => {
    await db
      .insert(douyinLinkMeta)
      .values({ key, value, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: douyinLinkMeta.key,
        set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` }
      })
  })
}

/** 只删一个房间的消息（页面上「清空本房间记录」） */
export async function clearRoomMessages(webRid: string): Promise<number> {
  return clearMessages(webRid)
}

/** 清数据（卸载插件时勾了「同时删除数据」）：清空自己的表 */
export async function purgeTables(tables: string[]): Promise<void> {
  await schemaReady
  await withOrm('douyin-link.purgeTables', async (db) => {
    for (const table of tables) {
      // 表名来自 ./ddl.ts 的常量，不含外部输入
      await db.execute(sql.raw(`DELETE FROM ${table}`))
    }
    logger.info(`[douyin-link] 已清空 ${tables.length} 张表的全部行`)
  })
}

/* --------------------------------------------------------- 导入 / 导出 */

/**
 * 导入导出的**纯数据行**（与列一一对应，去掉自增 `id`）。
 *
 * 导出的 JSON 里用这些形状；导入时按同一套字段回填。时间一律 ms epoch。
 */
export interface MessageExportRow {
  webRid: string
  sessionId: number
  kind: string
  userId: string
  userName: string
  content: string
  count: number
  diamonds: number
  toUserId: string
  toUserName: string
  orderKey: string
  atMs: number
}

export interface UserExportRow {
  webRid: string
  userId: string
  displayId: string
  nickname: string
  gender: number
  signature: string
  city: string
  avatar: string
  following: number
  follower: number
  honorLevel: number
  fansClubLevel: number
  badges: string
  secUid: string
  chat: number
  enter: number
  likes: number
  follows: number
  gift: number
  diamonds: number
  firstSeen: number
  lastSeen: number
}

export interface MinuteExportRow {
  webRid: string
  minute: number
  chat: number
  member: number
  likes: number
  social: number
  gift: number
  diamonds: number
  messages: number
  users: number
}

export interface SessionExportRow {
  webRid: string
  startedAt: number
  endedAt: number
  messages: number
  endReason: string
}

/** 一段本地自然日（`day` 是 `YYYY-MM-DD`，`from`/`to` 是 ms epoch 的闭区间） */
export interface DayRange {
  day: string
  from: number
  to: number
}

/** 本地时区偏移（ms）：分天口径与 `dayRecords` 保持一致（PGlite 默认 UTC，必须自己平移） */
function localOffsetMs(): number {
  return -new Date().getTimezoneOffset() * 60000
}

/** 导出：一个房间有数据的**本地自然日**列表（消息与会话都算，按天倒序） */
export async function exportDayRanges(webRid: string): Promise<DayRange[]> {
  if (!webRid) return []
  await schemaReady
  const offset = Math.trunc(localOffsetMs())
  return withOrm('douyin-link.exportDayRanges', async (db) => {
    const literal = sql.raw(String(offset))
    const messageBuckets = sql`floor((${douyinLinkMessages.atMs} + ${literal}) / 86400000)`
    const sessionBuckets = sql`floor((${douyinLinkSessions.startedAt} + ${literal}) / 86400000)`
    const messageRows = await db
      .selectDistinct({ bucket: sql<number>`(${messageBuckets})::int` })
      .from(douyinLinkMessages)
      .where(eq(douyinLinkMessages.webRid, webRid))
    const sessionRows = await db
      .selectDistinct({ bucket: sql<number>`(${sessionBuckets})::int` })
      .from(douyinLinkSessions)
      .where(eq(douyinLinkSessions.webRid, webRid))
    const buckets = new Set<number>([...messageRows, ...sessionRows].map((row) => row.bucket))
    return [...buckets]
      .sort((a, b) => b - a)
      .map((bucket) => ({
        day: new Date(bucket * 86400000).toISOString().slice(0, 10),
        // 本地日 00:00 的 epoch = bucket*86400000 - offset
        from: bucket * 86400000 - offset,
        to: bucket * 86400000 - offset + 86400000 - 1
      }))
  })
}

/** 导出：一个房间在某一时段内的消息流水（按时间正序，去掉自增 id） */
export async function exportMessageRows(webRid: string, fromMs: number, toMs: number): Promise<MessageExportRow[]> {
  if (!webRid) return []
  await schemaReady
  return withOrm('douyin-link.exportMessageRows', async (db) => {
    const rows = await db
      .select({
        webRid: douyinLinkMessages.webRid,
        sessionId: douyinLinkMessages.sessionId,
        kind: douyinLinkMessages.kind,
        userId: douyinLinkMessages.userId,
        userName: douyinLinkMessages.userName,
        content: douyinLinkMessages.content,
        count: douyinLinkMessages.count,
        diamonds: douyinLinkMessages.diamonds,
        toUserId: douyinLinkMessages.toUserId,
        toUserName: douyinLinkMessages.toUserName,
        orderKey: douyinLinkMessages.orderKey,
        atMs: douyinLinkMessages.atMs
      })
      .from(douyinLinkMessages)
      .where(and(eq(douyinLinkMessages.webRid, webRid), gte(douyinLinkMessages.atMs, fromMs), lte(douyinLinkMessages.atMs, toMs)))
      .orderBy(asc(douyinLinkMessages.atMs), asc(douyinLinkMessages.id))
    return rows
  })
}

/** 导出：一个房间的分钟桶（时段内） */
export async function exportMinuteRows(webRid: string, fromMs: number, toMs: number): Promise<MinuteExportRow[]> {
  if (!webRid) return []
  await schemaReady
  const fromMinute = Math.floor(fromMs / 60000)
  const toMinute = Math.floor(toMs / 60000)
  return withOrm('douyin-link.exportMinuteRows', async (db) => {
    const rows = await db
      .select()
      .from(douyinLinkMinutes)
      .where(and(eq(douyinLinkMinutes.webRid, webRid), gte(douyinLinkMinutes.minute, fromMinute), lte(douyinLinkMinutes.minute, toMinute)))
      .orderBy(asc(douyinLinkMinutes.minute))
    return rows.map((row) => ({
      webRid: row.webRid,
      minute: row.minute,
      chat: row.chat,
      member: row.member,
      likes: row.likes,
      social: row.social,
      gift: row.gift,
      diamonds: row.diamonds,
      messages: row.messages,
      users: row.users
    }))
  })
}

/** 导出：一个房间的监控会话（按开始时间落在时段内） */
export async function exportSessionRows(webRid: string, fromMs: number, toMs: number): Promise<SessionExportRow[]> {
  if (!webRid) return []
  await schemaReady
  return withOrm('douyin-link.exportSessionRows', async (db) => {
    const rows = await db
      .select()
      .from(douyinLinkSessions)
      .where(and(eq(douyinLinkSessions.webRid, webRid), gte(douyinLinkSessions.startedAt, fromMs), lte(douyinLinkSessions.startedAt, toMs)))
      .orderBy(asc(douyinLinkSessions.startedAt))
    return rows.map((row) => ({
      webRid: row.webRid,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      messages: row.messages,
      endReason: row.endReason
    }))
  })
}

/** 导出：某个房间的全部用户档案 */
export async function exportUserRows(webRid: string): Promise<UserExportRow[]> {
  if (!webRid) return []
  await schemaReady
  return withOrm('douyin-link.exportUserRows', async (db) => {
    const rows = await db.select().from(douyinLinkUsers).where(eq(douyinLinkUsers.webRid, webRid))
    return rows.map((row) => ({
      webRid: row.webRid,
      userId: row.userId,
      displayId: row.displayId,
      nickname: row.nickname,
      gender: row.gender,
      signature: row.signature,
      city: row.city,
      avatar: row.avatar,
      following: row.following,
      follower: row.follower,
      honorLevel: row.honorLevel,
      fansClubLevel: row.fansClubLevel,
      badges: row.badges,
      secUid: row.secUid,
      chat: row.chat,
      enter: row.enter,
      likes: row.likes,
      follows: row.follows,
      gift: row.gift,
      diamonds: row.diamonds,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen
    }))
  })
}

/** 一条消息的**去重指纹**：同一房间、同一时刻、同一发送者与内容的行视为同一条 */
function messageKey(row: MessageExportRow): string {
  return [
    row.webRid,
    row.atMs,
    row.kind,
    row.userId,
    row.content,
    row.count,
    row.diamonds,
    row.toUserId,
    row.orderKey
  ].join('\u0001')
}

/**
 * 导入房间行：**只补缺、不覆盖**（`ON CONFLICT DO NOTHING`）。
 *
 * 关键：不能盖掉用户已有的 `note`（备注）与 `monitor`（监控开关）——
 * 导入一份别人的备份不该把本机正在监控的房间停下来；而**新增**的房间一律
 * `monitor = false`（导入的是「记录」，不是「现在就去连它」）。返回真正新增的个数。
 */
export async function importRooms(rows: RoomRow[]): Promise<number> {
  if (rows.length === 0) return 0
  await schemaReady
  return withOrm('douyin-link.importRooms', async (db) => {
    const inserted = await db
      .insert(douyinLinkRooms)
      .values(
        rows.map((row) => ({
          webRid: row.webRid,
          roomId: row.roomId,
          title: row.title,
          anchor: row.anchor,
          cover: row.cover,
          onlineText: row.onlineText,
          status: row.status,
          note: row.note,
          monitor: false,
          addedAt: row.addedAt,
          lastActiveAt: row.lastActiveAt,
          lastSeenAt: row.lastSeenAt
        }))
      )
      .onConflictDoNothing({ target: douyinLinkRooms.webRid })
      .returning({ webRid: douyinLinkRooms.webRid })
    return inserted.length
  })
}

/**
 * 导入用户档案：**取大、不累加**（`GREATEST` + 非空覆盖）。
 *
 * 与实时落库的 `upsertUserDeltas`（统计**累加**）刻意分开：导入是「复原一份快照」，
 * 累加会让同一个人的发言数在重复导入时翻倍——那就违背了「数据不能重复」。
 */
export async function importUsers(rows: UserExportRow[]): Promise<number> {
  if (rows.length === 0) return 0
  await schemaReady
  return withOrm('douyin-link.importUsers', async (db) => {
    let affected = 0
    for (let index = 0; index < rows.length; index += MSG_CHUNK) {
      const chunk = rows.slice(index, index + MSG_CHUNK)
      const result = await db
        .insert(douyinLinkUsers)
        .values(chunk)
        .onConflictDoUpdate({
          target: [douyinLinkUsers.webRid, douyinLinkUsers.userId],
          set: {
            displayId: keepNonEmpty('display_id'),
            nickname: keepNonEmpty('nickname'),
            signature: keepNonEmpty('signature'),
            city: keepNonEmpty('city'),
            avatar: keepNonEmpty('avatar'),
            secUid: keepNonEmpty('sec_uid'),
            badges: sql`CASE WHEN excluded.badges <> '[]' THEN excluded.badges ELSE douyin_link_users.badges END`,
            gender: greatest('gender'),
            following: greatest('following'),
            follower: greatest('follower'),
            honorLevel: greatest('honor_level'),
            fansClubLevel: greatest('fans_club_level'),
            chat: greatest('chat'),
            enter: greatest('enter'),
            likes: greatest('likes'),
            follows: greatest('follows'),
            gift: greatest('gift'),
            diamonds: greatest('diamonds'),
            firstSeen: sql`LEAST(douyin_link_users.first_seen, EXCLUDED.first_seen)`,
            lastSeen: sql`GREATEST(douyin_link_users.last_seen, EXCLUDED.last_seen)`
          }
        })
        .returning({ userId: douyinLinkUsers.userId })
      affected += result.length
    }
    return affected
  })
}

/**
 * 导入消息流水：**按指纹去重**。
 *
 * 先按房间 + 时段把库里已有的行的指纹读进来（限定在导入批次的 [minAt, maxAt] 内，
 * 不做全表扫描），再逐条比对：库里已有、或本次批次内已经收过的，一律跳过。
 * 这样重复导入同一份压缩包是**幂等**的——不会多出任何一条。
 */
export async function importMessages(rows: MessageExportRow[]): Promise<{ added: number; skipped: number }> {
  if (rows.length === 0) return { added: 0, skipped: 0 }
  await schemaReady
  return withOrm('douyin-link.importMessages', async (db) => {
    // 同一房间的行放一起，才能用一次时段查询把已有指纹读全
    const byRoom = new Map<string, MessageExportRow[]>()
    for (const row of rows) {
      const list = byRoom.get(row.webRid)
      if (list) list.push(row)
      else byRoom.set(row.webRid, [row])
    }

    const seen = new Set<string>()
    for (const [webRid, list] of byRoom) {
      let min = Infinity
      let max = -Infinity
      for (const row of list) {
        if (row.atMs < min) min = row.atMs
        if (row.atMs > max) max = row.atMs
      }
      const existing = await db
        .select({
          webRid: douyinLinkMessages.webRid,
          atMs: douyinLinkMessages.atMs,
          kind: douyinLinkMessages.kind,
          userId: douyinLinkMessages.userId,
          content: douyinLinkMessages.content,
          count: douyinLinkMessages.count,
          diamonds: douyinLinkMessages.diamonds,
          toUserId: douyinLinkMessages.toUserId,
          orderKey: douyinLinkMessages.orderKey
        })
        .from(douyinLinkMessages)
        .where(
          and(
            eq(douyinLinkMessages.webRid, webRid),
            gte(douyinLinkMessages.atMs, Number.isFinite(min) ? min : 0),
            lte(douyinLinkMessages.atMs, Number.isFinite(max) ? max : 0)
          )
        )
      for (const row of existing) seen.add(messageKey(row as MessageExportRow))
    }

    const fresh: MessageExportRow[] = []
    let skipped = 0
    for (const row of rows) {
      const key = messageKey(row)
      if (seen.has(key)) {
        skipped += 1
        continue
      }
      seen.add(key)
      fresh.push(row)
    }

    for (let index = 0; index < fresh.length; index += MSG_CHUNK) {
      await db.insert(douyinLinkMessages).values(
        fresh.slice(index, index + MSG_CHUNK).map((row) => ({
          webRid: row.webRid,
          // 会话 id 不复用（导入后 sessions 会重新分配自增 id，留旧值只会指错）
          sessionId: 0,
          kind: row.kind as DanmakuKind,
          userId: row.userId,
          userName: row.userName,
          content: row.content,
          count: row.count,
          diamonds: row.diamonds,
          toUserId: row.toUserId,
          toUserName: row.toUserName,
          orderKey: row.orderKey,
          atMs: row.atMs
        }))
      )
    }
    return { added: fresh.length, skipped }
  })
}

/** 导入分钟桶：**取大、不累加**（同一分钟重复导入保持原值） */
export async function importMinutes(rows: MinuteExportRow[]): Promise<number> {
  if (rows.length === 0) return 0
  await schemaReady
  return withOrm('douyin-link.importMinutes', async (db) => {
    let affected = 0
    for (let index = 0; index < rows.length; index += MSG_CHUNK) {
      const chunk = rows.slice(index, index + MSG_CHUNK)
      const values = sql.join(
        chunk.map(
          (row) =>
            sql`(${row.webRid}, ${row.minute}, ${row.chat}, ${row.member}, ${row.likes}, ${row.social}, ${row.gift}, ${row.diamonds}, ${row.messages}, ${row.users})`
        ),
        sql`, `
      )
      await db.execute(sql`
        INSERT INTO douyin_link_minutes (web_rid, minute, chat, member, likes, social, gift, diamonds, messages, users)
        VALUES ${values}
        ON CONFLICT (web_rid, minute) DO UPDATE SET
          chat = GREATEST(douyin_link_minutes.chat, EXCLUDED.chat),
          member = GREATEST(douyin_link_minutes.member, EXCLUDED.member),
          likes = GREATEST(douyin_link_minutes.likes, EXCLUDED.likes),
          social = GREATEST(douyin_link_minutes.social, EXCLUDED.social),
          gift = GREATEST(douyin_link_minutes.gift, EXCLUDED.gift),
          diamonds = GREATEST(douyin_link_minutes.diamonds, EXCLUDED.diamonds),
          messages = GREATEST(douyin_link_minutes.messages, EXCLUDED.messages),
          users = GREATEST(douyin_link_minutes.users, EXCLUDED.users)
      `)
      affected += chunk.length
    }
    return affected
  })
}

/** 导入监控会话：**只补缺**（同一房间、同一开始时刻的会话视为同一次） */
export async function importSessions(rows: SessionExportRow[]): Promise<number> {
  if (rows.length === 0) return 0
  await schemaReady
  return withOrm('douyin-link.importSessions', async (db) => {
    let added = 0
    for (const row of rows) {
      const found = await db
        .select({ id: douyinLinkSessions.id })
        .from(douyinLinkSessions)
        .where(and(eq(douyinLinkSessions.webRid, row.webRid), eq(douyinLinkSessions.startedAt, row.startedAt)))
        .limit(1)
      if (found.length > 0) continue
      await db.insert(douyinLinkSessions).values({
        webRid: row.webRid,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        messages: row.messages,
        endReason: row.endReason
      })
      added += 1
    }
    return added
  })
}

/* --------------------------------------------------------------- 行转换 */

function toStoredMessage(row: {
  webRid: string
  kind: string
  userId: string
  userName: string
  content: string
  count: number
  diamonds: number
  toUserId: string
  toUserName: string
  atMs: number
  id: number
}): StoredMessage {
  const message: StoredMessage = {
    id: row.id,
    webRid: row.webRid,
    kind: row.kind as DanmakuKind,
    user: row.userName,
    userId: row.userId,
    text: row.content,
    count: row.count,
    diamonds: row.diamonds ?? 0,
    toUser: row.toUserName ?? '',
    toUserId: row.toUserId ?? '',
    at: row.atMs
  }
  return message
}

function toRankRow(row: {
  userId: string
  nickname: string
  displayId: string
  avatar: string
  gender: number
  signature: string
  city: string
  badges: string
  secUid: string
  following: number
  follower: number
  honorLevel: number
  fansClubLevel: number
  chat: number
  enter: number
  likes: number
  follows: number
  gift: number
  diamonds: number
  firstSeen: number
  lastSeen: number
}): UserRankRow {
  let badges: string[] = []
  try {
    const parsed = JSON.parse(row.badges || '[]') as unknown
    if (Array.isArray(parsed)) badges = parsed.map((badge) => String(badge)).slice(0, 8)
  } catch {
    badges = []
  }
  return {
    userId: row.userId,
    nickname: row.nickname,
    displayId: row.displayId,
    avatar: row.avatar,
    gender: row.gender,
    signature: row.signature,
    city: row.city,
    badges,
    secUid: row.secUid,
    following: row.following,
    follower: row.follower,
    honorLevel: row.honorLevel,
    fansClubLevel: row.fansClubLevel,
    stats: {
      chat: row.chat,
      enter: row.enter,
      like: row.likes,
      follow: row.follows,
      gift: row.gift ?? 0,
      diamonds: row.diamonds ?? 0
    },
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen
  }
}

/** `SET col = CASE WHEN excluded.col <> '' THEN excluded.col ELSE table.col END` */
function keepNonEmpty(column: string) {
  return sql.raw(`CASE WHEN excluded.${column} <> '' THEN excluded.${column} ELSE douyin_link_users.${column} END`)
}

function greatest(column: string) {
  return sql.raw(`GREATEST(douyin_link_users.${column}, excluded.${column})`)
}
