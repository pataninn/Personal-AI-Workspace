/** Provider configuration selected by the application; never accepted from a browser request. */
export interface HomePlanningProvider {
  readonly profile: string;
  readonly model: string;
  readonly endpoint: string;
}

export interface StartHomePlanningRunInput {
  /** The persisted Home turn UUID is also the runtime's stable run identity. */
  readonly turnId: string;
  readonly prompt: string;
  readonly provider: HomePlanningProvider;
}

export type StartHomePlanningRunResult =
  | { readonly outcome: 'accepted' }
  | { readonly outcome: 'unavailable'; readonly code: 'PLANNING_RUNTIME_UNAVAILABLE' }
  | { readonly outcome: 'unknown'; readonly code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' };

export type HomePlanningRuntimeEvent =
  | { readonly sequence: number; readonly type: 'assistant.delta'; readonly text: string }
  | {
      readonly sequence: number;
      readonly type: 'home.tool.requested';
      readonly requestId: string;
      readonly sessionId: string;
      readonly name: string;
      readonly args: Readonly<Record<string, unknown>>;
    };

export type HomePlanningRuntimeStatus = 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface PollHomePlanningRunInput {
  readonly turnId: string;
  readonly cursor: number;
}

export interface PollHomePlanningRunResult {
  readonly status: HomePlanningRuntimeStatus;
  readonly events: readonly HomePlanningRuntimeEvent[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
  readonly code?: string;
}

export type HomePlanningToolResult =
  | { readonly outcome: 'shared'; readonly data: Readonly<Record<string, unknown>> }
  | { readonly outcome: 'denied'; readonly code: 'CONSENT_DENIED' };

export interface SendHomePlanningToolResultInput {
  readonly turnId: string;
  readonly requestId: string;
  readonly result: HomePlanningToolResult;
}

export interface CancelHomePlanningRunResult {
  readonly outcome: 'confirmed' | 'unknown';
}

/** Narrow Home-owned boundary to the dedicated planning runtime, separate from project IAgentRuntime. */
export interface IHomePlanningRuntime {
  /** Resolves only when planning-create is accepted; failures before acceptance are unavailable or unknown. */
  start(input: StartHomePlanningRunInput): Promise<StartHomePlanningRunResult>;

  /** Reads a bounded, ascending runtime page after the supplied process-local runtime cursor. */
  poll(input: PollHomePlanningRunInput): Promise<PollHomePlanningRunResult>;

  /** Delivers one already-authorized typed Home tool result or a content-free denial. */
  sendToolResult(input: SendHomePlanningToolResultInput): Promise<{ readonly accepted: boolean }>;

  /** Confirms stop only when the bridge confirms it; transport uncertainty remains unknown. */
  cancel(turnId: string): Promise<CancelHomePlanningRunResult>;

  /** Idempotently cleans up a terminal planning sandbox. */
  delete(turnId: string): Promise<void>;
}
