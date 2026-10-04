export type ProjectTaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'archived';

export type ProjectTaskFilter = 'all' | 'open' | 'completed' | 'archived';

export type ProjectTaskImportance = 'low' | 'medium' | 'high' | 'urgent';

export interface ProjectTaskSubtask {
  readonly id: string;
  readonly title: string;
  readonly completed: boolean;
}

export interface ProjectTaskSubtaskDraft {
  readonly id?: string;
  readonly title: string;
  readonly completed?: boolean;
}

export interface UserProjectTaskSource {
  readonly kind: 'user';
  readonly label: string;
  readonly suggestionId: null;
  readonly runId: null;
  readonly conversationId: null;
  readonly acceptedAt: null;
}

export interface AssistantProjectTaskSource {
  readonly kind: 'assistant_suggestion';
  readonly label: string;
  readonly suggestionId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly acceptedAt: string;
}

export type ProjectTaskSource = UserProjectTaskSource | AssistantProjectTaskSource;

export interface ProjectTask {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly details: string | null;
  readonly importance: ProjectTaskImportance;
  readonly deadline: string | null;
  readonly subtasks: readonly ProjectTaskSubtask[];
  readonly status: ProjectTaskStatus;
  readonly position: number;
  readonly version: number;
  readonly source: ProjectTaskSource;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly archivedAt: string | null;
}

export interface ProjectTaskDraft {
  readonly title: string;
  readonly details: string | null;
  readonly importance?: ProjectTaskImportance;
  readonly deadline?: string | null;
  readonly subtasks?: readonly ProjectTaskSubtaskDraft[];
}

export type ProjectTaskSuggestionStatus = 'pending' | 'accepted' | 'dismissed';

export interface ProjectTaskSuggestion {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly title: string;
  readonly details: string | null;
  readonly subtasks: readonly { readonly title: string }[];
  readonly status: ProjectTaskSuggestionStatus;
  readonly version: number;
  readonly taskId: string | null;
  readonly source: {
    readonly kind: 'assistant';
    readonly label: string;
  };
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface ProjectTaskList {
  readonly tasks: readonly ProjectTask[];
  readonly orderVersion: number;
}

export interface ProjectTaskUpdateResult {
  readonly task: ProjectTask;
  readonly orderVersion: number;
}

export interface ProjectTaskSuggestionDecision {
  readonly taskSuggestion: ProjectTaskSuggestion;
  readonly task: ProjectTask | null;
  readonly orderVersion: number | null;
}
