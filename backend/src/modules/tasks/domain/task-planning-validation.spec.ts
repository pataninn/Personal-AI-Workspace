import { ProjectTaskValidationError } from '@/modules/tasks/domain/project-task-errors';
import { normalizeTaskDeadline, normalizeTaskImportance, normalizeTaskSubtasks, normalizeSuggestionSubtasks } from '@/modules/tasks/domain/task-planning-validation';

describe('task planning validation', () => {
  it.each(['low', 'medium', 'high', 'urgent'])('accepts importance %s', (value) => {
    expect(normalizeTaskImportance(value)).toBe(value);
  });

  it.each(['critical', null, 5])('rejects invalid importance %s', (value) => {
    expect(() => normalizeTaskImportance(value)).toThrow(ProjectTaskValidationError);
  });

  it('preserves a real leap-day calendar date and a cleared deadline', () => {
    expect(normalizeTaskDeadline('2028-02-29')).toBe('2028-02-29');
    expect(normalizeTaskDeadline(null)).toBeNull();
  });

  it.each(['2026-02-29', '2026-04-31', '2026-13-01', '2026-01-00', '0000-01-01', '2026-1-01', '2026-01-01T00:00:00Z', undefined])('rejects non-calendar deadline %s', (value) => {
    expect(() => normalizeTaskDeadline(value)).toThrow(ProjectTaskValidationError);
  });

  it('preserves existing ids while assigning new checklist ids', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const result = normalizeTaskSubtasks([{ id, title: ' Existing ', completed: true }, { title: ' New ' }]);
    expect(result[0]).toEqual({ id, title: 'Existing', completed: true });
    expect(result[1]).toMatchObject({ title: 'New', completed: false });
    expect(result[1]?.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result[1]?.id).not.toBe(id);
  });

  it('rejects duplicate ids, nested children, oversized checklists and invalid completion', () => {
    const item = { id: '11111111-1111-4111-8111-111111111111', title: 'Item' };
    for (const items of [[item, item], [{ title: 'Item', subtasks: [] }], Array.from({ length: 51 }, () => ({ title: 'Item' })), [{ title: 'Item', completed: 'yes' }]]) {
      expect(() => normalizeTaskSubtasks(items)).toThrow(ProjectTaskValidationError);
    }
  });

  it('rejects suggestion scheduling, nested children and credential-like checklist content', () => {
    for (const items of [[{ title: 'Item', deadline: '2026-10-05' }], [{ title: 'Item', subtasks: [] }], [{ title: 'API_KEY=private-value' }]]) {
      expect(() => normalizeSuggestionSubtasks(items)).toThrow(ProjectTaskValidationError);
    }
    expect(normalizeSuggestionSubtasks([{ title: ' Review ' }])).toEqual([{ title: 'Review' }]);
  });
});
