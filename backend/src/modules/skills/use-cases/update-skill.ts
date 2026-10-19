import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { AppError } from '@/shared/errors/app-error';
import type { Skill } from '@/modules/skills/domain/skill-types';
import { validateSkillDraft, validateSkillVersion } from '@/modules/skills/domain/skill-validation';
import type { ISkillRepository } from '@/modules/skills/repositories/skill-repository';

export interface UpdateSkillInput {
  readonly ownerId: string;
  readonly skillId: string;
  readonly expectedVersion: unknown;
  readonly workspaceId?: unknown;
  readonly title?: unknown;
  readonly instructions?: unknown;
  readonly declaredTools?: unknown;
  readonly enabled?: unknown;
}

export class UpdateSkillUseCase {
  public constructor(
    private readonly projects: Pick<IProjectRepository, 'findByIdForOwner'>,
    private readonly skills: ISkillRepository
  ) {}

  public async execute(input: UpdateSkillInput): Promise<Skill> {
    const expectedVersion = validateSkillVersion(input.expectedVersion);
    const current = await this.skills.findActiveById(input.ownerId, input.skillId);
    if (!current) throw notFound();
    if (current.version !== expectedVersion) throw conflict();

    const draft = validateSkillDraft({
      workspaceId: input.workspaceId === undefined ? current.workspaceId : input.workspaceId,
      title: input.title === undefined ? current.title : input.title,
      instructions: input.instructions === undefined ? current.instructions : input.instructions,
      declaredTools: input.declaredTools === undefined ? current.declaredTools : input.declaredTools,
      enabled: input.enabled === undefined ? current.enabled : input.enabled
    });
    if (draft.workspaceId !== null) {
      const workspace = await this.projects.findByIdForOwner(input.ownerId, draft.workspaceId);
      if (!workspace || workspace.status !== 'active') throw workspaceNotFound();
    }
    const updated = await this.skills.update({
      ownerId: input.ownerId,
      skillId: input.skillId,
      expectedVersion,
      ...draft
    });
    if (updated) return updated;
    if (!await this.skills.findActiveById(input.ownerId, input.skillId)) throw notFound();
    throw conflict();
  }
}

function notFound(): AppError {
  return new AppError('SKILL_NOT_FOUND', 404, 'The skill is unavailable.');
}

function conflict(): AppError {
  return new AppError('SKILL_VERSION_CONFLICT', 409, 'The skill changed. Refresh it before saving.');
}

function workspaceNotFound(): AppError {
  return new AppError('SKILL_WORKSPACE_NOT_FOUND', 404, 'The selected workspace is unavailable.');
}
