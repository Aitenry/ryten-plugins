import { useId } from 'react'
import { useLedgerPalette } from '../palette'

/**
 * 手写的极简 SVG 图表（环形图 / 柱状图 / 折线图 / 迷你趋势线）。
 *
 * 两条设计约束：
 * 1. **不能引图表库**：插件产物里只有宿主已有的 vendor（react / antd / 图标 / dayjs），
 *    引 echarts 之类会构建失败。所以这里全是几十行的 SVG。
 * 2. **尺寸由调用方给死**（`width` / `height` 是像素）：配合 `ChartBox` 量出来的容器尺寸，
 *    图表永远刚好填满面板——不会撑出滚动条，也不会拉伸变形（不用 preserveAspectRatio="none"）。
 */
export interface Slice {
  label: string
  value: number
  color: string
}

export interface BarPoint {
  label: string
  income: number
  expense: number
}

/** 轴与留白：左留给数值标签，下留给日期标签 */
const PAD = { left: 46, right: 8, top: 10, bottom: 18 }

function niceMax(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

function shortNumber(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 10000) return `${(value / 10000).toFixed(abs >= 100000 ? 0 : 1)}万`
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}k`
  return `${Math.round(value)}`
}

/**
 * 分组柱状图（收入 vs 支出）。
 * 空间不够时自动降级：矮到放不下刻度就只画柱子，窄到放不下标签就只画首尾。
 */
export function BarChart(props: {
  data: BarPoint[]
  width: number
  height: number
}): React.JSX.Element {
  const p = useLedgerPalette()
  const { width, height, data } = props
  const showYLabels = height >= 66
  const showXLabels = height >= 46
  const pad = showYLabels ? PAD : { left: 4, right: 6, top: 4, bottom: showXLabels ? 14 : 4 }
  const plotWidth = Math.max(4, width - pad.left - pad.right)
  const plotHeight = Math.max(4, height - pad.top - pad.bottom)
  const max = niceMax(Math.max(1, ...data.flatMap((item) => [item.income, item.expense])))
  const baseline = pad.top + plotHeight
  const slot = data.length > 0 ? plotWidth / data.length : plotWidth
  const barWidth = Math.max(2, Math.min(9, slot * 0.32))
  const labelStep = Math.max(1, Math.ceil(data.length / (width < 260 ? 3 : width < 480 ? 5 : 8)))

  return (
    <svg width={width} height={height} role="img">
      {/* 网格线 + 刻度 */}
      {(showYLabels ? [0, 0.25, 0.5, 0.75, 1] : [0]).map((ratio) => {
        const y = pad.top + plotHeight * (1 - ratio)
        return (
          <g key={ratio}>
            <line
              x1={pad.left}
              y1={y}
              x2={pad.left + plotWidth}
              y2={y}
              stroke={p.split}
              strokeWidth={1}
              strokeDasharray={ratio === 0 || !showYLabels ? undefined : '3 3'}
            />
            {showYLabels ? (
              <text x={pad.left - 6} y={y + 3.5} textAnchor="end" fontSize={10} fill={p.axis}>
                {shortNumber(max * ratio)}
              </text>
            ) : null}
          </g>
        )
      })}

      {data.map((item, index) => {
        const centerX = pad.left + slot * (index + 0.5)
        const incomeHeight = (item.income / max) * plotHeight
        const expenseHeight = (item.expense / max) * plotHeight
        return (
          <g key={`${item.label}-${index}`}>
            <rect
              x={centerX - barWidth - 1}
              y={baseline - incomeHeight}
              width={barWidth}
              height={incomeHeight}
              rx={Math.min(2, barWidth / 3)}
              fill={p.income}
              opacity={0.9}
            >
              <title>{`${item.label} · 收入 ${item.income}`}</title>
            </rect>
            <rect
              x={centerX + 1}
              y={baseline - expenseHeight}
              width={barWidth}
              height={expenseHeight}
              rx={Math.min(2, barWidth / 3)}
              fill={p.expense}
              opacity={0.9}
            >
              <title>{`${item.label} · 支出 ${item.expense}`}</title>
            </rect>
            {showXLabels && index % labelStep === 0 ? (
              <text x={centerX} y={height - 4} textAnchor="middle" fontSize={10} fill={p.axis}>
                {item.label}
              </text>
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}

/**
 * 折线 + 面积图（余额 / 净资产走势）。
 * 端点不画圆点阵（点多了像毛刺），只标最后一个点。
 */
export function LineChart(props: {
  values: number[]
  labels: string[]
  width: number
  height: number
  color?: string
}): React.JSX.Element {
  const p = useLedgerPalette()
  const gradientId = useId().replace(/[^a-zA-Z0-9-]/g, '')
  const { width, height, values, labels } = props
  const color = props.color ?? p.accent
  const showYLabels = height >= 60
  const showXLabels = height >= 46
  const pad = showYLabels ? PAD : { left: 4, right: 6, top: 4, bottom: showXLabels ? 14 : 4 }
  const plotWidth = Math.max(4, width - pad.left - pad.right)
  const plotHeight = Math.max(4, height - pad.top - pad.bottom)
  const baseline = pad.top + plotHeight

  if (values.length === 0) {
    return <svg width={width} height={height} role="img" />
  }

  const max = Math.max(...values, 0)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const stepX = values.length > 1 ? plotWidth / (values.length - 1) : 0
  const point = (value: number, index: number): [number, number] => [
    pad.left + index * stepX,
    baseline - ((value - min) / span) * plotHeight
  ]
  const points = values.map(point)
  const line = points.map(([x, y]) => `${x},${y}`).join(' ')
  const area = [
    `M ${points[0][0]} ${baseline}`,
    ...points.map(([x, y]) => `L ${x} ${y}`),
    `L ${points[points.length - 1][0]} ${baseline}`,
    'Z'
  ].join(' ')
  const labelStep = Math.max(1, Math.ceil(values.length / (width < 260 ? 3 : width < 480 ? 5 : 8)))
  const last = points[points.length - 1]

  return (
    <svg width={width} height={height} role="img">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>

      {(showYLabels ? [0, 0.5, 1] : [0]).map((ratio) => {
        const y = pad.top + plotHeight * (1 - ratio)
        return (
          <g key={ratio}>
            <line
              x1={pad.left}
              y1={y}
              x2={pad.left + plotWidth}
              y2={y}
              stroke={p.split}
              strokeWidth={1}
              strokeDasharray={ratio === 0 || !showYLabels ? undefined : '3 3'}
            />
            {showYLabels ? (
              <text x={pad.left - 6} y={y + 3.5} textAnchor="end" fontSize={10} fill={p.axis}>
                {shortNumber(min + span * ratio)}
              </text>
            ) : null}
          </g>
        )
      })}

      {values.length > 1 ? <path d={area} fill={`url(#${gradientId})`} /> : null}
      {values.length > 1 ? (
        <polyline points={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      ) : null}

      <circle cx={last[0]} cy={last[1]} r={3} fill={p.surface} stroke={color} strokeWidth={2}>
        <title>{`${labels[labels.length - 1] ?? ''}: ${values[values.length - 1]}`}</title>
      </circle>

      {labels.map((label, index) =>
        showXLabels && index % labelStep === 0 ? (
          <text
            key={`${label}-${index}`}
            x={point(values[index], index)[0]}
            y={height - 4}
            textAnchor="middle"
            fontSize={10}
            fill={p.axis}
          >
            {label}
          </text>
        ) : null
      )}
    </svg>
  )
}

/** 环形图（分类占比）：中心留白显示总额或占比项数 */
export function PieChart(props: {
  data: Slice[]
  size: number
  thickness?: number
  centerLabel?: string
  centerValue?: string
}): React.JSX.Element {
  const size = props.size
  const p = useLedgerPalette()
  const radius = size / 2
  const outer = radius - 2
  const thickness = props.thickness ?? Math.max(18, radius * 0.34)
  const inner = Math.max(6, outer - thickness)
  const center = radius
  const total = props.data.reduce((sum, item) => sum + Math.max(0, item.value), 0)

  if (total <= 0) {
    return (
      <svg width={size} height={size} role="img">
        <circle cx={center} cy={center} r={(outer + inner) / 2} fill="none" stroke={p.split} strokeWidth={thickness} />
      </svg>
    )
  }

  let angle = -Math.PI / 2
  const arcs = props.data
    .filter((item) => item.value > 0)
    .map((item) => {
      const sweep = (item.value / total) * Math.PI * 2
      const start = angle
      const end = angle + sweep
      angle = end
      const large = sweep > Math.PI ? 1 : 0
      const x1 = center + outer * Math.cos(start)
      const y1 = center + outer * Math.sin(start)
      const x2 = center + outer * Math.cos(end)
      const y2 = center + outer * Math.sin(end)
      const x3 = center + inner * Math.cos(end)
      const y3 = center + inner * Math.sin(end)
      const x4 = center + inner * Math.cos(start)
      const y4 = center + inner * Math.sin(start)
      const d = [
        `M ${x1} ${y1}`,
        `A ${outer} ${outer} 0 ${large} 1 ${x2} ${y2}`,
        `L ${x3} ${y3}`,
        `A ${inner} ${inner} 0 ${large} 0 ${x4} ${y4}`,
        'Z'
      ].join(' ')
      return { d, color: item.color, label: item.label, value: item.value, share: item.value / total }
    })

  return (
    <svg width={size} height={size} role="img">
      {arcs.map((arc) => (
        <path key={arc.label} d={arc.d} fill={arc.color}>
          <title>{`${arc.label}: ${arc.value.toFixed(2)}（${Math.round(arc.share * 100)}%）`}</title>
        </path>
      ))}
      {props.centerValue ? (
        <text x={center} y={center - 2} textAnchor="middle" fontSize={15} fontWeight={600} fill={p.text}>
          {props.centerValue}
        </text>
      ) : null}
      {props.centerLabel ? (
        <text x={center} y={center + 14} textAnchor="middle" fontSize={10} fill={p.axis}>
          {props.centerLabel}
        </text>
      ) : null}
    </svg>
  )
}

/** 图例：色点 + 名称 + 金额 + 占比条（一眼看出谁是大头） */
export function Legend(props: { data: Slice[]; currency: string; digits?: number }): React.JSX.Element {
  const total = props.data.reduce((sum, item) => sum + Math.max(0, item.value), 0)
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
      {props.data.map((item) => {
        const share = total > 0 ? Math.max(0, item.value) / total : 0
        return (
          <li key={item.label} className="flex min-w-0 items-center gap-3">
            <span
              className="inline-block h-[8px] w-[8px] shrink-0 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            <span className="shrink-0 tabular-nums opacity-70">
              {item.value.toFixed(props.digits ?? 2)} {props.currency}
            </span>
            <span className="w-[46px] shrink-0 text-right tabular-nums opacity-45">
              {Math.round(share * 100)}%
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** 迷你趋势线（指标块右侧用，纯装饰但能看出走势） */
export function Sparkline(props: {
  values: number[]
  width: number
  height: number
  color?: string
}): React.JSX.Element {
  const p = useLedgerPalette()
  const { values, width, height } = props
  if (values.length < 2) return <svg width={width} height={height} role="img" />
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const stepX = width / (values.length - 1)
  const points = values
    .map((value, index) => `${index * stepX},${height - 2 - ((value - min) / span) * (height - 4)}`)
    .join(' ')
  return (
    <svg width={width} height={height} role="img">
      <polyline
        points={points}
        fill="none"
        stroke={props.color ?? p.accent}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * 横向占比条（预算 / 目标 / 使用率）。
 * 超过 100% 变红，80% 起变橙——这是记账里最需要一眼看出来的两件事。
 */
export function ProgressBar(props: {
  ratio: number
  label?: string
  size?: 'sm' | 'md'
}): React.JSX.Element {
  const p = useLedgerPalette()
  const ratio = Number.isFinite(props.ratio) ? props.ratio : 0
  const percent = Math.max(0, Math.min(1, ratio))
  const danger = ratio > 1
  const warning = !danger && ratio >= 0.8
  const height = props.size === 'md' ? 8 : 6
  return (
    <div
      className="w-full overflow-hidden rounded-full"
      style={{ height, backgroundColor: p.track }}
      title={props.label}
    >
      <div
        className="h-full rounded-full transition-all"
        style={{
          width: `${Math.round(percent * 100)}%`,
          backgroundColor: danger ? p.down : warning ? p.warn : p.accent
        }}
      />
    </div>
  )
}
