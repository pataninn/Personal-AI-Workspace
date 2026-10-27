import type { DataSource, QueryRunner } from 'typeorm';

import {
  HomeConversationCursorInvalidError,
  HomeConversationNotFoundError,
  HomeRequestKeyReusedError,
  HomeTurnTransitionInvalidError
} from '@/modules/home-assistant/domain/home-conversation-errors';
import type {
  HomeConversationRow,
  HomeMessageRow,
  HomeTurnRow
} from '@/infrastructure/database/repositories/home-conversation-persistence-mappers';
import { encodeHomeConversationCursor } from '@/infrastructure/database/repositories/home-conversation-persistence-mappers';
import { TypeOrmHomeConversationRepository } from '@/infrastructure/database/repositories/typeorm-home-conversation-repository';

const OWNER_ID = 'owner-1';
const CONVERSATION_ID = 'conversation-1';
const TURN_ID = 'turn-1';

const conversationRow: HomeConversationRow = {
  id: CONVERSATION_ID,
  owner_id: OWNER_ID,
  scope: 'home',
  workspace_id: null,
  title: 'Home',
  last_event_sequence: 0,
  last_activity_at: new Date('2026-10-15T00:00:00.000Z'),
  created_at: new Date('2026-10-15T00:00:00.000Z'),
  updated_at: new Date('2026-10-15T00:00:00.000Z')
};

const turnRow: HomeTurnRow = {
  id: TURN_ID,
  owner_id: OWNER_ID,
  conversation_id: CONVERSATION_ID,
  sequence: 5,
  request_key: 'turn-request-1',
  status: 'pending',
  created_at: new Date('2026-10-15T00:00:00.000Z'),
  updated_at: new Date('2026-10-15T00:00:00.000Z')
};

const messageRow: HomeMessageRow = {
  id: 'message-1',
  owner_id: OWNER_ID,
  conversation_id: CONVERSATION_ID,
  turn_id: TURN_ID,
  sequence: 7,
  role: 'user',
  content: 'Remember this.',
  created_at: new Date('2026-10-15T00:00:00.000Z')
};

type QueryHandler = (query: string, parameters: readonly unknown[]) => readonly unknown[];

function createRepository(handler: QueryHandler): {
  readonly repository: TypeOrmHomeConversationRepository;
  readonly query: jest.Mock;
  readonly runner: QueryRunner;
} {
  let lastEventSequence = 0;
  const query = jest.fn(async (statement: string, parameters: unknown[] = []) => {
    if (statement.includes('FROM "users"') && statement.includes('FOR SHARE')) {
      return [{ id: String(parameters[0]) }];
    }
    if (statement.startsWith('INSERT INTO "account_limits"')) return [];
    if (statement.includes('FROM "account_limits"') && statement.includes('FOR UPDATE')) {
      return [{ storage_limit_bytes: null }];
    }
    if (statement.startsWith('INSERT INTO "storage_account_totals"')) return [];
    if (statement.includes('FROM "storage_account_totals"') && statement.includes('FOR UPDATE')) {
      return [{ used_bytes: '0', reserved_bytes: '0', accounting_state: 'ready' }];
    }
    if (statement.startsWith('SELECT "last_event_sequence", "workspace_id" FROM "home_conversations"')
      || statement.startsWith('SELECT "last_event_sequence" FROM "home_conversations"')) {
      return [{ last_event_sequence: lastEventSequence, workspace_id: null }];
    }
    if (statement.includes('SET "last_event_sequence"')) {
      lastEventSequence += 1;
      return [{ last_event_sequence: lastEventSequence }];
    }
    return handler(statement, parameters);
  });
  const runner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    isTransactionActive: true,
    query
  } as unknown as QueryRunner;
  const dataSource = { createQueryRunner: jest.fn(() => runner), query } as unknown as DataSource;
  return { repository: new TypeOrmHomeConversationRepository(dataSource), query, runner };
}

describe('TypeOrmHomeConversationRepository', () => {
  it('creates a Home conversation once and replays the same scoped request', async () => {
    let created = false;
    const { repository, query } = createRepository((statement) => {
      if (statement.includes('FROM "home_conversations"') && statement.includes('create_request_key')) {
        return created ? [{ ...conversationRow, request_fingerprint: 'fingerprint' }] : [];
      }
      if (statement.includes('INSERT INTO "home_conversations"')) {
        created = true;
        return [conversationRow];
      }
      return [];
    });
    const input = { ownerId: OWNER_ID, scope: { kind: 'home' as const }, title: 'Home', requestKey: 'create-1', requestFingerprint: 'fingerprint' };

    const first = await repository.create(input);
    const retry = await repository.create(input);

    expect(first.replayed).toBe(false);
    expect(retry).toMatchObject({ replayed: true, resource: { ownerId: OWNER_ID, scope: { kind: 'home' } } });
    expect(query.mock.calls.filter(([statement]) => String(statement).includes('INSERT INTO "home_conversations"'))).toHaveLength(1);
  });

  it('rejects a reused conversation key with a different fingerprint', async () => {
    const { repository, query } = createRepository((statement) => statement.includes('create_request_key')
      ? [{ ...conversationRow, request_fingerprint: 'original' }]
      : []);

    await expect(repository.create({ ownerId: OWNER_ID, scope: { kind: 'home' }, title: 'Changed', requestKey: 'create-1', requestFingerprint: 'different' }))
      .rejects.toBeInstanceOf(HomeRequestKeyReusedError);

    expect(query.mock.calls.some(([statement]) => String(statement).includes('INSERT INTO "home_conversations"'))).toBe(false);
  });

  it('does not create a workspace conversation for a foreign workspace', async () => {
    const { repository, query } = createRepository((statement) => statement.includes('FROM "projects"') ? [] : []);

    await expect(repository.create({
      ownerId: OWNER_ID,
      scope: { kind: 'workspace', workspaceId: 'foreign-workspace' },
      title: 'Planning',
      requestKey: 'create-2',
      requestFingerprint: 'fingerprint'
    })).rejects.toBeInstanceOf(HomeConversationNotFoundError);

    const workspaceLookup = query.mock.calls.find(([statement]) => String(statement).includes('FROM "projects"'));
    expect(workspaceLookup?.[1]).toEqual([OWNER_ID, 'foreign-workspace']);
    expect(query.mock.calls.some(([statement]) => String(statement).includes('INSERT INTO "home_conversations"'))).toBe(false);
  });

  it('allocates a turn sequence under the conversation lock and replays its request', async () => {
    let created = false;
    const { repository, query } = createRepository((statement) => {
      if (statement.includes('FROM "home_conversations"') && statement.includes('FOR UPDATE')) return [conversationRow];
      if (statement.includes('FROM "home_turns"') && statement.includes('request_key')) return created ? [{ ...turnRow, request_fingerprint: 'fingerprint' }] : [];
      if (statement.includes('MAX("sequence")')) return [{ sequence: '4' }];
      if (statement.includes('INSERT INTO "home_turns"')) { created = true; return [turnRow]; }
      return [];
    });
    const input = { ownerId: OWNER_ID, conversationId: CONVERSATION_ID, requestKey: 'turn-request-1', requestFingerprint: 'fingerprint' };

    const first = await repository.createTurn(input);
    const retry = await repository.createTurn(input);

    expect(first.resource.sequence).toBe(5);
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    const lockIndex = query.mock.calls.findIndex(([statement]) => String(statement).includes('FROM "home_conversations"') && String(statement).includes('FOR UPDATE'));
    const sequenceIndex = query.mock.calls.findIndex(([statement]) => String(statement).includes('MAX("sequence")'));
    expect(lockIndex).toBeLessThan(sequenceIndex);
    expect(query.mock.calls[sequenceIndex]?.[1]).toEqual([OWNER_ID, CONVERSATION_ID]);
  });

  it('persists Home and workspace policy revisions with the turn before the user message', async () => {
    const submittedTurn = { ...turnRow, status: 'running' as const, home_policy_revision: '17', workspace_policy_revision: null };
    const submittedMessage = { ...messageRow, sequence: 1 };
    const { repository, query } = createRepository((statement) => {
      if (statement.includes('FROM "home_conversations"') && statement.includes('FOR UPDATE')) return [conversationRow];
      if (statement.includes('FROM "home_turns"') && statement.includes('request_key')) return [];
      if (statement.includes('MAX("sequence")') && statement.includes('home_turns')) return [{ sequence: 1 }];
      if (statement.includes('MAX("sequence")') && statement.includes('home_messages')) return [{ sequence: 1 }];
      if (statement.startsWith('INSERT INTO "home_turns"')) return [submittedTurn];
      if (statement.startsWith('INSERT INTO "home_messages"')) return [submittedMessage];
      if (statement.includes('SELECT "id" FROM "home_messages"') && statement.includes('turn_id" = ANY')) return [{ id: messageRow.id }];
      return [];
    });

    const result = await repository.submitTurn({
      ownerId: OWNER_ID, conversationId: CONVERSATION_ID, requestKey: 'turn-request-1', requestFingerprint: 'fingerprint',
      message: 'Plan today', initialStatus: 'running', homePolicyRevision: '17', workspacePolicyRevision: null
    });

    const insert = query.mock.calls.find(([statement]) => String(statement).startsWith('INSERT INTO "home_turns"'));
    expect(insert?.[1]).toEqual([OWNER_ID, CONVERSATION_ID, 1, 'turn-request-1', 'fingerprint', 'running', '17', null, null, null]);
    expect(result.turn).toMatchObject({ homePolicyRevision: '17', workspacePolicyRevision: null, status: 'running' });
    expect(result.disclosure).toBeUndefined();
  });

  it('does not expose or create turns for another owner', async () => {
    const { repository, query } = createRepository(() => []);

    await expect(repository.createTurn({ ownerId: 'other-owner', conversationId: CONVERSATION_ID, requestKey: 'key', requestFingerprint: 'fp' }))
      .rejects.toBeInstanceOf(HomeConversationNotFoundError);

    const conversationLookup = query.mock.calls.find(([statement]) =>
      String(statement).includes('FROM "home_conversations"') && String(statement).includes('FOR UPDATE'));
    expect(conversationLookup?.[1]).toEqual(['other-owner', CONVERSATION_ID]);
    expect(query.mock.calls.some(([statement]) => String(statement).includes('INSERT INTO "home_turns"'))).toBe(false);
  });

  it('allows unknown-turn reconciliation and rejects a terminal state reversal', async () => {
    let turnStatus = 'unknown';
    const { repository, query } = createRepository((statement) => {
      if (statement.includes('FROM "home_conversations"') && statement.includes('FOR UPDATE')) return [conversationRow];
      if (statement.includes('FROM "home_turns"') && statement.includes('FOR UPDATE')) return [{ ...turnRow, status: turnStatus }];
      if (statement.startsWith('UPDATE "home_turns"')) { turnStatus = 'completed'; return [{ ...turnRow, status: 'completed' }]; }
      return [];
    });

    const reconciled = await repository.updateTurnStatus({ ownerId: OWNER_ID, conversationId: CONVERSATION_ID, turnId: TURN_ID, status: 'completed' });
    expect(reconciled?.status).toBe('completed');

    turnStatus = 'completed';
    await expect(repository.updateTurnStatus({ ownerId: OWNER_ID, conversationId: CONVERSATION_ID, turnId: TURN_ID, status: 'running' }))
      .rejects.toBeInstanceOf(HomeTurnTransitionInvalidError);
    expect(query.mock.calls.filter(([statement]) => String(statement).startsWith('UPDATE "home_turns"'))).toHaveLength(1);
  });

  it('assigns messages a conversation sequence and replays their request key', async () => {
    let created = false;
    const { repository, query } = createRepository((statement) => {
      if (statement.includes('FROM "home_conversations"') && statement.includes('FOR UPDATE')) return [conversationRow];
      if (statement.includes('FROM "home_messages"') && statement.includes('request_key')) return created ? [{ ...messageRow, request_fingerprint: 'message-fp' }] : [];
      if (statement.includes('FROM "home_turns"') && statement.includes('FOR UPDATE')) return [{ id: TURN_ID }];
      if (statement.includes('MAX("sequence")')) return [{ sequence: '6' }];
      if (statement.includes('INSERT INTO "home_messages"')) { created = true; return [messageRow]; }
      return [];
    });
    const input = { ownerId: OWNER_ID, conversationId: CONVERSATION_ID, turnId: TURN_ID, role: 'user' as const, content: 'Remember this.', requestKey: 'message-1', requestFingerprint: 'message-fp' };

    const first = await repository.appendMessage(input);
    const retry = await repository.appendMessage(input);

    expect(first.resource.sequence).toBe(7);
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(query.mock.calls.filter(([statement]) => String(statement).includes('INSERT INTO "home_messages"'))).toHaveLength(1);
  });

  it('returns only the owner-scoped message page in ascending order', async () => {
    const descendingRows = [3, 2, 1].map((sequence) => ({ ...messageRow, id: `message-${sequence}`, sequence }));
    const { repository, query } = createRepository((statement) => {
      if (statement.includes('FROM "home_conversations"')) return [conversationRow];
      if (statement.includes('FROM "home_messages"')) return descendingRows;
      return [];
    });

    const page = await repository.listMessagesForOwner({ ownerId: OWNER_ID, conversationId: CONVERSATION_ID, limit: 2 });

    expect(page?.messages.map((message) => message.sequence)).toEqual([2, 3]);
    expect(page?.nextBeforeSequence).toBe(2);
    const messageQuery = query.mock.calls.find(([statement]) => String(statement).includes('FROM "home_messages"'));
    expect(messageQuery?.[1]).toEqual([OWNER_ID, CONVERSATION_ID, 3]);
  });

  it('filters system and tool messages before applying the transcript history limit', async () => {
    const { repository, query } = createRepository((statement) => {
      if (statement.includes('FROM "home_conversations"')) return [conversationRow];
      if (statement.includes('FROM "home_messages"')) return [messageRow];
      return [];
    });

    await repository.listMessagesForOwner({ ownerId: OWNER_ID, conversationId: CONVERSATION_ID, limit: 8, beforeSequence: 12, transcriptOnly: true });

    const messageQuery = query.mock.calls.find(([statement]) => String(statement).includes('FROM "home_messages"'));
    expect(String(messageQuery?.[0])).toContain('"sequence" < $3');
    expect(String(messageQuery?.[0])).toContain('"role" IN (\'user\', \'assistant\')');
    expect(messageQuery?.[1]).toEqual([OWNER_ID, CONVERSATION_ID, 12, 9]);
  });

  it('preserves PostgreSQL microseconds in the activity cursor across pages', async () => {
    const newerTimestamp = '2026-10-15T12:00:00.123456Z';
    const olderTimestamp = '2026-10-15T12:00:00.123200Z';
    const newerRow = {
      ...conversationRow,
      id: '55555555-5555-4555-8555-555555555555',
      last_activity_at: newerTimestamp,
      cursor_activity_at: newerTimestamp
    };
    const olderRow = {
      ...conversationRow,
      id: '66666666-6666-4666-8666-666666666666',
      last_activity_at: olderTimestamp,
      cursor_activity_at: olderTimestamp
    };
    const { repository, query } = createRepository((statement, parameters) => {
      if (!statement.includes('FROM "home_conversations"')) return [];
      if (statement.includes('"last_activity_at" <')) {
        return parameters[2] === newerTimestamp ? [olderRow] : [];
      }
      return [newerRow, olderRow];
    });

    const firstPage = await repository.listForOwner({ ownerId: OWNER_ID, scope: { kind: 'home' }, limit: 1 });
    const cursor = firstPage.nextCursor;
    if (cursor === null) throw new Error('Expected the first activity page to have a cursor.');
    const secondPage = await repository.listForOwner({
      ownerId: OWNER_ID,
      scope: { kind: 'home' },
      limit: 1,
      cursor
    });

    expect(firstPage.conversations.map((conversation) => conversation.id)).toEqual(['55555555-5555-4555-8555-555555555555']);
    expect(secondPage.conversations.map((conversation) => conversation.id)).toEqual(['66666666-6666-4666-8666-666666666666']);
    const secondQuery = query.mock.calls.find(([, parameters]) => parameters.includes(newerTimestamp));
    expect(secondQuery?.[1]).toEqual([OWNER_ID, 'home', newerTimestamp, '55555555-5555-4555-8555-555555555555', 2]);
    expect(String(secondQuery?.[0])).toContain('to_char("last_activity_at" AT TIME ZONE \'UTC\'');
    expect(String(secondQuery?.[0])).toContain('SS.US');
  });

  it.each([
    ['an empty cursor', ''],
    ['a non-UUID id', encodeHomeConversationCursor('2026-10-15T12:00:00.123456Z', 'not-a-uuid')],
    ['a timestamp without six fractional digits', encodeHomeConversationCursor('2026-10-15T12:00:00.123Z', '55555555-5555-4555-8555-555555555555')],
    ['an impossible calendar date', encodeHomeConversationCursor('2026-02-30T12:00:00.123456Z', '55555555-5555-4555-8555-555555555555')]
  ])('rejects a cursor with %s before querying PostgreSQL', async (_description, cursor) => {
    const { repository, query } = createRepository(() => []);

    await expect(repository.listForOwner({ ownerId: OWNER_ID, scope: { kind: 'home' }, limit: 10, cursor }))
      .rejects.toBeInstanceOf(HomeConversationCursorInvalidError);
    expect(query).not.toHaveBeenCalled();
  });
});
