import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Segmented, Tooltip } from 'antd'
import { RiArrowDownLine, RiLoginCircleLine, RiHeartLine, RiAddCircleLine, RiGiftLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { DanmakuItem, DanmakuKind, UserProfile } from '../../shared/types'
import { ScrollStyle, usePluginPalette, type PluginPalette } from './ui'
import { UserAvatar } from './UserAvatar'

/**
 * 弹幕列表：**分类分开看**（弹幕 / 进场 / 关注 / 点赞），新消息在底部自动跟随。
 *
 * 用户反馈过的四件事都在这里解决：
 * 1. 「关注直播间、进入直播间要分开显示」——顶部一排分类（Segmented），
 *    每类各自一个列表：进场/关注/点赞走卡片行（类型徽章 + 头像），聊天走紧凑行；
 * 2. **不要「全部」那一类**：混排视图去掉后，每屏只有一种消息，行样式也就不用再分两种；
 *    直播状态/系统提示（下播等）数量极少但重要，改成**固定在列表上方的一行notice**，
 *    不再占一个分类，也不会因为没了混排就看不见；
 * 3. **也去掉「在线人数」那一类**（它就是 stats 消息），但人数本身要看得见：
 *    它现在是列表上方**固定的一行**（只显示最新一条，随消息更新），不再当分类用
 *    ——人数这类消息是「当前值」而不是「流水」，占一栏反倒要用户自己去翻；
 * 4. 「滚动条优化」——只给这一个内容块一根**细滚动条**
 *    （样式是 ui.tsx 里那份共用的 `SCROLLBAR_CSS` / `<ScrollStyle />`；
 *    宿主 CSP 是 `style-src 'self' 'unsafe-inline'`，所以 <style> 元素是允许的，
 *    ::-webkit-scrollbar 这类伪元素没法用内联样式写），
 *    并且往上翻时**不抢滚动**：离底部超过 48px 就停跟随，右下角给「N 条新消息」。
 *
 * 只画最后 300 条：弹幕是高频流，DOM 越少越稳。
 */
const RENDER_CAP = 300
const NEAR_BOTTOM_PX = 48

/**
 * 细滚动条 + 行悬停底色的样式**统一放在 ui.tsx**（`SCROLLBAR_CSS` / `<ScrollStyle />`）：
 * 用户档案的列表也用同一份，两边观感才一致——别在这里再抄一遍。
 */

/**
 * 分类视图：一个分类 = 一种消息。
 * `control`/`system`（直播状态）与 `stats`（在线人数）**不占分类**：前者进 notices，
 * 后者进 statsLine ——两类都是「当前值 / 系统提示」，不是需要往下翻的消息流水。
 */
type ViewKey = Exclude<DanmakuKind, 'control' | 'system' | 'stats'>

/** 分类顺序 */
const VIEWS: ViewKey[] = ['chat', 'member', 'social', 'like', 'gift']

export function DanmakuFeed(props: {
  /** 正在看哪个房间（头像按房间缓存） */
  webRid: string
  items: DanmakuItem[]
  kinds: DanmakuKind[]
  autoScroll: boolean
  /** userId → 档案（点昵称看详情要用） */
  users: Map<string, UserProfile>
  onOpenUser: (userId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const palette = usePluginPalette()
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [view, setView] = useState<ViewKey>('chat')
  /** 上次「在底部」时看到的最后一条 id：用来数「中途来了几条」 */
  const seenIdRef = useRef(0)

  const allowed = useMemo(() => new Set(props.kinds), [props.kinds])

  /** 允许显示的消息（设置里的「显示类型」过滤） */
  const pool = useMemo(
    () => props.items.filter((item) => allowed.size === 0 || allowed.has(item.kind)),
    [props.items, allowed]
  )

  /** 直播状态/系统提示：固定显示在列表上方（不占分类），最多留 3 条 */
  const notices = useMemo(
    () => pool.filter((item) => item.kind === 'control' || item.kind === 'system').slice(-3),
    [pool]
  )

  /**
   * 在线人数：也只留**最新一条**固定显示（人数是当前值，不是流水，攒着没有意义）。
   * 它不再是一个分类，但内容不丢——就在 notices 下方那一行。
   */
  const statsLine = useMemo(() => {
    const rows = pool.filter((item) => item.kind === 'stats')
    return rows.length > 0 ? rows[rows.length - 1] : null
  }, [pool])

  const visible = useMemo(
    () => pool.filter((item) => item.kind === view).slice(-RENDER_CAP),
    [pool, view]
  )

  const lastId = visible.length > 0 ? visible[visible.length - 1].id : 0
  if (atBottom && lastId > seenIdRef.current) seenIdRef.current = lastId
  const pending = visible.filter((item) => item.id > seenIdRef.current).length

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    if (!props.autoScroll || !atBottom) return
    box.scrollTop = box.scrollHeight
  }, [lastId, props.autoScroll, atBottom])

  // 换分类等于换了一屏内容：直接回到最新，别让用户在上一个分类的位置上迷路
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    box.scrollTop = box.scrollHeight
    setAtBottom(true)
    seenIdRef.current = 0
  }, [view])

  const toBottom = (): void => {
    const box = boxRef.current
    if (!box) return
    box.scrollTop = box.scrollHeight
    setAtBottom(true)
  }

  /**
   * 分类上的计数：**必须和列表用同一个池子**（`pool`，已经过「显示类型」过滤）。
   * 早先这里数的是 `props.items`（未过滤），于是旧设置文件里没有 `gift` 时会出现
   * 「礼物 1」的计数、点进去却是「这一类还没有消息」（用户 2026-10-08 截图反馈）。
   */
  const counts = useMemo(() => {
    const map = new Map<ViewKey, number>()
    for (const item of pool) {
      if (item.kind === 'control' || item.kind === 'system' || item.kind === 'stats') continue
      map.set(item.kind as ViewKey, (map.get(item.kind as ViewKey) ?? 0) + 1)
    }
    return map
  }, [pool])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <ScrollStyle />
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Segmented
          size="small"
          value={view}
          onChange={(value) => setView(value as ViewKey)}
          options={VIEWS.map((key) => ({
            value: key,
            label: `${viewLabel(t, key)}${view === key && counts.get(key) ? ` ${counts.get(key)}` : ''}`
          }))}
        />
      </div>
      {/*
        固定头两行：直播状态/系统提示（notices）+ 最新在线人数（statsLine）。
        这两类都不占分类，但必须在——尤其下播提示，看不见就等于没有。
      */}
      {notices.length > 0 || statsLine ? (
        <div className="flex shrink-0 flex-col gap-1">
          {notices.map((item) => (
            <DanmakuRow
              key={item.id}
              item={item}
              webRid={props.webRid}
              palette={palette}
              user={undefined}
              onOpenUser={props.onOpenUser}
            />
          ))}
          {statsLine ? (
            <DanmakuRow
              key={statsLine.id}
              item={statsLine}
              webRid={props.webRid}
              palette={palette}
              user={undefined}
              onOpenUser={props.onOpenUser}
            />
          ) : null}
        </div>
      ) : null}
      <div
        ref={boxRef}
        data-rb-scroll=""
        className="min-h-0 flex-1 overflow-y-auto pr-1"
        onScroll={(event) => {
          const box = event.currentTarget
          const bottom = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX
          if (bottom) seenIdRef.current = lastId
          setAtBottom(bottom)
        }}
      >
        {visible.length === 0 ? (
          <div key="empty" className="flex h-full items-center justify-center px-3">
            <span className="text-center text-xs opacity-50">
              {t(view === 'chat' ? 'douyin-link.page.danmakuEmpty' : 'douyin-link.page.viewEmpty')}
            </span>
          </div>
        ) : (
          // key={view}：换分类时强制整块重挂，避免 React 复用上一个分类的 DOM 节点
          // （列表行的 key 来自主进程自增 id，跨分类复用可能把上一类的行留在新分类里）
          <div key={view} className="flex flex-col gap-1.5">
            {visible.map((item) => (
              <DanmakuRow
                key={item.id}
                item={item}
                webRid={props.webRid}
                palette={palette}
                user={item.userId ? props.users.get(item.userId) : undefined}
                onOpenUser={props.onOpenUser}
              />
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2">
        <span className="text-xs opacity-50">{t('douyin-link.page.viewCount', { count: visible.length })}</span>
        {!atBottom ? (
          <Button size="small" type="primary" icon={<RiArrowDownLine size={13} />} onClick={toBottom}>
            {pending > 0 ? t('douyin-link.page.newMessages', { count: pending }) : t('douyin-link.page.follow')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** 事件类消息（进场/关注/点赞）走卡片行；聊天走紧凑行 */
function DanmakuRow(props: {
  item: DanmakuItem
  /** 正在看哪个房间（卡片行的头像按房间缓存） */
  webRid: string
  palette: PluginPalette
  user?: UserProfile
  onOpenUser: (userId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { item, palette, user } = props
  const accent = kindColor(item.kind, palette)

  /**
   * 紧凑行 vs 卡片行：聊天/人数/状态本来就是紧凑行；**没有发送者的礼物**（点歌）也走紧凑行——
   * 它没有昵称可点、头像只会是个问号，做成「· 想听 X 演唱」更干净。
   */
  const compact =
    item.kind === 'chat' ||
    item.kind === 'stats' ||
    item.kind === 'control' ||
    item.kind === 'system' ||
    (item.kind === 'gift' && !item.user && !item.userId)

  if (compact) {
    return (
      <div data-rb-row="" className="flex min-w-0 items-start gap-1.5 rounded px-1 py-0.5 text-xs leading-5">
        <span className="mt-[7px] shrink-0 rounded-full" style={{ width: 4, height: 4, backgroundColor: accent }} />
        <span className="min-w-0 break-words">
          {item.kind === 'chat' ? (
            <>
              {item.user ? (
                <Tooltip title={t('douyin-link.page.clickUser')}>
                  <span
                    className="cursor-pointer font-medium"
                    style={{ color: accent }}
                    onClick={() => item.userId && props.onOpenUser(item.userId)}
                  >
                    {item.user}
                  </span>
                </Tooltip>
              ) : null}
              {item.user ? <span className="opacity-60">：</span> : null}
              <span>{item.text}</span>
            </>
          ) : item.kind === 'stats' ? (
            <>
              <span className="opacity-70">{t('douyin-link.lines.stats')} </span>
              <span style={{ color: accent }}>{item.text}</span>
            </>
          ) : item.kind === 'system' ? (
            // 房间级系统提示（`WebcastRoomMessage`，如进房欢迎语）：原文照显，不当成状态变化
            <span style={{ color: accent }}>{item.text}</span>
          ) : item.kind === 'gift' ? (
            // 点歌：这一帧里没有发送者，只有歌手与歌名 -> 直接成句，别硬凑一个昵称出来
            <span style={{ color: accent }}>{lineText(t, item)}</span>
          ) : (
            <span style={{ color: accent }}>
              {item.text === 'ended' ? t('douyin-link.lines.controlEnded') : t('douyin-link.lines.controlChanged')}
            </span>
          )}
        </span>
      </div>
    )
  }

  const badge =
    item.kind === 'member'
      ? t('douyin-link.kinds.member')
      : item.kind === 'social'
        ? t('douyin-link.kinds.social')
        : item.kind === 'gift'
          ? t('douyin-link.kinds.gift')
          : t('douyin-link.kinds.like')

  return (
    <div data-rb-row="" className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1">
      <UserAvatar webRid={props.webRid} userId={item.userId} nickname={item.user} size={22} />
      <span
        className="shrink-0 rounded px-1 text-[10px] leading-4"
        style={{ color: accent, border: `1px solid ${accent}`, opacity: 0.9 }}
      >
        {badge}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs">
        {/*
          点歌/礼物那一类，帧里只有发送者的 id：昵称由主进程用我们自己的数据补
          （本场见过的人 → 库里查），所以这里优先用记录里的名字、其次是刚推过来的档案；
          两个都没有就照实显示 id（可点开查档案），绝不编一个名字出来。
        */}
        {item.user || item.userId ? (
          <>
            <Tooltip title={user ? userTooltip(t, user) : undefined}>
              <span
                className="cursor-pointer font-medium"
                style={{ color: accent }}
                onClick={() => item.userId && props.onOpenUser(item.userId)}
              >
                {item.user || user?.nickname || t('douyin-link.page.idOnly', { id: item.userId })}
              </span>
            </Tooltip>
            <span className="opacity-70"> </span>
          </>
        ) : null}
        <span className="opacity-70">{lineText(t, item)}</span>
      </span>
      {/*
        礼物的价值单独一列：`diamonds = 0` 有两种可能（免费礼物 / 官方没给价），
        推送里分不出来，所以文案只说「价值未知」，不写成「0 抖币」。
        点歌（没有发送者那一类）不带价格，整列省掉。
      */}
      {item.kind === 'gift' && (item.user || item.userId) ? (
        <span className="shrink-0 text-[10px] opacity-60">
          {item.diamonds > 0
            ? t('douyin-link.page.giftDiamonds', { count: formatDiamonds(item.diamonds) })
            : t('douyin-link.page.giftValueUnknown')}
        </span>
      ) : null}
      {item.count > 1 ? (
        <span className="shrink-0 text-xs opacity-60">×{item.count}</span>
      ) : null}
    </div>
  )
}

/** 事件行里「昵称 之后」的那段文案 */
function lineText(
  t: (key: string, options?: Record<string, unknown>) => string,
  item: DanmakuItem
): string {
  switch (item.kind) {
    case 'member':
      return t('douyin-link.lines.member')
    case 'social':
      return t('douyin-link.lines.social')
    case 'gift':
      // 礼物名解不出来（推送里没带礼物结构）时也要成句，别显示成「送出了 」
      return item.text
        ? // 「送给谁」也是礼物的一部分：点歌那一帧的收礼人就是歌手（谁收到了这份点唱礼物）
          `${t('douyin-link.lines.giftNamed', { name: item.text })}${giftRecipientText(t, item) ? ` ${giftRecipientText(t, item)}` : ''}`
        : t('douyin-link.lines.gift')
    default:
      return t('douyin-link.lines.like')
  }
}

/**
 * 礼物行的「送给 X」那一段（收礼人）。不是礼物、或帧里没带收礼人时返回空串。
 *
 * 历史消息（用户档案里的历史弹幕、消息检索）也用它，所以收礼人在库里也存了一份
 * （`messages.to_user_name` / `to_user_id`），不是只在实时那一屏可见。
 */
export function giftRecipientText(
  t: (key: string, options?: Record<string, unknown>) => string,
  item: Pick<DanmakuItem, 'kind' | 'toUser' | 'toUserId'>
): string {
  if (item.kind !== 'gift' || (!item.toUser && !item.toUserId)) return ''
  return t('douyin-link.lines.giftTo', {
    to: item.toUser || t('douyin-link.page.idOnly', { id: item.toUserId })
  })
}

/** 抖币数字（万以上折成「1.2万」，弹幕行里放不下长数字） */
export function formatDiamonds(value: number): string {
  if (value >= 10000) return `${Math.round(value / 1000) / 10}万`
  return String(value)
}

/** 悬停昵称时的速览（等级/粉丝团/关注数，明细点开看） */
function userTooltip(t: (key: string) => string, user: UserProfile): string {
  const parts: string[] = []
  if (user.displayId) parts.push(`ID ${user.displayId}`)
  if (user.honorLevel > 0) parts.push(`${t('douyin-link.users.honor')} ${user.honorLevel}`)
  if (user.fansClubLevel > 0) parts.push(`${t('douyin-link.users.fansClub')} ${user.fansClubLevel}`)
  if (user.following > 0 || user.follower > 0) parts.push(`⭐ ${user.following} / ${user.follower}`)
  parts.push(t('douyin-link.page.clickUser'))
  return parts.join(' · ')
}

function viewLabel(t: (key: string) => string, view: ViewKey): string {
  return t(`douyin-link.kinds.${view}`)
}

/** 类型 → 颜色（一律取调色板，不写字面量色值；用户档案里的历史弹幕也用这一份） */
export function kindColor(kind: DanmakuKind, palette: PluginPalette): string {
  switch (kind) {
    case 'member':
      return palette.accent
    case 'like':
      return palette.down
    case 'social':
      return palette.up
    // 礼物用暖色（warn）：它是这个房间里「花钱」的那条，最该被一眼看到
    case 'gift':
      return palette.warn
    case 'stats':
      return palette.axis
    case 'control':
      return palette.down
    default:
      return palette.dark ? palette.accent : palette.text
  }
}

/** 事件类型的小图标（用户列表里也用） */
export function kindIcon(kind: DanmakuKind, size = 12): React.JSX.Element {
  switch (kind) {
    case 'member':
      return <RiLoginCircleLine size={size} />
    case 'social':
      return <RiAddCircleLine size={size} />
    case 'gift':
      return <RiGiftLine size={size} />
    default:
      return <RiHeartLine size={size} />
  }
}
