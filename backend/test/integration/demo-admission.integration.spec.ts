import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DataSource, QueryRunner } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmDemoAdmissionRepository } from '@/infrastructure/database/repositories/typeorm-demo-admission-repository';
import { TypeOrmAiRunRepository } from '@/infrastructure/database/repositories/typeorm-ai-run-repository';
import { TypeOrmConversationRepository } from '@/infrastructure/database/repositories/typeorm-conversation-repository';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { TypeOrmDemoStorageBootstrap } from '@/infrastructure/database/typeorm-demo-storage-bootstrap';
import { TypeOrmShowcaseRepository } from '@/infrastructure/database/repositories/typeorm-showcase-repository';
import { TypeOrmDemoShowcaseCopyManager } from '@/infrastructure/database/repositories/typeorm-demo-showcase-copy-manager';
import { TypeOrmProjectRepository } from '@/infrastructure/database/repositories/typeorm-project-repository';
import { TypeOrmProjectFileAccess } from '@/infrastructure/database/repositories/typeorm-project-file-access';
import { TypeOrmStorageRootMappingRepository } from '@/infrastructure/database/repositories/typeorm-storage-root-mapping-repository';
import { ProjectFileGateway } from '@/infrastructure/workspace/project-file-gateway';
import { StorageQuotaFileMutation } from '@/infrastructure/workspace/storage-quota-file-mutation';
import type { IWorkspaceBoundary, ProjectRootScope, ResolvedProjectRoot, WorkspaceBoundarySnapshot } from '@/modules/projects/repositories/workspace-boundary';
import { OpaqueTokenProvider } from '@/infrastructure/auth/opaque-token-provider';
import { FakeAgentRuntime } from '@/infrastructure/sandbox/fake-agent-runtime';
import { InMemoryRunEventPublisher } from '@/infrastructure/ai-runs/in-memory-run-event-publisher';
import { CancelAiRunUseCase } from '@/modules/ai-runs/use-cases/cancel-ai-run-use-case';
import { StartAiRunUseCase } from '@/modules/ai-runs/use-cases/start-ai-run-use-case';
import type { StartRunUpdate, RunMutationResult } from '@/modules/ai-runs/repositories/ai-run-repository';
import { DemoAdmissionRateLimitedError, DemoAdmissionUnavailableError, DemoRunStartRateLimitedError } from '@/modules/demo/domain/demo-admission-errors';
import { CreateDemoSessionUseCase } from '@/modules/demo/use-cases/create-demo-session';

const DATABASE_NAME = 'home_history_task_3_3_demo_test';
const REGULAR_OWNER_ID = 'd3330000-0000-4000-8000-000000000101';
const SHOWCASE_VERSION_ID = 'd3330000-0000-4000-8000-000000000201';
const FILE_SHOWCASE_VERSION_ID = 'd3330000-0000-4000-8000-000000000202';
const SHOWCASE_TASK_ID = 'd3330000-0000-4000-8000-000000000301';
const SHOWCASE_CHECKLIST_ID = 'd3330000-0000-4000-8000-000000000302';
const SHOWCASE_FACT_ID = 'd3330000-0000-4000-8000-000000000303';
const SHOWCASE_FILE_ID = 'd3330000-0000-4000-8000-000000000304';
const SHOWCASE_FILE_BYTES = Buffer.alloc(4096, 0x61);
const SHOWCASE_FILE_SHA256 = createHash('sha256').update(SHOWCASE_FILE_BYTES).digest('hex');
const databaseUrl = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

interface SafeCopyFailureDiagnostic {
  readonly operation: string;
  readonly category: 'typeorm_query_failed' | 'project_domain_error' | 'storage_quota_error' | 'application_error' | 'other_error';
  readonly sqlState?: string;
  readonly constraint?: string;
  readonly domainCode?: string;
}

const SAFE_COPY_ERROR_CODES = new Set([
  'PROJECT_NAME_CONFLICT', 'PROJECT_ROOT_OVERLAP', 'PROJECT_ROOT_INVALID', 'WORKSPACE_STORAGE_UNAVAILABLE',
  'STORAGE_QUOTA_EXCEEDED', 'STORAGE_ACCOUNTING_UNAVAILABLE', 'STORAGE_RECONCILIATION_PENDING',
  'STORAGE_OPERATION_CONFLICT', 'STORAGE_FILE_STATE_CHANGED'
]);

function asDiagnosticRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  // Only allowlisted scalar properties are read; the record itself is never serialized.
  return value as Record<string, unknown>;
}

function safeCopyFailureDiagnostic(error: unknown, operation: string): SafeCopyFailureDiagnostic {
  const record = asDiagnosticRecord(error);
  const driver = asDiagnosticRecord(record?.driverError) ?? record;
  const sqlState = [record?.code, driver?.code].find((value): value is string => typeof value === 'string' && /^[0-9A-Z]{5}$/u.test(value));
  const rawConstraint = driver?.constraint;
  const constraint = typeof rawConstraint === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(rawConstraint) ? rawConstraint : undefined;
  const category = record?.name === 'QueryFailedError' ? 'typeorm_query_failed'
    : record?.name === 'ProjectDomainError' ? 'project_domain_error'
      : record?.name === 'StorageQuotaError' ? 'storage_quota_error'
        : record?.name === 'AppError' ? 'application_error' : 'other_error';
  const rawDomainCode = record?.code;
  const domainCode = typeof rawDomainCode === 'string' && SAFE_COPY_ERROR_CODES.has(rawDomainCode) ? rawDomainCode : undefined;
  return {
    operation,
    category,
    ...(sqlState === undefined ? {} : { sqlState }),
    ...(constraint === undefined ? {} : { constraint }),
    ...(domainCode === undefined ? {} : { domainCode })
  };
}

function copySqlOperation(sql: string): string {
  const statement = sql.trimStart().toLocaleUpperCase('en-US');
  if (statement.startsWith('INSERT INTO "PROJECTS"')) return 'project_insert';
  if (statement.startsWith('INSERT INTO "STORAGE_ROOT_MAPPINGS"')) return 'root_mapping_insert';
  if (statement.startsWith('INSERT INTO "PROJECT_TASKS"')) return 'task_clone_insert';
  if (statement.startsWith('INSERT INTO "PROJECT_FACTS"')) return 'fact_clone_insert';
  if (statement.startsWith('UPDATE "DEMO_SHOWCASE_COPIES"')) return 'copy_phase_update';
  if (statement.startsWith('UPDATE "STORAGE_ACCOUNT_TOTALS"')) return 'quota_account_update';
  return 'copy_database_query';
}

function observeCopyQueryFailures(dataSource: DataSource, failures: SafeCopyFailureDiagnostic[]): () => void {
  const originalCreateQueryRunner = dataSource.createQueryRunner.bind(dataSource);
  const observedFactory: DataSource['createQueryRunner'] = (...args) => {
    const queryRunner = originalCreateQueryRunner(...args);
    const originalQuery = queryRunner.query.bind(queryRunner);
    // The copy path uses QueryRunner's standard two-argument query overload; the cast preserves TypeORM's overload set.
    queryRunner.query = (async (...queryArgs: Parameters<QueryRunner['query']>) => {
      try {
        return await originalQuery(...queryArgs);
      } catch (error: unknown) {
        failures.push(safeCopyFailureDiagnostic(error, copySqlOperation(queryArgs[0])));
        throw error;
      }
    }) as QueryRunner['query'];
    return queryRunner;
  };
  dataSource.createQueryRunner = observedFactory;
  return () => { dataSource.createQueryRunner = originalCreateQueryRunner; };
}

class TestManagedWorkspaceBoundary implements IWorkspaceBoundary {
  public constructor(private readonly root: string) {}

  public async getSnapshot(): Promise<WorkspaceBoundarySnapshot> { return { status: 'ready' }; }
  public async getManagedSnapshot(): Promise<WorkspaceBoundarySnapshot> { return { status: 'ready' }; }
  public async assertReady(): Promise<void> {}
  public async validateProjectRoot(): Promise<string> { throw new Error('Managed test roots must use the trusted project resolver.'); }

  public async createManagedProjectRoot(ownerId: string, projectId: string): Promise<string> {
    if (!isCanonicalUuid(ownerId) || !isCanonicalUuid(projectId)) throw new Error('The test managed root requires UUID identities.');
    const projectsRoot = path.join(this.root, ownerId, 'projects');
    await fs.mkdir(projectsRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(projectsRoot, projectId), { mode: 0o700 });
    return `projects/${projectId}`;
  }

  public async resolveProjectRoot(scope: ProjectRootScope): Promise<ResolvedProjectRoot> {
    if (scope.storageKind !== 'managed' || !isCanonicalUuid(scope.ownerId) || !isCanonicalUuid(scope.projectId)
      || scope.relativeRoot !== `projects/${scope.projectId}`) {
      throw new Error('The test managed root scope is invalid.');
    }
    const canonicalRoot = path.resolve(this.root).replaceAll('\\', '/');
    const canonicalProjectRoot = path.resolve(this.root, scope.ownerId, 'projects', scope.projectId).replaceAll('\\', '/');
    return { canonicalRoot, canonicalProjectRoot };
  }
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

async function seedShowcaseFixtures(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    INSERT INTO "showcase_versions" ("id", "project_display", "tasks", "facts", "content_digest", "snapshot_bytes", "item_count", "file_count")
    VALUES ($1, $2::jsonb, '[]'::jsonb, '[]'::jsonb, repeat('a', 64), 0, 0, 0)
    ON CONFLICT ("id") DO NOTHING
  `, [SHOWCASE_VERSION_ID, JSON.stringify({ name: 'Isolated fixture', objective: null })]);

  const task = {
    id: SHOWCASE_TASK_ID,
    title: 'Prepare the launch checklist',
    details: 'Confirm the private copy is editable.',
    status: 'todo',
    importance: 'medium',
    deadline: null,
    checklist: [{ id: SHOWCASE_CHECKLIST_ID, title: 'Review the copied files', completed: false }]
  };
  const fact = { id: SHOWCASE_FACT_ID, title: 'Workspace name', content: 'Sample workspace for isolated integration tests.' };
  await dataSource.query(`
    INSERT INTO "showcase_versions" ("id", "project_display", "tasks", "facts", "content_digest", "snapshot_bytes", "item_count", "file_count")
    VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6, 4, 1)
    ON CONFLICT ("id") DO NOTHING
  `, [
    FILE_SHOWCASE_VERSION_ID,
    JSON.stringify({ name: 'Private copy fixture', objective: 'Verify a bounded immutable snapshot copy.' }),
    JSON.stringify([task]),
    JSON.stringify([fact]),
    createHash('sha256').update('task-3-4-private-copy-fixture').digest('hex'),
    SHOWCASE_FILE_BYTES.length + Buffer.byteLength(JSON.stringify(task)) + Buffer.byteLength(JSON.stringify(fact))
  ]);
  await dataSource.query(`
    INSERT INTO "showcase_files" ("version_id", "file_id", "name", "media_type", "content", "sha256", "byte_length")
    VALUES ($1, $2, 'docs/guide.txt', 'text/plain', $3, $4, $5)
    ON CONFLICT ("version_id", "file_id") DO NOTHING
  `, [FILE_SHOWCASE_VERSION_ID, SHOWCASE_FILE_ID, SHOWCASE_FILE_BYTES, SHOWCASE_FILE_SHA256, SHOWCASE_FILE_BYTES.length]);
}

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

describeDatabase('Task 3.3 demo admission with PostgreSQL', () => {
  let dataSource: DataSource | undefined;
  let databaseCreated = false;
  let admissionRepository: TypeOrmDemoAdmissionRepository;
  let quotaRepository: TypeOrmStorageQuotaRepository;
  let showcaseRepository: TypeOrmShowcaseRepository;
  let showcaseCopyManager: TypeOrmDemoShowcaseCopyManager;
  let demoUseCase: CreateDemoSessionUseCase;
  let targetUrl: string;
  let workspaceRoot: string | undefined;
  const copyFailureDiagnostics: SafeCopyFailureDiagnostic[] = [];

  const limits = {
    globalAdmissionMax: 2,
    globalAdmissionWindowSeconds: 3600,
    networkAdmissionMax: 1,
    networkAdmissionWindowSeconds: 900,
    runStartMax: 1,
    runStartWindowSeconds: 3600
  } as const;
  const networkSecret = 'task-3-3-dedicated-network-hash-secret';
  const rotatedSecret = 'task-3-3-rotated-network-hash-secret';
  const showcaseLimits = {
    maxSnapshotBytes: 1_000_000,
    maxFileBytes: 256_000,
    maxItems: 100,
    maxFiles: 10,
    maxRetainedVersions: 4,
    maxCopyAttempts: 2
  } as const;
  const tokenProvider = new OpaqueTokenProvider('task-3-3-test-session-hmac-secret-32-bytes');

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded demo admission database URL is required.');
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      const identity = await baseClient.query<{
        readonly database: string;
        readonly user: string;
        readonly canCreateDatabase: boolean;
        readonly databaseExists: boolean;
      }>(`SELECT current_database() AS "database", current_user AS "user",
          (SELECT "rolcreatedb" FROM "pg_roles" WHERE "rolname" = current_user) AS "canCreateDatabase",
          EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "databaseExists"`, [DATABASE_NAME]);
      if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.canCreateDatabase !== true || identity.rows[0]?.databaseExists) {
        throw new Error('The guarded demo admission role cannot safely create its isolated database.');
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
    const connectedIdentity: readonly { readonly database: string; readonly user: string }[] = await dataSource.query(
      'SELECT current_database() AS "database", current_user AS "user"'
    );
    expect(connectedIdentity).toEqual([{ database: DATABASE_NAME, user: 'home_test' }]);
    const applied = await dataSource.runMigrations({ transaction: 'all' });
    expect(applied).toHaveLength(dataSource.migrations.length);

    quotaRepository = new TypeOrmStorageQuotaRepository(dataSource);
    const accounting = new TypeOrmStorageContentAccounting(dataSource, quotaRepository);
    const bootstrap = new TypeOrmDemoStorageBootstrap(dataSource, accounting, quotaRepository);
    admissionRepository = new TypeOrmDemoAdmissionRepository(dataSource, limits);
    showcaseRepository = new TypeOrmShowcaseRepository(dataSource);
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'task-3-4-demo-copy-'));
    const workspaceBoundary = new TestManagedWorkspaceBoundary(workspaceRoot);
    const rootMappings = new TypeOrmStorageRootMappingRepository(dataSource);
    const projectRepository = new TypeOrmProjectRepository(dataSource, accounting);
    const createProject = projectRepository.create.bind(projectRepository);
    projectRepository.create = async (input) => {
      try {
        return await createProject(input);
      } catch (error: unknown) {
        copyFailureDiagnostics.push(safeCopyFailureDiagnostic(error, 'project_create'));
        throw error;
      }
    };
    showcaseCopyManager = new TypeOrmDemoShowcaseCopyManager(
      dataSource,
      showcaseRepository,
      projectRepository,
      workspaceBoundary,
      new TypeOrmProjectFileAccess(dataSource, rootMappings),
      new ProjectFileGateway({ containerRoot: workspaceRoot, workspaceBoundary }),
      new StorageQuotaFileMutation(quotaRepository),
      quotaRepository,
      accounting,
      showcaseLimits
    );
    demoUseCase = new CreateDemoSessionUseCase(admissionRepository, bootstrap, tokenProvider, {
      limits,
      networkHashSecret: networkSecret,
      lifetimeMs: 24 * 60 * 60 * 1000,
      isShowcaseAvailable: async () => Boolean(await showcaseRepository.getCurrentSummary()),
      // This admission integration pins the fixture version but leaves copy execution to Task 3.4 tests.
      provisionShowcaseCopy: async () => undefined
    });
  }, 120_000);

  beforeEach(async () => {
    await requiredDataSource().query('TRUNCATE TABLE "users" CASCADE');
    await requiredDataSource().query('TRUNCATE TABLE "demo_admission_counters" CASCADE');
    await seedShowcaseFixtures(requiredDataSource());
    await requiredDataSource().query(`
      INSERT INTO "users" ("id", "scope_key", "identifier", "account_kind", "role", "display_name", "password_hash")
      VALUES ($1, 'account:task-3-3-regular', 'task-regular', 'regular', 'user', 'Regular fixture', 'fixture-hash')
    `, [REGULAR_OWNER_ID]);
    await requiredDataSource().query('INSERT INTO "account_limits" ("owner_id") VALUES ($1)', [REGULAR_OWNER_ID]);
    await requiredDataSource().query('UPDATE "showcase_publication" SET "current_version_id" = $1 WHERE "singleton_id" = true', [SHOWCASE_VERSION_ID]);
    await requiredDataSource().query('UPDATE "assistant_policy_provider_configuration" SET "provider_profile" = NULL, "model" = NULL WHERE "singleton_id" = true');
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (workspaceRoot) {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = undefined;
    }
    if (!databaseCreated || !databaseUrl) return;
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      const identity = await baseClient.query<{
        readonly database: string;
        readonly user: string;
        readonly owner: string | null;
        readonly exists: boolean;
      }>(`SELECT current_database() AS "database", current_user AS "user",
          (SELECT pg_get_userbyid("datdba") FROM "pg_database" WHERE "datname" = $1) AS "owner",
          EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "exists"`, [DATABASE_NAME]);
      if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.owner !== 'home_test') {
        throw new Error('Refusing to remove the demo database after its guarded identity changed.');
      }
      if (!identity.rows[0]?.exists) { databaseCreated = false; return; }
      await baseClient.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [DATABASE_NAME]);
      await baseClient.query(`DROP DATABASE "${DATABASE_NAME}"`);
      databaseCreated = false;
    } finally {
      await baseClient.end();
    }
  }, 30_000);

  it('serializes cross-network duplicate keys, enforces fixed-window counters, and makes the owner storage-ready once', async () => {
    const firstKey = randomBytes(32).toString('base64url');
    const secondKey = randomBytes(32).toString('base64url');
    const thirdKey = randomBytes(32).toString('base64url');
    const concurrent = await Promise.all([
      demoUseCase.execute({ idempotencyKey: firstKey, clientIp: '198.51.100.40' }),
      demoUseCase.execute({ idempotencyKey: firstKey, clientIp: '203.0.113.90' })
    ]);
    const created = concurrent.filter((result) => result.kind === 'created');
    const statusOnly = concurrent.filter((result) => result.kind === 'status');
    expect(created).toHaveLength(1);
    expect(statusOnly).toHaveLength(1);
    expect(statusOnly[0]).toMatchObject({ kind: 'status', state: expect.stringMatching(/^(pending|ready)$/u) });
    const ownerId = created[0]?.kind === 'created' ? created[0].session.principal.id : '';
    expect(ownerId).toMatch(/^[0-9a-f-]{36}$/u);
    const pinnedCopy = await dataSource!.query(`
      SELECT c."pinned_version_id", c."target_project_id", c."state"
      FROM "demo_showcase_copies" c WHERE c."owner_id" = $1
    `, [ownerId]);
    expect(pinnedCopy).toEqual([expect.objectContaining({
      pinned_version_id: SHOWCASE_VERSION_ID,
      target_project_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      state: 'pending'
    })]);

    const accountRows: readonly {
      readonly demo_users: number;
      readonly admissions: number;
      readonly sessions: number;
      readonly counters: number;
      readonly raw_key_retained: boolean;
      readonly expiries_match: boolean;
      readonly ready_state: boolean;
      readonly inference_paused: boolean;
    }[] = await dataSource!.query(`
      SELECT
        (SELECT count(*)::int FROM "users" WHERE "account_kind" = 'demo') AS "demo_users",
        (SELECT count(*)::int FROM "demo_admissions") AS "admissions",
        (SELECT count(*)::int FROM "sessions" s JOIN "users" u ON u."id" = s."user_id" WHERE u."account_kind" = 'demo') AS "sessions",
        (SELECT count(*)::int FROM "demo_admission_counters") AS "counters",
        EXISTS (SELECT 1 FROM "demo_admissions" WHERE "request_key_digest" = $1) AS "raw_key_retained",
        (SELECT u."expires_at" = s."expires_at" AND s."expires_at" = a."expires_at"
           FROM "users" u JOIN "sessions" s ON s."user_id" = u."id"
           JOIN "demo_admissions" a ON a."owner_id" = u."id" WHERE u."id" = $2) AS "expiries_match",
        (SELECT t."accounting_state" = 'ready' AND t."used_bytes" = 0 AND t."reserved_bytes" = 0
           FROM "storage_account_totals" t WHERE t."owner_id" = $2) AS "ready_state",
        (SELECT "inference_paused" FROM "credit_runtime_policy" WHERE "id" = 1) AS "inference_paused"
    `, [firstKey, ownerId]);
    expect(accountRows[0]).toEqual({
      demo_users: 1, admissions: 1, sessions: 1, counters: 2,
      raw_key_retained: false, expiries_match: true, ready_state: true, inference_paused: true
    });
    const usage = await quotaRepository.readUsage(ownerId);
    expect(usage).toMatchObject({ state: 'ready', usedBytes: 0n, reservedBytes: 0n });

    await expect(demoUseCase.execute({ idempotencyKey: firstKey, clientIp: '192.0.2.55' }))
      .resolves.toEqual({ kind: 'status', state: 'ready' });
    await expect(demoUseCase.execute({ idempotencyKey: secondKey, clientIp: '198.51.100.40' }))
      .rejects.toThrow(DemoAdmissionRateLimitedError);
    const rotatedUseCase = new CreateDemoSessionUseCase(
      admissionRepository,
      { initializeEmptyAccount: async () => undefined },
      tokenProvider,
      { limits, networkHashSecret: rotatedSecret, lifetimeMs: 24 * 60 * 60 * 1000 }
    );
    await expect(rotatedUseCase.execute({ idempotencyKey: thirdKey, clientIp: '192.0.2.56' }))
      .rejects.toThrow(DemoAdmissionUnavailableError);

    const secondOwner = await demoUseCase.execute({ idempotencyKey: secondKey, clientIp: '203.0.113.40' });
    expect(secondOwner.kind).toBe('created');
    const globalLimitKey = randomBytes(32).toString('base64url');
    await expect(demoUseCase.execute({ idempotencyKey: globalLimitKey, clientIp: '192.0.2.99' }))
      .rejects.toThrow(DemoAdmissionRateLimitedError);
    const finalRows: readonly { readonly users: number; readonly admissions: number; readonly global_count: number }[] = await dataSource!.query(`
      SELECT (SELECT count(*)::int FROM "users" WHERE "account_kind" = 'demo') AS "users",
        (SELECT count(*)::int FROM "demo_admissions") AS "admissions",
        (SELECT "count" FROM "demo_admission_counters" WHERE "scope_kind" = 'global_admission') AS "global_count"
    `);
    expect(finalRows).toEqual([{ users: 2, admissions: 2, global_count: 2 }]);
  }, 30_000);

  it('keeps the admitted immutable pin through publication and gates a quota-failed private file copy until verified retry', async () => {
    await requiredDataSource().query('UPDATE "showcase_publication" SET "current_version_id" = $1 WHERE "singleton_id" = true', [FILE_SHOWCASE_VERSION_ID]);
    const idempotencyKey = randomBytes(32).toString('base64url');
    const admitted = await demoUseCase.execute({ idempotencyKey, clientIp: '198.51.100.44' });
    if (admitted.kind !== 'created') throw new Error('The private-copy fixture did not create its demo identity.');
    const ownerId = admitted.session.principal.id;
    const beforeCopy = await quotaRepository.readUsage(ownerId);
    expect(beforeCopy).toMatchObject({ state: 'ready', usedBytes: 0n, reservedBytes: 0n });
    expect(await showcaseCopyManager.isReady(ownerId)).toBe(false);
    expect(await showcaseCopyManager.getStatus(ownerId)).toMatchObject({ state: 'pending', projectId: null, retryAllowed: true, workspaceMode: null, capabilities: null });

    const admissionRows: readonly { readonly id: string; readonly status: string }[] = await requiredDataSource().query(
      'SELECT "id", "status" FROM "demo_admissions" WHERE "owner_id" = $1', [ownerId]
    );
    expect(admissionRows).toHaveLength(1);
    const admissionId = admissionRows[0]!.id;
    expect(admissionRows[0]!.status).toBe('ready');
    const initialCopyRows: readonly { readonly pinned_version_id: string; readonly target_project_id: string; readonly phase: string }[] = await requiredDataSource().query(
      'SELECT "pinned_version_id", "target_project_id", "phase" FROM "demo_showcase_copies" WHERE "admission_id" = $1', [admissionId]
    );
    const initialCopy = initialCopyRows[0];
    expect(initialCopy).toMatchObject({ pinned_version_id: FILE_SHOWCASE_VERSION_ID, phase: 'queued' });
    expect(initialCopy?.target_project_id).toMatch(/^[0-9a-f-]{36}$/u);

    // A later publication cannot retarget this admission or prune its pinned source.
    const publishInput = {
      adminId: REGULAR_OWNER_ID,
      idempotencyDigest: randomBytes(32).toString('hex'),
      requestFingerprint: randomBytes(32).toString('hex'),
      snapshot: {
        project: { name: 'Replacement fixture', objective: null },
        tasks: [],
        facts: [],
        files: []
      },
      contentDigest: createHash('sha256').update('task-3-4-replacement-fixture').digest('hex'),
      snapshotBytes: 0,
      itemCount: 0,
      maxRetainedVersions: 4
    } as const;
    const publication = await showcaseRepository.publish(publishInput);
    expect(publication.replayed).toBe(false);
    await expect(showcaseRepository.publish(publishInput)).resolves.toMatchObject({
      version: publication.version,
      publishedAt: publication.publishedAt,
      replayed: true
    });
    await expect(showcaseRepository.getCurrentSummary()).resolves.toMatchObject({ version: publication.version, fileCount: 0 });
    const pinnedAfterPublish: readonly { readonly pinned_version_id: string }[] = await requiredDataSource().query(
      'SELECT "pinned_version_id" FROM "demo_showcase_copies" WHERE "admission_id" = $1', [admissionId]
    );
    expect(pinnedAfterPublish).toEqual([{ pinned_version_id: FILE_SHOWCASE_VERSION_ID }]);
    await expect(showcaseRepository.getVersion(FILE_SHOWCASE_VERSION_ID)).resolves.toMatchObject({
      files: [expect.objectContaining({ id: SHOWCASE_FILE_ID, sha256: SHOWCASE_FILE_SHA256 })]
    });
    await expect(demoUseCase.execute({ idempotencyKey, clientIp: '203.0.113.44' })).resolves.toEqual({ kind: 'status', state: 'ready' });

    // The user's new project policy must come from the current trusted 4.1 setting, not the pre-existing Home policy.
    await requiredDataSource().query(
      'UPDATE "assistant_policy_provider_configuration" SET "provider_profile" = $1, "model" = $2 WHERE "singleton_id" = true',
      ['fixture-trusted-profile', 'fixture-trusted-model']
    );
    await requiredDataSource().query('UPDATE "account_limits" SET "storage_limit_bytes" = 1024 WHERE "owner_id" = $1', [ownerId]);
    copyFailureDiagnostics.length = 0;
    const stopObservingCopyQueries = observeCopyQueryFailures(requiredDataSource(), copyFailureDiagnostics);
    try {
      await showcaseCopyManager.provision(admissionId, ownerId);
    } finally {
      stopObservingCopyQueries();
    }

    const firstAttemptRows: readonly {
      readonly state: string; readonly phase: string; readonly attempts: number; readonly retry_allowed: boolean;
      readonly failure_code: string | null; readonly claim_token: string | null; readonly admission_status: string;
      readonly owner_active: boolean; readonly project_created: boolean; readonly task_count: number; readonly fact_count: number;
      readonly used_bytes: string; readonly reserved_bytes: string; readonly accounting_state: string;
    }[] = await requiredDataSource().query(`
      SELECT c."state", c."phase", c."attempts", c."retry_allowed", c."failure_code", c."claim_token",
        a."status" AS "admission_status", u."is_active" AS "owner_active",
        EXISTS (SELECT 1 FROM "projects" p WHERE p."id" = c."target_project_id" AND p."owner_id" = c."owner_id") AS "project_created",
        (SELECT count(*)::int FROM "project_tasks" t WHERE t."project_id" = c."target_project_id" AND t."owner_id" = c."owner_id") AS "task_count",
        (SELECT count(*)::int FROM "project_facts" f WHERE f."project_id" = c."target_project_id" AND f."owner_id" = c."owner_id") AS "fact_count",
        (SELECT "used_bytes"::text FROM "storage_account_totals" WHERE "owner_id" = c."owner_id") AS "used_bytes",
        (SELECT "reserved_bytes"::text FROM "storage_account_totals" WHERE "owner_id" = c."owner_id") AS "reserved_bytes",
        (SELECT "accounting_state" FROM "storage_account_totals" WHERE "owner_id" = c."owner_id") AS "accounting_state"
      FROM "demo_showcase_copies" c
      JOIN "demo_admissions" a ON a."id" = c."admission_id"
      JOIN "users" u ON u."id" = c."owner_id"
      WHERE c."admission_id" = $1
    `, [admissionId]);
    expect(copyFailureDiagnostics).toEqual([]);
    expect(firstAttemptRows[0]).toMatchObject({
      state: 'failed', phase: 'files_pending', attempts: 1, retry_allowed: true, failure_code: 'quota',
      claim_token: null, admission_status: 'ready', owner_active: true, project_created: true, task_count: 1, fact_count: 1,
      accounting_state: 'ready'
    });
    expect(await showcaseCopyManager.isReady(ownerId)).toBe(false);
    expect(await showcaseCopyManager.getStatus(ownerId)).toMatchObject({
      state: 'failed', projectId: null, retryAllowed: true, workspaceMode: null, capabilities: null
    });
    const failedCopyRows: readonly { readonly pinned_version_id: string; readonly phase: string; readonly attempts: number; readonly failure_code: string }[] = await requiredDataSource().query(
      'SELECT "pinned_version_id", "phase", "attempts", "failure_code" FROM "demo_showcase_copies" WHERE "admission_id" = $1', [admissionId]
    );
    expect(failedCopyRows[0]).toMatchObject({ pinned_version_id: FILE_SHOWCASE_VERSION_ID, phase: 'files_pending', attempts: 1, failure_code: 'quota' });
    const privateFilePath = path.join(workspaceRoot!, ownerId, 'projects', initialCopy!.target_project_id, 'docs', 'guide.txt');
    await expect(fs.stat(privateFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const failedUsage = await quotaRepository.readUsage(ownerId);
    expect(failedUsage.state).toBe('ready');
    expect(failedUsage.usedBytes).toBeGreaterThan(0n);
    expect(failedUsage.reservedBytes).toBe(0n);

    await requiredDataSource().query('UPDATE "account_limits" SET "storage_limit_bytes" = 20000 WHERE "owner_id" = $1', [ownerId]);
    await expect(showcaseCopyManager.retry(ownerId)).resolves.toMatchObject({
      state: 'ready', projectId: initialCopy!.target_project_id, retryAllowed: false,
      workspaceMode: 'file_backed', capabilities: { planning: true, fileAccess: true }
    });
    expect(await showcaseCopyManager.isReady(ownerId)).toBe(true);
    await expect(fs.readFile(privateFilePath)).resolves.toEqual(SHOWCASE_FILE_BYTES);

    const projectRows: readonly { readonly id: string; readonly owner_id: string; readonly relative_root: string; readonly storage_kind: string }[] = await requiredDataSource().query(
      'SELECT "id", "owner_id", "relative_root", "storage_kind" FROM "projects" WHERE "id" = $1', [initialCopy!.target_project_id]
    );
    expect(projectRows).toEqual([{
      id: initialCopy!.target_project_id,
      owner_id: ownerId,
      relative_root: `projects/${initialCopy!.target_project_id}`,
      storage_kind: 'managed'
    }]);

    const taskRows: readonly { readonly id: string; readonly owner_id: string; readonly title: string; readonly subtasks: unknown }[] = await requiredDataSource().query(
      'SELECT "id", "owner_id", "title", "subtasks" FROM "project_tasks" WHERE "owner_id" = $1 AND "project_id" = $2',
      [ownerId, initialCopy!.target_project_id]
    );
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]).toMatchObject({ owner_id: ownerId, title: 'Prepare the launch checklist' });
    expect(taskRows[0]?.id).not.toBe(SHOWCASE_TASK_ID);
    const copiedSubtasks = typeof taskRows[0]?.subtasks === 'string'
      ? JSON.parse(taskRows[0].subtasks) as readonly { readonly id: string; readonly title: string }[]
      : taskRows[0]?.subtasks as readonly { readonly id: string; readonly title: string }[];
    expect(copiedSubtasks).toHaveLength(1);
    expect(copiedSubtasks[0]).toMatchObject({ title: 'Review the copied files' });
    expect(copiedSubtasks[0]?.id).not.toBe(SHOWCASE_CHECKLIST_ID);
    const factRows: readonly { readonly id: string; readonly owner_id: string; readonly title: string; readonly content: string }[] = await requiredDataSource().query(
      'SELECT "id", "owner_id", "title", "content" FROM "project_facts" WHERE "owner_id" = $1 AND "project_id" = $2',
      [ownerId, initialCopy!.target_project_id]
    );
    expect(factRows).toHaveLength(1);
    expect(factRows[0]).toMatchObject({ owner_id: ownerId, title: 'Workspace name', content: 'Sample workspace for isolated integration tests.' });
    expect(factRows[0]?.id).not.toBe(SHOWCASE_FACT_ID);

    const policies: readonly { readonly scope_kind: string; readonly provider_profile: string | null; readonly model: string | null; readonly revision: number }[] = await requiredDataSource().query(
      'SELECT "scope_kind", "provider_profile", "model", "revision"::int AS "revision" FROM "assistant_scope_policies" WHERE "owner_id" = $1 AND ("scope_kind" = \'home\' OR "project_id" = $2) ORDER BY "scope_kind"',
      [ownerId, initialCopy!.target_project_id]
    );
    expect(policies).toEqual([
      { scope_kind: 'home', provider_profile: null, model: null, revision: 1 },
      { scope_kind: 'project', provider_profile: 'fixture-trusted-profile', model: 'fixture-trusted-model', revision: 1 }
    ]);

    const references: readonly { readonly resource_kind: string; readonly copy_key: string; readonly byte_count: string; readonly sha256: string }[] = await requiredDataSource().query(
      'SELECT "resource_kind", "copy_key", "byte_count", "sha256" FROM "storage_resource_references" WHERE "owner_id" = $1 AND "project_id" = $2',
      [ownerId, initialCopy!.target_project_id]
    );
    expect(references).toContainEqual({ resource_kind: 'project_file', copy_key: 'docs/guide.txt', byte_count: '4096', sha256: SHOWCASE_FILE_SHA256 });
    const unresolved: readonly { readonly count: number }[] = await requiredDataSource().query(
      'SELECT count(*)::int AS "count" FROM "storage_filesystem_reservations" WHERE "owner_id" = $1 AND "status" IN (\'pending\', \'unknown\')',
      [ownerId]
    );
    expect(unresolved).toEqual([{ count: 0 }]);
    const finalUsage = await quotaRepository.readUsage(ownerId);
    expect(finalUsage.state).toBe('ready');
    expect(finalUsage.usedBytes).toBeGreaterThanOrEqual(BigInt(SHOWCASE_FILE_BYTES.length));
    expect(finalUsage.reservedBytes).toBe(0n);
    const readyCopyRows: readonly { readonly state: string; readonly pinned_version_id: string | null; readonly target_project_id: string; readonly workspace_mode: string; readonly file_access: boolean }[] = await requiredDataSource().query(
      'SELECT "state", "pinned_version_id", "target_project_id", "workspace_mode", "file_access" FROM "demo_showcase_copies" WHERE "admission_id" = $1',
      [admissionId]
    );
    expect(readyCopyRows).toEqual([{
      state: 'ready', pinned_version_id: null, target_project_id: initialCopy!.target_project_id,
      workspace_mode: 'file_backed', file_access: true
    }]);
  }, 45_000);

  it('serializes demo run-start caps by owner and leaves regular owners outside that counter', async () => {
    const ready = await demoUseCase.execute({ idempotencyKey: randomBytes(32).toString('base64url'), clientIp: '198.51.100.70' });
    if (ready.kind !== 'created') throw new Error('The run-start fixture did not create its demo identity.');
    const ownerId = ready.session.principal.id;
    const runIds = [randomUUID(), randomUUID()];
    const starts = await Promise.allSettled(runIds.map((runId) => admissionRepository.admitDemoRunStart(ownerId, runId)));
    expect(starts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(starts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = starts.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: expect.any(DemoRunStartRateLimitedError) });

    const rowsBefore = await dataSource!.query('SELECT count(*)::int AS "count" FROM "demo_run_start_events" WHERE "owner_id" = $1', [ownerId]);
    expect(rowsBefore).toEqual([{ count: 1 }]);
    const regularRunId = randomUUID();
    await expect(admissionRepository.admitDemoRunStart(REGULAR_OWNER_ID, regularRunId)).resolves.toBeUndefined();
    const rowsAfter = await dataSource!.query('SELECT count(*)::int AS "count" FROM "demo_run_start_events" WHERE "owner_id" = $1', [REGULAR_OWNER_ID]);
    expect(rowsAfter).toEqual([{ count: 0 }]);
  }, 30_000);

  it('does not consume a demo run-start slot when cancellation commits before beginStart', async () => {
    const admitted = await demoUseCase.execute({ idempotencyKey: randomBytes(32).toString('base64url'), clientIp: '198.51.100.81' });
    if (admitted.kind !== 'created') throw new Error('The demo race fixture did not create its identity.');
    const ownerId = admitted.session.principal.id;
    const projectId = randomUUID();
    const conversationId = randomUUID();
    const runId = randomUUID();
    const relativeRoot = `projects/${projectId}`;
    const rootKey = relativeRoot.toLocaleLowerCase('en-US');
    await dataSource!.query(`
      INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind")
      VALUES ($1, $2, 'Race fixture', $3, $4, $5, 'managed')
    `, [projectId, ownerId, `race-${projectId}`, relativeRoot, rootKey]);
    await dataSource!.query(`
      INSERT INTO "storage_root_mappings" ("owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state")
      VALUES ($1, $2, $2, $3, 'managed', $4, 'active')
    `, [ownerId, projectId, rootKey, relativeRoot]);
    await dataSource!.query(`
      INSERT INTO "conversations" ("id", "owner_id", "project_id", "title") VALUES ($1, $2, $3, 'Race fixture')
    `, [conversationId, ownerId, projectId]);
    const manifest = {
      manifestHash: 'a'.repeat(64), provider: 'NVIDIA hosted NIM', providerProfile: 'nvidia-hosted-nim',
      model: 'nvidia/nemotron-3-super-120b-a12b', categories: ['Request'], files: [], requestBytes: 0,
      messageBytes: 0, messageCount: 0, messageHash: 'b'.repeat(64), byteEstimate: 0, tokenEstimate: 0,
      excludedItemCount: 0, omittedItemCount: 0, omissionSummary: 'No selected items were excluded.',
      bestEffortSecretDetection: true
    };
    await dataSource!.query(`
      INSERT INTO "ai_runs" (
        "id", "owner_id", "project_id", "conversation_id", "request", "relative_root", "storage_kind",
        "requested_paths", "manifest", "manifest_hash", "status", "phase", "decision", "runtime_kind",
        "sandbox_ready", "safe_message", "create_idempotency_key", "request_fingerprint"
      ) VALUES ($1, $2, $3, $4, 'race test', $5, 'managed', '[]'::jsonb, $6::jsonb, $7, 'ready', 'runtime', 'approved', 'fake', true, 'Ready', $8, $9)
    `, [runId, ownerId, projectId, conversationId, relativeRoot, JSON.stringify(manifest), manifest.manifestHash, `create-${runId}`, 'c'.repeat(64)]);

    let releaseBeginStart!: () => void;
    let signalBeginStart!: () => void;
    const beginStartPaused = new Promise<void>((resolve) => { signalBeginStart = resolve; });
    const beginStartGate = new Promise<void>((resolve) => { releaseBeginStart = resolve; });
    class PausedBeginStartRepository extends TypeOrmAiRunRepository {
      public override async beginStart(input: StartRunUpdate): Promise<RunMutationResult> {
        signalBeginStart();
        await beginStartGate;
        return super.beginStart(input);
      }
    }

    const repository = new TypeOrmAiRunRepository(dataSource!);
    const pausedRepository = new PausedBeginStartRepository(dataSource!);
    const runtime = new FakeAgentRuntime();
    const events = new InMemoryRunEventPublisher();
    const start = new StartAiRunUseCase(pausedRepository, new TypeOrmConversationRepository(dataSource!), runtime, events, admissionRepository);
    const cancel = new CancelAiRunUseCase(repository, runtime, events);
    const pendingStart = start.execute({ ownerId, runId, idempotencyKey: `start-${runId}` });
    await beginStartPaused;
    await cancel.execute({ ownerId, runId, idempotencyKey: `cancel-${runId}` });
    releaseBeginStart();

    await expect(pendingStart).rejects.toMatchObject({ code: 'AI_RUN_STATE_CONFLICT' });
    expect(runtime.startedRuns).toEqual([]);
    const finalState: readonly { readonly status: string; readonly start_idempotency_key: string | null }[] = await dataSource!.query(
      'SELECT "status", "start_idempotency_key" FROM "ai_runs" WHERE "id" = $1 AND "owner_id" = $2', [runId, ownerId]
    );
    expect(finalState).toEqual([{ status: 'cancelled', start_idempotency_key: null }]);
    const runStartEvents: readonly { readonly count: number }[] = await dataSource!.query(
      'SELECT count(*)::int AS "count" FROM "demo_run_start_events" WHERE "owner_id" = $1 AND "run_id" = $2', [ownerId, runId]
    );
    expect(runStartEvents).toEqual([{ count: 0 }]);
  }, 30_000);

  function requiredDataSource(): DataSource {
    if (!dataSource?.isInitialized) throw new Error('The guarded demo database is not initialized.');
    return dataSource;
  }
});
