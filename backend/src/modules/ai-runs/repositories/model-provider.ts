import type { EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';
import type { RuntimeChangeProposal } from '@/modules/ai-runs/domain/change-types';

export interface ProviderContextFile {
  readonly relativePath: string;
  readonly content: string;
}

export interface ProviderContextMessage {
  readonly role: string;
  readonly content: string;
}

export interface ModelProviderRequest {
  readonly runId: string;
  readonly request: string;
  readonly manifest: EgressManifest;
  readonly files: readonly ProviderContextFile[];
  readonly messages: readonly ProviderContextMessage[];
}

export type ModelProviderEvent =
  | { readonly type: 'started' }
  | { readonly type: 'provider.request_started' }
  | { readonly type: 'provider.response_received' }
  | { readonly type: 'assistant.delta'; readonly text: string }
  | { readonly type: 'assistant.message.completed'; readonly text: string }
  | { readonly type: 'changes.proposed'; readonly changes: readonly RuntimeChangeProposal[] }
  | { readonly type: 'completed'; readonly text: string }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'needs_manual_review'; readonly message: string }
  | { readonly type: 'cancelled' };

export interface ProviderCancellationResult {
  readonly outcome: 'confirmed' | 'unknown';
}

export interface IModelProvider {
  checkAvailability(): Promise<void>;
  stream(input: ModelProviderRequest): AsyncIterable<ModelProviderEvent>;
  cancel(runId: string): Promise<ProviderCancellationResult>;
}
