export type SkillToolCapability = 'home_task_read' | 'home_task_write' | 'home_workspace_read' | 'home_workspace_write' | 'home_action_undo';

export interface UserSkill {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly title: string;
  readonly instructions: string;
  readonly declaredTools: readonly SkillToolCapability[];
  readonly enabled: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SkillTemplate {
  readonly id: 'plan-my-day' | 'daily-briefing';
  readonly title: string;
  readonly instructions: string;
  readonly declaredTools: readonly SkillToolCapability[];
}

export type CreateSkillRequest =
  | { readonly templateId: SkillTemplate['id']; readonly workspaceId: string | null }
  | { readonly title: string; readonly instructions: string; readonly workspaceId: string | null; readonly declaredTools: readonly SkillToolCapability[] };

export interface UpdateSkillRequest {
  readonly expectedVersion: number;
  readonly workspaceId?: string | null;
  readonly title?: string;
  readonly instructions?: string;
  readonly declaredTools?: readonly SkillToolCapability[];
  readonly enabled?: boolean;
}

export interface SkillInvocationResult {
  readonly invocation: {
    readonly id: string;
    readonly skillId: string;
    readonly skillVersion: number;
    readonly conversationId: string;
    readonly turnId: string | null;
    readonly contextRevisions: readonly { readonly kind: 'home_message' | 'project_fact'; readonly id: string; readonly revision: number }[];
    readonly state: string;
  };
}
