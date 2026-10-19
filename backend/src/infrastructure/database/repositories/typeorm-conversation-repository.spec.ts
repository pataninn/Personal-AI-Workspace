import type { DataSource, QueryRunner } from 'typeorm';

import { TypeOrmConversationRepository } from '@/infrastructure/database/repositories/typeorm-conversation-repository';
import type { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';

const OWNER_ID = 'user-1';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-000000000001';
const IDEMPOTENCY_ID = '66666666-6666-4666-8666-000000000001';
const NOW = new Date('2026-09-12T12:00:00.000Z');

const conversationRow = {
  id: CONVERSATION_ID,
  owner_id: OWNER_ID,
  project_id: PROJECT_ID,
  title: 'Notes',
  status: 'active' as const,
  last_activity_at: NOW,
  created_at: NOW,
  updated_at: NOW
};

const messageRow = {
  id: '55555555-5555-4555-8555-000000000001',
  conversation_id: CONVERSATION_ID,
  role: 'user' as const,
  sequence: 2,
  content: 'second message',
  created_at: NOW
};

const passThroughStorageAccounting = {
  runMutation: async <T>(_transaction: unknown, _ownerId: string, mutation: () => Promise<T>): Promise<T> => mutation()
} as unknown as TypeOrmStorageContentAccounting;

function queryRunnerFixture(): { readonly dataSource: DataSource; readonly queryRunner: QueryRunner; readonly query: jest.Mock } {
  const query = jest.fn(async (sql: string): Promise<unknown> => {
    if (sql.includes('FROM "projects"') && sql.includes('FOR UPDATE')) return [{ status: 'active', relative_root: null }];
    if (sql.includes('FROM "project_removal_jobs"')) return [];
    if (sql.includes('pg_advisory_xact_lock')) return [];
    if (sql.includes('FROM "conversation_idempotency_keys"')) return [];
    if (sql.includes('FROM "conversations"') && sql.includes('FOR UPDATE')) return [conversationRow];
    if (sql.includes('COALESCE(MAX("sequence")')) return [{ sequence: 2 }];
    if (sql.startsWith('INSERT INTO "messages"')) return [messageRow];
    if (sql.startsWith('INSERT INTO "conversation_idempotency_keys"')) return [{ id: IDEMPOTENCY_ID }];
    return [];
  });
  const queryRunner = {
    query,
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined)
  } as unknown as QueryRunner;
  const dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as unknown as DataSource;
  return { dataSource, queryRunner, query };
}

describe('TypeOrmConversationRepository sequencing locks', () => {
  it('locks the project and conversation rows before allocating a sequence', async () => {
    const { dataSource, queryRunner, query } = queryRunnerFixture();
    const repository = new TypeOrmConversationRepository(dataSource, passThroughStorageAccounting);

    const result = await repository.addUserMessage({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      content: 'second message',
      idempotencyKey: 'message-lock-test',
      requestFingerprint: JSON.stringify({ conversationId: CONVERSATION_ID, content: 'second message' })
    });

    expect(result.resource.sequence).toBe(2);
    expect(queryRunner.startTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(query.mock.calls[1]?.[0]).toContain('project_removal_jobs');
    expect(query.mock.calls[2]?.[0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[4]?.[0]).toContain('FOR UPDATE');
    expect(query.mock.calls[5]?.[0]).toContain('COALESCE(MAX');
    expect(query.mock.calls[5]?.[0]).not.toContain('FOR UPDATE');
  });

  it('uses the run-scoped idempotency key even when the request text repeats', async () => {
    const { dataSource, queryRunner, query } = queryRunnerFixture();
    const repository = new TypeOrmConversationRepository(dataSource, passThroughStorageAccounting);

    const result = await repository.addRunUserMessage({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      content: 'second message',
      idempotencyKey: 'run-user-run-2',
      requestFingerprint: JSON.stringify({ runId: 'run-2', content: 'second message' })
    });

    expect(result.resource.id).toBe(messageRow.id);
    expect(query.mock.calls.some(([sql, params]) => String(sql).includes('run-user-run-2') || (Array.isArray(params) && params.includes('run-user-run-2')))).toBe(true);
    expect(queryRunner.startTransaction).toHaveBeenCalledTimes(1);
  });
});
