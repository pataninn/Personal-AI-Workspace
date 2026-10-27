import {
  canTransitionProjectTask,
  isProjectTaskStatus,
  normalizeTaskDetails,
  normalizeTaskSuggestionDrafts,
  normalizeTaskText,
  normalizeTaskTitle
} from '@/modules/tasks/domain/project-task-validation';
import { ProjectTaskValidationError } from '@/modules/tasks/domain/project-task-errors';
import { PROJECT_TASK_STATUSES } from '@/modules/tasks/domain/project-task';
import type { ProjectTaskStatus } from '@/modules/tasks/domain/project-task';

describe('project task validation', () => {
  describe('normalizeTaskTitle', () => {
    it('should trim surrounding whitespace and remove control characters', () => {
      expect(normalizeTaskTitle('\u0000  Review the setup\u007f  ')).toBe('Review the setup');
    });

    it('should measure the title limit in Unicode code points', () => {
      const atLimit = '🙂'.repeat(120);

      expect(normalizeTaskTitle(atLimit)).toBe(atLimit);
      expect(() => normalizeTaskTitle('🙂'.repeat(121))).toThrow(ProjectTaskValidationError);
    });

    it('should reject non-string and blank titles', () => {
      expect(() => normalizeTaskTitle(undefined)).toThrow(ProjectTaskValidationError);
      expect(() => normalizeTaskTitle(' \u0000\u007f ')).toThrow(ProjectTaskValidationError);
    });
  });

  describe('normalizeTaskDetails', () => {
    it('should normalize line endings, trim text, and retain allowed tabs and newlines', () => {
      expect(normalizeTaskDetails('  First\r\nSecond\rThird\tline\u0000  ')).toBe('First\nSecond\nThird\tline');
    });

    it('should return null for omitted or blank details', () => {
      expect(normalizeTaskDetails(undefined)).toBeNull();
      expect(normalizeTaskDetails(' \n\t ')).toBeNull();
    });

    it('should enforce the limit in UTF-8 bytes', () => {
      const atLimit = 'é'.repeat(2048);

      expect(normalizeTaskDetails(atLimit)).toBe(atLimit);
      expect(() => normalizeTaskDetails('é'.repeat(2049))).toThrow(ProjectTaskValidationError);
    });
  });

  describe('normalizeTaskText', () => {
    it('should require at least one editable field', () => {
      expect(() => normalizeTaskText({})).toThrow(ProjectTaskValidationError);
    });

    it('should preserve a cleared details field while normalizing the title', () => {
      expect(normalizeTaskText({ title: '  Update notes  ', details: null })).toEqual({ title: 'Update notes', details: null });
    });
  });

  describe('task suggestion drafts', () => {
    it('should normalize up to five bounded suggestions and omit empty details', () => {
      const drafts = Array.from({ length: 5 }, (_, index) => ({ title: `  Suggestion ${index + 1}  ` }));

      expect(normalizeTaskSuggestionDrafts(drafts)).toEqual([
        { title: 'Suggestion 1' },
        { title: 'Suggestion 2' },
        { title: 'Suggestion 3' },
        { title: 'Suggestion 4' },
        { title: 'Suggestion 5' }
      ]);
    });

    it('should reject more than five suggestions', () => {
      const drafts = Array.from({ length: 6 }, (_, index) => ({ title: `Suggestion ${index + 1}` }));

      expect(() => normalizeTaskSuggestionDrafts(drafts)).toThrow(ProjectTaskValidationError);
    });

    it.each([
      ['title', [{ title: 'API_KEY=private-value' }]],
      ['details', [{ title: 'Safe title', details: 'password: private-value' }]]
    ] as const)('should reject credential-like content in a suggestion %s', (_field, drafts) => {
      expect(() => normalizeTaskSuggestionDrafts(drafts)).toThrow(ProjectTaskValidationError);
    });
  });

  describe('task status lifecycle', () => {
    const allowedNextStatuses: Readonly<Record<ProjectTaskStatus, readonly ProjectTaskStatus[]>> = {
      todo: ['in_progress', 'done'],
      in_progress: ['blocked', 'done'],
      blocked: ['in_progress', 'done'],
      done: ['todo']
    };

    it.each(PROJECT_TASK_STATUSES)('should expose only contract-approved transitions from %s', (current) => {
      const nextStatuses = PROJECT_TASK_STATUSES.filter((next) => canTransitionProjectTask(current, next));

      expect(nextStatuses).toEqual(allowedNextStatuses[current]);
    });

    it('should recognize only the declared status values', () => {
      expect(isProjectTaskStatus('blocked')).toBe(true);
      expect(isProjectTaskStatus('deleted')).toBe(false);
      expect(isProjectTaskStatus(null)).toBe(false);
    });
  });
});
