import * as fs from 'fs'
import { BrowserWindow, dialog } from 'electron'
import logger from 'electron-log'
import type { ExportResult, ImportResult } from '../shared/types'
import { createZip, readZip, type ZipEntryInput } from './zip'
import {
  exportDayRanges,
  exportMessageRows,
  exportMinuteRows,
  exportSessionRows,
  exportUserRows,
  importMessages,
  importMinutes,
  importRooms,
  importSessions,
  importUsers,
  listRooms,
  type MessageExportRow,
  type MinuteExportRow,
  type RoomRow,
  type SessionExportRow,
  type UserExportRow
} from './db/mapper'

/**
 * 抖音直播分析器 的数据导入 / 导出（设置页那两个按钮）。
 *
 * 压缩包（ZIP，见 `./zip.ts`）里的结构：
 * - `manifest.json`            —— 格式与版本、导出时刻、房间数等；
 * - `rooms.json`               —— 房间清单（备注 / 监控开关也在内）；
 * - `users/<webRid>.json`      —— 该房间的全部用户档案；
 * - `records/<webRid>/<day>.json` —— **每个 JSON = 某房间某一天的直播数据**
 *    （消息流水 + 分钟聚合 + 当天的监控会话）。
 *
 * 导入按「不能重复」设计：
 * - 房间只补缺（已存在的不覆盖备注/监控开关）；
 * - 消息按（房间/时刻/类型/发送者/内容/数量/抖币/收礼人/单号）指纹去重；
 * - 分钟桶与用户统计**取大不累加**；会话按（房间 + 开始时刻）只补缺。
 * 于是同一份包反复导入是**幂等**的。
 */

const FORMAT = 'douyin-link-archive'
const FORMAT_VERSION = 1

/** 文件对话框的父窗口（可能没有聚焦窗口 → 用无参重载） */
async function pickSave(options: Electron.SaveDialogOptions): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

async function pickOpen(options: Electron.OpenDialogOptions): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}

/** 本地日期串 `YYYY-MM-DD`（与分天口径一致） */
function today(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 一天文件的形状 */
interface DayFile {
  webRid: string
  day: string
  messages: MessageExportRow[]
  minutes: MinuteExportRow[]
  sessions: SessionExportRow[]
}

interface ArchiveManifest {
  format: string
  version: number
  exportedAt: number
  rooms: Array<{ webRid: string; title: string; anchor: string }>
  counts: { rooms: number; days: number; messages: number; users: number; sessions: number }
}

/**
 * 导出：把所有房间的记录打成 ZIP。
 *
 * 只读库、不碰运行态：导出期间监控照常跑（新收到的消息会落在库里，
 * 这一份快照不含导出开始之后的部分——这是快照的语义，不是漏数据）。
 */
export async function exportArchive(): Promise<ExportResult> {
  const rooms = await listRooms()
  const exportedAt = Date.now()
  const target = await pickSave({
    title: '导出抖音直播记录（ZIP）',
    defaultPath: `douyin-link-${today()}.zip`,
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
  })
  if (!target) return { ok: false, path: '', rooms: 0, days: 0, messages: 0, message: 'cancelled' }

  const entries: ZipEntryInput[] = []
  let dayCount = 0
  let messageCount = 0
  let userCount = 0
  let sessionCount = 0

  try {
    for (const room of rooms) {
      const users = await exportUserRows(room.webRid)
      if (users.length > 0) {
        userCount += users.length
        entries.push({ name: `users/${room.webRid}.json`, data: JSON.stringify(users) })
      }
      const days = await exportDayRanges(room.webRid)
      for (const range of days) {
        const [messages, minutes, sessions] = await Promise.all([
          exportMessageRows(room.webRid, range.from, range.to),
          exportMinuteRows(room.webRid, range.from, range.to),
          exportSessionRows(room.webRid, range.from, range.to)
        ])
        if (messages.length === 0 && minutes.length === 0 && sessions.length === 0) continue
        dayCount += 1
        messageCount += messages.length
        sessionCount += sessions.length
        const file: DayFile = { webRid: room.webRid, day: range.day, messages, minutes, sessions }
        entries.push({ name: `records/${room.webRid}/${range.day}.json`, data: JSON.stringify(file) })
      }
    }
    entries.push({ name: 'rooms.json', data: JSON.stringify(rooms) })
    const manifest: ArchiveManifest = {
      format: FORMAT,
      version: FORMAT_VERSION,
      exportedAt,
      rooms: rooms.map((room) => ({ webRid: room.webRid, title: room.title, anchor: room.anchor })),
      counts: { rooms: rooms.length, days: dayCount, messages: messageCount, users: userCount, sessions: sessionCount }
    }
    entries.push({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) })

    const buffer = createZip(entries)
    fs.writeFileSync(target, buffer)
    logger.info(
      `[douyin-link] 导出完成：${target}（${rooms.length} 个房间、${dayCount} 天、${messageCount} 条消息、${userCount} 条用户）`
    )
    return { ok: true, path: target, rooms: rooms.length, days: dayCount, messages: messageCount }
  } catch (error) {
    logger.warn('[douyin-link] 导出失败:', error)
    return { ok: false, path: '', rooms: 0, days: 0, messages: 0, message: describe(error) }
  }
}

/** 解析出来的一天文件（字段缺失一律当空数组，坏数据不该让整包导入失败） */
function parseDayFile(raw: unknown): DayFile | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Partial<DayFile>
  if (typeof record.webRid !== 'string' || !record.webRid) return null
  const day = typeof record.day === 'string' ? record.day : ''
  return {
    webRid: record.webRid,
    day,
    messages: Array.isArray(record.messages) ? (record.messages as MessageExportRow[]) : [],
    minutes: Array.isArray(record.minutes) ? (record.minutes as MinuteExportRow[]) : [],
    sessions: Array.isArray(record.sessions) ? (record.sessions as SessionExportRow[]) : []
  }
}

/** 导入：读一个 ZIP，去重后合并进库 */
export async function importArchive(): Promise<ImportResult> {
  const empty: ImportResult = { ok: false, rooms: 0, messages: 0, skipped: 0, users: 0 }
  const file = await pickOpen({
    title: '导入抖音直播记录（ZIP）',
    properties: ['openFile'],
    filters: [
      { name: 'ZIP 压缩包', extensions: ['zip'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  })
  if (!file) return { ...empty, message: 'cancelled' }

  try {
    const files = readZip(fs.readFileSync(file))
    const manifestRaw = files.get('manifest.json')
    if (manifestRaw) {
      const manifest = JSON.parse(manifestRaw.toString('utf-8')) as Partial<ArchiveManifest>
      if (manifest.format !== FORMAT || (manifest.version ?? 0) > FORMAT_VERSION) {
        return { ...empty, message: 'badFormat' }
      }
    }

    let roomsAdded = 0
    if (files.has('rooms.json')) {
      const rooms = JSON.parse(files.get('rooms.json')!.toString('utf-8')) as RoomRow[]
      if (Array.isArray(rooms)) roomsAdded = await importRooms(rooms.filter((room) => room?.webRid))
    }

    let users = 0
    for (const [name, content] of files) {
      if (!name.startsWith('users/') || !name.endsWith('.json')) continue
      const rows = JSON.parse(content.toString('utf-8')) as UserExportRow[]
      if (Array.isArray(rows)) users += await importUsers(rows.filter((row) => row?.webRid && row?.userId))
    }

    let messages = 0
    let skipped = 0
    // 逐天文件处理：每个 JSON 是「某房间某一天的直播数据」
    for (const [name, content] of files) {
      if (!name.startsWith('records/') || !name.endsWith('.json')) continue
      const day = parseDayFile(JSON.parse(content.toString('utf-8')))
      if (!day) continue
      if (day.minutes.length > 0) await importMinutes(day.minutes)
      if (day.sessions.length > 0) await importSessions(day.sessions)
      if (day.messages.length > 0) {
        const result = await importMessages(day.messages)
        messages += result.added
        skipped += result.skipped
      }
    }

    logger.info(
      `[douyin-link] 导入完成：${file}（新增房间 ${roomsAdded}、用户 ${users}、消息 ${messages}、跳过重复 ${skipped}）`
    )
    return { ok: true, rooms: roomsAdded, messages, skipped, users }
  } catch (error) {
    logger.warn('[douyin-link] 导入失败:', error)
    return { ...empty, message: describe(error) }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200)
  return String(error).slice(0, 200)
}