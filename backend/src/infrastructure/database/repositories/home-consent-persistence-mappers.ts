import { HomeConversationEventInvalidError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type {
  HomeConsentCategory,
  HomeConsentDecision,
  HomeConsentDeliveryState,
  HomeConsentDisclosureRecord,
  HomeConsentPhase,
  HomeConversationScope
} from '@/modules/home-assistant/domain/home-conversation-types';

export interface HomeConsentDisclosureRow {
  readonly disclosure_id: string;
  readonly owner_id: string;
  readonly conversation_id: string;
  readonly turn_id: string;
  readonly phase: string;
  readonly provider_profile: string;
  readonly provider_name: string;
  readonly model: string;
  readonly scope_kind: string;
  readonly scope_id: string | null;
  readonly categories: unknown;
  readonly item_count: number | string;
  readonly byte_limit: number | string;
  readonly runtime_request_id: string | null;
  readonly result_fingerprint: string | null;
  readonly decision: string | null;
  readonly delivery_state: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const CATEGORIES: readonly HomeConsentCategory[] = ['current_message', 'bounded_home_history', 'task_metadata', 'workspace_metadata'];

/** Maps consent facts while rejecting persisted records outside the disclosure bounds. */
export function toHomeConsentDisclosure(row: HomeConsentDisclosureRow): HomeConsentDisclosureRecord {
  const scope = toScope(row.scope_kind, row.scope_id);
  const categories = toCategories(row.categories);
  if (!isPhase(row.phase) || !isDeliveryState(row.delivery_state) || !isDecision(row.decision)
    || !Number.isSafeInteger(Number(row.item_count)) || Number(row.item_count) < 1
    || !Number.isSafeInteger(Number(row.byte_limit)) || Number(row.byte_limit) < 1 || Number(row.byte_limit) > 262144
    || (row.phase === 'initial' && (row.runtime_request_id !== null || row.result_fingerprint !== null))
    || (row.phase === 'tool_result' && (!isRuntimeRequestId(row.runtime_request_id) || !isFingerprint(row.result_fingerprint)))) {
    throw new HomeConversationEventInvalidError();
  }
  return {
    disclosureId: row.disclosure_id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    phase: row.phase,
    providerProfile: row.provider_profile,
    providerName: row.provider_name,
    model: row.model,
    scope,
    categories,
    itemCount: Number(row.item_count),
    byteLimit: Number(row.byte_limit),
    runtimeRequestId: row.runtime_request_id,
    resultFingerprint: row.result_fingerprint,
    decision: row.decision,
    deliveryState: row.delivery_state,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

function isRuntimeRequestId(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function isFingerprint(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{64}$/u.test(value);
}

function toScope(kind: string, id: string | null): HomeConversationScope {
  if (kind === 'home' && id === null) return { kind: 'home' };
  if (kind === 'workspace' && id !== null) return { kind: 'workspace', workspaceId: id };
  throw new HomeConversationEventInvalidError();
}

function toCategories(value: unknown): readonly HomeConsentCategory[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4
    || !value.every((category): category is HomeConsentCategory => typeof category === 'string' && CATEGORIES.includes(category as HomeConsentCategory))) {
    throw new HomeConversationEventInvalidError();
  }
  return value;
}

function isPhase(value: string): value is HomeConsentPhase {
  return value === 'initial' || value === 'tool_result';
}

function isDecision(value: string | null): value is HomeConsentDecision | null {
  return value === null || value === 'allow' || value === 'deny';
}

function isDeliveryState(value: string): value is HomeConsentDeliveryState {
  return value === 'awaiting_decision' || value === 'starting' || value === 'accepted'
    || value === 'unavailable' || value === 'unknown' || value === 'not_required';
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
