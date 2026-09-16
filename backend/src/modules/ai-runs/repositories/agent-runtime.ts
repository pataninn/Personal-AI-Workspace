import type { EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';
import type { CommandLimits, CommandResult } from '@/modules/ai-runs/domain/command-types';

export interface RuntimeCreateInput {
  readonly runId: string;
  readonly stagedReference: string;
  readonly manifest: EgressManifest;
}

export interface RuntimeReadyResult {
  readonly kind: 'fake';
  readonly sandboxReady: true;
}

export interface RuntimeCommandProposalInput {
  readonly runId: string;
  readonly commandId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface RuntimeCommandInput extends RuntimeCommandProposalInput {
  readonly limits: CommandLimits;
}

export interface RuntimeCommandCancellationInput {
  readonly runId: string;
  readonly commandId: string;
}

export interface IAgentRuntime {
  checkAvailability(): Promise<void>;
  create(input: RuntimeCreateInput): Promise<RuntimeReadyResult>;
  readonly proposeCommand?: (input: RuntimeCommandProposalInput) => Promise<void>;
  readonly executeCommand?: (input: RuntimeCommandInput) => Promise<CommandResult>;
  readonly cancelCommand?: (input: RuntimeCommandCancellationInput) => Promise<void>;
  destroy(runId: string): Promise<void>;
}
