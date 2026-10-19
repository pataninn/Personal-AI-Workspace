import type {
  HomeConversation,
  HomeConversationEventPage,
  HomeConversationPage,
  HomeConversationScope,
  HomeConsentDecision,
  HomeConsentDecisionResult,
  HomeConsentDisclosureDraft,
  HomeConsentDisclosureResult,
  HomeConsentDisclosureRecord,
  HomeMessage,
  HomeMessagePage,
  HomeMessageRole,
  HomeTurn,
  HomeTurnPage,
  HomeTurnSubmission,
  HomeTurnStatus,
  HomeToolResultDisclosureDraft,
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

export interface SubmitHomeTurnInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly requestKey: string;
  readonly requestFingerprint: string;
  readonly message: string;
  readonly initialStatus: HomeTurnStatus;
  /** Current Home policy binding; optional for trusted legacy fixtures/replays only. */
  readonly homePolicyRevision?: string | null;
  /** Current workspace policy binding for a workspace-scoped turn; null for Home scope. */
  readonly workspacePolicyRevision?: string | null;
  readonly initialDisclosure?: HomeConsentDisclosureDraft;
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

export interface CompleteHomeTurnWithAssistantInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly content: string;
  readonly status: 'completed' | 'partial';
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
  readonly transcriptOnly?: boolean;
}

export interface CancelHomeTurnInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly turnId: string;
}

export interface ListHomeEventsInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly afterSequence: number;
  readonly limit: number;
}

export interface DecideHomeConsentInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly disclosureId: string;
  readonly decision: HomeConsentDecision;
}

export interface UpdateHomeConsentDeliveryInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly disclosureId: string;
  readonly deliveryState: 'accepted' | 'unavailable' | 'unknown';
}

export interface CreateHomeToolResultDisclosureInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly draft: HomeToolResultDisclosureDraft;
}

export interface UpdateHomeToolResultDeliveryInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly disclosureId: string;
  readonly deliveryState: 'accepted' | 'unknown';
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

  /** Atomically creates/replays a turn, its initial user message, and their replay events. */
  submitTurn(input: SubmitHomeTurnInput): Promise<HomeTurnSubmission>;

  /** Applies one owner-scoped decision and its event under the conversation lock. */
  decideConsent(input: DecideHomeConsentInput): Promise<HomeConsentDecisionResult | null>;

  /** Creates one bounded pending disclosure for a typed runtime result without persisting result data. */
  createToolResultDisclosure(input: CreateHomeToolResultDisclosureInput): Promise<HomeConsentDisclosureResult | null>;

  /** Records bridge acceptance/uncertainty together with the corresponding turn transition. */
  updateConsentDelivery(input: UpdateHomeConsentDeliveryInput): Promise<HomeTurn | null>;

  /** Marks the dynamic result exchange accepted or uncertain; uncertainty makes an active turn unknown. */
  updateToolResultDelivery(input: UpdateHomeToolResultDeliveryInput): Promise<HomeTurn | null>;

  /** Rechecks a persisted one-turn disclosure before provider or ACP egress. */
  findConsentDisclosure(ownerId: string, conversationId: string, turnId: string, disclosureId: string): Promise<HomeConsentDisclosureRecord | null>;

  /** Reads only the current turn's user message for the initial provider prompt. */
  findUserMessageForTurn(ownerId: string, conversationId: string, turnId: string): Promise<HomeMessage | null>;

  /** Lists a conversation's turns in sequence order. */
  listTurnsForOwner(input: ListHomeTurnsInput): Promise<HomeTurnPage | null>;

  /** Updates a turn that belongs to the supplied owner and conversation. */
  updateTurnStatus(input: UpdateHomeTurnStatusInput): Promise<HomeTurn | null>;

  /** Commits the bounded assistant reply and terminal turn status only while the turn is active. */
  completeTurnWithAssistant(input: CompleteHomeTurnWithAssistantInput): Promise<HomeTurn | null>;

  /** Persists cancellation intent idempotently before the runtime is signalled. */
  cancelTurn(input: CancelHomeTurnInput): Promise<PersistedHomeResource<HomeTurn> | null>;

  /** Finds one turn only when it belongs to the supplied owner and conversation. */
  findTurnForOwner(ownerId: string, conversationId: string, turnId: string): Promise<HomeTurn | null>;

  /** Appends an ordered message or replays its matching request. */
  appendMessage(input: AppendHomeMessageInput): Promise<PersistedHomeResource<HomeMessage>>;

  /** Lists a conversation's messages in sequence order. */
  listMessagesForOwner(input: ListHomeMessagesInput): Promise<HomeMessagePage | null>;

  /** Replays one bounded page strictly after its numeric event cursor. */
  listEventsForOwner(input: ListHomeEventsInput): Promise<HomeConversationEventPage | null>;

  /** Converts unresolved turns to unknown and appends one status event per changed turn. */
  reconcileInterruptedTurns(): Promise<number>;
}
