import { useMemo } from 'react'
import { theme as antdTheme } from 'antd'
import { useTheme } from '@host/renderer/hooks/useTheme'

/**
 * 插件的配色表：**唯一真源**，界面里的每个颜色都从这里取，组件里不出现字面量色值。
 *
 * 为什么必须这么做（用户反馈 2026-09-28：「没有适配黑暗主题」）：
 * 插件页面里原先写死了几十个浅色（`bg-[#fcfcfd]`、`border-[#ededed]`、图表的
 * `fill="#9ca3af"` / `stroke="#f0f0f0"`、金额的 `#16a34a` / `#ef4444` …）。
 * 宿主切到暗色时，antd 组件跟着 `darkAlgorithm` 变暗、页面底色也变暗，而这些写死的
 * 浅色留在原地 —— 卡片成了「白底白字」、网格线比背景还亮、深绿金额在深底上看不清。
 *
 * 为什么不靠 Tailwind 的 `dark:` 变体：工坊编 `plugin.css` 用的是
 * `tailwindcss/theme + utilities`（见宿主 workshop/css.ts 的 TAILWIND_ENTRY，
 * 里面没有 `@custom-variant dark`），所以 `dark:` 走的是 Tailwind 默认的
 * **`prefers-color-scheme` 媒体查询**，而宿主是靠 `document.documentElement` 上的
 * `.dark` 类 + antd `darkAlgorithm` 切换主题的（见宿主 ThemeContext.tsx；主题模式还支持
 * 「跟随时间」的 auto，与操作系统配色无关）。两者对不上：
 * 应用暗色 + 系统亮色 → 插件仍画浅色；应用亮色 + 系统暗色 → 插件反而画暗色。
 *
 * 所以：
 * - **中性色**（边框、分隔线、软底、轨道、坐标轴文字、面板底色）一律取 antd token
 *   （`theme.useToken()`）——它们由 `darkAlgorithm` 算好，天然跟着主题走，用户自定义主题也覆盖得到；
 * - **语义色**（涨/跌/警示/主色、收支柱）额外给一份暗色变体：antd 的
 *   colorSuccess/colorError 在暗色下偏灰（`#49aa19`/`#dc4446`），做金额文字对比度不够，
 *   所以这里显式挑过（暗色下整体提亮一档）。暗色判定用宿主 `useTheme()` 的
 *   `effectiveTheme`，与 antd 算法、`.dark` 类**同源**，不会出现三者不一致。
 */
export interface LedgerPalette {
  /** 当前是否暗色主题（少数需要按主题换排版/透明度的场合用） */
  dark: boolean
  /** 收入 / 正向（绿） */
  up: string
  /** 支出 / 负向（红） */
  down: string
  /** 警示（橙黄） */
  warn: string
  /** 主色（紫） */
  accent: string
  /** 收入柱 / 收入色点（比 up 更饱和，做面积用） */
  income: string
  /** 支出柱 / 支出色点（橙） */
  expense: string
  /** 边框（卡片、表框、日历格） */
  border: string
  /** 分隔线 / 图表网格线（比边框更淡） */
  split: string
  /** 软底（指标块这类淡色面板） */
  soft: string
  /** 轨道底色（进度条未填充部分） */
  track: string
  /** 坐标轴 / 次要说明文字 */
  axis: string
  /** 主文字（图表里需要显式给色的文本） */
  text: string
  /** 面板底色（用来「压住」图形元素，例如折线端点的小圆点） */
  surface: string
}

/**
 * 暗色下的语义色：比亮色版整体提亮一档 —— 暗底上要的是「亮而不过曝」，
 * 亮色版的 `#16a34a`/`#ef4444` 放在 `#141414` 上偏闷（对比度 ~3:1，数字还是小字号）。
 */
const DARK_SEMANTIC = {
  up: '#4ade80',
  down: '#f87171',
  warn: '#fbbf24',
  accent: '#a78bfa',
  income: '#22c55e',
  expense: '#fb923c'
}

/**
 * 亮色下的语义色：都按「文字压在面板底色上对比度 ≥ 3:1」挑过一档深色
 * （`#16a34a`/`#f97316` 在白底上只有 3.4 / 2.8，小字号金额偏虚；
 * 收深到 `#15803d`/`#ea580c` 后为 4.9 / 3.5，`_tools/probe-dark.mjs` 会把这条规则量出来）。
 */
const LIGHT_SEMANTIC = {
  up: '#15803d',
  down: '#ef4444',
  warn: '#f59e0b',
  accent: '#8b5cf6',
  income: '#22c55e',
  expense: '#ea580c'
}

/** 不经 hook 的版本（给图表这类纯函数/单测用；组件里请用 useLedgerPalette） */
export function ledgerPalette(dark: boolean, token: LedgerTokens): LedgerPalette {
  const semantic = dark ? DARK_SEMANTIC : LIGHT_SEMANTIC
  return {
    dark,
    ...semantic,
    border: token.colorBorderSecondary,
    split: token.colorSplit,
    soft: dark ? 'rgba(255, 255, 255, 0.04)' : token.colorFillQuaternary,
    track: token.colorFillSecondary,
    axis: token.colorTextTertiary,
    text: token.colorText,
    surface: token.colorBgContainer
  }
}

/** 从 antd token 里取的那几个字段（只声明用到的，避免依赖 antd 内部类型路径） */
export interface LedgerTokens {
  colorBorderSecondary: string
  colorSplit: string
  colorFillQuaternary: string
  colorFillSecondary: string
  colorTextTertiary: string
  colorText: string
  colorBgContainer: string
}

/**
 * 组件里取配色表。**必须在组件体内调用**（用了 hook）：
 *
 * ```tsx
 * const p = useLedgerPalette()
 * <div style={{ backgroundColor: p.soft, borderColor: p.border }} />
 * ```
 */
export function useLedgerPalette(): LedgerPalette {
  const { token } = antdTheme.useToken()
  const { effectiveTheme } = useTheme()
  const dark = effectiveTheme === 'dark'
  return useMemo(() => ledgerPalette(dark, token), [dark, token])
}
