import { and, asc, desc, eq, gte, ilike, inArray, like, lte, ne, notInArray, notLike, or, sql, type SQL } from 'drizzle-orm'
import logger from 'electron-log'
import { withOrm } from '@host/main/database/orm'
import type {
  DanmakuKind,
  DayRecordRow,
  DbStats,
  GiftBreakdownRow,
  GiftDayRow,
  GiftRankRow,
  IdentityAccountRow,
  IdentityGroup,
  LiveRoomInfo,
  MessagePage,
  MessageQuery,
  MonitorSession,
  RoomCompareRow,
  StoredMessage,
  UserIdentity,
  UserRankRow,
  UserStats,
  UserTotalsRow
} from '../../shared/types'
import {
  douyinLinkIdentities,
  douyinLinkIdentityAccounts,
  douyinLinkMessages,
  douyinLinkMeta,
  douyinLinkMinutes,
  douyinLinkRooms,
  douyinLinkSessions,
  douyinLinkUserPortraits,
  douyinLinkUsers
} from './schema'
import { schemaReady } from './ddl'
import { ANON_ID_PREFIX, ANONYMOUS_ID } from '../../shared/anonymous'
import { mergeGiftRows, storedGiftMergeInput } from '../gift/merge'
import type { UserAnalysisData } from '../analysis/portrait'
import type { ContextDanmakuRow, ContextWindow } from '../analysis/context'

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
  /**
   * 本场**见过他在麦上**（含房间主播）→ 写进 `douyin_link_users.on_mic`（粘性，`OR` 合并）。
   * AI 画像据此把主播与观众分开（用户 2026-10-13）。
   */
  onMic?: boolean
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

/**
 * **礼物的「对方」是谁**（只有礼物才有这个方向）。
 *
 * 同一行在不同人眼里方向是相反的：`from` 是送礼人、`to` 是收礼人；对「我」来说
 * 我发的就是**送出**、我在 `to` 里就是**收到**。界面靠它显示「→ 对方 / ← 对方」。
 */
export type GiftMessageDirection = 'sent' | 'received'

/** 条件检索（跨房间也行：`webRid` 空 = 所有房间） */
export async function queryMessages(query: MessageQuery): Promise<MessagePage> {
  await schemaReady
  return withOrm('douyin-link.queryMessages', async (db) => {
    const filters = []
    if (query.webRid) filters.push(eq(douyinLinkMessages.webRid, query.webRid))
    if (query.kind) filters.push(eq(douyinLinkMessages.kind, query.kind))
    /**
     * 发送者：单个 `userId` 与集合 `userIds` 合成**一个**条件（不能各推一条——两条会被 AND 起来，
     * 变成「既是 A1 又在集合里」，集合里其它 id 的行永远查不出来；2026-10-11 工装抓到的）。
     * 画像的多账号口径就是这一条：命中集合里任何一个 id 都算「这个人发的」。
     */
    const senderIds = [...new Set([...(query.userId ? [query.userId] : []), ...(query.userIds ?? [])])]
    const senderFilter =
      senderIds.length === 1
        ? eq(douyinLinkMessages.userId, senderIds[0])
        : senderIds.length > 1
          ? inArray(douyinLinkMessages.userId, senderIds)
          : undefined
    // 收礼人（礼物才有）：某人「收到的礼物历史」就是 kind='gift' + 这个条件（同样的合并口径）
    const recipientIds = [...new Set([...(query.toUserId ? [query.toUserId] : []), ...(query.toUserIds ?? [])])]
    const recipientFilter =
      recipientIds.length === 1
        ? eq(douyinLinkMessages.toUserId, recipientIds[0])
        : recipientIds.length > 1
          ? inArray(douyinLinkMessages.toUserId, recipientIds)
          : undefined
    /**
     * 两个方向都要（`bothDirections`）：送礼与收礼是**或**的关系，而不是与——
     * 这就是「某一天他送的和收的都在同一张明细里」。任一边没给条件就退回那一边的条件。
     */
    if (query.bothDirections) {
      if (senderFilter && recipientFilter) filters.push(or(senderFilter, recipientFilter)!)
      else if (senderFilter) filters.push(senderFilter)
      else if (recipientFilter) filters.push(recipientFilter)
    } else {
      if (senderFilter) filters.push(senderFilter)
      if (recipientFilter) filters.push(recipientFilter)
    }
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
            onMic: row.onMic === true,
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
            // 「见过他在麦上」是**粘性**的：一旦 true 永不回退（这一列只用来分清主播与观众）
            onMic: sql`douyin_link_users.on_mic OR EXCLUDED.on_mic`,
            firstSeen: sql`LEAST(douyin_link_users.first_seen, EXCLUDED.first_seen)`,
            lastSeen: sql`GREATEST(douyin_link_users.last_seen, EXCLUDED.last_seen)`
          }
        })
    }
  })
}

export type UserSort = 'recent' | 'chat' | 'gift'

/**
 * 某个房间的用户榜（`keyword` 匹配昵称/抖音号/id），**服务端分页**。
 *
 * 为什么带 `total` 与 `offset`：以前固定 `limit` 取前 N 条，超出的人界面永远翻不到
 * （用户 2026-10-10 反馈「不能固定 300」）。现在由界面按页查，`total` 决定页数。
 */
export async function listUsersPage(
  webRid: string,
  sort: UserSort = 'recent',
  keyword = '',
  limit = 200,
  offset = 0
): Promise<{ rows: UserRankRow[]; total: number }> {
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
    const where = and(...filters)
    const totals = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(douyinLinkUsers)
      .where(where)
    const rows = await db
      .select()
      .from(douyinLinkUsers)
      .where(where)
      .orderBy(...order)
      .limit(Math.min(Math.max(1, limit), 1000))
      .offset(Math.max(0, Math.round(offset)))
    return { rows: rows.map(toRankRow), total: totals[0]?.value ?? 0 }
  })
}

/**
 * 概览「发言榜」：**窗口内**发言最多的人（用户 2026-10-10：「发言榜要按照当天的来排」）。
 *
 * 与 `listUsersPage('chat')` 的区别：那个用用户表里的**跨会话累计** `chat`，
 * 这里是直接在**消息流水**里按 `kind = 'chat'` 数这一段的条数——所以「今天」就是今天，
 * 与概览其余部分（KPI/趋势/礼物榜）的时间范围口径一致。
 * 静态信息从用户表 left join 取（没有就空），形状对齐 `UserRankRow`。
 */
export async function chatRankByPerson(
  webRid: string,
  fromMs: number,
  toMs: number,
  limit = 10
): Promise<UserRankRow[]> {
  if (!webRid) return []
  await schemaReady
  return withOrm('douyin-link.chatRankByPerson', async (db) => {
    const rows = await db
      .select({
        userId: douyinLinkMessages.userId,
        /** 昵称优先用消息里记的那份，再退回用户表（同礼物榜的回退逻辑） */
        name: sql<string>`coalesce(nullif(max(${douyinLinkMessages.userName}), ''), max(${douyinLinkUsers.nickname}), '')`,
        chat: sql<number>`count(*)::int`,
        lastAt: sql<number>`max(${douyinLinkMessages.atMs})::double precision`
      })
      .from(douyinLinkMessages)
      .leftJoin(
        douyinLinkUsers,
        and(
          eq(douyinLinkUsers.webRid, douyinLinkMessages.webRid),
          eq(douyinLinkUsers.userId, douyinLinkMessages.userId)
        )
      )
      .where(
        and(
          eq(douyinLinkMessages.webRid, webRid),
          eq(douyinLinkMessages.kind, 'chat'),
          ne(douyinLinkMessages.userId, ''),
          gte(douyinLinkMessages.atMs, fromMs),
          lte(douyinLinkMessages.atMs, toMs)
        )
      )
      .groupBy(douyinLinkMessages.userId)
      .orderBy(desc(sql`count(*)`), desc(sql`max(${douyinLinkMessages.atMs})`))
      .limit(Math.min(Math.max(1, limit), 100))
    return rows.map((row) => ({
      userId: row.userId,
      nickname: row.name ?? '',
      displayId: '',
      avatar: '',
      gender: 0,
      signature: '',
      city: '',
      badges: [],
      secUid: '',
      following: 0,
      follower: 0,
      honorLevel: 0,
      fansClubLevel: 0,
      stats: { ...EMPTY_STATS(), chat: row.chat },
      firstSeen: 0,
      lastSeen: row.lastAt
    }))
  })
}

/**
 * 只补用户档案的**静态字段**（昵称/头像/等级…），**不动统计与时间**。
 *
 * 用在哪：在线观众里「只有 id 的人」（接口的成员名单只给 id）——按 id 去抖音查回真实资料后
 * 落库，下一轮就能显示昵称与头像（见 `hub.enrichUnknownUsers`）。
 * 刻意不复用 `upsertUserDeltas`：那个会累加统计、还会写 first/lastSeen，
 * 一个新补出来的人不该在榜上装成「刚出现过」。
 */
export interface UserStaticRow {
  userId: string
  displayId: string
  nickname: string
  gender: number
  signature: string
  city: string
  avatar: string
  following: number
  follower: number
  secUid: string
}

export async function upsertUserStatic(webRid: string, rows: UserStaticRow[]): Promise<void> {
  if (!webRid || rows.length === 0) return
  await schemaReady
  await withOrm('douyin-link.upsertUserStatic', async (db) => {
    for (let index = 0; index < rows.length; index += MSG_CHUNK) {
      const chunk = rows.slice(index, index + MSG_CHUNK)
      await db
        .insert(douyinLinkUsers)
        .values(chunk.map((row) => ({ webRid, ...row })))
        .onConflictDoUpdate({
          target: [douyinLinkUsers.webRid, douyinLinkUsers.userId],
          set: {
            displayId: keepNonEmpty('display_id'),
            nickname: keepNonEmpty('nickname'),
            signature: keepNonEmpty('signature'),
            city: keepNonEmpty('city'),
            avatar: keepNonEmpty('avatar'),
            secUid: keepNonEmpty('sec_uid'),
            gender: greatest('gender'),
            following: greatest('following'),
            follower: greatest('follower')
          }
        })
    }
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

/**
 * 一批用户**跨房间**各取最近的一行（`webRid` 为空时用，例如「数据大屏」模式下没有当前房间）。
 *
 * 为什么单独一个函数：`getUsers` 是「某个房间里的这一批人」，空 webRid 它直接返回空；
 * 而界面在大屏模式下仍然要能打开任何一个人的档案（老行为就是 `getUser('', id)` 取最近一行）。
 * 口径与 `getUser('')` 一致：**每个 id 取 last_seen 最新的那一行**，不做跨房间累加。
 */
export async function getUsersAnyRoom(userIds: string[]): Promise<Map<string, UserRankRow>> {
  const out = new Map<string, UserRankRow>()
  const ids = [...new Set(userIds.filter((id) => id.length > 0))]
  if (ids.length === 0) return out
  await schemaReady
  await withOrm('douyin-link.getUsersAnyRoom', async (db) => {
    for (let index = 0; index < ids.length; index += MSG_CHUNK) {
      const slice = ids.slice(index, index + MSG_CHUNK)
      const rows = await db
        .select()
        .from(douyinLinkUsers)
        .where(inArray(douyinLinkUsers.userId, slice))
        .orderBy(desc(douyinLinkUsers.lastSeen))
      for (const row of rows) if (!out.has(row.userId)) out.set(row.userId, toRankRow(row))
    }
  })
  return out
}

/**
 * 一批用户的**跨房间入场次数合计**（实时列表行首要显示「入场 N 次」）。
 *
 * 为什么是跨房间：用户 2026-10-11 明确要求这几个数是「这个人」的，不是「这个房间里」的
 * —— 直播场景里同一个人会在好几个房间来回进。
 */
export async function enterTotalsByUser(userIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const ids = [...new Set(userIds.filter((id) => id.length > 0))]
  if (ids.length === 0) return out
  await schemaReady
  await withOrm('douyin-link.enterTotals', async (db) => {
    for (let index = 0; index < ids.length; index += MSG_CHUNK) {
      const slice = ids.slice(index, index + MSG_CHUNK)
      const rows = await db
        .select({
          userId: douyinLinkUsers.userId,
          total: sql<number>`coalesce(sum(${douyinLinkUsers.enter}), 0)::int`
        })
        .from(douyinLinkUsers)
        .where(inArray(douyinLinkUsers.userId, slice))
        .groupBy(douyinLinkUsers.userId)
      for (const row of rows) out.set(row.userId, row.total)
    }
  })
  return out
}

/**
 * 一批用户的**跨房间互动合计**（不按 webRid 切；档案弹窗「互动统计」用）。
 *
 * 与 `enterTotalsByUser` 的区别：这里把整份互动都合了。口径与数据来源：
 * - **发言 / 进场 / 点赞 / 关注 / 送礼次数 / 送礼抖币**：`douyin_link_users` 按人把各房间的
 *   累计行加起来（每个人的每一行本身就是那个房间的累计，见表注释）；
 * - **收礼抖币**：`douyin_link_users` 里**没有**这一列（档案表按「这个人送出去多少」记），
 *   所以按收礼人过滤 `douyin_link_messages` 现算——与收礼物榜同一口径（`to_user_id` 非空，
 *   收礼人认不出来就不算，见 `shared/gift-recipient.ts`）。
 *
 * ⚠️ 消息流水会按保留期清理，而用户档案行不会：所以**收礼抖币可能比送礼抖币少**
 * （用户把保留期设成非零时）。这是数据的真实情况，不拿档案表里的数去补。
 */
export async function userStatsAnyRoom(userIds: string[]): Promise<Map<string, UserTotalsRow>> {
  const out = new Map<string, UserTotalsRow>()
  const ids = [...new Set((userIds ?? []).filter((id) => id.length > 0))]
  if (ids.length === 0) return out
  /*
   * 先给**每个问到的 id 都建一行 0**：档案行还没落库的人（本场刚出现、或者档案被清过）
   * 也有「收礼抖币」可查（那个数是从消息流水现算的）。不这么做的话，调用方拿到的是
   * `undefined`，会分不清「没这个人」和「这个人什么都没有」。
   */
  for (const id of ids) {
    out.set(id, {
      userId: id,
      chat: 0,
      enter: 0,
      like: 0,
      follow: 0,
      gift: 0,
      diamonds: 0,
      receivedDiamonds: 0
    })
  }
  await schemaReady
  await withOrm('douyin-link.userStatsAnyRoom', async (db) => {
    for (let index = 0; index < ids.length; index += MSG_CHUNK) {
      const slice = ids.slice(index, index + MSG_CHUNK)
      const rows = await db
        .select({
          userId: douyinLinkUsers.userId,
          chat: sql<number>`coalesce(sum(${douyinLinkUsers.chat}), 0)::int`,
          enter: sql<number>`coalesce(sum(${douyinLinkUsers.enter}), 0)::int`,
          likes: sql<number>`coalesce(sum(${douyinLinkUsers.likes}), 0)::int`,
          follows: sql<number>`coalesce(sum(${douyinLinkUsers.follows}), 0)::int`,
          gift: sql<number>`coalesce(sum(${douyinLinkUsers.gift}), 0)::int`,
          diamonds: sql<number>`coalesce(sum(${douyinLinkUsers.diamonds}), 0)::int`
        })
        .from(douyinLinkUsers)
        .where(inArray(douyinLinkUsers.userId, slice))
        .groupBy(douyinLinkUsers.userId)
      for (const row of rows) {
        out.set(row.userId, {
          userId: row.userId,
          chat: row.chat,
          enter: row.enter,
          like: row.likes,
          follow: row.follows,
          gift: row.gift,
          diamonds: row.diamonds,
          receivedDiamonds: 0
        })
      }
      /*
       * 收礼抖币：只认**别人送给他**的礼物。两种「自环」都要排掉：
       * - 同行自己送自己（`user_id = to_user_id`，真发生过）；
       * - **画像里自己名下的另一个号**送来的（`user_id` 也在 `slice` 里）——阿甲拿小号给大号刷礼物，
       *   那不是「收到的礼」，算进去会让送礼/收礼两个数字互相灌水（与「分析用户」的关系网同一口径，
       *   见 `userAnalysisData` 的 `selfLoopOut`）。
       * `to_user_id` 为空的行是「认不出收礼人」，也不计。
       */
      const selfLoopOut = slice.length > 1 ? notInArray(douyinLinkMessages.userId, slice) : undefined
      const received = await db
        .select({
          userId: douyinLinkMessages.toUserId,
          diamonds: sql<number>`coalesce(sum(${douyinLinkMessages.diamonds}), 0)::int`
        })
        .from(douyinLinkMessages)
        .where(
          and(
            inArray(douyinLinkMessages.toUserId, slice),
            eq(douyinLinkMessages.kind, 'gift'),
            ne(douyinLinkMessages.toUserId, ''),
            ne(douyinLinkMessages.userId, douyinLinkMessages.toUserId),
            selfLoopOut
          )
        )
        .groupBy(douyinLinkMessages.toUserId)
      for (const row of received) {
        const hit = out.get(row.userId)
        if (hit) hit.receivedDiamonds = row.diamonds
      }
    }
  })
  return out
}

/**
 * 某个人（含画像绑定的全部账号）的**逐日送礼 / 收礼抖币**，跨全部直播间。
 *
 * 给档案弹窗的「每日收益」日历用（用户 2026-10-11：「点击后可以查看每一个月的每一天送礼和
 * 收礼的抖币，这个内容 UI 向股票的每日收益的样式」）。三条口径：
 * - **按本地自然日**分格（与「每日记录」同一个偏移算法：`(at_ms + 偏移) / 86400000`）；
 * - **送礼** = 他发的礼物行的抖币合计；**收礼** = 别人送给他的礼物行的抖币合计；
 * - `days` 只回**范围内有记录**的日子，没记录的那天由界面画成空格子（不回 0 行）。
 *
 * `fromBucket` / `toBucket` 由调用方按本地月份算好（见 `monthBucketRange`）。
 */
export async function userGiftDays(
  userIds: string[],
  fromBucket: number,
  toBucket: number
): Promise<GiftDayRow[]> {
  const ids = [...new Set((userIds ?? []).filter((id) => id.length > 0))]
  if (ids.length === 0) return []
  await schemaReady
  const offsetMs = -new Date().getTimezoneOffset() * 60000
  return withOrm('douyin-link.userGiftDays', async (db) => {
    // 时区偏移必须是字面量（GROUP BY / ORDER BY 会各渲染一次，绑定参数会被当成两个表达式）
    const offset = sql.raw(String(Math.trunc(offsetMs)))
    const buckets = sql`floor((${douyinLinkMessages.atMs} + ${offset}) / 86400000)`
    const inRange = and(
      gte(buckets, sql`${fromBucket}`),
      lte(buckets, sql`${toBucket}`)
    )
    const sent = await db
      .select({
        bucket: sql<number>`(${buckets})::int`,
        diamonds: sql<number>`coalesce(sum(${douyinLinkMessages.diamonds}), 0)::int`,
        gifts: sql<number>`count(*)::int`
      })
      .from(douyinLinkMessages)
      .where(and(inArray(douyinLinkMessages.userId, ids), eq(douyinLinkMessages.kind, 'gift'), inRange))
      .groupBy(buckets)
    const received = await db
      .select({
        bucket: sql<number>`(${buckets})::int`,
        diamonds: sql<number>`coalesce(sum(${douyinLinkMessages.diamonds}), 0)::int`,
        gifts: sql<number>`count(*)::int`
      })
      .from(douyinLinkMessages)
      .where(
        and(
          inArray(douyinLinkMessages.toUserId, ids),
          eq(douyinLinkMessages.kind, 'gift'),
          ne(douyinLinkMessages.userId, douyinLinkMessages.toUserId),
          inRange
        )
      )
      .groupBy(buckets)

    const days = new Map<number, GiftDayRow>()
    const ensure = (bucket: number): GiftDayRow => {
      const hit = days.get(bucket)
      if (hit) return hit
      const row: GiftDayRow = { day: new Date(bucket * 86400000).toISOString().slice(0, 10), bucket, sent: 0, received: 0, sentGifts: 0, receivedGifts: 0 }
      days.set(bucket, row)
      return row
    }
    for (const row of sent) {
      const day = ensure(row.bucket)
      day.sent = row.diamonds
      day.sentGifts = row.gifts
    }
    for (const row of received) {
      const day = ensure(row.bucket)
      day.received = row.diamonds
      day.receivedGifts = row.gifts
    }
    return [...days.values()].sort((a, b) => a.bucket - b.bucket)
  })
}

/** 某个人有礼物记录的月份（`YYYY-MM`，按本地月份、倒序）——日历翻页的边界 */
export async function userGiftMonths(userIds: string[]): Promise<string[]> {
  const ids = [...new Set((userIds ?? []).filter((id) => id.length > 0))]
  if (ids.length === 0) return []
  await schemaReady
  const offsetMs = -new Date().getTimezoneOffset() * 60000
  return withOrm('douyin-link.userGiftMonths', async (db) => {
    const offset = sql.raw(String(Math.trunc(offsetMs)))
    const dayBucket = sql`floor((${douyinLinkMessages.atMs} + ${offset}) / 86400000)`
    const scope = and(
      eq(douyinLinkMessages.kind, 'gift'),
      or(
        inArray(douyinLinkMessages.userId, ids),
        and(inArray(douyinLinkMessages.toUserId, ids), ne(douyinLinkMessages.userId, douyinLinkMessages.toUserId))
      )
    )
    const rows = await db
      .select({
        month: sql<string>`to_char(to_timestamp((${dayBucket})::bigint * 86400), 'YYYY-MM')`
      })
      .from(douyinLinkMessages)
      .where(scope)
      .groupBy(sql`to_char(to_timestamp((${dayBucket})::bigint * 86400), 'YYYY-MM')`)
      .orderBy(desc(sql`to_char(to_timestamp((${dayBucket})::bigint * 86400), 'YYYY-MM')`))
    return rows.map((row) => row.month).filter(Boolean)
  })
}


export async function todayGiftTotals(dayStart: number): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  await schemaReady
  return withOrm('douyin-link.todayGiftTotals', async (db) => {
    const rows = await db
      .select({
        userId: douyinLinkMessages.userId,
        total: sql<number>`coalesce(sum(${douyinLinkMessages.diamonds}), 0)::int`
      })
      .from(douyinLinkMessages)
      .where(
        and(
          eq(douyinLinkMessages.kind, 'gift'),
          gte(douyinLinkMessages.atMs, dayStart),
          ne(douyinLinkMessages.userId, '')
        )
      )
      .groupBy(douyinLinkMessages.userId)
    for (const row of rows) if (row.total > 0) out.set(row.userId, row.total)
    return out
  })
}

export async function clearUsers(webRid = ''): Promise<void> {
  await schemaReady
  await withOrm('douyin-link.clearUsers', async (db) => {
    await db.delete(douyinLinkUsers).where(webRid ? eq(douyinLinkUsers.webRid, webRid) : undefined)
  })
}

/**
 * **补档案**：把「有消息流水、但没有档案行」的人按消息流水补出来（历史数据修复）。
 *
 * 什么时候需要（2026-10-11）：0.15.9 及以前 `RoomRecorder.takeUserDeltas` 有配额饥饿 bug——
 * 一个房间里本场用户超过 400 人之后，新出现的人**永远不会**被写进 `douyin_link_users`，
 * 而他们的消息照常进 `douyin_link_messages`。表现是档案弹窗报「没有这个用户的档案」，
 * 但按 id 去抖音仍能查到人（机制与真库证据见 `main/monitor/recorder.ts` 的 `takeUserDeltas` 注释）。
 *
 * 口径：
 * - **只补缺的行**（`on conflict do nothing`）：已有档案的人一个字段都不动，统计也不会翻倍；
 * - 能从流水复原的：昵称（**最近一条非空**的名字）、五类互动次数、送礼次数与抖币、首末时间；
 *   复原不了的：头像 / 抖音号 / 荣誉等级 / secUid（流水里没有）——留给「在线观众按 id 补资料」
 *   与后续监控继续补空；
 * - 统计口径与实时写入逐条对齐：`chat/enter/likes/follows` = 条数、`gift` = 礼物行数、
 *   `diamonds` = 礼物行抖币之和、`first_seen/last_seen` = 最早/最晚一条消息的时刻。
 *
 * 返回补出来的行数。
 */
export async function repairUsersFromMessages(webRid = ''): Promise<number> {
  await schemaReady
  return withOrm('douyin-link.repairUsers', async (db) => {
    const scope = webRid ? sql`and m.web_rid = ${webRid}` : sql``
    const gapResult = await db.execute<{ value: number }>(sql`
      select count(*)::int as value from (
        select distinct m.web_rid, m.user_id from douyin_link_messages m
        where m.user_id <> '' ${scope}
      ) missing
      where not exists (
        select 1 from douyin_link_users u
        where u.web_rid = missing.web_rid and u.user_id = missing.user_id
      )`)
    const gap = Number(gapResult.rows?.[0]?.value ?? 0)
    if (gap === 0) return 0

    const inserted = await db.execute(sql`
      insert into douyin_link_users (
        web_rid, user_id, nickname, chat, enter, likes, follows, gift, diamonds, first_seen, last_seen
      )
      select
        m.web_rid,
        m.user_id,
        coalesce((array_agg(m.user_name order by m.at_ms desc) filter (where m.user_name <> ''))[1], ''),
        count(*) filter (where m.kind = 'chat')::int,
        count(*) filter (where m.kind = 'member')::int,
        count(*) filter (where m.kind = 'like')::int,
        count(*) filter (where m.kind = 'social')::int,
        count(*) filter (where m.kind = 'gift')::int,
        coalesce(sum(m.diamonds) filter (where m.kind = 'gift'), 0)::int,
        min(m.at_ms),
        max(m.at_ms)
      from douyin_link_messages m
      where m.user_id <> '' ${scope}
      group by m.web_rid, m.user_id
      on conflict (web_rid, user_id) do nothing`)
    return typeof inserted.affectedRows === 'number' ? inserted.affectedRows : gap
  })
}

/**
 * **匿名身份拆分**（一次性迁移）：把历史上「所有匿名用户共用占位 id `111111`」的行，
 * 按马甲名拆成 `anon:<占位 id>#<马甲>`（见 `shared/anonymous.ts`）。
 *
 * 为什么必须迁移历史数据（2026-10-12 用户报障「匿名用户，内容监控会重复，这么严重的 bug」）：
 * 新写入从这一版起就按马甲分开，但**库里已经堆在一起的那份不会自己散开**——档案弹窗
 * 打开 `111111` 看到的仍是十几个互不相干的人合出来的「互动统计 13 条弹幕 / 53 次进场」
 * 与一条混合时间线的「历史弹幕」。所以装载时把这个箱子按马甲重新分装一次。
 *
 * 四条口径：
 * 1. **只动匿名那部分**（`user_id = 占位 id`，或 `anon:` 开头但没有马甲段的残缺行），
 *    真实用户的 id 一个都不碰；
 * 2. **可反复跑**（幂等）：拆过的行（`anon:…#马甲`）会被跳过，跑第二遍什么都不改；
 * 3. 拆出来**落回同一个 `user_id` 列**——这一列从此是「内部身份键」，展示真抖音 id 的地方
 *    走 `rawDouyinId()`（`shared/anonymous.ts`）；
 * 4. 拆分后同一个人在不同帧里仍可能是两行（马甲换过、或早期帧没名字），所以遇到
 *    `(web_rid, user_id)` 撞行时**把两行并成一行**：统计相加、静态字段取非空、时间取首末。
 *
 * 返回改动的行数（消息 + 用户档案），装载时打一条日志。
 */
export async function splitAnonymousIdentities(): Promise<number> {
  await schemaReady
  return withOrm('douyin-link.splitAnonymous', async (db) => {
    /** 名字 → 马甲（与 `shared/anonymous.ts` 的 `anonymousMask` 逐字对齐：昵称优先，其次抖音号） */
    const mask = sql<string>`trim(regexp_replace(coalesce(nullif(btrim(u.nickname), ''), nullif(btrim(u.display_id), ''), ''), '\s+', ' ', 'g'))`
    /**
     * 马甲是「信息量为零的占位名」（空 / 匿名 / 神秘人），**或者通用打码名**（`秋***`：
     * 抖音给所有隐藏身份观众都用它，十几个人同名——当身份用就又把人并起来了）。
     * 这两种都认不出人 → 归到**本房间的未知桶**（与运行时 `hub.anonymousKeyOf` 同一口径）。
     */
    const placeholder = sql`(${mask} = '' or ${mask} like '%匿名%' or ${mask} like '%神秘人%' or lower(${mask}) like '%anonymous%' or ${mask} like '%**')`
    /** 旧键 → 新键：`111111` → `anon:111111#dou2056511`；认不出的 → `anon:111111#room:<房间>` */
    const newKey = sql<string>`${ANON_ID_PREFIX} || replace(u.user_id, ${ANON_ID_PREFIX}, '') || '#' ||
      case when ${placeholder} then 'room:' || u.web_rid
        else left(${mask}, 24)
      end`
    const unsplit = sql`(u.user_id = ${ANONYMOUS_ID} or (u.user_id like ${`${ANON_ID_PREFIX}%`} and position('#' in u.user_id) = 0))`

    /**
     * 消息行自己的马甲（**与 `shared/anonymous.ts` 的 `anonymousMask` 同规则**）：
     * 先归一化空白、再去掉抖音给匿名名挂的装饰（`☞`、`-`、空格），最后截到 24 字符。
     *
     * **通用打码名（`秋***`）不算马甲**：它是抖音给所有隐藏身份观众的「首字+星号」，
     * 十几个人同名——当身份用就又把人并起来了。这类行留给 ② 去归「一个房间一个未知桶」。
     */
    const nameOf = sql<string>`left(btrim(ltrim(regexp_replace(btrim(m.user_name), '\s+', ' ', 'g'), '☞·-— ')), 24)`
    const maskOfRow = sql<string>`btrim(regexp_replace(btrim(m.user_name), '\s+', ' ', 'g'))`
    const namedRow = sql`(${nameOf} <> '' and ${nameOf} not like '%匿名%' and ${nameOf} not like '%神秘人%' and lower(${nameOf}) not like '%anonymous%' and ${maskOfRow} not like '%**')`
    /** 通用打码名（`秋***` / `M***`）：认不出人 → ② 里归「本房间的未知桶」 */
    const genericRow = sql`(${maskOfRow} like '%**')`
    const splitId = sql<string>`${ANON_ID_PREFIX} || replace(m.user_id, ${ANON_ID_PREFIX}, '') || '#' || ${nameOf}`
    /** 消息行上的同一个判据（`u` → `m`：这一列两处都要判） */
    const unsplitMessage = sql`(m.user_id = ${ANONYMOUS_ID} or (m.user_id like ${`${ANON_ID_PREFIX}%`} and position('#' in m.user_id) = 0))`
    /** 收礼人那一列（没有名字，只能按档案行的马甲换） */
    const splitRecipient = sql<string>`${ANON_ID_PREFIX} || replace(m.to_user_id, ${ANON_ID_PREFIX}, '') || '#' ||
      case when ${placeholder}
        then 'lv' || greatest(u.honor_level, 0) || '_fc' || greatest(u.fans_club_level, 0)
        else left(${mask}, 24)
      end`

    let touched = 0

    /**
     * ① **档案行：先给「只在消息流水里出现过」的马甲补一行，再把旧键整体换掉。**
     *
     * 为什么绕这一圈（2026-10-12 工装抓到的）：真库里 `(web_rid, user_id)` 是唯一键，
     * 十几个马甲的档案**只剩下最后一个写进来的那个**，其余只存在于消息行的 `user_name` 里；
     * 直接把那一行换键，就等于把十几个人的统计全算到那一个马甲头上（又一次「重复」）。
     * 所以先按**消息行自己的名字**把认得出的马甲补出档案（统计按流水现算），
     * 换键时它们各自对上自己的新键（撞行就相加）。
     *
     * 统计走一层「按 (房间, 马甲) 先算好」的子查询：`select` 里再拼 `anon:…#马甲`
     * 这种表达式（Postgres 不许在 `group by` 里直接引用同一层的表达式）。
     *
     * ⚠️ 顺序要紧：**档案先于消息流水**。反过来的话，消息行的 id 已经换成新键，
     * 这一步的 `where`（只认旧键）就再也匹配不到那些行——2026-10-12 工装就是这么抓到的。
     */
    await db.execute(sql`
      insert into douyin_link_users (
        web_rid, user_id, nickname, chat, enter, likes, follows, gift, diamonds, first_seen, last_seen
      )
      select
        g.web_rid,
        ${ANON_ID_PREFIX} || ${ANONYMOUS_ID} || '#' || g.name,
        g.name,
        g.chat, g.enter, g.likes, g.follows, g.gift, g.diamonds, g.first_seen, g.last_seen
      from (
        select
          m.web_rid,
          ${nameOf} as name,
          count(*) filter (where m.kind = 'chat')::int as chat,
          count(*) filter (where m.kind = 'member')::int as enter,
          count(*) filter (where m.kind = 'like')::int as likes,
          count(*) filter (where m.kind = 'social')::int as follows,
          count(*) filter (where m.kind = 'gift')::int as gift,
          coalesce(sum(m.diamonds) filter (where m.kind = 'gift'), 0)::int as diamonds,
          min(m.at_ms) as first_seen,
          max(m.at_ms) as last_seen
        from douyin_link_messages m
        where m.user_id <> '' and ${unsplitMessage} and ${namedRow}
        group by m.web_rid, ${nameOf}
      ) g
      on conflict (web_rid, user_id) do nothing`)

    /**
     * ② 旧档案行换键。`(web_rid, user_id)` 是唯一键，而新键按马甲算——**同一个旧键在同一房间
     *    会散成好几行**（马甲名不同），所以先把新行插出来，最后删旧行。
     *
     * **撞行时以 ① 补出来的那行为准（`excluded`）**：旧行那份统计是「十几个人加在一起」的
     * 脏账（旧版把所有匿名用户按一个 id 累加），而 ① 的统计是按消息流水现算的、
     * 只算这个马甲自己的行。所以这里不能再相加，也不能保留旧值——直接覆盖。
     * 唯一保留旧值的是头像/签名/等级这类静态字段：流水里没有，只有旧行记过。
     * （早先写成 `chat + excluded.chat` 是错的：真库副本上 dou2056511 因此变成「4 条弹幕」，
     * 而库里属于他的弹幕行是 0 条——2026-10-12 真库排练抓到的。）
     */
    const moved = await db.execute(sql`
      insert into douyin_link_users (
        web_rid, user_id, display_id, nickname, gender, signature, city, avatar, following, follower,
        honor_level, fans_club_level, badges, sec_uid, chat, enter, likes, follows, gift, diamonds,
        first_seen, last_seen
      )
      select u.web_rid, ${newKey}, u.display_id, u.nickname, u.gender, u.signature, u.city, u.avatar,
        u.following, u.follower, u.honor_level, u.fans_club_level, u.badges, u.sec_uid,
        u.chat, u.enter, u.likes, u.follows, u.gift, u.diamonds, u.first_seen, u.last_seen
      from douyin_link_users u
      where u.user_id <> '' and ${unsplit} and ${newKey} <> u.user_id
      on conflict (web_rid, user_id) do update set
        chat = excluded.chat,
        enter = excluded.enter,
        likes = excluded.likes,
        follows = excluded.follows,
        gift = excluded.gift,
        diamonds = excluded.diamonds,
        first_seen = excluded.first_seen,
        last_seen = excluded.last_seen,
        nickname = case when douyin_link_users.nickname = '' then excluded.nickname else douyin_link_users.nickname end,
        display_id = case when douyin_link_users.display_id = '' then excluded.display_id else douyin_link_users.display_id end,
        avatar = case when douyin_link_users.avatar = '' then excluded.avatar else douyin_link_users.avatar end,
        signature = case when douyin_link_users.signature = '' then excluded.signature else douyin_link_users.signature end,
        city = case when douyin_link_users.city = '' then excluded.city else douyin_link_users.city end,
        sec_uid = case when douyin_link_users.sec_uid = '' then excluded.sec_uid else douyin_link_users.sec_uid end,
        honor_level = greatest(douyin_link_users.honor_level, excluded.honor_level),
        fans_club_level = greatest(douyin_link_users.fans_club_level, excluded.fans_club_level),
        following = greatest(douyin_link_users.following, excluded.following),
        follower = greatest(douyin_link_users.follower, excluded.follower)`)
    touched += Number(moved.affectedRows ?? 0) || 0
    // 旧行清掉：它记的统计已经不再代表任何一个人（见上），新行才是准的
    const dropped = await db.execute(sql`
      delete from douyin_link_users u where u.user_id <> '' and ${unsplit} and ${newKey} <> u.user_id`)
    touched += Number(dropped.affectedRows ?? 0) || 0

    /**
     * ③ **消息流水按「行自己的名字」换 id**（一次 UPDATE 就够：同一个旧 id 在不同房间、不同行
     *    各自算自己的新键）。放在档案之后：这一步之后旧键就没了，反过来的话 ① 的补档案
     *    再也匹配不到那些行。
     *
     * 认不出名字的占位名帧**留在原处**——宁可留着旧样子（一条没有身份的共用行），
     * 也不能把两个匿名的人并成一个新的假身份。
     */
    const rows = await db.execute(sql`
      update douyin_link_messages m
      set user_id = ${splitId}
      where m.user_id <> '' and ${unsplitMessage} and ${namedRow}`)
    touched += Number(rows.affectedRows ?? 0) || 0
    /** 收礼人那一列同样只有 id、没有名字：按**档案行**的马甲换（那个人的档案里有名字） */
    const received = await db.execute(sql`
      update douyin_link_messages m
      set to_user_id = ${splitRecipient}
      from douyin_link_users u
      where u.web_rid = m.web_rid and m.to_user_id = u.user_id
        and ${unsplit} and ${splitRecipient} <> m.to_user_id`)
    touched += Number(received.affectedRows ?? 0) || 0

    return touched
  })
}

/**
 * **匿名身份还原用的候选账号**（2026-10-12，见 `main/douyin/anonymous-reveal.ts`）。
 *
 * 为什么需要它：匿名观众的真实 id 在抖音那边查不到（三条实测死路见那个文件），
 * 唯一还可能指向真人的线索是**马甲名里那截数字**（`dou2056511` → `2056511`，实测是真实 id 的尾段）。
 * 所以拿它在**我们自己已经见过的身份**里收窄一遍——`(用户 id 以该尾段结尾)` 或者
 * `(昵称就是这个马甲名)`，外加本房间画像里已经绑定的账号。
 *
 * **这只是「收窄」，不是结论**：判定必须再过 `matchAnonymousCandidate`（尾段 + 粉丝 + 关注三条全中）。
 * 顺序按「最近出现」排，界面上真要还原时也只认全中的那一条。
 */
export async function getAnonymousCandidates(
  webRid: string,
  mask: string,
  tail: string,
  limit = 40
): Promise<UserRankRow[]> {
  if (!tail && !mask) return []
  void webRid
  await schemaReady
  return withOrm('douyin-link.anonymousCandidates', async (db) => {
    const filters = []
    if (tail) filters.push(like(douyinLinkUsers.userId, `%${tail}`))
    if (mask) filters.push(eq(douyinLinkUsers.nickname, mask))
    const rows = await db
      .select()
      .from(douyinLinkUsers)
      .where(
        and(ne(douyinLinkUsers.userId, ANONYMOUS_ID), notLike(douyinLinkUsers.userId, `${ANON_ID_PREFIX}%`), or(...filters))
      )
      .orderBy(desc(douyinLinkUsers.lastSeen))
      .limit(Math.min(Math.max(1, limit), 200))
    return rows.map(toRankRow)
  })
}

/**
 * **空名字回填**（一次性迁移）：消息行里 `user_name` 是空的，而我们自己的用户档案里**有**这个名字时，
 * 把名字补回去（发送者列与收礼人列各一条语句）。
 *
 * 由来（2026-10-11 用户报障「神秘人七阶获取不了名称」）：补名字那条链以前**只对礼物类帧**做，
 * 弹幕/进场帧没带名字时从来没查过库；而且 `identifyBatch` 还会把「神秘人/匿名」这类名字当占位清掉。
 * 运行期两处都已修（见 `hub.resolveMissingNames` 与 `shared/anonymous.ts` 的 `isUsableNickname`），
 * 但**已经落库的那些空名字行不会自己变好**——这份迁移就是补它们。
 *
 * 三条口径：
 * 1. **只补空的**（`user_name = ''`），已有名字的一个字都不动；
 * 2. **只补真名字**：档案里的昵称不能是空、也不能是打码名（`%**`）或占位名（`%匿名%`）——
 *    把 `秋***` 这种写进消息行毫无意义（下次拆分时还得再判断一次）；
 * 3. **按 (房间, 用户 id) 精确对齐**：名字取自同一房间的档案行，绝不跨房间借名字
 *    （同一个 id 在 A 房叫「张三」、在 B 房叫别的，跨房借就是张冠李戴）。
 *
 * 幂等：跑第二遍时 `user_name = ''` 的行已经补上了，自然什么都不改。返回补了多少行。
 *
 * 顺带**清掉历史垃圾名**（第 4 条口径，见 `clearMaskNames`）：修复前把 `张**` / `秋***` / `***`
 * 这类打码名写进了消息行，那是没有任何信息量的假名字——留着只会在界面上假装是个名字。
 * 只清「打码名」这一种形状，真昵称（哪怕叫「神秘人七阶」）一个字都不动。
 */
export async function backfillMessageNames(): Promise<number> {
  await schemaReady
  return withOrm('douyin-link.backfillNames', async (db) => {
    /**
     * 名字可用性判据（与 `shared/anonymous.ts` 的 `isUsableNickname` 对齐）：
     * 非空、且不是打码名（`秋***`）、也不是占位名（`匿名`/`神秘人*` 那种**通用**占位）。
     * 注意只排除**通用**占位：真账号自己起名「神秘人七阶」是允许的，那种要留下。
     */
    const usable = (column: SQL): SQL =>
      sql`(${column} <> '' and ${column} not like '%**' and ${column} not like '匿名' and ${column} not like '神秘人')`
    const sent = await db.execute(sql`
      update douyin_link_messages m
      set user_name = u.nickname
      from douyin_link_users u
      where m.web_rid = u.web_rid and m.user_id = u.user_id
        and m.user_name = '' and m.user_id <> ''
        and ${usable(sql`u.nickname`)}`)
    const received = await db.execute(sql`
      update douyin_link_messages m
      set to_user_name = u.nickname
      from douyin_link_users u
      where m.web_rid = u.web_rid and m.to_user_id = u.user_id
        and m.to_user_name = '' and m.to_user_id <> ''
        and ${usable(sql`u.nickname`)}`)
    return (Number(sent.affectedRows ?? 0) || 0) + (Number(received.affectedRows ?? 0) || 0)
  })
}

/**
 * **清掉「打码名当名字」的历史垃圾**：修复前有两条路会把 `张**` / `秋***` / `***` 这类
 * 打码名写进消息行（`displayNickname` 只在部分路径生效 + 老的 `isAnonymousName` 不认打码名）。
 *
 * 判断很保守：
 * - **消息行**：名字以 `**` 结尾 → 清空（那种形状不可能是真昵称）；若这一行有 id，
 *   再拿**同房间的档案**里的可用名字补上（顺手救回真名）；
 * - **档案行**：昵称本身是打码名 → 清空（档案里留着它，用户榜上就会出现一排「张**」）。
 *
 * 幂等：清完的行名字是空串，第二遍没有匹配项。返回清了多少行。
 */
export async function clearMaskNames(): Promise<number> {
  await schemaReady
  return withOrm('douyin-link.clearMaskNames', async (db) => {
    const cleared = await db.execute(sql`
      update douyin_link_messages
      set user_name = ''
      where user_name like '%**'`)
    const clearedRecipient = await db.execute(sql`
      update douyin_link_messages
      set to_user_name = ''
      where to_user_name like '%**'`)
    const clearedProfiles = await db.execute(sql`
      update douyin_link_users
      set nickname = ''
      where nickname like '%**'`)
    return (
      (Number(cleared.affectedRows ?? 0) || 0) +
      (Number(clearedRecipient.affectedRows ?? 0) || 0) +
      (Number(clearedProfiles.affectedRows ?? 0) || 0)
    )
  })
}

/* --------------------------------------------------------------- 画像（多账号） *//**
 * 画像：**一个人可以有多个抖音账号，但画像只有一个**（用户 2026-10-11 的要求）。
 *
 * 三条口径：
 * 1. **身份键永远是抖音数字 id**（`douyin_link_identity_accounts.user_id` 是主键）——
 *    昵称会改、会重名、匿名时还会被占位串抹掉，所以昵称只用来显示，永不参与关联；
 * 2. **绑定关系是全局的**（不带 `web_rid`）：同一个人在 A 房和 B 房是同一个人；
 * 3. 所有「按人」的聚合都先经 `resolveAccountIds()` 换成 id 集合，再按集合查
 *    （画像 / 档案 / 历史；榜单仍按账号分行——那是「哪个号在刷」，与「这个人是谁」是两回事）。
 */

/** `in (…)` 的**参数化**字面量列表：`inArray` 只能用在 drizzle 的 select 构造器里，
 *  而下面几个画像查询要裸 SQL，所以自己拼一份（仍走绑定参数，不拼字符串） */
function idInList(ids: string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  )
}

/** `db.execute` 的行类型要求带索引签名，接口本身没有 → 交叉一层再断言（宿主的 Orm 泛型是 any） */
type RawRow<T> = T & Record<string, unknown>


/**
 * 账号概览的聚合（跨房间并成一份）：昵称/抖音号/头像取**最近一次见到**的那份，
 * 五类互动与抖币各自累加、首见取最早、末见取最晚、房间数去重。
 */
function accountBriefsQuery(where: SQL): SQL {
  return sql`
    select
      u.user_id as "userId",
      coalesce((array_agg(u.nickname order by u.last_seen desc) filter (where u.nickname <> ''))[1], '') as "nickname",
      coalesce((array_agg(u.display_id order by u.last_seen desc) filter (where u.display_id <> ''))[1], '') as "displayId",
      coalesce((array_agg(u.avatar order by u.last_seen desc) filter (where u.avatar <> ''))[1], '') as "avatar",
      coalesce(sum(u.chat), 0)::int as "chat",
      coalesce(sum(u.enter), 0)::int as "enter",
      coalesce(sum(u.likes), 0)::int as "likes",
      coalesce(sum(u.follows), 0)::int as "follows",
      coalesce(sum(u.gift), 0)::int as "gift",
      coalesce(sum(u.diamonds), 0)::int as "diamonds",
      coalesce(min(nullif(u.first_seen, 0)), 0)::double precision as "firstSeen",
      coalesce(max(u.last_seen), 0)::double precision as "lastSeen",
      count(distinct u.web_rid)::int as "rooms"
    from douyin_link_users u
    where ${where}
    group by u.user_id
  `
}

/** 这个抖音 id 属于哪个画像（0 = 没绑定） */
export async function identityOf(userId: string): Promise<number> {
  const id = String(userId ?? '').trim()
  if (!id) return 0
  await schemaReady
  return withOrm('douyin-link.identityOf', async (db) => {
    const rows = await db
      .select({ identityId: douyinLinkIdentityAccounts.identityId })
      .from(douyinLinkIdentityAccounts)
      .where(eq(douyinLinkIdentityAccounts.userId, id))
      .limit(1)
    return rows[0]?.identityId ?? 0
  })
}

/** 这个 id 的**全部账号**（含它自己）。没绑定 = 只有它自己。所有按人的聚合都先过这一层。 */
export async function resolveAccountIds(userId: string): Promise<string[]> {
  const id = String(userId ?? '').trim()
  if (!id) return []
  const identityId = await identityOf(id)
  if (!identityId) return [id]
  await schemaReady
  return withOrm('douyin-link.resolveAccountIds', async (db) => {
    const rows = await db
      .select({ userId: douyinLinkIdentityAccounts.userId })
      .from(douyinLinkIdentityAccounts)
      .where(eq(douyinLinkIdentityAccounts.identityId, identityId))
    const ids = rows.map((row) => row.userId)
    return ids.includes(id) ? ids : [id, ...ids]
  })
}

/** 画像视图：名字 + 主账号 + 全部账号（跨房间概览）。没绑定就返回「一个账号的画像」。 */
export async function userIdentity(userId: string): Promise<UserIdentity> {
  const id = String(userId ?? '').trim()
  if (!id) return { identityId: 0, name: '', note: '', primaryUserId: '', accounts: [] }
  await schemaReady
  return withOrm('douyin-link.userIdentity', async (db) => {
    const owner = await db
      .select({ identityId: douyinLinkIdentityAccounts.identityId })
      .from(douyinLinkIdentityAccounts)
      .where(eq(douyinLinkIdentityAccounts.userId, id))
      .limit(1)
    const identityId = owner[0]?.identityId ?? 0
    const identity = identityId
      ? (
          await db
            .select()
            .from(douyinLinkIdentities)
            .where(eq(douyinLinkIdentities.id, identityId))
            .limit(1)
        )[0]
      : undefined
    const members = identityId
      ? await db
          .select({ userId: douyinLinkIdentityAccounts.userId })
          .from(douyinLinkIdentityAccounts)
          .where(eq(douyinLinkIdentityAccounts.identityId, identityId))
      : [{ userId: id }]
    const ids = [...new Set([id, ...members.map((row) => row.userId)])]
    const briefs: IdentityAccountRow[] = []
    if (ids.length > 0) {
      // 宿主的 Orm 泛型是 `any`（见 host.d.ts），`execute` 的行类型拿不到 → 这里显式收一下
      const result = await db.execute(accountBriefsQuery(sql`u.user_id in (${idInList(ids)})`))
      for (const row of (result.rows ?? []) as Array<RawRow<IdentityAccountRow>>) briefs.push(row)
    }
    const primary = identity?.primaryUserId && ids.includes(identity.primaryUserId) ? identity.primaryUserId : ids[0]
    briefs.sort((a, b) => {
      if (a.userId === primary) return -1
      if (b.userId === primary) return 1
      return b.lastSeen - a.lastSeen
    })
    return {
      identityId,
      name: identity?.name ?? '',
      note: identity?.note ?? '',
      primaryUserId: primary ?? '',
      accounts: briefs.map((row) => ({ ...row, identityId }))
    }
  })
}

/**
 * 搜索可关联的账号：**跨全部房间**按昵称 / 抖音号 / 用户 id 找（粘贴 id 也走这里，命中就是它自己）。
 *
 * 结果里带上 `identityId`：界面据此显示「已绑到另一个画像」（绑过去会合并两个画像）。
 */
export async function searchAccounts(keyword: string, limit = 20): Promise<IdentityAccountRow[]> {
  await schemaReady
  const needle = String(keyword ?? '').trim()
  const pattern = `%${needle}%`
  return withOrm('douyin-link.searchAccounts', async (db) => {
    const where = needle
      ? sql`(u.user_id like ${pattern} or u.nickname ilike ${pattern} or u.display_id ilike ${pattern})`
      : sql`true`
    const result = await db.execute(sql`
      select briefs.*, coalesce(a.identity_id, 0)::int as "identityId"
      from (${accountBriefsQuery(where)}) briefs
      left join douyin_link_identity_accounts a on a.user_id = briefs."userId"
      order by briefs."lastSeen" desc
      limit ${Math.min(Math.max(1, Math.round(limit)), 50)}
    `)
    return ((result.rows ?? []) as Array<RawRow<IdentityAccountRow> & { identityId?: number }>).map((row) => ({
      ...row,
      identityId: Number(row.identityId ?? 0)
    }))
  })
}

/**
 * 把 `targetUserId` 绑到 `sourceUserId` 所在的画像。
 *
 * 四种情形一次说清：
 * - 两边都没绑 → 新建一个画像，主账号 = source；
 * - source 有、target 没有 → target 加进来；
 * - target 有、source 没有 → source 加进 target 那个画像；
 * - 两边各有各的画像 → **合并**：账号全迁到 source 那个画像，空掉的那个删掉
 *   （名字/主账号空的一边让位给有的一边）。
 *
 * 返回画像 id（0 = 入参不合法，例如同一个 id）。
 */
export async function bindAccount(sourceUserId: string, targetUserId: string): Promise<number> {
  const source = String(sourceUserId ?? '').trim()
  const target = String(targetUserId ?? '').trim()
  if (!/^\d{4,}$/.test(source) || !/^\d{4,}$/.test(target) || source === target) return 0
  await schemaReady
  return withOrm('douyin-link.bindAccount', async (db) => {
    const now = Date.now()
    const ownerOf = async (userId: string): Promise<number> => {
      const rows = await db
        .select({ identityId: douyinLinkIdentityAccounts.identityId })
        .from(douyinLinkIdentityAccounts)
        .where(eq(douyinLinkIdentityAccounts.userId, userId))
        .limit(1)
      return rows[0]?.identityId ?? 0
    }
    const sourceIdentity = await ownerOf(source)
    const targetIdentity = await ownerOf(target)

    let identityId = sourceIdentity
    if (sourceIdentity && targetIdentity && sourceIdentity !== targetIdentity) {
      const pair = await db
        .select()
        .from(douyinLinkIdentities)
        .where(inArray(douyinLinkIdentities.id, [sourceIdentity, targetIdentity]))
      const keep = pair.find((row) => row.id === sourceIdentity)
      const drop = pair.find((row) => row.id === targetIdentity)
      await db
        .update(douyinLinkIdentityAccounts)
        .set({ identityId: sourceIdentity })
        .where(eq(douyinLinkIdentityAccounts.identityId, targetIdentity))
      await db.delete(douyinLinkIdentities).where(eq(douyinLinkIdentities.id, targetIdentity))
      logger.info(
        `[douyin-link] 画像合并：${targetIdentity} → ${sourceIdentity}（账号全部迁入，空画像已删）`
      )
      if (keep && drop) {
        await db
          .update(douyinLinkIdentities)
          .set({
            name: keep.name || drop.name,
            note: keep.note || drop.note,
            primaryUserId: keep.primaryUserId || drop.primaryUserId,
            updatedAt: now
          })
          .where(eq(douyinLinkIdentities.id, sourceIdentity))
      }
    }

    if (!identityId) identityId = targetIdentity
    if (!identityId) {
      const created = await db
        .insert(douyinLinkIdentities)
        .values({ name: '', note: '', primaryUserId: source, createdAt: now, updatedAt: now })
        .returning({ id: douyinLinkIdentities.id })
      identityId = created[0]?.id ?? 0
    }
    if (!identityId) return 0

    await db
      .insert(douyinLinkIdentityAccounts)
      .values([
        { userId: source, identityId, addedAt: now },
        { userId: target, identityId, addedAt: now }
      ])
      // 已经属于别的画像（上面没走到合并的边角情形）也一并改归属：**一个 id 只能有一个画像**
      .onConflictDoUpdate({
        target: douyinLinkIdentityAccounts.userId,
        set: { identityId: sql`excluded.identity_id` }
      })

    const identity = (
      await db.select().from(douyinLinkIdentities).where(eq(douyinLinkIdentities.id, identityId)).limit(1)
    )[0]
    if (identity) {
      await db
        .update(douyinLinkIdentities)
        .set({ primaryUserId: identity.primaryUserId || source, updatedAt: now })
        .where(eq(douyinLinkIdentities.id, identityId))
    }
    logger.info(`[douyin-link] 画像绑定：${source} + ${target} → 画像 ${identityId}`)
    return identityId
  })
}

/**
 * 解绑一个账号。**只剩一个账号时把这个画像一并解散**（单账号的「画像」等于没绑，
 * 留着只会在界面上多一层壳）；主账号被解绑时把主账号让给剩下的第一个。
 * 返回解绑后 source 还属于哪个画像（0 = 已经解散 / 本来就没绑）。
 */
export async function unbindAccount(userId: string): Promise<number> {
  const id = String(userId ?? '').trim()
  if (!id) return 0
  await schemaReady
  return withOrm('douyin-link.unbindAccount', async (db) => {
    const owner = await db
      .select({ identityId: douyinLinkIdentityAccounts.identityId })
      .from(douyinLinkIdentityAccounts)
      .where(eq(douyinLinkIdentityAccounts.userId, id))
      .limit(1)
    const identityId = owner[0]?.identityId ?? 0
    if (!identityId) return 0

    await db.delete(douyinLinkIdentityAccounts).where(eq(douyinLinkIdentityAccounts.userId, id))
    const rest = await db
      .select({ userId: douyinLinkIdentityAccounts.userId })
      .from(douyinLinkIdentityAccounts)
      .where(eq(douyinLinkIdentityAccounts.identityId, identityId))
      .orderBy(asc(douyinLinkIdentityAccounts.addedAt))

    if (rest.length <= 1) {
      for (const row of rest) {
        await db.delete(douyinLinkIdentityAccounts).where(eq(douyinLinkIdentityAccounts.userId, row.userId))
      }
      await db.delete(douyinLinkIdentities).where(eq(douyinLinkIdentities.id, identityId))
      logger.info(`[douyin-link] 画像解散：${identityId}（只剩一个账号，不再算关联）`)
      return 0
    }

    const identity = (
      await db.select().from(douyinLinkIdentities).where(eq(douyinLinkIdentities.id, identityId)).limit(1)
    )[0]
    if (identity && identity.primaryUserId === id) {
      await db
        .update(douyinLinkIdentities)
        .set({ primaryUserId: rest[0].userId, updatedAt: Date.now() })
        .where(eq(douyinLinkIdentities.id, identityId))
    }
    logger.info(`[douyin-link] 画像解绑：${id} 已从画像 ${identityId} 移出（还剩 ${rest.length} 个账号）`)
    return identityId
  })
}

/** 改画像名（空串 = 退回主账号昵称；最多 40 字，超了截断而不是报错） */
export async function renameIdentity(identityId: number, name: string): Promise<void> {
  const id = Math.trunc(Number(identityId) || 0)
  if (!id) return
  const trimmed = String(name ?? '').trim().slice(0, 40)
  await schemaReady
  await withOrm('douyin-link.renameIdentity', async (db) => {
    await db
      .update(douyinLinkIdentities)
      .set({ name: trimmed, updatedAt: Date.now() })
      .where(eq(douyinLinkIdentities.id, id))
  })
}

/** 导出用的画像分组（不带本地自增 id：导入时按账号重建，反复导入幂等） */
export async function exportIdentityGroups(): Promise<IdentityGroup[]> {
  await schemaReady
  return withOrm('douyin-link.exportIdentities', async (db) => {
    const identities = await db.select().from(douyinLinkIdentities)
    const accounts = await db.select().from(douyinLinkIdentityAccounts)
    const out: IdentityGroup[] = []
    for (const identity of identities) {
      const ids = accounts.filter((row) => row.identityId === identity.id).map((row) => row.userId)
      if (ids.length < 2) continue
      out.push({
        name: identity.name,
        note: identity.note,
        primaryUserId: identity.primaryUserId,
        accounts: ids
      })
    }
    return out
  })
}

/** 导入画像分组：逐个账号绑到一起（`bindAccount` 本身幂等，重复导入不会造出重复画像） */
export async function importIdentityGroups(groups: IdentityGroup[]): Promise<number> {
  let bound = 0
  for (const group of groups) {
    const accounts = [...new Set((group?.accounts ?? []).map((id) => String(id ?? '').trim()))].filter((id) =>
      /^\d{4,}$/.test(id)
    )
    if (accounts.length < 2) continue
    const head = accounts[0]
    let identityId = 0
    for (const account of accounts.slice(1)) {
      identityId = (await bindAccount(head, account)) || identityId
      bound += 1
    }
    if (identityId) {
      if (group.name) await renameIdentity(identityId, group.name)
      const primary = accounts.includes(String(group.primaryUserId ?? '')) ? String(group.primaryUserId) : head
      await schemaReady
      await withOrm('douyin-link.importIdentityPrimary', async (db) => {
        await db
          .update(douyinLinkIdentities)
          .set({ primaryUserId: primary, note: String(group.note ?? '').slice(0, 200), updatedAt: Date.now() })
          .where(eq(douyinLinkIdentities.id, identityId))
      })
    }
  }
  return bound
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

/** 某个人送过的礼物（按礼物名聚合；用户榜悬停看明细用）。
 *  `userIds` 是**画像的全部账号**（没绑定时就是那一个 id）。 */
export async function userGiftBreakdown(
  webRid: string,
  userIds: string[],
  limit = 12
): Promise<GiftBreakdownRow[]> {
  const ids = [...new Set(userIds.filter((id) => id.length > 0))]
  if (!webRid || ids.length === 0) return []
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
          inArray(douyinLinkMessages.userId, ids),
          eq(douyinLinkMessages.kind, 'gift')
        )
      )
      .groupBy(douyinLinkMessages.content)
      .orderBy(desc(sql`coalesce(sum(${douyinLinkMessages.diamonds}), 0)`), desc(sql`count(*)`))
      .limit(Math.min(Math.max(1, limit), 50))
    return rows.map((row) => ({ name: row.name, count: row.count, diamonds: row.diamonds, users: 1 }))
  })
}

/** 「分析用户」的空白输入（没有有效的房间/用户时，让上层直接得到一份「无数据」画像） */
function emptyAnalysisData(): UserAnalysisData {
  return {
    chat: 0,
    enter: 0,
    likes: 0,
    follows: 0,
    gift: 0,
    diamonds: 0,
    firstSeen: 0,
    lastSeen: 0,
    hours: new Array(24).fill(0),
    activeDays: 0,
    giftKinds: 0,
    topGiftName: '',
    topGiftCount: 0,
    topGiftDiamonds: 0,
    recipients: 0,
    honorLevel: 0,
    fansClubLevel: 0,
    chatTexts: [],
    giftHours: new Array(24).fill(0),
    giftDays: 0,
    giftMax: 0,
    giftFirstAt: 0,
    giftLastAt: 0,
    outEdges: [],
    inEdges: [],
    sessions: 0,
    sessionSpans: [],
    firstFollowAt: 0
  }
}

/**
 * 「分析用户」的聚合数据（喂给 `main/analysis/portrait.ts` 做确定性打分，**不经过大模型**）。
 *
 * 口径（用户 2026-10-10：「只需要跨房间进行构建画像，即这个人在这个平台的画像」）：
 * - **跨全部直播间**：只按 `user_id` 筛，**不带 webRid**——画像回答的是「这个人在这个平台什么样」，
 *   而不是「他在某一个房间什么样」。所以所有查询都不再钉房间；
 * - **用户档案表是权威**，但档案是**按房间**存的（同一个人每个房间一行），跨房间要把它**并起来**：
 *   互动数各自累加、首末时间取最早/最晚、等级取最高（等级本身是平台级的，各房一般一致）；
 * - 档案缺失时（例如只剩消息流水的历史数据）退回**消息流水**现场聚合：
 *   非礼物按 `count(*)`、礼物按 `sum(count)`、抖币按 `sum(diamonds)`（对齐 recorder 的口径）；
 * - 分天/分时按**本地时区**，偏移拼字面量（同 `dayRecords`：绑定参数会让 GROUP BY 认不出同一表达式）。
 *
 * **多账号（0.15.11）**：入参是**画像的全部账号**（`resolveAccountIds()` 的结果，没绑定时就是一个 id）。
 * 同一个人自己的两个号之间的收送礼物是**自环**，不算「送礼对象」，所以关系边、收礼人数都排掉集合内的 id。
 */
export async function userAnalysisData(userIds: string[]): Promise<UserAnalysisData> {
  const ids = [...new Set((userIds ?? []).filter((id) => id.length > 0))]
  if (ids.length === 0) return emptyAnalysisData()
  await schemaReady
  const offsetMs = -new Date().getTimezoneOffset() * 60000
  return withOrm('douyin-link.userAnalysisData', async (db) => {
    const offset = sql.raw(String(Math.trunc(offsetMs)))
    /** 跨全部直播间的范围条件：只要「这个人（任一账号）发的」 */
    const scope = inArray(douyinLinkMessages.userId, ids)
    /** 自环：集合内部账号之间的收送不算「关系」 */
    const selfLoopOut = ids.length > 1 ? notInArray(douyinLinkMessages.toUserId, ids) : undefined
    const selfLoopIn = ids.length > 1 ? notInArray(douyinLinkMessages.userId, ids) : undefined

    // 档案表按房间存，这里把同一个人的所有房间档案并成一份
    const profileRows = await db
      .select()
      .from(douyinLinkUsers)
      .where(inArray(douyinLinkUsers.userId, ids))
    /** 两个都是正数才取小，否则取那个非零的（0 = 没记录，不该参与比较） */
    const minPositive = (a: number, b: number): number => (a > 0 && b > 0 ? Math.min(a, b) : Math.max(a, b))
    /** 跨房间合并后的档案口径（只保留画像要用到的字段） */
    interface ProfileTotals {
      chat: number
      enter: number
      likes: number
      follows: number
      gift: number
      diamonds: number
      firstSeen: number
      lastSeen: number
      honorLevel: number
      fansClubLevel: number
    }
    const profile =
      profileRows.length === 0
        ? undefined
        : profileRows.reduce<ProfileTotals>(
            (acc, row) => ({
              chat: acc.chat + row.chat,
              enter: acc.enter + row.enter,
              likes: acc.likes + row.likes,
              follows: acc.follows + row.follows,
              gift: acc.gift + row.gift,
              diamonds: acc.diamonds + row.diamonds,
              firstSeen: minPositive(acc.firstSeen, row.firstSeen),
              lastSeen: Math.max(acc.lastSeen, row.lastSeen),
              honorLevel: Math.max(acc.honorLevel, row.honorLevel),
              fansClubLevel: Math.max(acc.fansClubLevel, row.fansClubLevel)
            }),
            {
              chat: 0,
              enter: 0,
              likes: 0,
              follows: 0,
              gift: 0,
              diamonds: 0,
              firstSeen: 0,
              lastSeen: 0,
              honorLevel: 0,
              fansClubLevel: 0
            }
          )

    // 各类型的条数（礼物另给 sum(count) 作为件数）
    const kindRows = await db
      .select({
        kind: douyinLinkMessages.kind,
        hits: sql<number>`count(*)::int`,
        items: sql<number>`coalesce(sum(${douyinLinkMessages.count}), 0)::int`,
        diamonds: sql<number>`coalesce(sum(${douyinLinkMessages.diamonds}), 0)::int`
      })
      .from(douyinLinkMessages)
      .where(scope)
      .groupBy(douyinLinkMessages.kind)

    const timeRows = await db
      .select({
        firstAt: sql<number>`coalesce(min(${douyinLinkMessages.atMs}), 0)::double precision`,
        lastAt: sql<number>`coalesce(max(${douyinLinkMessages.atMs}), 0)::double precision`
      })
      .from(douyinLinkMessages)
      .where(scope)

    const hourBucket = sql`floor((${douyinLinkMessages.atMs} + ${offset}) / 3600000)::bigint % 24`
    const hourRows = await db
      .select({ hour: sql<number>`(${hourBucket})::int`, hits: sql<number>`count(*)::int` })
      .from(douyinLinkMessages)
      .where(scope)
      .groupBy(hourBucket)

    const dayBucket = sql`floor((${douyinLinkMessages.atMs} + ${offset}) / 86400000)`
    const dayRows = await db
      .select({ days: sql<number>`count(distinct (${dayBucket})::int)::int` })
      .from(douyinLinkMessages)
      .where(scope)

    // 礼物汇总：时间跨度 / 送礼天数 / 单笔最大（送礼习惯用）
    const giftAggRows = await db
      .select({
        firstAt: sql<number>`coalesce(min(${douyinLinkMessages.atMs}), 0)::double precision`,
        lastAt: sql<number>`coalesce(max(${douyinLinkMessages.atMs}), 0)::double precision`,
        maxDiamonds: sql<number>`coalesce(max(${douyinLinkMessages.diamonds}), 0)::int`,
        days: sql<number>`count(distinct (${dayBucket})::int)::int`
      })
      .from(douyinLinkMessages)
      .where(and(scope, eq(douyinLinkMessages.kind, 'gift')))

    // 礼物时段分布（本地时区，24 桶）
    const giftHourRows = await db
      .select({ hour: sql<number>`(${hourBucket})::int`, hits: sql<number>`count(*)::int` })
      .from(douyinLinkMessages)
      .where(and(scope, eq(douyinLinkMessages.kind, 'gift')))
      .groupBy(hourBucket)

    // 送礼对象（本人 → 对方）：昵称优先消息里记的，再退回用户表
    const outEdgeRows = await db
      .select({
        userId: douyinLinkMessages.toUserId,
        name: sql<string>`coalesce(nullif(max(${douyinLinkMessages.toUserName}), ''), max(${douyinLinkUsers.nickname}), '')`,
        diamonds: sql<number>`coalesce(sum(${douyinLinkMessages.diamonds}), 0)::int`,
        items: sql<number>`coalesce(sum(${douyinLinkMessages.count}), 0)::int`,
        hits: sql<number>`count(*)::int`,
        lastAt: sql<number>`coalesce(max(${douyinLinkMessages.atMs}), 0)::double precision`
      })
      .from(douyinLinkMessages)
      .leftJoin(
        douyinLinkUsers,
        and(
          eq(douyinLinkUsers.webRid, douyinLinkMessages.webRid),
          eq(douyinLinkUsers.userId, douyinLinkMessages.toUserId)
        )
      )
      .where(
        and(
          scope,
          eq(douyinLinkMessages.kind, 'gift'),
          ne(douyinLinkMessages.toUserId, ''),
          selfLoopOut
        )
      )
      .groupBy(douyinLinkMessages.toUserId)
      .orderBy(desc(sql`coalesce(sum(${douyinLinkMessages.diamonds}), 0)`), desc(sql`count(*)`))
      .limit(40)

    // 送礼给本人的人（对方 → 本人）：注意这里按「收礼人 = 本人」筛，
    // 用的是跨房间条件（不带 webRid，也就不能复用上面那个 scope——它钉的是发送者）
    const inEdgeRows = await db
      .select({
        userId: douyinLinkMessages.userId,
        name: sql<string>`coalesce(nullif(max(${douyinLinkMessages.userName}), ''), max(${douyinLinkUsers.nickname}), '')`,
        diamonds: sql<number>`coalesce(sum(${douyinLinkMessages.diamonds}), 0)::int`,
        items: sql<number>`coalesce(sum(${douyinLinkMessages.count}), 0)::int`,
        hits: sql<number>`count(*)::int`,
        lastAt: sql<number>`coalesce(max(${douyinLinkMessages.atMs}), 0)::double precision`
      })
      .from(douyinLinkMessages)
      .leftJoin(
        douyinLinkUsers,
        and(
          eq(douyinLinkUsers.webRid, douyinLinkMessages.webRid),
          eq(douyinLinkUsers.userId, douyinLinkMessages.userId)
        )
      )
      .where(
        and(
          inArray(douyinLinkMessages.toUserId, ids),
          eq(douyinLinkMessages.kind, 'gift'),
          ne(douyinLinkMessages.userId, ''),
          selfLoopIn
        )
      )
      .groupBy(douyinLinkMessages.userId)
      .orderBy(desc(sql`coalesce(sum(${douyinLinkMessages.diamonds}), 0)`), desc(sql`count(*)`))
      .limit(40)

    // 「互动结构」用：到访场次与每场停留（`session_id = 0` 表示没有会话信息，不计）
    const sessionRows = await db
      .select({
        sessionId: douyinLinkMessages.sessionId,
        span: sql<number>`(coalesce(max(${douyinLinkMessages.atMs}), 0) - coalesce(min(${douyinLinkMessages.atMs}), 0))::double precision`
      })
      .from(douyinLinkMessages)
      .where(and(scope, ne(douyinLinkMessages.sessionId, 0)))
      .groupBy(douyinLinkMessages.sessionId)

    // 首次关注的时间（0 = 从没关注过）：用来看「多久转化成关注」
    const followRows = await db
      .select({ firstAt: sql<number>`coalesce(min(${douyinLinkMessages.atMs}), 0)::double precision` })
      .from(douyinLinkMessages)
      .where(and(scope, eq(douyinLinkMessages.kind, 'social')))

    const giftRows = await db
      .select({
        name: douyinLinkMessages.content,
        items: sql<number>`coalesce(sum(${douyinLinkMessages.count}), 0)::int`,
        diamonds: sql<number>`coalesce(sum(${douyinLinkMessages.diamonds}), 0)::int`
      })
      .from(douyinLinkMessages)
      .where(and(scope, eq(douyinLinkMessages.kind, 'gift')))
      .groupBy(douyinLinkMessages.content)
      .orderBy(desc(sql`coalesce(sum(${douyinLinkMessages.diamonds}), 0)`), desc(sql`count(*)`))

    const recipientRows = await db
      .select({ value: sql<number>`count(distinct nullif(${douyinLinkMessages.toUserId}, ''))::int` })
      .from(douyinLinkMessages)
      .where(and(scope, eq(douyinLinkMessages.kind, 'gift'), ne(douyinLinkMessages.toUserId, ''), selfLoopOut))

    const textRows = await db
      .select({ content: douyinLinkMessages.content })
      .from(douyinLinkMessages)
      .where(and(scope, eq(douyinLinkMessages.kind, 'chat')))
      .orderBy(desc(douyinLinkMessages.atMs))
      .limit(2000)

    const byKind = new Map(kindRows.map((row) => [row.kind, row]))
    const countOf = (kind: string): number => byKind.get(kind)?.hits ?? 0

    const hours = new Array(24).fill(0)
    for (const row of hourRows) {
      const hour = Math.trunc(row.hour)
      if (hour >= 0 && hour < 24) hours[hour] = row.hits
    }

    const topGift = giftRows[0]
    const firstAt = timeRows[0]?.firstAt ?? 0
    const lastAt = timeRows[0]?.lastAt ?? 0

    const giftHours = new Array(24).fill(0)
    for (const row of giftHourRows) {
      const hour = Math.trunc(row.hour)
      if (hour >= 0 && hour < 24) giftHours[hour] = row.hits
    }
    const giftAgg = giftAggRows[0]

    return {
      chat: profile ? profile.chat : countOf('chat'),
      enter: profile ? profile.enter : countOf('member'),
      likes: profile ? profile.likes : countOf('like'),
      follows: profile ? profile.follows : countOf('social'),
      gift: profile ? profile.gift : countOf('gift'),
      diamonds: profile ? profile.diamonds : (byKind.get('gift')?.diamonds ?? 0),
      firstSeen: profile && profile.firstSeen > 0 ? profile.firstSeen : firstAt,
      lastSeen: profile && profile.lastSeen > 0 ? profile.lastSeen : lastAt,
      hours,
      activeDays: dayRows[0]?.days ?? 0,
      giftKinds: giftRows.length,
      topGiftName: topGift?.name ?? '',
      topGiftCount: topGift?.items ?? 0,
      topGiftDiamonds: topGift?.diamonds ?? 0,
      recipients: recipientRows[0]?.value ?? 0,
      honorLevel: profile?.honorLevel ?? 0,
      fansClubLevel: profile?.fansClubLevel ?? 0,
      chatTexts: textRows.map((row) => row.content).filter((text) => text.length > 0),
      giftHours,
      giftDays: giftAgg?.days ?? 0,
      giftMax: giftAgg?.maxDiamonds ?? 0,
      giftFirstAt: giftAgg?.firstAt ?? 0,
      giftLastAt: giftAgg?.lastAt ?? 0,
      outEdges: outEdgeRows.map((row) => ({
        userId: row.userId,
        name: row.name ?? '',
        diamonds: row.diamonds,
        items: row.items,
        hits: row.hits,
        lastAt: row.lastAt
      })),
      inEdges: inEdgeRows.map((row) => ({
        userId: row.userId,
        name: row.name ?? '',
        diamonds: row.diamonds,
        items: row.items,
        hits: row.hits,
        lastAt: row.lastAt
      })),
      sessions: sessionRows.length,
      sessionSpans: sessionRows.map((row) => Math.max(0, row.span)),
      firstFollowAt: followRows[0]?.firstAt ?? 0
    }
  })
}

/**
 * AI 画像的**证据原料**（跨全部直播间、按画像的全部账号查）。
 *
 * 与 `userAnalysisData` 的分工：那一份喂**确定性算法**（只要数字），这一份喂**大模型**
 * （要的是「有上下文的事实」）——所以它多给三样：
 * 1. **按房间摊开**：他出现在哪几个直播间、每个房间各说了多少 / 送了多少、什么时候来什么时候走
 *    （模型据此判断「他是这个主播的老观众，还是到处串场的人」）；
 * 2. **带时间戳的弹幕样本**：模型要引用原话、要看出「他说话的语气」，光有词频统计不够；
 * 3. **带时间戳的礼物流水（送 / 收两个方向）**：礼物名 + 件数 + 抖币 + 对方是谁——
 *    「他给谁花过钱、收过谁的钱」是关系判断的硬证据。
 *
 * 口径与画像一致：`userIds` 是这个人的全部账号，自环（自己两个号之间）不算收礼。
 */
export interface UserPortraitRoomRow {
  webRid: string
  title: string
  chat: number
  enter: number
  likes: number
  follows: number
  gift: number
  diamonds: number
  receivedDiamonds: number
  firstSeen: number
  lastSeen: number
}

/** 一条带上下文的流水（弹幕 / 送礼 / 收礼共用；`counterpart` 是对方的名字——弹幕为空） */
export interface UserPortraitMessageRow {
  atMs: number
  webRid: string
  content: string
  count: number
  diamonds: number
  counterpart: string
}

export interface UserPortraitExtras {
  /** 按房间摊开（出现的房间倒序：最近的在前） */
  rooms: UserPortraitRoomRow[]
  /** 最近的弹幕（新 → 旧） */
  recentChat: UserPortraitMessageRow[]
  /** 最近的送礼（新 → 旧） */
  sentGifts: UserPortraitMessageRow[]
  /** 最近的收礼（新 → 旧） */
  receivedGifts: UserPortraitMessageRow[]
  /** 跨房间合计：送礼 / 收礼抖币 */
  sentDiamonds: number
  receivedDiamonds: number
  /** 首次 / 最近出现（ms） */
  firstSeen: number
  lastSeen: number
}

/** 证据原料的条数上限（提示词大小直接等于 token 成本，这里就是成本的闸门） */
export const PORTRAIT_SAMPLE_LIMITS = {
  chat: 80,
  sentGifts: 40,
  receivedGifts: 30,
  rooms: 12
} as const

export async function userPortraitExtras(userIds: string[]): Promise<UserPortraitExtras> {
  const ids = [...new Set((userIds ?? []).filter((id) => id.length > 0))]
  const empty: UserPortraitExtras = {
    rooms: [],
    recentChat: [],
    sentGifts: [],
    receivedGifts: [],
    sentDiamonds: 0,
    receivedDiamonds: 0,
    firstSeen: 0,
    lastSeen: 0
  }
  if (ids.length === 0) return empty
  await schemaReady
  return withOrm('douyin-link.userPortraitExtras', async (db) => {
    const minPositive = (a: number, b: number): number => (a > 0 && b > 0 ? Math.min(a, b) : Math.max(a, b))

    // 1) 按房间：档案表（权威：本房间的互动计数与送礼抖币）
    const profileRows = await db
      .select()
      .from(douyinLinkUsers)
      .where(inArray(douyinLinkUsers.userId, ids))

    // 2) 按房间：收礼（档案表里没有这一列，只能从消息流水现算）
    const receivedRows = await db
      .select({
        webRid: douyinLinkMessages.webRid,
        diamonds: sql<number>`coalesce(sum(${douyinLinkMessages.diamonds}), 0)::int`,
        hits: sql<number>`count(*)::int`,
        firstAt: sql<number>`coalesce(min(${douyinLinkMessages.atMs}), 0)::double precision`,
        lastAt: sql<number>`coalesce(max(${douyinLinkMessages.atMs}), 0)::double precision`
      })
      .from(douyinLinkMessages)
      .where(and(inArray(douyinLinkMessages.toUserId, ids), eq(douyinLinkMessages.kind, 'gift')))
      .groupBy(douyinLinkMessages.webRid)

    // 3) 房间名（模型要知道「哪个直播间」，只有房间号它认不出来）
    const roomRows = await db
      .select({
        webRid: douyinLinkRooms.webRid,
        title: douyinLinkRooms.title,
        anchor: douyinLinkRooms.anchor
      })
      .from(douyinLinkRooms)
    const roomTitles = new Map(roomRows.map((row) => [row.webRid, row.title || row.anchor || '']))

    const byRoom = new Map<string, UserPortraitRoomRow>()
    const touch = (webRid: string): UserPortraitRoomRow => {
      const hit = byRoom.get(webRid)
      if (hit) return hit
      const created: UserPortraitRoomRow = {
        webRid,
        title: roomTitles.get(webRid) ?? '',
        chat: 0,
        enter: 0,
        likes: 0,
        follows: 0,
        gift: 0,
        diamonds: 0,
        receivedDiamonds: 0,
        firstSeen: 0,
        lastSeen: 0
      }
      byRoom.set(webRid, created)
      return created
    }

    for (const row of profileRows) {
      const target = touch(row.webRid)
      target.chat += row.chat
      target.enter += row.enter
      target.likes += row.likes
      target.follows += row.follows
      target.gift += row.gift
      target.diamonds += row.diamonds
      target.firstSeen = minPositive(target.firstSeen, row.firstSeen)
      target.lastSeen = Math.max(target.lastSeen, row.lastSeen)
    }
    for (const row of receivedRows) {
      const target = touch(row.webRid)
      target.receivedDiamonds += row.diamonds
      // 档案缺失（只剩消息流水的历史数据）时用礼物流水兜底时间轴，和 userAnalysisData 同口径
      if (target.lastSeen === 0) target.lastSeen = row.lastAt
      if (target.firstSeen === 0) target.firstSeen = row.firstAt
    }

    const rooms = [...byRoom.values()]
      .filter((room) => room.chat + room.enter + room.likes + room.follows + room.gift + room.receivedDiamonds > 0)
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, PORTRAIT_SAMPLE_LIMITS.rooms)

    // 4) 最近的弹幕（带时间：模型要看「他什么时候说话、说什么」）
    const chatRows = await db
      .select({
        atMs: douyinLinkMessages.atMs,
        webRid: douyinLinkMessages.webRid,
        content: douyinLinkMessages.content
      })
      .from(douyinLinkMessages)
      .where(and(inArray(douyinLinkMessages.userId, ids), eq(douyinLinkMessages.kind, 'chat')))
      .orderBy(desc(douyinLinkMessages.atMs))
      .limit(PORTRAIT_SAMPLE_LIMITS.chat)

    // 5) 最近送出的礼物（谁、什么、多少、给了谁）
    const sentRows = await db
      .select({
        atMs: douyinLinkMessages.atMs,
        webRid: douyinLinkMessages.webRid,
        content: douyinLinkMessages.content,
        count: douyinLinkMessages.count,
        diamonds: douyinLinkMessages.diamonds,
        name: douyinLinkMessages.toUserName
      })
      .from(douyinLinkMessages)
      .where(and(inArray(douyinLinkMessages.userId, ids), eq(douyinLinkMessages.kind, 'gift')))
      .orderBy(desc(douyinLinkMessages.atMs))
      .limit(PORTRAIT_SAMPLE_LIMITS.sentGifts)

    // 6) 最近收到的礼物（谁送的）
    const receivedGiftRows = await db
      .select({
        atMs: douyinLinkMessages.atMs,
        webRid: douyinLinkMessages.webRid,
        content: douyinLinkMessages.content,
        count: douyinLinkMessages.count,
        diamonds: douyinLinkMessages.diamonds,
        name: douyinLinkMessages.userName
      })
      .from(douyinLinkMessages)
      .where(and(inArray(douyinLinkMessages.toUserId, ids), eq(douyinLinkMessages.kind, 'gift')))
      .orderBy(desc(douyinLinkMessages.atMs))
      .limit(PORTRAIT_SAMPLE_LIMITS.receivedGifts)

    let firstSeen = 0
    let lastSeen = 0
    let sentDiamonds = 0
    let receivedDiamonds = 0
    for (const room of rooms) {
      if (room.firstSeen > 0) firstSeen = firstSeen > 0 ? Math.min(firstSeen, room.firstSeen) : room.firstSeen
      lastSeen = Math.max(lastSeen, room.lastSeen)
      sentDiamonds += room.diamonds
      receivedDiamonds += room.receivedDiamonds
    }

    return {
      rooms,
      recentChat: chatRows.map((row) => ({
        atMs: row.atMs,
        webRid: row.webRid,
        content: row.content,
        count: 0,
        diamonds: 0,
        counterpart: ''
      })),
      sentGifts: sentRows.map((row) => ({
        atMs: row.atMs,
        webRid: row.webRid,
        content: row.content,
        count: row.count,
        diamonds: row.diamonds,
        counterpart: row.name ?? ''
      })),
      receivedGifts: receivedGiftRows.map((row) => ({
        atMs: row.atMs,
        webRid: row.webRid,
        content: row.content,
        count: row.count,
        diamonds: row.diamonds,
        counterpart: row.name ?? ''
      })),
      sentDiamonds,
      receivedDiamonds,
      firstSeen,
      lastSeen
    }
  })
}

/** 观察窗最多取几个（最近优先） */
const CONTEXT_WINDOW_LIMIT = 12
/** 每个房间最多取几场（最近优先） */
const CONTEXT_SESSIONS_PER_ROOM = 3
/** 窗内原始弹幕的**安全上限**：正常一场直播远达不到，只是防止异常数据把内存打爆 */
const CONTEXT_ROW_SAFETY_CAP = 40000
/** 拿不到会话时，兜底窗口的宽度（ms） */
const CONTEXT_FALLBACK_SPAN = 2 * 3600_000

/**
 * 「时段上下文」的取数：定位**观察窗**（观众 = 他自己的会话窗口；主播 / 沉默者 = 房间的直播场次），
 * 再把窗内**整个房间**的弹幕拉出来，交给 `main/analysis/context.ts` 做聚合与抽样。
 *
 * 与 `userPortraitExtras` 的分工：那一份给「本人发的」原始流水（谁说了什么、谁给谁送了礼），
 * 这一份给「他所处的**环境**」——房间里其他人在聊什么。两者都进 AI 材料，但角色不同：
 * 前者是「他的话」，后者是「他说话时房间在说什么」，也是**主播 / 沉默观众唯一有的东西**。
 *
 * 输入**不设条数上限**（只给一个防爆的保护值），压缩交给纯逻辑那一层去做。
 */
export async function userRoomContext(input: {
  userIds: string[]
  /** 观众走「他自己的会话窗口」，主播 / 沉默者走「房间的直播场次」 */
  role: 'viewer' | 'host'
  maxWindows?: number
  /** 现在（正在直播的那一场没有结束时间，拿它兜底） */
  now?: number
}): Promise<{ windows: ContextWindow[]; rows: ContextDanmakuRow[] }> {
  const ids = [...new Set((input.userIds ?? []).filter((id) => id.length > 0))]
  const empty = { windows: [], rows: [] }
  if (ids.length === 0) return empty
  const limit = Math.min(CONTEXT_WINDOW_LIMIT, Math.max(1, Math.round(input.maxWindows ?? CONTEXT_WINDOW_LIMIT)))
  const now = input.now && input.now > 0 ? input.now : Date.now()
  await schemaReady
  return withOrm('douyin-link.userRoomContext', async (db) => {
    const roomTitleRows = await db
      .select({ webRid: douyinLinkRooms.webRid, title: douyinLinkRooms.title, anchor: douyinLinkRooms.anchor })
      .from(douyinLinkRooms)
    const titles = new Map(roomTitleRows.map((row) => [row.webRid, row.title || row.anchor || '']))

    /** 观察窗（房间 + 时间范围） */
    const windows: ContextWindow[] = []
    const push = (webRid: string, start: number, end: number): void => {
      if (!webRid || !(end >= start)) return
      windows.push({ webRid, title: titles.get(webRid) ?? '', start, end })
    }

    // 1) 观众的优先路径：他自己的**会话窗口**（session_id 不为 0 的那几场，有明确的起止）
    if (input.role === 'viewer') {
      const rows = await db
        .select({
          webRid: douyinLinkMessages.webRid,
          start: sql<number>`coalesce(min(${douyinLinkMessages.atMs}), 0)::double precision`,
          end: sql<number>`coalesce(max(${douyinLinkMessages.atMs}), 0)::double precision`
        })
        .from(douyinLinkMessages)
        .where(
          and(
            inArray(douyinLinkMessages.userId, ids),
            eq(douyinLinkMessages.kind, 'chat'),
            ne(douyinLinkMessages.sessionId, 0)
          )
        )
        .groupBy(douyinLinkMessages.webRid, douyinLinkMessages.sessionId)
        .orderBy(desc(sql`coalesce(max(${douyinLinkMessages.atMs}), 0)`))
        .limit(limit)
      for (const row of rows) push(row.webRid, row.start, row.end)
    }

    // 2) 兜底（也是主播的唯一路径）：他在哪些房间出现过 → 拿房间**最近的直播场次**当观察窗。
    //    「出现过」的证据：本人档案行（进场/发言都会落一行），或有人给他送过礼。
    if (windows.length === 0) {
      const profileRows = await db
        .select({ webRid: douyinLinkUsers.webRid, lastSeen: douyinLinkUsers.lastSeen })
        .from(douyinLinkUsers)
        .where(inArray(douyinLinkUsers.userId, ids))
        .orderBy(desc(douyinLinkUsers.lastSeen))
      const giftRows = await db
        .select({
          webRid: douyinLinkMessages.webRid,
          lastAt: sql<number>`coalesce(max(${douyinLinkMessages.atMs}), 0)::double precision`
        })
        .from(douyinLinkMessages)
        .where(and(inArray(douyinLinkMessages.toUserId, ids), eq(douyinLinkMessages.kind, 'gift')))
        .groupBy(douyinLinkMessages.webRid)
        .orderBy(desc(sql`coalesce(max(${douyinLinkMessages.atMs}), 0)`))

      const ranked = new Map<string, number>()
      for (const row of profileRows) {
        if (row.webRid) ranked.set(row.webRid, Math.max(ranked.get(row.webRid) ?? 0, row.lastSeen ?? 0))
      }
      for (const row of giftRows) {
        if (row.webRid) ranked.set(row.webRid, Math.max(ranked.get(row.webRid) ?? 0, row.lastAt ?? 0))
      }
      const roomIds = [...ranked.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([webRid]) => webRid)
      if (roomIds.length > 0) {
        const sessionRows = await db
          .select({
            webRid: douyinLinkSessions.webRid,
            startedAt: douyinLinkSessions.startedAt,
            endedAt: douyinLinkSessions.endedAt
          })
          .from(douyinLinkSessions)
          .where(inArray(douyinLinkSessions.webRid, roomIds))
          .orderBy(desc(douyinLinkSessions.startedAt))
        const perRoom = new Map<string, number>()
        for (const row of sessionRows) {
          const used = perRoom.get(row.webRid) ?? 0
          if (used >= CONTEXT_SESSIONS_PER_ROOM) continue
          perRoom.set(row.webRid, used + 1)
          push(row.webRid, row.startedAt, row.endedAt > 0 ? row.endedAt : now)
        }
        // 房间没有会话记录（历史数据 / 从没跑过监控）：用「最近一次出现」往回开一个兜底窗
        for (const webRid of roomIds) {
          if (perRoom.has(webRid)) continue
          const last = ranked.get(webRid) ?? 0
          if (last > 0) push(webRid, Math.max(0, last - CONTEXT_FALLBACK_SPAN), last)
        }
      }
    }

    const picked = windows
      .sort((a, b) => b.end - a.end)
      .slice(0, limit)
      .sort((a, b) => a.start - b.start)
    if (picked.length === 0) return { windows: [], rows: [] }

    // 3) 取窗内**整个房间**的弹幕（含本人；本人由纯逻辑层标 self）
    const scope = or(
      ...picked.map((w) =>
        and(
          eq(douyinLinkMessages.webRid, w.webRid),
          gte(douyinLinkMessages.atMs, w.start),
          lte(douyinLinkMessages.atMs, w.end)
        )
      )
    )
    const rows = await db
      .select({
        atMs: douyinLinkMessages.atMs,
        webRid: douyinLinkMessages.webRid,
        userId: douyinLinkMessages.userId,
        userName: douyinLinkMessages.userName,
        content: douyinLinkMessages.content
      })
      .from(douyinLinkMessages)
      .where(and(eq(douyinLinkMessages.kind, 'chat'), scope))
      .orderBy(asc(douyinLinkMessages.atMs))
      .limit(CONTEXT_ROW_SAFETY_CAP)

    return { windows: picked, rows }
  })
}

/**
 * 「最近一次出现」（跨全部直播间，ms）。
 *
 * 只给 AI 画像的**数据指纹**用（判断「这份画像生成之后数据又涨了吗」），所以刻意做得极轻：
 * 两条聚合（消息流水的最大时间 + 档案行的最大 `last_seen`）取更大者，不碰用户表以外的任何东西。
 * 为什么不复用 `userPortraitExtras`：那个要摊房间、拉样本，是生成时的重查询，不该挂在「打开弹窗」的路径上。
 */
export async function userLastSeenAnyRoom(userIds: string[]): Promise<number> {
  const ids = [...new Set((userIds ?? []).filter((id) => id.length > 0))]
  if (ids.length === 0) return 0
  await schemaReady
  return withOrm('douyin-link.userLastSeenAnyRoom', async (db) => {
    const fromMessages = await db
      .select({ at: sql<number>`coalesce(max(${douyinLinkMessages.atMs}), 0)::double precision` })
      .from(douyinLinkMessages)
      .where(inArray(douyinLinkMessages.userId, ids))
    const fromUsers = await db
      .select({ at: sql<number>`coalesce(max(${douyinLinkUsers.lastSeen}), 0)::double precision` })
      .from(douyinLinkUsers)
      .where(inArray(douyinLinkUsers.userId, ids))
    return Math.max(fromMessages[0]?.at ?? 0, fromUsers[0]?.at ?? 0)
  })
}

/* ------------------------------------------------------------------- AI 画像角色 */

/**
 * 「这个人是不是主播」的**历史信号**（AI 画像的角色判定用，见 `main/portrait.ts` 的 `detectRole`）。
 *
 * 三条来自库里的事实：
 * - `onMic`：我们在麦位表 / 房间主播里**见过他**（粘性列，最硬的证据）；
 * - `receivedGifts` / `receivedDiamonds`：别人送给他的礼物（主播靠这个活着）；
 * - `sentDiamonds`：他送出去的抖币（观众才买账）。
 *
 * 为什么不做成一次 SQL：三样来自两张表、口径也不同（一个是粘性布尔、两个是流水聚合），
 * 分开查更好读；调用点在「打开弹窗 / 开始生成」这种低频路径上。
 */
export interface UserHostSignal {
  /** 见过他在麦上（任一房间） */
  onMic: boolean
  /** 收到礼物的条数 */
  receivedGifts: number
  /** 收到的抖币 */
  receivedDiamonds: number
  /** 送出的抖币 */
  sentDiamonds: number
}

export async function userHostSignal(userIds: string[]): Promise<UserHostSignal> {
  const ids = [...new Set((userIds ?? []).filter((id) => id.length > 0))]
  const empty: UserHostSignal = { onMic: false, receivedGifts: 0, receivedDiamonds: 0, sentDiamonds: 0 }
  if (ids.length === 0) return empty
  await schemaReady
  return withOrm('douyin-link.userHostSignal', async (db) => {
    const micRows = await db
      .select({ onMic: sql<boolean>`bool_or(${douyinLinkUsers.onMic})` })
      .from(douyinLinkUsers)
      .where(inArray(douyinLinkUsers.userId, ids))
    const receivedRows = await db
      .select({
        hits: sql<number>`count(*)::int`,
        diamonds: sql<number>`coalesce(sum(${douyinLinkMessages.diamonds}), 0)::int`
      })
      .from(douyinLinkMessages)
      .where(and(inArray(douyinLinkMessages.toUserId, ids), eq(douyinLinkMessages.kind, 'gift')))
    const sentRows = await db
      .select({ diamonds: sql<number>`coalesce(sum(${douyinLinkMessages.diamonds}), 0)::int` })
      .from(douyinLinkMessages)
      .where(and(inArray(douyinLinkMessages.userId, ids), eq(douyinLinkMessages.kind, 'gift')))
    return {
      onMic: micRows[0]?.onMic === true,
      receivedGifts: receivedRows[0]?.hits ?? 0,
      receivedDiamonds: receivedRows[0]?.diamonds ?? 0,
      sentDiamonds: sentRows[0]?.diamonds ?? 0
    }
  })
}

/* ------------------------------------------------------------------ AI 画像缓存 */
/** AI 画像的一行（主进程内部形状；渲染层拿到的是 shared/types 的 `AiPortrait`） */
export interface UserPortraitRow {
  key: string
  userId: string
  identityId: number
  /** 这一版分析的角色（`viewer` / `host`；见 `shared/types.ts` 的 `AiPortraitRole`） */
  role: string
  version: number
  providerId: number
  providerName: string
  model: string
  structured: boolean
  /** 结构化报告的 JSON 文本（未结构化时空串） */
  report: string
  raw: string
  fingerprint: string
  interactions: number
  inputTokens: number
  outputTokens: number
  generatedAt: number
}

/** 读某个人的 AI 画像（没生成过 = null） */
export async function getUserPortrait(key: string): Promise<UserPortraitRow | null> {
  const id = String(key ?? '')
  if (!id) return null
  await schemaReady
  return withOrm('douyin-link.getUserPortrait', async (db) => {
    const rows = await db
      .select()
      .from(douyinLinkUserPortraits)
      .where(eq(douyinLinkUserPortraits.portraitKey, id))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      key: row.portraitKey,
      userId: row.userId,
      identityId: row.identityId,
      role: row.role,
      version: row.version,
      providerId: row.providerId,
      providerName: row.providerName,
      model: row.model,
      structured: row.structured,
      report: row.report,
      raw: row.raw,
      fingerprint: row.fingerprint,
      interactions: row.interactions,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      generatedAt: row.generatedAt
    }
  })
}

/**
 * 写 AI 画像（**只留最新一版**，主键冲突就整行覆盖）。
 *
 * `version` 由调用方给（服务层负责「上一版 +1」）——放在这里而不是 `max(version)+1` 的子查询，
 * 是因为版本号还要参与提示词（「这是第 N 版，上一版说了什么」），服务层本来就要先读一遍。
 */
export async function saveUserPortrait(row: UserPortraitRow): Promise<void> {
  if (!row.key) return
  await schemaReady
  const now = Date.now()
  await withOrm('douyin-link.saveUserPortrait', async (db) => {
    await db
      .insert(douyinLinkUserPortraits)
      .values({
        portraitKey: row.key,
        userId: row.userId,
        identityId: row.identityId,
        role: row.role,
        version: row.version,
        providerId: row.providerId,
        providerName: row.providerName,
        model: row.model,
        structured: row.structured,
        report: row.report,
        raw: row.raw,
        fingerprint: row.fingerprint,
        interactions: row.interactions,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        generatedAt: row.generatedAt > 0 ? row.generatedAt : now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: douyinLinkUserPortraits.portraitKey,
        set: {
          userId: row.userId,
          identityId: row.identityId,
          role: row.role,
          version: row.version,
          providerId: row.providerId,
          providerName: row.providerName,
          model: row.model,
          structured: row.structured,
          report: row.report,
          raw: row.raw,
          fingerprint: row.fingerprint,
          interactions: row.interactions,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          generatedAt: row.generatedAt > 0 ? row.generatedAt : now,
          updatedAt: now
        }
      })
  })
}

/** 删掉一个人的 AI 画像（「重新生成」不需要它——覆盖写入即可；留给清数据与工装用） */
export async function deleteUserPortrait(key: string): Promise<number> {
  const id = String(key ?? '')
  if (!id) return 0
  await schemaReady
  return withOrm('douyin-link.deleteUserPortrait', async (db) => {
    const rows = await db
      .delete(douyinLinkUserPortraits)
      .where(eq(douyinLinkUserPortraits.portraitKey, id))
      .returning({ key: douyinLinkUserPortraits.portraitKey })
    return rows.length
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

/**
 * 窗口内**每个直播间**各自的分钟序列（数据大屏「指标」页签：动态排序柱状图 / 日内走势 / 按小时分布）。
 *
 * 与 `minuteSeriesAll`（把各房**同一分钟**相加成一条全局曲线）相对：这里**保留 web_rid**，
 * 渲染层才能画「房间之间横向比」的图。`(web_rid, minute)` 是表的主键，每行天然唯一，
 * 直接按 (web_rid, minute) 排序取回即可，不需要再聚合。
 */
export async function minuteSeriesPerRoom(
  fromMinute: number,
  toMinute: number
): Promise<Map<string, MinuteRow[]>> {
  await schemaReady
  return withOrm('douyin-link.minuteSeriesPerRoom', async (db) => {
    const rows = await db
      .select()
      .from(douyinLinkMinutes)
      .where(and(gte(douyinLinkMinutes.minute, fromMinute), lte(douyinLinkMinutes.minute, toMinute)))
      .orderBy(asc(douyinLinkMinutes.webRid), asc(douyinLinkMinutes.minute))
    const out = new Map<string, MinuteRow[]>()
    for (const row of rows) {
      const entry: MinuteRow = {
        minute: row.minute,
        chat: row.chat,
        member: row.member,
        likes: row.likes,
        social: row.social,
        gift: row.gift,
        diamonds: row.diamonds,
        messages: row.messages,
        users: row.users
      }
      const list = out.get(row.webRid)
      if (list) list.push(entry)
      else out.set(row.webRid, [entry])
    }
    return out
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
