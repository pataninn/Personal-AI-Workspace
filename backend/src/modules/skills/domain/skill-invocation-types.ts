import type { SkillToolCapability } from '@/modules/skills/domain/skill-types';

export type SkillInvocationState = 'claimed' | 'bound' | 'dispatching' | 'accepted' | 'unknown' | 'denied';

export interface SkillContextRevision {
  readonly kind: 'home_message' | 'project_fact';
  readonly id: string;
  readonly revision: number;
}

export interface SkillInvocation {
  readonly id: string;
  readonly ownerId: string;
  readonly conversationId: string;
  readonly skillId: string;
  readonly skillRevisionId: string;
  readonly skillVersion: number;
  readonly requestKeyDigest: string;
  readonly requestFingerprint: string;
  readonly contextRevisions: readonly SkillContextRevision[];
  readonly declaredTools: readonly SkillToolCapability[];
  readonly title: string;
  readonly instructions: string;
  readonly enabled: boolean;
  readonly state: SkillInvocationState;
  readonly turnId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly current: boolean;
}

export interface SkillInvocationResult {
  readonly invocation: {
    readonly id: string;
    readonly skillId: string;
    readonly skillVersion: number;
    readonly conversationId: string;
    readonly turnId: string | null;
    readonly contextRevisions: readonly SkillContextRevision[];
    readonly state: string;
  };
}
