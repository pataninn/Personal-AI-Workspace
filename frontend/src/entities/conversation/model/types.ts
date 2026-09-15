export type ConversationStatus = 'active' | 'archived';

export interface ConversationSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: ConversationStatus;
  readonly lastActivityAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationListResponse {
  readonly conversations: readonly ConversationSnapshot[];
  readonly nextCursor: string | null;
}

export interface ConversationHistoryResponse {
  readonly conversation: ConversationSnapshot;
  readonly messages: readonly import('@/entities/message').MessageSnapshot[];
  readonly nextBeforeSequence: number | null;
}
