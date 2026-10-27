export type AssistantScopeKind = 'home' | 'project';

export type AssistantPolicyProfile = 'home_in_scope_v1' | 'workspace_in_scope_v1';

export type AssistantContextCategory =
  | 'current_message'
  | 'bounded_home_history'
  | 'task_metadata'
  | 'workspace_metadata'
  | 'request'
  | 'recent_conversation'
  | 'project_files'
  | 'project_facts';

export type AssistantToolCapability =
  | 'home_task_read'
  | 'home_task_write'
  | 'home_workspace_read'
  | 'home_workspace_write'
  | 'home_action_undo'
  | 'workspace_file_read'
  | 'workspace_file_write'
  | 'bounded_sandbox_command';

export interface AssistantScopePolicy {
  readonly id: string;
  readonly ownerId: string;
  readonly scopeKind: AssistantScopeKind;
  readonly projectId: string | null;
  readonly policyProfile: AssistantPolicyProfile;
  readonly providerProfile: string | null;
  readonly model: string | null;
  readonly enabled: boolean;
  readonly revokedAt: Date | null;
  /** PostgreSQL bigint is represented as a decimal string to avoid precision loss. */
  readonly revision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type AssistantScopePolicyScope =
  | { readonly ownerId: string; readonly scopeKind: 'home'; readonly projectId: null }
  | { readonly ownerId: string; readonly scopeKind: 'project'; readonly projectId: string };

export interface AssistantPolicyProfileDefinition {
  readonly contextCategories: readonly AssistantContextCategory[];
  readonly toolCapabilities: readonly AssistantToolCapability[];
}

/** Versioned, closed server policy. New authority requires a deliberate code/schema revision. */
export const ASSISTANT_POLICY_PROFILES: Readonly<Record<AssistantPolicyProfile, AssistantPolicyProfileDefinition>> = {
  home_in_scope_v1: {
    contextCategories: ['current_message', 'bounded_home_history', 'task_metadata', 'workspace_metadata'],
    toolCapabilities: ['home_task_read', 'home_task_write', 'home_workspace_read', 'home_workspace_write', 'home_action_undo']
  },
  workspace_in_scope_v1: {
    contextCategories: ['request', 'recent_conversation', 'project_files', 'project_facts', 'task_metadata', 'workspace_metadata'],
    toolCapabilities: ['home_task_read', 'home_task_write', 'home_workspace_read', 'home_workspace_write', 'home_action_undo',
      'workspace_file_read', 'workspace_file_write', 'bounded_sandbox_command']
  }
};

export function intersectAssistantCapabilities(
  left: readonly AssistantToolCapability[],
  right: readonly AssistantToolCapability[]
): readonly AssistantToolCapability[] {
  const rightSet = new Set(right);
  return left.filter((capability) => rightSet.has(capability));
}

export function policyProfileForScope(scopeKind: AssistantScopeKind): AssistantPolicyProfile {
  return scopeKind === 'home' ? 'home_in_scope_v1' : 'workspace_in_scope_v1';
}
