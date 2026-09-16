export type AiRunStatus =
  | 'pending_approval'
  | 'rejected'
  | 'staging'
  | 'ready'
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'blocked'
  | 'review_required';

export type AiRunPhase = 'manifest' | 'decision' | 'staging' | 'runtime' | 'inference' | 'terminal' | 'review';

export type EgressDecision = 'pending' | 'approved' | 'rejected';

export type CleanupStatus = 'not_started' | 'complete' | 'unknown';

export type ProviderTransmissionStatus = 'not_started' | 'not_started_confirmed' | 'unknown';

export interface EgressFileEntry {
  readonly relativePath: string;
  readonly sourceHash: string;
  readonly sizeBytes: number;
}

export interface EgressMessage {
  readonly role: string;
  readonly content: string;
}

export interface EgressManifest {
  readonly manifestHash: string;
  readonly provider: 'NVIDIA hosted NIM';
  readonly providerProfile: string;
  readonly model: string;
  readonly categories: readonly string[];
  readonly files: readonly EgressFileEntry[];
  readonly requestBytes: number;
  readonly messageBytes: number;
  readonly messageCount: number;
  readonly messageHash: string;
  readonly byteEstimate: number;
  readonly tokenEstimate: number;
  readonly excludedItemCount: number;
  readonly omittedItemCount: number;
  readonly omissionSummary: string;
  readonly bestEffortSecretDetection: true;
}

export interface AiRun {
  readonly id: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly request: string;
  readonly relativeRoot: string;
  readonly requestedPaths: readonly string[];
  readonly manifest: EgressManifest;
  readonly manifestInvalidated: boolean;
  readonly status: AiRunStatus;
  readonly phase: AiRunPhase;
  readonly decision: EgressDecision;
  readonly cleanup: CleanupStatus;
  readonly providerTransmission: ProviderTransmissionStatus;
  readonly stagingItemCount: number;
  readonly runtimeKind?: 'fake';
  readonly sandboxReady: boolean;
  readonly runtimeReference?: string;
  readonly requestMessageId?: string;
  readonly assistantMessageId?: string;
  readonly assistantComplete?: boolean;
  readonly assistantContentLength?: number;
  readonly startIdempotencyKey?: string;
  readonly startFingerprint?: string;
  readonly cancelIdempotencyKey?: string;
  readonly cancelFingerprint?: string;
  readonly decisionIdempotencyKey?: string;
  readonly decisionFingerprint?: string;
  readonly safeMessage: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateAiRunRecord {
  readonly ownerId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly request: string;
  readonly relativeRoot: string;
  readonly requestedPaths: readonly string[];
  readonly manifest: EgressManifest;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface CreateAiRunResult {
  readonly resource: AiRun;
  readonly replayed: boolean;
}

export interface DecisionUpdate {
  readonly ownerId: string;
  readonly runId: string;
  readonly manifestHash: string;
  readonly decision: 'approve' | 'reject';
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface DecisionResult {
  readonly resource: AiRun;
  readonly replayed: boolean;
}

export interface AiRunSnapshot {
  readonly runId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly status: AiRunStatus;
  readonly phase: AiRunPhase;
  readonly manifestHash: string;
  readonly decision: EgressDecision;
  readonly safeMessage: string;
  readonly cleanup: CleanupStatus;
  readonly providerTransmission: ProviderTransmissionStatus;
  readonly stagingItemCount: number;
  readonly runtime?: { readonly kind: 'fake'; readonly sandboxReady: true };
  readonly assistant?: {
    readonly messageId?: string;
    readonly complete: boolean;
    readonly contentLength: number;
  };
}
