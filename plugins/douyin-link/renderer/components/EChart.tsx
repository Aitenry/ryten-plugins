import { useEffect, useRef } from 'react'
import type { ChartOption } from '../lib/echarts'

/**
 * ECharts 实例的最小接口（只列用到的）——避免把 echarts 的类型拉进运行时。
 */
interface ChartInstance {
  setOption: (option: ChartOption, opts?: { notMerge?: boolean; lazyUpdate?: boolean }) => void
  getOption: () => unknown
  resize: () => void
  dispose: () => void
  on: (event: string, handler: (params: unknown) => void) => void
  off: (event: string, handler?: (params: unknown) => void) => void
}

/** 图例组件在我们这份 option 里的形状（`selected` = 用户点掉了哪些系列） */
type LegendLike = { selected?: Record<string, boolean> } & Record<string, unknown>

/**
 * 读「用户点掉了哪些系列」。
 *
 * ECharts 把图例的开关状态维护在**实例的 option** 里（点一下图例 → `legend.selected` 变），
 * 所以这里直接从实例读，不用自己记事件（也就不会被调用方传进来的 `onEvents` 顶掉监听）。
 */
export function readLegendSelected(chart: ChartInstance): Record<string, boolean> | null {
  try {
    const current = chart.getOption() as { legend?: LegendLike | LegendLike[] } | undefined
    const legend = Array.isArray(current?.legend) ? current.legend[0] : current?.legend
    const selected = legend?.selected
    return selected && typeof selected === 'object' ? { ...selected } : null
  } catch {
    return null
  }
}

/**
 * 把上一次的图例选择写回新 option。
 *
 * **为什么必须有**（用户 2026-10-11）：「概览 → 分钟趋势，点图例，过一会被重置了」。
 * 原因是这张图每 2 秒收到一次 `summary` 推送、每次都用 `notMerge: true` 整体替换 option
 * （见下面第三个 useEffect），而 `notMerge` 会把图例的开关状态一起清掉 —— 用户点掉「点赞」，
 * 两秒后自己又亮了。同样的坑 `dataZoom` 已经单独处理过（见 MetricsPanel 里那段注释），
 * 图例没有；放在这里统一兜住，所有图表（分钟趋势、日内走势…）都不用再各自记一遍。
 */
export function applyLegendSelection(
  option: ChartOption,
  selected: Record<string, boolean> | null
): ChartOption {
  if (!selected || Object.keys(selected).length === 0) return option
  const mergeOne = (item: ChartOption): ChartOption => {
    const raw = item as unknown as { legend?: LegendLike | LegendLike[] }
    if (!raw.legend) return item
    const list = Array.isArray(raw.legend) ? raw.legend : [raw.legend]
    const merged = list.map((legend) => ({
      ...legend,
      // 新 option 里显式写了的优先（现在的调用方都不写 selected，所以就是原样还原用户的选择）
      selected: { ...selected, ...(legend.selected ?? {}) }
    }))
    return { ...item, legend: Array.isArray(raw.legend) ? merged : merged[0] } as ChartOption
  }
  return (Array.isArray(option) ? (option as ChartOption[]).map(mergeOne) : mergeOne(option)) as ChartOption
}

export interface EChartProps {
  /** ECharts 配置（颜色/文案都从插件调色板算好再传进来） */
  option: ChartOption
  /** 是否整体替换配置（默认 true）。动态排序柱状图传 false 以保留换位/条形过渡动画 */
  notMerge?: boolean
  /** 主题标识（如 `light`/`dark`）：变化时强制整体替换，清掉上一套主题的底色/坐标轴色 */
  themeKey?: string
  /** 图表事件（如点击某根柱子）；未用到时可不传 */
  onEvents?: Record<string, (params: unknown) => void>
  className?: string
  /** 需要显式高度（如自适应内容高度的面板）时用 style 传高度 */
  style?: React.CSSProperties
}

/** 给一个图表实例重新挂事件：先摘掉旧监听，再逐个挂上 */
function applyEvents(chart: ChartInstance, events?: Record<string, (params: unknown) => void>): void {
  for (const name of Object.keys(events ?? {})) chart.off(name)
  if (!events) return
  for (const [name, handler] of Object.entries(events)) chart.on(name, handler)
}

/**
 * ECharts 图表的 React 包装：**自己管尺寸与生命周期**，调用方只管给 `option`。
 *
 * 几个关键点：
 * - **动态 import** `../lib/echarts`：echarts 会被 esbuild 拆进独立的 `chunk-*.mjs`，
 *   不会进 renderer 入口（入口在应用启动时就会被宿主加载）；
 * - 自带 `ResizeObserver` 调 `chart.resize()`（宽高为 0 时跳过——antd 隐藏面板尺寸为 0）；
 * - `option` 变 → `setOption`；`themeKey` 变 → 强制整体替换；卸载 `dispose()`。
 */
export function EChart(props: EChartProps): React.JSX.Element {
  const { option, notMerge = true, themeKey, onEvents, className, style } = props
  const boxRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<ChartInstance | null>(null)
  const optionRef = useRef(option)
  optionRef.current = option
  const eventsRef = useRef(onEvents)
  eventsRef.current = onEvents
  const themeRef = useRef(themeKey)

  // 挂载：动态引入 echarts → 初始化 → 观察尺寸 → 卸载时销毁
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    let alive = true
    let observer: ResizeObserver | null = null
    void import('../lib/echarts').then(({ echarts }) => {
      const node = boxRef.current
      if (!alive || !node) return
      const chart = echarts.init(node, undefined, { renderer: 'canvas' }) as unknown as ChartInstance
      chartRef.current = chart
      const resize = (): void => {
        const box = boxRef.current
        if (box && box.clientWidth > 0 && box.clientHeight > 0) chart.resize()
      }
      observer = new ResizeObserver(resize)
      observer.observe(node)
      chart.setOption(applyLegendSelection(optionRef.current, readLegendSelected(chart)), { notMerge: true })
      applyEvents(chart, eventsRef.current)
      resize()
    })
    return () => {
      alive = false
      observer?.disconnect()
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [])

  // option / 主题变化：重设（主题变了就整体替换）
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const themeChanged = themeRef.current !== themeKey
    themeRef.current = themeKey
    /**
     * 推送把新 option 送进来时，**先读出用户在图上做过的事**（现在是图例的开关状态）再整体替换：
     * 这一行就是「点了图例过一会儿被重置」的修复（见 `applyLegendSelection` 的注释）。
     */
    chart.setOption(applyLegendSelection(option, readLegendSelected(chart)), {
      notMerge: themeChanged ? true : notMerge
    })
  }, [option, notMerge, themeKey])

  // 事件变化：重新挂监听
  useEffect(() => {
    const chart = chartRef.current
    if (chart) applyEvents(chart, onEvents)
  }, [onEvents])

  return <div ref={boxRef} className={'min-h-0 ' + (className ?? 'flex-1 w-full')} style={style} />
}