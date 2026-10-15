export { createProjectTaskRouter, type ProjectTaskRouterDependencies } from '@/modules/tasks/controllers/project-task-router';
export { createGlobalTaskRouter, type GlobalTaskRouterDependencies } from '@/modules/tasks/controllers/global-task-router';
export type {
  ProjectTask,
  ProjectTaskFilter,
  ProjectTaskListSnapshot,
  ProjectTaskSource,
  ProjectTaskStatus,
  ProjectTaskImportance,
  ProjectTaskSubtask,
  ProjectTaskSuggestion,
  ProjectTaskSuggestionStatus,
  TaskSuggestionDraft
} from '@/modules/tasks/domain/project-task';
export { ProjectTaskDomainError, ProjectTaskMoveConflictError } from '@/modules/tasks/domain/project-task-errors';
export { GlobalTaskNotFoundError, TaskQueryCursorInvalidError } from '@/modules/tasks/domain/global-task-query-errors';
export type { GlobalTaskQueryFilters, GlobalTaskQueryItem, GlobalTaskQueryPage } from '@/modules/tasks/domain/global-task-query';
export type { IProjectTaskRepository } from '@/modules/tasks/repositories/project-task-repository';
export type { IGlobalTaskQueryRepository } from '@/modules/tasks/repositories/global-task-query-repository';
export type { ITaskMutationParticipant } from '@/modules/tasks/repositories/task-mutation-participant';
export type { IProjectTaskSuggestionQuery } from '@/modules/tasks/repositories/task-suggestion-query';
export {
  CreateProjectTaskUseCase,
  DeleteProjectTaskUseCase,
  ListProjectTaskSuggestionsUseCase,
  ListProjectTasksUseCase,
  ReorderProjectTaskUseCase,
  ResolveProjectTaskSuggestionUseCase,
  UpdateProjectTaskUseCase
} from '@/modules/tasks/use-cases/project-task-use-cases';
export { CountInboxTasksUseCase, GetGlobalTaskUseCase, ListGlobalTasksUseCase } from '@/modules/tasks/use-cases/global-task-query-use-cases';
export { TaskMutationUseCases, projectTaskOperationKey, derivedProjectTaskOperationIdentity } from '@/modules/tasks/use-cases/task-mutation-use-cases';
export type { ITaskMutationCommands, TaskMutationCommandResult, TaskMutationCreateInput, TaskMutationUpdateInput, TaskMutationMoveInput, TaskMutationArchiveInput, TaskPatchInput } from '@/modules/tasks/use-cases/task-mutation-use-cases';
