export type AiRunStatus = 'pending_approval' | 'rejected' | 'staging' | 'ready' | 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled' | 'blocked' | 'review_required';

export type AiRunPhase = 'manifest' | 'decision' | 'staging' | 'runtime' | 'inference' | 'terminal' | 'review';

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
  readonly assistant?: {
    readonly messageId?: string;
    readonly complete: boolean;
    readonly contentLength: number;
  };
}

export interface AiRunIntent extends AiRunSnapshot {
  readonly manifest?: EgressManifest;
}

export type SandboxCommandClassification = 'safe' | 'sensitive' | 'blocked';

export type SandboxCommandDecision = 'pending' | 'approved' | 'rejected' | 'not_applicable';

export type SandboxCommandStatus =
  | 'awaiting_approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'output_truncated'
  | 'rejected'
  | 'blocked'
  | 'cancel_requested'
  | 'cancelled'
  | 'review_required';

export interface SandboxCommandLimits {
  readonly wallTimeMs: number;
  readonly idleTimeMs: number;
  readonly maxOutputBytes: number;
  readonly maxProcesses: number;
  readonly memoryBytes: number;
  readonly cpuTimeMs: number;
  readonly network: 'denied';
}

export type SandboxCommandTermination = 'completed' | 'failed' | 'timed_out' | 'output_truncated' | 'cancelled';

export interface SandboxCommandResult {
  readonly exitCode: number | null;
  readonly termination: SandboxCommandTermination;
  readonly durationMs: number;
  readonly outputBytes: number;
  readonly outputLineCount: number;
  readonly outputTruncated: boolean;
  readonly outputSha256: string;
  readonly outputPreview?: string;
}

export interface SandboxCommandSnapshot {
  readonly commandId: string;
  readonly runId: string;
  readonly proposalHash: string;
  readonly command: string;
  readonly summary: string;
  readonly argumentCount: number;
  readonly argumentSummaries: readonly string[];
  readonly cwd: string;
  readonly classification: SandboxCommandClassification;
  readonly decision: SandboxCommandDecision;
  readonly status: SandboxCommandStatus;
  readonly limits: SandboxCommandLimits;
  readonly result?: SandboxCommandResult;
  readonly safeMessage: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
