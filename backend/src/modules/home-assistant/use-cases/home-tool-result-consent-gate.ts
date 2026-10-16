import { createHash, randomUUID } from 'node:crypto';

import { HomeConsentDecisionStaleError, HomeConversationInputInvalidError, HomeConversationNotFoundError, HomeTurnNotActiveError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type {
  HomeConsentCategory,
  HomeConsentDisclosureDescriptor,
  HomeConsentDisclosureRecord,
  HomeConversationScope,
  HomeToolResultDisclosureDraft
} from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { HomePlanningProvider } from '@/modules/home-assistant/repositories/home-planning-runtime';
import { redactEgressText } from '@/shared/egress/redaction';

const MAX_TOOL_RESULT_BYTES = 256 * 1024;
const MAX_TOOL_REQUEST_ID_LENGTH = 128;
const ALLOWED_CATEGORIES: readonly HomeConsentCategory[] = ['current_message', 'bounded_home_history', 'task_metadata', 'workspace_metadata'];

export interface RequestHomeToolResultConsentInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly requestId: string;
  readonly scope: HomeConversationScope;
  readonly categories: readonly HomeConsentCategory[];
  readonly itemCount: number;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface PendingHomeToolResult {
  readonly requestId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly fingerprint: string;
  readonly byteLimit: number;
  readonly categories: readonly HomeConsentCategory[];
  readonly itemCount: number;
  readonly scope: HomeConversationScope;
}

/** Holds bounded redacted result data only in memory until its one-turn consent decision. */
export class HomeToolResultConsentGate {
  private readonly pending = new Map<string, PendingHomeToolResult>();

  public constructor(private readonly conversations: IHomeConversationRepository, private readonly provider: HomePlanningProvider) {}

  public async request(input: RequestHomeToolResultConsentInput): Promise<HomeConsentDisclosureDescriptor> {
    if (encodedBytes(input.data) > MAX_TOOL_RESULT_BYTES * 4) throw new HomeConversationInputInvalidError('The Home tool result exceeds its pre-redaction limit.');
    const safe = sanitizeToolResult(input.data);
    const encoded = JSON.stringify(safe);
    const byteLimit = Buffer.byteLength(encoded, 'utf8');
    validateRequest(input, byteLimit);
    const turn = await this.conversations.findTurnForOwner(input.ownerId, input.conversationId, input.turnId);
    if (!turn) throw new HomeConversationNotFoundError();
    if (turn.status !== 'running') throw new HomeTurnNotActiveError();
    const draft: HomeToolResultDisclosureDraft = {
      disclosureId: randomUuid(),
      phase: 'tool_result',
      runtimeRequestId: input.requestId,
      resultFingerprint: fingerprint(encoded),
      provider: { profile: this.provider.profile, name: providerDisplayName(this.provider.profile), model: this.provider.model },
      scope: input.scope,
      categories: input.categories,
      itemCount: input.itemCount,
      byteLimit
    };
    const persisted = await this.conversations.createToolResultDisclosure({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      draft
    });
    if (!persisted) throw new HomeConversationNotFoundError();
    if (persisted.disclosure.resultFingerprint !== draft.resultFingerprint) throw new HomeConsentDecisionStaleError();
    if (persisted.disclosure.decision !== null || persisted.disclosure.deliveryState !== 'awaiting_decision') throw new HomeConsentDecisionStaleError();
    this.pending.set(persisted.disclosure.disclosureId, {
      requestId: input.requestId,
      data: safe,
      fingerprint: draft.resultFingerprint,
      byteLimit,
      categories: input.categories,
      itemCount: input.itemCount,
      scope: input.scope
    });
    return descriptor(persisted.disclosure);
  }

  public take(disclosureId: string): PendingHomeToolResult | null {
    const value = this.pending.get(disclosureId) ?? null;
    this.pending.delete(disclosureId);
    return value;
  }
}

function sanitizeToolResult(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const sanitized = sanitizeJsonValue(value, 0);
  if (!isRecord(sanitized)) throw new HomeConversationInputInvalidError('The Home tool result is invalid.');
  return sanitized;
}

function sanitizeJsonValue(value: unknown, depth: number): unknown {
  if (depth > 32) throw new HomeConversationInputInvalidError('The Home tool result is too deeply nested.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactEgressText(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item, depth + 1));
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new HomeConversationInputInvalidError('The Home tool result is not plain JSON.');
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, isSensitiveKey(key) ? '[REDACTED]' : sanitizeJsonValue(item, depth + 1)]));
  }
  throw new HomeConversationInputInvalidError('The Home tool result is not valid JSON.');
}

function isSensitiveKey(value: string): boolean {
  const normalized = value.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase();
  if (/(?:api[_-]?key|access[_-]?(?:key|token)|refresh[_-]?token|password|passwd|secret|credential|private[_-]?key|token)/u.test(normalized)) {
    return true;
  }

  const segments = normalized.split(/[^a-z0-9]+/u).filter(Boolean);
  if (segments.some((segment) => ['auth', 'authorization', 'authentication', 'cookie', 'cookies'].includes(segment))) {
    return true;
  }

  const compact = normalized.replace(/[^a-z0-9]/gu, '');
  if (compact === 'session' || /^session(?:id|key|token|cookie|secret|credential|auth|sid)/u.test(compact)) {
    return true;
  }

  const sessionIndex = segments.indexOf('session');
  const nextSegment = sessionIndex < 0 ? undefined : segments[sessionIndex + 1];
  return nextSegment !== undefined && /^(?:id|key|token|cookie|secret|credentials?|auth|sid)/u.test(nextSegment);
}

function validateRequest(input: RequestHomeToolResultConsentInput, byteLimit: number): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(input.requestId) || input.requestId.length > MAX_TOOL_REQUEST_ID_LENGTH
    || input.categories.length < 1 || input.categories.length > 4 || new Set(input.categories).size !== input.categories.length
    || !input.categories.every((category) => ALLOWED_CATEGORIES.includes(category))
    || !Number.isSafeInteger(input.itemCount) || input.itemCount < 1 || input.itemCount > 100000
    || byteLimit < 1 || byteLimit > MAX_TOOL_RESULT_BYTES) {
    throw new HomeConversationInputInvalidError('The Home tool result disclosure exceeds its supported bounds.');
  }
}

function descriptor(value: HomeConsentDisclosureRecord): HomeConsentDisclosureDescriptor {
  return {
    disclosureId: value.disclosureId,
    phase: value.phase,
    provider: { profile: value.providerProfile, name: value.providerName, model: value.model },
    scope: value.scope,
    categories: value.categories,
    itemCount: value.itemCount,
    byteLimit: value.byteLimit
  };
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function encodedBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(encoded, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function randomUuid(): string {
  return randomUUID();
}

function providerDisplayName(profile: string): string {
  if (profile === 'nebius-token-factory') return 'Nebius Token Factory';
  if (profile === 'nvidia-hosted-nim') return 'NVIDIA hosted NIM';
  return profile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
