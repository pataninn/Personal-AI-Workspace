import 'reflect-metadata';

import { DataSource as TypeOrmDataSource, type DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { CreateAssistantScopePolicies1710000032000 } from '@/infrastructure/database/migrations/1710000032000-create-assistant-scope-policies';
import { TypeOrmAssistantScopePolicyRepository } from '@/infrastructure/database/repositories/typeorm-assistant-scope-policy-repository';

const DATABASE_NAME = 'home_history_task_4_1_policy_test';
const LEGACY_OWNER_ID = '4a410000-0000-4000-8000-000000000001';
const LEGACY_PROJECT_ID = '4a410000-0000-4000-8000-000000000002';
const NEW_OWNER_ONE_ID = '4a410000-0000-4000-8000-000000000003';
const NEW_OWNER_TWO_ID = '4a410000-0000-4000-8000-000000000004';
const NEW_OWNER_THREE_ID = '4a410000-0000-4000-8000-000000000005';
const NEW_OWNER_FOUR_ID = '4a410000-0000-4000-8000-000000000009';
const ROLLBACK_OWNER_ID = '4a410000-0000-4000-8000-00000000000a';
const NEW_PROJECT_ONE_ID = '4a410000-0000-4000-8000-000000000006';
const NEW_PROJECT_TWO_ID = '4a410000-0000-4000-8000-000000000007';
const NEW_PROJECT_THREE_ID = '4a410000-0000-4000-8000-000000000008';
const NEW_PROJECT_FOUR_ID = '4a410000-0000-4000-8000-00000000000b';
const ROLLBACK_PROJECT_ID = '4a410000-0000-4000-8000-00000000000c';

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

describeDatabase('Task 4.1 assistant scope policy PostgreSQL integration', () => {
  let dataSource: DataSource | undefined;
  let databaseCreated = false;
  let repository: TypeOrmAssistantScopePolicyRepository;
  let targetUrl: string;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded Task 4.1 policy integration database URL is required.');

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
        throw new Error('The guarded Task 4.1 test role cannot create its isolated database.');
      }
      if (identity.rows[0].databaseExists) {
        throw new Error('The fixed Task 4.1 database already exists; inspect ownership before retrying.');
      }
      await baseClient.query(`CREATE DATABASE "${DATABASE_NAME}" OWNER "home_test"`);
      databaseCreated = true;
    } finally {
      await baseClient.end();
    }

    const target = new URL(databaseUrl);
    target.pathname = `/${DATABASE_NAME}`;
    targetUrl = target.toString();

    // Apply every registered predecessor migration first, then seed scopes as they existed
    // before 0032. A full registered DataSource applies 0032 next and proves its real backfill.
    const configuredDataSource = createDataSource({ url: targetUrl });
    const configuredMigrations = configuredDataSource.options.migrations;
    if (!Array.isArray(configuredMigrations)) {
      throw new Error('The configured Task 4.1 migration chain is not an ordered migration list.');
    }
    const policyMigrationIndex = configuredMigrations.findIndex(
      (migration) => migration === CreateAssistantScopePolicies1710000032000
    );
    if (policyMigrationIndex < 0) {
      throw new Error('The assistant scope policy migration must be registered.');
    }

    const beforePolicyDataSource = new TypeOrmDataSource({
      ...configuredDataSource.options,
      migrations: configuredMigrations.slice(0, policyMigrationIndex)
    });
    await beforePolicyDataSource.initialize();
    try {
      const predecessorMigrations = await beforePolicyDataSource.runMigrations({ transaction: 'all' });
      expect(predecessorMigrations).toHaveLength(policyMigrationIndex);

      await beforePolicyDataSource.query(`
        INSERT INTO "users" (
          "id", "scope_key", "display_name", "password_hash", "identifier", "account_kind", "role", "expires_at"
        ) VALUES ($1, 'local', 'Policy migration owner', 'fixture-hash', 'owner', 'regular', 'admin', NULL)
      `, [LEGACY_OWNER_ID]);
      await insertProject(beforePolicyDataSource, LEGACY_OWNER_ID, LEGACY_PROJECT_ID, 'legacy', '.');
    } finally {
      await beforePolicyDataSource.destroy();
    }

    dataSource = new TypeOrmDataSource({
      ...configuredDataSource.options,
      migrations: configuredMigrations.slice(0, policyMigrationIndex + 1)
    });
    await dataSource.initialize();
    const registeredNames = dataSource.migrations.map((migration) => migration.name);
    expect(registeredNames.at(-1)).toBe(new CreateAssistantScopePolicies1710000032000().name);
    const applied = await dataSource.runMigrations({ transaction: 'all' });
    expect(applied.map((migration) => migration.name)).toEqual([
      new CreateAssistantScopePolicies1710000032000().name
    ]);
    repository = new TypeOrmAssistantScopePolicyRepository(dataSource);
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
        throw new Error('Refusing to remove the Task 4.1 test database because its guarded identity changed.');
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

  it('backfills an owner and existing project with null, version-one policies', async () => {
    const home = await repository.find({ ownerId: LEGACY_OWNER_ID, scopeKind: 'home', projectId: null });
    const project = await repository.find({ ownerId: LEGACY_OWNER_ID, scopeKind: 'project', projectId: LEGACY_PROJECT_ID });
    const providerConfiguration: readonly { singleton_id: boolean; provider_profile: string | null; model: string | null }[] =
      await dataSource!.query(`SELECT "singleton_id", "provider_profile", "model" FROM "assistant_policy_provider_configuration"`);

    expect(home).toMatchObject({
      ownerId: LEGACY_OWNER_ID,
      scopeKind: 'home',
      projectId: null,
      policyProfile: 'home_in_scope_v1',
      providerProfile: null,
      model: null,
      enabled: true,
      revokedAt: null,
      revision: '1'
    });
    expect(project).toMatchObject({
      ownerId: LEGACY_OWNER_ID,
      scopeKind: 'project',
      projectId: LEGACY_PROJECT_ID,
      policyProfile: 'workspace_in_scope_v1',
      providerProfile: null,
      model: null,
      enabled: true,
      revokedAt: null,
      revision: '1'
    });
    expect(providerConfiguration).toEqual([{ singleton_id: true, provider_profile: null, model: null }]);
  });

  it('creates default home and workspace policies transactionally for new users and projects', async () => {
    await insertRegularUser(dataSource!, NEW_OWNER_ONE_ID, 'policy-user-one');
    await insertRegularUser(dataSource!, NEW_OWNER_TWO_ID, 'policy-user-two');
    await insertRegularUser(dataSource!, NEW_OWNER_THREE_ID, 'policy-user-three');
    await insertProject(dataSource!, NEW_OWNER_ONE_ID, NEW_PROJECT_ONE_ID, 'managed', `projects/${NEW_PROJECT_ONE_ID}`);
    await insertProject(dataSource!, NEW_OWNER_TWO_ID, NEW_PROJECT_TWO_ID, 'managed', `projects/${NEW_PROJECT_TWO_ID}`);
    await insertProject(dataSource!, NEW_OWNER_THREE_ID, NEW_PROJECT_THREE_ID, 'managed', `projects/${NEW_PROJECT_THREE_ID}`);

    await expect(repository.find({ ownerId: NEW_OWNER_ONE_ID, scopeKind: 'home', projectId: null }))
      .resolves.toMatchObject({ policyProfile: 'home_in_scope_v1', providerProfile: null, model: null, revision: '1' });
    await expect(repository.find({ ownerId: NEW_OWNER_ONE_ID, scopeKind: 'project', projectId: NEW_PROJECT_ONE_ID }))
      .resolves.toMatchObject({ policyProfile: 'workspace_in_scope_v1', providerProfile: null, model: null, revision: '1' });
    await expect(repository.find({ ownerId: NEW_OWNER_TWO_ID, scopeKind: 'home', projectId: null }))
      .resolves.toMatchObject({ policyProfile: 'home_in_scope_v1', enabled: true, revision: '1' });
    await expect(repository.find({ ownerId: NEW_OWNER_TWO_ID, scopeKind: 'project', projectId: NEW_PROJECT_TWO_ID }))
      .resolves.toMatchObject({ policyProfile: 'workspace_in_scope_v1', enabled: true, revision: '1' });

    await expect(dataSource!.transaction(async (manager) => {
      await manager.query(`
        INSERT INTO "users" (
          "id", "scope_key", "display_name", "password_hash", "identifier", "account_kind", "role", "expires_at"
        ) VALUES ($1, 'account:rollback-policy-user', 'Rollback owner', 'fixture-hash', 'rollback-policy-user', 'regular', 'user', NULL)
      `, [ROLLBACK_OWNER_ID]);
      throw new Error('rollback fixture transaction');
    })).rejects.toThrow('rollback fixture transaction');
    const rolledBackUser: readonly { count: string }[] = await dataSource!.query(
      'SELECT count(*)::text AS "count" FROM "users" WHERE "id" = $1', [ROLLBACK_OWNER_ID]
    );
    const rolledBackHomePolicy: readonly { count: string }[] = await dataSource!.query(
      'SELECT count(*)::text AS "count" FROM "assistant_scope_policies" WHERE "owner_id" = $1', [ROLLBACK_OWNER_ID]
    );
    expect(rolledBackUser).toEqual([{ count: '0' }]);
    expect(rolledBackHomePolicy).toEqual([{ count: '0' }]);

    await expect(dataSource!.transaction(async (manager) => {
      await manager.query(`
        INSERT INTO "projects" (
          "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind", "objective"
        ) VALUES ($1, $2, 'Rollback project', 'policy-rollback-project', $3, $3, 'managed', 'Fixture')
      `, [ROLLBACK_PROJECT_ID, NEW_OWNER_TWO_ID, `projects/${ROLLBACK_PROJECT_ID}`]);
      throw new Error('rollback fixture transaction');
    })).rejects.toThrow('rollback fixture transaction');
    const rolledBackProjectPolicy: readonly { count: string }[] = await dataSource!.query(
      'SELECT count(*)::text AS "count" FROM "assistant_scope_policies" WHERE "owner_id" = $1 AND "project_id" = $2',
      [NEW_OWNER_TWO_ID, ROLLBACK_PROJECT_ID]
    );
    const rolledBackProject: readonly { count: string }[] = await dataSource!.query(
      'SELECT count(*)::text AS "count" FROM "projects" WHERE "owner_id" = $1 AND "id" = $2',
      [NEW_OWNER_TWO_ID, ROLLBACK_PROJECT_ID]
    );
    expect(rolledBackProjectPolicy).toEqual([{ count: '0' }]);
    expect(rolledBackProject).toEqual([{ count: '0' }]);
  });

  it('enforces owner, composite project, uniqueness, scope, provider-pair, revocation, and revision constraints', async () => {
    await expectPgConstraint(() => dataSource!.query(`
      INSERT INTO "assistant_scope_policies" ("owner_id", "scope_kind", "policy_profile")
      VALUES ('4a41ffff-0000-4000-8000-000000000001', 'home', 'home_in_scope_v1')
    `), '23503', 'FK_assistant_scope_policies_owner');

    await expectPgConstraint(() => dataSource!.query(`
      INSERT INTO "assistant_scope_policies" ("owner_id", "scope_kind", "project_id", "policy_profile")
      VALUES ($1, 'project', $2, 'workspace_in_scope_v1')
    `, [NEW_OWNER_ONE_ID, NEW_PROJECT_TWO_ID]), '23503', 'FK_assistant_scope_policies_project_owner');

    await expectPgConstraint(() => dataSource!.query(`
      INSERT INTO "assistant_scope_policies" ("owner_id", "scope_kind", "policy_profile")
      VALUES ($1, 'home', 'home_in_scope_v1')
    `, [NEW_OWNER_THREE_ID]), '23505', 'UQ_assistant_scope_policies_home_owner');

    await expectPgConstraint(() => dataSource!.query(`
      INSERT INTO "assistant_scope_policies" ("owner_id", "scope_kind", "project_id", "policy_profile")
      VALUES ($1, 'project', $2, 'workspace_in_scope_v1')
    `, [NEW_OWNER_THREE_ID, NEW_PROJECT_THREE_ID]), '23505', 'UQ_assistant_scope_policies_project_owner');

    await expectPgConstraint(() => dataSource!.query(`
      INSERT INTO "assistant_scope_policies" ("owner_id", "scope_kind", "project_id", "policy_profile")
      VALUES ($1, 'home', $2, 'home_in_scope_v1')
    `, [NEW_OWNER_THREE_ID, NEW_PROJECT_THREE_ID]), '23514', 'CHK_assistant_scope_policies_scope');

    await expectPgConstraint(() => dataSource!.query(`
      INSERT INTO "assistant_scope_policies" (
        "owner_id", "scope_kind", "policy_profile", "provider_profile", "model"
      ) VALUES ($1, 'home', 'home_in_scope_v1', 'nim', NULL)
    `, [NEW_OWNER_THREE_ID]), '23514', 'CHK_assistant_scope_policies_provider_pair');

    await expectPgConstraint(() => dataSource!.query(`
      INSERT INTO "assistant_scope_policies" (
        "owner_id", "scope_kind", "project_id", "policy_profile", "enabled", "revoked_at"
      ) VALUES ($1, 'project', $2, 'workspace_in_scope_v1', false, NULL)
    `, [NEW_OWNER_ONE_ID, NEW_PROJECT_THREE_ID]), '23514', 'CHK_assistant_scope_policies_revocation');

    await expectPgConstraint(() => dataSource!.query(`
      INSERT INTO "assistant_scope_policies" ("owner_id", "scope_kind", "policy_profile", "revision")
      VALUES ($1, 'home', 'home_in_scope_v1', 0)
    `, [NEW_OWNER_THREE_ID]), '23514', 'CHK_assistant_scope_policies_revision');

    await expectPgConstraint(() => dataSource!.query(`
      INSERT INTO "assistant_policy_provider_configuration" ("singleton_id", "provider_profile", "model")
      VALUES (false, 'nim', 'model')
    `), '23514', 'CHK_assistant_policy_provider_configuration_singleton');
  });

  it('fills only null provider pairs, preserves configured and revoked rows, and serializes fill/revoke revisions', async () => {
    const legacyHomeScope = { ownerId: LEGACY_OWNER_ID, scopeKind: 'home' as const, projectId: null };
    const newHomeScope = { ownerId: NEW_OWNER_ONE_ID, scopeKind: 'home' as const, projectId: null };
    const nullRevokedScope = { ownerId: NEW_OWNER_TWO_ID, scopeKind: 'home' as const, projectId: null };
    const concurrentProjectScope = { ownerId: NEW_OWNER_ONE_ID, scopeKind: 'project' as const, projectId: NEW_PROJECT_ONE_ID };

    const legacyHomeBeforeFill = await repository.find(legacyHomeScope);
    expect(legacyHomeBeforeFill).toMatchObject({
      providerProfile: null,
      model: null,
      enabled: true,
      revokedAt: null,
      revision: '1'
    });
    const legacyHomeFill = await repository.fillConfiguredProvider({
      scope: legacyHomeScope,
      providerProfile: 'nim-pinned',
      model: 'model-pinned'
    });
    const legacyHomeAfterFill = await repository.find(legacyHomeScope);
    expect(legacyHomeAfterFill).toMatchObject({ providerProfile: 'nim-pinned', model: 'model-pinned', revision: '2' });
    expect(legacyHomeFill).toMatchObject({ providerProfile: 'nim-pinned', model: 'model-pinned', revision: '2' });

    const competingFills = await Promise.all([
      repository.fillConfiguredProvider({ scope: concurrentProjectScope, providerProfile: 'nim-first', model: 'model-first' }),
      repository.fillConfiguredProvider({ scope: concurrentProjectScope, providerProfile: 'nim-second', model: 'model-second' })
    ]);
    expect(competingFills.filter((result) => result !== null)).toHaveLength(1);
    const projectAfterFill = await repository.find(concurrentProjectScope);
    expect(projectAfterFill).toMatchObject({ enabled: true, revokedAt: null, revision: '2' });
    expect([
      ['nim-first', 'model-first'],
      ['nim-second', 'model-second']
    ]).toContainEqual([projectAfterFill?.providerProfile, projectAfterFill?.model]);

    await expect(repository.fillConfiguredProvider({
      scope: newHomeScope,
      providerProfile: 'nim-revoked',
      model: 'model-revoked'
    })).resolves.toMatchObject({ providerProfile: 'nim-revoked', model: 'model-revoked', revision: '2' });
    const simultaneousRevocations = await Promise.all([
      repository.revoke(newHomeScope),
      repository.revoke(newHomeScope)
    ]);
    await repository.revoke(nullRevokedScope);
    const revokedHome = await repository.find(newHomeScope);
    expect(revokedHome).toMatchObject({ enabled: false, providerProfile: 'nim-revoked', model: 'model-revoked', revision: '3' });
    expect(revokedHome?.revokedAt).toBeInstanceOf(Date);
    expect(simultaneousRevocations.map((policy) => policy?.revision)).toEqual(['3', '3']);
    expect(simultaneousRevocations[0]?.revokedAt).toEqual(simultaneousRevocations[1]?.revokedAt);

    await repository.synchronizeProviderConfiguration({ providerProfile: 'nim-deployment', model: 'model-deployment' });

    const pinnedHome = await repository.find(legacyHomeScope);
    const backfilledProject = await repository.find({ ownerId: LEGACY_OWNER_ID, scopeKind: 'project', projectId: LEGACY_PROJECT_ID });
    const revokedAfterSync = await repository.find(newHomeScope);
    const nullRevokedAfterSync = await repository.find(nullRevokedScope);
    const filledProjectAfterSync = await repository.find(concurrentProjectScope);
    expect(pinnedHome).toMatchObject({ providerProfile: 'nim-pinned', model: 'model-pinned', revision: '2', enabled: true });
    expect(backfilledProject).toMatchObject({ providerProfile: 'nim-deployment', model: 'model-deployment', revision: '2' });
    expect(revokedAfterSync).toMatchObject({ providerProfile: 'nim-revoked', model: 'model-revoked', revision: '3', enabled: false });
    expect(nullRevokedAfterSync).toMatchObject({ providerProfile: null, model: null, revision: '2', enabled: false });
    expect(filledProjectAfterSync).toEqual(projectAfterFill);

    await expect(repository.fillConfiguredProvider({
      scope: legacyHomeScope,
      providerProfile: 'nim-replacement',
      model: 'model-replacement'
    })).resolves.toBeNull();
    await expect(repository.fillConfiguredProvider({
      scope: nullRevokedScope,
      providerProfile: 'nim-replacement',
      model: 'model-replacement'
    })).resolves.toBeNull();
    await repository.synchronizeProviderConfiguration({ providerProfile: 'nim-later', model: 'model-later' });
    await expect(repository.find(legacyHomeScope)).resolves.toEqual(pinnedHome);
    await expect(repository.find(newHomeScope)).resolves.toEqual(revokedAfterSync);
    await expect(repository.find(nullRevokedScope)).resolves.toEqual(nullRevokedAfterSync);

    await insertRegularUser(dataSource!, NEW_OWNER_FOUR_ID, 'policy-user-four');
    await insertProject(dataSource!, NEW_OWNER_FOUR_ID, NEW_PROJECT_FOUR_ID, 'managed', `projects/${NEW_PROJECT_FOUR_ID}`);
    await expect(repository.find({ ownerId: NEW_OWNER_FOUR_ID, scopeKind: 'home', projectId: null }))
      .resolves.toMatchObject({ providerProfile: 'nim-later', model: 'model-later', revision: '1' });
    await expect(repository.find({ ownerId: NEW_OWNER_FOUR_ID, scopeKind: 'project', projectId: NEW_PROJECT_FOUR_ID }))
      .resolves.toMatchObject({ providerProfile: 'nim-later', model: 'model-later', revision: '1' });
  });
});

async function insertRegularUser(dataSource: DataSource, id: string, scopeKey: string): Promise<void> {
  await dataSource.query(`
    INSERT INTO "users" (
      "id", "scope_key", "display_name", "password_hash", "identifier", "account_kind", "role", "expires_at"
    ) VALUES ($1, $2, 'Scope policy user', 'fixture-hash', $3, 'regular', 'user', NULL)
  `, [id, `account:${scopeKey}`, scopeKey]);
}

async function insertProject(
  dataSource: DataSource,
  ownerId: string,
  projectId: string,
  storageKind: 'legacy' | 'managed',
  relativeRoot: string
): Promise<void> {
  await dataSource.query(`
    INSERT INTO "projects" (
      "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind", "objective"
    ) VALUES ($1, $2, 'Scope policy project', $3, $4, $4, $5, 'Fixture project')
  `, [projectId, ownerId, `policy-${projectId.slice(-6)}`, relativeRoot, storageKind]);
}

async function expectPgConstraint(
  operation: () => Promise<unknown>,
  code: string,
  constraint: string
): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  const queryFailure = caught as { readonly code?: string; readonly constraint?: string; readonly driverError?: { readonly code?: string; readonly constraint?: string } };
  expect(queryFailure.driverError?.code ?? queryFailure.code).toBe(code);
  expect(queryFailure.driverError?.constraint ?? queryFailure.constraint).toBe(constraint);
}
