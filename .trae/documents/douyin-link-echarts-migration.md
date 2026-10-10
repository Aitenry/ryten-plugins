# douyin-link：图表分析全部改用 ECharts

## Context（为什么做）

用户要求「这个插件里面的**图表分析，全部使用 echarts 来构建**」。当前 douyin-link 的所有图表都是**手写 SVG / div + CSS**（无任何图表库）：维护成本高、交互（tooltip / 图例 / 换位动画）要自己造、观感与「图表」预期有差距。本次把这些**真正的图表**统一迁到 ECharts（按需引入 + 主题跟随调色板），保留现有交互（hover 明细、播放/暂停+时间轴、配色身份）。

约束（已核实）：
- 构建：`scripts/build.mjs` 的 `RENDERER_VENDOR = react, react-dom, antd, @remixicon/react, @ant-design/icons, dayjs`。**`echarts` 不在名单里 → esbuild 会从 node_modules 打进包**（期望行为，不动 build；也不去改宿主 `host-ui.ts`）。渲染层经 blob 加载，`absolutizeChunkSpecifiers` 会把 `import('./chunk-x.mjs')` 改写成 `plugin://<id>/chunk-x.mjs`。
- 主题：`ui.tsx` 的 `PluginPalette` + `usePluginPalette()`（字段 `dark/accent/up/down/warn/border/split/soft/track/axis/text/surface`），随宿主主题变化重渲染；`OverviewPanel` 另用 antd `theme.useToken()` 取 `colorBgElevated/boxShadowSecondary`。
- CSP：允许内联样式，canvas/SVG 本地渲染无障碍。

## 范围

**迁移（真正的图表）**：
- `OverviewPanel.tsx` → `TrendChart`、`KindBars`
- `MetricsPanel.tsx` → `BarRace`、`IntradayChart`、`HourBars`
- `AllRoomsPanel.tsx` 复用 `TrendChart`（调用签名保持/同步）

**保留为列表（不迁移）**：`GiftRankBoard`、`RankList`（OverviewPanel）、`GiftTypeList`（AllRoomsPanel）、`RevenueRank`（MetricsPanel）。它们是**可点的行**（点开用户礼物历史 / 切换直播间），行内 `h-1.5 w-14` 微条只是比例指示；改成画布会丢掉 `<button>` 语义、键盘可达、`title`、`truncate` 与 `[data-rb-scroll]`+`ScrollStyle` 的滚动契约，收益远小于风险。（若坚持要，唯一可行方案是横向 BarChart + `yAxis.inverse` + `dataZoom type:'inside'` + `onEvents.click → rows[dataIndex]`，本次不做。）

## 实现步骤

### 1. 依赖与注册表（新增）
- `package.json`：`npm i -D echarts`（本仓第三方一律放 devDependencies）。
- 新增 `renderer/lib/echarts.ts`（唯一注册点，按需引入控体积）：
  ```ts
  import * as echarts from 'echarts/core'
  import { BarChart, LineChart } from 'echarts/charts'
  import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
  import { CanvasRenderer } from 'echarts/renderers'
  echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])
  export { echarts }
  export type { EChartsOption } from 'echarts'
  ```
  只注册用到的：Bar/Line、Grid/Tooltip/Legend、Canvas。**不引** DataZoom / MarkLine / Graphic（BarRace 用现有 antd `Slider`；峰值高亮用逐点 `itemStyle`；明细面板用 tooltip `formatter` 返回 HTML）。

### 2. 共享 wrapper（新增 `renderer/components/EChart.tsx`）
```ts
EChart(props: { option: EChartsOption; notMerge?: boolean; themeKey?: string;
                onEvents?: Record<string, (p: unknown) => void>; className?: string })
```
- **动态 import** `../lib/echarts`（`await import(...)`）→ 靠 `splitting:true` 拆成 `chunk-*.mjs`，**echarts 不进 renderer 入口**（入口在应用启动即被加载）。
- 生命周期：mount 后 `echarts.init(div, undefined, {renderer:'canvas'})`；自带 `ResizeObserver`（宽高为 0 时跳过）→ `chart.resize()`；卸载 `disconnect()`+`dispose()`。
- `option` 变 → `setOption(option, { notMerge })`；`themeKey` 变 → 强制 `notMerge:true` 重设；`onEvents` 变 → 先 `chart.off()` 再逐个 `on()`。
- 容器 `className="h-full w-full min-h-0"`。迁移后 `ui.tsx` 的 `ChartBox` 在本插件内不再被图表使用（**保留不删**，避免牵连其它引用/验收）。
  注：组件直接放在 `components/` 而非 `lib/`，与现有组件同目录，便于 import。

### 3. 逐图迁移映射
- **TrendChart** → 堆叠 `BarChart`：`xAxis:{type:'category', data: bucketLabels}`（**保留**现有 `bucket`（≤60 根）与 `bucketLabel` 拼接逻辑），`yAxis` 开 `splitLine(palette.split)` + `axisLabel(palette.axis,10)`；5 个 `series` 全 `stack:'total'`，颜色沿用 `colors`（chat=accent / member=up / like=down / social=axis / gift=warn）；原生 `legend`（`icon:'rect'`, 8px, 字号 10）替换手写图例；`tooltip:{trigger:'axis', axisPointer:虚线 accent}`，`formatter` 返回 HTML 复刻现在「时间段+合计 / 各系列左右对齐」的面板，`backgroundColor=token.colorBgElevated`、`borderColor=palette.split`、`textStyle.color=palette.text`、`extraCssText` 给 148 宽/圆角/阴影。
- **KindBars** → 横向 `BarChart`：`yAxis type:'category'`、隐藏 x 轴网格；`showBackground:true` + `backgroundStyle.color=palette.track`、`itemStyle:{color:palette.accent, borderRadius:999}`、`label:{position:'right', formatter:'值 · N%'}`。
- **BarRace** → `BarChart`：`yAxis:{type:'category', inverse:true, animationDurationUpdate:RACE_TICK_MS}` + `series[0].realtimeSort:true`。**游标状态机完全不动**（`cursor/playing`、`RACE_TICK_MS` 的 `setInterval`、`toggle()`、antd `Button`/`Slider`）；每个 tick 用现有 `cumulative/order` 重算 data 并 `setOption(option,{notMerge:false})`，换位交给 realtimeSort+过渡。每房颜色用 data item `itemStyle.color=colorOf.get(webRid)`；值 `label:{position:'right', formatter:formatNumber}`。（`yAxis.axisLabel` 逐条上色不支持：房名统一 `palette.axis`，身份靠条形色承载。）
- **IntradayChart** → 多系列 `LineChart`：每房一条 `{showSymbol:false, lineStyle:{width:1.6}}`；原生 `legend type:'scroll'`；`tooltip trigger:'axis'` 的自定义 `formatter` 内按值**降序**（复刻现在 `hoverRows`）渲染彩色块+名字+数值；保留 `LINE_MAX`。
- **HourBars** → `BarChart`：`xAxis category` 0..23（`axisLabel.formatter` 每 6 小时 + 末位 23）；`tooltip trigger:'item'`（替代现在 `title`）；逐点 `itemStyle.color = value<=0 ? palette.track(opacity .4) : hour===peakHour ? palette.warn : palette.accent`，`borderRadius:[2,2,0,0]`。

### 4. AllRoomsPanel
`TrendChart` 调用签名保持；若 wrapper 不再需要 `size`（改自带 ResizeObserver），同步去掉 `<ChartBox>` 包裹（OverviewPanel 第 193 行、AllRoomsPanel 第 126 行）。

### 5. 顺带：先前已修未提交的 3 个 bug
本工作区当前还带着上一轮已改未提交的修复：`MetricsPanel.tsx`（i18n 键 `douyin-link.page.metrics.*`）、`ui.tsx`/`RoomRail.tsx`/`Page.tsx`（`roomLabel` 用主播名 + `cleanName` 兜占位串）、`main/douyin/room.ts`（源头清洗 `$undefined`）。本次一并纳入。

### 6. 版本与发布
- `manifest.ts` 版本 `0.15.4 → 0.15.5`（产物增大）。
- 收尾：`chore(douyin-link): bump version to 0.15.5` → 合并 main → push → tag `v0.1.37` 触发 CI 发布。

## 关键文件
- 新增：`plugins/douyin-link/renderer/lib/echarts.ts`、`plugins/douyin-link/renderer/components/EChart.tsx`
- 改：`renderer/components/OverviewPanel.tsx`、`renderer/components/MetricsPanel.tsx`、`renderer/components/AllRoomsPanel.tsx`、`manifest.ts`、`package.json`
- 参考（不改）：`scripts/build.mjs`（`RENDERER_VENDOR` / 裸模块打包 / chunk 绝对化）、`renderer/components/ui.tsx`（`PluginPalette`/`usePluginPalette`/`ChartBox`）

## 验证
1. `npm run typecheck` 通过。
2. `node scripts/build.mjs --plugin douyin-link`：`renderer.mjs` 入口体积基本不变、新增含 echarts 的 `chunk-*.mjs`（入口里**不应**出现 echarts）；`--dev` 复查 chunk 可读。
3. 手测（加载插件）：
   - 概览趋势：结构化 tooltip、图例、>60 根分桶正确；`KindBars` 百分比标签。
   - 指标页：BarRace 播放/暂停/拖动滑杆 + 换位动画 + 固定配色；日内图 tooltip 降序 + 图例滚动；小时图峰值色 + tooltip。
   - 两个榜单点击仍分别打开礼物历史 / 切换直播间（保持不变）。
   - 明暗主题切换不闪、不残留旧色；窗口缩放 canvas 清晰、无整页滚动条。