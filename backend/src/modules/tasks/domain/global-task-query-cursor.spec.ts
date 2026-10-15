import { decodeGlobalTaskQueryCursor, encodeGlobalTaskQueryCursor } from '@/modules/tasks/domain/global-task-query-cursor';
import { TaskQueryCursorInvalidError } from '@/modules/tasks/domain/global-task-query-errors';
import type { GlobalTaskQueryFilters } from '@/modules/tasks/domain/global-task-query';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const FILTERS: GlobalTaskQueryFilters = { inboxOnly: false, includeArchived: false, limit: 25 };
const POSITION = { createdAt: '2026-10-16T08:09:10.123456Z', taskId: TASK };
const IMPOSSIBLE_TIMESTAMP_CURSOR = encodeGlobalTaskQueryCursor(
  { ...POSITION, createdAt: '2026-02-30T08:09:10.123456Z' },
  OWNER,
  FILTERS
);

describe('global task query cursor', () => {
  it('round-trips exact database timestamp precision', () => {
    const cursor = encodeGlobalTaskQueryCursor(POSITION, OWNER, FILTERS);
    expect(decodeGlobalTaskQueryCursor(cursor, OWNER, FILTERS)).toEqual(POSITION);
  });

  it.each([
    'not-a-cursor',
    Buffer.from(JSON.stringify({ version: 1, createdAt: '2026-10-16T08:09:10.123Z', taskId: TASK, fingerprint: 'a'.repeat(64) })).toString('base64url'),
    IMPOSSIBLE_TIMESTAMP_CURSOR
  ])(
    'rejects malformed cursor payload %s',
    (cursor) => expect(() => decodeGlobalTaskQueryCursor(cursor, OWNER, FILTERS)).toThrow(TaskQueryCursorInvalidError)
  );
});
