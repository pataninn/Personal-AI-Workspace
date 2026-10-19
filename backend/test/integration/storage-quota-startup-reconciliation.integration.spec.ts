import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmStorageRootMappingRepository } from '@/infrastructure/database/repositories/typeorm-storage-root-mapping-repository';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { StorageQuotaStartupReconciler } from '@/infrastructure/startup/storage-quota-startup-reconciler';
import { recoveryReferenceIdentity, StorageQuotaRootScanner, type TrustedStorageRoot } from '@/infrastructure/workspace/storage-quota-reconciliation';
import { storageFileOperationFingerprint } from '@/modules/storage-quotas/domain/storage-file-operation-fingerprint';
import type { StorageFileOperationCommand, StorageFileReferencePlan, StorageResourceReference } from '@/modules/storage-quotas/domain/storage-quota-types';
import type { IWorkspaceBoundary, ManagedNamespaceInventory } from '@/modules/projects/repositories/workspace-boundary';

const DATABASE_NAME = 'home_history_task_3_2_startup_test';
const OWNER_ONE = '3a320000-0000-4000-8000-000000000201';
const OWNER_TWO = '3a320000-0000-4000-8000-000000000202';
const OWNER_THREE = '3a320000-0000-4000-8000-000000000203';
const OWNER_FOUR = '3a320000-0000-4000-8000-000000000204';
const OWNER_FIVE = '3a320000-0000-4000-8000-000000000205';
const PROJECT_ONE = '3a320000-0000-4000-8000-000000000211';
const PROJECT_TWO = '3a320000-0000-4000-8000-000000000212';
const PROJECT_THREE = '3a320000-0000-4000-8000-000000000213';
const RECOVERY_RUN_ID = '3a320000-0000-4000-8000-000000000221';
const ORPHAN_PROJECT_ID = '3a320000-0000-4000-8000-000000000231';
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
    || target.port !== '55441' || target.pathname !== '/home_history_test' || target.username !== 'home_test') {
    throw new Error('HOME_CONVERSATION_TEST_DATABASE_URL must target home_test/home_history_test on loopback port 55441.');
  }
}

describeDatabase('Task 3.2 startup storage reconciliation with PostgreSQL and temporary roots', () => {
  let dataSource: DataSource | undefined;
  let databaseCreated = false;
  let workspaceRoot: string;
  let recoveryRoot: string;
  let projectOneRoot: string;
  let projectTwoRoot: string;
  let projectThreeRoot: string;
  let orphanProjectRoot: string;
  let quotaRepository: TypeOrmStorageQuotaRepository;
  let mappingRepository: TypeOrmStorageRootMappingRepository;
  let accounting: TypeOrmStorageContentAccounting;
  let namespaceInventoryOverride: ManagedNamespaceInventory | undefined;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded startup reconciliation database URL is required.');
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      const identity = await baseClient.query<{
        readonly database: string; readonly user: string; readonly canCreateDatabase: boolean; readonly databaseExists: boolean;
      }>(`SELECT current_database() AS "database", current_user AS "user",
          (SELECT "rolcreatedb" FROM "pg_roles" WHERE "rolname" = current_user) AS "canCreateDatabase",
          EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "databaseExists"`, [DATABASE_NAME]);
      if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.canCreateDatabase !== true || identity.rows[0]?.databaseExists) {
        throw new Error('The guarded startup reconciliation role cannot safely create its isolated database.');
      }
      await baseClient.query(`CREATE DATABASE "${DATABASE_NAME}" OWNER "home_test"`);
      databaseCreated = true;
    } finally {
      await baseClient.end();
    }

    const target = new URL(databaseUrl);
    target.pathname = `/${DATABASE_NAME}`;
    const configured = createDataSource({ url: target.toString() });
    dataSource = new DataSource({ ...configured.options, extra: { max: 1 } });
    await dataSource.initialize();
    const identity: readonly { readonly database: string; readonly user: string }[] = await dataSource.query(
      'SELECT current_database() AS "database", current_user AS "user"'
    );
    expect(identity).toEqual([{ database: DATABASE_NAME, user: 'home_test' }]);
    const applied = await dataSource.runMigrations({ transaction: 'all' });
    expect(applied).toHaveLength(dataSource.migrations.length);

    quotaRepository = new TypeOrmStorageQuotaRepository(dataSource);
    mappingRepository = new TypeOrmStorageRootMappingRepository(dataSource);
    accounting = new TypeOrmStorageContentAccounting(dataSource, quotaRepository);
  }, 120_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (!databaseCreated || !databaseUrl) return;
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      const identity = await baseClient.query<{
        readonly database: string; readonly user: string; readonly owner: string | null; readonly exists: boolean;
      }>(`SELECT current_database() AS "database", current_user AS "user",
          (SELECT pg_get_userbyid("datdba") FROM "pg_database" WHERE "datname" = $1) AS "owner",
          EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "exists"`, [DATABASE_NAME]);
      if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.owner !== 'home_test') {
        throw new Error('Refusing to remove the startup reconciliation database after its guarded identity changed.');
      }
      if (!identity.rows[0]?.exists) { databaseCreated = false; return; }
      await baseClient.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [DATABASE_NAME]);
      await baseClient.query(`DROP DATABASE "${DATABASE_NAME}"`);
      databaseCreated = false;
    } finally {
      await baseClient.end();
    }
  }, 30_000);

  beforeEach(async () => {
    await requiredDataSource().query('TRUNCATE TABLE "users" CASCADE');
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'pai-startup-workspace-'));
    recoveryRoot = await mkdtemp(path.join(os.tmpdir(), 'pai-startup-recovery-'));
    projectOneRoot = path.join(workspaceRoot, `projects/${PROJECT_ONE}`);
    projectTwoRoot = path.join(workspaceRoot, `projects/${PROJECT_TWO}`);
    projectThreeRoot = path.join(workspaceRoot, `projects/${PROJECT_THREE}`);
    orphanProjectRoot = path.join(workspaceRoot, `projects/${ORPHAN_PROJECT_ID}`);
    await mkdir(projectOneRoot, { recursive: true });
    await mkdir(projectTwoRoot, { recursive: true });
    await mkdir(projectThreeRoot, { recursive: true });
    await writeFile(path.join(projectThreeRoot, 'retained.txt'), 'retained physical bytes', 'utf8');
    await mkdir(orphanProjectRoot, { recursive: true });
    await writeFile(path.join(orphanProjectRoot, 'historic.txt'), 'historic managed bytes', 'utf8');
    await mkdir(path.join(recoveryRoot, `run-${RECOVERY_RUN_ID}`), { recursive: true });
    await writeFile(path.join(recoveryRoot, `run-${RECOVERY_RUN_ID}`, 'copy.bak'), 'known recovery copy', 'utf8');
    await seedAccountsAndProjects(requiredDataSource());
    await markInventoriesReady();
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(recoveryRoot, { recursive: true, force: true });
    namespaceInventoryOverride = undefined;
  });

  it('settles a verified interrupted file write and keeps a missing-root reservation charged and unavailable', async () => {
    const expectedContent = 'verified after restart';
    const ownerOneCommand = operationCommand(OWNER_ONE, PROJECT_ONE, `projects/${PROJECT_ONE}`, 'first-write', expectedContent);
    const ownerOneReservation = await reserve(ownerOneCommand);
    expect(ownerOneReservation.state).toBe('reserved');
    await writeFile(path.join(projectOneRoot, 'after-crash.txt'), expectedContent, 'utf8');

    const ownerTwoCommand = operationCommand(OWNER_TWO, PROJECT_TWO, `projects/${PROJECT_TWO}`, 'missing-root-write', 'reserved content');
    const ownerTwoReservation = await reserve(ownerTwoCommand);
    expect(ownerTwoReservation.state).toBe('reserved');
    await rm(projectTwoRoot, { recursive: true, force: true });

    const result = await reconciler().reconcile();
    expect(result.readyOwnerIds).toContain(OWNER_ONE);
    expect(result.readyOwnerIds).toContain(OWNER_THREE);
    expect(result.readyOwnerIds).toContain(OWNER_FOUR);
    expect(result.readyOwnerIds).toContain(OWNER_FIVE);
    expect(result.unavailableOwnerIds).toContain(OWNER_TWO);
    await expect(quotaRepository.readUsage(OWNER_ONE)).resolves.toMatchObject({
      state: 'ready',
      usedBytes: BigInt(Buffer.byteLength('Startup project one', 'utf8')
        + Buffer.byteLength(expectedContent, 'utf8') + Buffer.byteLength('known recovery copy', 'utf8')),
      reservedBytes: 0n
    });
    await expect(quotaRepository.readUsage(OWNER_THREE)).resolves.toMatchObject({
      state: 'ready', usedBytes: BigInt(Buffer.byteLength('retained physical bytes', 'utf8')), reservedBytes: 0n
    });
    await expect(quotaRepository.readUsage(OWNER_FOUR)).resolves.toMatchObject({
      state: 'ready', usedBytes: 0n, reservedBytes: 0n
    });
    await expect(quotaRepository.readUsage(OWNER_FIVE)).resolves.toMatchObject({
      state: 'ready', usedBytes: BigInt(Buffer.byteLength('historic managed bytes', 'utf8')), reservedBytes: 0n
    });
    await expect(mappingRepository.listMappings(OWNER_FIVE)).resolves.toEqual([expect.objectContaining({
      ownerId: OWNER_FIVE, projectId: null, locatorProjectId: ORPHAN_PROJECT_ID,
      rootKey: `projects/${ORPHAN_PROJECT_ID}`, storageKind: 'managed',
      relativeRoot: `projects/${ORPHAN_PROJECT_ID}`, state: 'retained'
    })]);
    const recoveryReferenceRows: readonly { readonly resource_key: string; readonly copy_key: string; readonly byte_count: string }[] = await requiredDataSource().query(
      `SELECT "resource_key", "copy_key", "byte_count"::text AS "byte_count" FROM "storage_resource_references"
       WHERE "owner_id" = $1 AND "resource_kind" = 'recovery_file'`, [OWNER_ONE]
    );
    expect(recoveryReferenceRows).toEqual([{
      resource_key: RECOVERY_RUN_ID,
      copy_key: `run-${RECOVERY_RUN_ID}/copy.bak`,
      byte_count: String(Buffer.byteLength('known recovery copy', 'utf8'))
    }]);

    const operationRows: readonly { readonly owner_id: string; readonly status: string }[] = await requiredDataSource().query(
      'SELECT "owner_id", "status" FROM "storage_filesystem_reservations" ORDER BY "owner_id"'
    );
    expect(operationRows).toEqual([
      { owner_id: OWNER_ONE, status: 'settled' },
      { owner_id: OWNER_TWO, status: 'pending' }
    ]);
    const ownerTwoTotals: readonly { readonly accounting_state: string; readonly reserved_bytes: string }[] = await requiredDataSource().query(
      'SELECT "accounting_state", "reserved_bytes"::text AS "reserved_bytes" FROM "storage_account_totals" WHERE "owner_id" = $1',
      [OWNER_TWO]
    );
    expect(ownerTwoTotals).toEqual([{ accounting_state: 'unavailable', reserved_bytes: String(Buffer.byteLength('reserved content', 'utf8')) }]);

    await mkdir(path.join(recoveryRoot, 'orphaned-copy'));
    await writeFile(path.join(recoveryRoot, 'orphaned-copy', 'unknown.bak'), 'unattributed', 'utf8');
    const orphanResult = await reconciler().reconcile();
    expect(orphanResult.readyOwnerIds).toEqual([]);
    expect(orphanResult.unavailableOwnerIds).toEqual([OWNER_ONE, OWNER_TWO, OWNER_THREE, OWNER_FOUR, OWNER_FIVE]);
  }, 30_000);

  it('keeps a known unsafe owner unavailable and blocks every account for an unknown namespace entry', async () => {
    namespaceInventoryOverride = {
      configured: true,
      unattributableEntries: false,
      owners: [
        { ownerId: OWNER_ONE, unsafe: true, projectIds: [] },
        { ownerId: OWNER_TWO, unsafe: false, projectIds: [PROJECT_TWO] },
        { ownerId: OWNER_THREE, unsafe: false, projectIds: [PROJECT_THREE] },
        { ownerId: OWNER_FOUR, unsafe: false, projectIds: [] },
        { ownerId: OWNER_FIVE, unsafe: false, projectIds: [ORPHAN_PROJECT_ID] }
      ]
    };
    const ownerScoped = await reconciler().reconcile();
    expect(ownerScoped.unavailableOwnerIds).toEqual([OWNER_ONE]);
    expect(ownerScoped.readyOwnerIds).toEqual([OWNER_TWO, OWNER_THREE, OWNER_FOUR, OWNER_FIVE]);

    namespaceInventoryOverride = {
      configured: true,
      unattributableEntries: true,
      owners: []
    };
    const globalUntrusted = await reconciler().reconcile();
    expect(globalUntrusted.readyOwnerIds).toEqual([]);
    expect(globalUntrusted.unavailableOwnerIds).toEqual([OWNER_ONE, OWNER_TWO, OWNER_THREE, OWNER_FOUR, OWNER_FIVE]);
  }, 30_000);

  async function seedAccountsAndProjects(source: DataSource): Promise<void> {
    for (const [ownerId, projectId, scopeKey, identifier, name, relativeRoot] of [
      [OWNER_ONE, PROJECT_ONE, 'startup-one', 'startup-one', 'Startup project one', `projects/${PROJECT_ONE}`],
      [OWNER_TWO, PROJECT_TWO, 'startup-two', 'startup-two', 'Startup project two', `projects/${PROJECT_TWO}`],
      [OWNER_THREE, PROJECT_THREE, 'startup-three', 'startup-three', 'Startup project three', `projects/${PROJECT_THREE}`]
    ] as const) {
      await source.query(`INSERT INTO "users" ("id", "scope_key", "display_name", "password_hash", "identifier")
        VALUES ($1, $2, $3, 'fixture-hash', $4)`, [ownerId, `account:${scopeKey}`, scopeKey, identifier]);
      await source.query('INSERT INTO "account_limits" ("owner_id", "storage_limit_bytes") VALUES ($1, 1000000)', [ownerId]);
      await source.query(`INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind")
        VALUES ($1, $2, $3, $4, $5, $5, 'managed')`, [projectId, ownerId, name, scopeKey, relativeRoot]);
      await source.query(`INSERT INTO "storage_root_mappings" ("owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state")
        VALUES ($1, $2, $2, $3, 'managed', $4, 'active')`, [ownerId, projectId, relativeRoot.toLowerCase(), relativeRoot]);
    }
    await source.query(`UPDATE "storage_root_mappings" SET "project_id" = NULL, "state" = 'retained'
      WHERE "owner_id" = $1 AND "project_id" = $2`, [OWNER_THREE, PROJECT_THREE]);
    await source.query('DELETE FROM "projects" WHERE "owner_id" = $1 AND "id" = $2', [OWNER_THREE, PROJECT_THREE]);
    await source.query(`INSERT INTO "users" ("id", "scope_key", "display_name", "password_hash", "identifier")
      VALUES ($1, 'account:startup-four', 'startup-four', 'fixture-hash', 'startup-four')`, [OWNER_FOUR]);
    await source.query(`INSERT INTO "users" ("id", "scope_key", "display_name", "password_hash", "identifier")
      VALUES ($1, 'account:startup-five', 'startup-five', 'fixture-hash', 'startup-five')`, [OWNER_FIVE]);
    await source.query('INSERT INTO "account_limits" ("owner_id", "storage_limit_bytes") VALUES ($1, 1000000)', [OWNER_FIVE]);
  }

  async function markInventoriesReady(): Promise<void> {
    const rootByProject = new Map([
      [PROJECT_ONE, projectOneRoot], [PROJECT_TWO, projectTwoRoot], [PROJECT_THREE, projectThreeRoot],
      [ORPHAN_PROJECT_ID, orphanProjectRoot]
    ]);
    for (const ownerId of [OWNER_ONE, OWNER_TWO, OWNER_THREE, OWNER_FOUR]) {
      const runner = requiredDataSource().createQueryRunner();
      await runner.connect();
      let databaseReferences: readonly StorageResourceReference[];
      try {
        databaseReferences = await accounting.scanDatabaseContent(runner, ownerId);
      } finally {
        await runner.release();
      }
      const mappings = await mappingRepository.listMappings(ownerId);
      const roots: TrustedStorageRoot[] = mappings.map((mapping) => {
        const absolutePath = rootByProject.get(mapping.locatorProjectId);
        if (!absolutePath) throw new Error('A startup fixture root locator was not registered.');
        return {
          ownerId,
          projectId: mapping.projectId,
          rootKey: mapping.rootKey,
          absolutePath,
          classifyFile: () => mapping.state === 'retained' ? 'retained_root' as const : 'project_file' as const
        };
      });
      if (ownerId === OWNER_ONE) {
        roots.push({
          ownerId,
          projectId: PROJECT_ONE,
          rootKey: 'recovery-v1',
          absolutePath: path.join(recoveryRoot, `run-${RECOVERY_RUN_ID}`),
          classifyFile: () => 'recovery_file' as const,
          referenceForFile: (physicalRelativeKey: string) => recoveryReferenceIdentity(`run-${RECOVERY_RUN_ID}/${physicalRelativeKey}`, PROJECT_ONE)
        });
      }
      const fileReferences = await new StorageQuotaRootScanner().scan(roots);
      await quotaRepository.reconcileReferences(ownerId, [...databaseReferences, ...fileReferences]);
    }
  }

  async function reserve(command: StorageFileOperationCommand) {
    return await quotaRepository.reserveFileOperation(command, async (transaction, request) =>
      await mappingRepository.resolveTrustedScope(transaction, request));
  }

  function operationCommand(
    ownerId: string,
    projectId: string,
    rootKey: string,
    operationKey: string,
    content: string
  ): StorageFileOperationCommand {
    const relativeKey = operationKey === 'first-write' ? 'after-crash.txt' : 'will-not-exist.txt';
    const intendedSha256 = createHash('sha256').update(content, 'utf8').digest('hex');
    const change: StorageFileReferencePlan = {
      kind: 'project_file', resourceKey: rootKey, copyKey: relativeKey, projectId, rootKey, relativeKey,
      expectedPriorBytes: null, expectedPriorSha256: null,
      intendedBytes: BigInt(Buffer.byteLength(content, 'utf8')), intendedSha256
    };
    const input = { ownerId, operationKey, projectId, rootKey, targetKey: relativeKey, changes: [change] };
    return { ...input, fingerprint: storageFileOperationFingerprint(input) };
  }

  function reconciler(): StorageQuotaStartupReconciler {
    const roots = new Map([
      [PROJECT_ONE, projectOneRoot],
      [PROJECT_TWO, projectTwoRoot],
      [PROJECT_THREE, projectThreeRoot],
      [ORPHAN_PROJECT_ID, orphanProjectRoot]
    ]);
    const workspaceBoundary: IWorkspaceBoundary = {
      getSnapshot: async () => ({ status: 'ready' }),
      assertReady: async () => undefined,
      validateProjectRoot: async (relativeRoot) => relativeRoot,
      resolveProjectRoot: async ({ projectId }) => {
        const canonicalProjectRoot = roots.get(projectId);
        if (!canonicalProjectRoot) throw new Error('unexpected project locator');
        return { canonicalRoot: workspaceRoot, canonicalProjectRoot };
      },
      inspectManagedNamespace: async () => namespaceInventoryOverride ?? ({
        configured: true,
        unattributableEntries: false,
        owners: [
          { ownerId: OWNER_ONE, unsafe: false, projectIds: [PROJECT_ONE] },
          { ownerId: OWNER_TWO, unsafe: false, projectIds: [PROJECT_TWO] },
          { ownerId: OWNER_THREE, unsafe: false, projectIds: [PROJECT_THREE] },
          { ownerId: OWNER_FOUR, unsafe: false, projectIds: [] },
          { ownerId: OWNER_FIVE, unsafe: false, projectIds: [ORPHAN_PROJECT_ID] }
        ]
      })
    };
    return new StorageQuotaStartupReconciler(
      requiredDataSource(), quotaRepository, mappingRepository, accounting, workspaceBoundary, recoveryRoot,
      new StorageQuotaRootScanner()
    );
  }

  function requiredDataSource(): DataSource {
    if (!dataSource) throw new Error('The isolated startup reconciliation database was not initialized.');
    return dataSource;
  }
});
