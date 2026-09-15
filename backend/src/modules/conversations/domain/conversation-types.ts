export type ConversationStatus = 'active' | 'archived';

export interface Conversation {
  readonly id: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: ConversationStatus;
  readonly lastActivityAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  readonly id: string;
  readonly conversationId: string;
  readonly role: MessageRole;
  readonly sequence: number;
  readonly content: string;
  readonly createdAt: Date;
}

export interface ConversationPage {
  readonly conversations: readonly Conversation[];
  readonly nextCursor: string | null;
}

export interface MessagePage {
  readonly conversation: Conversation;
  readonly messages: readonly Message[];
  readonly nextBeforeSequence: number | null;
}

export interface PersistedResource<T> {
  readonly resource: T;
  readonly replayed: boolean;
}
