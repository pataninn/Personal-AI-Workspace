import type {
  AiRun,
  CreateAiRunRecord,
  CreateAiRunResult,
  DecisionResult,
  DecisionUpdate
} from '@/modules/ai-runs/domain/ai-run-types';
import type { TaskSuggestionDraft } from '@/modules/ai-runs/domain/task-suggestion-draft';
import type { AiRunActivityRecordPage, ListAiRunActivityInput } from '@/modules/ai-runs/domain/activity-types';

export interface StartRunUpdate {
  readonly ownerId: string;
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface CancelRunUpdate {
  readonly ownerId: string;
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface CompleteRunUpdate {
  readonly ownerId: string;
  readonly runId: string;
  readonly status: 'succeeded' | 'failed' | 'blocked' | 'review_required' | 'cancelled';
  readonly safeMessage: string;
  readonly assistantText?: string;
  readonly assistantComplete?: boolean;
  readonly cleanup?: AiRun['cleanup'];
  readonly providerTransmission?: AiRun['providerTransmission'];
  readonly providerUsage?: AiRun['providerUsage'];
  readonly taskSuggestions?: readonly TaskSuggestionDraft[];
}

export interface RunMutationResult {
  readonly resource: AiRun;
  readonly replayed: boolean;
}

export interface IAiRunRepository {
  create(input: CreateAiRunRecord): Promise<CreateAiRunResult>;
  findByIdForOwner(ownerId: string, runId: string): Promise<AiRun | null>;
  recordDecision(input: DecisionUpdate): Promise<DecisionResult>;
  save(run: AiRun): Promise<void>;
  reopenProviderPermissionDecision?(input: { readonly ownerId: string; readonly runId: string; readonly permissionId: string }): Promise<AiRun | null>;
  readonly beginStart?: (input: StartRunUpdate) => Promise<RunMutationResult>;
  readonly markRunning?: (ownerId: string, runId: string) => Promise<AiRun | null>;
  readonly recordProviderTransmission?: (ownerId: string, runId: string, transmission: AiRun['providerTransmission']) => Promise<AiRun | null>;
  readonly markWaitingApproval?: (ownerId: string, runId: string, safeMessage: string) => Promise<AiRun | null>;
  readonly requestCancellation?: (input: CancelRunUpdate) => Promise<RunMutationResult>;
  readonly completeRun?: (input: CompleteRunUpdate) => Promise<AiRun | null>;
  readonly markCancelled?: (ownerId: string, runId: string) => Promise<AiRun | null>;
  /** Fences an already-running job after its persisted principal has expired or been disabled. */
  readonly stopForInactivePrincipal?: (ownerId: string, runId: string) => Promise<AiRun | null>;
  readonly markReviewRequired?: (ownerId: string, runId: string, safeMessage: string) => Promise<AiRun | null>;
  /**
   * Run event projection and cancellation share this conditional fence. The
   * callback must only publish bounded process-local output; repository state
   * transitions remain outside the callback.
   */
  readonly withRunProjection?: (ownerId: string, runId: string, projection: (run: AiRun) => void) => Promise<boolean>;
  readonly listActivityForProjectOwner?: (input: ListAiRunActivityInput) => Promise<AiRunActivityRecordPage>;
  readonly recordProviderUsage?: (ownerId: string, runId: string, usage: NonNullable<AiRun['providerUsage']>) => Promise<AiRun | null>;
  /**
   * Fence runs interrupted by a previous single-server process before serving
   * requests. Implementations must preserve confirmed provider transmission
   * states and must never resume external work.
   */
  recoverInterruptedRunsForReview?(): Promise<number>;
}
