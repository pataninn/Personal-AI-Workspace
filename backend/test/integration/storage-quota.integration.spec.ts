import type { DataSource, QueryRunner } from 'typeorm';

import { AddAccountStorageLimit1710000029000 } from '@/infrastructure/database/migrations/1710000029000-add-account-storage-limit';
import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { storageFileOperationFingerprint } from '@/modules/storage-quotas/domain/storage-file-operation-fingerprint';
import type { StorageFileOperationCommand, StorageResourceReference, StorageResourceReferenceChange, StorageTrustedFileScope, StorageVerifiedFileChange } from '@/modules/storage-quotas/domain/storage-quota-types';
import type { StorageQuotaTransaction, StorageTrustedFileScopeResolver } from '@/modules/storage-quotas/repositories/storage-quota-repository';

const DATABASE_NAME = 'home_history_task_3_2_storage_test';
const OWNER_ID = '3a320000-0000-4000-8000-000000000001';
const databaseUrl = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

interface PgClient {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
  end(): Promise<void>;
}

const { Client } = require('pg') as { readonly Client: new (options: { readonly connectionString: string }) => PgClient };

if (databaseUrl) {
  const target = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !new Set(['127.0.0.1', 'localhost', '::1', '[::1]']).has(target.hostname)
    || target.port !== '55441'
    || target.pathname !== '/home_history_test'
    || target.username !== 'home_test') {
    throw new Error('HOME_CONVERSATION_TEST_DATABASE_URL must target home_test/home_history_test on loopback port 55441.');
  }
}

describeDatabase('Task 3.2 PostgreSQL storage quota foundation', () => {
  let dataSource: DataSource | undefined;
  let databaseCreated = false;
  let repository: TypeOrmStorageQuotaRepository;
  let targetUrl: string;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded storage-quota integration database URL is required.');
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      const identity = await baseClient.query<{
        readonly database: string;
        readonly user: string;
        readonly canCreateDatabase: boolean;
        readonly databaseExists: boolean;
      }>(`
        SELECT current_database() AS "database", current_user AS "user",
          (SELECT "rolcreatedb" FROM "pg_roles" WHERE "rolname" = current_user) AS "canCreateDatabase",
          EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "databaseExists"
      `, [DATABASE_NAME]);
      if (identity.rows[0]?.database !== 'home_history_test'
        || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.canCreateDatabase !== true) {
        throw new Error('The guarded Task 3.2 test role cannot create its isolated database.');
      }
      if (identity.rows[0]?.databaseExists) {
        throw new Error('The fixed Task 3.2 database already exists; inspect ownership before retrying.');
      }
      await baseClient.query(`CREATE DATABASE "${DATABASE_NAME}" OWNER "home_test"`);
      databaseCreated = true;
    } finally {
      await baseClient.end();
    }

    const target = new URL(databaseUrl);
    target.pathname = `/${DATABASE_NAME}`;
    targetUrl = target.toString();
    dataSource = createDataSource({ url: targetUrl });
    await dataSource.initialize();
    const identity: readonly { readonly database: string; readonly user: string }[] = await dataSource.query(
      'SELECT current_database() AS "database", current_user AS "user"'
    );
    expect(identity).toEqual([{ database: DATABASE_NAME, user: 'home_test' }]);
    const applied = await dataSource.runMigrations({ transaction: 'all' });
    expect(applied).toHaveLength(dataSource.migrations.length);
    repository = new TypeOrmStorageQuotaRepository(dataSource);

    await dataSource.query(`
      INSERT INTO "users" ("id", "scope_key", "display_name", "password_hash", "identifier", "account_kind", "role", "expires_at")
      VALUES ($1, 'account:storage-quota-test', 'Storage quota test', 'fixture-hash', 'storage-quota-test', 'regular', 'user', NULL)
    `, [OWNER_ID]);
    await dataSource.query('INSERT INTO "account_limits" ("owner_id", "storage_limit_bytes") VALUES ($1, 10)', [OWNER_ID]);
    await repository.reconcileReferences(OWNER_ID, []);
  }, 120_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (!databaseCreated || !databaseUrl) return;
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      const identity = await baseClient.query<{
        readonly database: string;
        readonly user: string;
        readonly owner: string | null;
        readonly exists: boolean;
      }>(`
        SELECT current_database() AS "database", current_user AS "user",
          (SELECT pg_get_userbyid("datdba") FROM "pg_database" WHERE "datname" = $1) AS "owner",
          EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "exists"
      `, [DATABASE_NAME]);
      if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.owner !== 'home_test') {
        throw new Error('Refusing to remove the Task 3.2 test database because its guarded identity changed.');
      }
      if (!identity.rows[0]?.exists) {
        databaseCreated = false;
        return;
      }
      await baseClient.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [DATABASE_NAME]
      );
      await baseClient.query(`DROP DATABASE "${DATABASE_NAME}"`);
      databaseCreated = false;
    } finally {
      await baseClient.end();
    }
  });

  beforeEach(async () => {
    // Each case starts from the canonical empty inventory even if an earlier assertion failed.
    await repository.reconcileReferences(OWNER_ID, []);
  });

  it('applies the shared account limit migration and refuses rollback after a verified reconciliation', async () => {
    const limitColumns: readonly { readonly data_type: string; readonly is_nullable: string }[] = await dataSource!.query(`
      SELECT "data_type", "is_nullable" FROM information_schema.columns
      WHERE "table_schema" = current_schema() AND "table_name" = 'account_limits' AND "column_name" = 'storage_limit_bytes'
    `);
    expect(limitColumns).toEqual([{ data_type: 'bigint', is_nullable: 'YES' }]);

    const state: readonly { readonly accounting_state: string }[] = await dataSource!.query(
      'SELECT "accounting_state" FROM "storage_account_totals" WHERE "owner_id" = $1', [OWNER_ID]
    );
    expect(state).toEqual([{ accounting_state: 'ready' }]);

    const queryRunner = dataSource!.createQueryRunner();
    await queryRunner.connect();
    try {
      await expect(new AddAccountStorageLimit1710000029000().down(queryRunner)).rejects.toThrow('rollback is blocked');
    } finally {
      await queryRunner.release();
    }
  });

  it('serializes concurrent growth, rolls back references with the caller transaction, and permits shrink while over limit', async () => {
    const mutationCalls = new Map<string, number>();
    const results = await Promise.allSettled([
      mutateDatabaseReference('concurrent-a', 7n, mutationCalls),
      mutateDatabaseReference('concurrent-b', 7n, mutationCalls)
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    // Both SQL mutations execute under the savepoint before exact positive-delta admission;
    // the owner/account lock serializes them and the denied second mutation is rolled back.
    expect([...mutationCalls.values()].reduce((sum, count) => sum + count, 0)).toBe(2);
    const concurrentReferences: readonly { readonly count: string }[] = await dataSource!.query(
      'SELECT count(*)::text AS "count" FROM "storage_resource_references" WHERE "owner_id" = $1 AND "resource_key" IN ($2, $3)',
      [OWNER_ID, 'concurrent-a', 'concurrent-b']
    );
    expect(concurrentReferences).toEqual([{ count: '1' }]);
    const acceptedKey = results.find((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')?.value;
    expect(acceptedKey).toBeDefined();
    await expect(repository.readUsage(OWNER_ID)).resolves.toMatchObject({ usedBytes: 7n, reservedBytes: 0n, limitBytes: 10n });

    const rollbackRunner = await startTransaction(dataSource!);
    try {
      await repository.runDatabaseMutation(rollbackRunner, { ownerId: OWNER_ID, maximumGrowthBytes: 3n }, async () => ({
        result: undefined,
        references: [{ reference: databaseReference('rolled-back', 'rollback-copy'), nextBytes: 3n, nextSha256: null }]
      }));
      await rollbackRunner.rollbackTransaction();
    } finally {
      await rollbackRunner.release();
    }
    const rolledBack: readonly { readonly count: string }[] = await dataSource!.query(
      'SELECT count(*)::text AS "count" FROM "storage_resource_references" WHERE "owner_id" = $1 AND "resource_key" = $2',
      [OWNER_ID, 'rolled-back']
    );
    expect(rolledBack).toEqual([{ count: '0' }]);
    await expect(repository.readUsage(OWNER_ID)).resolves.toMatchObject({ usedBytes: 7n });

    await dataSource!.query('UPDATE "account_limits" SET "storage_limit_bytes" = 6 WHERE "owner_id" = $1', [OWNER_ID]);
    await expect(repository.readUsage(OWNER_ID)).resolves.toMatchObject({ overLimit: true, availableBytes: 0n });
    const reference = databaseReference(acceptedKey!, `copy-${acceptedKey}`);
    await runDatabaseMutation({
      ownerId: OWNER_ID,
      maximumGrowthBytes: 0n,
      referenceChanges: [{ reference, nextBytes: null, nextSha256: null }]
    });
    await expect(repository.readUsage(OWNER_ID)).resolves.toMatchObject({ usedBytes: 0n, overLimit: false });
  });

  it('settles and replays an exact filesystem reservation without double charging', async () => {
    await dataSource!.query('UPDATE "account_limits" SET "storage_limit_bytes" = 5000000000 WHERE "owner_id" = $1', [OWNER_ID]);
    await dataSource!.query(`
      INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind")
      VALUES ($1, $2, 'Storage test', 'storage-test', $3, $3, 'managed')
    `, [PROJECT_ID, OWNER_ID, `projects/${PROJECT_ID}`]);
    const command = fileCommand();
    const reserved = await repository.reserveFileOperation(command, resolveTrustedScope);
    expect(reserved).toMatchObject({ state: 'reserved', replay: false });
    await expect(repository.readUsage(OWNER_ID)).resolves.toMatchObject({ usedBytes: 0n, reservedBytes: 5n, limitBytes: 5_000_000_000n });

    const actual: StorageVerifiedFileChange = {
      kind: 'project_file', resourceKey: `managed:${PROJECT_ID}`, copyKey: 'notes.md', projectId: PROJECT_ID,
      rootKey: `managed:${PROJECT_ID}`, relativeKey: 'notes.md', bytes: 5n, sha256: 'a'.repeat(64)
    };
    await expect(repository.settleFileOperation(OWNER_ID, reserved.operationId, [actual])).resolves.toMatchObject({ state: 'settled' });
    await expect(repository.reserveFileOperation(command, resolveTrustedScope)).resolves.toMatchObject({ state: 'settled', replay: true, outcome: [actual] });
    await expect(repository.readUsage(OWNER_ID)).resolves.toMatchObject({ usedBytes: 5n, reservedBytes: 0n, limitBytes: 5_000_000_000n });
  });

  async function mutateDatabaseReference(key: string, bytes: bigint, calls: Map<string, number>): Promise<string> {
    return await runDatabaseMutation({
      ownerId: OWNER_ID,
      maximumGrowthBytes: bytes,
      referenceChanges: [{ reference: databaseReference(key, `copy-${key}`), nextBytes: bytes, nextSha256: null }],
      beforeMutation: () => calls.set(key, (calls.get(key) ?? 0) + 1)
    }).then(() => key);
  }

  async function runDatabaseMutation(input: {
    readonly ownerId: string;
    readonly maximumGrowthBytes: bigint;
    readonly referenceChanges: readonly StorageResourceReferenceChange[];
    readonly beforeMutation?: () => void;
  }): Promise<void> {
    const queryRunner = await startTransaction(dataSource!);
    try {
      await repository.runDatabaseMutation(queryRunner, { ownerId: input.ownerId, maximumGrowthBytes: input.maximumGrowthBytes }, async () => {
        input.beforeMutation?.();
        return { result: undefined, references: input.referenceChanges };
      });
      await queryRunner.commitTransaction();
    } catch (error: unknown) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
});

const PROJECT_ID = '3a320000-0000-4000-8000-000000000002';

const resolveTrustedScope: StorageTrustedFileScopeResolver = async (
  transaction: StorageQuotaTransaction,
  request
): Promise<StorageTrustedFileScope> => {
  const roots: readonly {
    readonly id: string;
    readonly relative_root: string | null;
    readonly storage_kind: 'legacy' | 'managed' | null;
  }[] = await transaction.query(
    'SELECT "id", "relative_root", "storage_kind" FROM "projects" WHERE "owner_id" = $1 AND "id" = $2 FOR SHARE',
    [request.ownerId, request.projectId]
  ) as readonly { id: string; relative_root: string | null; storage_kind: 'legacy' | 'managed' | null }[];
  return {
    ownerId: request.ownerId,
    projectId: request.projectId,
    roots: roots.flatMap((root) => root.relative_root === null || root.storage_kind === null ? [] : [{
      ownerId: request.ownerId,
      projectId: root.id,
      locatorProjectId: root.id,
      rootKey: `${root.storage_kind}:${root.id}`,
      storageKind: root.storage_kind,
      relativeRoot: root.relative_root
    }])
  };
};

async function startTransaction(dataSource: DataSource): Promise<QueryRunner> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();
  return queryRunner;
}

function databaseReference(resourceKey: string, copyKey: string): StorageResourceReference {
  return {
    ownerId: OWNER_ID, kind: 'database_content', resourceKey, copyKey, bytes: 0n,
    projectId: null, rootKey: null, relativeKey: null, sha256: null
  };
}

function fileCommand(): StorageFileOperationCommand {
  const base: Omit<StorageFileOperationCommand, 'fingerprint'> = {
    ownerId: OWNER_ID, operationKey: 'task-3-2-file-write', projectId: PROJECT_ID,
    rootKey: `managed:${PROJECT_ID}`, targetKey: 'notes.md',
    changes: [{
      kind: 'project_file', resourceKey: `managed:${PROJECT_ID}`, copyKey: 'notes.md', projectId: PROJECT_ID,
      rootKey: `managed:${PROJECT_ID}`, relativeKey: 'notes.md', expectedPriorBytes: null, expectedPriorSha256: null,
      intendedBytes: 5n, intendedSha256: 'a'.repeat(64)
    }]
  };
  return { ...base, fingerprint: storageFileOperationFingerprint(base) };
}
