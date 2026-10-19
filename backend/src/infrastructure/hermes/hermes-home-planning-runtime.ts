import { createHash, randomBytes } from 'node:crypto';

import type {
  CancelHomePlanningRunResult,
  HomePlanningProvider,
  HomePlanningRuntimeEvent,
  HomePlanningRuntimeStatus,
  IHomePlanningRuntime,
  PollHomePlanningRunInput,
  PollHomePlanningRunResult,
  SendHomePlanningToolResultInput,
  StartHomePlanningRunInput,
  StartHomePlanningRunResult
} from '@/modules/home-assistant/repositories/home-planning-runtime';
import { NEBIUS_PROVIDER_PROFILE, NVIDIA_PROVIDER_PROFILE } from '@/modules/ai-runs/domain/model-provider-profile';
import { EXPECTED_NIM_MODEL } from '@/infrastructure/config/app-config';
import { AiRunRuntimeUnavailableError } from '@/modules/ai-runs/domain/ai-run-errors';
import { redactEgressText } from '@/shared/egress/redaction';

import { HermesBridgeCallError, HermesBridgeClient, isRecord } from '@/infrastructure/hermes/hermes-bridge-client';

const PROVIDER_ENDPOINTS: Readonly<Record<string, string>> = {
  [NVIDIA_PROVIDER_PROFILE]: 'https://integrate.api.nvidia.com/v1',
  [NEBIUS_PROVIDER_PROFILE]: 'https://api.tokenfactory.nebius.com/v1'
};
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_POLL_PAGE_BYTES = 256 * 1024;
const MAX_HOME_TOOL_RESULT_BYTES = 256 * 1024;
const MAX_HOME_TOOL_EVENT_BYTES = 256 * 1024;
const TURN_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
export const HOME_PLANNING_TOOL_NAMES = [
  'home_list_tasks',
  'home_get_task',
  'home_create_task',
  'home_update_task',
  'home_move_task',
  'home_archive_task',
  'home_search_workspaces',
  'home_reuse_workspace',
  'home_create_workspace',
  'home_update_workspace_objective',
  'home_undo_action',
  'home_propose_bulk_changes'
] as const;
export type HomePlanningToolName = typeof HOME_PLANNING_TOOL_NAMES[number];
const ALLOWED_HOME_TOOL_NAMES: ReadonlySet<string> = new Set(HOME_PLANNING_TOOL_NAMES);

export interface HermesHomePlanningRuntimeOptions {
  /** Names explicitly registered by trusted server composition; absent means deny-all. */
  readonly registeredToolNames?: readonly HomePlanningToolName[];
  /** Must be enabled only after the bridge proves every provider egress attempt is admitted. */
  readonly providerEgressAdmissionEnforced?: boolean;
}

interface ActivePlanningRun {
  readonly capability: string;
  readonly fingerprint: string;
  accepted: boolean;
  cancelled: boolean;
  startPromise?: Promise<StartHomePlanningRunResult>;
  cancelPromise?: Promise<CancelHomePlanningRunResult>;
}

/** Home-specific Hermes adapter. It carries no project snapshot or project runtime dependency. */
export class HermesHomePlanningRuntime implements IHomePlanningRuntime {
  private readonly runs = new Map<string, ActivePlanningRun>();
  private readonly homeToolNames: ReadonlySet<string>;
  private readonly providerEgressAdmissionEnforced: boolean;

  public constructor(
    private readonly bridge: HermesBridgeClient,
    private readonly provider: HomePlanningProvider,
    options: HermesHomePlanningRuntimeOptions = {}
  ) {
    const registeredToolNames = options.registeredToolNames ?? [];
    if (!Array.isArray(registeredToolNames)
      || registeredToolNames.some((name) => typeof name !== 'string' || !ALLOWED_HOME_TOOL_NAMES.has(name))
      || new Set(registeredToolNames).size !== registeredToolNames.length) {
      throw new TypeError('The Home planning tool registration is invalid.');
    }
    this.homeToolNames = new Set(registeredToolNames);
    this.providerEgressAdmissionEnforced = options.providerEgressAdmissionEnforced === true;
  }

  public async supportsPolicyExecution(_input: { readonly providerProfile: string; readonly model: string }): Promise<boolean> {
    // The ACP boundary cannot yet prove admission for every primary or auxiliary send.
    return false;
  }

  public async start(input: StartHomePlanningRunInput): Promise<StartHomePlanningRunResult> {
    if (!this.providerEgressAdmissionEnforced
      || !validTurnId(input.turnId) || !validPrompt(input.prompt) || !sameProvider(input.provider, this.provider)) {
      return { outcome: 'unavailable', code: 'PLANNING_RUNTIME_UNAVAILABLE' };
    }
    const fingerprint = requestFingerprint(input);
    const existing = this.runs.get(input.turnId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { outcome: 'unavailable', code: 'PLANNING_RUNTIME_UNAVAILABLE' };
      if (existing.startPromise) return existing.startPromise;
      return existing.accepted
        ? { outcome: 'accepted' }
        : { outcome: 'unknown', code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' };
    }
    const active: ActivePlanningRun = {
      capability: randomBytes(32).toString('base64url'),
      fingerprint,
      accepted: false,
      cancelled: false
    };
    this.runs.set(input.turnId, active);
    active.startPromise = this.startAccepted(input, active);
    return active.startPromise;
  }

  public async poll(input: PollHomePlanningRunInput): Promise<PollHomePlanningRunResult> {
    if (!validTurnId(input.turnId) || !validCursor(input.cursor)) return unknownPoll(input.cursor);
    const active = this.runs.get(input.turnId);
    if (!active) return unknownPoll(input.cursor);
    try {
      const reply = await this.bridge.call('planning-poll', input.turnId, active.capability, { cursor: input.cursor });
      return parsePoll(reply, input.cursor, this.homeToolNames);
    } catch {
      return unknownPoll(input.cursor);
    }
  }

  public async sendToolResult(input: SendHomePlanningToolResultInput): Promise<{ readonly accepted: boolean }> {
    const active = this.runs.get(input.turnId);
    if (!validTurnId(input.turnId) || !validRequestId(input.requestId) || !active || !active.accepted || active.cancelled
      || !validToolResult(input.result)) throw new AiRunRuntimeUnavailableError();
    const payload = { requestId: input.requestId, result: input.result };
    if (encodedBytes(payload) > MAX_HOME_TOOL_RESULT_BYTES) throw new AiRunRuntimeUnavailableError();
    const reply = await this.bridge.call('planning-home-tool-result', input.turnId, active.capability, payload);
    if (reply.accepted !== true && reply.accepted !== false) throw new AiRunRuntimeUnavailableError();
    return { accepted: reply.accepted };
  }

  public async cancel(turnId: string): Promise<CancelHomePlanningRunResult> {
    if (!validTurnId(turnId)) return { outcome: 'unknown' };
    const active = this.runs.get(turnId);
    if (!active) return { outcome: 'unknown' };
    if (active.cancelPromise) return active.cancelPromise;
    active.cancelled = true;
    active.cancelPromise = this.cancelActive(turnId, active);
    return active.cancelPromise;
  }

  public async delete(turnId: string): Promise<void> {
    const active = this.runs.get(turnId);
    if (!active || !validTurnId(turnId)) return;
    if (active.startPromise) await active.startPromise;
    const reply = await this.bridge.call('planning-delete', turnId, active.capability, {});
    if (reply.deleted !== true) throw new AiRunRuntimeUnavailableError();
    this.runs.delete(turnId);
  }

  private async startAccepted(input: StartHomePlanningRunInput, active: ActivePlanningRun): Promise<StartHomePlanningRunResult> {
    let reply: Record<string, unknown>;
    try {
      reply = await this.bridge.call('planning-create', input.turnId, active.capability, {
        prompt: input.prompt,
        providerProfile: input.provider.profile,
        model: input.provider.model,
        endpoint: input.provider.endpoint
      });
    } catch (error: unknown) {
      if (error instanceof HermesBridgeCallError && ['not-sent', 'rejected'].includes(error.acceptance)) {
        this.runs.delete(input.turnId);
        return { outcome: 'unavailable', code: 'PLANNING_RUNTIME_UNAVAILABLE' };
      }
      return { outcome: 'unknown', code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' };
    }
    if (reply.status !== 'preparing') return { outcome: 'unknown', code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' };
    active.accepted = true;
    return { outcome: 'accepted' };
  }

  private async cancelActive(turnId: string, active: ActivePlanningRun): Promise<CancelHomePlanningRunResult> {
    if (active.startPromise) await active.startPromise;
    if (!active.accepted && !this.runs.has(turnId)) return { outcome: 'unknown' };
    try {
      const reply = await this.bridge.call('planning-cancel', turnId, active.capability, {});
      return reply.outcome === 'confirmed' ? { outcome: 'confirmed' } : { outcome: 'unknown' };
    } catch {
      return { outcome: 'unknown' };
    }
  }
}

function parsePoll(reply: Record<string, unknown>, cursor: number, homeToolNames: ReadonlySet<string>): PollHomePlanningRunResult {
  const statuses: readonly HomePlanningRuntimeStatus[] = ['preparing', 'running', 'completed', 'failed', 'cancelled', 'unknown'];
  if (!statuses.includes(reply.status as HomePlanningRuntimeStatus) || !Array.isArray(reply.events)
    || typeof reply.hasMore !== 'boolean') return unknownPoll(cursor);
  const events: HomePlanningRuntimeEvent[] = [];
  let nextCursor = cursor;
  let pageBytes = 0;
  for (const item of reply.events) {
    if (!isRecord(item) || !Number.isSafeInteger(item.sequence) || (item.sequence as number) <= nextCursor) return unknownPoll(cursor);
    const sequence = item.sequence as number;
    pageBytes += encodedBytes(item);
    if (pageBytes > MAX_POLL_PAGE_BYTES) return unknownPoll(cursor);
    if (item.type === 'update') {
      if (!isRecord(item.update)) return unknownPoll(cursor);
      if (item.update.sessionUpdate === 'agent_message_chunk' && isRecord(item.update.content)
        && typeof item.update.content.text === 'string') {
        const text = redactEgressText(item.update.content.text);
        if (Buffer.byteLength(text) > MAX_POLL_PAGE_BYTES) return unknownPoll(cursor);
        events.push({ sequence, type: 'assistant.delta', text });
      }
    } else if (item.type === 'home-tool-request') {
      if (typeof item.id !== 'string' || !validRequestId(item.id) || !isRecord(item.params)
        || typeof item.params.sessionId !== 'string' || item.params.sessionId.length < 1 || item.params.sessionId.length > 128
        || typeof item.params.name !== 'string' || !homeToolNames.has(item.params.name)
        || !isRecord(item.params.args) || !isJsonValue(item.params.args, 0)
        || encodedBytes(item) > MAX_HOME_TOOL_EVENT_BYTES) return unknownPoll(cursor);
      events.push({
        sequence,
        type: 'home.tool.requested',
        requestId: item.id,
        sessionId: item.params.sessionId,
        name: item.params.name,
        args: item.params.args
      });
    } else if (item.type !== 'started') {
      return unknownPoll(cursor);
    }
    nextCursor = sequence;
  }
  const code = typeof reply.code === 'string' && /^PLANNING_RUNTIME_[A-Z_]{1,48}$/u.test(reply.code) ? reply.code : undefined;
  return { status: reply.status as HomePlanningRuntimeStatus, events, nextCursor, hasMore: reply.hasMore, ...(code ? { code } : {}) };
}

function validPrompt(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= MAX_PROMPT_BYTES;
}

function validTurnId(value: string): boolean {
  return typeof value === 'string' && TURN_ID_PATTERN.test(value);
}

function validCursor(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validRequestId(value: string): boolean {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

function sameProvider(received: HomePlanningProvider, configured: HomePlanningProvider): boolean {
  if (received.profile !== configured.profile || received.model !== configured.model || received.endpoint !== configured.endpoint) return false;
  return received.model === EXPECTED_NIM_MODEL && PROVIDER_ENDPOINTS[received.profile] === received.endpoint;
}

function validToolResult(result: SendHomePlanningToolResultInput['result']): boolean {
  if (!isRecord(result)) return false;
  if (result.outcome === 'denied') return Object.keys(result).length === 2 && result.code === 'CONSENT_DENIED';
  if (result.outcome === 'conflict') return Object.keys(result).length === 2 && result.code === 'VERSION_CONFLICT';
  if (result.outcome !== 'shared' || Object.keys(result).length !== 2 || !isRecord(result.data)) return false;
  return isJsonValue(result.data, 0);
}

function requestFingerprint(input: StartHomePlanningRunInput): string {
  return createHash('sha256').update(JSON.stringify({
    turnId: input.turnId,
    prompt: input.prompt,
    provider: input.provider
  })).digest('hex');
}

function isJsonValue(value: unknown, depth: number): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function encodedBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(encoded);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function unknownPoll(cursor: number): PollHomePlanningRunResult {
  return {
    status: 'unknown',
    events: [],
    nextCursor: validCursor(cursor) ? cursor : 0,
    hasMore: false,
    code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN'
  };
}
