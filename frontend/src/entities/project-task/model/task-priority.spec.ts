import { describe, expect, it } from 'vitest';

import { compareTaskPriority, isTaskOverdue } from '@/entities/project-task/model/task-priority';
import type { ProjectTask } from '@/entities/project-task/model/types';

function task(id: string, deadline: string | null, importance: ProjectTask['importance']): ProjectTask {
  return { id, projectId: 'project', title: id, details: null, importance, deadline, subtasks: [], status: 'todo', position: 0, version: 1,
    source: { kind: 'user', label: 'You', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
    createdAt: '2026-10-01', updatedAt: '2026-10-01', completedAt: null, archivedAt: null };
}

describe('task priority', () => {
  it('sorts nearest deadline before importance, and undated tasks last', () => {
    const tasks = [task('undated', null, 'urgent'), task('later', '2026-10-08', 'urgent'), task('low', '2026-10-06', 'low'), task('urgent', '2026-10-06', 'urgent')];
    expect(tasks.sort(compareTaskPriority).map((item) => item.id)).toEqual(['urgent', 'low', 'later', 'undated']);
  });

  it('treats a deadline as a local calendar day and excludes completed tasks', () => {
    const today = new Date(2026, 9, 5, 12);
    expect(isTaskOverdue(task('today', '2026-10-05', 'medium'), today)).toBe(false);
    expect(isTaskOverdue(task('past', '2026-10-04', 'medium'), today)).toBe(true);
    expect(isTaskOverdue({ ...task('done', '2026-10-04', 'medium'), status: 'done' }, today)).toBe(false);
    expect(isTaskOverdue(task('undated', null, 'medium'), today)).toBe(false);
  });
});
