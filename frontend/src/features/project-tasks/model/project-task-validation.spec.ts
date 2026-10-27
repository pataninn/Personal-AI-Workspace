import { describe, expect, it } from 'vitest';

import type { ProjectTask } from '@/entities/project-task';
import { isProjectTaskEditorDraftDirty, rebaseProjectTaskEditorDraft, validateProjectTaskDraft } from '@/features/project-tasks/model/project-task-validation';

const baselineTask: ProjectTask = {
  id: 'task-1', projectId: null, title: 'Task', details: null, importance: 'medium', deadline: null,
  subtasks: [
    { id: 'sub-1', title: 'First', completed: false },
    { id: 'sub-2', title: 'Second', completed: false }
  ],
  status: 'todo', position: 0, version: 1,
  source: { kind: 'user' as const, label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
  createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', completedAt: null
};

describe('validateProjectTaskDraft', () => {
  it('trims valid values and represents blank optional details as null', () => {
    expect(validateProjectTaskDraft('  Write notes  ', '   ')).toEqual({
      draft: { title: 'Write notes', details: null },
      errors: {}
    });
  });

  it('uses Unicode code points for title limits and UTF-8 bytes for details', () => {
    expect(validateProjectTaskDraft('😀'.repeat(121), '')).toMatchObject({ errors: { title: 'Use 120 characters or fewer.' } });
    expect(validateProjectTaskDraft('Valid', 'é'.repeat(2049))).toMatchObject({ errors: { details: 'Use 4,096 bytes or fewer.' } });
  });

  it('rejects empty titles and unsupported control characters', () => {
    expect(validateProjectTaskDraft('   ', '')).toMatchObject({ errors: { title: 'Enter a task title.' } });
    expect(validateProjectTaskDraft('Bad\u0000title', '')).toMatchObject({ errors: { title: 'Remove control characters from the title.' } });
    expect(validateProjectTaskDraft('Valid', 'bad\u0000details')).toMatchObject({ errors: { details: 'Remove unsupported control characters from the details.' } });
    expect(validateProjectTaskDraft('Valid', 'line one\nline two\tindent')).toMatchObject({ errors: {} });
  });

  it('validates calendar-only deadlines, required importance and checklist titles', () => {
    expect(validateProjectTaskDraft('Task', '', { importance: '', deadline: '2026-02-30', subtasks: [{ title: '' }] }).errors)
      .toEqual({ importance: 'Choose how important this task is.', deadline: 'Choose a valid calendar date.', subtasks: 'Each subtask needs a title of 120 characters or fewer, without control characters.' });
    expect(validateProjectTaskDraft('Task', '', { importance: 'urgent', deadline: '2028-02-29', subtasks: [{ id: 'existing', title: '  Review  ', completed: true }] }).draft)
      .toEqual({ title: 'Task', details: null, importance: 'urgent', deadline: '2028-02-29', subtasks: [{ id: 'existing', title: 'Review', completed: true }] });
  });

  it('treats trimmed optional fields as pristine but preserves checklist order and completion in dirty checks', () => {
    const unchanged = { title: ' Task ', details: '  ', metadata: { importance: 'medium' as const, deadline: '', subtasks: baselineTask.subtasks } };
    expect(isProjectTaskEditorDraftDirty(baselineTask, unchanged)).toBe(false);
    expect(isProjectTaskEditorDraftDirty(baselineTask, { ...unchanged, metadata: { ...unchanged.metadata, subtasks: [...baselineTask.subtasks].reverse() } })).toBe(true);
    expect(isProjectTaskEditorDraftDirty(baselineTask, { ...unchanged, metadata: { ...unchanged.metadata, subtasks: [{ ...baselineTask.subtasks[0]!, completed: true }, baselineTask.subtasks[1]!] } })).toBe(true);
  });

  it('adopts latest untouched fields after explicit keep-draft review', () => {
    const latest = { ...baselineTask, details: 'Latest remote details', version: 2 };
    const rebased = rebaseProjectTaskEditorDraft(baselineTask, latest, {
      title: 'My title', details: '', metadata: { importance: 'medium', deadline: '', subtasks: baselineTask.subtasks }
    });
    expect(rebased).toEqual({
      title: 'My title', details: 'Latest remote details',
      metadata: { importance: 'medium', deadline: '', subtasks: baselineTask.subtasks }
    });
  });
});
