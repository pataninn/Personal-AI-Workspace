import type {
  HomeConversation,
  HomeConversationPage,
  HomeConversationScope,
  HomeMessage,
  HomeMessagePage,
  HomeMessageRole,
  HomeTurn,
  HomeTurnPage,
  HomeTurnStatus,
  PersistedHomeResource
} from '@/modules/home-assistant/domain/home-conversation-types';

export interface CreateHomeConversationInput {
  readonly ownerId: string;
  readonly scope: HomeConversationScope;
  readonly title: string;
  readonly requestKey: string;
  readonly requestFingerprint: string;
}

export interface ListHomeConversationsInput {
  readonly ownerId: string;
  readonly scope: HomeConversationScope;
  readonly limit: number;
  readonly cursor?: string;
}

export interface CreateHomeTurnInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly requestKey: string;
  readonly requestFingerprint: string;
}

export interface ListHomeTurnsInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly limit: number;
  readonly afterSequence?: number;
}

export interface UpdateHomeTurnStatusInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly status: HomeTurnStatus;
}

export interface AppendHomeMessageInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly role: HomeMessageRole;
  readonly content: string;
  readonly requestKey: string;
  readonly requestFingerprint: string;
}

export interface ListHomeMessagesInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly limit: number;
  readonly beforeSequence?: number;
}

/** Persistence contract for owner-scoped Home history. */
export interface IHomeConversationRepository {
  /** Lists one Home or workspace scope by activity, with a stable cursor. */
  listForOwner(input: ListHomeConversationsInput): Promise<HomeConversationPage>;

  /** Finds a conversation only when it belongs to the supplied owner. */
  findForOwner(ownerId: string, conversationId: string): Promise<HomeConversation | null>;

  /** Creates a conversation or replays its matching creation request. */
  create(input: CreateHomeConversationInput): Promise<PersistedHomeResource<HomeConversation>>;

  /** Creates an ordered turn or replays its matching request. */
  createTurn(input: CreateHomeTurnInput): Promise<PersistedHomeResource<HomeTurn>>;

  /** Lists a conversation's turns in sequence order. */
  listTurnsForOwner(input: ListHomeTurnsInput): Promise<HomeTurnPage | null>;

  /** Updates a turn that belongs to the supplied owner and conversation. */
  updateTurnStatus(input: UpdateHomeTurnStatusInput): Promise<HomeTurn | null>;

  /** Appends an ordered message or replays its matching request. */
  appendMessage(input: AppendHomeMessageInput): Promise<PersistedHomeResource<HomeMessage>>;

  /** Lists a conversation's messages in sequence order. */
  listMessagesForOwner(input: ListHomeMessagesInput): Promise<HomeMessagePage | null>;
}
