import type { Category } from '../../shared/types'

/**
 * 分类树的**纯逻辑**（组装 / 摊平 / 拼出要画的节点 / 上级下拉的选项树），与画界面的部分
 * （`CategoryTree.tsx`）分开。
 *
 * 为什么抽出来：这几段是「层级对不对、收起后还能不能展开」的关键，抽出来就能用
 * `node`（类型擦除）直接跑断言，不必起应用（见仓库里那套「能看到界面才敢说通过」的教训）。
 * 这里**不许 import react / antd / 宿主**——只有 shared/types。
 *
 * 文件名为什么带 `Model`：Windows 的路径不区分大小写，`categoryTree.ts` 与
 * `CategoryTree.tsx` 只差一个首字母，tsc / esbuild 会把它们当成同一个文件
 * （实测报 TS1149「differs only in casing」）。
 *
 * 这里**不再有**「按高度截断 + 还有 N 项」那套（`fitCategories` / `ROW_HEIGHT` 已删）：
 * 用户反馈「不要有还有 2 项这种东西，要显示全部内容」——分类是用户自己建的、数量可控，
 * 少显示几行比多占一点高度更让人难受。现在面板内部**自己滚**（细滚动条，见 CategoryTree.tsx），
 * 整页仍然不出滚动条。
 */

/** 分类树的索引：根列表 + 子列表（按 sort → id 排好） */
export interface CategoryTreeIndex {
  roots: Category[]
  childrenOf: Map<number, Category[]>
  /** 有子分类的节点（默认展开这些） */
  parentKeys: number[]
}

/**
 * 把扁平分类（`parentId` + `sort`）组装成树。
 *
 * 顺序沿用主进程那一套（sort → id），界面上不另立一套；父节点已经不存在的分类
 * （脏数据 / 上级被删）**当根处理**，免得它从界面上消失。
 */
export function buildCategoryTree(categories: Category[]): CategoryTreeIndex {
  const ids = new Set(categories.map((category) => category.id))
  const childrenOf = new Map<number, Category[]>()
  const roots: Category[] = []
  const sorted = [...categories].sort((a, b) => a.sort - b.sort || a.id - b.id)
  for (const category of sorted) {
    const parentId = category.parentId != null && ids.has(category.parentId) ? category.parentId : null
    if (parentId === null) {
      roots.push(category)
      continue
    }
    const bucket = childrenOf.get(parentId)
    if (bucket) bucket.push(category)
    else childrenOf.set(parentId, [category])
  }
  return { roots, childrenOf, parentKeys: [...childrenOf.keys()] }
}

/** 一个「要画出来的」节点：内容 + 已画出的下级 + 有下级但没收进来 */
export interface CategoryTreeNode {
  category: Category
  children: CategoryTreeNode[]
  /**
   * 分类表里它**有**下级，但本次没画出来（因为收起了）。
   *
   * 这个标记纯粹是为了三角：收起的分支其子行根本不在 treeData 里，若按「没有 children
   * 就是叶子」处理，节点一收起就丢了三角，**再也展不开**（真实 bug）。
   * 所以凡是「有下级但没画出来」的，都要显式告诉 Tree「这不是叶子」（`isLeaf: false`）。
   */
  hiddenChildren: boolean
}

/**
 * 把「本次要画的行」（`flattenCategories` 的输出）拼成树。
 *
 * `keep` 是 DFS 序（父行一定先于子行出现），顺序照 `keep` 原样保留。
 */
export function buildVisibleTree(index: CategoryTreeIndex, keep: Category[]): CategoryTreeNode[] {
  const nodes = new Map<number, CategoryTreeNode>()
  for (const category of keep) {
    nodes.set(category.id, { category, children: [], hiddenChildren: false })
  }
  const roots: CategoryTreeNode[] = []
  for (const category of keep) {
    const node = nodes.get(category.id)
    if (!node) continue
    const parent = category.parentId != null ? nodes.get(category.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  for (const [id, node] of nodes) {
    node.hiddenChildren = hasChildren(index, id) && node.children.length === 0
  }
  return roots
}

/** 分类表里这个节点有没有下级 */
export function hasChildren(index: CategoryTreeIndex, id: number): boolean {
  return (index.childrenOf.get(id)?.length ?? 0) > 0
}

/** 本次画出来的行里，哪些 key 该有三角可点（有下级即可，收起态也一样） */
export function switchableKeys(index: CategoryTreeIndex, keep: Category[]): number[] {
  return keep.filter((category) => hasChildren(index, category.id)).map((category) => category.id)
}

/** 展开态下真正要显示的行序列（DFS 顺序；收起的分支整支不进来） */
export function flattenCategories(index: CategoryTreeIndex, expanded: React.Key[]): Category[] {
  const open = new Set(expanded)
  const out: Category[] = []
  // 脏数据里若出现环（a→b→a 且从某个根可达），没有这个集合就会无限递归
  const seen = new Set<number>()
  const walk = (nodes: Category[]): void => {
    for (const node of nodes) {
      if (seen.has(node.id)) continue
      seen.add(node.id)
      out.push(node)
      if (open.has(node.id)) walk(index.childrenOf.get(node.id) ?? [])
    }
  }
  walk(index.roots)
  return out
}

/** 上级分类下拉（TreeSelect）的一个节点：值 + 显示名 + （可选）下级 */
export interface CategoryOption {
  value: number
  title: string
  children?: CategoryOption[]
}

/** 某个节点及其全部下级的 id 集合（容忍脏数据里的环） */
export function collectSubtree(index: CategoryTreeIndex, rootId: number): Set<number> {
  const out = new Set<number>()
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop() as number
    if (out.has(id)) continue
    out.add(id)
    for (const child of index.childrenOf.get(id) ?? []) stack.push(child.id)
  }
  return out
}

/**
 * 上级分类的选项树（给 `EntityForm` 的 `treeSelect` 字段用）。
 *
 * 用户反馈：「新增分类的时候，选择分类也需要是树结构」——原来是一个平铺下拉，
 * 多级分类在里面完全看不出谁在谁下面，选「餐饮 › 外卖」和选「外卖」长得一样。
 *
 * `excludeId` 是**正在编辑的那个分类**：连它自己带整棵子树一起拿掉。少了这一步，
 * 用户能把「餐饮」的上级改成「餐饮外卖」，分类表里就出现环——树上再也画不出来
 * （环里的节点进不了 `roots`），看着像分类凭空消失。
 */
export function buildCategoryTreeOptions(
  categories: Category[],
  excludeId?: number | null
): CategoryOption[] {
  const index = buildCategoryTree(categories)
  const excluded = excludeId == null ? new Set<number>() : collectSubtree(index, excludeId)
  const seen = new Set<number>()
  const walk = (nodes: Category[]): CategoryOption[] => {
    const out: CategoryOption[] = []
    for (const category of nodes) {
      if (excluded.has(category.id) || seen.has(category.id)) continue
      seen.add(category.id)
      const children = walk(index.childrenOf.get(category.id) ?? [])
      out.push(
        children.length > 0
          ? { value: category.id, title: category.name, children }
          : { value: category.id, title: category.name }
      )
    }
    return out
  }
  return walk(index.roots)
}
