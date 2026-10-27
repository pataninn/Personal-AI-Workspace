import type { DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmProjectChatContextRepository } from '@/infrastructure/database/repositories/typeorm-project-chat-context-repository';
import { TypeOrmProjectFactRepository } from '@/infrastructure/database/repositories/typeorm-project-fact-repository';
import { TypeOrmProjectRepository } from '@/infrastructure/database/repositories/typeorm-project-repository';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';
import { ProjectChatContextUseCases } from '@/modules/ai-runs/use-cases/project-chat-context-use-cases';

const DATABASE_NAME = 'home_history_task_3_2_fact_test';
const OWNER_ID = '3a320000-0000-4000-8000-000000000101';
const PROJECT_ID = '3a320000-0000-4000-8000-000000000102';
const FOREIGN_OWNER_ID = '3a320000-0000-4000-8000-000000000103';
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

describeDatabase('Project fact storage quota PostgreSQL integration', () => {
  let dataSource: DataSource | undefined;
  let databaseCreated = false;
  let quotaRepository: TypeOrmStorageQuotaRepository;
  let factRepository: TypeOrmProjectFactRepository;
  let accounting: TypeOrmStorageContentAccounting;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded project fact quota database URL is required.');
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
        throw new Error('The guarded project fact quota test role cannot create its isolated database.');
      }
      if (identity.rows[0]?.databaseExists) {
        throw new Error('The fixed project fact quota database already exists; inspect ownership before retrying.');
      }
      await baseClient.query(`CREATE DATABASE "${DATABASE_NAME}" OWNER "home_test"`);
      databaseCreated = true;
    } finally {
      await baseClient.end();
    }

    const target = new URL(databaseUrl);
    target.pathname = `/${DATABASE_NAME}`;
    dataSource = createDataSource({ url: target.toString() });
    await dataSource.initialize();
    const identity: readonly { readonly database: string; readonly user: string }[] = await dataSource.query(
      'SELECT current_database() AS "database", current_user AS "user"'
    );
    expect(identity).toEqual([{ database: DATABASE_NAME, user: 'home_test' }]);
    const applied = await dataSource.runMigrations({ transaction: 'all' });
    expect(applied).toHaveLength(dataSource.migrations.length);

    await seedOwnerAndPlanningProject(dataSource);
    quotaRepository = new TypeOrmStorageQuotaRepository(dataSource);
    accounting = new TypeOrmStorageContentAccounting(dataSource, quotaRepository);
    factRepository = new TypeOrmProjectFactRepository(dataSource, accounting);
    await markFixtureInventoryReady(dataSource, quotaRepository, accounting);
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
      if (identity.rows[0]?.database !== 'home_history_test'
        || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.owner !== 'home_test') {
        throw new Error('Refusing to remove the project fact quota database because its guarded identity changed.');
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
  }, 30_000);

  it('accounts UTF-8 fact bytes, rolls back denied growth, and retains bytes across shrink, verify, and soft-delete', async () => {
    const source = requiredDataSource();
    const initial = await quotaRepository.readUsage(OWNER_ID);
    expect(initial.state).toBe('ready');
    if (initial.usedBytes === null) throw new Error('The fixture inventory must have verified byte totals.');
    const baselineBytes = initial.usedBytes;
    await setStorageLimit(source, baselineBytes + 5n);

    const created = await factRepository.create({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      key: 'unicode fact',
      title: 'é',
      content: '雪'
    });
    await expect(quotaRepository.readUsage(OWNER_ID)).resolves.toMatchObject({ usedBytes: baselineBytes + 5n });
    const exactReferences: readonly { readonly copy_key: string; readonly byte_count: string }[] = await source.query(
      `SELECT "copy_key", "byte_count"::text AS "byte_count" FROM "storage_resource_references"
       WHERE "owner_id" = $1 AND "resource_kind" = 'database_content' AND "resource_key" = $2 ORDER BY "copy_key"`,
      [OWNER_ID, `project_facts:${created.id}`]
    );
    expect(exactReferences).toEqual([
      { copy_key: 'content', byte_count: '3' },
      { copy_key: 'title', byte_count: '2' }
    ]);

    const deniedCreate = factRepository.create({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      key: 'denied fact',
      title: 'é',
      content: '雪'
    });
    await expect(deniedCreate).rejects.toMatchObject({
      code: 'STORAGE_QUOTA_EXCEEDED',
      statusCode: 413
    });
    await expect(quotaRepository.readUsage(OWNER_ID)).resolves.toMatchObject({ usedBytes: baselineBytes + 5n });
    const factsAfterDeniedGrowth: readonly { readonly count: string }[] = await source.query(
      'SELECT count(*)::text AS "count" FROM "project_facts" WHERE "owner_id" = $1 AND "project_id" = $2',
      [OWNER_ID, PROJECT_ID]
    );
    expect(factsAfterDeniedGrowth).toEqual([{ count: '1' }]);

    await setStorageLimit(source, baselineBytes);
    const shrunk = await factRepository.update({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      factId: created.id,
      key: 'unicode fact',
      title: 'a',
      content: 'b',
      expectedVersion: created.version
    });
    if (!shrunk) throw new Error('The expected fact version should be updated.');
    expect(shrunk).toMatchObject({ version: 2, title: 'a', content: 'b' });
    await expect(quotaRepository.readUsage(OWNER_ID)).resolves.toMatchObject({ usedBytes: baselineBytes + 2n, overLimit: true });

    const verified = await factRepository.verify({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      factId: created.id,
      expectedVersion: shrunk.version
    });
    if (!verified) throw new Error('The expected fact version should be verified.');
    expect(verified).toMatchObject({ version: 3, verificationStatus: 'verified' });
    await expect(quotaRepository.readUsage(OWNER_ID)).resolves.toMatchObject({ usedBytes: baselineBytes + 2n });

    await expect(factRepository.softDelete({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      factId: created.id,
      expectedVersion: verified.version
    })).resolves.toBe(true);
    await expect(quotaRepository.readUsage(OWNER_ID)).resolves.toMatchObject({ usedBytes: baselineBytes + 2n });
    const retainedFact: readonly { readonly title: string; readonly content: string; readonly deleted_at: Date | string | null }[] = await source.query(
      'SELECT "title", "content", "deleted_at" FROM "project_facts" WHERE "id" = $1',
      [created.id]
    );
    expect(retainedFact).toHaveLength(1);
    expect(retainedFact[0]).toMatchObject({ title: 'a', content: 'b' });
    expect(retainedFact[0]?.deleted_at).not.toBeNull();
  });

  it('persists planning-only selection and reads only current active owner facts without opening file capabilities', async () => {
    const source = requiredDataSource();
    await setStorageLimit(source, 1_000_000n);
    const projects = new TypeOrmProjectRepository(source);
    const contexts = new TypeOrmProjectChatContextRepository(source);
    const workspace: jest.Mocked<IWorkspaceGateway> = {
      list: jest.fn(async (..._args: Parameters<IWorkspaceGateway['list']>) => { throw new Error('File inventory must not be read for planning-only context.'); }),
      tree: jest.fn(async (..._args: Parameters<IWorkspaceGateway['tree']>) => { throw new Error('File inventory must not be read for planning-only context.'); }),
      readText: jest.fn(async (..._args: Parameters<IWorkspaceGateway['readText']>) => { throw new Error('File contents must not be read for planning-only context.'); }),
      searchText: jest.fn(async (..._args: Parameters<IWorkspaceGateway['searchText']>) => { throw new Error('File contents must not be read for planning-only context.'); })
    };
    const context = new ProjectChatContextUseCases(projects, contexts, factRepository, workspace);
    const created = await factRepository.create({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      key: 'preferred language',
      title: 'Preferred language',
      content: 'Use TypeScript.'
    });

    const saved = await context.update(OWNER_ID, PROJECT_ID, { factIds: [created.id], includeProjectConversations: false });
    expect(saved).toMatchObject({ factIds: [created.id], includeProjectConversations: false, relativePaths: [], excludedPaths: [], availablePaths: [] });
    await expect(contexts.get(OWNER_ID, PROJECT_ID)).resolves.toMatchObject({ factIds: [created.id], includeProjectConversations: false });
    await expect(context.getSelectedFacts(OWNER_ID, PROJECT_ID)).resolves.toMatchObject([
      { id: created.id, version: 1, title: 'Preferred language', content: 'Use TypeScript.' }
    ]);

    const edited = await factRepository.update({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      factId: created.id,
      key: created.key,
      title: 'Preferred language',
      content: 'Use strict TypeScript.',
      expectedVersion: created.version
    });
    if (!edited) throw new Error('The expected fact version should be updated.');
    await expect(context.getSelectedFacts(OWNER_ID, PROJECT_ID)).resolves.toMatchObject([
      { id: created.id, version: 2, content: 'Use strict TypeScript.' }
    ]);

    await context.update(OWNER_ID, PROJECT_ID, { factIds: [] });
    await expect(context.getSelectedFacts(OWNER_ID, PROJECT_ID)).resolves.toEqual([]);
    await context.update(OWNER_ID, PROJECT_ID, { factIds: [created.id] });
    await expect(factRepository.softDelete({ ownerId: OWNER_ID, projectId: PROJECT_ID, factId: created.id, expectedVersion: edited.version })).resolves.toBe(true);
    await expect(context.getSelectedFacts(OWNER_ID, PROJECT_ID)).resolves.toEqual([]);
    await expect(context.get(OWNER_ID, PROJECT_ID)).resolves.toMatchObject({ factIds: [] });

    await expect(context.getSelectedFacts(FOREIGN_OWNER_ID, PROJECT_ID)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(context.update(OWNER_ID, PROJECT_ID, { relativePaths: ['notes.md'] })).rejects.toMatchObject({ code: 'PROJECT_ROOT_NOT_ATTACHED' });
    await expect(context.update(OWNER_ID, PROJECT_ID, { excludedPaths: ['notes.md'] })).rejects.toMatchObject({ code: 'PROJECT_ROOT_NOT_ATTACHED' });
    expect(workspace.list).not.toHaveBeenCalled();
    expect(workspace.tree).not.toHaveBeenCalled();
    expect(workspace.readText).not.toHaveBeenCalled();
    expect(workspace.searchText).not.toHaveBeenCalled();
  });

  function requiredDataSource(): DataSource {
    if (!dataSource) throw new Error('The isolated project fact quota database was not initialized.');
    return dataSource;
  }

  async function setStorageLimit(source: DataSource, limit: bigint): Promise<void> {
    await source.query('UPDATE "account_limits" SET "storage_limit_bytes" = $2 WHERE "owner_id" = $1', [OWNER_ID, limit.toString()]);
  }
});

async function seedOwnerAndPlanningProject(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    INSERT INTO "users" ("id", "scope_key", "display_name", "password_hash", "identifier", "account_kind", "role", "expires_at")
    VALUES ($1, 'account:fact-storage-test', 'Fact quota test', 'fixture-hash', 'fact-storage-test', 'regular', 'user', NULL)
  `, [OWNER_ID]);
  await dataSource.query('INSERT INTO "account_limits" ("owner_id", "storage_limit_bytes") VALUES ($1, 10000)', [OWNER_ID]);
  await dataSource.query(`
    INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key")
    VALUES ($1, $2, 'Fact quota project', 'fact-quota-test', NULL, NULL)
  `, [PROJECT_ID, OWNER_ID]);
}

async function markFixtureInventoryReady(
  dataSource: DataSource,
  quotaRepository: TypeOrmStorageQuotaRepository,
  accounting: TypeOrmStorageContentAccounting
): Promise<void> {
  const references = await scanFixtureInventory(dataSource, accounting);
  await quotaRepository.reconcileReferences(OWNER_ID, references);
}

async function scanFixtureInventory(
  dataSource: DataSource,
  accounting: TypeOrmStorageContentAccounting
) {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  try {
    await queryRunner.startTransaction();
    const references = await accounting.scanDatabaseContent(queryRunner, OWNER_ID);
    await queryRunner.commitTransaction();
    return references;
  } catch (error: unknown) {
    if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}
