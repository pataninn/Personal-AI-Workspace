import { HomeConversationCursorInvalidError, HomeConversationEventInvalidError, HomeConversationScopeInvalidError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type {
  HomeConversation,
  HomeConversationEvent,
  HomeConversationEventPayload,
  HomeConversationEventType,
  HomeConversationScope,
  HomeMessage,
  HomeMessageRole,
  HomeTurn,
  HomeTurnStatus
} from '@/modules/home-assistant/domain/home-conversation-types';

type Timestamp = Date | string;

export interface HomeConversationRow {
  readonly id: string;
  readonly owner_id: string;
  readonly scope: 'home' | 'workspace';
  readonly workspace_id: string | null;
  readonly title: string;
  readonly last_event_sequence: number | string;
  readonly last_activity_at: Timestamp;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface HomeConversationListRow extends HomeConversationRow {
  /** Exact UTC timestamp text used for keyset pagination; keeps PostgreSQL microseconds. */
  readonly cursor_activity_at: string;
}

export interface HomeTurnRow {
  readonly id: string;
  readonly owner_id: string;
  readonly conversation_id: string;
  readonly sequence: number | string;
  readonly request_key: string;
  readonly status: HomeTurnStatus;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface HomeMessageRow {
  readonly id: string;
  readonly owner_id: string;
  readonly conversation_id: string;
  readonly turn_id: string;
  readonly sequence: number | string;
  readonly role: HomeMessageRole;
  readonly content: string;
  readonly created_at: Timestamp;
}

export interface HomeConversationEventRow {
  readonly sequence: number | string;
  readonly event_type: string;
  readonly turn_id: string | null;
  readonly entity_id: string | null;
  readonly payload: unknown;
  readonly created_at: Timestamp;
}

function toDate(value: Timestamp): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Maps the database scope pair and rejects states the schema should prohibit. */
export function toHomeConversationScope(scope: 'home' | 'workspace', workspaceId: string | null): HomeConversationScope {
  if (scope === 'home' && workspaceId === null) {
    return { kind: 'home' };
  }
  if (scope === 'workspace' && workspaceId !== null) {
    return { kind: 'workspace', workspaceId };
  }
  throw new HomeConversationScopeInvalidError();
}

/** Maps a Home conversation row into the storage-independent domain shape. */
export function toHomeConversation(row: HomeConversationRow): HomeConversation {
  return {
    id: row.id,
    ownerId: row.owner_id,
    scope: toHomeConversationScope(row.scope, row.workspace_id),
    title: row.title,
    lastEventSequence: Number(row.last_event_sequence),
    lastActivityAt: toDate(row.last_activity_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

/** Maps an allowlisted event row while rejecting unexpected JSON payload shapes. */
export function toHomeConversationEvent(row: HomeConversationEventRow): HomeConversationEvent {
  if (!isHomeConversationEventType(row.event_type) || !isScalarRecord(row.payload)) {
    throw new HomeConversationEventInvalidError();
  }
  return {
    sequence: Number(row.sequence),
    type: row.event_type,
    turnId: row.turn_id,
    entityId: row.entity_id,
    payload: row.payload,
    createdAt: toDate(row.created_at)
  };
}

/** Maps a turn row while normalizing PostgreSQL integer values. */
export function toHomeTurn(row: HomeTurnRow): HomeTurn {
  return {
    id: row.id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    sequence: Number(row.sequence),
    requestKey: row.request_key,
    status: row.status,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

/** Maps a message row while normalizing PostgreSQL integer values. */
export function toHomeMessage(row: HomeMessageRow): HomeMessage {
  return {
    id: row.id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    sequence: Number(row.sequence),
    role: row.role,
    content: row.content,
    createdAt: toDate(row.created_at)
  };
}

/** Encodes a stable activity cursor without converting the database timestamp through JS Date. */
export function encodeHomeConversationCursor(lastActivityAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ lastActivityAt, id })).toString('base64url');
}

/** Decodes and validates a stable activity cursor. */
export function decodeHomeConversationCursor(cursor: string): { readonly lastActivityAt: string; readonly id: string } {
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) {
      throw new Error('invalid cursor encoding');
    }
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(value) || typeof value.lastActivityAt !== 'string' || !isCanonicalCursorTimestamp(value.lastActivityAt)
      || typeof value.id !== 'string' || !isUuid(value.id)) {
      throw new Error('invalid cursor fields');
    }
    return { lastActivityAt: value.lastActivityAt, id: value.id };
  } catch {
    throw new HomeConversationCursorInvalidError();
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

/** Matches the exact UTC microsecond timestamp emitted by the Home list query. */
function isCanonicalCursorTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/u.exec(value);
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (daysInMonth[month - 1] ?? 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHomeConversationEventType(value: string): value is HomeConversationEventType {
  return value === 'conversation.created'
    || value === 'turn.created'
    || value === 'turn.status_changed'
    || value === 'message.appended'
    || value === 'action.receipt';
}

function isScalarRecord(value: unknown): value is HomeConversationEventPayload {
  return isRecord(value) && Object.values(value).every((entry) => entry === null || ['string', 'number', 'boolean'].includes(typeof entry));
}
