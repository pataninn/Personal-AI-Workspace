import type { SkillContextRevision, SkillInvocation, SkillInvocationState } from '@/modules/skills/domain/skill-invocation-types';
import type { SkillRunTurnSummary } from '@/modules/skills/domain/skill-run-summary-types';

export interface ClaimSkillInvocationRecord {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly skillId: string;
  readonly skillRevisionId: string;
  readonly skillVersion: number;
  readonly requestKeyDigest: string;
  readonly requestFingerprint: string;
  readonly contextRevisions: readonly SkillContextRevision[];
}

export interface ISkillInvocationRepository {
  claim(input: ClaimSkillInvocationRecord): Promise<SkillInvocation>;
  findById(ownerId: string, invocationId: string): Promise<SkillInvocation | null>;
  findByRequestKey(ownerId: string, conversationId: string, requestKeyDigest: string): Promise<SkillInvocation | null>;
  findForTurn(ownerId: string, conversationId: string, turnId: string): Promise<SkillInvocation | null>;
  listTurnSummaries(ownerId: string, conversationId: string, turnIds: readonly string[]): Promise<readonly SkillRunTurnSummary[]>;
  updateState(ownerId: string, invocationId: string, state: SkillInvocationState): Promise<SkillInvocation | null>;
}
