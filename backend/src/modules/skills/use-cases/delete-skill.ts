import { AppError } from '@/shared/errors/app-error';
import { validateSkillVersion } from '@/modules/skills/domain/skill-validation';
import type { ISkillRepository } from '@/modules/skills/repositories/skill-repository';

export interface DeleteSkillInput {
  readonly ownerId: string;
  readonly skillId: string;
  readonly expectedVersion: unknown;
}

export class DeleteSkillUseCase {
  public constructor(private readonly skills: ISkillRepository) {}

  public async execute(input: DeleteSkillInput): Promise<void> {
    const expectedVersion = validateSkillVersion(input.expectedVersion);
    if (await this.skills.softDelete({ ...input, expectedVersion })) return;
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
