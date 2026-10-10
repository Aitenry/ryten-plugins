import { useState } from 'react'
import { Button, Dropdown, Input, Switch } from 'antd'
import {
  RiAddLine,
  RiDeleteBin6Line,
  RiMoreLine,
  RiPlayCircleLine,
  RiRefreshLine,
  RiStopCircleLine
} from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { RoomRuntime } from '../../shared/types'
import { FitList, HOVER_BG, Panel, usePluginPalette } from './ui'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** 相位 → 显示文案与颜色（颜色一律取调色板） */
function phaseMeta(t: Translate, room: RoomRuntime, palette: ReturnType<typeof usePluginPalette>): { text: string; color: string } {
  switch (room.phase) {
    case 'live':
      return { text: t('douyin-link.page.phaseLive'), color: palette.up }
    case 'connecting':
    case 'resolving':
      return { text: t('douyin-link.page.phaseConnecting'), color: palette.warn }
    case 'retrying':
      return { text: t('douyin-link.page.phaseRetrying'), color: palette.warn }
    case 'queued':
      return { text: t('douyin-link.page.phaseQueued'), color: palette.axis }
    case 'error':
      return { text: t('douyin-link.page.phaseError'), color: palette.down }
    case 'ended':
      /**
       * 下播但开关还开着 = **在等它重新开播**（主进程每分钟探测一次，开播就自动拉起）。
       * 这两种状态必须分得开：旧版下播会把开关一起关掉，用户看到的是「监控莫名其妙停了」。
       */
      return room.monitor
        ? { text: t('douyin-link.page.phaseWaiting'), color: palette.warn }
        : { text: t('douyin-link.page.phaseEnded'), color: palette.axis }
    default:
      return { text: t('douyin-link.page.phaseOff'), color: palette.axis }
  }
}

/**
 * 左栏：**房间清单**（这个分析器的入口）。
 *
 * 一行 = 一个直播间：相位点、标题、房间号与速率、库里累计、监控开关、更多操作。
 * 点整行 = 把它设为「分析中的房间」（页签跟着它）。
 *
 * 列表用 `FitList`（贪心塞行 + 「还有 N 个」）而不是滚动条：插件页面不该出滚动条
 * （见 WORKSHOP 第 6 节）。房间数一般是个位数，真多了也是「先看前几个」更合理。
 */
export function RoomRail(props: {
  rooms: RoomRuntime[]
  activeRoom: string
  busy: boolean
  onAdd: (input: string) => void
  onSelect: (webRid: string) => void
  onToggleMonitor: (webRid: string, on: boolean) => void
  onMonitorAll: (on: boolean) => void
  onRefresh: (webRid: string) => void
  onRemove: (webRid: string, purge: boolean) => void
  onClearMessages: (webRid: string) => void
}): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as unknown as Translate
  const palette = usePluginPalette()
  const [draft, setDraft] = useState('')

  const add = (): void => {
    const value = draft.trim()
    if (!value) return
    props.onAdd(value)
    setDraft('')
  }

  const monitoring = props.rooms.some((room) => room.monitor)

  /**
   * 列表顺序 = 加入时间倒序（新加的在上），**点选不改顺序**（用户反馈：点一下房间就跳到最上面）。
   *
   * 主进程也这么排（`hub.buildRooms`），这里再排一次是因为**主进程模块只在应用启动时加载**：
   * 重装插件只换渲染层，主进程那段旧排序还在跑——列表顺序不该依赖「用户有没有重启应用」。
   * 两边键相同，重启后也不会互相打架。
   */
  const ordered = [...props.rooms].sort((a, b) => b.addedAt - a.addedAt)

  return (
    <Panel className="min-h-0 flex-1" title={t('douyin-link.page.rooms', { count: props.rooms.length })}>
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex shrink-0 items-center gap-2">
          <Input
            size="small"
            value={draft}
            placeholder={t('douyin-link.page.addPlaceholder')}
            onChange={(event) => setDraft(event.target.value)}
            onPressEnter={add}
          />
          <Button
            size="small"
            type="primary"
            icon={<RiAddLine size={14} />}
            loading={props.busy}
            title={t('douyin-link.page.add')}
            aria-label={t('douyin-link.page.add')}
            onClick={add}
          />
          <Button
            size="small"
            type="text"
            loading={props.busy}
            title={monitoring ? t('douyin-link.page.monitorStopAll') : t('douyin-link.page.monitorAll')}
            aria-label={monitoring ? t('douyin-link.page.monitorStopAll') : t('douyin-link.page.monitorAll')}
            icon={monitoring ? <RiStopCircleLine size={16} /> : <RiPlayCircleLine size={16} />}
            onClick={() => props.onMonitorAll(!monitoring)}
          />
        </div>

        {props.rooms.length === 0 ? (
          <span className="px-1 py-3 text-xs opacity-60">{t('douyin-link.page.emptyRooms')}</span>
        ) : (
          <FitList
            items={ordered}
            rowHeight={62}
            keyOf={(room) => room.webRid}
            moreLabel={(count) => t('douyin-link.page.moreRooms', { count })}
            renderItem={(room) => (
              <RoomRow
                room={room}
                active={room.webRid === props.activeRoom}
                palette={palette}
                t={t}
                onSelect={() => props.onSelect(room.webRid)}
                onToggleMonitor={(on) => props.onToggleMonitor(room.webRid, on)}
                onRefresh={() => props.onRefresh(room.webRid)}
                onRemove={(purge) => props.onRemove(room.webRid, purge)}
                onClearMessages={() => props.onClearMessages(room.webRid)}
              />
            )}
          />
        )}
      </div>
    </Panel>
  )
}

function RoomRow(props: {
  room: RoomRuntime
  active: boolean
  palette: ReturnType<typeof usePluginPalette>
  t: Translate
  onSelect: () => void
  onToggleMonitor: (on: boolean) => void
  onRefresh: () => void
  onRemove: (purge: boolean) => void
  onClearMessages: () => void
}): React.JSX.Element {
  const { room, palette, t } = props
  const phase = phaseMeta(t, room, palette)
  // 标题 = 主播名 + 直播间标题：只有直播间标题根本认不出是哪个直播间（用户反馈）
  const label = room.title || room.note || room.webRid
  const title = room.anchor ? `${room.anchor} · ${label}` : label

  return (
    <div
      data-rb-row=""
      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5"
      style={{
        cursor: 'pointer',
        backgroundColor: props.active ? HOVER_BG : undefined,
        borderLeft: `2px solid ${props.active ? palette.accent : 'transparent'}`
      }}
      onClick={props.onSelect}
    >
      <span
        className="shrink-0 rounded-full"
        title={phase.text}
        style={{ width: 7, height: 7, backgroundColor: phase.color }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 truncate text-xs font-medium">{title}</span>
        <span className="min-w-0 truncate text-[10px] opacity-60">
          {room.webRid} · {phase.text} · {t('douyin-link.page.rate', { rate: room.rate })} ·{' '}
          {t('douyin-link.page.storedCount', { count: room.stored.messages })}
        </span>
      </div>
      <div className="shrink-0" onClick={(event) => event.stopPropagation()}>
        <Switch size="small" checked={room.monitor} onChange={props.onToggleMonitor} />
      </div>
      <Dropdown
        trigger={['click']}
        menu={{
          items: [
            { key: 'refresh', icon: <RiRefreshLine size={13} />, label: t('douyin-link.page.refresh') },
            {
              key: 'clear',
              icon: <RiDeleteBin6Line size={13} />,
              label: t('douyin-link.page.clearRoomMessages')
            },
            { type: 'divider' },
            { key: 'remove', label: t('douyin-link.page.remove') },
            { key: 'remove-all', danger: true, label: t('douyin-link.page.removeData') }
          ],
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation()
            if (key === 'refresh') props.onRefresh()
            else if (key === 'clear') props.onClearMessages()
            else if (key === 'remove') props.onRemove(false)
            else if (key === 'remove-all') props.onRemove(true)
          }
        }}
      >
        <Button
          size="small"
          type="text"
          icon={<RiMoreLine size={14} />}
          onClick={(event) => event.stopPropagation()}
        />
      </Dropdown>
    </div>
  )
}
