import { describe, expect, it } from 'vitest';

import type { ProjectTask } from '@/entities/project-task/model/types';
import { createTaskPatch } from '@/features/task-actions/model/create-task-patch';

const task: ProjectTask = {
  id: 'task-1', projectId: null, title: 'Review plan', details: 'Original detail', importance: 'medium', deadline: '2026-10-20',
  subtasks: [{ id: 'sub-1', title: 'Check dates', completed: false }], status: 'todo', position: 0, version: 2,
  source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
  createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', completedAt: null, archivedAt: null
};

describe('createTaskPatch', () => {
  it('sends only the field the user changed', () => {
    expect(createTaskPatch(task, { title: 'Review launch plan', details: task.details, importance: task.importance, deadline: task.deadline, subtasks: task.subtasks }))
      .toEqual({ title: 'Review launch plan' });
  });

  it('preserves explicit null clears and only includes a changed checklist', () => {
    expect(createTaskPatch(task, { title: task.title, details: null, importance: task.importance, deadline: null, subtasks: [] }))
      .toEqual({ details: null, deadline: null, subtasks: [] });
  });

  it('does not overwrite remote fields when a stale draft is rebased onto the latest task', () => {
    const latest = { ...task, details: 'Changed elsewhere', version: 3 };
    const rebasedDraft = { title: 'My title edit', details: latest.details, importance: latest.importance, deadline: latest.deadline, subtasks: latest.subtasks };
    expect(createTaskPatch(latest, rebasedDraft)).toEqual({ title: 'My title edit' });
  });

  it('omits an unchanged task', () => {
    expect(createTaskPatch(task, { title: task.title, details: task.details, importance: task.importance, deadline: task.deadline, subtasks: task.subtasks })).toEqual({});
  });
});
