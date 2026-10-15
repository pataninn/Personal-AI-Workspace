/** Identifies whether Home history belongs to Home or one planning workspace. */
export type HomeConversationScope =
  | { readonly kind: 'home' }
  | { readonly kind: 'workspace'; readonly workspaceId: string };

/** States persisted for a Home assistant turn. */
export type HomeTurnStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'unknown';

/** Roles that can appear in a persisted Home transcript. */
export type HomeMessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** A conversation stored separately from project-scoped conversations. */
export interface HomeConversation {
  readonly id: string;
  readonly ownerId: string;
  readonly scope: HomeConversationScope;
  readonly title: string;
  readonly lastActivityAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A durable request and its current processing outcome. */
export interface HomeTurn {
  readonly id: string;
  readonly ownerId: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly requestKey: string;
  readonly status: HomeTurnStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Returns whether a persisted turn may move from its current state to another. */
export function canTransitionHomeTurn(from: HomeTurnStatus, to: HomeTurnStatus): boolean {
  if (from === to) {
    return true;
  }
  const allowed: Readonly<Record<HomeTurnStatus, readonly HomeTurnStatus[]>> = {
    pending: ['running', 'failed', 'cancelled', 'unknown'],
    running: ['completed', 'partial', 'failed', 'cancelled', 'unknown'],
    completed: [],
    partial: [],
    failed: [],
    cancelled: [],
    unknown: ['completed', 'partial', 'failed', 'cancelled']
  };
  return allowed[from].includes(to);
}

/** One ordered transcript entry associated with a Home turn. */
export interface HomeMessage {
  readonly id: string;
  readonly ownerId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly role: HomeMessageRole;
  readonly content: string;
  readonly createdAt: Date;
}

/** A conversation page ordered by recent activity. */
export interface HomeConversationPage {
  readonly conversations: readonly HomeConversation[];
  readonly nextCursor: string | null;
}

/** A turn page ordered by its conversation sequence. */
export interface HomeTurnPage {
  readonly turns: readonly HomeTurn[];
  readonly nextAfterSequence: number | null;
}

/** A message page ordered by its conversation sequence. */
export interface HomeMessagePage {
  readonly messages: readonly HomeMessage[];
  readonly nextBeforeSequence: number | null;
}

/** A persisted create/append result, including whether it replayed a request. */
export interface PersistedHomeResource<T> {
  readonly resource: T;
  readonly replayed: boolean;
}
