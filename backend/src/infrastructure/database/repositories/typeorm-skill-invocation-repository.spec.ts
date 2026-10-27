import type { DataSource, QueryRunner } from 'typeorm';

import { TypeOrmSkillInvocationRepository } from '@/infrastructure/database/repositories/typeorm-skill-invocation-repository';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const SKILL_ID = '33333333-3333-4333-8333-333333333333';
const REVISION_ID = '44444444-4444-4444-8444-444444444444';
const REQUEST_KEY_DIGEST = 'a'.repeat(64);
const REQUEST_FINGERPRINT = 'b'.repeat(64);

function repositoryWithRetainedInvocation(fingerprint: string) {
  const runner = {
    connect: jest.fn(async () => undefined),
    startTransaction: jest.fn(async () => undefined),
    commitTransaction: jest.fn(async () => undefined),
    rollbackTransaction: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    isTransactionActive: true,
    query: jest.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO "skill_invocations"')) return [];
      if (sql.includes('FROM "skill_invocations" i')) return [];
      if (sql.includes('SELECT "request_fingerprint"')) return [{ request_fingerprint: fingerprint }];
      throw new Error('Unexpected SQL in invocation claim test.');
    })
  };
  const dataSource = { createQueryRunner: jest.fn(() => runner) } as unknown as DataSource;
  return { repository: new TypeOrmSkillInvocationRepository(dataSource), runner: runner as unknown as QueryRunner };
}

describe('TypeOrmSkillInvocationRepository.claim', () => {
  const input = {
    ownerId: OWNER_ID,
    conversationId: CONVERSATION_ID,
    skillId: SKILL_ID,
    skillRevisionId: REVISION_ID,
    skillVersion: 1,
    requestKeyDigest: REQUEST_KEY_DIGEST,
    requestFingerprint: REQUEST_FINGERPRINT,
    contextRevisions: []
  };

  it('returns unavailable for an exact replay when the retained invocation source has been deleted', async () => {
    const { repository, runner } = repositoryWithRetainedInvocation(REQUEST_FINGERPRINT);

    await expect(repository.claim(input)).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND', statusCode: 404 });

    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it('keeps idempotency-key conflict behavior when a retained source is unavailable', async () => {
    const { repository } = repositoryWithRetainedInvocation('c'.repeat(64));

    await expect(repository.claim(input)).rejects.toMatchObject({ code: 'SKILL_IDEMPOTENCY_KEY_REUSED', statusCode: 409 });
  });
});
