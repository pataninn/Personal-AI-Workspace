export type AssistantPolicyScopeKind = 'home' | 'workspace';

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

export type AssistantExecutionPolicyReadiness =
  | { readonly state: 'ready' }
  | { readonly state: 'blocked'; readonly reasonCode: 'policy_revoked' }
  | {
      readonly state: 'unavailable';
      readonly reasonCode: 'policy_unavailable' | 'provider_unconfigured' | 'runtime_unverified';
    };

export interface AssistantExecutionPolicyStatus {
  readonly scope: { readonly kind: AssistantPolicyScopeKind; readonly label: string };
  readonly policy: null | {
    readonly enabled: boolean;
    readonly revision: string;
    readonly provider: null | { readonly name: string; readonly model: string };
    readonly included: {
      readonly categories: readonly AssistantContextCategory[];
      readonly items: readonly { readonly kind: 'file'; readonly name: string }[];
    };
    readonly exclusionsEnforced: true;
    readonly capabilities: readonly AssistantToolCapability[];
  };
  readonly fileAccess: boolean;
  readonly readiness: AssistantExecutionPolicyReadiness;
}

export type AssistantExecutionPolicyQuery =
  | { readonly scope: 'home' }
  | { readonly scope: 'workspace'; readonly projectId: string };
