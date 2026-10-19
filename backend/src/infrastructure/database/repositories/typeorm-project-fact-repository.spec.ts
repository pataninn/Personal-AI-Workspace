import type { DataSource, QueryRunner } from 'typeorm';

import { TypeOrmProjectFactRepository } from '@/infrastructure/database/repositories/typeorm-project-fact-repository';
import type { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { ProjectFactAlreadyExistsError, ProjectFactArchivedProjectError } from '@/modules/memory/domain/project-fact-errors';
import type { ProjectFactVersionRecord, UpdateProjectFactRecord } from '@/modules/memory/repositories/project-fact-repository';
import type { StorageQuotaTransaction } from '@/modules/storage-quotas/repositories/storage-quota-repository';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const FACT_ID = '33333333-3333-4333-8333-333333333333';
const CREATED_AT = new Date('2026-09-25T01:02:03.000Z');
const REVIEWED_AT = new Date('2026-09-26T01:02:03.000Z');

function row(overrides: Partial<{
  readonly version: number;
  readonly content: string;
  readonly verified_at: Date | string | null;
  readonly updated_at: Date | string;
}> = {}): Record<string, unknown> {
  return {
    id: FACT_ID,
    owner_id: OWNER_ID,
    project_id: PROJECT_ID,
    fact_key: 'test command',
    title: 'Test command',
    content: 'Run pnpm test.',
    version: 2,
    verified_at: REVIEWED_AT,
    created_at: CREATED_AT,
    updated_at: REVIEWED_AT,
    ...overrides
  };
}

function projectFactDataSource(query: jest.Mock): DataSource {
  return { query } as unknown as DataSource;
}

function transactionalDataSource(query: jest.Mock, removalPending = false) {
  const events: string[] = [];
  let transactionActive = false;
  const queryRunner = {
    query: jest.fn(async (sql: string, parameters?: unknown[]): Promise<unknown> => {
      if (sql.includes('FROM "projects"') && sql.includes('FOR UPDATE')) {
        events.push('project-lock');
        return [{ status: 'active', relative_root: null }];
      }
      if (sql.includes('FROM "project_removal_jobs"')) {
        events.push('removal-check');
        return removalPending ? [{ project_id: PROJECT_ID }] : [];
      }
      events.push('write');
      return query(sql, parameters);
    }),
    connect: jest.fn(async () => { events.push('connect'); }),
    startTransaction: jest.fn(async () => {
      events.push('begin');
      transactionActive = true;
    }),
    commitTransaction: jest.fn(async () => {
      events.push('commit');
      transactionActive = false;
    }),
    rollbackTransaction: jest.fn(async () => {
      events.push('rollback');
      transactionActive = false;
    }),
    release: jest.fn(async () => { events.push('release'); }),
    get isTransactionActive() { return transactionActive; }
  } as unknown as QueryRunner;
  const dataSourceQuery = jest.fn((sql: string, parameters?: unknown[]) => query(sql, parameters));
  const dataSource = {
    query: dataSourceQuery,
    createQueryRunner: jest.fn(() => queryRunner)
  } as unknown as DataSource;
  return { dataSource, dataSourceQuery, events, queryRunner };
}

class RecordingStorageAccounting implements Pick<TypeOrmStorageContentAccounting, 'runMutation'> {
  public readonly ownerIds: string[] = [];
  public readonly transactions: StorageQuotaTransaction[] = [];
  public denial: Error | null = null;

  public constructor(private readonly events: string[]) {}

  public async runMutation<T>(
    transaction: StorageQuotaTransaction,
    ownerId: string,
    mutation: () => Promise<T>
  ): Promise<T> {
    this.events.push('account');
    this.ownerIds.push(ownerId);
    this.transactions.push(transaction);
    const result = await mutation();
    const denial = this.denial;
    if (denial) throw denial;
    return result;
  }
}

describe('TypeOrmProjectFactRepository', () => {
  it('unwraps UPDATE results for review and maps a subsequent SELECT reread without storage mutation accounting', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([[row()], 1])
      .mockResolvedValueOnce([row()]);
    const storageAccounting = new RecordingStorageAccounting([]);
    const harness = transactionalDataSource(query);
    const repository = new TypeOrmProjectFactRepository(harness.dataSource, storageAccounting);
    const input: ProjectFactVersionRecord = { ownerId: OWNER_ID, projectId: PROJECT_ID, factId: FACT_ID, expectedVersion: 1 };

    const reviewed = await repository.verify(input);
    const reread = await repository.listActiveByProject(OWNER_ID, PROJECT_ID);

    expect(reviewed).toMatchObject({
      id: FACT_ID,
      version: 2,
      verificationStatus: 'verified',
      verifiedAt: REVIEWED_AT,
      updatedAt: REVIEWED_AT
    });
    expect(reread[0]?.verifiedAt?.toISOString()).toBe(REVIEWED_AT.toISOString());
    expect(reread[0]?.verificationStatus).toBe('verified');
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('"verified_at" = now()'), [OWNER_ID, PROJECT_ID, FACT_ID, 1]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('"deleted_at" IS NULL'), [OWNER_ID, PROJECT_ID]);
    expect(storageAccounting.ownerIds).toEqual([]);
  });

  it('returns null when a versioned review UPDATE affects no rows', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);
    const harness = transactionalDataSource(query);
    const repository = new TypeOrmProjectFactRepository(harness.dataSource);

    await expect(repository.verify({ ownerId: OWNER_ID, projectId: PROJECT_ID, factId: FACT_ID, expectedVersion: 8 }))
      .resolves.toBeNull();
  });

  it('creates facts inside the same owner-accounted QueryRunner transaction', async () => {
    const query = jest.fn().mockResolvedValue([row({ version: 1, verified_at: null })]);
    const harness = transactionalDataSource(query);
    const storageAccounting = new RecordingStorageAccounting(harness.events);
    const repository = new TypeOrmProjectFactRepository(harness.dataSource, storageAccounting);

    await expect(repository.create({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      key: 'test command',
      title: 'Test command',
      content: 'Run pnpm test.'
    })).resolves.toMatchObject({ id: FACT_ID, version: 1, content: 'Run pnpm test.' });

    expect(harness.events).toEqual(['connect', 'begin', 'account', 'project-lock', 'removal-check', 'write', 'commit', 'release']);
    expect(storageAccounting.ownerIds).toEqual([OWNER_ID]);
    expect(storageAccounting.transactions[0]).toBe(harness.queryRunner);
    expect(harness.dataSourceQuery).not.toHaveBeenCalled();
  });

  it('preserves optimistic update behavior while accounting only through the trusted owner transaction', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([row({ version: 3, verified_at: null, content: 'Run pnpm test --run.' })])
      .mockResolvedValueOnce([]);
    const harness = transactionalDataSource(query);
    const storageAccounting = new RecordingStorageAccounting(harness.events);
    const repository = new TypeOrmProjectFactRepository(harness.dataSource, storageAccounting);
    const update: UpdateProjectFactRecord = {
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      factId: FACT_ID,
      key: 'test command',
      title: 'Test command',
      content: 'Run pnpm test --run.',
      expectedVersion: 2
    };

    const updated = await repository.update(update);
    const stale = await repository.update({ ...update, expectedVersion: 1 });

    expect(updated).toMatchObject({ version: 3, content: 'Run pnpm test --run.', verificationStatus: 'needs_review', verifiedAt: null });
    expect(stale).toBeNull();
    expect(storageAccounting.ownerIds).toEqual([OWNER_ID, OWNER_ID]);
    expect(harness.events).toEqual([
      'connect', 'begin', 'account', 'project-lock', 'removal-check', 'write', 'commit', 'release',
      'connect', 'begin', 'account', 'project-lock', 'removal-check', 'write', 'commit', 'release'
    ]);
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('"version" = $7'), [
      update.key, update.title, update.content, OWNER_ID, PROJECT_ID, FACT_ID, 2
    ]);
    expect(harness.dataSourceQuery).not.toHaveBeenCalled();
  });

  it('rolls back a fact insert when quota admission rejects after the write callback', async () => {
    const query = jest.fn().mockResolvedValue([row({ version: 1, verified_at: null })]);
    const harness = transactionalDataSource(query);
    const storageAccounting = new RecordingStorageAccounting(harness.events);
    const denied = new Error('STORAGE_QUOTA_EXCEEDED');
    storageAccounting.denial = denied;
    const repository = new TypeOrmProjectFactRepository(harness.dataSource, storageAccounting);

    await expect(repository.create({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      key: 'test command',
      title: 'Test command',
      content: 'Run pnpm test.'
    })).rejects.toBe(denied);

    expect(harness.events).toEqual(['connect', 'begin', 'account', 'project-lock', 'removal-check', 'write', 'rollback', 'release']);
    expect(storageAccounting.ownerIds).toEqual([OWNER_ID]);
    expect(harness.dataSourceQuery).not.toHaveBeenCalled();
  });

  it('retains the duplicate-fact domain error and rolls back the attempted insert', async () => {
    const query = jest.fn().mockRejectedValue({ code: '23505' });
    const harness = transactionalDataSource(query);
    const storageAccounting = new RecordingStorageAccounting(harness.events);
    const repository = new TypeOrmProjectFactRepository(harness.dataSource, storageAccounting);

    await expect(repository.create({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      key: 'test command',
      title: 'Test command',
      content: 'Run pnpm test.'
    })).rejects.toBeInstanceOf(ProjectFactAlreadyExistsError);

    expect(harness.events).toEqual(['connect', 'begin', 'account', 'project-lock', 'removal-check', 'write', 'rollback', 'release']);
  });

  it('keeps soft-delete content charged and outside the content mutation wrapper', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([[], 0])
      .mockResolvedValueOnce([[{ id: FACT_ID }], 1]);
    const storageAccounting = new RecordingStorageAccounting([]);
    const harness = transactionalDataSource(query);
    const repository = new TypeOrmProjectFactRepository(harness.dataSource, storageAccounting);
    const input: ProjectFactVersionRecord = { ownerId: OWNER_ID, projectId: PROJECT_ID, factId: FACT_ID, expectedVersion: 1 };

    await expect(repository.softDelete(input)).resolves.toBe(false);
    await expect(repository.softDelete(input)).resolves.toBe(true);

    const softDeleteSql = query.mock.calls[1]?.[0] as string;
    expect(softDeleteSql).toContain('"deleted_at" = now()');
    expect(softDeleteSql).toContain('"version" = "version" + 1');
    expect(softDeleteSql).not.toMatch(/"(?:title|content)"\s*=/);
    expect(storageAccounting.ownerIds).toEqual([]);
  });

  it('blocks fact creation after the project removal barrier commits', async () => {
    const query = jest.fn().mockResolvedValue([row({ version: 1, verified_at: null })]);
    const harness = transactionalDataSource(query, true);
    const storageAccounting = new RecordingStorageAccounting(harness.events);
    const repository = new TypeOrmProjectFactRepository(harness.dataSource, storageAccounting);

    await expect(repository.create({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      key: 'test command',
      title: 'Test command',
      content: 'Run pnpm test.'
    })).rejects.toBeInstanceOf(ProjectFactArchivedProjectError);

    expect(harness.events).toEqual(['connect', 'begin', 'account', 'project-lock', 'removal-check', 'rollback', 'release']);
    expect(query).not.toHaveBeenCalled();
  });
});
