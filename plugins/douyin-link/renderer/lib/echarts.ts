/**
 * ECharts 的**唯一注册点**（按需引入，控制打进插件包的体积）。
 *
 * 为什么按需：`echarts` 不在 `scripts/build.mjs` 的 `RENDERER_VENDOR` 名单里，
 * 会被 esbuild 从 node_modules **打进插件的 renderer chunk**——全量 echarts 约 1MB，
 * 只 `use()` 用到的图表/组件/渲染器能砍掉一大半。
 *
 * 本插件用到的：
 * - 图表：`BarChart`（趋势堆叠柱 / 消息类型 / 动态排序 / 礼物均价）、`LineChart`（日内走势多折线）；
 * - 组件：`GridComponent`（直角坐标系）、`TooltipComponent`（所有 hover 明细）、`LegendComponent`（图例）、
 *   `DataZoomComponent`（日内走势图底部滑块，对照 echarts 的 intraday-breaks-1）、
 *   `GraphicComponent`（动态排序柱状图的大号时间水印，对照 bar-race-country）；
 * - 渲染器：`CanvasRenderer`。
 *
 * 明细面板走 tooltip 的自定义 `formatter`（返回 HTML），高亮走逐点 `itemStyle`。
 *
 * 这个模块只被 `components/EChart.tsx` 用 `await import()` 动态引入，所以 echarts 会落进
 * 独立的 `chunk-*.mjs`，**不会进 renderer 入口**（入口在应用启动时就会被宿主加载）。
 */
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  GraphicComponent
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

import type { BarSeriesOption, LineSeriesOption } from 'echarts/charts'
import type {
  GridComponentOption,
  TooltipComponentOption,
  LegendComponentOption,
  DataZoomComponentOption,
  GraphicComponentOption
} from 'echarts/components'
import type { ComposeOption } from 'echarts/core'

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  GraphicComponent,
  CanvasRenderer
])

export { echarts }

/** 本插件用到的 option 类型（只含已注册的系列/组件） */
export type ChartOption = ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
  | DataZoomComponentOption
  | GraphicComponentOption
>