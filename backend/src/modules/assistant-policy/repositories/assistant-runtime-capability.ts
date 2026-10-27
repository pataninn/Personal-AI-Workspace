import type { AssistantScopeKind } from '@/modules/assistant-policy/domain/assistant-scope-policy';

export interface AssistantRuntimeCapabilityInput {
  readonly scopeKind: AssistantScopeKind;
  readonly providerProfile: string;
  readonly model: string;
}

export type AssistantRuntimeCapability =
  | { readonly available: true }
  | { readonly available: false; readonly reasonCode: 'runtime_unverified' };

/** Trusted server-side capability evidence for the exact provider/model execution boundary. */
export interface IAssistantRuntimeCapability {
  assess(input: AssistantRuntimeCapabilityInput): Promise<AssistantRuntimeCapability>;
}
