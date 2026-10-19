import type { EgressManifest, ProviderTokenUsage } from '@/modules/ai-runs/domain/ai-run-types';
import type { ProjectStorageKind } from '@/modules/projects/domain/project-types';
import type { CommandLimits, CommandResult } from '@/modules/ai-runs/domain/command-types';
import type { RuntimeChangeProposal } from '@/modules/ai-runs/domain/change-types';
import type { TaskSuggestionDraft } from '@/modules/ai-runs/domain/task-suggestion-draft';

export interface RuntimeCreateInput {
  readonly runId: string;
  readonly stagedReference: string;
  readonly manifest: EgressManifest;
}

export interface RuntimeReadyResult {
  readonly kind: 'fake' | 'direct' | 'hermes';
  readonly sandboxReady: true;
}

export interface DirectRunPreparationInput {
  readonly runId: string;
  readonly manifest: EgressManifest;
}

export interface RuntimeRunInput {
  readonly runId: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly storageKind: ProjectStorageKind;
  readonly relativeRoot: string;
  readonly request: string;
  readonly manifest: EgressManifest;
  readonly stagedReference?: string;
  /** Rechecked by the transport immediately before each provider attempt. */
  readonly beforeProviderAttempt?: () => Promise<void>;
  readonly policyRevision?: string;
}

export type RuntimeInferenceEvent =
  | { readonly type: 'started' }
  | { readonly type: 'provider.request_started' }
  | { readonly type: 'provider.response_received' }
  | { readonly type: 'provider.usage'; readonly usage: ProviderTokenUsage }
  | { readonly type: 'assistant.delta'; readonly text: string }
  | { readonly type: 'assistant.message.completed'; readonly text: string }
  | { readonly type: 'tool.proposed'; readonly proposal: RuntimeCommandProposalInput }
  | { readonly type: 'approval.required'; readonly commandId: string }
  | { readonly type: 'tool.started'; readonly commandId: string }
  | { readonly type: 'tool.completed'; readonly commandId: string; readonly status: string }
  | { readonly type: 'tool.failed'; readonly commandId: string; readonly status: string }
  | { readonly type: 'tool.progress'; readonly toolId: string; readonly title: string; readonly status: string; readonly commandId?: string }
  | { readonly type: 'changes.proposed'; readonly changes: readonly RuntimeChangeProposal[] }
  | { readonly type: 'completed'; readonly text: string; readonly taskSuggestions?: readonly TaskSuggestionDraft[] }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'blocked'; readonly message: string }
  | { readonly type: 'cancelled' }
  | { readonly type: 'needs_manual_review'; readonly message: string };

export interface RuntimeRunCancellationInput {
  readonly runId: string;
}

export interface RuntimeRunCancellationResult {
  readonly outcome: 'confirmed' | 'unknown';
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
  readonly directProvider?: true;
  /** Trusted runtime evidence; user configuration cannot enable this capability. */
  supportsPolicyExecution?(input: { readonly providerProfile: string; readonly model: string }): Promise<boolean>;
  /** True only when the isolated bridge enforces the fixed command profile before model continuation. */
  supportsPolicyCommandExecution?(input: { readonly providerProfile: string; readonly model: string }): Promise<boolean>;
  checkAvailability(): Promise<void>;
  create(input: RuntimeCreateInput): Promise<RuntimeReadyResult>;
  readonly prepareDirectRun?: (input: DirectRunPreparationInput) => Promise<RuntimeReadyResult>;
  readonly proposeCommand?: (input: RuntimeCommandProposalInput) => Promise<void>;
  readonly executeCommand?: (input: RuntimeCommandInput) => Promise<CommandResult>;
  /** Private policy dispatch path; it must not be implemented through a user approval decision. */
  readonly executePolicyCommand?: (input: RuntimeCommandInput) => Promise<CommandResult>;
  /** Releases held command output only after a fresh policy fence and successful persistence. */
  readonly completePolicyCommand?: (input: { readonly runId: string; readonly commandId: string }) => Promise<void>;
  readonly decideCommand?: (input: { readonly runId: string; readonly commandId: string; readonly approved: boolean }) => Promise<void>;
  readonly cancelCommand?: (input: RuntimeCommandCancellationInput) => Promise<void>;
  readonly startRun?: (input: RuntimeRunInput) => AsyncIterable<RuntimeInferenceEvent>;
  readonly cancelRun?: (input: RuntimeRunCancellationInput) => Promise<RuntimeRunCancellationResult>;
  destroy(runId: string): Promise<void>;
}
