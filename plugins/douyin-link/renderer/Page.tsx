import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, DatePicker, Modal, Segmented, Tag } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { RiDeleteBin6Line, RiRadarLine, RiTeamLine, RiUserSearchLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type {
  AnalyzerSnapshot,
  DanmakuItem,
  DayRecordRow,
  FailureInfo,
  LiveSettings,
  MysteryProfile,
  MysteryReveal,
  RoomRuntime,
  UserAnalysis,
  UserProfile
} from '../shared/types'
import { isAnonymousId } from '../shared/anonymous'
import api, { normalizeSnapshot } from './api'
import { AllRoomsPanel } from './components/AllRoomsPanel'
import { DanmakuFeed } from './components/DanmakuFeed'
import { MetricsPanel } from './components/MetricsPanel'
import { OverviewPanel } from './components/OverviewPanel'
import { PresencePanel } from './components/PresencePanel'
import {
  PageShell,
  Pane,
  Panel,
  PillTabBar,
  PillTabsBody,
  ScrollStyle,
  formModalProps,
  splitModalProps,
  cleanName,
  roomLabel,
  usePluginPalette
} from './components/ui'
import type { PillTabItem, PluginPalette } from './components/ui'
import { RoomRail } from './components/RoomRail'
import { SearchPanel } from './components/SearchPanel'
import { UserAvatar } from './components/UserAvatar'
import { UserHistory } from './components/UserHistory'
import { GiftHistoryModal } from './components/GiftHistory'
import { DayRail } from './components/DayRail'
import { UsersPanel } from './components/UsersPanel'
import { duration, formatNumber, stamp } from './components/OverviewPanel'

type Translate = (key: string, options?: Record<string, unknown>) => string
type TabKey = 'overview' | 'live' | 'presence' | 'users' | 'search' | 'all' | 'metrics'
/** 视图模式：直播间（单房间页签）/ 数据大屏（跨房间聚合 + 检索） */
type ViewMode = 'room' | 'dashboard'
/** 各模式下合法的页签（切模式时用它把停在别处的 tab 收回来） */
const ROOM_TABS: TabKey[] = ['overview', 'live', 'presence', 'users']
const DASHBOARD_TABS: TabKey[] = ['all', 'metrics', 'search']
const DEFAULT_ROOM_TAB: TabKey = 'overview'
const DEFAULT_DASHBOARD_TAB: TabKey = 'all'
/**
 * 概览页签的**兜底窗口**（分钟）。概览正常都带 `effectiveRange`（今天 / 选中的那一天），
 * 这个值只在拿不到时间范围时才用得上（见 OverviewPanel 的 `minutes`）。
 */
const OVERVIEW_MINUTES = 60

/**
 * 「直播间 / 数据大屏」切换时的淡入动画关键帧。
 *
 * 关键帧写在 `<style>` 里（内联样式没法定义 `@keyframes`），用内联 `animation` 引用它——
 * 不引入任何类名（插件页的样式覆盖检查按类名比对，这样最干净）。
 * 主体用 `key={mode}` 触发重放，见下面渲染里的说明。
 */
const MODE_SWITCH_CSS = `
@keyframes rb-mode-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
`

/**
 * 实时列表里一次往库里翻多少条 / 内存里最多挂多少条。
 *
 * 库里是**全部**（默认永久保存），内存里挂的只是「正在看的这一段」：翻到更早的靠
 * 「加载更早」继续查库，所以内存上限只用来兜住 DOM 与数组的体量，不影响内容是否还在。
 */
const FEED_PAGE = 300
const FEED_CAP = 5000

/**
 * 合并两段弹幕（老的在前、新的在后），按 `id` 去重——库里的历史与内存里的实时段会有重叠。
 *
 * 超出 `FEED_CAP` 只从**最前面**裁（裁掉的是最早的历史，可以再翻回来），
 * 绝不裁后面的新消息。
 */
function mergeFeed(older: DanmakuItem[], current: DanmakuItem[]): DanmakuItem[] {
  const seen = new Set(current.map((item) => item.id))
  const head = older.filter((item) => !seen.has(item.id))
  return [...head, ...current].slice(-FEED_CAP)
}

/** 本地日期串 `YYYY-MM-DD`（与主进程 `dayRecords` 的分天口径一致） */
function localDay(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 抖音直播分析器 的页面。
 *
 * 三条边界，读代码时先记住：
 * 1. **界面只是视图**：房间清单、相位、计数、分析结果全部由主进程算（`main/monitor/hub.ts`）
 *    并从数据库里查（`main/db/mapper.ts`）。页面不解析链接、不拉流、不建窗口、
 *    也不自己攒数据——所以关掉页面、切走页签都不会影响监控；
 * 2. **声音只跟「分析中的房间」**：主进程全局只有一个音频泵，点某个房间 = 把声音切给它，
 *    其它房间继续在后台监听弹幕（这是这一版的核心诉求）；
 * 3. 布局纪律照 WORKSHOP 第 6 节：根节点不滚（PageShell）、列布局固定 grid-cols-12、
 *    内容多了靠 FitTable/FitList 降级、配色只取 usePluginPalette()。
 */
export default function Page(): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const palette = usePluginPalette()

  const [rooms, setRooms] = useState<RoomRuntime[]>([])
  const [activeRoom, setActiveRoom] = useState('')
  const [settings, setSettings] = useState<LiveSettings | null>(null)
  const [itemsByRoom, setItemsByRoom] = useState<Map<string, DanmakuItem[]>>(() => new Map())
  const [usersByRoom, setUsersByRoom] = useState<Map<string, Map<string, UserProfile>>>(() => new Map())
  const [usersReloadKey, setUsersReloadKey] = useState(0)
  const [tab, setTab] = useState<TabKey>('overview')
  /** 视图模式：直播间（单房间页签）/ 数据大屏（跨房间聚合）；切换按钮在左栏「全部停止」旁 */
  const [mode, setMode] = useState<ViewMode>('room')
  /**
   * 数据大屏的时间区间（用户自己选的一段，默认「今天」）。
   *
   * 用户 2026-10-10 的要求：「数据大屏里面的时间区间要改成选择时间区间的，默认是当天」——
   * 原来的「最近 15 分钟 / 1 小时 / …」预设换成一个**日期区间选择器**，默认本地自然日的
   * 今天（00:00 → 24:00）。今天且右端是「今天 24:00」时，主进程的全局分析推送不会被当成
   * 历史区间跳过，所以大屏仍然是实时更新的。
   */
  const [dashRange, setDashRange] = useState<[Dayjs, Dayjs]>(() => [dayjs().startOf('day'), dayjs().endOf('day')])
  const [busy, setBusy] = useState(false)
  const [openUser, setOpenUser] = useState('')
  /**
   * 时间范围（概览看的是哪一段）：`null` = 用「这一天」的默认整段（今天 = 00:00 → 现在）。
   * 两个入口都往这里写：概览的时间进度条、左侧「每日记录」点某一天。
   */
  const [range, setRange] = useState<{ from: number; to: number } | null>(null)
  /** 数据大屏实际查询用的区间（ms）：由上面的日期选择器换算而来 */
  const dashboardRange = useMemo(
    () => ({ from: dashRange[0].valueOf(), to: dashRange[1].valueOf() }),
    [dashRange]
  )
  /**
   * 「现在」的粗粒度时钟（每 5 秒一跳）。
   *
   * 为什么必须有它：「今天」的时间范围右端得**跟着时间走**。`dayBounds.last` 原来只在挂载时
   * 用一次 `Date.now()` 算出来，而它的依赖只有 `activeDay`（今天根本不变），于是右端被**冻在
   * 打开界面的那一刻**：概览永远只统计到那一秒，之后落库的礼物进不了窗口；主进程还会因为
   * 「窗口右端已是历史」而干脆不再推送概览。用户看到的就是「礼物不是实时的，得关掉应用重新
   * 进来才看见最新的」。用这个心跳让右端持续推进即可（历史的那一天仍是整天，不受影响）。
   */
  const [clock, setClock] = useState(() => Date.now())
  /** 当前房间「每一天的直播记录」（左侧列表）与它选中的那一天 */
  const [days, setDays] = useState<DayRecordRow[]>([])
  const [daySel, setDaySel] = useState('')
  const [daysLoading, setDaysLoading] = useState(false)
  /**
   * 「加载更早」的状态（按房间）：`loading` = 正在查库、`done` = 库里再往前没有了。
   * 实时列表只装得下有限条，更早的内容在库里——这个按钮就是把它翻出来（内容不会消失）。
   */
  const [earlierByRoom, setEarlierByRoom] = useState<Map<string, { loading: boolean; done: boolean }>>(
    () => new Map()
  )
  /**
   * 礼物榜点开的那一行（`null` = 没开）：这个人 + 方向（他送的 / 他收到的）。
   * 与用户档案弹窗是两个入口，互不干扰。
   */
  const [openGifts, setOpenGifts] = useState<{ userId: string; name: string; direction: 'sent' | 'received' } | null>(
    null
  )
  /** 「添加直播间」失败时的提示（代码在主进程，文案在这里翻） */
  const [addFailure, setAddFailure] = useState<FailureInfo | null>(null)

  const settingsRef = useRef<LiveSettings | null>(null)
  /** 当前页签（事件回调里要用到，但不想因为切页签重订阅事件通道） */
  const tabRef = useRef<TabKey>('overview')
  /** 「用户榜需要刷新」的欠账：不在用户页签时不查库，切回去补一次 */
  const usersReloadPending = useRef(false)
  /** 已经为该房间补过「库里的历史」的房间（每个房间只自动补一次） */
  const historyLoaded = useRef<Set<string>>(new Set())
  const maxItems = settings?.maxItems ?? 200

  const active = useMemo(() => rooms.find((room) => room.webRid === activeRoom) ?? null, [rooms, activeRoom])
  const items = activeRoom ? (itemsByRoom.get(activeRoom) ?? []) : []
  const users = activeRoom ? (usersByRoom.get(activeRoom) ?? new Map()) : new Map<string, UserProfile>()

  /**
   * 「每日记录」：切房间时拉一次，监控中的房间每分钟补一次（今天那一行是活的）。
   * 进度条两端也来自它（最早/最近一天的首末消息时间）——所以两处口径天然一致。
   */
  const reloadDays = useCallback(async (webRid: string): Promise<void> => {
    if (!webRid) {
      setDays([])
      return
    }
    setDaysLoading(true)
    try {
      setDays(await api.dayRecords(webRid, 120))
    } catch {
      setDays([])
    } finally {
      setDaysLoading(false)
    }
  }, [])

  /**
   * **时间进度条只在一天之内**（用户 2026-10-08：「时间范围只在今天的时间范围，不能跨天」）。
   *
   * 所以先定「看的是哪一天」：`daySel` 空 = 今天。这一天的 00:00 → 现在（历史的日子是
   * 00:00 → 24:00）就是进度条的两端，拖把手只能在这一天里选一段，永远跨不到昨天去。
   * 想看别的日子就点左侧「每日记录」里那一天。
   */
  const today = localDay(Date.now())
  const activeDay = daySel || today
  const dayRow = useMemo(() => days.find((day) => day.day === activeDay) ?? null, [days, activeDay])
  const dayBounds = useMemo(() => {
    const start = new Date(`${activeDay}T00:00:00`).getTime()
    if (!Number.isFinite(start)) return null
    const end = start + 86400000 - 1
    // 「现在」用 clock（每 5 秒一跳）而不是当场取 Date.now()：今天的右端要持续推进，
    // 否则这个 memo 只算一次、之后永远停在打开那一刻（见 clock 的注释）。
    // 今天还没有数据时也给一条进度条（用户可以先看空态，数据一到就动起来）
    return { first: start, last: Math.min(end, clock) }
  }, [activeDay, clock])

  /**
   * 生效的时间范围：用户拖出来的那一段**夹在这一天之内**；没拖过就是「这一天的全部数据」
   * （今天 = 00:00 或第一条 → 现在，历史的日子 = 那天的第一条 → 最后一条）。
   */
  const effectiveRange = useMemo(() => {
    if (!dayBounds) return null
    const clamp = (value: number): number => Math.min(Math.max(value, dayBounds.first), dayBounds.last)
    if (range) {
      const from = clamp(range.from)
      const to = clamp(range.to)
      return to > from ? { from, to } : { from: dayBounds.first, to: dayBounds.last }
    }
    const from = dayRow && dayRow.firstAt > 0 ? Math.max(dayBounds.first, dayRow.firstAt) : dayBounds.first
    const to =
      activeDay === today
        ? dayBounds.last
        : dayRow && dayRow.lastAt > 0
          ? Math.min(dayBounds.last, dayRow.lastAt)
          : dayBounds.last
    return to > from ? { from, to } : { from: dayBounds.first, to: dayBounds.last }
  }, [range, dayBounds, dayRow, activeDay, today])

  /** 点「每日记录」里的一天：把详情切到那一天（`range` 归零 = 用那一天的默认整段） */
  const pickDay = useCallback((day: DayRecordRow): void => {
    setDaySel(day.day)
    setRange(null)
  }, [])

  /** 进度条拖动：只改这一段，看的是哪一天不变（所以它跨不出这一天） */
  const changeRange = useCallback((next: { from: number; to: number } | null): void => {
    setRange(next)
  }, [])

  /* ------------------------------------------------------- 初始与推送 */

  const applySnapshot = useCallback((raw: AnalyzerSnapshot): void => {
    // 出口再兜一层归一化：`rooms` 必须是数组（界面里到处是 rooms.find），
    // settings 必须完整。主进程刚起来、或工坊的挂载冒烟在插件刚装好时渲染这一页，
    // 都可能给不出一份完整快照——那种时候界面该是空态，不是白屏。
    const next = normalizeSnapshot(raw)
    setRooms(next.rooms)
    setActiveRoom(next.activeRoom)
    setSettings(next.settings)
    settingsRef.current = next.settings
    if (next.activeRoom && next.recent.length > 0) {
      setItemsByRoom((previous) => {
        const map = new Map(previous)
        map.set(next.activeRoom, next.recent)
        return map
      })
    }
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    applySnapshot(await api.snapshot())
  }, [applySnapshot])

  useEffect(() => {
    void reload()
  }, [reload])

  /**
   * 「现在」时钟：每 5 秒把 `clock` 推一格，让「今天」的时间范围右端跟着时间走
   * （见 clock 的注释——没有它，概览会冻在打开那一刻，新的礼物永远进不来）。
   */
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 5000)
    return () => window.clearInterval(timer)
  }, [])

  /**
   * 当前房间的「每日记录」：切房间时拉一次，监控中每 60 秒补一次（今天那一行的计数是活的）。
   * 房间没在监控也要拉——历史记录与监控状态无关。
   */
  useEffect(() => {
    if (!activeRoom) {
      setDays([])
      return
    }
    void reloadDays(activeRoom)
    if (!active?.monitor) return
    const timer = window.setInterval(() => void reloadDays(activeRoom), 60000)
    return () => window.clearInterval(timer)
  }, [activeRoom, active?.monitor, reloadDays])

  /** 房间列表推送：相位、计数、库里累计都在里面（界面直接替换，不做增量合并） */
  useEffect(
    () =>
      api.onRooms((push) => {
        // 推送形状不信任（api 层挡过一道，这里再挡 undefined 的房间号）
        setRooms(Array.isArray(push.rooms) ? push.rooms : [])
        setActiveRoom(typeof push.activeRoom === 'string' ? push.activeRoom : '')
      }),
    []
  )

  /** 消息批：只并进它自己那个房间的列表（切房间回来还是这些） */
  useEffect(
    () =>
      api.onMessages((batch) => {
        setItemsByRoom((previous) => {
          const map = new Map(previous)
          const list = [...(map.get(batch.webRid) ?? []), ...batch.items].slice(-FEED_CAP)
          map.set(batch.webRid, list)
          return map
        })
      }),
    []
  )

  /** 计数心跳：原地改那个房间的计数（不重拉快照） */
  useEffect(
    () =>
      api.onTicks((tick) => {
        setRooms((previous) =>
          previous.map((room) =>
            room.webRid === tick.webRid
              ? {
                  ...room,
                  counters: tick.counters,
                  received: tick.received,
                  rate: tick.rate,
                  sessionUsers: tick.sessionUsers
                }
              : room
          )
        )
      }),
    []
  )

  /**
   * 用户档案变化：合并进对应房间的表，并让用户榜刷新一次。
   *
   * **只在用户页签开着时才让它查库**：用户榜每次刷新都是一条数据库查询，而推送
   * 最多 1.5 秒一次——页签没开着还照查，就是在跟宿主的流式输出抢 PGlite
   * （用户实测：「监控一开，对话输出卡到一半不动」）。没开着就记一笔欠账，切回去补。
   */
  useEffect(
    () =>
      api.onUsers((batch) => {
        setUsersByRoom((previous) => {
          const map = new Map(previous)
          const table = new Map(map.get(batch.webRid) ?? [])
          for (const user of batch.users) table.set(user.id, user)
          map.set(batch.webRid, table)
          return map
        })
        if (tabRef.current === 'users') setUsersReloadKey((previous) => previous + 1)
        else usersReloadPending.current = true
      }),
    []
  )

  /** 切回用户页签：把欠账补上（只补一次） */
  useEffect(() => {
    if (tab !== 'users') return
    tabRef.current = tab
    if (!usersReloadPending.current) return
    usersReloadPending.current = false
    setUsersReloadKey((previous) => previous + 1)
  }, [tab])

  /* ----------------------------------------------------------- 房间操作 */

  const saveSettings = useCallback(async (patch: Partial<LiveSettings>): Promise<void> => {
    const next = await api.setSettings(patch)
    settingsRef.current = next
    setSettings(next)
  }, [])

  const addRoom = useCallback(
    async (input: string): Promise<void> => {
      setBusy(true)
      setAddFailure(null)
      try {
        const result = await api.roomAdd(input)
        if (!result.ok) setAddFailure(result.failure ?? { code: 'resolveFailed' })
        else if (result.webRid) await loadRoomData(result.webRid)
      } finally {
        setBusy(false)
        await reload()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reload, maxItems]
  )

  /** 切到某个房间时把它的「最近弹幕」与「用户表」拉一次；弹幕再补一段**库里的**历史 */
  const loadRoomData = useCallback(
    async (webRid: string): Promise<void> => {
      const [recent, userPage, stored] = await Promise.all([
        api.roomRecent(webRid, Math.max(50, maxItems)),
        api.usersList(webRid, 'recent', '', { limit: 300 }),
        /**
         * 内存里只有最近 `maxItems` 条，**库里的才是全部**：这里把库里的最近一段也拉进来，
         * 不然切个房间/重启一次，之前收的礼物就从列表上「消失」了（用户 2026-10-08 反馈
         * 「怎么礼物会不断消失」）。更早的用列表顶部的「加载更早」继续往库里翻。
         */
        api.messagesQuery({ webRid, limit: FEED_PAGE }).catch(() => ({ rows: [], total: 0 }))
      ])
      setItemsByRoom((previous) => {
        const map = new Map(previous)
        const older = [...stored.rows].reverse() as DanmakuItem[]
        map.set(webRid, mergeFeed(older, map.get(webRid) ?? recent))
        return map
      })
      setUsersByRoom((previous) => {
        const map = new Map(previous)
        const table = new Map<string, UserProfile>()
        for (const row of userPage.rows) {
          table.set(row.userId, {
            id: row.userId,
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
            firstSeen: row.firstSeen,
            lastSeen: row.lastSeen,
            stats: row.stats
          })
        }
        map.set(webRid, table)
        return map
      })
    },
    [maxItems]
  )

  const selectRoom = useCallback(
    (webRid: string): void => {
      if (webRid === activeRoom) return
      setActiveRoom(webRid)
      // 换房间 = 换一份数据：时间范围与选中的那一天都回到「最近」
      setRange(null)
      setDaySel('')
      void reloadDays(webRid)
      void api.roomSelect(webRid).then(() => loadRoomData(webRid))
    },
    [activeRoom, loadRoomData, reloadDays]
  )

  /**
   * 切模式：把页签收回到该模式合法的那个。
   * `tab` 是单值，而「检索 / 对比」只在数据大屏里、单房间页签只在直播间模式里——
   * 不收回来会停在一个当前模式没有的页签上（空白）。
   */
  const changeMode = useCallback((next: ViewMode): void => {
    setMode(next)
    const valid = next === 'room' ? ROOM_TABS : DASHBOARD_TABS
    setTab((current) => (valid.includes(current) ? current : next === 'room' ? DEFAULT_ROOM_TAB : DEFAULT_DASHBOARD_TAB))
  }, [])

  /** 数据大屏里点一行/一个房间 → 切到该直播间并回到直播间模式（看它的详情） */
  const openRoom = useCallback(
    (webRid: string): void => {
      selectRoom(webRid)
      changeMode('room')
    },
    [changeMode, selectRoom]
  )

  /**
   * 选中的房间**列表是空的就补一段库里的历史**（用户 2026-10-08：「弹幕也一样」——
   * 下播 / 关掉监控 / 重启应用之后内存里那一段没了，实时页就整片空白，而数据都在库里）。
   *
   * 触发时机：应用刚打开、切房间、下播后重启。每个房间只自动试一次（`historyLoaded`），
   * 免得「库里真的没有消息」时反复查库。
   */
  useEffect(() => {
    if (!activeRoom || historyLoaded.current.has(activeRoom)) return
    const list = itemsByRoom.get(activeRoom)
    if (list && list.length > 0) return
    historyLoaded.current.add(activeRoom)
    void loadRoomData(activeRoom)
  }, [activeRoom, itemsByRoom, loadRoomData])

  /**
   * 「加载更早」：按当前列表里**最早那条的时间**往库里再翻一页（老消息在前）。
   *
   * 翻到库里没有了就把这个房间标成 `done`，按钮变成「没有更早的了」。
   * 这是「内容不消失」的兜底：实时列表只有一段，库里的历史永远能翻回来。
   */
  const loadEarlier = useCallback((): void => {
    const webRid = activeRoom
    if (!webRid) return
    const list = itemsByRoom.get(webRid) ?? []
    const oldest = list[0]?.at ?? 0
    if (oldest <= 0) return
    setEarlierByRoom((previous) => {
      const map = new Map(previous)
      map.set(webRid, { loading: true, done: previous.get(webRid)?.done ?? false })
      return map
    })
    void api
      .messagesQuery({ webRid, to: oldest - 1, limit: FEED_PAGE })
      .then((page) => {
        const older = [...page.rows].reverse() as DanmakuItem[]
        setItemsByRoom((previous) => {
          const map = new Map(previous)
          map.set(webRid, mergeFeed(older, map.get(webRid) ?? []))
          return map
        })
        setEarlierByRoom((previous) => {
          const map = new Map(previous)
          map.set(webRid, { loading: false, done: older.length === 0 })
          return map
        })
      })
      .catch(() => {
        setEarlierByRoom((previous) => {
          const map = new Map(previous)
          map.set(webRid, { loading: false, done: false })
          return map
        })
      })
  }, [activeRoom, itemsByRoom])

  const toggleMonitor = useCallback((webRid: string, on: boolean): void => {
    void api.roomMonitor(webRid, on)
  }, [])

  const monitorAll = useCallback((on: boolean): void => {
    setBusy(true)
    void api.roomMonitorAll(on).finally(() => setBusy(false))
  }, [])

  const refreshRoom = useCallback((webRid: string): void => {
    void api.roomRefresh(webRid)
  }, [])

  const removeRoom = useCallback(
    (webRid: string, purge: boolean): void => {
      const room = rooms.find((entry) => entry.webRid === webRid)
      Modal.confirm({
        ...formModalProps,
        title: t('douyin-link.page.removeConfirmTitle', { room: room ? roomLabel(room) : webRid }),
        content: purge ? t('douyin-link.page.removeConfirmData') : t('douyin-link.page.removeConfirmKeep'),
        okText: t('douyin-link.page.remove'),
        okButtonProps: { danger: true },
        cancelText: t('douyin-link.page.cancel'),
        onOk: () => {
          void api.roomRemove(webRid, purge).then(() => reload())
        }
      })
    },
    [reload, rooms, t]
  )

  const clearRoomMessages = useCallback(
    (webRid: string): void => {
      Modal.confirm({
        ...formModalProps,
        title: t('douyin-link.page.clearConfirmTitle'),
        content: t('douyin-link.page.clearConfirmBody'),
        okText: t('douyin-link.page.clearRoomMessages'),
        okButtonProps: { danger: true },
        cancelText: t('douyin-link.page.cancel'),
        onOk: () => {
          void api.messagesClear(webRid).then(() => {
            void api.recentClear(webRid)
            setItemsByRoom((previous) => {
              const map = new Map(previous)
              map.set(webRid, [])
              return map
            })
            return reload()
          })
        }
      })
    },
    [reload, t]
  )

  /* ------------------------------------------------------------- 渲染 */

  const phaseTag = active ? <Tag color={phaseColor(active)}>{phaseText(t, active)}</Tag> : null

  /*
   * 「本场」统计（弹幕 / 进场 / 关注 / 点赞）挂在**房间标题行**上：
   * 它是这个房间当前的运行数字，五个页签都该看得见，不该只住在实时页签的正文里。
   * 字段逐个兜底 —— 主进程刚起来时 counters 可能还没填全，缺个字段不该让整页崩。
   */
  const counters = active?.counters ?? null
  const sessionLine = counters
    ? t('douyin-link.page.interactions', {
        chat: counters.chat ?? 0,
        enter: counters.enter ?? 0,
        follow: counters.follow ?? 0,
        like: counters.like ?? 0,
        gift: counters.gift ?? 0
      })
    : ''

  /**
   * 页签清单：**胶囊条与页签容器共用同一份**（`items` 与 antd 的 `items` 同形）。
   * 胶囊条住在房间头的统计行右端（见 RoomHeader 的 `tabBar`），容器占满剩下的高度。
   */
  const roomTabItems: PillTabItem[] = [
    {
      key: 'overview',
      label: t('douyin-link.page.tabOverview'),
      children: (
        <Pane>
          <OverviewPanel
            room={active}
            minutes={OVERVIEW_MINUTES}
            range={effectiveRange}
            onRange={changeRange}
            bounds={dayBounds}
            onOpenGifts={(target) => setOpenGifts(target)}
            onOpenUser={setOpenUser}
          />
        </Pane>
      )
    },
    {
      key: 'live',
      label: t('douyin-link.page.tabLive'),
      children: (
        <Pane>
          <Panel
            className="h-full"
            title={t('douyin-link.page.tabLive')}
            extra={
              <div className="flex items-center gap-2">
                <span className="text-xs opacity-60">
                  {t('douyin-link.page.danmakuCount', { count: items.length })}
                </span>
                <Button
                  size="small"
                  type="text"
                  icon={<RiTeamLine size={13} />}
                  onClick={() => setTab('users')}
                >
                  {t('douyin-link.page.usersButton', { count: active?.stored.users ?? users.size })}
                </Button>
                <Button
                  size="small"
                  type="text"
                  icon={<RiDeleteBin6Line size={13} />}
                  onClick={() => {
                    if (!activeRoom) return
                    setItemsByRoom((previous) => {
                      const map = new Map(previous)
                      map.set(activeRoom, [])
                      return map
                    })
                    void api.recentClear(activeRoom)
                  }}
                >
                  {t('douyin-link.page.clear')}
                </Button>
              </div>
            }
          >
            <div className="flex min-h-0 flex-1 flex-col gap-1">
              {active?.danmaku.failure ? <FailureLine failure={active.danmaku.failure} /> : null}
              <DanmakuFeed
                webRid={activeRoom}
                items={items}
                kinds={settings?.kinds ?? ['chat', 'member', 'like', 'social', 'gift', 'stats', 'control']}
                autoScroll={settings?.autoScroll ?? true}
                users={users}
                onOpenUser={setOpenUser}
                onLoadEarlier={loadEarlier}
                loadingEarlier={earlierByRoom.get(activeRoom)?.loading ?? false}
                earlierDone={earlierByRoom.get(activeRoom)?.done ?? false}
              />
            </div>
          </Panel>
        </Pane>
      )
    },
    {
      key: 'presence',
      label: t('douyin-link.page.tabPresence'),
      children: (
        <Pane>
          <PresencePanel room={active} reloadKey={usersReloadKey} onOpenUser={setOpenUser} />
        </Pane>
      )
    },
    {
      key: 'users',
      label: t('douyin-link.page.tabUsers'),
      children: (
        <Pane>
          <UsersPanel room={active} onOpenUser={setOpenUser} />
        </Pane>
      )
    }
  ]

  /**
   * 数据大屏的页签：全局分析（跨房聚合）/ 检索 / 对比。
   *
   * 「检索」「对比」从单房间视图**抽离**到这里——它们本来就是跨房间的，
   * 不依赖「分析中的房间」；放在数据大屏里，单房间视图只剩跟这个房间强相关的页签。
   */
  const dashboardTabItems: PillTabItem[] = [
    {
      key: 'all',
      label: t('douyin-link.page.tabAll'),
      children: (
        <Pane>
          <AllRoomsPanel
            range={dashboardRange}
            onSelectRoom={openRoom}
            onOpenGifts={(target) => setOpenGifts(target)}
            onOpenUser={setOpenUser}
          />
        </Pane>
      )
    },
    {
      // 「指标」：把每个直播间**拆开并排**，看「谁的抖币收入涨得快 / 什么时段最集中」
      // （动态排序柱状图、日内走势、收入排行、按小时分布）——与「全局分析」的「合起来看」互补。
      key: 'metrics',
      label: t('douyin-link.page.tabMetrics'),
      children: (
        <Pane>
          <MetricsPanel range={dashboardRange} onSelectRoom={openRoom} />
        </Pane>
      )
    },
    {
      key: 'search',
      label: t('douyin-link.page.tabSearch'),
      children: (
        <Pane>
          <SearchPanel rooms={rooms} activeRoom="" />
        </Pane>
      )
    }
  ]

  /** 当前模式下的页签（胶囊条与容器共用） */
  const activeTabItems = mode === 'room' ? roomTabItems : dashboardTabItems

  return (
    /* 页头整条去掉了：标题与「数据库：… / 声音状态」都由宿主界面和下面的面板给出了，
       这里不再重复一行。PageShell 的 header 省略即可（顶栏高度随之收掉）。 */
    <PageShell>
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {/*
         * 顶部工具条：两个模式共用同一条，且**模式切换、内容页签、右侧状态都在同一行**。
         *
         * 为什么（用户 2026-10-10）：「直播间与数据大屏的切换不够丝滑，因为两者的位置不一致」，
         * 以及「下面的 tab 独立一行真丑」——所以模式切换（左）与内容页签（紧挨着）并排，
         * 右侧只放跟当前模式相关的控件（直播间 = 本场数字 + 相位；大屏 = 时间区间）。
         * 一行放不下时靠 `flex-wrap` 换行，不再固定占两行。
         */}
        <Panel className="shrink-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <Segmented
              size="small"
              value={mode}
              onChange={(value) => changeMode(value as ViewMode)}
              options={[
                { value: 'room', label: t('douyin-link.page.modeRoom') },
                { value: 'dashboard', label: t('douyin-link.page.modeDashboard') }
              ]}
            />
            <div className="flex items-center">
              <PillTabBar items={activeTabItems} activeKey={tab} onChange={(key) => setTab(key as TabKey)} />
            </div>
            <div className="ml-auto flex min-w-0 items-center gap-2">
              {mode === 'room' ? (
                <>
                  {sessionLine ? (
                    /* 数字长了就截断（原生 title 兜住全文），不能把右侧控件挤没了 */
                    <span
                      className="truncate text-xs opacity-60"
                      style={{ maxWidth: 'min(560px, 52vw)' }}
                      title={sessionLine}
                    >
                      {sessionLine}
                    </span>
                  ) : null}
                  {phaseTag}
                </>
              ) : (
                <>
                  <span className="truncate text-xs opacity-60">{t('douyin-link.page.dashboardHint')}</span>
                  {/* 时间区间：自己选一段（默认「今天」）——见 dashRange 的注释 */}
                  <DatePicker.RangePicker
                    size="small"
                    allowClear={false}
                    value={dashRange}
                    onChange={(next) => {
                      if (next && next[0] && next[1]) setDashRange([next[0], next[1]])
                    }}
                    placeholder={[t('douyin-link.page.rangeFrom'), t('douyin-link.page.rangeTo')]}
                  />
                </>
              )}
            </div>
          </div>
        </Panel>

        {/*
         * 主体：直播间 = 左栏房间清单 + 右栏详情；数据大屏 = 全宽。
         * `key={mode}` 让切换时**重放一次淡入动画**（模式一变内容本来就整体替换，所以不会额外丢状态）。
         */}
        <div
          key={mode}
          className="grid min-h-0 flex-1 grid-cols-12 grid-rows-1 gap-3"
          style={{ animation: 'rb-mode-in .18s ease' }}
        >
          {mode === 'room' ? (
            <div className="col-span-3 flex min-h-0 flex-col gap-3">
              <RoomRail
                rooms={rooms}
                activeRoom={activeRoom}
                busy={busy}
                onAdd={(input) => void addRoom(input)}
                onSelect={selectRoom}
                onToggleMonitor={toggleMonitor}
                onMonitorAll={monitorAll}
                onRefresh={refreshRoom}
                onRemove={removeRoom}
                onClearMessages={clearRoomMessages}
              />
              {addFailure ? <FailureLine failure={addFailure} /> : null}
              {/* 「每日记录」是某个房间的当天记录：选中了房间才出现 */}
              {activeRoom ? (
                <DayRail days={days} selected={daySel} loading={daysLoading} onPick={pickDay} />
              ) : null}
            </div>
          ) : null}

          <div
            className={
              mode === 'room' ? 'col-span-9 flex min-h-0 flex-col gap-3' : 'col-span-12 flex min-h-0 flex-col gap-3'
            }
          >
            {mode === 'room' ? (
              <Panel className="shrink-0">
                <RoomHeader room={active} t={t} />
              </Panel>
            ) : null}
            <PillTabsBody activeKey={tab} onChange={(key) => setTab(key as TabKey)} items={activeTabItems} />
          </div>
        </div>
      </div>

      {/* 模式切换动画的关键帧（见 MODE_SWITCH_CSS） */}
      <style>{MODE_SWITCH_CSS}</style>

      {/* 用户档案：礼物榜点名字、在线观众点一行、弹幕点昵称都走这里。
          大屏模式下可能没有「当前房间」（`activeRoom` 为空串），此时档案按跨房间查（mapper 支持空 webRid）。 */}
      {openUser ? (
        <UserProfileModal
          webRid={activeRoom}
          userId={openUser}
          rooms={rooms}
          onClose={() => setOpenUser('')}
        />
      ) : null}

      {/* 礼物榜点开的历史（他送的 / 他收到的）：与榜单同一段范围——今天就是今天，不翻旧账。
          数据大屏里的榜单是跨房间的，所以 webRid 传空串（走跨房查询），也不再要求选中房间。 */}
      {openGifts ? (
        <GiftHistoryModal
          webRid={mode === 'room' ? activeRoom : ''}
          userId={openGifts.userId}
          name={openGifts.name}
          direction={openGifts.direction}
          range={mode === 'room' ? effectiveRange : dashboardRange}
          onClose={() => setOpenGifts(null)}
        />
      ) : null}
    </PageShell>
  )
}

/**
 * 房间头：**只有这个房间的信息行**。
 *
 * 页面头部原来还有「房间名」标题与本场数字，现在**都挪到了顶部的共用工具条**
 * （见渲染里那段说明：为了让「直播间 / 数据大屏」切换时控件不跳位）——
 * 房间名由左栏的选中态表达，这里只留主播 / 在线 / 状态 / 房间号 / 库里累计与速率。
 *
 * 历史（用户 2026-10-08）：「移除播放音频内容，以及监控开关，移除上面图片的内容」——
 * 那条工具行（监控开关 / 播放 / 清晰度 / 音量 / 刷新）整条去掉了：开关在左栏房间行上，
 * 音频与播放整体下线（这是采集分析用的，不出声），刷新在房间行的「⋯」菜单里。
 */
function RoomHeader(props: { room: RoomRuntime | null; t: Translate }): React.JSX.Element {
  const { room, t } = props
  if (!room) {
    return <span className="text-xs opacity-50">{t('douyin-link.page.emptyRooms')}</span>
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs opacity-70">
        <span className="min-w-0 truncate">
          {t('douyin-link.page.anchor')}：{cleanName(room.anchor) || '-'}
        </span>
        <span>
          {t('douyin-link.page.online')}：{room.onlineText || '-'}
        </span>
        <span>
          {room.status === 'live'
            ? t('douyin-link.page.liveOn')
            : room.status === 'ended'
              ? t('douyin-link.page.liveOff')
              : t('douyin-link.page.liveUnknown')}
        </span>
        <span>{room.webRid}</span>
        {cleanName(room.note) ? <span className="min-w-0 truncate">· {cleanName(room.note)}</span> : null}
        <span>
          {t('douyin-link.page.storedLine', {
            messages: formatNumber(room.stored.messages),
            users: formatNumber(room.stored.users),
            sessions: formatNumber(room.stored.sessions)
          })}
        </span>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] opacity-60">
        <span>
          {t('douyin-link.page.rate', { rate: room.rate })} ·{' '}
          {t('douyin-link.page.sessionUsers', { count: room.sessionUsers })} ·{' '}
          {t('douyin-link.page.sessionReceived', { count: room.received })}
        </span>
        {room.failure ? <FailureLine failure={room.failure} /> : null}
      </div>
    </div>
  )
}

/**
 * 用户档案弹窗：**库里的累计数字**（本场数字在房间标题行上）+ **这个人发过的历史弹幕**。
 *
 * 版式（用户反馈「档案太丑、内容一行一行的」）：账号与时间并成点号短句、互动统计用 KPI
 * 小方块，不再一条明细占一行——原来光这两段就是 11 行，现在两行短句 + 一排方块。
 *
 * 历史弹幕（`UserHistory`）摆在档案分支**外面**：用户记录被「清空用户记录」清掉之后，
 * 档案查不到了，但消息流水还在——那种时候照样能翻出他说过什么，比一个「没有档案」的空框有用。
 *
 * 版式（用户 2026-10-10）：**没有页脚**（「关闭」与右上角 × 重复）+ 点「分析」后**右栏出画像**，
 * 两栏等高、各自滚（细滚动条）。见下方 `splitModalProps` 那段注释。
 */
function UserProfileModal(props: {
  webRid: string
  userId: string
  rooms: RoomRuntime[]
  onClose: () => void
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const palette = usePluginPalette()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(false)
  /** 「查看神秘人信息」的结果（null = 还没查过；点了按钮才查） */
  const [reveal, setReveal] = useState<MysteryReveal | null>(null)
  const [revealing, setRevealing] = useState(false)
  /** 「分析用户」的画像结果（null = 还没点过；按钮在名字行、荣誉等级旁边） */
  const [analysis, setAnalysis] = useState<UserAnalysis | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  /** 分析失败（主进程没回话）：只给一句提示，不留半截结果 */
  const [analyzeError, setAnalyzeError] = useState(false)
  /** 点过「分析」之后弹窗右侧多一栏画像，弹窗跟着变宽（没点就保持原来的窄弹窗） */
  const splitOpen = Boolean(analysis || analyzeError)

  /**
   * 能不能「查看真实资料」：只要有**可查的用户 id**（数字串）就放出来——不再猜谁「算匿名」。
   * 唯一的例外是抖音的匿名**占位 id `111111`**：帧里的 id/抖音号/secUid 全是它，真实账号标识被抹掉，
   * 拿它查一定 `notFound`（2026-10-09 批量抓帧实测），所以不给按钮、改成一句如实说明。
   */
  const revealable =
    !loading && /^\d{4,}$/.test(props.userId) && !isAnonymousId(props.userId)
  /** 这条档案就是那个共用占位 id：真实身份在数据里不可还原 */
  const anonymousOnly = !loading && isAnonymousId(props.userId)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setReveal(null)
    setAnalysis(null)
    setAnalyzeError(false)
    void api
      .userGet(props.webRid, props.userId)
      .then((next) => {
        if (alive) setProfile(next)
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [props.webRid, props.userId])

  const doReveal = useCallback((): void => {
    setRevealing(true)
    void api
      .revealMystery(props.userId)
      .then((result) => setReveal(result ?? { ok: false, code: 'network' }))
      .catch(() => setReveal({ ok: false, code: 'network' }))
      .finally(() => setRevealing(false))
  }, [props.userId])

  /**
   * 「分析用户」：把库里的数据交给主进程的**确定性规则算法**（RFM + Bartle 原型 + 情感词典 + …）
   * 生成画像——不依赖大模型、不需要人工处理，同一份数据结论一致（见 `main/analysis/portrait.ts`）。
   *
   * **跨全部直播间**（只传 userId，见用户 2026-10-10 的要求）：得到的是「这个人在这个平台的画像」，
   * 所以换个房间看同一个人，画像不会变。
   */
  const doAnalyze = useCallback((): void => {
    setAnalyzing(true)
    setAnalyzeError(false)
    void api
      .userAnalysis(props.userId)
      .then((result) => {
        if (result) setAnalysis(result)
        else setAnalyzeError(true)
      })
      .catch(() => setAnalyzeError(true))
      .finally(() => setAnalyzing(false))
  }, [props.userId])

  /**
   * 两栏版式：左栏是档案与历史，右栏是点了「分析」才出现的画像。
   * 两个决定（用户 2026-10-10）：
   * 1. **页脚不再放按钮**——原来的「关闭」与右上角的 × 重复，去掉后正文还能多出一行高度；
   * 2. 点过分析后弹窗**变宽**（右栏 336px 需要地方），两栏由 `splitModalProps` 保证等高、各自滚。
   */
  return (
    <Modal
      {...splitModalProps}
      open={Boolean(props.userId)}
      title={t('douyin-link.users.detailTitle')}
      onCancel={props.onClose}
      footer={null}
      width={splitOpen ? 892 : undefined}
    >
      <ScrollStyle />
      {/* 左栏：档案 + 互动统计 + 神秘人还原 + 历史弹幕。自己滚，跟右栏同高（超出才出滚动条） */}
      <div data-rb-scroll="" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
        {!profile ? (
          <span className="text-xs opacity-60">
            {loading ? t('douyin-link.users.loading') : t('douyin-link.users.missing')}
          </span>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <UserAvatar webRid={props.webRid} userId={profile.id} nickname={profile.nickname} size={48} />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                {/* 荣誉等级 / 粉丝团 / 「分析用户」都跟在名字这一行的**最右端**
                    （原来荣誉等级单独占一行，把名字行也拉长了；分析按钮原在页脚，现在收进图标） */}
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-semibold">
                    {profile.nickname || t('douyin-link.page.unknownUser')}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    {profile.honorLevel > 0 ? (
                      <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                        {t('douyin-link.users.honor')} {profile.honorLevel}
                      </Tag>
                    ) : null}
                    {profile.fansClubLevel > 0 ? (
                      <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                        {t('douyin-link.users.fansClub')} {profile.fansClubLevel}
                      </Tag>
                    ) : null}
                    {/* 只用图标：文案进 title / aria-label，鼠标悬停可见、读屏可读；
                        分析中 antd 会把图标换成转圈，不需要再来一套「分析中…」文案 */}
                    <Button
                      size="small"
                      type="text"
                      loading={analyzing}
                      title={t('douyin-link.users.analyzeButton')}
                      aria-label={t('douyin-link.users.analyzeButton')}
                      icon={<RiRadarLine size={15} />}
                      onClick={doAnalyze}
                    />
                  </span>
                </div>
                <span className="flex flex-wrap items-center gap-1 text-xs opacity-70">
                  <span>
                    {t('douyin-link.users.displayId')} {profile.displayId || '-'}
                  </span>
                  <span>·</span>
                  <span>
                    {t('douyin-link.users.gender')} {genderText(t, profile.gender)}
                  </span>
                  {profile.city ? (
                    <>
                      <span>·</span>
                      <span>{profile.city}</span>
                    </>
                  ) : null}
                </span>
              </div>
            </div>

            {profile.signature ? (
              <div className="rounded-md px-2 py-1.5 text-xs" style={{ backgroundColor: palette.soft }}>
                {profile.signature}
              </div>
            ) : null}

            {/* 账号与时间：并成两行点号短句（原来一条明细占一行，光这里就是六行） */}
            <div className="flex flex-col gap-1">
              <FactLine
                items={[
                  `${t('douyin-link.users.following')} ${profile.following > 0 ? formatNumber(profile.following) : '-'}`,
                  `${t('douyin-link.users.follower')} ${profile.follower > 0 ? formatNumber(profile.follower) : '-'}`,
                  `${t('douyin-link.users.userId')} ${profile.id}`
                ]}
              />
              <FactLine
                items={[
                  `${t('douyin-link.users.firstSeen')} ${stamp(profile.firstSeen)}`,
                  `${t('douyin-link.users.lastSeen')} ${stamp(profile.lastSeen)}`,
                  `${t('douyin-link.users.span')} ${duration(profile.lastSeen - profile.firstSeen)}`
                ]}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium">{t('douyin-link.users.statsTitle')}</span>
              {/* 数字排成与概览页 KPI 同款的软底小方块：一行五格，扫一眼就有量级感 */}
              <div className="grid grid-cols-5 gap-1.5">
                <StatBlock label={t('douyin-link.kinds.chat')} value={formatNumber(profile.stats.chat)} palette={palette} />
                <StatBlock label={t('douyin-link.kinds.member')} value={formatNumber(profile.stats.enter)} palette={palette} />
                <StatBlock label={t('douyin-link.kinds.like')} value={formatNumber(profile.stats.like)} palette={palette} />
                <StatBlock label={t('douyin-link.kinds.social')} value={formatNumber(profile.stats.follow)} palette={palette} />
                <StatBlock
                  label={t('douyin-link.page.kpiDiamonds')}
                  value={formatNumber(profile.stats.diamonds)}
                  palette={palette}
                />
              </div>
              <span className="text-[10px] opacity-50">{t('douyin-link.users.statsHint')}</span>
            </div>
          </>
        )}

        {/* 神秘人还原：**不挂在档案分支里** —— 纯匿名的送礼人往往连档案都没有，只剩一个 id，
            这种时候也要能查看（用户 2026-10-09：「如果是神秘人，增加一个按钮可以查看其信息」） */}
        {revealable ? (
          <div className="flex flex-col gap-2 rounded-md px-2.5 py-2" style={{ backgroundColor: palette.soft }}>
            {reveal && reveal.ok ? (
              <RevealedIdentity profile={reveal.profile} palette={palette} t={t} />
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <RiUserSearchLine size={14} style={{ color: palette.warn, flexShrink: 0 }} />
                  <span className="min-w-0 flex-1 text-xs opacity-80">{t('douyin-link.users.revealSecret')}</span>
                  <Button size="small" type="primary" loading={revealing} onClick={doReveal}>
                    {revealing ? t('douyin-link.users.revealLoading') : t('douyin-link.users.revealButton')}
                  </Button>
                </div>
                {reveal && !reveal.ok ? (
                  <span className="text-xs" style={{ color: palette.down }}>
                    {revealErrorText(t, reveal.code)}
                  </span>
                ) : null}
              </>
            )}
          </div>
        ) : anonymousOnly ? (
          /* 抖音的匿名占位 id（111111）：帧里的 id/抖音号/secUid 全被抹平，没有可查的账号标识——
             与其给一个点了必然失败的按钮，不如把话说明白（本插件的纪律：宁可没有，不给错的）。 */
          <div className="flex items-start gap-2 rounded-md px-2.5 py-2" style={{ backgroundColor: palette.soft }}>
            <RiUserSearchLine size={14} style={{ color: palette.warn, flexShrink: 0, marginTop: 1 }} />
            <span className="min-w-0 flex-1 text-xs opacity-70">{t('douyin-link.users.revealAnonymousOnly')}</span>
          </div>
        ) : null}

        {/* 这个人说过什么：**不挂在档案分支里** —— 用户记录被清掉后档案查不到，但消息流水还在 */}
        <UserHistory webRid={props.webRid} userId={props.userId} rooms={props.rooms} />
      </div>

      {/* 右栏：用户画像。**不挂在档案分支里** —— 画像用的是消息流水里的互动数据，
          就算档案被清空也能成画（跟历史弹幕一个道理）；没点过「分析」就不占位、也不撑宽弹窗 */}
      {splitOpen ? (
        <div data-rb-scroll="" className="flex w-[336px] shrink-0 flex-col gap-2 overflow-y-auto pr-1">
          {analyzeError ? (
            <span className="text-xs" style={{ color: palette.down }}>
              {t('douyin-link.users.analyzeFailed')}
            </span>
          ) : null}
          {analysis ? <UserAnalysisPanel analysis={analysis} palette={palette} t={t} /> : null}
        </div>
      ) : null}
    </Modal>
  )
}

/** 点号短句：一串「标签 值」排成一行，值之间用「·」隔开（档案的账号/时间信息） */
function FactLine(props: { items: string[] }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs opacity-70">
      {props.items.map((item, index) => (
        <Fragment key={index}>
          {index > 0 ? <span>·</span> : null}
          <span className="min-w-0 truncate" title={item}>
            {item}
          </span>
        </Fragment>
      ))}
    </div>
  )
}

/** 档案里的统计小方块：与概览页 KPI 同款软底（label 灰、数字加粗、可选提示/强调色） */
function StatBlock(props: {
  label: string
  value: string
  hint?: string
  accent?: string
  palette: PluginPalette
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col rounded-md px-1.5 py-1" style={{ backgroundColor: props.palette.soft }}>
      <span className="truncate text-[10px] opacity-60">{props.label}</span>
      <span className="truncate text-sm font-semibold leading-5" style={{ color: props.accent }}>
        {props.value}
      </span>
      {props.hint ? <span className="truncate text-[10px] opacity-50">{props.hint}</span> : null}
    </div>
  )
}

/** 机器键 → i18n 键后缀：首字母大写（`spending` → `Spending`、`bigSpender` → `BigSpender`） */
function cap(key: string): string {
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : ''
}

/** 距最近出现：刚刚 / N 分钟前 / N 小时前 / N 天前（`hours` 是小时数） */
function recencyText(t: Translate, hours: number): string {
  if (hours < 1 / 60) return t('douyin-link.users.analyzeRecencyNow')
  if (hours < 1) return t('douyin-link.users.analyzeRecencyMinutesAgo', { n: Math.max(1, Math.round(hours * 60)) })
  if (hours < 48) return t('douyin-link.users.analyzeRecencyHoursAgo', { n: Math.round(hours) })
  return t('douyin-link.users.analyzeRecencyDaysAgo', { n: Math.round(hours / 24) })
}

/** 情感倾向：积极 / 中性 / 消极（带符号分值） */
function sentimentText(t: Translate, sentiment: number): string {
  if (sentiment >= 20) return t('douyin-link.users.analyzeSentimentPositive', { n: sentiment })
  if (sentiment <= -20) return t('douyin-link.users.analyzeSentimentNegative', { n: sentiment })
  return t('douyin-link.users.analyzeSentimentNeutral')
}

/** 情绪唤起度：平静 / 适中 / 高能（`value` 是 0-100） */
function arousalText(t: Translate, value: number): string {
  if (value < 25) return t('douyin-link.users.analyzeArousalCalm')
  if (value < 60) return t('douyin-link.users.analyzeArousalMedium')
  return t('douyin-link.users.analyzeArousalHigh')
}

/** 六维特征条：软底进度条 + 分值（宽度 = 分值，颜色走插件主题色，不做褒贬暗示） */
function TraitBar(props: { label: string; score: number; palette: PluginPalette; suffix?: string }): React.JSX.Element {
  const score = Math.max(0, Math.min(100, props.score))
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 truncate text-[10px] opacity-70">{props.label}</span>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full" style={{ backgroundColor: props.palette.border }}>
        <span className="block h-full rounded-full" style={{ width: `${score}%`, backgroundColor: props.palette.accent }} />
      </span>
      <span className="w-9 shrink-0 text-right text-[10px] tabular-nums opacity-70">
        {score}
        {props.suffix ?? ''}
      </span>
    </div>
  )
}

/** 区块小标题（画像面板里各段统一用） */
function SectionTitle(props: { label: string; hint?: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs font-medium">{props.label}</span>
      {props.hint ? <span className="truncate text-[10px] opacity-50">{props.hint}</span> : null}
    </div>
  )
}

/** 长名字截断（SVG 里没有 CSS truncate，只好自己切） */
function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 送礼时段分布：24 根迷你柱（无数据的时段淡显，峰值最高拉满） */
function GiftHourStrip(props: { hours: number[]; palette: PluginPalette }): React.JSX.Element {
  const hours = props.hours.length === 24 ? props.hours : new Array(24).fill(0)
  const max = Math.max(1, ...hours)
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-end gap-[2px]" style={{ height: 26 }}>
        {hours.map((value, hour) => (
          <span
            key={hour}
            className="min-h-[2px] min-w-0 flex-1 rounded-sm"
            title={`${String(hour).padStart(2, '0')}:00 · ${value}`}
            style={{
              height: `${Math.max(4, (value / max) * 100)}%`,
              backgroundColor: props.palette.accent,
              opacity: value > 0 ? 0.85 : 0.15
            }}
          />
        ))}
      </div>
      <span className="flex justify-between text-[9px] leading-3 opacity-40">
        <span>0</span>
        <span>6</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </span>
    </div>
  )
}

/** 关系排行的一行：昵称 + 占比条 + 数值（送礼习惯/关系网共用） */
function PeerBar(props: { name: string; value: string; share: number; palette: PluginPalette }): React.JSX.Element {
  const share = Math.max(0, Math.min(100, props.share))
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 truncate text-[10px] opacity-80" title={props.name}>
        {props.name}
      </span>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full" style={{ backgroundColor: props.palette.border }}>
        <span className="block h-full rounded-full" style={{ width: `${share}%`, backgroundColor: props.palette.accent }} />
      </span>
      <span className="shrink-0 text-[10px] tabular-nums opacity-70">{props.value}</span>
    </div>
  )
}

/** 关系网图里单侧最多画几个节点（更多的看下面的排行列表） */
const NETWORK_MAX_NODES = 5

/**
 * 人物关系网（一跳）：中间是本人，左边画「本人送出的对象」，右边画「送礼给本人的人」。
 *
 * 手写 SVG 而不是上 ECharts 的 graph：这里的关系是**确定的一跳星形**，没有布局算法要跑，
 * 手写能精确控制节点半径/连线粗细与「占比」的对应关系，也不用为一个小组件再拉一份图表依赖。
 */
function RelationshipGraph(props: {
  analysis: UserAnalysis
  palette: PluginPalette
  t: Translate
}): React.JSX.Element | null {
  const { analysis, palette, t } = props
  const outgoing = analysis.network.outgoing.slice(0, NETWORK_MAX_NODES)
  const incoming = analysis.network.incoming.slice(0, NETWORK_MAX_NODES)
  if (outgoing.length === 0 && incoming.length === 0) return null

  const centerX = 150
  const leftX = 96
  const rightX = 204
  const rows = Math.max(outgoing.length, incoming.length, 1)
  const height = rows * 30 + 34
  const centerY = height / 2
  const yOf = (index: number, count: number): number => {
    if (count <= 1) return centerY
    const top = 16
    const span = height - 32
    return top + (span * index) / (count - 1)
  }
  const radiusOf = (share: number): number => 5 + (7 * Math.max(0, Math.min(100, share))) / 100
  const widthOf = (share: number): number => 1 + (4 * Math.max(0, Math.min(100, share))) / 100
  const weightText = (peer: UserAnalysis['network']['outgoing'][number]): string =>
    peer.diamonds > 0 ? formatNumber(peer.diamonds) : `${formatNumber(peer.items)} ${t('douyin-link.users.analyzeGiftItem')}`

  return (
    <div className="flex flex-col gap-1">
      <svg viewBox={`0 0 300 ${height}`} className="w-full" style={{ height }} role="img">
        {outgoing.map((peer, index) => (
          <line
            key={`oe-${peer.userId}`}
            x1={centerX}
            y1={centerY}
            x2={leftX}
            y2={yOf(index, outgoing.length)}
            stroke={palette.accent}
            strokeWidth={widthOf(peer.share)}
            strokeOpacity={0.4}
            strokeLinecap="round"
          />
        ))}
        {incoming.map((peer, index) => (
          <line
            key={`ie-${peer.userId}`}
            x1={centerX}
            y1={centerY}
            x2={rightX}
            y2={yOf(index, incoming.length)}
            stroke={palette.up}
            strokeWidth={widthOf(peer.share)}
            strokeOpacity={0.4}
            strokeLinecap="round"
          />
        ))}
        {outgoing.map((peer, index) => {
          const y = yOf(index, outgoing.length)
          const r = radiusOf(peer.share)
          return (
            <g key={`on-${peer.userId}`}>
              <circle cx={leftX} cy={y} r={r} fill={palette.soft} stroke={palette.accent} strokeWidth={1.2} />
              <text x={leftX - r - 5} y={y + 3} textAnchor="end" fontSize={9} fill="currentColor" opacity={0.8}>
                {shorten(peer.name, 6)}
              </text>
            </g>
          )
        })}
        {incoming.map((peer, index) => {
          const y = yOf(index, incoming.length)
          const r = radiusOf(peer.share)
          return (
            <g key={`in-${peer.userId}`}>
              <circle cx={rightX} cy={y} r={r} fill={palette.soft} stroke={palette.up} strokeWidth={1.2} />
              <text x={rightX + r + 5} y={y + 3} textAnchor="start" fontSize={9} fill="currentColor" opacity={0.8}>
                {shorten(peer.name, 6)}
              </text>
            </g>
          )
        })}
        <circle cx={centerX} cy={centerY} r={15} fill={palette.soft} stroke={palette.accent} strokeWidth={1.5} />
        <text x={centerX} y={centerY + 3} textAnchor="middle" fontSize={9} fill="currentColor" opacity={0.9}>
          {t('douyin-link.users.analyzeNetworkSelf')}
        </text>
      </svg>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] opacity-60">
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-3 rounded-full" style={{ backgroundColor: palette.accent }} />
          {t('douyin-link.users.analyzeNetworkOut', { coins: formatNumber(analysis.network.outTotal) })}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-3 rounded-full" style={{ backgroundColor: palette.up }} />
          {t('douyin-link.users.analyzeNetworkIn', { coins: formatNumber(analysis.network.inTotal) })}
        </span>
      </div>
      {outgoing.length > 0 ? (
        <div className="flex flex-col gap-1">
          <SectionTitle label={t('douyin-link.users.analyzeNetworkFavorTitle')} />
          {analysis.network.outgoing.slice(0, NETWORK_MAX_NODES).map((peer) => (
            <PeerBar
              key={peer.userId}
              name={peer.name}
              value={weightText(peer)}
              share={peer.share}
              palette={palette}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 「分析用户」画像面板：主画像 + **互动结构**（五类互动全量）+ 大五人格 + 六维特征 +
 * 弹幕分析 + 送礼习惯 + 人物关系网 + 动机结构 + 标签 + 结论 + 量化事实 + 方法依据。
 *
 * 全部文案本地化：主进程只给机器键与数值参数（见 `shared/types.ts` 的 `UserAnalysis`），
 * 这里用 `cap` 把机器键拼成 `analysisBig5*` / `analysisTrait*` / `analysisChatTopic*` /
 * `analysisMotivation*` / `analysisArchetype*` / `analysisTag*` / `analysisInsight*` 键。
 */
function UserAnalysisPanel(props: {
  analysis: UserAnalysis
  palette: PluginPalette
  t: Translate
}): React.JSX.Element {
  const { analysis, palette, t } = props
  if (!analysis.hasData) {
    return (
      <div className="rounded-md px-2.5 py-2 text-xs opacity-70" style={{ backgroundColor: palette.soft }}>
        {t('douyin-link.users.analyzeEmpty')}
      </div>
    )
  }
  const facts = analysis.facts
  return (
    <div className="flex flex-col gap-2 rounded-md px-2.5 py-2" style={{ backgroundColor: palette.soft }}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">{t('douyin-link.users.analyzeTitle')}</span>
        {/* 画像跨全部直播间，跟上面「本房间累计」的档案不是一个口径，写明白免得对不上号 */}
        <span className="shrink-0 text-[10px] opacity-50">{t('douyin-link.users.analyzeScopeHint')}</span>
        <span className="ml-auto shrink-0 text-sm font-semibold" style={{ color: palette.accent }}>
          {t(`douyin-link.users.analysisArchetype${cap(analysis.archetype)}`)}
        </span>
        <span className="shrink-0 text-[10px] opacity-60">
          {t('douyin-link.users.analyzeConfidence')} {analysis.confidence}%
        </span>
      </div>
      <span className="text-[11px] leading-4 opacity-70">
        {t(`douyin-link.users.analysisArchetype${cap(analysis.archetype)}Desc`)}
      </span>

      {/* 互动结构：五类互动全量摊开（弹幕 / 进场 / 点赞 / 关注 / 礼物）+ 场次 / 停留 / 关注转化。
          只看弹幕会漏掉「只看不说」「疯狂点赞」「反复打卡」这几类最典型的观众 */}
      <div className="flex flex-col gap-1">
        <SectionTitle label={t('douyin-link.users.analyzeBehaviorTitle')} />
        <div className="flex flex-col gap-1">
          {/* 只画真正发生过的互动类型：全是 0% 的空条只是噪声（占比会四舍五入，所以按 score 过滤） */}
          {analysis.behavior.kinds
            .filter((item) => item.score > 0)
            .map((item) => (
              <TraitBar
                key={item.key}
                label={t(`douyin-link.kinds.${item.key}`)}
                score={item.score}
                palette={palette}
                suffix="%"
              />
            ))}
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <StatBlock
            label={t('douyin-link.users.analyzeBehaviorSessions')}
            value={`${formatNumber(analysis.behavior.sessions)} ${t('douyin-link.users.analyzeUnitSession')}`}
            palette={palette}
          />
          <StatBlock
            label={t('douyin-link.users.analyzeBehaviorStay')}
            value={
              analysis.behavior.avgStayMinutes > 0
                ? `${analysis.behavior.avgStayMinutes} ${t('douyin-link.users.analyzeUnitMinute')}`
                : '-'
            }
            hint={
              analysis.behavior.maxStayMinutes > 0
                ? `${t('douyin-link.users.analyzeBehaviorMaxStay')} ${analysis.behavior.maxStayMinutes}${t('douyin-link.users.analyzeUnitMinute')}`
                : undefined
            }
            palette={palette}
          />
          <StatBlock
            label={t('douyin-link.users.analyzeBehaviorPerSession')}
            value={String(analysis.behavior.perSession)}
            palette={palette}
          />
        </div>
        <FactLine
          items={[
            analysis.behavior.topKind
              ? `${t('douyin-link.users.analyzeBehaviorTop')} ${t(`douyin-link.kinds.${analysis.behavior.topKind}`)}`
              : '',
            `${t('douyin-link.users.analyzeBehaviorFollow')} ${
              analysis.behavior.followDays < 0
                ? t('douyin-link.users.analyzeBehaviorFollowNone')
                : t('douyin-link.users.analyzeBehaviorFollowDays', { n: analysis.behavior.followDays })
            }`
          ].filter((item) => item.length > 0)}
        />
      </div>

      {/* 大五人格（Big Five / OCEAN）：从行为数据做侧写，不是心理测量量表 */}
      <div className="flex flex-col gap-1">
        <SectionTitle
          label={t('douyin-link.users.analyzePersonalityTitle')}
          hint={t('douyin-link.users.analyzePersonalityHint')}
        />
        {analysis.personality.map((trait) => (
          <TraitBar
            key={trait.key}
            label={t(`douyin-link.users.analysisBig5${cap(trait.key)}`)}
            score={trait.score}
            palette={palette}
          />
        ))}
        {analysis.personalityTop ? (
          <span className="text-[11px] leading-4 opacity-70">
            {t('douyin-link.users.analyzePersonalityTop')}
            {t(`douyin-link.users.analysisBig5${cap(analysis.personalityTop)}Desc`)}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <SectionTitle label={t('douyin-link.users.analyzeTraitsTitle')} />
        {analysis.traits.map((trait) => (
          <TraitBar
            key={trait.key}
            label={t(`douyin-link.users.analysisTrait${cap(trait.key)}`)}
            score={trait.score}
            palette={palette}
          />
        ))}
      </div>

      {/* 弹幕文本分析：主题 + 情绪效价/唤起度 + 语言特征 + 高频词 */}
      <div className="flex flex-col gap-1">
        <SectionTitle label={t('douyin-link.users.analyzeChatTitle')} />
        {analysis.chat.sampleCount <= 0 ? (
          <span className="text-[11px] leading-4 opacity-60">{t('douyin-link.users.analyzeChatEmpty')}</span>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              <StatBlock
                label={t('douyin-link.users.analyzeChatValence')}
                value={sentimentText(t, analysis.chat.valence)}
                palette={palette}
              />
              <StatBlock
                label={t('douyin-link.users.analyzeChatArousal')}
                value={arousalText(t, analysis.chat.arousal)}
                palette={palette}
              />
            </div>
            {/* 7 大类情感构成（大连理工《情感词汇本体》的分类体系）：比分正负轴更细，
                能看出「他的情绪是乐/好，还是哀/怒」 */}
            {analysis.chat.emotions.some((item) => item.score > 0) ? (
              <div className="flex flex-col gap-1">
                <SectionTitle label={t('douyin-link.users.analyzeChatEmotionsTitle')} />
                {analysis.chat.emotions.map((item) => (
                  <TraitBar
                    key={item.key}
                    label={t(`douyin-link.users.analysisEmotion${cap(item.key)}`)}
                    score={item.score}
                    palette={palette}
                    suffix="%"
                  />
                ))}
              </div>
            ) : null}
            {analysis.chat.topics.length > 0 ? (
              <div className="flex flex-col gap-1">
                <SectionTitle label={t('douyin-link.users.analyzeChatTopicsTitle')} />
                {analysis.chat.topics.map((topic) => (
                  <TraitBar
                    key={topic.key}
                    label={t(`douyin-link.users.analysisChatTopic${cap(topic.key)}`)}
                    score={topic.score}
                    palette={palette}
                    suffix="%"
                  />
                ))}
              </div>
            ) : null}
            <FactLine
              items={[
                `${t('douyin-link.users.analyzeChatSample')} ${analysis.chat.sampleCount}`,
                `${t('douyin-link.users.analyzeChatEmoji')} ${analysis.chat.emojiRate}%`,
                `${t('douyin-link.users.analyzeChatMention')} ${analysis.chat.mentionRate}%`,
                `${t('douyin-link.users.analyzeChatAvgLength')} ${analysis.chat.avgLength}${t('douyin-link.users.analyzeUnitChar')}`,
                `${t('douyin-link.users.analyzeChatFeatureQuestion')} ${analysis.chat.questionRate}%`,
                `${t('douyin-link.users.analyzeChatFeatureExclaim')} ${analysis.chat.exclaimRate}%`,
                `${t('douyin-link.users.analyzeChatFeatureRepeat')} ${analysis.chat.repeatRate}%`
              ]}
            />
            {analysis.chat.keywords.length > 0 ? (
              <span className="flex flex-wrap items-center gap-1">
                <span className="shrink-0 text-[10px] opacity-60">{t('douyin-link.users.analyzeChatKeywordsTitle')}</span>
                {analysis.chat.keywords.map((word) => (
                  <span
                    key={word}
                    className="rounded-full px-2 py-0.5 text-[10px]"
                    style={{ border: `1px solid ${palette.border}` }}
                  >
                    {word}
                  </span>
                ))}
              </span>
            ) : null}
          </>
        )}
      </div>

      {/* 送礼习惯：把礼物流水按时间 / 种类 / 对象摊开 */}
      <div className="flex flex-col gap-1">
        <SectionTitle label={t('douyin-link.users.analyzeGiftingTitle')} />
        {facts.monetary <= 0 && analysis.gifting.giftDays <= 0 ? (
          <span className="text-[11px] leading-4 opacity-60">{t('douyin-link.users.analyzeGiftingEmpty')}</span>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-1.5">
              <StatBlock
                label={t('douyin-link.users.analyzeGiftingDays')}
                value={`${formatNumber(analysis.gifting.giftDays)} ${t('douyin-link.users.analyzeUnitDay')}`}
                palette={palette}
              />
              <StatBlock
                label={t('douyin-link.users.analyzeGiftingPerDay')}
                value={String(analysis.gifting.perDay)}
                palette={palette}
              />
              <StatBlock
                label={t('douyin-link.users.analyzeGiftingMax')}
                value={formatNumber(analysis.gifting.maxGift)}
                palette={palette}
              />
              <StatBlock
                label={t('douyin-link.users.analyzeGiftingPeak')}
                value={analysis.gifting.peakHour >= 0 ? `${String(analysis.gifting.peakHour).padStart(2, '0')}:00` : '-'}
                palette={palette}
              />
              <StatBlock
                label={t('douyin-link.users.analyzeGiftingSpan')}
                value={`${formatNumber(Math.round(analysis.gifting.spanDays))} ${t('douyin-link.users.analyzeUnitDay')}`}
                palette={palette}
              />
              <StatBlock
                label={t('douyin-link.users.analyzeGiftingTopKind')}
                value={`${analysis.gifting.topGiftShare}%`}
                palette={palette}
              />
            </div>
            <SectionTitle label={t('douyin-link.users.analyzeGiftingHoursTitle')} />
            <GiftHourStrip hours={analysis.gifting.hours} palette={palette} />
            <FactLine
              items={[
                `${t('douyin-link.users.analyzeGiftingTargets')} ${analysis.gifting.recipients}`,
                analysis.gifting.topRecipientName
                  ? `${t('douyin-link.users.analyzeGiftingFavorite')} ${analysis.gifting.topRecipientName} ${analysis.gifting.topRecipientShare}%`
                  : t('douyin-link.users.analyzeGiftingNoTarget')
              ]}
            />
          </>
        )}
      </div>

      {/* 人物关系网：以本人为中心的一跳图（左 = 送出，右 = 收到） */}
      <div className="flex flex-col gap-1">
        <SectionTitle label={t('douyin-link.users.analyzeNetworkTitle')} />
        {analysis.network.outgoing.length === 0 && analysis.network.incoming.length === 0 ? (
          <span className="text-[11px] leading-4 opacity-60">{t('douyin-link.users.analyzeNetworkEmpty')}</span>
        ) : (
          <RelationshipGraph analysis={analysis} palette={palette} t={t} />
        )}
      </div>

      {/* 动机结构（自我决定论 SDT）：解释「他为什么留在这里」 */}
      <div className="flex flex-col gap-1">
        <SectionTitle label={t('douyin-link.users.analyzeMotivationTitle')} />
        {analysis.motivations.map((item) => (
          <TraitBar
            key={item.key}
            label={t(`douyin-link.users.analysisMotivation${cap(item.key)}`)}
            score={item.score}
            palette={palette}
          />
        ))}
        {analysis.motivationTop ? (
          <span className="text-[11px] leading-4 opacity-70">
            {t('douyin-link.users.analyzeMotivationTop')}
            {t(`douyin-link.users.analysisMotivation${cap(analysis.motivationTop)}Desc`)}
          </span>
        ) : null}
      </div>

      {analysis.tags.length > 0 ? (
        <div className="flex flex-col gap-1">
          <SectionTitle label={t('douyin-link.users.analyzeTagsTitle')} />
          <span className="flex flex-wrap gap-1">
            {analysis.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full px-2 py-0.5 text-[10px]"
                style={{ border: `1px solid ${palette.border}` }}
              >
                {t(`douyin-link.users.analysisTag${cap(tag)}`)}
              </span>
            ))}
          </span>
        </div>
      ) : null}

      {analysis.insights.length > 0 ? (
        <div className="flex flex-col gap-1">
          <SectionTitle label={t('douyin-link.users.analyzeInsightsTitle')} />
          {analysis.insights.map((insight, index) => (
            <span key={`${insight.key}-${index}`} className="flex items-start gap-1 text-[11px] leading-4 opacity-80">
              <span style={{ color: palette.accent }}>•</span>
              <span className="min-w-0 flex-1">
                {t(`douyin-link.users.analysisInsight${cap(insight.key)}`, insight.params)}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <SectionTitle label={t('douyin-link.users.analyzeFactsTitle')} />
        <div className="grid grid-cols-3 gap-1.5">
          <StatBlock
            label={t('douyin-link.users.analyzeFactRecency')}
            value={recencyText(t, facts.recencyHours)}
            palette={palette}
          />
          <StatBlock
            label={t('douyin-link.users.analyzeFactActiveDays')}
            value={`${formatNumber(facts.activeDays)} ${t('douyin-link.users.analyzeUnitDay')}`}
            palette={palette}
          />
          <StatBlock
            label={t('douyin-link.users.analyzeFactMonetary')}
            value={formatNumber(facts.monetary)}
            palette={palette}
          />
          <StatBlock
            label={t('douyin-link.users.analyzeFactAvgGift')}
            value={formatNumber(facts.avgGift)}
            palette={palette}
          />
          <StatBlock
            label={t('douyin-link.users.analyzeFactPeakHour')}
            value={facts.peakHour >= 0 ? `${String(facts.peakHour).padStart(2, '0')}:00` : '-'}
            palette={palette}
          />
          <StatBlock
            label={t('douyin-link.users.analyzeFactSentiment')}
            value={sentimentText(t, facts.sentiment)}
            palette={palette}
          />
        </div>
        <FactLine
          items={[
            facts.topGiftName
              ? `${t('douyin-link.users.analyzeFactTopGift')} ${facts.topGiftName} ×${formatNumber(facts.topGiftCount)}`
              : `${t('douyin-link.users.analyzeFactGiftKinds')} ${facts.giftKinds}`,
            `${t('douyin-link.users.analyzeFactRecipients')} ${facts.recipients}`
          ]}
        />
      </div>

      <span className="text-[10px] leading-3 opacity-50">{t('douyin-link.users.analyzeBasis')}</span>
    </div>
  )
}

/**
 * 「神秘人真实信息」卡片：抖音那边**按用户 id 查回来**的账号资料（见 `main/douyin/mystery.ts`）。
 *
 * 与上面那一段（我们自己观察到的档案）刻意分开：这里的昵称、粉丝数、地区都是账号本人的，
 * 跟直播间里的匿名马甲无关——这正是「脱马甲」要看的东西。头像由主进程下载成 data URL。
 */
function RevealedIdentity(props: {
  profile: MysteryProfile
  palette: PluginPalette
  t: Translate
}): React.JSX.Element {
  const { profile, palette, t } = props
  const letter = (profile.nickname || '?').trim().slice(0, 1).toUpperCase()
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] opacity-50">{t('douyin-link.users.revealTitle')}</span>
      <div className="flex items-center gap-2">
        {profile.avatar ? (
          <img
            src={profile.avatar}
            alt=""
            width={36}
            height={36}
            className="shrink-0 rounded-full"
            style={{ objectFit: 'cover' }}
          />
        ) : (
          <span
            className="flex shrink-0 items-center justify-center rounded-full text-[12px]"
            style={{ width: 36, height: 36, color: palette.surface, backgroundColor: palette.accent }}
          >
            {letter}
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-semibold">{profile.nickname}</span>
          {profile.verified ? (
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              {t('douyin-link.users.revealVerified')} {profile.verified}
            </Tag>
          ) : null}
        </div>
      </div>
      <FactLine
        items={[
          `${t('douyin-link.users.displayId')} ${profile.displayId || '-'}`,
          `${t('douyin-link.users.gender')} ${genderText(t, profile.gender)}`,
          profile.region ? `${t('douyin-link.users.revealRegion')} ${profile.region}` : ''
        ].filter(Boolean)}
      />
      <FactLine
        items={[
          `${t('douyin-link.users.revealFollower')} ${formatNumber(profile.follower)}`,
          `${t('douyin-link.users.revealFollowing')} ${formatNumber(profile.following)}`,
          `${t('douyin-link.users.revealWorks')} ${formatNumber(profile.awemeCount)}`,
          `${t('douyin-link.users.revealLikes')} ${formatNumber(profile.totalFavorited)}`
        ]}
      />
      {profile.signature ? <span className="text-xs opacity-70">{profile.signature}</span> : null}
    </div>
  )
}

/** 神秘人还原的失败码 → 文案（翻不到就退回通用失败句） */
function revealErrorText(t: Translate, code: 'badInput' | 'network' | 'notFound' | 'badResponse'): string {
  const key = `douyin-link.users.revealError${code[0].toUpperCase()}${code.slice(1)}`
  const text = t(key)
  return text.startsWith('douyin-link.') ? t('douyin-link.users.revealFailed') : text
}

/** 失败原因：**代码在主进程、文案在渲染层**，所以在这里翻（翻不到就退回裸代码 + 明细） */
export function FailureLine(props: { failure: FailureInfo }): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const palette = usePluginPalette()
  const key = `douyin-link.failure.${props.failure.code}`
  const text = t(key, { detail: props.failure.detail ?? '' })
  return (
    <span className="text-xs" style={{ color: palette.down }}>
      {text.startsWith('douyin-link.') ? `${props.failure.code} ${props.failure.detail ?? ''}`.trim() : text}
    </span>
  )
}

function phaseText(t: Translate, room: RoomRuntime): string {
  switch (room.phase) {
    case 'live':
      return t('douyin-link.page.phaseLive')
    case 'connecting':
      return t('douyin-link.page.phaseConnecting')
    case 'resolving':
      return t('douyin-link.page.phaseResolving')
    case 'retrying':
      return t('douyin-link.page.phaseRetrying')
    case 'queued':
      return t('douyin-link.page.phaseQueued')
    case 'error':
      return t('douyin-link.page.phaseError')
    case 'ended':
      return t('douyin-link.page.phaseEnded')
    default:
      return t('douyin-link.page.phaseOff')
  }
}

function phaseColor(room: RoomRuntime): string | undefined {
  switch (room.phase) {
    case 'live':
      return 'green'
    case 'connecting':
    case 'resolving':
    case 'retrying':
      return 'gold'
    case 'error':
      return 'red'
    default:
      return undefined
  }
}

function genderText(t: Translate, gender: number): string {
  if (gender === 1) return t('douyin-link.users.genderMale')
  if (gender === 2) return t('douyin-link.users.genderFemale')
  return t('douyin-link.users.genderUnknown')
}
