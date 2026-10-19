import type {
  ProjectTask,
  ProjectTaskFilter,
  ProjectTaskListSnapshot,
  ProjectTaskSuggestion
} from '@/modules/tasks/domain/project-task';

export interface CreateProjectTaskRecord {
  readonly ownerId: string;
  readonly projectId: string;
  readonly title: string;
  readonly details: string | null;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly importance: ProjectTask['importance'];
  readonly deadline: string | null;
  readonly subtasks: ProjectTask['subtasks'];
}

export interface UpdateProjectTaskTextRecord {
  readonly title?: string;
  readonly details?: string | null;
  readonly importance?: ProjectTask['importance'];
  readonly deadline?: string | null;
  readonly subtasks?: ProjectTask['subtasks'];
}

export interface UpdateProjectTaskRecord {
  readonly ownerId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly text?: UpdateProjectTaskTextRecord;
  readonly status?: ProjectTask['status'];
}

export interface ReorderProjectTaskRecord {
  readonly ownerId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly direction: 'up' | 'down';
  readonly expectedOrderVersion: number;
}

export interface ResolveProjectTaskSuggestionRecord {
  readonly ownerId: string;
  readonly projectId: string;
  readonly suggestionId: string;
  readonly expectedVersion: number;
  readonly decision: 'accepted' | 'dismissed';
  readonly title?: string;
  readonly details?: string | null;
  readonly importance?: ProjectTask['importance'];
  readonly deadline?: string | null;
  readonly subtasks?: ProjectTask['subtasks'];
}

export interface CreateProjectTaskResult {
  readonly task: ProjectTask;
  readonly orderVersion: number;
  readonly replayed: boolean;
}

export type ResolveProjectTaskSuggestionResult =
  | { readonly decision: 'accepted'; readonly task: ProjectTask; readonly taskSuggestion: ProjectTaskSuggestion; readonly orderVersion: number }
  | { readonly decision: 'dismissed'; readonly taskSuggestion: ProjectTaskSuggestion };

export interface IProjectTaskRepository {
  listTasks(ownerId: string, projectId: string, filter: ProjectTaskFilter): Promise<ProjectTaskListSnapshot>;
  createTask(input: CreateProjectTaskRecord): Promise<CreateProjectTaskResult>;
  updateTask(input: UpdateProjectTaskRecord): Promise<{ readonly task: ProjectTask; readonly orderVersion: number }>;
  reorderTask(input: ReorderProjectTaskRecord): Promise<ProjectTaskListSnapshot>;
  listSuggestions(ownerId: string, projectId: string, filter: { readonly status: 'all' | 'pending'; readonly conversationId?: string }): Promise<readonly ProjectTaskSuggestion[]>;
  resolveSuggestion(input: ResolveProjectTaskSuggestionRecord): Promise<ResolveProjectTaskSuggestionResult>;
}
