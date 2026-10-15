import { createHash } from 'node:crypto';

import type { GlobalTaskQueryCursorPosition, GlobalTaskQueryFilters } from '@/modules/tasks/domain/global-task-query';
import { TaskQueryCursorInvalidError } from '@/modules/tasks/domain/global-task-query-errors';

interface EncodedTaskQueryCursor extends GlobalTaskQueryCursorPosition {
  readonly version: 1;
  readonly fingerprint: string;
}

const CURSOR_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isExactUtcTimestamp(value: string): boolean {
  if (!CURSOR_DATE.test(value)) return false;
  const dateTime = value.slice(0, 19);
  const year = Number(value.slice(0, 4));
  const parsed = new Date(`${dateTime}.${value.slice(20, 23)}Z`);
  return year > 0 && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === dateTime;
}

function queryFingerprint(ownerId: string, filters: GlobalTaskQueryFilters): string {
  return createHash('sha256').update(JSON.stringify({ ownerId, filters })).digest('hex');
}

export function encodeGlobalTaskQueryCursor(
  position: GlobalTaskQueryCursorPosition,
  ownerId: string,
  filters: GlobalTaskQueryFilters
): string {
  const value: EncodedTaskQueryCursor = { version: 1, ...position, fingerprint: queryFingerprint(ownerId, filters) };
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeGlobalTaskQueryCursor(
  cursor: string,
  ownerId: string,
  filters: GlobalTaskQueryFilters
): GlobalTaskQueryCursorPosition {
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error('Invalid token encoding.');
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(json).toString('base64url') !== cursor) throw new Error('Non-canonical token encoding.');
    const value: unknown = JSON.parse(json);
    if (!isCursor(value) || value.fingerprint !== queryFingerprint(ownerId, filters)) throw new Error('Invalid token payload.');
    return { createdAt: value.createdAt, taskId: value.taskId };
  } catch {
    throw new TaskQueryCursorInvalidError();
  }
}

function isCursor(value: unknown): value is EncodedTaskQueryCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  return Object.keys(cursor).length === 4
    && cursor.version === 1
    && typeof cursor.createdAt === 'string'
    && isExactUtcTimestamp(cursor.createdAt)
    && typeof cursor.taskId === 'string'
    && UUID.test(cursor.taskId)
    && typeof cursor.fingerprint === 'string'
    && /^[a-f0-9]{64}$/u.test(cursor.fingerprint);
}
