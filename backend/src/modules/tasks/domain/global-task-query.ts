import type { ProjectStatus } from '@/modules/projects/domain/project-types';
import type { ProjectTask, ProjectTaskImportance, ProjectTaskStatus } from '@/modules/tasks/domain/project-task';

export interface GlobalTaskQueryFilters {
  readonly workspaceId?: string;
  readonly inboxOnly: boolean;
  readonly status?: ProjectTaskStatus;
  readonly importance?: ProjectTaskImportance;
  readonly deadlineFrom?: string;
  readonly deadlineTo?: string;
  readonly q?: string;
  readonly includeArchived: boolean;
  readonly limit: number;
}

export interface GlobalTaskQueryItem {
  readonly task: ProjectTask;
  readonly collection: 'inbox' | 'workspace';
  readonly workspace: { readonly id: string; readonly name: string; readonly status: ProjectStatus } | null;
}

export interface GlobalTaskQueryCursorPosition {
  readonly createdAt: string;
  readonly taskId: string;
}

export interface GlobalTaskQueryPage {
  readonly items: readonly GlobalTaskQueryItem[];
  readonly nextCursor: string | null;
}
