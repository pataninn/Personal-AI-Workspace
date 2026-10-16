export const SYNTHETIC_TIME = '2026-10-16T00:00:00.000Z';

export type SyntheticScope =
  | { readonly kind: 'home' }
  | { readonly kind: 'workspace'; readonly workspaceId: string };

export type SyntheticTurnStatus =
  | 'pending'
  | 'running'
  | 'cancel_requested'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'unsupported';

export interface SyntheticConversation {
  readonly id: string;
  readonly scope: SyntheticScope;
  readonly title: string;
  readonly lastEventSequence: number;
  readonly lastActivityAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SyntheticMessage {
  readonly id: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly createdAt: string;
}

export interface SyntheticTurn {
  readonly id: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly status: SyntheticTurnStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SyntheticEvent {
  readonly sequence: number;
  readonly type: string;
  readonly turnId: string | null;
  readonly entityId: string | null;
  readonly payload: Readonly<Record<string, string | number | boolean | null | readonly string[]>>;
  readonly createdAt: string;
}

export interface HomeChatFixtureOptions {
  readonly scope?: SyntheticScope;
  readonly conversations?: readonly SyntheticConversation[];
  readonly messages?: readonly SyntheticMessage[];
  readonly turns?: readonly SyntheticTurn[];
  readonly events?: readonly SyntheticEvent[];
  readonly failEventReads?: number;
  readonly failTurnSubmissions?: number;
  readonly dynamicConsentAfterAllow?: boolean;
  readonly turnReadStatuses?: readonly SyntheticTurnStatus[];
}

export interface HomeChatFixtureCalls {
  readonly listQueries: Array<{ readonly scope: string | null; readonly workspaceId: string | null }>;
  readonly createRequests: Array<{ readonly body: Readonly<Record<string, unknown>>; readonly idempotencyKey: string }>;
  readonly submitRequests: Array<{ readonly body: Readonly<Record<string, unknown>>; readonly idempotencyKey: string }>;
  readonly consentDecisions: Array<{ readonly body: Readonly<Record<string, unknown>>; readonly phase: 'initial' | 'tool_result' }>;
  readonly eventCursors: number[];
  cancellationRequests: number;
  turnStatusReads: number;
}

export function makeConversation(id: string, scope: SyntheticScope = { kind: 'home' }, title = 'Saved planning question'): SyntheticConversation {
  return { id, scope, title, lastEventSequence: 0, lastActivityAt: SYNTHETIC_TIME, createdAt: SYNTHETIC_TIME, updatedAt: SYNTHETIC_TIME };
}

export function makeTurn(conversationId: string, id: string, status: SyntheticTurnStatus, sequence = 1): SyntheticTurn {
  return { id, conversationId, sequence, status, createdAt: SYNTHETIC_TIME, updatedAt: SYNTHETIC_TIME };
}

export function makeMessage(turnId: string, id: string, role: SyntheticMessage['role'], content: string, sequence = 1): SyntheticMessage {
  return { id, turnId, sequence, role, content, createdAt: SYNTHETIC_TIME };
}

export function makeEvent(sequence: number, type: string, turnId: string | null, status: SyntheticTurnStatus): SyntheticEvent {
  return { sequence, type, turnId, entityId: null, payload: { status }, createdAt: SYNTHETIC_TIME };
}
