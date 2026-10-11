/**
 * 「概览 → 分钟趋势的图例，点掉之后过一会儿又自己亮回来」的回归工装（dev-only，不参与打包）。
 *
 * 用户 2026-10-11 原话：「概览的 tab 页下的分钟趋势，点击这个内容，过一会被重置了」。
 * 机制：这张图每 2 秒收到一次 `summary` 推送 → 每次 `setOption(新option, { notMerge: true })`
 * 整体替换 → ECharts 把**图例的开关状态**一起清掉（`notMerge` 的语义就是「当作全新图」）。
 *
 * 这个脚本用**真的 echarts**（`lib/echarts.ts` 里注册的那一份）+ **真的修复函数**
 * （`components/EChart.tsx` 导出的 `applyLegendSelection`）跑三组断言，跑法：
 *
 *   node plugins/douyin-link/spike/legend-persist-check.mjs
 *
 * 用的是 echarts 的 **SSR 模式**（`init(null, null, { renderer: 'svg', ssr: true })`）：
 * 不需要浏览器、不需要 canvas，纯 Node 就能跑出真图真状态。
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const workDir = mkdtempSync(join(tmpdir(), 'douyin-legend-'))

/** 只把「真 echarts + 真修复函数」打进来；React 之类不需要，`EChart.tsx` 里只是 import 不会执行 */
const entry = join(workDir, 'entry.ts')
writeFileSync(
  entry,
  `
import { echarts as core } from ${JSON.stringify(join(PLUGIN, 'renderer/lib/echarts.ts').replace(/\\/g, '/'))}
import { SVGRenderer } from 'echarts/renderers'
// 插件在浏览器里用 canvas；这里跑无头 SSR，补注册 SVG 渲染器（不动插件本身）
core.use([SVGRenderer])
export const echarts = core
export { applyLegendSelection, readLegendSelected } from ${JSON.stringify(join(PLUGIN, 'renderer/components/EChart.tsx').replace(/\\/g, '/'))}
`,
  'utf8'
)

const outfile = join(workDir, 'bundle.mjs')
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'warning',
  // 入口文件在系统临时目录里，`echarts/renderers` 这类子路径要从仓库的 node_modules 解析
  nodePaths: [join(HERE, '../../../node_modules')]
  // React 只是被 import、运行不到（这里不挂载组件），跟着打进 bundle，避免临时目录解析不到 node_modules
})

const { echarts, applyLegendSelection, readLegendSelected } = await import(pathToFileURL(outfile).href)

const KEYS = ['弹幕', '进场', '点赞', '关注', '礼物']

/** 造一份和分钟趋势同形状的 option（图例 + 五条堆叠柱） */
const makeOption = (tick) => ({
  animation: false,
  grid: { left: 36, right: 10, top: 24, bottom: 18 },
  legend: { top: 0, icon: 'roundRect', itemWidth: 8, itemHeight: 8, itemGap: 12 },
  tooltip: { trigger: 'axis' },
  xAxis: { type: 'category', data: ['00:00', '00:01', '00:02'] },
  yAxis: { type: 'value' },
  series: KEYS.map((name, index) => ({
    name,
    type: 'bar',
    stack: 'total',
    data: [index + tick, index + tick + 1, index + tick + 2]
  }))
})

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`)
}

const selectedOf = (chart) => {
  const option = chart.getOption()
  const legend = Array.isArray(option.legend) ? option.legend[0] : option.legend
  const selected = legend?.selected ?? {}
  // 只保留「被关掉」的那些，断言更直观
  return Object.entries(selected)
    .filter(([, on]) => on === false)
    .map(([name]) => name)
    .sort()
}

const newChart = () => echarts.init(null, null, { renderer: 'svg', ssr: true, width: 420, height: 240 })

console.log('工装：真 echarts（SSR）+ 真 applyLegendSelection\n')

/* ------------------------------------------------------------------ 1. 复现 bug */

console.log('[1] 修复前的行为（直接 notMerge 整体替换）——复现用户看到的「点完被重置」')
{
  const chart = newChart()
  chart.setOption(makeOption(1), { notMerge: true })
  chart.dispatchAction({ type: 'legendToggleSelect', name: '点赞' })
  chart.dispatchAction({ type: 'legendToggleSelect', name: '礼物' })
  check('点掉「点赞」「礼物」之后，实例记住了', selectedOf(chart), ['礼物', '点赞'].sort())

  // 模拟 2 秒后的一次推送：新 option 对象 + notMerge: true（旧代码就是这么干的）
  chart.setOption(makeOption(2), { notMerge: true })
  check('推送一次之后……被重置回全亮（这就是 bug）', selectedOf(chart), [])
  chart.dispose()
}

/* ------------------------------------------------------------ 2. 修复后：保得住 */

console.log('\n[2] 修复后（EChart 现在会先读回图例选择再替换）')
{
  const chart = newChart()
  const push = (tick) => chart.setOption(applyLegendSelection(makeOption(tick), readLegendSelected(chart)), { notMerge: true })

  push(1)
  chart.dispatchAction({ type: 'legendToggleSelect', name: '点赞' })
  chart.dispatchAction({ type: 'legendToggleSelect', name: '礼物' })
  push(2)
  check('第 1 次推送后仍然关着', selectedOf(chart), ['礼物', '点赞'].sort())
  push(3)
  check('第 2 次推送后仍然关着', selectedOf(chart), ['礼物', '点赞'].sort())
  push(4)
  check('第 3 次推送后仍然关着', selectedOf(chart), ['礼物', '点赞'].sort())
  check('图例开关没有影响数据本身（仍是 5 条系列）', chart.getOption().series.length, 5)
  chart.dispose()
}

/* ------------------------------------------------- 3. 新 option 里显式写的优先 */

console.log('\n[3] 如果调用方在新 option 里显式写了 selected，以它为准')
{
  const chart = newChart()
  chart.setOption(makeOption(1), { notMerge: true })
  chart.dispatchAction({ type: 'legendToggleSelect', name: '弹幕' })
  const explicit = makeOption(2)
  explicit.legend.selected = { 弹幕: true, 进场: false }
  chart.setOption(applyLegendSelection(explicit, { 弹幕: true, 点赞: false }), { notMerge: true })
  check('显式写的（进场=false）与保留的（点赞=false）都在，弹幕被显式打开', selectedOf(chart), ['进场', '点赞'].sort())
  chart.dispose()
}

/* --------------------------------------------------- 4. 主题切换（整体替换）也保得住 */

console.log('\n[4] 主题切换走的是 notMerge: true，同样要保住用户的选择')
{
  const chart = newChart()
  chart.setOption(makeOption(1), { notMerge: true })
  chart.dispatchAction({ type: 'legendToggleSelect', name: '关注' })
  chart.setOption(applyLegendSelection(makeOption(2), readLegendSelected(chart)), { notMerge: true })
  check('主题切换后「关注」还是关着', selectedOf(chart), ['关注'])
  chart.dispose()
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)


