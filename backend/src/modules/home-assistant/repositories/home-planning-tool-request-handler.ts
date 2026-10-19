import type { HomeConsentCategory, HomeConversationScope } from '@/modules/home-assistant/domain/home-conversation-types';
import type { HomePlanningToolResult } from '@/modules/home-assistant/repositories/home-planning-runtime';

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

export type HomePlanningToolResolution =
  | { readonly kind: 'consented'; readonly candidate: HomePlanningToolResultCandidate }
  | {
    readonly kind: 'immediate';
    readonly result: HomePlanningToolResult;
    /** Internal owner-checked target used to recheck scope policy before runtime continuation. */
    readonly authorizationProjectId?: string;
  };

/** Optional application boundary for registered Home tools; no handler means deny all requests. */
export interface IHomePlanningToolRequestHandler {
  resolve(input: HomePlanningToolRequest): Promise<HomePlanningToolResolution | null>;
}
