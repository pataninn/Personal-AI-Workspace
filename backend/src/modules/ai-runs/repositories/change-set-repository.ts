import type {
  ChangeSetDecisionResult,
  ChangeSetDecisionUpdate,
  CreateProposedChangeSetRecord,
  ProposedChangeSet
} from '@/modules/ai-runs/domain/change-types';

export interface IProposedChangeSetRepository {
  create(input: CreateProposedChangeSetRecord): Promise<ProposedChangeSet>;
  findByRunForOwner(ownerId: string, runId: string): Promise<ProposedChangeSet | null>;
  recordDecision(input: ChangeSetDecisionUpdate): Promise<ChangeSetDecisionResult>;
  save(changeSet: ProposedChangeSet): Promise<void>;
}

