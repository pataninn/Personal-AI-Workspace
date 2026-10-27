export const PROJECT_TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done'] as const;
export type ProjectTaskStatus = typeof PROJECT_TASK_STATUSES[number];
export type ProjectTaskFilter = 'all' | 'open' | 'completed';
export type ProjectTaskSuggestionStatus = 'pending' | 'accepted' | 'dismissed';
export const PROJECT_TASK_IMPORTANCES = ['low', 'medium', 'high', 'urgent'] as const;
export type ProjectTaskImportance = typeof PROJECT_TASK_IMPORTANCES[number];

export interface ProjectTaskSubtask {
  readonly id: string;
  readonly title: string;
  readonly completed: boolean;
}

export interface TaskSuggestionSubtask {
  readonly title: string;
}

export interface ProjectTaskSource {
  readonly kind: 'user' | 'assistant_suggestion';
  readonly label: 'Added by you' | 'Added from an assistant suggestion · accepted by you';
  readonly suggestionId: string | null;
  readonly runId: string | null;
  readonly conversationId: string | null;
  readonly acceptedAt: Date | null;
}

export interface ProjectTask {
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly details: string | null;
  readonly status: ProjectTaskStatus;
  readonly importance: ProjectTaskImportance;
  readonly deadline: string | null;
  readonly subtasks: readonly ProjectTaskSubtask[];
  readonly position: number;
  readonly version: number;
  readonly source: ProjectTaskSource;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

export interface ProjectTaskSuggestion {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly title: string;
  readonly details: string | null;
  readonly subtasks: readonly TaskSuggestionSubtask[];
  readonly status: ProjectTaskSuggestionStatus;
  readonly version: number;
  readonly taskId: string | null;
  readonly source: { readonly kind: 'assistant'; readonly label: 'Suggested by the assistant' };
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

export interface TaskSuggestionDraft {
  readonly title: string;
  readonly details?: string | null;
  readonly subtasks?: readonly TaskSuggestionSubtask[];
}

export interface ProjectTaskListSnapshot {
  readonly tasks: readonly ProjectTask[];
  readonly orderVersion: number;
}

export interface ProjectTaskCreateResult extends ProjectTaskListSnapshot {
  readonly task: ProjectTask;
  readonly replayed: boolean;
}

export interface ProjectTaskSuggestionAcceptResult {
  readonly task: ProjectTask;
  readonly taskSuggestion: ProjectTaskSuggestion;
  readonly orderVersion: number;
}
