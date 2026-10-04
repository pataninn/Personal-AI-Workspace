import { isTaskChecklistComplete, resolveTaskChecklistState } from '@/modules/tasks/domain/task-checklist-status';

describe('task checklist completion', () => {
  it('does not complete a task with no subtasks', () => {
    expect(isTaskChecklistComplete([])).toBe(false);
  });

  it('completes a task only when every item is checked', () => {
    const first = { id: 'one', title: 'First', completed: true };
    const second = { id: 'two', title: 'Second', completed: false };
    expect(isTaskChecklistComplete([first, second])).toBe(false);
    expect(isTaskChecklistComplete([first, { ...second, completed: true }])).toBe(true);
  });

  it('checks every child when the parent is manually marked done', () => {
    const subtasks = [{ id: 'one', title: 'First', completed: false }, { id: 'two', title: 'Second', completed: true }];
    const result = resolveTaskChecklistState({ current: { status: 'blocked', subtasks }, status: 'done' });
    expect(result).toEqual({ status: 'done', subtasks: subtasks.map((item) => ({ ...item, completed: true })) });
    expect(subtasks[0]?.completed).toBe(false);
  });

  it.each(['todo', 'in_progress', 'blocked'] as const)('automatically completes %s when the last child is checked', (status) => {
    const child = { id: 'one', title: 'First', completed: false };
    expect(resolveTaskChecklistState({ current: { status, subtasks: [child] }, subtasks: [{ ...child, completed: true }] })).toEqual({
      status: 'done', subtasks: [{ ...child, completed: true }]
    });
  });

  it('reopens a completed task when a checklist item is unchecked', () => {
    const child = { id: 'one', title: 'First', completed: true };
    expect(resolveTaskChecklistState({ current: { status: 'done', subtasks: [child] }, subtasks: [{ ...child, completed: false }] })).toEqual({
      status: 'todo', subtasks: [{ ...child, completed: false }]
    });
  });

  it('reopens a completed task when an unfinished item is added', () => {
    const child = { id: 'one', title: 'First', completed: true };
    const added = { id: 'two', title: 'Second', completed: false };
    expect(resolveTaskChecklistState({ current: { status: 'done', subtasks: [child] }, subtasks: [child, added] }).status).toBe('todo');
  });

  it('keeps completion when editing only parent metadata or removing every checklist item', () => {
    const current = { status: 'done' as const, subtasks: [{ id: 'one', title: 'First', completed: true }] };
    expect(resolveTaskChecklistState({ current })).toEqual(current);
    expect(resolveTaskChecklistState({ current, subtasks: [] })).toEqual({ status: 'done', subtasks: [] });
  });

  it('allows manual completion with an empty checklist without automatically completing empty tasks', () => {
    const current = { status: 'todo' as const, subtasks: [] };
    expect(resolveTaskChecklistState({ current, subtasks: [] }).status).toBe('todo');
    expect(resolveTaskChecklistState({ current, status: 'done' })).toEqual({ status: 'done', subtasks: [] });
  });
});
