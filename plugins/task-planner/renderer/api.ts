import type { PlannerDependencyRow, PlannerTaskRow, PlannerTreeNode } from '../shared/types'

/**
 * planner 插件主进程通道的薄封装。
 *
 * 原先散在 `src/preload/index.ts` 的 `api.planner` 命名空间已删除；这里的方法/分组
 * **同名、同参数、同返回类型**（沿用 `tasks` / `deps` 两层结构，避免 `add`/`delete` 重名），
 * 实现改为走 preload 唯一暴露的通用桥
 * （`window.api.plugin.invoke`，通道名 `plugin:task-planner:*`）。
 * 类型沿用 `shared/types.ts` 的 DTO 形状，未改语义。
 */
const invoke = window.api.plugin.invoke

export const plannerApi = {
  tasks: {
    getAll: () => invoke('plugin:task-planner:tasks-get-all') as Promise<PlannerTaskRow[]>,
    getById: (id: number) =>
      invoke('plugin:task-planner:tasks-get-by-id', id) as Promise<PlannerTaskRow | null>,
    getTree: () => invoke('plugin:task-planner:tasks-get-tree') as Promise<PlannerTreeNode[]>,
    add: (task: Omit<PlannerTaskRow, 'id' | 'created_at' | 'updated_at'>) =>
      invoke('plugin:task-planner:tasks-add', task) as Promise<number>,
    update: (id: number, updates: Partial<Omit<PlannerTaskRow, 'id' | 'created_at'>>) =>
      invoke('plugin:task-planner:tasks-update', id, updates) as Promise<boolean>,
    delete: (id: number) => invoke('plugin:task-planner:tasks-delete', id) as Promise<boolean>,
    reorder: (orderList: { id: number; sort_order: number; parent_id: number | null }[]) =>
      invoke('plugin:task-planner:tasks-reorder', orderList) as Promise<boolean>
  },
  deps: {
    add: (taskId: number, dependsOnTaskId: number) =>
      invoke('plugin:task-planner:deps-add', taskId, dependsOnTaskId) as Promise<number>,
    delete: (taskId: number, dependsOnTaskId: number) =>
      invoke('plugin:task-planner:deps-delete', taskId, dependsOnTaskId) as Promise<boolean>,
    getAll: () => invoke('plugin:task-planner:deps-get-all') as Promise<PlannerDependencyRow[]>
  }
}

export default plannerApi
