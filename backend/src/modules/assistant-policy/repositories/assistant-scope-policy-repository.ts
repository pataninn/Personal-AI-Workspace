import type { AssistantScopePolicy, AssistantScopePolicyScope } from '@/modules/assistant-policy/domain/assistant-scope-policy';

export interface IAssistantScopePolicyRepository {
  find(scope: AssistantScopePolicyScope): Promise<AssistantScopePolicy | null>;
  synchronizeProviderConfiguration(input: { readonly providerProfile: string | null; readonly model: string | null }): Promise<void>;
  fillConfiguredProvider(input: {
    readonly scope: AssistantScopePolicyScope;
    readonly providerProfile: string;
    readonly model: string;
  }): Promise<AssistantScopePolicy | null>;
  revoke(scope: AssistantScopePolicyScope): Promise<AssistantScopePolicy | null>;
}
