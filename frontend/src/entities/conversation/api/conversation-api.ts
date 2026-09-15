import { getJson, postJson } from '@/shared/api';
import type { MessageSnapshot } from '@/entities/message';
import type { ConversationHistoryResponse, ConversationListResponse, ConversationSnapshot } from '@/entities/conversation/model/types';

const PROJECTS_PATH = '/api/v1/projects';
const CONVERSATIONS_PATH = '/api/v1/conversations';

export interface CreateConversationRequest {
  readonly title: string;
}

export interface CreateMessageRequest {
  readonly content: string;
}

export function listConversations(projectId: string, cursor?: string): Promise<ConversationListResponse> {
  const query = new URLSearchParams();
  if (cursor) {
    query.set('cursor', cursor);
  }
  return getJson<ConversationListResponse>(`${PROJECTS_PATH}/${encodeURIComponent(projectId)}/conversations${query.size ? `?${query.toString()}` : ''}`);
}

export function createConversation(
  projectId: string,
  request: CreateConversationRequest,
  csrfToken: string,
  idempotencyKey: string
): Promise<ConversationSnapshot> {
  return postJson<ConversationSnapshot>(
    `${PROJECTS_PATH}/${encodeURIComponent(projectId)}/conversations`,
    request,
    { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': idempotencyKey }
  );
}

export function getConversation(projectId: string, conversationId: string, beforeSequence?: number): Promise<ConversationHistoryResponse> {
  const query = new URLSearchParams({ projectId });
  if (beforeSequence !== undefined) {
    query.set('beforeSequence', String(beforeSequence));
  }
  return getJson<ConversationHistoryResponse>(`${CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}?${query.toString()}`);
}

export function createMessage(
  projectId: string,
  conversationId: string,
  request: CreateMessageRequest,
  csrfToken: string,
  idempotencyKey: string
): Promise<MessageSnapshot> {
  const query = new URLSearchParams({ projectId });
  return postJson<MessageSnapshot>(
    `${CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}/messages?${query.toString()}`,
    request,
    { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': idempotencyKey }
  );
}
