import { SKILL_INPUT_LIMITS } from '@/modules/skills/domain/skill-types';

/** Composes the already validated server-owned skill snapshot and user request without truncation. */
export function makeSkillMessage(title: string, instructions: string, request: string): string {
  return `Reusable skill: ${title}\nUser-authored skill instructions:\n${instructions}\n\nUser request:\n${request}`;
}

// UTF-8 instruction bytes bound their character count too; the public Home message limit is unchanged.
export const MAX_SKILL_MESSAGE_CHARACTERS = SKILL_INPUT_LIMITS.titleCharacters
  + SKILL_INPUT_LIMITS.instructionBytes + SKILL_INPUT_LIMITS.requestCharacters + makeSkillMessage('', '', '').length;
