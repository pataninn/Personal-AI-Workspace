import { AppError } from '@/shared/errors/app-error';
import type { Skill } from '@/modules/skills/domain/skill-types';
import type { ISkillRepository } from '@/modules/skills/repositories/skill-repository';

export class GetSkillUseCase {
  public constructor(private readonly skills: ISkillRepository) {}

  public async execute(input: { readonly ownerId: string; readonly skillId: string }): Promise<Skill> {
    const skill = await this.skills.findActiveById(input.ownerId, input.skillId);
    if (!skill) throw new AppError('SKILL_NOT_FOUND', 404, 'Skill not found.');
    return skill;
  }
}
