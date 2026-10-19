import { validateSkillDraft, validateSkillVersion } from '@/modules/skills/domain/skill-validation';

describe('skill validation', () => {
  it('normalizes text and keeps declared tools within the closed capability list', () => {
    expect(validateSkillDraft({
      workspaceId: null,
      title: '  Plan today  ',
      instructions: '  Read my task list.  ',
      declaredTools: ['home_task_read', 'home_workspace_read'],
      enabled: true
    })).toEqual({
      workspaceId: null,
      title: 'Plan today',
      instructions: 'Read my task list.',
      declaredTools: ['home_task_read', 'home_workspace_read'],
      enabled: true
    });
  });

  it('rejects duplicate and non-Home tools, oversized instructions, and credential-like text', () => {
    const base = { workspaceId: null, title: 'Skill', instructions: 'Read tasks.', enabled: true };
    expect(() => validateSkillDraft({ ...base, declaredTools: ['home_task_read', 'home_task_read'] })).toThrow();
    expect(() => validateSkillDraft({ ...base, declaredTools: ['shell_exec'] })).toThrow();
    expect(() => validateSkillDraft({ ...base, instructions: 'x'.repeat(16_001), declaredTools: [] })).toThrow();
    expect(() => validateSkillDraft({ ...base, instructions: 'OPENAI_API_KEY=secret-value-123', declaredTools: [] })).toThrow();
  });

  it('accepts only positive safe skill versions', () => {
    expect(validateSkillVersion(3)).toBe(3);
    expect(() => validateSkillVersion(0)).toThrow();
    expect(() => validateSkillVersion(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});
