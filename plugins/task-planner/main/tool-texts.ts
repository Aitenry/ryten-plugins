import { getMainLanguage } from '@host/main/i18n'

/**
 * planner 工具的返回文案（显示在工具卡片上，跟随界面语言）。
 *
 * 原先它与 `todos` / `music` 的文案挤在应用内核的 `src/main/i18n/tool-results-planner.ts` 里；
 * planner 变成独立插件后，这份文案随插件走——插件自己负责自己的用户可见文本。
 * 占位符语法（`{{name}}`、`_one` / `_other` 单复数）与宿主的 `mainFormat` / `mainPlural` 对齐。
 */
export const zhCNToolTexts = {
  /** 任务类型标签（TYPE_LABELS），未知类型回退成 {{type}} */
  typeLabels: {
    project: '项目',
    phase: '阶段',
    task: '任务',
    unknown: '{{type}}'
  },

  /** 三个工具共用的空态与「未知命令/子命令」提示 */
  common: {
    noTasks: '还没有规划任务。',
    unknownCommand: '未知命令：{{command}}。支持：{{supported}}',
    unknownSubcommand: '未知子命令：{{subcommand}}。支持：{{supported}}'
  },

  planner: {
    /** mainPlural 单复数：中文两份同文案，英文 1 item / n items */
    listHeader_one: '**规划任务列表**（共 {{count}} 项）\n',
    listHeader_other: '**规划任务列表**（共 {{count}} 项）\n',
    treeHeader: '**规划任务树**\n',
    /** 每个任务行下方的一行汇总字段 */
    meta: '类型：{{type}} | 进度：{{progress}}% | 工时：{{hours}}h | 优先级：P{{priority}}',
    dateRange: '日期：{{range}}',
    validation: {
      titleRequired: '标题不能为空。',
      typeRequired: '类型不能为空，支持：{{types}}',
      progressRequired: '进度不能为空（可设为 0）。',
      progressRange: '进度范围 0-100。',
      workHoursRequired: '工时不能为空。',
      workHoursNegative: '工时不能为负数。',
      priorityRequired: '优先级不能为空。',
      priorityRange: '无效优先级 P{{priority}}，有效范围：P0–P7。',
      startRequired: '开始日期不能为空（格式 YYYY-MM-DDTHH:mm:ss，如 {{example}}）。',
      endRequired: '结束日期不能为空（格式 YYYY-MM-DDTHH:mm:ss，如 {{example}}）。',
      endBeforeStart: '结束日期不能早于开始日期。',
      taskIdRequired: '任务 ID 不能为空。',
      taskNotFound: '未找到 ID 为 {{id}} 的任务。',
      fieldsRequired: '没有需要更新的字段。',
      parentStartBound: '开始日期不能早于父级「{{parentTitle}}」的开始日期（{{parentStart}}）',
      parentEndBound: '结束日期不能晚于父级「{{parentTitle}}」的结束日期（{{parentEnd}}）'
    },
    created: '已创建{{type}}：[{{id}}] {{path}}',
    updated: '已更新任务 [{{id}}] "{{title}}"：{{fields}}',
    /** 任务字段名（update 回显里的 key），不是数据 */
    fieldLabels: {
      title: '标题',
      progress: '进度',
      work_hours: '工时',
      priority: '优先级',
      start_date: '开始日期',
      end_date: '结束日期'
    },
    /** 项目/阶段进度由子节点聚合，不能手改 */
    aggregateProgress:
      '「{{type}}」类型的进度由子节点聚合计算，不能手动修改。如需更新其他字段，请保持 progress 不变（当前 {{progress}}）。',
    deleted: '已删除{{type}}：[{{id}}] "{{title}}"{{detail}}',
    /** 级联删除的子任务计数，走 mainPlural（1 subtask / n subtasks） */
    deletedChildren_one: '（含 {{count}} 个子任务）',
    deletedChildren_other: '（含 {{count}} 个子任务）',

    deps: {
      empty: '还没有任务依赖关系。',
      header: '**依赖关系列表**\n',
      addNeedsIds: '添加依赖需要提供 taskId 和 dependsOnTaskId',
      deleteNeedsIds: '删除依赖需要提供 taskId 和 dependsOnTaskId',
      selfDependency: '任务不能依赖自身。',
      added:
        '已添加依赖：[{{taskId}}] → [{{dependsOnTaskId}}]（[{{taskId}}] 依赖 [{{dependsOnTaskId}}]）',
      removed: '已删除依赖：[{{taskId}}] → [{{dependsOnTaskId}}]',
      notFound: '未找到依赖：[{{taskId}}] → [{{dependsOnTaskId}}]'
    }
  }
}

export const enUSToolTexts: typeof zhCNToolTexts = {
  typeLabels: {
    project: 'Project',
    phase: 'Phase',
    task: 'Task',
    unknown: '{{type}}'
  },

  common: {
    noTasks: 'No planner tasks yet.',
    unknownCommand: 'Unknown command: {{command}}. Supported: {{supported}}',
    unknownSubcommand: 'Unknown subcommand: {{subcommand}}. Supported: {{supported}}'
  },

  planner: {
    listHeader_one: '**Planner tasks** ({{count}} item)\n',
    listHeader_other: '**Planner tasks** ({{count}} items)\n',
    treeHeader: '**Planner task tree**\n',
    meta: 'Type: {{type}} | Progress: {{progress}}% | Work hours: {{hours}}h | Priority: P{{priority}}',
    dateRange: 'Date: {{range}}',
    validation: {
      titleRequired: 'Title must not be empty.',
      typeRequired: 'Type must not be empty. Supported: {{types}}',
      progressRequired: 'Progress must not be empty (it may be 0).',
      progressRange: 'Progress must be between 0 and 100.',
      workHoursRequired: 'Work hours must not be empty.',
      workHoursNegative: 'Work hours must not be negative.',
      priorityRequired: 'Priority must not be empty.',
      priorityRange: 'Invalid priority P{{priority}}. Valid range: P0–P7.',
      startRequired: 'Start date must not be empty (format YYYY-MM-DDTHH:mm:ss, e.g. {{example}}).',
      endRequired: 'End date must not be empty (format YYYY-MM-DDTHH:mm:ss, e.g. {{example}}).',
      endBeforeStart: 'End date must not be earlier than the start date.',
      taskIdRequired: 'Task ID must not be empty.',
      taskNotFound: 'No task found with ID {{id}}.',
      fieldsRequired: 'No fields to update.',
      parentStartBound:
        'Start date must not be earlier than the parent "{{parentTitle}}" start date ({{parentStart}})',
      parentEndBound:
        'End date must not be later than the parent "{{parentTitle}}" end date ({{parentEnd}})'
    },
    created: 'Created {{type}}: [{{id}}] {{path}}',
    updated: 'Updated task [{{id}}] "{{title}}": {{fields}}',
    fieldLabels: {
      title: 'title',
      progress: 'progress',
      work_hours: 'work_hours',
      priority: 'priority',
      start_date: 'start_date',
      end_date: 'end_date'
    },
    aggregateProgress:
      'The progress of a "{{type}}" is aggregated from its child nodes and cannot be changed manually. To update other fields, keep progress unchanged (currently {{progress}}).',
    deleted: 'Deleted {{type}}: [{{id}}] "{{title}}"{{detail}}',
    deletedChildren_one: ' ({{count}} subtask)',
    deletedChildren_other: ' ({{count}} subtasks)',

    deps: {
      empty: 'No task dependencies yet.',
      header: '**Dependency list**\n',
      addNeedsIds: 'Adding a dependency requires taskId and dependsOnTaskId',
      deleteNeedsIds: 'Deleting a dependency requires taskId and dependsOnTaskId',
      selfDependency: 'A task cannot depend on itself.',
      added:
        'Added dependency: [{{taskId}}] → [{{dependsOnTaskId}}] ([{{taskId}}] depends on [{{dependsOnTaskId}}])',
      removed: 'Deleted dependency: [{{taskId}}] → [{{dependsOnTaskId}}]',
      notFound: 'No dependency found: [{{taskId}}] → [{{dependsOnTaskId}}]'
    }
  }
}

export function getToolTexts(): typeof zhCNToolTexts {
  return getMainLanguage() === 'en-US' ? enUSToolTexts : zhCNToolTexts
}
