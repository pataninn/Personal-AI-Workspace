import { getJson, postJson } from '@/shared/api';
import type {
  HomeConsentDecisionResult,
  HomeConversationEvent,
  HomeConversationListPage,
  HomeConversationScope,
  HomeEventPage,
  HomeMessagePage,
  HomeTurnPage,
  HomeTurnSnapshot,
  HomeTurnSubmission,
  HomeConversationSnapshot
} from '@/entities/home-conversation/model/types';

const CONVERSATIONS_PATH = '/api/v1/home/conversations';

export function listHomeConversations(scope: HomeConversationScope, cursor?: string): Promise<HomeConversationListPage> {
  const query = new URLSearchParams({ scope: scope.kind, limit: '50' });
  if (scope.kind === 'workspace') query.set('workspaceId', scope.workspaceId);
  if (cursor) query.set('cursor', cursor);
  return getJson<HomeConversationListPage>(`${CONVERSATIONS_PATH}?${query.toString()}`);
}

export function createHomeConversation(
  scope: HomeConversationScope,
  title: string,
  csrfToken: string,
  idempotencyKey: string
): Promise<HomeConversationSnapshot & { readonly replayed: boolean }> {
  return postJson(`${CONVERSATIONS_PATH}`, { scope, title }, {
    'X-CSRF-Token': csrfToken,
    'Idempotency-Key': idempotencyKey
  });
}

export function getHomeConversation(conversationId: string): Promise<HomeConversationSnapshot> {
  return getJson(`${CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}`);
}

export function listHomeMessages(conversationId: string, beforeSequence?: number): Promise<HomeMessagePage> {
  const query = new URLSearchParams({ limit: '50' });
  if (beforeSequence !== undefined) query.set('beforeSequence', String(beforeSequence));
  return getJson(`${CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}/messages?${query.toString()}`);
}

export function listHomeTurns(conversationId: string, afterSequence = 0): Promise<HomeTurnPage> {
  const query = new URLSearchParams({ afterSequence: String(afterSequence), limit: '100' });
  return getJson(`${CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}/turns?${query.toString()}`);
}

export function getHomeTurn(conversationId: string, turnId: string): Promise<HomeTurnSnapshot> {
  return getJson(`${CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}`);
}

export function listHomeEvents(conversationId: string, afterSequence: number): Promise<HomeEventPage> {
  const query = new URLSearchParams({ afterSequence: String(afterSequence), limit: '100' });
  return getJson(`${CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}/events?${query.toString()}`);
}

export function submitHomeTurn(
  conversationId: string,
  message: string,
  csrfToken: string,
  idempotencyKey: string
): Promise<HomeTurnSubmission> {
  return postJson(`${CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}/turns`, { message }, {
    'X-CSRF-Token': csrfToken,
    'Idempotency-Key': idempotencyKey
  });
}

export function cancelHomeTurn(conversationId: string, turnId: string, csrfToken: string): Promise<{ readonly turn: HomeTurnSnapshot; readonly replayed: boolean }> {
  return postJson(`${CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/cancellation`, {}, {
    'X-CSRF-Token': csrfToken
  });
}

export function decideHomeConsent(
  conversationId: string,
  turnId: string,
  disclosureId: string,
  decision: 'allow' | 'deny',
  csrfToken: string
): Promise<HomeConsentDecisionResult> {
  return postJson(`${CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/consent-decisions`, {
    disclosureId,
    decision
  }, { 'X-CSRF-Token': csrfToken });
}

export type { HomeConversationEvent };
