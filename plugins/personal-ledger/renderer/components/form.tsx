import { useMemo } from 'react'
import { Switch, theme, type ModalProps } from 'antd'

/**
 * 表单的**共用骨架**：弹窗高度上限、正文滚动条、字段排版、开关。
 *
 * 为什么必须收成一份（用户反馈：「表单要和『记一笔』保持一致，不然太丑了」）：
 * 插件里有两类弹窗——
 *   ① 「记一笔」（TransactionForm）：一行行紧凑控件（宽 120~240、行内 wrap），插件的**视觉基准**；
 *   ② 通用实体表单（EntityForm：账户 / 分类 / 标签 / 商家 / 预算 / 目标 / 周期账 / 借还 / 存款）。
 * 之前 ② 是「标签在上、控件铺满整宽、一个字段一行」的一列大排面，还带两个副作用：
 * 十个字段的表单要 620px 高（记一笔只有 400px），矮窗口下必滚；`Switch` 在这种
 * **列方向** flex 里被 `align-items: stretch` 拉满整宽，看着像一条横杠（「开关被撑开」）。
 * 现在两边都用这里的原语：同一套行间距（12px）、同一档控件宽度、同一个弹窗宽度与按钮文案，
 * 开关走 `FormSwitch` 的定宽行——不会再被拉伸。
 *
 * 高度上限仍是「标题/按钮固定，正文自己滚」，做法与原因见 `useFormModalProps` 的长注释。
 */

/** 「记一笔」的弹窗宽度，也是所有表单弹窗的基准宽度 */
export const FORM_MODAL_WIDTH = 680

/** 正文可用宽度（弹窗宽 - 左右各 24 的留白），决定一行能放几个字段 */
export const FORM_CONTENT_WIDTH = FORM_MODAL_WIDTH - 48

/** 字段之间的间距（px）：与 `FormRow` 的 `gap-3` 必须一致，否则换行会与预算对不上 */
export const FORM_GAP = 12

/**
 * 字段宽度：按控件类型给固定值，**不用百分比**——
 * 百分比在 `flex-wrap` 里会让每个字段都占满一行，又回到「一列大排面」。
 * 0 = 整行独占（多行文本）；开关自己只有 44px，这里给 120 只是让**折行**时
 * 有个名分（不然它会被当成「整行独占」，一个开关占掉一整行）。
 */
export const FIELD_WIDTH: Record<string, number> = {
  text: 200,
  number: 150,
  select: 180,
  // 树形下拉（TreeSelect）与普通下拉同宽：层级靠缩进表达，不需要额外宽度
  treeSelect: 180,
  date: 150,
  switch: 120,
  textarea: 0
}

/** 字段少时别把弹窗拉成一整条：多字段才用「记一笔」的宽度 */
export function formModalWidth(fieldCount: number): number {
  return fieldCount > 4 ? FORM_MODAL_WIDTH : 460
}

/**
 * 细滚动条：宿主的中性灰 + 半透明轨道，主题（亮/暗）都跟着 antd token 走。
 *
 * 为什么不用 `::-webkit-scrollbar` 写样式：插件的 CSS 是工坊扫源码生成的 Tailwind
 * 产物（`css: auto`），加不了伪元素规则；而 `scrollbar-width` / `scrollbar-color`
 * 是标准属性、能内联，Chromium（Electron）都认。
 * 「表单的滚动条太丑」指的就是弹窗正文那条默认的粗滚动条——正文一超高就会冒出来。
 */
export function useThinScrollbar(): React.CSSProperties {
  const { token } = theme.useToken()
  return useMemo(
    () => ({ scrollbarWidth: 'thin', scrollbarColor: `${token.colorFill} transparent` }),
    [token.colorFill]
  )
}

/**
 * 表单弹窗的「高度上限」：**标题与按钮固定，正文自己滚**。
 *
 * 为什么必须限制：插件里的弹窗正文高度由**内容**决定——「账户」表单 10 个字段约 620px，
 * 加上头/脚与 antd 默认的 `top: 100px`，整块 737px。窗口矮一点（1200×660）就装不下，
 * 此时能滚的是 `.ant-modal-wrap`（`position: fixed; overflow: auto`，铺满整个视口）：
 * 窗口右边缘冒出一条「整页」滚动条，滚的是整个对话框——标题和「保存」按钮一起被滚走，
 * 按钮常常落在视口外点不到。
 *
 * 做法：给弹窗的白面板（antd 6 的语义名 `container`，即 `.ant-modal-container`）一个
 * `max-height` 并让它变成列方向的 flex 容器，正文 `flex:1 / min-height:0 / overflow:auto`，
 * 头脚 `shrink-0` 占住自己的高度，挤出来的空间全给正文，正文超出就在**弹窗内部**滚，
 * 滚动条走 `useThinScrollbar()` 的细样式。
 *
 * 为什么用 flex 而不是给正文写 `max-height: calc(100vh - Npx)`：头/脚高度会随标题行数、
 * 字号、语言变，写死的 N 一旦算少，wrap 的滚动条就又回来了；flex 链跟着容器走，不需要预算。
 * `calc(100vh - 72px)` = top 24 + padding-bottom 24 + 24px 余量。
 *
 * 用法（**变量名保持 `formModalProps`**，静态体检按这个名字认「弹窗有高度上限」）：
 * ```tsx
 * const formModalProps = useFormModalProps()
 * <Modal {...formModalProps} open={…} />
 * ```
 */
export function useFormModalProps(): Pick<ModalProps, 'style' | 'styles'> {
  const scrollbar = useThinScrollbar()
  return useMemo(
    () => ({
      style: { top: 24, paddingBottom: 24 },
      styles: {
        container: {
          display: 'flex',
          flexDirection: 'column',
          maxHeight: 'calc(100vh - 72px)',
          minHeight: 0
        },
        header: { flexShrink: 0 },
        body: { flex: 1, minHeight: 0, overflow: 'auto', ...scrollbar },
        footer: { flexShrink: 0 }
      }
    }),
    [scrollbar]
  )
}

/** 表单正文：一行行往下排（每行自己换行）；行距与「记一笔」一致 */
export function FormBody(props: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-3 pt-2">{props.children}</div>
}

/**
 * 一行字段：`flex-wrap` + `items-start`。
 *
 * `items-start` 是想让**控件按内容宽度**排（而不是被拉伸），
 * 没有它，这一行里宽度小的控件（尤其是开关）会被 `align-items: stretch` 撑开——
 * 「开关被撑开」就是这么来的。
 */
export function FormRow(props: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap items-start gap-3">{props.children}</div>
}

/** 一个带标签的字段：标签在上（小字），控件在下；宽度由调用方按控件类型给 */
export function FormField(props: {
  label?: React.ReactNode
  /** 不给就是「按内容宽度」（开关、行内小控件） */
  width?: number | string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1" style={{ width: props.width ?? 'max-content' }}>
      {props.label ? <span className="truncate text-xs leading-4 opacity-60">{props.label}</span> : null}
      {props.children}
    </div>
  )
}

/**
 * 开关字段：**定宽一行**，与输入框同高（32px）。
 *
 * 不能直接把 `Switch` 丢进 `flex flex-col` 的字段里：列方向 flex 的
 * `align-items: stretch` 会把开关拉满整宽（用户看到的「开关被撑开了」）。
 * 这里外面套一层 `w-max` 的定宽行 + `items-center`，开关永远只有自己的 44px。
 */
export function FormSwitch(props: {
  label?: React.ReactNode
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <FormField label={props.label}>
      <div className="flex h-8 items-center">
        <Switch size="small" checked={props.checked} disabled={props.disabled} onChange={props.onChange} />
      </div>
    </FormField>
  )
}
