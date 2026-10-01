import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, Table, type TableProps } from 'antd'
import { useLedgerPalette } from '../palette'

/**
 * 一页装下的布局原语。
 *
 * 这里所有东西的共同目标：**插件页面永不出滚动条**。
 * 宿主把插件页面挂在 `.frame-body-center`（高度确定）里，所以只要每一层都
 * 「flex + min-height:0 + 不给根节点 overflow」就能严格锁死在窗口内；
 * 至于「内容比窗口多」的情况，靠下面这几个原语**按可用高度自适应**：
 * 表格按高度算每页行数、列表按高度截断并提示「还有 N 项」、图表按容器尺寸重画。
 */

/**
 * 表单弹窗的高度上限（「标题/按钮固定、正文自己滚」）与字段排版**已挪到 `./form.tsx`**：
 * 那里是「记一笔」与实体表单共用的那一份（`useFormModalProps` / `FormRow` / `FormField` /
 * `FormSwitch`）。为什么挪走：弹窗排版原来放在这里，只有一份弹窗用了它，另一份自然长歪了；
 * 收进表单自己的模块之后，两类弹窗只能走同一套原语。
 */

export interface Size {
  width: number
  height: number
}

/** 监听元素尺寸：图表与表格靠它把「可用高度」变成具体像素 */
export function useSize<T extends HTMLElement = HTMLDivElement>(): [React.RefObject<T | null>, Size] {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = (): void => {
      const next = { width: element.clientWidth, height: element.clientHeight }
      setSize((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return [ref, size]
}

/**
 * 填满剩余高度、自身不出滚动条的面板：标题栏固定，正文自己分配剩余空间。
 */
export function Panel(props: {
  title?: React.ReactNode
  extra?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}): React.JSX.Element {
  return (
    <Card
      size="small"
      variant="outlined"
      className={props.className}
      styles={{
        root: { display: 'flex', flexDirection: 'column', minHeight: 0 },
        header: { minHeight: 36, padding: '0 14px', fontSize: 13, fontWeight: 600 },
        body: { flex: 1, minHeight: 0, padding: '12px 14px', display: 'flex', flexDirection: 'column' }
      }}
      title={props.title}
      extra={props.extra}
    >
      <div className={`flex min-h-0 flex-1 flex-col ${props.bodyClassName ?? ''}`}>{props.children}</div>
    </Card>
  )
}

/**
 * 页签内容区：铺满 pane（pane 是 absolute + inset:0，所以 h-full 就够）。
 *
 * 为什么要有这层壳（踩过）：antd 6 里**每个页签各自是一个 `.ant-tabs-content`**，
 * 而且是绝对定位铺满 body 的；页签内部的列布局得由内容自己建。
 * 注意**不要**在 Tabs 的 `styles.content` 上写 `display`（antd 靠
 * `.ant-tabs-content-hidden` 这个**类**隐藏非激活页签，内联样式优先级更高会让隐藏失效，
 * 访问过的页签会全部叠在一起画出来——`_tools/probe-panes.mjs` 就是量这个的）。
 */
export function Pane({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="h-full w-full min-h-0 overflow-hidden">{children}</div>
}

/** 紧凑指标块（比 antd Statistic 省一半高度，适合一排铺开） */
export function Kpi(props: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  tone?: 'default' | 'up' | 'down' | 'accent'
  className?: string
}): React.JSX.Element {
  // 底色/边框走 token（暗色下自动变深），语义色走配色表（见 palette.ts）
  const p = useLedgerPalette()
  const color =
    props.tone === 'up' ? p.up : props.tone === 'down' ? p.down : props.tone === 'accent' ? p.accent : undefined
  return (
    <div
      className={`flex min-w-0 flex-col justify-center gap-1 rounded-xl border border-solid px-4 py-3 ${props.className ?? ''}`}
      style={{ backgroundColor: p.soft, borderColor: p.border }}
    >
      <span className="truncate text-xs leading-[18px] opacity-60">{props.label}</span>
      <span className="truncate text-[19px] font-semibold leading-7 tabular-nums" style={{ color }}>
        {props.value}
      </span>
      {props.hint ? <span className="truncate text-xs leading-4 opacity-50">{props.hint}</span> : null}
    </div>
  )
}

/**
 * 自适应表格：按容器高度算每页行数 → 永远不出纵向滚动条，也不留大片空白。
 * 语义与 antd Table 一致（`table` 直接透传），只是帮忙算 pagination。
 *
 * 这里**不靠猜尺寸**（antd 的表头 / 分页器 / 行高会随版本和字号变，猜两次都被打脸），
 * 而是「估算 + 收敛」：先按经验给个行数，然后在布局完成后量真实高度，
 *   溢出 → 减一行；一行都放不下 → 收起分页器；再放不下 → 不画表格只给提示；
 *   还有富余 → 加一行，直到「剩余空间 < 一行」为止。
 * 因为始终朝「内容 ≤ 容器」这一个方向收敛，所以不会来回抖。
 */
export function FitTable<T extends object>(props: {
  table: TableProps<T>
  /** 只用来做初始估算，真实行高由收敛环量出来 */
  rowHeight?: number
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const rowHeight = props.rowHeight ?? 42
  const [boxHeight, setBoxHeight] = useState(0)
  const [rows, setRows] = useState(1)
  const [pager, setPager] = useState(true)
  const [tooSmall, setTooSmall] = useState(false)
  // 诊断用：算了几次、算出来的容量是多少（看不到界面时，离线验证靠它取证）
  const setsRef = useRef(0)
  const capRef = useRef(0)
  // 部件实测高度（表头 / 行 / 分页器含外边距）。表格没画出来时沿用上次测到的值，
  // 这样「退化」判断不会因为「现在没画表格」而把高度当 0，来回翻。
  const headRef = useRef(39)
  const rowRef = useRef(rowHeight)
  const pagerRef = useRef(56)
  const dataLength = props.table.dataSource?.length ?? 0

  /** 退化显示用：取前几列的纯文本值（够紧凑，也比「一行被截断」可读） */
  const columns = (props.table.columns ?? []).slice(0, 3) as { dataIndex?: string }[]
  const cellText = (row: unknown, column: { dataIndex?: string }): string =>
    column.dataIndex ? String((row as Record<string, unknown>)[column.dataIndex] ?? '') : ''
  const fallbackRows = (props.table.dataSource ?? [])
    .slice(0, Math.max(1, Math.floor(boxHeight / rowHeight) || 1))
    .map((row) => columns.map((column) => cellText(row, column)).filter(Boolean).join(' · '))

  // 容器高度（观察它：窗口/分栏一变就重算）
  useEffect(() => {
    const element = boxRef.current
    if (!element) return
    const update = (): void => setBoxHeight(element.clientHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /**
   * 一次算清能放几行 —— **不是**收敛环。
   *
   * 之前用「量余量 → 加/减一行」的收敛环，在真机上被证明不可靠：
   * 布局会晚于 effect 到位（字体、表格自身的一次性布局），effect 当时量到的余量是 0，
   * 于是它什么都不做，而 650ms 之后元素其实已经溢出 18~54px——`sets: 0` 就是这么来的。
   * 改成「量部件 → 一次算容量」：容量是 `f(容器高, 表头高, 行高, 分页器占高)` 的纯函数，
   * 与「现在画了几行」无关，所以既不需要收敛，也不会来回抖。
   */
  const measure = useCallback((): void => {
    const element = boxRef.current
    if (!element) return
    const thead = element.querySelector('.ant-table-thead')
    const firstRow = element.querySelector('.ant-table-tbody tr')
    const pagination = element.querySelector('.ant-pagination')
    if (thead instanceof HTMLElement) headRef.current = thead.offsetHeight
    if (firstRow instanceof HTMLElement) rowRef.current = firstRow.offsetHeight
    if (pagination instanceof HTMLElement) {
      const cs = getComputedStyle(pagination)
      pagerRef.current =
        pagination.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)
    }
    const headH = headRef.current
    const realRowH = rowRef.current
    const available = element.clientHeight
    if (available <= 0) return
    setsRef.current += 1
    // 连「表头 + 一行」都放不下：退化成几行纯文本（比被裁掉强）
    if (available < headH + realRowH) {
      setTooSmall(true)
      return
    }
    setTooSmall(false)
    const withPager = Math.floor((available - headH - pagerRef.current) / realRowH)
    const withoutPager = Math.floor((available - headH) / realRowH)
    const limit = Math.max(1, dataLength)
    const capacity = withPager >= 1 ? withPager : withoutPager
    capRef.current = capacity
    setPager(withPager >= 1)
    setRows(Math.max(1, Math.min(capacity, limit)))
  }, [dataLength])

  // 高度变了就重算；再补两次延时重算，接住「晚于 effect 才到位」的布局
  useEffect(() => {
    measure()
    const timers = [250, 900].map((delay) => window.setTimeout(measure, delay))
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [boxHeight, measure])

  return (
    <div
      ref={boxRef}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      // 供离线验证读取「它当时算出来的是什么」（看不到界面时唯一的取证手段）
      data-ft-rows={rows}
      data-ft-pager={pager ? 1 : 0}
      data-ft-small={tooSmall ? 1 : 0}
      data-ft-h={Math.round(boxHeight)}
      data-ft-sets={setsRef.current}
      data-ft-cap={capRef.current}
      data-ft-parts={`${headRef.current}/${rowRef.current}/${pagerRef.current}`}
    >
      {tooSmall || boxHeight === 0 ? (
        // 空间连「表头 + 一行」都放不下：不画表格（画了就会被裁），
        // 退化成几行纯文本——比空着、假称「暂无数据」或被截断的一行都有用。
        <div className="flex min-h-0 flex-col gap-1 overflow-hidden">
          {tooSmall
            ? fallbackRows.map((text, index) => (
                <span key={index} className="truncate text-xs opacity-70">
                  {text}
                </span>
              ))
            : null}
        </div>
      ) : (
        <Table<T>
          size="small"
          {...props.table}
          // 分页器放不下时**必须自己截断数据**：`pagination={false}` 的语义是
          // 「不分页」= 把所有行都画出来（实测 3 行 → 156px 塞进 115px 的盒子，被裁 41px）。
          dataSource={pager ? props.table.dataSource : (props.table.dataSource ?? []).slice(0, rows)}
          pagination={
            pager
              ? {
                  size: 'small',
                  pageSize: rows,
                  showSizeChanger: false,
                  ...(props.table.pagination ?? {})
                }
              : false
          }
        />
      )}
    </div>
  )
}

/**
 * 自适应列表：**贪心**塞行——放不下的行一个都不画，剩下的用「还有 N 项」收尾。
 *
 * 为什么不用「算行数」而是贪心：行距、分隔、尾行都会吃掉高度，
 * 贪心能保证「画出来的东西加起来 ≤ 容器高度」这个硬约束，
 * 于是列表永远不会把面板顶破（顶破就意味着要么出滚动条、要么内容被裁）。
 *
 * 注意 `rowHeight` 要**略大于**真实行高（按钮 + 内边距实测值），
 * 声明小了会一点点累积成裁切。
 */
export function FitList<T>(props: {
  items: T[]
  rowHeight: number
  keyOf: (item: T, index: number) => React.Key
  renderItem: (item: T) => React.ReactNode
  empty?: React.ReactNode
  moreLabel?: (count: number) => string
  className?: string
}): React.JSX.Element {
  const [ref, size] = useSize()
  const gap = 6
  const moreHeight = 18
  const available = size.height

  const rendered: T[] = []
  let used = 0
  for (const item of props.items) {
    const need = (rendered.length > 0 ? gap : 0) + props.rowHeight
    if (used + need > available) break
    used += need
    rendered.push(item)
  }

  let more: string | null = null
  if (props.moreLabel && rendered.length < props.items.length) {
    const need = (rendered.length > 0 ? gap : 0) + moreHeight
    if (used + need <= available) {
      more = props.moreLabel(props.items.length - rendered.length)
    } else if (rendered.length > 0) {
      // 回退一行，把「还有 N 项」放进来（它比少显示一行更有用）
      rendered.pop()
      used -= props.rowHeight + gap
      more = props.moreLabel(props.items.length - rendered.length)
    }
  }

  return (
    <div ref={ref} className={`flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden ${props.className ?? ''}`}>
      {props.items.length === 0
        ? props.empty ?? <span className="text-xs opacity-50">-</span>
        : rendered.map((item, index) => (
            <div key={props.keyOf(item, index)} className="min-w-0 shrink-0">
              {props.renderItem(item)}
            </div>
          ))}
      {more ? <span className="shrink-0 text-xs opacity-50">{more}</span> : null}
    </div>
  )
}

/**
 * 图表容器：量好尺寸再把像素交给 SVG（不给 SVG 伸展，避免线条变形）。
 * 刻意**不设最小高度**——容器多矮就画多矮，图表自己降级（见 Charts.tsx），
 * 否则「最小高度」会变成固定高度，把面板顶破。
 */
export function ChartBox(props: {
  children: (size: Size) => React.ReactNode
  className?: string
}): React.JSX.Element {
  const [ref, size] = useSize()
  return (
    <div ref={ref} className={`min-h-0 flex-1 ${props.className ?? ''}`}>
      {size.width > 0 && size.height > 0 ? props.children({ width: size.width, height: size.height }) : null}
    </div>
  )
}

/** 金额格式化：千分位 + 固定两位（负数走红色由调用方决定） */
export function money(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '-'
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
