import type { Skill } from '@/modules/skills/domain/skill-types';
import type { ISkillRepository } from '@/modules/skills/repositories/skill-repository';

export class ListSkillsUseCase {
  public constructor(private readonly skills: ISkillRepository) {}

  public async execute(input: { readonly ownerId: string; readonly workspaceId?: string }): Promise<readonly Skill[]> {
    return this.skills.listActive(input.ownerId, input.workspaceId);
  }
}
