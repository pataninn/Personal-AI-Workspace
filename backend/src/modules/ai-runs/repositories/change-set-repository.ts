import type {
  ChangeSetDecisionResult,
  ChangeSetDecisionUpdate,
  CreateProposedChangeSetRecord,
  PolicyAuthorizedChangeSetApplyClaim,
  ProposedChangeSet
} from '@/modules/ai-runs/domain/change-types';
import type { ListProjectFileHistoryInput, ProjectFileHistoryRecordPage } from '@/modules/ai-runs/domain/file-history-types';

export interface IProposedChangeSetRepository {
  create(input: CreateProposedChangeSetRecord): Promise<ProposedChangeSet>;
  findByRunForOwner(ownerId: string, runId: string): Promise<ProposedChangeSet | null>;
  listFileHistoryForProjectOwner(input: ListProjectFileHistoryInput): Promise<ProjectFileHistoryRecordPage>;
  recordDecision(input: ChangeSetDecisionUpdate): Promise<ChangeSetDecisionResult>;
  claimPolicyAuthorizedApply(input: PolicyAuthorizedChangeSetApplyClaim): Promise<ChangeSetDecisionResult>;
  save(changeSet: ProposedChangeSet): Promise<void>;
}
