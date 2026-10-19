import { createHash } from 'node:crypto';

import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { AppError } from '@/shared/errors/app-error';
import { SKILL_TEMPLATES } from '@/modules/skills/domain/skill-types';
import { validateSkillDraft } from '@/modules/skills/domain/skill-validation';
import type { CreateSkillResult, ISkillRepository } from '@/modules/skills/repositories/skill-repository';

export interface CreateSkillInput {
  readonly ownerId: string;
  readonly idempotencyKey: unknown;
  readonly templateId?: unknown;
  readonly workspaceId?: unknown;
  readonly title?: unknown;
  readonly instructions?: unknown;
  readonly declaredTools?: unknown;
}

export class CreateSkillUseCase {
  public constructor(
    private readonly projects: Pick<IProjectRepository, 'findByIdForOwner'>,
    private readonly skills: ISkillRepository
  ) {}

  public async execute(input: CreateSkillInput): Promise<CreateSkillResult> {
    const template = findTemplate(input.templateId);
    const draft = template
      ? validateTemplateRequest(input, template)
      : validateCustomRequest(input);
    await this.assertWorkspaceAvailable(input.ownerId, draft.workspaceId);
    const key = validateIdempotencyKey(input.idempotencyKey);
    return this.skills.create({
      ownerId: input.ownerId,
      ...draft,
      idempotencyKeyDigest: createHash('sha256').update(key, 'utf8').digest('hex'),
      requestFingerprint: fingerprint(draft)
    });
  }

  private async assertWorkspaceAvailable(ownerId: string, workspaceId: string | null): Promise<void> {
    if (workspaceId === null) return;
    const workspace = await this.projects.findByIdForOwner(ownerId, workspaceId);
    if (!workspace || workspace.status !== 'active') throw new AppError('SKILL_WORKSPACE_NOT_FOUND', 404, 'The selected workspace is unavailable.');
  }
}

function findTemplate(value: unknown) {
  if (value === undefined) return null;
  const template = SKILL_TEMPLATES.find((candidate) => candidate.id === value);
  if (!template) throw new AppError('VALIDATION_ERROR', 400, 'The skill template is invalid.', [{ field: 'templateId', message: 'Choose a supported template.' }]);
  return template;
}

function validateTemplateRequest(input: CreateSkillInput, template: NonNullable<ReturnType<typeof findTemplate>>) {
  if (input.title !== undefined || input.instructions !== undefined || input.declaredTools !== undefined) {
    throw new AppError('VALIDATION_ERROR', 400, 'Choose a template or custom skill fields, not both.');
  }
  return validateSkillDraft({
    workspaceId: input.workspaceId ?? null,
    title: template.title,
    instructions: template.instructions,
    declaredTools: template.declaredTools,
    enabled: true
  });
}

function validateCustomRequest(input: CreateSkillInput) {
  if (input.title === undefined || input.instructions === undefined || input.declaredTools === undefined) {
    throw new AppError('VALIDATION_ERROR', 400, 'The skill is invalid.', [{ field: 'title', message: 'Provide a title, instructions, and declaredTools.' }]);
  }
  return validateSkillDraft({
    workspaceId: input.workspaceId ?? null,
    title: input.title,
    instructions: input.instructions,
    declaredTools: input.declaredTools,
    enabled: true
  });
}

function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{8,128}$/u.test(value)) {
    throw new AppError('VALIDATION_ERROR', 400, 'A valid Idempotency-Key is required.');
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
