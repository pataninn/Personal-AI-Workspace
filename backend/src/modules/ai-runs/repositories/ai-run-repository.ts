import type {
  AiRun,
  CreateAiRunRecord,
  CreateAiRunResult,
  DecisionResult,
  DecisionUpdate
} from '@/modules/ai-runs/domain/ai-run-types';

export interface IAiRunRepository {
  create(input: CreateAiRunRecord): Promise<CreateAiRunResult>;
  findByIdForOwner(ownerId: string, runId: string): Promise<AiRun | null>;
  recordDecision(input: DecisionUpdate): Promise<DecisionResult>;
  save(run: AiRun): Promise<void>;
}
