import type { DataSource, QueryRunner } from 'typeorm';

import { TypeOrmSkillRepository } from '@/infrastructure/database/repositories/typeorm-skill-repository';
import type { StorageContentMutationScope } from '@/infrastructure/database/storage-content-projections';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const SKILL_ID = '33333333-3333-4333-8333-333333333333';
const REVISION_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-19T00:00:00.000Z');

describe('TypeOrmSkillRepository.findActiveEnabledForShowcase', () => {
  it('loads only selected enabled skills owned by the publisher and scoped to the source project or account', async () => {
    const query = jest.fn(async (_sql: string, _parameters?: readonly unknown[]) => [{
      id: SKILL_ID,
      revision_id: REVISION_ID,
      owner_id: OWNER_ID,
      workspace_id: PROJECT_ID,
      title: 'Plan my day',
      instructions: 'Review selected tasks.',
      declared_tools: ['home_task_read'],
      enabled: true,
      version: 2,
      created_at: NOW,
      updated_at: NOW
    }]);
    const repository = new TypeOrmSkillRepository({ query } as unknown as DataSource);

    const result = await repository.findActiveEnabledForShowcase(OWNER_ID, PROJECT_ID, [SKILL_ID]);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('s."owner_id" = $1'), [OWNER_ID, PROJECT_ID, [SKILL_ID]]);
    expect(query.mock.calls[0]?.[0]).toContain('r."enabled" = true');
    expect(query.mock.calls[0]?.[0]).toContain('(s."workspace_id" IS NULL OR s."workspace_id" = $2)');
    expect(query.mock.calls[0]?.[0]).toContain('s."id" = ANY($3::uuid[])');
    expect(result).toMatchObject([{ id: SKILL_ID, revisionId: REVISION_ID, ownerId: OWNER_ID, workspaceId: PROJECT_ID, version: 2 }]);
  });

  it('does not query when no skills were allowlisted', async () => {
    const query = jest.fn(async (_sql: string, _parameters?: readonly unknown[]) => []);
    const repository = new TypeOrmSkillRepository({ query } as unknown as DataSource);

    await expect(repository.findActiveEnabledForShowcase(OWNER_ID, PROJECT_ID, [])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('TypeOrmSkillRepository revision storage accounting', () => {
  it('keeps prior immutable revisions in the accounted scope when editing a skill', async () => {
    const nextRevisionId = '55555555-5555-4555-8555-555555555555';
    let updated = false;
    let revisionRead = 0;
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT "id" FROM "skill_revisions"')) {
        revisionRead += 1;
        return revisionRead === 1 ? [{ id: REVISION_ID }] : [{ id: REVISION_ID }, { id: nextRevisionId }];
      }
      if (sql.startsWith('SELECT s."id", r."id" AS "revision_id"')) {
        return [{
          id: SKILL_ID,
          revision_id: updated ? nextRevisionId : REVISION_ID,
          owner_id: OWNER_ID,
          workspace_id: null,
          title: updated ? 'Updated title' : 'Original title',
          instructions: updated ? 'Updated instructions.' : 'Original instructions.',
          declared_tools: ['home_task_read'],
          enabled: true,
          version: updated ? 2 : 1,
          created_at: NOW,
          updated_at: NOW
        }];
      }
      if (sql.startsWith('UPDATE "skills" SET')) {
        updated = true;
        return [{ id: SKILL_ID, owner_id: OWNER_ID, workspace_id: null, current_version: 2, created_at: NOW, updated_at: NOW }];
      }
      if (sql.startsWith('INSERT INTO "skill_revisions"')) return [{ id: nextRevisionId }];
      throw new Error(`Unexpected skill repository query: ${sql}`);
    });
    const queryRunner = {
      connect: async () => undefined,
      startTransaction: async () => undefined,
      commitTransaction: async () => undefined,
      rollbackTransaction: async () => undefined,
      release: async () => undefined,
      isTransactionActive: false,
      query
    } as unknown as QueryRunner;
    const dataSource = { createQueryRunner: jest.fn(() => queryRunner) } as unknown as DataSource;
    let accountedBefore: readonly { readonly id: string }[] = [];
    let accountedAfter: readonly { readonly id: string }[] = [];
    const accounting = {
      runMutation: async <T>(
        transaction: QueryRunner,
        _ownerId: string,
        mutate: () => Promise<T>,
        scope: StorageContentMutationScope<T>
      ) => {
        const quotaTransaction = transaction as unknown as { query: (sql: string, parameters?: unknown[]) => Promise<unknown> };
        accountedBefore = await scope.before(quotaTransaction);
        const result = await mutate();
        accountedAfter = await scope.after(quotaTransaction, result);
        return result;
      }
    };
    const repository = new TypeOrmSkillRepository(dataSource, accounting);

    await expect(repository.update({
      ownerId: OWNER_ID,
      skillId: SKILL_ID,
      expectedVersion: 1,
      workspaceId: null,
      title: 'Updated title',
      instructions: 'Updated instructions.',
      declaredTools: ['home_task_read'],
      enabled: true
    })).resolves.toMatchObject({ version: 2, revisionId: nextRevisionId });

    expect(accountedBefore).toEqual([{ entity: 'skill_revisions', id: REVISION_ID }]);
    expect(accountedAfter).toEqual([
      { entity: 'skill_revisions', id: REVISION_ID },
      { entity: 'skill_revisions', id: nextRevisionId }
    ]);
  });

  it('does not create a replacement when a create idempotency key belongs to a deleted skill', async () => {
    const query = jest.fn(async (_sql: string) => [{
      id: SKILL_ID,
      create_request_fingerprint: 'b'.repeat(64),
      deleted_at: NOW
    }]);
    const queryRunner = {
      connect: async () => undefined,
      startTransaction: async () => undefined,
      commitTransaction: async () => undefined,
      rollbackTransaction: async () => undefined,
      release: async () => undefined,
      isTransactionActive: false,
      query
    } as unknown as QueryRunner;
    const dataSource = { createQueryRunner: jest.fn(() => queryRunner) } as unknown as DataSource;
    const accounting = {
      runMutation: async <T>(_transaction: QueryRunner, _ownerId: string, mutation: () => Promise<T>) => await mutation()
    };
    const repository = new TypeOrmSkillRepository(dataSource, accounting);

    await expect(repository.create({
      ownerId: OWNER_ID,
      workspaceId: null,
      title: 'Plan my day',
      instructions: 'Plan work.',
      declaredTools: ['home_task_read'],
      enabled: true,
      idempotencyKeyDigest: 'a'.repeat(64),
      requestFingerprint: 'b'.repeat(64)
    })).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND', statusCode: 404 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('FOR UPDATE');
  });
});
