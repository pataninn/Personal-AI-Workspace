import { describe, expect, it } from 'vitest';

import { validateProjectFactDraft } from '@/features/project-memory/model/project-fact-validation';

describe('validateProjectFactDraft', () => {
  it('requires both a name and a value', () => {
    expect(validateProjectFactDraft({ title: '  ', content: '' })).toEqual({
      title: 'Enter a fact name.',
      content: 'Enter what the assistant should know.'
    });
  });

  it('enforces the API title length and UTF-8 content byte limits', () => {
    const errors = validateProjectFactDraft({ title: 'a'.repeat(121), content: 'é'.repeat(2049) });

    expect(errors.title).toContain('120 characters');
    expect(errors.content).toContain('4,096 bytes');
    expect(validateProjectFactDraft({ title: '😀'.repeat(61), content: 'valid' }).title).toContain('120 characters');
  });

  it('accepts a trimmed human-readable fact within the API limits', () => {
    expect(validateProjectFactDraft({ title: ' Preferred language ', content: ' This project uses TypeScript. ' })).toEqual({});
  });
});
