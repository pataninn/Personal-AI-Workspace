export type AiRunStatus = 'pending_approval' | 'rejected' | 'staging' | 'ready' | 'failed' | 'review_required';

export type AiRunPhase = 'manifest' | 'decision' | 'staging' | 'runtime' | 'review';

export type EgressDecision = 'pending' | 'approved' | 'rejected';

export type CleanupStatus = 'not_started' | 'complete' | 'unknown';

export type ProviderTransmissionStatus = 'not_started' | 'not_started_confirmed' | 'unknown';

export interface EgressManifest {
  readonly runId: string;
  readonly manifestHash: string;
  readonly status: 'pending_approval';
  readonly provider: string;
  readonly providerProfile: string;
  readonly model: string;
  readonly categories: readonly string[];
  readonly relativePaths: readonly string[];
  readonly itemCount: number;
  readonly byteEstimate: number;
  readonly tokenEstimate: number;
  readonly excludedItemCount: number;
  readonly omittedItemCount: number;
  readonly omissionSummary: string;
  readonly bestEffortSecretDetection: boolean;
  readonly preConsentNotice: string;
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
}

export interface AiRunIntent extends AiRunSnapshot {
  readonly manifest?: EgressManifest;
}
