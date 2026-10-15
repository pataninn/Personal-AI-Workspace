import { HomeConversationCursorInvalidError, HomeConversationScopeInvalidError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type {
  HomeConversation,
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
    lastActivityAt: toDate(row.last_activity_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
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
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!isRecord(value) || typeof value.lastActivityAt !== 'string' || Number.isNaN(Date.parse(value.lastActivityAt)) || typeof value.id !== 'string') {
      throw new Error('invalid cursor fields');
    }
    return { lastActivityAt: value.lastActivityAt, id: value.id };
  } catch {
    throw new HomeConversationCursorInvalidError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
