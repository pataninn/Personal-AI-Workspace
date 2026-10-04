import { getJson } from '@/shared/api';
import type { ProjectSnapshot } from '@/entities/project/model/types';

export interface HomeTaskSummary {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly title: string;
  readonly status: 'todo' | 'in_progress' | 'blocked';
  readonly importance: 'low' | 'medium' | 'high' | 'urgent';
  readonly deadline: string | null;
  readonly version: number;
}

export interface ProjectOverview {
  readonly projects: readonly (ProjectSnapshot & { readonly lastActivityAt: string })[];
  readonly tasks: readonly HomeTaskSummary[];
}

export function getProjectOverview(): Promise<ProjectOverview> {
  return getJson('/api/v1/projects/overview?taskLimit=6');
}
