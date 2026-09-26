import type { ProjectTaskSuggestion } from '@/modules/tasks/domain/project-task';

export interface IProjectTaskSuggestionQuery {
  listForRun(ownerId: string, projectId: string, runId: string): Promise<readonly ProjectTaskSuggestion[]>;
}
