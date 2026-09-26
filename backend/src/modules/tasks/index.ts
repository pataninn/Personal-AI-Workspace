export { createProjectTaskRouter, type ProjectTaskRouterDependencies } from '@/modules/tasks/controllers/project-task-router';
export type {
  ProjectTask,
  ProjectTaskFilter,
  ProjectTaskListSnapshot,
  ProjectTaskSource,
  ProjectTaskStatus,
  ProjectTaskSuggestion,
  ProjectTaskSuggestionStatus,
  TaskSuggestionDraft
} from '@/modules/tasks/domain/project-task';
export { ProjectTaskDomainError } from '@/modules/tasks/domain/project-task-errors';
export type { IProjectTaskRepository } from '@/modules/tasks/repositories/project-task-repository';
export type { IProjectTaskSuggestionQuery } from '@/modules/tasks/repositories/task-suggestion-query';
export {
  CreateProjectTaskUseCase,
  ListProjectTaskSuggestionsUseCase,
  ListProjectTasksUseCase,
  ReorderProjectTaskUseCase,
  ResolveProjectTaskSuggestionUseCase,
  UpdateProjectTaskUseCase
} from '@/modules/tasks/use-cases/project-task-use-cases';
