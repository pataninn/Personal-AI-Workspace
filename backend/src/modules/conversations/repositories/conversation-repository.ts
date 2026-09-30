import type {
  Conversation,
  ConversationPage,
  Message,
  MessagePage,
  PersistedResource
} from '@/modules/conversations/domain/conversation-types';

export interface ListConversationsInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface FindConversationInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly limit: number;
  readonly beforeSequence?: number;
}

export interface CreateConversationRecord {
  readonly ownerId: string;
  readonly projectId: string;
  readonly title: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface AddMessageRecord {
  readonly ownerId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly content: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface IConversationRepository {
  listByProjectForOwner(input: ListConversationsInput): Promise<ConversationPage>;
  findWithMessagesForOwner(input: FindConversationInput): Promise<MessagePage | null>;
  readonly findMessageForOwner?: (input: { readonly ownerId: string; readonly projectId: string; readonly conversationId: string; readonly messageId: string }) => Promise<Message | null>;
  create(input: CreateConversationRecord): Promise<PersistedResource<Conversation>>;
  addUserMessage(input: AddMessageRecord): Promise<PersistedResource<Message>>;
  readonly addAssistantMessage?: (input: AddMessageRecord) => Promise<PersistedResource<Message>>;
  readonly addRunUserMessage?: (input: AddMessageRecord) => Promise<PersistedResource<Message>>;
}
