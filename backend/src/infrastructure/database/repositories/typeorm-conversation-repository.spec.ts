import type { DataSource, QueryRunner } from 'typeorm';

import { TypeOrmConversationRepository } from '@/infrastructure/database/repositories/typeorm-conversation-repository';

const OWNER_ID = 'user-1';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-000000000001';
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

function queryRunnerFixture(): { readonly dataSource: DataSource; readonly queryRunner: QueryRunner; readonly query: jest.Mock } {
  const query = jest.fn()
    .mockResolvedValueOnce([{ status: 'active' }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([conversationRow])
    .mockResolvedValueOnce([{ sequence: 2 }])
    .mockResolvedValueOnce([messageRow])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);
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
    const repository = new TypeOrmConversationRepository(dataSource);

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
    expect(query.mock.calls[1]?.[0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[3]?.[0]).toContain('FOR UPDATE');
    expect(query.mock.calls[4]?.[0]).toContain('COALESCE(MAX');
    expect(query.mock.calls[4]?.[0]).not.toContain('FOR UPDATE');
  });
});
