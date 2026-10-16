import type { HomeConsentCategory, HomeConversationScope } from '@/modules/home-assistant/domain/home-conversation-types';

/** A typed request from the dedicated planning runner, already owned by one Home turn. */
export interface HomePlanningToolRequest {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly requestId: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly scope: HomeConversationScope;
}

/** A bounded application result ready for the one-turn consent gate. */
export interface HomePlanningToolResultCandidate {
  readonly scope: HomeConversationScope;
  readonly categories: readonly HomeConsentCategory[];
  readonly itemCount: number;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Optional application boundary for registered Home tools; no handler means deny all requests. */
export interface IHomePlanningToolRequestHandler {
  resolve(input: HomePlanningToolRequest): Promise<HomePlanningToolResultCandidate | null>;
}
