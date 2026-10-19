import type { Skill, SkillDraft } from '@/modules/skills/domain/skill-types';

export interface CreateSkillRecord extends SkillDraft {
  readonly ownerId: string;
  readonly idempotencyKeyDigest: string;
  readonly requestFingerprint: string;
}

export interface UpdateSkillRecord extends SkillDraft {
  readonly ownerId: string;
  readonly skillId: string;
  readonly expectedVersion: number;
}

export interface DeleteSkillRecord {
  readonly ownerId: string;
  readonly skillId: string;
  readonly expectedVersion: number;
}

export interface CreateSkillResult {
  readonly skill: Skill;
  readonly replayed: boolean;
}

export interface ISkillRepository {
  listActive(ownerId: string, workspaceId?: string): Promise<readonly Skill[]>;
  findActiveById(ownerId: string, skillId: string): Promise<Skill | null>;
  findActiveEnabledForShowcase(ownerId: string, workspaceId: string, skillIds: readonly string[]): Promise<readonly Skill[]>;
  create(input: CreateSkillRecord): Promise<CreateSkillResult>;
  update(input: UpdateSkillRecord): Promise<Skill | null>;
  softDelete(input: DeleteSkillRecord): Promise<Skill | null>;
}
