import type { MainIpcHandlers } from '@host/main/plugins/context'
import type { PlannerTaskRow } from '../shared/types'
import {
  getAllTasks as getAllPlannerTasks,
  getTaskById as getPlannerTaskById,
  getTaskTree as getPlannerTaskTree,
  addTask as addPlannerTask,
  updateTask as updatePlannerTask,
  deleteTask as deletePlannerTask,
  reorderTasks as reorderPlannerTasks,
  addDependency as addPlannerDependency,
  deleteDependency as deletePlannerDependency,
  getAllDependencies as getAllPlannerDependencies
} from './db/mapper'

/**
 * planner（甘特图/任务树）IPC 处理器表。
 *
 * 通道名一律 `plugin:task-planner:<channel>`（命名空间 = manifest.id）；由 `main/index.ts`
 * 交给 `ctx.registerIpc`，插件停用时随 ctx.dispose() 一次性摘除。
 *
 * 迁移说明：原 `src/main/ipc/planner.ts` 的 10 个扁平通道
 * （`planner-tasks-*` / `planner-deps-*`）逐个改名，参数与返回类型不变；
 * 参数类型原先只写在 preload 的类型声明里，现在收进本文件（preload 已删掉该命名空间）。
 * 本插件没有「主进程 → 渲染层」的事件通道，因此不需要 `ctx.registerEvent`。
 */
export const plannerIpcHandlers: MainIpcHandlers = {
  'plugin:task-planner:tasks-get-all': async () => {
    try {
      return await getAllPlannerTasks()
    } catch (error) {
      console.error('Error in plugin:task-planner:tasks-get-all:', error)
      throw error
    }
  },

  'plugin:task-planner:tasks-get-by-id': async (id: number) => {
    try {
      return await getPlannerTaskById(id)
    } catch (error) {
      console.error('Error in plugin:task-planner:tasks-get-by-id:', error)
      throw error
    }
  },

  'plugin:task-planner:tasks-get-tree': async () => {
    try {
      return await getPlannerTaskTree()
    } catch (error) {
      console.error('Error in plugin:task-planner:tasks-get-tree:', error)
      throw error
    }
  },

  'plugin:task-planner:tasks-add': async (
    task: Omit<PlannerTaskRow, 'id' | 'created_at' | 'updated_at'>
  ) => {
    try {
      return await addPlannerTask(task)
    } catch (error) {
      console.error('Error in plugin:task-planner:tasks-add:', error)
      throw error
    }
  },

  'plugin:task-planner:tasks-update': async (
    id: number,
    updates: Partial<Omit<PlannerTaskRow, 'id' | 'created_at'>>
  ) => {
    try {
      return await updatePlannerTask(id, updates)
    } catch (error) {
      console.error('Error in plugin:task-planner:tasks-update:', error)
      throw error
    }
  },

  'plugin:task-planner:tasks-delete': async (id: number) => {
    try {
      return await deletePlannerTask(id)
    } catch (error) {
      console.error('Error in plugin:task-planner:tasks-delete:', error)
      throw error
    }
  },

  'plugin:task-planner:tasks-reorder': async (
    orderList: { id: number; sort_order: number; parent_id: number | null }[]
  ) => {
    try {
      return await reorderPlannerTasks(orderList)
    } catch (error) {
      console.error('Error in plugin:task-planner:tasks-reorder:', error)
      throw error
    }
  },

  'plugin:task-planner:deps-add': async (taskId: number, dependsOnTaskId: number) => {
    try {
      return await addPlannerDependency(taskId, dependsOnTaskId)
    } catch (error) {
      console.error('Error in plugin:task-planner:deps-add:', error)
      throw error
    }
  },

  'plugin:task-planner:deps-delete': async (taskId: number, dependsOnTaskId: number) => {
    try {
      return await deletePlannerDependency(taskId, dependsOnTaskId)
    } catch (error) {
      console.error('Error in plugin:task-planner:deps-delete:', error)
      throw error
    }
  },

  'plugin:task-planner:deps-get-all': async () => {
    try {
      return await getAllPlannerDependencies()
    } catch (error) {
      console.error('Error in plugin:task-planner:deps-get-all:', error)
      throw error
    }
  }
}
