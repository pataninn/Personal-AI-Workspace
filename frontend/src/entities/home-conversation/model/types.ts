export type HomeConversationScope =
  | { readonly kind: 'home' }
  | { readonly kind: 'workspace'; readonly workspaceId: string };

export type HomeTurnStatus =
  | 'pending'
  | 'running'
  | 'cancel_requested'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'unsupported';

export type HomeMessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type HomeConsentCategory = 'current_message' | 'bounded_home_history' | 'task_metadata' | 'workspace_metadata';

export interface HomeConversationSnapshot {
  readonly id: string;
  readonly scope: HomeConversationScope;
  readonly title: string;
  readonly lastEventSequence: number;
  readonly lastActivityAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HomeTurnSnapshot {
  readonly id: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly status: HomeTurnStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HomeMessageSnapshot {
  readonly id: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly role: HomeMessageRole;
  readonly content: string;
  readonly createdAt: string;
}

export type HomeEventValue = string | number | boolean | null | readonly string[];

export interface HomeConversationEvent {
  readonly sequence: number;
  readonly type: string;
  readonly turnId: string | null;
  readonly entityId: string | null;
  readonly payload: Readonly<Record<string, HomeEventValue>>;
  readonly createdAt: string;
}

export interface HomeConsentDisclosure {
  readonly disclosureId: string;
  readonly phase: 'initial' | 'tool_result';
  readonly provider: { readonly profile: string; readonly name: string; readonly model: string };
  readonly scope: HomeConversationScope;
  readonly categories: readonly HomeConsentCategory[];
  readonly itemCount: number;
  readonly byteLimit: number;
}

export type HomeTurnExecution =
  | { readonly state: 'consent_required'; readonly disclosure: HomeConsentDisclosure }
  | { readonly state: 'running' | 'resumed' | 'cancelled' | 'unsupported' | 'unknown'; readonly code?: string };

export interface HomeConversationListPage {
  readonly conversations: readonly HomeConversationSnapshot[];
  readonly nextCursor: string | null;
}

export interface HomeMessagePage {
  readonly messages: readonly HomeMessageSnapshot[];
  readonly nextBeforeSequence: number | null;
}

export interface HomeTurnPage {
  readonly turns: readonly HomeTurnSnapshot[];
  readonly nextAfterSequence: number | null;
}

export interface HomeEventPage {
  readonly events: readonly HomeConversationEvent[];
  readonly nextAfterSequence: number | null;
  readonly lastEventSequence: number;
}

export interface HomeTurnSubmission {
  readonly turn: HomeTurnSnapshot;
  readonly message: HomeMessageSnapshot;
  readonly execution: HomeTurnExecution;
  readonly replayed: boolean;
}

export interface HomeConsentDecisionResult {
  readonly turn: HomeTurnSnapshot;
  readonly disclosureId: string;
  readonly decision: 'allow' | 'deny';
  readonly execution: Exclude<HomeTurnExecution, { readonly state: 'consent_required' }>;
  readonly replayed: boolean;
}
