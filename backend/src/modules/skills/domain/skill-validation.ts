import { containsPotentialSecret } from '@/shared/egress/redaction';
import { AppError } from '@/shared/errors/app-error';
import { SKILL_INPUT_LIMITS, SKILL_TOOL_CAPABILITIES, type SkillDraft, type SkillToolCapability } from '@/modules/skills/domain/skill-types';

export function validateSkillDraft(input: {
  readonly workspaceId: unknown;
  readonly title: unknown;
  readonly instructions: unknown;
  readonly declaredTools: unknown;
  readonly enabled: unknown;
}): SkillDraft {
  return {
    workspaceId: validateWorkspaceId(input.workspaceId),
    title: validateTitle(input.title),
    instructions: validateInstructions(input.instructions),
    declaredTools: validateDeclaredTools(input.declaredTools),
    enabled: validateEnabled(input.enabled)
  };
}

export function validateSkillVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw validationError('expectedVersion', 'Use a positive current skill version.');
  }
  return value;
}

function validateWorkspaceId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw validationError('workspaceId', 'Use an owned workspace UUID or null.');
  }
  return value;
}

function validateTitle(value: unknown): string {
  if (typeof value !== 'string') throw validationError('title', 'Enter a skill title.');
  const title = value.trim();
  if (title.length < 1 || title.length > SKILL_INPUT_LIMITS.titleCharacters || containsPotentialSecret(title)) {
    throw validationError('title', 'Enter a title up to 120 characters without credential-like text.');
  }
  return title;
}

function validateInstructions(value: unknown): string {
  if (typeof value !== 'string') throw validationError('instructions', 'Enter skill instructions.');
  const instructions = value.trim();
  if (instructions.length === 0 || Buffer.byteLength(instructions, 'utf8') > SKILL_INPUT_LIMITS.instructionBytes || containsPotentialSecret(instructions)) {
    throw validationError('instructions', 'Enter instructions up to 16,000 UTF-8 bytes without credential-like text.');
  }
  return instructions;
}

function validateDeclaredTools(value: unknown): readonly SkillToolCapability[] {
  if (!Array.isArray(value) || value.length > SKILL_TOOL_CAPABILITIES.length) {
    throw validationError('declaredTools', 'Choose up to five supported Home tool capabilities.');
  }
  const tools: SkillToolCapability[] = [];
  for (const item of value) {
    const capability = typeof item === 'string'
      ? SKILL_TOOL_CAPABILITIES.find((candidate) => candidate === item)
      : undefined;
    if (!capability || tools.includes(capability)) {
      throw validationError('declaredTools', 'Choose unique supported Home tool capabilities.');
    }
    tools.push(capability);
  }
  return SKILL_TOOL_CAPABILITIES.filter((tool) => tools.includes(tool));
}

function validateEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') throw validationError('enabled', 'Choose whether the skill is enabled.');
  return value;
}

function validationError(field: string, message: string): AppError {
  return new AppError('VALIDATION_ERROR', 400, 'The skill is invalid.', [{ field, message }]);
}
