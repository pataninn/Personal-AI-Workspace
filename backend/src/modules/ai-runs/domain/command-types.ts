export type CommandClassification = 'safe' | 'sensitive' | 'blocked';

export type CommandDecision = 'pending' | 'approved' | 'rejected' | 'not_applicable';

export type CommandStatus =
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

export type CommandTermination = 'completed' | 'failed' | 'timed_out' | 'output_truncated' | 'cancelled';

export interface CommandLimits {
  readonly wallTimeMs: number;
  readonly idleTimeMs: number;
  readonly maxOutputBytes: number;
  readonly maxProcesses: number;
  readonly memoryBytes: number;
  readonly cpuTimeMs: number;
  readonly network: 'denied' | 'approved_registries';
}

export const MAX_SANDBOX_COMMANDS_PER_LIST = 100;

export interface CommandResult {
  readonly exitCode: number | null;
  readonly termination: CommandTermination;
  readonly durationMs: number;
  readonly outputBytes: number;
  readonly outputLineCount: number;
  readonly outputTruncated: boolean;
  readonly outputSha256: string;
  readonly outputPreview?: string;
}

export interface SandboxCommand {
  readonly id: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly proposalHash: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly summary: string;
  readonly classification: CommandClassification;
  readonly blockedReason?: string;
  readonly decision: CommandDecision;
  readonly status: CommandStatus;
  readonly limits: CommandLimits;
  readonly result?: CommandResult;
  readonly cancelRequested: boolean;
  readonly createIdempotencyKey: string;
  readonly createFingerprint: string;
  readonly decisionIdempotencyKey?: string;
  readonly decisionFingerprint?: string;
  readonly cancelIdempotencyKey?: string;
  readonly cancelFingerprint?: string;
  readonly safeMessage: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateSandboxCommandRecord {
  readonly ownerId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly proposalHash: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly summary: string;
  readonly classification: CommandClassification;
  readonly blockedReason?: string;
  readonly limits: CommandLimits;
  readonly createIdempotencyKey: string;
  readonly createFingerprint: string;
}

export interface CommandDecisionUpdate {
  readonly ownerId: string;
  readonly runId: string;
  readonly commandId: string;
  readonly proposalHash: string;
  readonly decision: 'approve' | 'reject';
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface CommandCancellationUpdate {
  readonly ownerId: string;
  readonly runId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface CommandResultUpdate {
  readonly ownerId: string;
  readonly runId: string;
  readonly commandId: string;
  readonly status: CommandStatus;
  readonly result?: CommandResult;
  readonly cancelRequested?: boolean;
  readonly safeMessage: string;
}

export interface CommandSnapshot {
  readonly commandId: string;
  readonly runId: string;
  readonly proposalHash: string;
  readonly command: string;
  readonly summary: string;
  readonly argumentCount: number;
  readonly argumentSummaries: readonly string[];
  readonly cwd: string;
  readonly classification: CommandClassification;
  readonly decision: CommandDecision;
  readonly status: CommandStatus;
  readonly runtimeKind: 'fake' | 'hermes';
  readonly limits: CommandLimits;
  readonly result?: CommandResult;
  readonly safeMessage: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
