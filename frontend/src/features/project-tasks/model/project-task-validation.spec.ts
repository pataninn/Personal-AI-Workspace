import { describe, expect, it } from 'vitest';

import { validateProjectTaskDraft } from '@/features/project-tasks/model/project-task-validation';

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
});
