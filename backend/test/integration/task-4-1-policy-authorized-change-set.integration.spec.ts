import 'reflect-metadata';

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmAiRunRepository } from '@/infrastructure/database/repositories/typeorm-ai-run-repository';
import { TypeOrmAssistantScopePolicyRepository } from '@/infrastructure/database/repositories/typeorm-assistant-scope-policy-repository';
import { TypeOrmProposedChangeSetRepository } from '@/infrastructure/database/repositories/typeorm-change-set-repository';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { StorageQuotaRootScanner, type TrustedStorageRoot } from '@/infrastructure/workspace/storage-quota-reconciliation';
import type { EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';
import type { PolicyAuthorizedChangeSetApplyClaim, ProposedChangeOperation } from '@/modules/ai-runs/domain/change-types';
import { ChangeSetIdempotencyReusedError } from '@/modules/ai-runs/domain/change-errors';

const DATABASE_NAME = 'home_history_task_4_1_change_set_test';
const OWNER_ID = '4a410000-0000-4000-8000-000000000101';
const PROJECT_ID = '4a410000-0000-4000-8000-000000000102';
const CONVERSATION_ID = '4a410000-0000-4000-8000-000000000103';
const PROVIDER_PROFILE = 'nim-pinned';
const MODEL = 'model-pinned';
const SOURCE_TEXT = 'original file\n';
const NEXT_TEXT = 'updated file\n';
const databaseUrl = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

interface PgClient {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
  end(): Promise<void>;
}

interface StorageReferenceRow {
  readonly resource_kind: string;
  readonly resource_key: string;
  readonly copy_key: string;
  readonly byte_count: string;
  readonly sha256: string | null;
}

interface UsageRow {
  readonly accounting_state: string;
  readonly used_bytes: string;
  readonly reserved_bytes: string;
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

describeDatabase('Task 4.1 policy-authorized change-set claim PostgreSQL integration', () => {
  let dataSource: DataSource | undefined;
  let databaseCreated = false;
  let managedRoot: string | undefined;
  let quotaRepository: TypeOrmStorageQuotaRepository;
  let accounting: TypeOrmStorageContentAccounting;
  let runs: TypeOrmAiRunRepository;
  let policies: TypeOrmAssistantScopePolicyRepository;
  let changeSets: TypeOrmProposedChangeSetRepository;
  let policyRevision: string;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded policy claim integration database URL is required.');
    await createIsolatedDatabase();
    databaseCreated = true;
    const target = new URL(databaseUrl);
    target.pathname = `/${DATABASE_NAME}`;
    dataSource = createDataSource({ url: target.toString() });
    await dataSource.initialize();
    const identity: readonly { readonly database: string; readonly user: string }[] = await dataSource.query(
      'SELECT current_database() AS "database", current_user AS "user"'
    );
    expect(identity).toEqual([{ database: DATABASE_NAME, user: 'home_test' }]);
    const migrations = await dataSource.runMigrations({ transaction: 'all' });
    expect(migrations).toHaveLength(dataSource.migrations.length);

    managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pai-policy-claim-'));
    const projectRoot = path.join(managedRoot, OWNER_ID, ...`projects/${PROJECT_ID}`.split('/'));
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'README.md'), SOURCE_TEXT, 'utf8');

    await seedOwnerProjectAndConversation(dataSource);
    quotaRepository = new TypeOrmStorageQuotaRepository(dataSource);
    accounting = new TypeOrmStorageContentAccounting(dataSource, quotaRepository);
    runs = new TypeOrmAiRunRepository(dataSource, undefined, accounting);
    policies = new TypeOrmAssistantScopePolicyRepository(dataSource);
    changeSets = new TypeOrmProposedChangeSetRepository(dataSource, accounting);

    const workspacePolicy = await policies.fillConfiguredProvider({
      scope: { ownerId: OWNER_ID, scopeKind: 'project', projectId: PROJECT_ID },
      providerProfile: PROVIDER_PROFILE,
      model: MODEL
    });
    expect(workspacePolicy).toMatchObject({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      policyProfile: 'workspace_in_scope_v1',
      providerProfile: PROVIDER_PROFILE,
      model: MODEL,
      enabled: true,
      revision: '2'
    });
    if (!workspacePolicy) throw new Error('The fixture project needs a policy row before repository writes.');
    policyRevision = workspacePolicy.revision;

    const root: TrustedStorageRoot = {
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      rootKey: `projects/${PROJECT_ID}`,
      absolutePath: projectRoot,
      classifyFile: () => 'project_file'
    };
    const scanner = new StorageQuotaRootScanner();
    await reconcileOwner(dataSource, quotaRepository, accounting, [root], scanner);
    await expect(quotaRepository.readUsage(OWNER_ID)).resolves.toMatchObject({ state: 'ready' });
  }, 120_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (databaseCreated && databaseUrl) {
      await dropIsolatedDatabase();
      databaseCreated = false;
    }
    if (managedRoot) {
      const resolved = path.resolve(managedRoot);
      const temporaryBase = `${path.resolve(os.tmpdir())}${path.sep}`;
      if (!resolved.startsWith(temporaryBase)) throw new Error('Refusing to remove a claim fixture root outside the system temp directory.');
      await fs.rm(resolved, { recursive: true, force: true });
      managedRoot = undefined;
    }
  }, 30_000);

  it('serializes actual duplicate claim requests, rejects fingerprint reuse, and fences legacy or stale-policy runs', async () => {
    const source = requiredDataSource();
    const eligible = await createClaimableChangeSet('claimable-run-1', true);
    const claim = claimFor(eligible.run.id, eligible.changeSet.id, eligible.changeSet.proposalHash, eligible.run.policyRevision as string);
    const beforeConcurrentClaims = await storageSnapshot(source);

    const firstRequest = { ...claim };
    const retryRequest = { ...claim };
    const [first, retry] = await Promise.all([
      changeSets.claimPolicyAuthorizedApply(firstRequest),
      changeSets.claimPolicyAuthorizedApply(retryRequest)
    ]);
    expect([first.replayed, retry.replayed].sort()).toEqual([false, true]);
    expect(first.resource.id).toBe(eligible.changeSet.id);
    expect(retry.resource.id).toBe(eligible.changeSet.id);
    expect(first.resource).toMatchObject({ status: 'applying', decision: 'policy_authorized', decisionIdempotencyKey: claim.idempotencyKey, decisionFingerprint: claim.requestFingerprint });
    expect(retry.resource).toMatchObject({ status: 'applying', decision: 'policy_authorized', decisionIdempotencyKey: claim.idempotencyKey, decisionFingerprint: claim.requestFingerprint });
    await expect(changeSets.findByRunForOwner(OWNER_ID, eligible.run.id)).resolves.toMatchObject({
      id: eligible.changeSet.id,
      status: 'applying',
      decision: 'policy_authorized',
      decisionIdempotencyKey: claim.idempotencyKey,
      decisionFingerprint: claim.requestFingerprint
    });
    await expect(storageSnapshot(source)).resolves.toEqual(beforeConcurrentClaims);
    await expect(fs.readFile(requiredProjectFile(), 'utf8')).resolves.toBe(SOURCE_TEXT);

    await expect(changeSets.claimPolicyAuthorizedApply({ ...claim, requestFingerprint: 'f'.repeat(64) }))
      .rejects.toBeInstanceOf(ChangeSetIdempotencyReusedError);
    await expect(changeSets.findByRunForOwner(OWNER_ID, eligible.run.id)).resolves.toMatchObject({
      status: 'applying',
      decision: 'policy_authorized',
      decisionFingerprint: claim.requestFingerprint
    });

    const legacy = await createClaimableChangeSet('legacy-approved-run', false);
    await runs.save({ ...legacy.run, status: 'running', phase: 'inference', decision: 'approved' });
    const legacyBefore = await changeSets.findByRunForOwner(OWNER_ID, legacy.run.id);
    await expect(changeSets.claimPolicyAuthorizedApply(claimFor(
      legacy.run.id,
      legacy.changeSet.id,
      legacy.changeSet.proposalHash,
      policyRevision
    ))).rejects.toMatchObject({ code: 'CHANGE_SET_CONFLICT' });
    await expect(changeSets.findByRunForOwner(OWNER_ID, legacy.run.id)).resolves.toEqual(legacyBefore);

    const stale = await createClaimableChangeSet('stale-policy-run', true);
    const staleClaim = claimFor(stale.run.id, stale.changeSet.id, stale.changeSet.proposalHash, stale.run.policyRevision as string);
    const revoked = await policies.revoke({ ownerId: OWNER_ID, scopeKind: 'project', projectId: PROJECT_ID });
    expect(revoked).toMatchObject({ enabled: false, revision: (BigInt(policyRevision) + 1n).toString() });
    const staleBefore = await changeSets.findByRunForOwner(OWNER_ID, stale.run.id);
    await expect(changeSets.claimPolicyAuthorizedApply(staleClaim)).rejects.toMatchObject({ code: 'CHANGE_SET_CONFLICT' });
    await expect(changeSets.findByRunForOwner(OWNER_ID, stale.run.id)).resolves.toEqual(staleBefore);
    await expect(policies.find({ ownerId: OWNER_ID, scopeKind: 'project', projectId: PROJECT_ID }))
      .resolves.toMatchObject({ enabled: false, revision: (BigInt(policyRevision) + 1n).toString() });
    await expect(fs.readFile(requiredProjectFile(), 'utf8')).resolves.toBe(SOURCE_TEXT);
  }, 30_000);

  async function createClaimableChangeSet(idempotencyKey: string, bindPolicy: boolean): Promise<{
    readonly run: Awaited<ReturnType<TypeOrmAiRunRepository['create']>>['resource'];
    readonly changeSet: Awaited<ReturnType<TypeOrmProposedChangeSetRepository['create']>>;
  }> {
    const sourceHash = hash(SOURCE_TEXT);
    const request = `Fixture ${idempotencyKey}`;
    const manifest = createManifest(sourceHash, request);
    const created = await runs.create({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      request,
      relativeRoot: `projects/${PROJECT_ID}`,
      storageKind: 'managed',
      requestedPaths: ['README.md'],
      manifest,
      idempotencyKey,
      requestFingerprint: hash(`${idempotencyKey}:${request}`),
      ...(bindPolicy ? { policyRevision } : {})
    });
    const run = created.resource;
    await runs.save({ ...run, status: 'running', phase: 'inference', safeMessage: 'Fixture run in progress.' });
    const operation: ProposedChangeOperation = {
      operationId: `op-${idempotencyKey}`,
      operation: 'edit',
      path: 'README.md',
      content: NEXT_TEXT,
      summary: 'Update the fixture README.',
      expectedSourceHash: sourceHash,
      sourcePresent: true,
      destinationPresent: false,
      backupRequired: true,
      sizeBytes: Buffer.byteLength(NEXT_TEXT, 'utf8'),
      lineCount: 1,
      reviewable: true
    };
    const changeSet = await changeSets.create({
      runId: run.id,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      proposalHash: hash(JSON.stringify([operation])),
      operations: [operation],
      counts: { total: 1, creates: 0, edits: 1, overwrites: 0, renames: 0, deletes: 0, destructive: 1 },
      totalSizeBytes: operation.sizeBytes,
      totalLineCount: operation.lineCount,
      previewLimitBytes: 8192,
      previewLimitLines: 200,
      fakeRuntime: false
    });
    return { run, changeSet };
  }

  function requiredDataSource(): DataSource {
    if (!dataSource) throw new Error('The isolated policy claim database was not initialized.');
    return dataSource;
  }

  function requiredProjectFile(): string {
    if (!managedRoot) throw new Error('The isolated managed project root was not initialized.');
    return path.join(managedRoot, OWNER_ID, ...`projects/${PROJECT_ID}/README.md`.split('/'));
  }
});

async function createIsolatedDatabase(): Promise<void> {
  await withBaseClient(async (client) => {
    const identity = await client.query<{
      readonly database: string;
      readonly user: string;
      readonly canCreateDatabase: boolean;
      readonly databaseExists: boolean;
    }>(`SELECT current_database() AS "database", current_user AS "user",
      (SELECT "rolcreatedb" FROM "pg_roles" WHERE "rolname" = current_user) AS "canCreateDatabase",
      EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "databaseExists"`, [DATABASE_NAME]);
    if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
      || identity.rows[0]?.canCreateDatabase !== true) {
      throw new Error('The guarded role cannot create the isolated Task 4.1 change-set database.');
    }
    if (identity.rows[0]?.databaseExists) throw new Error('The Task 4.1 change-set database exists; inspect ownership before retrying.');
    await client.query(`CREATE DATABASE "${DATABASE_NAME}" OWNER "home_test"`);
  });
}

async function dropIsolatedDatabase(): Promise<void> {
  await withBaseClient(async (client) => {
    const identity = await client.query<{
      readonly database: string;
      readonly user: string;
      readonly owner: string | null;
      readonly exists: boolean;
    }>(`SELECT current_database() AS "database", current_user AS "user",
      (SELECT pg_get_userbyid("datdba") FROM "pg_database" WHERE "datname" = $1) AS "owner",
      EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "exists"`, [DATABASE_NAME]);
    if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
      || identity.rows[0]?.owner !== 'home_test') {
      throw new Error('Refusing to remove the Task 4.1 change-set database because its guarded identity changed.');
    }
    if (!identity.rows[0]?.exists) return;
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [DATABASE_NAME]);
    await client.query(`DROP DATABASE "${DATABASE_NAME}"`);
  });
}

async function withBaseClient<T>(operation: (client: PgClient) => Promise<T>): Promise<T> {
  if (!databaseUrl) throw new Error('The guarded Task 4.1 change-set database URL is required.');
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function seedOwnerProjectAndConversation(dataSource: DataSource): Promise<void> {
  const relativeRoot = `projects/${PROJECT_ID}`;
  await dataSource.query(`
    INSERT INTO "users" ("id", "scope_key", "display_name", "password_hash", "identifier", "account_kind", "role", "expires_at")
    VALUES ($1, 'local', 'Policy claim fixture', 'fixture-hash', 'owner', 'regular', 'admin', NULL)
  `, [OWNER_ID]);
  await dataSource.query('INSERT INTO "account_limits" ("owner_id", "storage_limit_bytes") VALUES ($1, 1000000)', [OWNER_ID]);
  await dataSource.query(`
    INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind")
    VALUES ($1, $2, 'Policy claim project', 'policy-claim-project', $3, $3, 'managed')
  `, [PROJECT_ID, OWNER_ID, relativeRoot]);
  await dataSource.query(`
    INSERT INTO "storage_root_mappings" ("owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state")
    VALUES ($1, $2, $2, $3, 'managed', $3, 'active')
  `, [OWNER_ID, PROJECT_ID, relativeRoot]);
  await dataSource.query(
    'INSERT INTO "conversations" ("id", "owner_id", "project_id", "title") VALUES ($1, $2, $3, $4)',
    [CONVERSATION_ID, OWNER_ID, PROJECT_ID, 'Policy claim fixture conversation']
  );
}

async function reconcileOwner(
  dataSource: DataSource,
  quotaRepository: TypeOrmStorageQuotaRepository,
  accounting: TypeOrmStorageContentAccounting,
  roots: readonly TrustedStorageRoot[],
  scanner: StorageQuotaRootScanner
): Promise<void> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    const databaseReferences = await accounting.scanDatabaseContent(runner, OWNER_ID);
    await runner.commitTransaction();
    const fileReferences = await scanner.scan(roots);
    await quotaRepository.reconcileReferences(OWNER_ID, [...databaseReferences, ...fileReferences]);
  } catch (error: unknown) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

async function storageSnapshot(dataSource: DataSource): Promise<{
  readonly usage: UsageRow;
  readonly references: readonly StorageReferenceRow[];
}> {
  const usages: readonly UsageRow[] = await dataSource.query(`
    SELECT "accounting_state", "used_bytes"::text AS "used_bytes", "reserved_bytes"::text AS "reserved_bytes"
    FROM "storage_account_totals" WHERE "owner_id" = $1
  `, [OWNER_ID]);
  const references: readonly StorageReferenceRow[] = await dataSource.query(`
    SELECT "resource_kind", "resource_key", "copy_key", "byte_count"::text AS "byte_count", "sha256"
    FROM "storage_resource_references" WHERE "owner_id" = $1 ORDER BY "resource_kind", "resource_key", "copy_key"
  `, [OWNER_ID]);
  if (!usages[0]) throw new Error('The storage fixture is missing its reconciled account total.');
  return { usage: usages[0], references };
}

function createManifest(sourceHash: string, request: string): EgressManifest {
  const requestBytes = Buffer.byteLength(request, 'utf8');
  const sourceBytes = Buffer.byteLength(SOURCE_TEXT, 'utf8');
  const messages = [] as const;
  return {
    manifestHash: hash(JSON.stringify({ request, sourceHash })),
    provider: 'NVIDIA hosted NIM',
    providerProfile: PROVIDER_PROFILE,
    model: MODEL,
    categories: ['project_files'],
    files: [{ relativePath: 'README.md', sourceHash, sizeBytes: sourceBytes }],
    facts: [],
    requestBytes,
    messageBytes: 0,
    messageCount: 0,
    messageHash: hash(JSON.stringify(messages)),
    messages,
    byteEstimate: requestBytes + sourceBytes,
    tokenEstimate: 8,
    excludedItemCount: 0,
    omittedItemCount: 0,
    omissionSummary: '',
    bestEffortSecretDetection: true
  };
}

function claimFor(runId: string, changeSetId: string, proposalHash: string, revision: string): PolicyAuthorizedChangeSetApplyClaim {
  return {
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    runId,
    proposalHash,
    policyRevision: revision,
    providerProfile: PROVIDER_PROFILE,
    model: MODEL,
    idempotencyKey: `policy-apply-${changeSetId}`,
    requestFingerprint: hash(JSON.stringify({ actor: 'policy_authorized', runId, proposalHash, revision }))
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
