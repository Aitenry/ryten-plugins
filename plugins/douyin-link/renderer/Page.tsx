import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Modal, Select, Slider, Switch, Tag } from 'antd'
import {
  RiDeleteBin6Line,
  RiPauseLine,
  RiPlayLine,
  RiRefreshLine,
  RiTeamLine
} from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type {
  AnalyzerSnapshot,
  DanmakuItem,
  FailureInfo,
  LiveSettings,
  QualityKey,
  RoomRuntime,
  UserProfile
} from '../shared/types'
import { QUALITY_KEYS } from '../shared/types'
import api, { normalizeSnapshot } from './api'
import { LiveAudioPlayer } from './audio/player'
import type { PlayerStats } from './audio/player'
import { ComparePanel } from './components/ComparePanel'
import { DanmakuFeed } from './components/DanmakuFeed'
import { OverviewPanel } from './components/OverviewPanel'
import { PresencePanel } from './components/PresencePanel'
import {
  PageShell,
  Pane,
  Panel,
  PillTabBar,
  PillTabsBody,
  formModalProps,
  usePluginPalette
} from './components/ui'
import type { PillTabItem, PluginPalette } from './components/ui'
import { RoomRail } from './components/RoomRail'
import { SearchPanel } from './components/SearchPanel'
import { UserAvatar } from './components/UserAvatar'
import { UserHistory } from './components/UserHistory'
import { GiftHistoryModal } from './components/GiftHistory'
import { UsersPanel } from './components/UsersPanel'
import { duration, formatNumber, stamp } from './components/OverviewPanel'

type Translate = (key: string, options?: Record<string, unknown>) => string
type TabKey = 'overview' | 'live' | 'presence' | 'users' | 'search' | 'compare'

const EMPTY_STATS: PlayerStats = {
  state: 'idle',
  sampleRate: 0,
  channels: 0,
  received: 0,
  dropped: 0,
  buffer: 0,
  decoded: 0,
  errorCode: '',
  detail: ''
}

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
  const [audioRoom, setAudioRoom] = useState('')
  const [settings, setSettings] = useState<LiveSettings | null>(null)
  const [itemsByRoom, setItemsByRoom] = useState<Map<string, DanmakuItem[]>>(() => new Map())
  const [usersByRoom, setUsersByRoom] = useState<Map<string, Map<string, UserProfile>>>(() => new Map())
  const [usersReloadKey, setUsersReloadKey] = useState(0)
  const [tab, setTab] = useState<TabKey>('overview')
  const [minutes, setMinutes] = useState(60)
  const [busy, setBusy] = useState(false)
  const [stats, setStats] = useState<PlayerStats>(EMPTY_STATS)
  const [volume, setVolume] = useState(0.8)
  const [openUser, setOpenUser] = useState('')
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

  const playerRef = useRef<LiveAudioPlayer | null>(null)
  const audioRoomRef = useRef('')
  const settingsRef = useRef<LiveSettings | null>(null)
  /** 当前页签（事件回调里要用到，但不想因为切页签重订阅事件通道） */
  const tabRef = useRef<TabKey>('overview')
  /** 「用户榜需要刷新」的欠账：不在用户页签时不查库，切回去补一次 */
  const usersReloadPending = useRef(false)
  const supported = useMemo(() => LiveAudioPlayer.isSupported(), [])
  const maxItems = settings?.maxItems ?? 200

  const active = useMemo(() => rooms.find((room) => room.webRid === activeRoom) ?? null, [rooms, activeRoom])
  const items = activeRoom ? (itemsByRoom.get(activeRoom) ?? []) : []
  const users = activeRoom ? (usersByRoom.get(activeRoom) ?? new Map()) : new Map<string, UserProfile>()

  /* ------------------------------------------------------- 初始与推送 */

  const applySnapshot = useCallback((raw: AnalyzerSnapshot): void => {
    // 出口再兜一层归一化：`rooms` 必须是数组（界面里到处是 rooms.find），
    // settings 必须完整。主进程刚起来、或工坊的挂载冒烟在插件刚装好时渲染这一页，
    // 都可能给不出一份完整快照——那种时候界面该是空态，不是白屏。
    const next = normalizeSnapshot(raw)
    setRooms(next.rooms)
    setActiveRoom(next.activeRoom)
    setAudioRoom(next.audioRoom)
    audioRoomRef.current = next.audioRoom
    setSettings(next.settings)
    settingsRef.current = next.settings
    setVolume(next.settings.volume)
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

  /** 房间列表推送：相位、计数、库里累计都在里面（界面直接替换，不做增量合并） */
  useEffect(
    () =>
      api.onRooms((push) => {
        // 推送形状不信任（api 层挡过一道，这里再挡 undefined 的房间号）
        setRooms(Array.isArray(push.rooms) ? push.rooms : [])
        setActiveRoom(typeof push.activeRoom === 'string' ? push.activeRoom : '')
        const audio = typeof push.audioRoom === 'string' ? push.audioRoom : ''
        setAudioRoom(audio)
        audioRoomRef.current = audio
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

  /* --------------------------------------------------------------- 音频 */

  useEffect(() => {
    const player = new LiveAudioPlayer()
    player.onStats = (next) => setStats(next)
    playerRef.current = player
    return () => {
      playerRef.current = null
      player.dispose()
      // 页面走了就别让主进程继续拉流（拉流在主进程，不主动停会一直耗流量）
      void api.audioStop()
    }
  }, [])

  /** 音频消息：**只放正在响的那个房间的帧**（切房间时旧泵已经停了，这里再兜一层） */
  useEffect(
    () =>
      api.onAudio((message) => {
        if (audioRoomRef.current && message.webRid !== audioRoomRef.current) return
        playerRef.current?.handleMessage(message)
      }),
    []
  )

  /** 主进程停了声音（比如房间下播）→ 播放器也收干净 */
  useEffect(() => {
    if (audioRoom || !playerRef.current) return
    playerRef.current.stopStream()
  }, [audioRoom])

  const toggleAudio = useCallback(async (): Promise<void> => {
    const player = playerRef.current
    if (!player || !activeRoom) return
    if (audioRoomRef.current === activeRoom && stats.state === 'playing') {
      player.pause()
      await api.audioStop()
      return
    }
    // 播放：让主进程开始推音频，然后在自己这个点击手势里把 AudioContext 解出来
    player.begin()
    const ok = await api.audioStart(activeRoom)
    if (!ok) {
      player.stopStream()
      return
    }
    audioRoomRef.current = activeRoom
    setAudioRoom(activeRoom)
    await player
      .resume()
      .catch(() => undefined)
  }, [activeRoom, stats.state])

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
      const [recent, userRows, stored] = await Promise.all([
        api.roomRecent(webRid, Math.max(50, maxItems)),
        api.usersList(webRid, 'recent', '', 300),
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
        for (const row of userRows) {
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
      void api.roomSelect(webRid).then(() => loadRoomData(webRid))
    },
    [activeRoom, loadRoomData]
  )

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
        title: t('douyin-link.page.removeConfirmTitle', { room: room?.title || webRid }),
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
  const tabItems: PillTabItem[] = [
    {
      key: 'overview',
      label: t('douyin-link.page.tabOverview'),
      children: (
        <Pane>
          <OverviewPanel
            room={active}
            minutes={minutes}
            onMinutes={setMinutes}
            onOpenGifts={(target) => setOpenGifts(target)}
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
          <UsersPanel room={active} reloadKey={usersReloadKey} onOpenUser={setOpenUser} />
        </Pane>
      )
    },
    {
      key: 'search',
      label: t('douyin-link.page.tabSearch'),
      children: (
        <Pane>
          <SearchPanel rooms={rooms} activeRoom={activeRoom} />
        </Pane>
      )
    },
    {
      key: 'compare',
      label: t('douyin-link.page.tabCompare'),
      children: (
        <Pane>
          <ComparePanel
            minutes={minutes}
            onMinutes={setMinutes}
            activeRoom={activeRoom}
            onSelect={selectRoom}
          />
        </Pane>
      )
    }
  ]

  return (
    /* 页头整条去掉了：标题与「数据库：… / 声音状态」都由宿主界面和下面的面板给出了，
       这里不再重复一行。PageShell 的 header 省略即可（顶栏高度随之收掉）。 */
    <PageShell>
      <div className="grid h-full min-h-0 grid-cols-12 grid-rows-1 gap-3">
        <div className="col-span-3 flex min-h-0 flex-col gap-3">
          <RoomRail
            rooms={rooms}
            activeRoom={activeRoom}
            audioRoom={audioRoom}
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
        </div>

        <div className="col-span-9 flex min-h-0 flex-col gap-3">
          <Panel
            className="shrink-0"
            title={active ? active.title || active.webRid : t('douyin-link.page.noActive')}
            extra={
              <div className="flex min-w-0 items-center gap-2">
                {sessionLine ? (
                  /* 数字长了就截断（原生 title 兜住全文），不能把房间名挤没了 */
                  <span
                    className="truncate text-xs font-normal opacity-60"
                    style={{ maxWidth: 'min(560px, 52vw)' }}
                    title={sessionLine}
                  >
                    {sessionLine}
                  </span>
                ) : null}
                {phaseTag}
              </div>
            }
          >
            <RoomHeader
              room={active}
              t={t}
              palette={palette}
              settings={settings}
              stats={stats}
              volume={volume}
              playing={audioRoom === activeRoom && stats.state === 'playing'}
              supported={supported}
              onToggleAudio={() => void toggleAudio()}
              onVolume={(value) => {
                setVolume(value)
                playerRef.current?.setVolume(value)
              }}
              onVolumeCommit={(value) => void saveSettings({ volume: value })}
              onQuality={(quality) => void saveSettings({ quality }).then(() => void reload())}
              onToggleMonitor={(on) => active && toggleMonitor(active.webRid, on)}
              onRefresh={() => active && refreshRoom(active.webRid)}
              tabBar={<PillTabBar items={tabItems} activeKey={tab} onChange={(key) => setTab(key as TabKey)} />}
            />
          </Panel>

          <PillTabsBody activeKey={tab} onChange={(key) => setTab(key as TabKey)} items={tabItems} />
        </div>
      </div>

      {openUser && activeRoom ? (
        <UserProfileModal
          webRid={activeRoom}
          userId={openUser}
          rooms={rooms}
          onClose={() => setOpenUser('')}
        />
      ) : null}

      {/* 礼物榜点开的历史（他送的 / 他收到的）：与用户档案弹窗是两个入口，互不干扰 */}
      {openGifts && activeRoom ? (
        <GiftHistoryModal
          webRid={activeRoom}
          userId={openGifts.userId}
          name={openGifts.name}
          direction={openGifts.direction}
          onClose={() => setOpenGifts(null)}
        />
      ) : null}
    </PageShell>
  )
}

/** 房间头：信息 + 监控开关 + 声音（播放/档位/音量）+ 刷新 */
function RoomHeader(props: {
  room: RoomRuntime | null
  t: Translate
  palette: ReturnType<typeof usePluginPalette>
  settings: LiveSettings | null
  stats: PlayerStats
  volume: number
  playing: boolean
  supported: boolean
  onToggleAudio: () => void
  onVolume: (value: number) => void
  onVolumeCommit: (value: number) => void
  onQuality: (quality: QualityKey) => void
  onToggleMonitor: (on: boolean) => void
  onRefresh: () => void
  /** 页签的胶囊条：挂在最后一行（「条/分 · 本场 N 人 · 本场 N 条」）的右端；不传就不渲染 */
  tabBar?: React.ReactNode
}): React.JSX.Element {
  const { room, t, palette } = props
  if (!room) {
    /* 没有选中房间时这一行也要在：**胶囊页签不能跟着一起消失**——检索 / 对比这两个页签
       不需要房间也能看，所以这里退化成「一句空态 + 右端的胶囊条」。 */
    return (
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-xs opacity-50">{t('douyin-link.page.emptyRooms')}</span>
        {props.tabBar ? <div className="ml-auto flex min-w-0 shrink-0 items-center">{props.tabBar}</div> : null}
      </div>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs opacity-70">
        <span className="min-w-0 truncate">
          {t('douyin-link.page.anchor')}：{room.anchor || '-'}
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
        {room.note ? <span className="min-w-0 truncate">· {room.note}</span> : null}
        <span>
          {t('douyin-link.page.storedLine', {
            messages: formatNumber(room.stored.messages),
            users: formatNumber(room.stored.users),
            sessions: formatNumber(room.stored.sessions)
          })}
        </span>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Switch
          size="small"
          checked={room.monitor}
          onChange={props.onToggleMonitor}
          checkedChildren={t('douyin-link.page.monitor')}
          unCheckedChildren={t('douyin-link.page.monitor')}
        />
        <Button
          size="small"
          type={props.playing ? 'default' : 'primary'}
          disabled={!props.supported || room.status === 'ended'}
          icon={props.playing ? <RiPauseLine size={14} /> : <RiPlayLine size={14} />}
          onClick={props.onToggleAudio}
        >
          {props.playing ? t('douyin-link.page.audioPause') : t('douyin-link.page.audioPlay')}
        </Button>
        <Select
          size="small"
          style={{ width: 92 }}
          value={props.settings?.quality ?? 'SD2'}
          onChange={(value) => props.onQuality(value as QualityKey)}
          options={QUALITY_KEYS.map((key) => ({ value: key, label: qualityLabel(t, key) }))}
        />
        <span className="text-xs opacity-60">{t('douyin-link.page.volume')}</span>
        <Slider
          className="min-w-[80px] flex-1"
          min={0}
          max={100}
          value={Math.round(props.volume * 100)}
          tooltip={{ open: false }}
          onChange={(value) => props.onVolume(value / 100)}
          onChangeComplete={(value) => props.onVolumeCommit(value / 100)}
        />
        <Button size="small" type="text" icon={<RiRefreshLine size={14} />} onClick={props.onRefresh}>
          {t('douyin-link.page.refresh')}
        </Button>
      </div>

      {/* 最后一行：速率 / 本场人数 / 本场条数 + 声音状态，**右端挂胶囊页签**
          （用户要求：「0 条/分 · 本场 N 人 · 本场 N 条 这个内容的右边放胶囊 tab」）。
          左边那一串是暗色小字，所以胶囊条单独放在不压暗的容器里。 */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] opacity-60">
          <span>
            {t('douyin-link.page.rate', { rate: room.rate })} ·{' '}
            {t('douyin-link.page.sessionUsers', { count: room.sessionUsers })} ·{' '}
            {t('douyin-link.page.sessionReceived', { count: room.received })}
          </span>
          <span>{audioStateText(t, props.stats, room)}</span>
          {props.stats.sampleRate > 0 ? (
            <span>
              {t('douyin-link.page.audioStats', {
                rate: props.stats.sampleRate,
                channels: props.stats.channels,
                buffer: props.stats.buffer.toFixed(2),
                dropped: props.stats.dropped
              })}
            </span>
          ) : null}
          {!props.supported ? <span style={{ color: palette.down }}>{t('douyin-link.page.audioUnsupported')}</span> : null}
          {room.failure ? <FailureLine failure={room.failure} /> : null}
        </div>
        {props.tabBar ? <div className="ml-auto flex min-w-0 shrink-0 items-center">{props.tabBar}</div> : null}
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

  useEffect(() => {
    let alive = true
    setLoading(true)
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

  return (
    <Modal
      {...formModalProps}
      open={Boolean(props.userId)}
      title={t('douyin-link.users.detailTitle')}
      onCancel={props.onClose}
      footer={
        <div className="flex justify-end">
          <Button onClick={props.onClose}>{t('douyin-link.users.close')}</Button>
        </div>
      }
    >
      {/* 外层的列容器是必需的：档案分支用 fragment，块与块之间的 gap 靠它（fragment 不生成节点） */}
      <div className="flex flex-col gap-3">
        {!profile ? (
          <span className="text-xs opacity-60">
            {loading ? t('douyin-link.users.loading') : t('douyin-link.users.missing')}
          </span>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <UserAvatar webRid={props.webRid} userId={profile.id} nickname={profile.nickname} size={48} />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                {/* 荣誉等级 / 粉丝团跟在名字这一行的**最右端**（原来单独占一行，把名字行也拉长了） */}
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

        {/* 这个人说过什么：**不挂在档案分支里** —— 用户记录被清掉后档案查不到，但消息流水还在 */}
        <UserHistory webRid={props.webRid} userId={props.userId} rooms={props.rooms} />
      </div>
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

function qualityLabel(t: Translate, quality: QualityKey): string {
  switch (quality) {
    case 'FULL_HD1':
      return t('douyin-link.page.qualityFullHd')
    case 'HD1':
      return t('douyin-link.page.qualityHd')
    case 'SD1':
      return t('douyin-link.page.qualitySd1')
    default:
      return t('douyin-link.page.qualitySd2')
  }
}

function audioStateText(t: Translate, stats: PlayerStats, room: RoomRuntime): string {
  if (stats.state === 'error') {
    const key = `douyin-link.failure.${stats.errorCode || 'audioUnsupported'}`
    const text = t(key, { detail: stats.detail })
    return `${t('douyin-link.failure.title')}：${text.startsWith('douyin-link.') ? stats.errorCode : text}`
  }
  if (stats.state === 'blocked') return t('douyin-link.page.audioBlocked')
  if (stats.state === 'playing') return t('douyin-link.page.audioPlaying')
  if (stats.state === 'paused') return t('douyin-link.page.audioPaused')
  if (stats.state === 'connecting') return t('douyin-link.page.audioConnecting')
  return room.audio ? t('douyin-link.page.audioIdle') : t('douyin-link.page.audioSwitched')
}

function genderText(t: Translate, gender: number): string {
  if (gender === 1) return t('douyin-link.users.genderMale')
  if (gender === 2) return t('douyin-link.users.genderFemale')
  return t('douyin-link.users.genderUnknown')
}
