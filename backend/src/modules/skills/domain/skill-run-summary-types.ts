import type { SkillContextRevision, SkillInvocationState } from '@/modules/skills/domain/skill-invocation-types';

export type SkillRunSourceSummary = Omit<SkillContextRevision, 'id'> & { readonly label: string | null };

export interface SkillRunSummary {
  readonly title: string;
  readonly skillVersion: number;
  readonly state: SkillInvocationState;
  readonly sources: readonly SkillRunSourceSummary[];
}

export interface SkillRunTurnSummary {
  readonly turnId: string;
  readonly summary: SkillRunSummary;
}
