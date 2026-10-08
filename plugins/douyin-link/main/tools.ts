import { tool } from '@langchain/core/tools'
import * as z from 'zod/v4'
import { mainFormat } from '@host/main/i18n'
import { HARNESS_TOOL_CONTRIBUTION } from '@host/main/plugins/tool-contract'
import type { DanmakuKind, RoomRuntime } from '../shared/types'
import { analyzerHub } from './monitor/hub'
import { getToolTexts, toolDescriptions } from './tool-texts'

/**
 * 抖音直播分析器 给助手的 AI 工具。
 *
 * 两条规矩：
 * - 经 **工具贡献点**（HARNESS_TOOL_CONTRIBUTION）注册：插件停用时 harness 拉不到这条贡献，
 *   工具自然从模型面前消失（不需要去改宿主的工具表）；
 * - 工具读的是**本插件自己的数据**（房间运行态 + 自己的表），不跨插件直读别人的数据。
 *
 * 能力边界：助手能看**文字与数字**（房间清单、KPI、消息检索、用户榜、多房间对比），
 * 能开关监控与音频；但**听不到声音**——音频帧只推给界面（主进程 → 渲染层的通道）。
 */

export const LIVE_TOOL_NAME = 'douyin_live'

export function createToolContribution(): {
  name: string
  info: { name: string; label: string; description: string; icon: string; color: string }
  build: () => unknown
} {
  const desc = toolDescriptions()
  return {
    name: LIVE_TOOL_NAME,
    info: {
      name: LIVE_TOOL_NAME,
      label: '抖音直播分析器',
      description: desc.zh,
      icon: 'RiLiveLine',
      color: '#8b5cf6'
    },
    build: () =>
      tool(
        async (input: {
          action: 'rooms' | 'summary' | 'messages' | 'users' | 'compare' | 'monitor' | 'audio'
          room?: string
          keyword?: string
          kind?: string
          sort?: 'recent' | 'chat' | 'gift'
          minutes?: number
          limit?: number
          on?: boolean
        }) => {
          const texts = getToolTexts()
          const t = texts.douyin_live
          const supported = 'rooms, summary, messages, users, compare, monitor, audio'
          const action = String(input?.action ?? '')
          if (!supported.includes(action)) {
            return mainFormat(texts.common.unknownAction, { action, supported })
          }

          const snapshot = await analyzerHub.snapshot()
          const room = resolveRoom(snapshot.rooms, input.room)

          if (action === 'rooms') return roomsText(t, snapshot.rooms, snapshot.activeRoom, snapshot.audioRoom)

          if (action === 'monitor') {
            if (!room) return t.noRoom
            await analyzerHub.setMonitor(room.webRid, input.on !== false)
            return mainFormat(t.monitorDone, {
              room: roomLabel(room),
              state: input.on !== false ? t.monitorOn : t.monitorOff
            })
          }

          if (action === 'audio') {
            if (input.on === false) {
              analyzerHub.stopAudio()
              return t.audioStopped
            }
            const ok = await analyzerHub.startAudio(room?.webRid ?? snapshot.activeRoom)
            return ok ? mainFormat(t.audioStarted, { room: room ? roomLabel(room) : snapshot.activeRoom }) : t.audioFailed
          }

          if (action === 'compare') {
            const minutes = clampMinutes(input.minutes)
            const rows = await analyzerHub.compare(minutes)
            if (rows.length === 0) return t.noRooms
            const lines = [mainFormat(t.compareHeader, { minutes })]
            for (const row of rows) {
              lines.push(
                mainFormat(t.compareRow, {
                  room: `${row.title || row.webRid}（${row.webRid}）`,
                  messages: row.messages,
                  chat: row.chat,
                  gift: row.gift,
                  diamonds: row.diamonds,
                  member: row.member,
                  like: row.like,
                  social: row.social,
                  users: row.users,
                  rate: row.perMinute,
                  total: row.totalMessages
                })
              )
            }
            return lines.join('\n')
          }

          if (!room) return t.noRoom

          if (action === 'summary') {
            const minutes = clampMinutes(input.minutes)
            const summary = await analyzerHub.summary(room.webRid, minutes)
            const lines = [
              mainFormat(t.summaryHeader, { room: roomLabel(room), minutes }),
              mainFormat(t.summaryTotals, {
                messages: summary.messages,
                chat: summary.totals.chat,
                gift: summary.totals.gift,
                diamonds: summary.totals.diamonds,
                member: summary.totals.enter,
                like: summary.totals.like,
                social: summary.totals.follow,
                users: summary.users
              })
            ]
            if (summary.lastAt > 0) {
              lines.push(
                mainFormat(t.summaryWindow, {
                  from: stamp(summary.firstAt),
                  to: stamp(summary.lastAt)
                })
              )
            }
            if (summary.kinds.length > 0) {
              lines.push(
                mainFormat(t.summaryKinds, {
                  kinds: summary.kinds
                    .map((entry) => `${texts.kinds[entry.kind] ?? entry.kind} ${entry.count}`)
                    .join(' · ')
                })
              )
            }
            if (summary.topChat.length > 0) {
              lines.push(mainFormat(t.summaryTopChat, { list: topList(summary.topChat, 'chat') }))
            }
            if (summary.topGift.length > 0) {
              lines.push(mainFormat(t.summaryTopGift, { list: topList(summary.topGift, 'gift') }))
            }
            return lines.join('\n')
          }

          if (action === 'users') {
            const limit = clampLimit(input.limit, 20)
            const rows = await analyzerHub.listUsers(
              room.webRid,
              input.sort === 'chat' || input.sort === 'gift' ? input.sort : 'recent',
              String(input.keyword ?? ''),
              limit
            )
            if (rows.length === 0) return t.usersEmpty
            const lines = [mainFormat(t.usersHeader, { room: roomLabel(room), count: rows.length })]
            for (const row of rows) {
              lines.push(
                mainFormat(t.userLine, {
                  user: `${row.nickname || row.userId}${row.displayId ? `（ID ${row.displayId}）` : ''}`,
                  chat: row.stats.chat,
                  gift: row.stats.gift,
                  diamonds: row.stats.diamonds,
                  enter: row.stats.enter,
                  like: row.stats.like,
                  follow: row.stats.follow,
                  honor: row.honorLevel,
                  fans: row.fansClubLevel
                })
              )
            }
            return lines.join('\n')
          }

          // messages：走数据库检索（支持房间/关键词/类型/时间窗）
          const limit = clampLimit(input.limit, 30)
          const kind = input.kind && input.kind in texts.kinds ? (input.kind as DanmakuKind) : ''
          const page = await analyzerHub.queryMessages({
            webRid: room.webRid,
            keyword: String(input.keyword ?? ''),
            kind,
            limit
          })
          if (page.rows.length === 0) return t.danmakuEmpty
          const lines = [mainFormat(t.danmakuHeader, { count: page.rows.length, total: page.total })]
          for (const row of page.rows) {
            const count = row.count > 0 ? mainFormat(t.countSuffix, { count: row.count }) : ''
            lines.push(
              mainFormat(t.line, {
                kind: texts.kinds[row.kind] ?? row.kind,
                time: stamp(row.at),
                user: row.user ? `${row.user}：` : '',
                text: `${row.text}${count}`
              })
            )
          }
          return lines.join('\n')
        },
        {
          name: LIVE_TOOL_NAME,
          description: desc.zh,
          schema: z.object({
            action: z
              .enum(['rooms', 'summary', 'messages', 'users', 'compare', 'monitor', 'audio'])
              .describe('rooms=房间清单；summary=房间分析报告；messages=库内消息检索；users=用户榜；compare=多房间对比；monitor=开关监控；audio=开关声音'),
            room: z.string().optional().describe('房间号或标题关键词；省略 = 分析中的房间（rooms/compare 不需要）'),
            keyword: z.string().optional().describe('messages/users 的关键词（正文或昵称）'),
            kind: z.string().optional().describe('messages 的类型：chat/gift/member/like/social'),
            sort: z.enum(['recent', 'chat', 'gift']).optional().describe('users 的排序'),
            minutes: z.number().optional().describe('summary/compare 的统计窗口（分钟，默认 60）'),
            limit: z.number().optional().describe('返回条数（默认 messages 30 / users 20，最多 200）'),
            on: z.boolean().optional().describe('monitor/audio 的开关（默认 true）')
          })
        }
      )
  }
}

type ToolTexts = ReturnType<typeof getToolTexts>

/** 房间清单：每个房间一行（相位、本场计数、库里累计） */
function roomsText(
  t: ToolTexts['douyin_live'],
  rooms: RoomRuntime[],
  activeRoom: string,
  audioRoom: string
): string {
  if (rooms.length === 0) return t.noRooms
  const lines = [mainFormat(t.roomsHeader, { count: rooms.length })]
  for (const room of rooms) {
    lines.push(
      mainFormat(t.roomLine, {
        room: `${room.title || room.webRid}（${room.webRid}）`,
        phase: phaseText(t, room.phase),
        monitor: room.monitor ? t.monitorOn : t.monitorOff,
        audio: room.webRid === audioRoom ? t.audioYes : t.audioNo,
        focus: room.webRid === activeRoom ? t.focusYes : '',
        rate: room.rate,
        received: room.received,
        users: room.sessionUsers,
        stored: room.stored.messages,
        storedUsers: room.stored.users,
        diamonds: room.stored.diamonds
      })
    )
    if (room.failure) lines.push(mainFormat(t.roomFailure, { code: room.failure.code }))
  }
  return lines.join('\n')
}

function phaseText(t: ToolTexts['douyin_live'], phase: string): string {
  switch (phase) {
    case 'live':
      return t.phaseLive
    case 'connecting':
    case 'resolving':
      return t.phaseConnecting
    case 'retrying':
      return t.phaseRetrying
    case 'queued':
      return t.phaseQueued
    case 'error':
      return t.phaseError
    case 'ended':
      return t.phaseEnded
    default:
      return t.phaseOff
  }
}

/** 房间定位：房间号精确 / 房间号片段 / 标题或备注关键词（都找不到就返回 undefined） */
function resolveRoom(rooms: RoomRuntime[], query?: string): RoomRuntime | undefined {
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle) {
    const exact = rooms.find((room) => room.webRid === needle)
    if (exact) return exact
    const partial = rooms.find(
      (room) =>
        room.webRid.includes(needle) ||
        room.title.toLowerCase().includes(needle) ||
        room.note.toLowerCase().includes(needle)
    )
    if (partial) return partial
    return undefined
  }
  return undefined
}

function roomLabel(room: RoomRuntime): string {
  return `${room.title || room.webRid}（${room.webRid}）`
}

function topList(rows: Array<{ nickname: string; userId: string; stats: { chat: number; diamonds: number } }>, kind: 'chat' | 'gift'): string {
  return rows
    .map((row) =>
      kind === 'chat'
        ? `${row.nickname || row.userId} ${row.stats.chat}`
        : `${row.nickname || row.userId} ${row.stats.diamonds}`
    )
    .join(' · ')
}

function clampMinutes(value?: number): number {
  const minutes = Math.round(Number(value) || 60)
  return Math.min(Math.max(5, minutes), 1440)
}

function clampLimit(value: number | undefined, fallback: number): number {
  const limit = Math.round(Number(value) || fallback)
  return Math.min(Math.max(1, limit), 200)
}

/** ms → `MM-DD HH:mm:ss`（工具返回里给人看的时间） */
function stamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export { HARNESS_TOOL_CONTRIBUTION }
