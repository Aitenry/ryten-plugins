import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm'
import logger from 'electron-log'
import { withOrm } from '@host/main/database/orm'
import type {
  DanmakuKind,
  DbStats,
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

/** 批量插消息（按批分片，别让一条 INSERT 的参数个数顶到上限） */
export async function insertMessages(rows: MessageRow[]): Promise<void> {
  if (rows.length === 0) return
  await schemaReady
  await withOrm('douyin-link.insertMessages', async (db) => {
    for (let index = 0; index < rows.length; index += MSG_CHUNK) {
      await db.insert(douyinLinkMessages).values(rows.slice(index, index + MSG_CHUNK))
    }
  })
}

/** 条件检索（跨房间也行：`webRid` 空 = 所有房间） */
export async function queryMessages(query: MessageQuery): Promise<MessagePage> {
  await schemaReady
  return withOrm('douyin-link.queryMessages', async (db) => {
    const filters = []
    if (query.webRid) filters.push(eq(douyinLinkMessages.webRid, query.webRid))
    if (query.kind) filters.push(eq(douyinLinkMessages.kind, query.kind))
    if (query.userId) filters.push(eq(douyinLinkMessages.userId, query.userId))
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

/** 类型分布 + 时间范围（概览页签） */
export async function kindBreakdown(
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

/* --------------------------------------------------------------- 行转换 */

function toStoredMessage(row: {
  webRid: string
  kind: string
  userId: string
  userName: string
  content: string
  count: number
  diamonds: number
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
