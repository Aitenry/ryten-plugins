import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Tooltip, Tree, type TreeDataNode } from 'antd'
import { RiDeleteBin6Line, RiEditLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { Category } from '../../shared/types'
import { buildCategoryTree, buildVisibleTree, flattenCategories, switchableKeys, type CategoryTreeNode } from './categoryTreeModel'
import { useThinScrollbar } from './form'
import { useSize } from './ui'

/**
 * 分类树：分类是**多级**的（`parentId`），所以用 antd Tree 画层级。
 *
 * 为什么不用原来那个平铺列表（用户反馈：「分类显示要用树的组件进行显示」）：平铺时子分类
 * 只能靠名字前手写的 `└` 字符暗示层级，多级分类完全糊在一起，也看不出谁有下级。
 * 树自带缩进与展开/收起（有子分类的节点才出三角），层级一眼能读。
 *
 * 高度策略（用户反馈：「不要有还有 2 项这种东西，要显示全部内容」）：
 * 原来照 `FitList` 那套「按高度整行截断 + 还有 N 项」办——但分类是**用户自己建的**，
 * 少显示几行比多占一点高度更让人难受，而「还有 2 项」既不告诉你是哪两项、也没法点开。
 * 现在**全部行都画**，超出的部分由**面板内部自己滚**（细滚动条，颜色走 antd token）。
 * 整页仍然不出滚动条：外层的 `min-h-0` + 内层的 `overflow-y-auto` 把滚动圈在这一栏里，
 * 与 ui.tsx 那套「每一层都 flex + min-height:0」的约定一致。
 * 组装 / 摊平 / 拼节点那几段纯逻辑在 `./categoryTreeModel.ts`（可离线跑断言）。
 *
 * 展开态是**受控**的，两个坑都踩过（用户反馈：「折叠了不能展开了」）：
 * ① `expandedKeys` 必须回传 `expanded`（用户点出来的那个集合），不能拿「树里画了什么」反推；
 * ② 收起的分支其子行**不在** treeData 里，若按「没有 children 就是叶子」处理，节点一收起就
 *    丢了三角，再也展不开。凡「有下级但没画出来」的都显式给 `isLeaf: false`，三角始终在。
 *
 * 编辑/删除只给图标（用户反馈：「编辑按钮需要图标显示，不需要文字」）：文案挪进 Tooltip，
 * 既省出宽度（一栏只有 ~1/3 页宽，树还有缩进），又不丢提示。
 */

/** 把「要画的节点」翻成 antd Tree 的 treeData（只有这一步碰 antd 的类型） */
function toTreeData(
  nodes: CategoryTreeNode[],
  renderTitle: (category: Category) => React.ReactNode
): TreeDataNode[] {
  return nodes.map((node) => {
    const base: TreeDataNode = { key: node.category.id, title: renderTitle(node.category) }
    if (node.children.length > 0) return { ...base, children: toTreeData(node.children, renderTitle) }
    // 有下级但这次没画出来（收起了）：显式留三角，否则一收起来就再也展不开
    if (node.hiddenChildren) return { ...base, isLeaf: false }
    return base
  })
}

/** 分类行（树的 title）：色点 + 名字 + 收支 + 编辑/删除（图标按钮） */
function CategoryRow(props: {
  category: Category
  onEdit: (category: Category) => void
  onDelete: (category: Category) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const category = props.category
  /** 按钮在树节点里：拦掉冒泡，免得点按钮顺手把节点也展开/选中了 */
  const act = (handler: (category: Category) => void) => (event: React.MouseEvent) => {
    event.stopPropagation()
    handler(category)
  }
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      <span
        className="inline-block h-[8px] w-[8px] shrink-0 rounded-full"
        style={{ backgroundColor: category.color }}
      />
      <span className="min-w-0 flex-1 truncate text-xs">{category.name}</span>
      <span className="shrink-0 text-xs opacity-50">{t(`personal-ledger.kinds.${category.kind}`)}</span>
      <Tooltip title={t('personal-ledger.common.edit')}>
        <Button
          size="small"
          type="text"
          aria-label={t('personal-ledger.common.edit')}
          icon={<RiEditLine size={13} />}
          onClick={act(props.onEdit)}
        />
      </Tooltip>
      <Tooltip title={t('personal-ledger.common.delete')}>
        <Button
          size="small"
          type="text"
          danger
          aria-label={t('personal-ledger.common.delete')}
          icon={<RiDeleteBin6Line size={13} />}
          onClick={act(props.onDelete)}
        />
      </Tooltip>
    </div>
  )
}

export default function CategoryTree(props: {
  categories: Category[]
  onEdit: (category: Category) => void
  onDelete: (category: Category) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [boxRef, size] = useSize<HTMLDivElement>()
  const thinScrollbar = useThinScrollbar()

  const index = useMemo(() => buildCategoryTree(props.categories), [props.categories])

  /** 展开态：默认父分类全展开；分类集合变了（增删 / 改上级）就重置，免得留下已删除的 key */
  const [expanded, setExpanded] = useState<React.Key[]>(index.parentKeys)
  const parentSignature = index.parentKeys.join(',')
  useEffect(() => {
    setExpanded(index.parentKeys)
    // 只认「哪些父分类存在」这个签名：数组每次渲染都是新引用，直接当依赖会每帧重设
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentSignature])

  /** 要画的行：**全部**（收起的分支整支不进来），不再按高度截断 */
  const rows = useMemo(() => flattenCategories(index, expanded), [index, expanded])

  const renderTitle = useCallback(
    (category: Category) => <CategoryRow category={category} onEdit={props.onEdit} onDelete={props.onDelete} />,
    [props.onEdit, props.onDelete]
  )

  const visible = useMemo(() => buildVisibleTree(index, rows), [index, rows])
  const treeData = useMemo(() => toTreeData(visible, renderTitle), [visible, renderTitle])

  /**
   * 展开态**必须**回传用户点出来的那个集合（`expanded`），不能拿「树里画了什么」反推
   * （真实 bug：反推出来的必然全是「打开」，用户点了收起等于没点）。
   */
  const switchable = useMemo(() => new Set(switchableKeys(index, rows)), [index, rows])
  const expandedKeys = useMemo(
    () => expanded.filter((key) => switchable.has(Number(key))),
    [expanded, switchable]
  )

  return (
    <div
      ref={boxRef}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      // 供离线 / 真机取证读取「它当时算出来的是什么」（看不到界面时唯一的证据）
      data-ct-rows={rows.length}
      data-ct-all={props.categories.length}
      data-ct-h={Math.round(size.height)}
    >
      {props.categories.length === 0 ? (
        <span className="text-xs opacity-50">{t('personal-ledger.common.empty')}</span>
      ) : (
        // 滚动圈在这一层里：面板高度固定、树自己滚 → 整页不出滚动条
        <div className="min-h-0 flex-1 overflow-y-auto pr-1" style={thinScrollbar}>
          <Tree
            treeData={treeData}
            blockNode
            selectable={false}
            virtual={false}
            // 展开只认三角：点行本身不该动展开态（行里还有编辑/删除按钮）
            expandAction={false}
            expandedKeys={expandedKeys}
            onExpand={(keys) => setExpanded(keys)}
          />
        </div>
      )}
    </div>
  )
}
