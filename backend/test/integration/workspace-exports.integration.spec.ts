import { DataSource } from 'typeorm';
import request from 'supertest';

import { createApp } from '@/app';
import { OpaqueTokenProvider } from '@/infrastructure/auth/opaque-token-provider';
import { TypeOrmSessionRepository } from '@/infrastructure/database/repositories/typeorm-auth-repositories';
import { TypeOrmWorkspaceExportRepository } from '@/infrastructure/database/repositories/typeorm-workspace-export-repository';
import { ReconcileWorkspaceExports } from '@/modules/workspace-exports/use-cases/reconcile-workspace-exports';
import { CreateWorkspaceExportUseCase } from '@/modules/workspace-exports/use-cases/create-workspace-export';
import { DownloadWorkspaceExportUseCase } from '@/modules/workspace-exports/use-cases/download-workspace-export';
import type { IWorkspaceExportArtifactStore } from '@/modules/workspace-exports/repositories/workspace-export-repository';
import { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { SESSION_COOKIE_NAME } from '@/modules/auth/controllers/request-auth';
import { GetReadinessUseCase } from '@/modules/health';
import { createDataSource } from '@/infrastructure/database/data-source';
import { createLogger } from '@/shared/logging/logger';

const DATABASE_NAME = 'home_history_task_6_4_workspace_exports_test';
const OWNER_ONE = '6c640000-0000-4000-8000-000000000001';
const OWNER_TWO = '6c640000-0000-4000-8000-000000000002';
const WORKSPACE_ONE = '6c640000-0000-4000-8000-000000000011';
const WORKSPACE_TWO = '6c640000-0000-4000-8000-000000000012';
const APP_ORIGIN = 'https://127.0.0.1:8443';
const TOKEN_ONE = 'task-6-4-owner-one-session-token-00000000000001';
const TOKEN_TWO = 'task-6-4-owner-two-session-token-00000000000002';
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

describeDatabase('Task 6.4 bounded workspace exports with isolated PostgreSQL and private artifacts', () => {
  let dataSource: DataSource | undefined;
  let databaseCreated = false;
  const artifactBytes = new Map<string, Buffer>();
  let artifacts: IWorkspaceExportArtifactStore;
  let exports: TypeOrmWorkspaceExportRepository;
  let app: ReturnType<typeof createApp>;
  let csrfOne: string;
  let csrfTwo: string;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded workspace export database URL is required.');
    await createIsolatedDatabase();
    const target = new URL(databaseUrl);
    target.pathname = `/${DATABASE_NAME}`;
    const configured = createDataSource({ url: target.toString() });
    dataSource = new DataSource({ ...configured.options, extra: { max: 1 } });
    await dataSource.initialize();
    const identity = await dataSource.query('SELECT current_database() AS "database", current_user AS "user"');
    expect(identity).toEqual([{ database: DATABASE_NAME, user: 'home_test' }]);
    const applied = await dataSource.runMigrations({ transaction: 'all' });
    expect(applied).toHaveLength(dataSource.migrations.length);

    artifacts = {
      write: async (id, bytes) => { artifactBytes.set(id, Buffer.from(bytes)); },
      read: async (id) => {
        const bytes = artifactBytes.get(id);
        if (!bytes) throw new Error('Preview artifact is unavailable.');
        return Buffer.from(bytes);
      },
      exists: async (id) => artifactBytes.has(id),
      remove: async (id) => { artifactBytes.delete(id); },
      listPartIds: async () => []
    };
    exports = new TypeOrmWorkspaceExportRepository(dataSource);
    await seedWorkspace(dataSource);

    const tokens = new OpaqueTokenProvider('task-6-4-integration-session-secret');
    const sessionRepository = new TypeOrmSessionRepository(dataSource);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await sessionRepository.create({ userId: OWNER_ONE, tokenHash: tokens.digestToken(TOKEN_ONE), expiresAt });
    await sessionRepository.create({ userId: OWNER_TWO, tokenHash: tokens.digestToken(TOKEN_TWO), expiresAt });
    csrfOne = tokens.createCsrfToken(TOKEN_ONE);
    csrfTwo = tokens.createCsrfToken(TOKEN_TWO);

    const create = new CreateWorkspaceExportUseCase(
      exports,
      artifacts,
      { execute: async () => { throw new Error('Rootless workspace unexpectedly requested filesystem access.'); }, authorizeMutation: async () => { throw new Error('Mutation access is not used by exports.'); } },
      { download: async () => { throw new Error('Downloads use the private artifact store.'); }, captureForExport: async () => { throw new Error('Rootless workspace unexpectedly enumerated files.'); }, write: async () => { throw new Error('Mutation access is not used by exports.'); }, remove: async () => { throw new Error('Mutation access is not used by exports.'); } },
      async () => ({ processId: process.pid, startTicks: '1' })
    );
    const download = new DownloadWorkspaceExportUseCase(exports, artifacts);
    const readiness = new GetReadinessUseCase({ getSnapshot: () => ({ status: 'ready', failures: [] }), markReady: () => undefined, markFailed: () => undefined });
    app = createApp({
      logger: createLogger('silent'), appVersion: 'test', readiness,
      workspaceExports: {
        create,
        download,
        getSession: new GetSessionUseCase(sessionRepository, tokens, { now: () => new Date() }),
        clearSessionCookie: (response) => { response.clearCookie(SESSION_COOKIE_NAME); },
        appOrigin: APP_ORIGIN
      }
    });
  }, 120_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await dropOnlyIsolatedDatabase();
  }, 30_000);

  beforeEach(async () => {
    await requiredDataSource().query('TRUNCATE TABLE "workspace_exports", "project_removal_jobs"');
    artifactBytes.clear();
  });

  it('creates one bounded owner-scoped JSON artifact and replays the same key with protected download headers', async () => {
    const captured = await exports.captureSnapshot(OWNER_ONE, WORKSPACE_ONE);
    expect(captured.workspace).toEqual({ id: WORKSPACE_ONE, name: 'Alpha workspace', objective: 'Export fixture' });
    const created = await postCreate(OWNER_ONE, WORKSPACE_ONE, 'task-6-4-idem-0001', 201);
    const descriptor = created.body.data.export as { readonly id: string; readonly workspaceId: string; readonly sizeBytes: number; readonly expiresAt: string };
    expect(descriptor).toMatchObject({ workspaceId: WORKSPACE_ONE, sizeBytes: expect.any(Number) });
    expect(Date.parse(descriptor.expiresAt)).toBeGreaterThan(Date.now());

    const replay = await postCreate(OWNER_ONE, WORKSPACE_ONE, 'task-6-4-idem-0001', 200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body.data.export).toEqual(descriptor);
    await expect(exportsCount(OWNER_ONE)).resolves.toBe(1);

    const response = await request(app).get(`/api/v1/workspace-exports/${descriptor.id}`)
      .set({ Cookie: cookie(TOKEN_ONE), Accept: 'application/json' })
      .buffer(true)
      .parse((incoming, callback) => {
        let body = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk: string) => { body += chunk; });
        incoming.on('end', () => callback(null, body));
      })
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBe(`attachment; filename="workspace-export-${descriptor.id}.json"`);
    expect(response.headers['content-length']).toBe(String(descriptor.sizeBytes));
    const document = JSON.parse(response.body as string) as Record<string, unknown>;
    expect(Object.keys(document)).toEqual(['manifest', 'workspace', 'files', 'tasks', 'memory', 'conversations', 'skills', 'schedules']);
    expect(document.workspace).toEqual({ id: WORKSPACE_ONE, name: 'Alpha workspace', objective: 'Export fixture' });
    expect(JSON.stringify(document)).not.toContain(OWNER_ONE);
    expect(JSON.stringify(document)).not.toContain('relative_root');
  });

  it('returns the same unavailable response for foreign, expired, and unknown export IDs', async () => {
    const created = await postCreate(OWNER_ONE, WORKSPACE_ONE, 'task-6-4-idem-0002', 201);
    const exportId = created.body.data.export.id as string;
    const foreign = await request(app).get(`/api/v1/workspace-exports/${exportId}`).set({ Cookie: cookie(TOKEN_TWO) }).expect(404);
    const missing = await request(app).get('/api/v1/workspace-exports/6c640000-0000-4000-8000-000000000099').set({ Cookie: cookie(TOKEN_TWO) }).expect(404);
    await requiredDataSource().query('UPDATE "workspace_exports" SET "expires_at"=clock_timestamp()-interval \'1 second\' WHERE "id"=$1', [exportId]);
    const expired = await request(app).get(`/api/v1/workspace-exports/${exportId}`).set({ Cookie: cookie(TOKEN_ONE) }).expect(404);
    expect(foreign.body.error).toEqual(missing.body.error);
    expect(expired.body.error).toEqual(missing.body.error);
    expect(JSON.stringify(foreign.body)).not.toContain(exportId);
  });

  it('enforces two active exports and preserves the exact removal fence until a builder is terminal', async () => {
    const first = await postCreate(OWNER_ONE, WORKSPACE_ONE, 'task-6-4-idem-0003', 201);
    const second = await postCreate(OWNER_ONE, WORKSPACE_ONE, 'task-6-4-idem-0004', 201);
    const firstId = first.body.data.export.id as string;
    const secondId = second.body.data.export.id as string;
    const overLimit = await postCreate(OWNER_ONE, WORKSPACE_ONE, 'task-6-4-idem-0005', 429);
    expect(overLimit.body.error.code).toBe('EXPORT_LIMIT_REACHED');
    await expect(exportsCount(OWNER_ONE)).resolves.toBe(2);

    await requiredDataSource().query(`INSERT INTO "project_removal_jobs" ("owner_id","project_id","storage_root_key","run_ids","export_ids")
      VALUES ($1,$2,NULL,'[]'::jsonb,$3::jsonb)`, [OWNER_ONE, WORKSPACE_ONE, JSON.stringify([firstId])]);
    const barrierRead = await requiredDataSource().query('SELECT "export_ids" FROM "project_removal_jobs" WHERE "owner_id"=$1 AND "project_id"=$2', [OWNER_ONE, WORKSPACE_ONE]) as readonly { export_ids: unknown }[];
    expect(barrierRead[0]?.export_ids).toEqual([firstId]);
    await requiredDataSource().query(`UPDATE "workspace_exports" SET "state"='building',"expires_at"=NULL,"byte_count"=NULL,
      "builder_process_id"=2147483000,"builder_start_ticks"='1' WHERE "id"=$1`, [firstId]);

    const fencedCreate = await postCreate(OWNER_ONE, WORKSPACE_ONE, 'task-6-4-idem-0006', 404);
    expect(fencedCreate.body.error.code).toBe('WORKSPACE_UNAVAILABLE');
    const cleanup = new ReconcileWorkspaceExports(exports, artifacts, async () => 'active');
    await expect(cleanup.waitForTerminalAndRemove([firstId], 0)).rejects.toMatchObject({ code: 'EXPORT_CLEANUP_PENDING' });
    await expect(artifacts.exists(firstId)).resolves.toBe(true);
    await expect(artifacts.exists(secondId)).resolves.toBe(true);

    await requiredDataSource().query(`UPDATE "workspace_exports" SET "state"='failed',"builder_process_id"=NULL,"builder_start_ticks"=NULL WHERE "id"=$1`, [firstId]);
    await cleanup.waitForTerminalAndRemove([firstId]);
    await expect(artifacts.exists(firstId)).resolves.toBe(false);
    await expect(artifacts.exists(secondId)).resolves.toBe(true);
    const remaining = await requiredDataSource().query('SELECT "id" FROM "workspace_exports" WHERE "owner_id"=$1 ORDER BY "id"', [OWNER_ONE]) as readonly { id: string }[];
    expect(remaining.map((row) => row.id)).toEqual([secondId]);
  });

  async function postCreate(ownerId: string, workspaceId: string, key: string, status: number): Promise<request.Response> {
    const token = ownerId === OWNER_ONE ? TOKEN_ONE : TOKEN_TWO;
    const csrf = ownerId === OWNER_ONE ? csrfOne : csrfTwo;
    const response = await request(app).post('/api/v1/workspace-exports')
      .set({ Cookie: cookie(token), Origin: APP_ORIGIN, 'X-CSRF-Token': csrf, 'Idempotency-Key': key })
      .send({ workspaceId });
    if (response.status !== status) throw new Error(`Unexpected create status ${response.status} with API code ${String(response.body?.error?.code ?? 'unknown')}.`);
    return response;
  }

  async function exportsCount(ownerId: string): Promise<number> {
    const rows: readonly { readonly count: string }[] = await requiredDataSource().query(
      'SELECT count(*)::text AS "count" FROM "workspace_exports" WHERE "owner_id"=$1', [ownerId]);
    return Number(rows[0]?.count ?? 0);
  }

  async function seedWorkspace(source: DataSource): Promise<void> {
    await source.query(`INSERT INTO "users" ("id","scope_key","display_name","password_hash","identifier","account_kind","role")
      VALUES ($1,'task-6-4-owner-one','Export owner one','fixture-hash','export-owner-one','regular','user'),
             ($2,'task-6-4-owner-two','Export owner two','fixture-hash','export-owner-two','regular','user')`, [OWNER_ONE, OWNER_TWO]);
    await source.query(`INSERT INTO "projects" ("id","owner_id","name","slug","relative_root","relative_root_key","objective")
      VALUES ($1,$2,'Alpha workspace','alpha-workspace',NULL,NULL,'Export fixture'),
             ($3,$4,'Beta workspace','beta-workspace',NULL,NULL,'Foreign workspace')`, [WORKSPACE_ONE, OWNER_ONE, WORKSPACE_TWO, OWNER_TWO]);
  }

  async function createIsolatedDatabase(): Promise<void> {
    if (!databaseUrl) throw new Error('The guarded workspace export database URL is required.');
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      const identity = await baseClient.query<{
        readonly database: string; readonly user: string; readonly canCreateDatabase: boolean;
        readonly databaseExists: boolean; readonly targetSessions: number;
      }>(`SELECT current_database() AS "database", current_user AS "user",
          (SELECT "rolcreatedb" FROM "pg_roles" WHERE "rolname"=current_user) AS "canCreateDatabase",
          EXISTS (SELECT 1 FROM "pg_database" WHERE "datname"=$1) AS "databaseExists",
          (SELECT count(*)::int FROM "pg_stat_activity" WHERE "datname"=$1) AS "targetSessions"`, [DATABASE_NAME]);
      const row = identity.rows[0];
      if (row?.database !== 'home_history_test' || row.user !== 'home_test' || row.canCreateDatabase !== true
        || row.databaseExists || row.targetSessions !== 0) {
        throw new Error('The guarded workspace export role cannot safely create its isolated database.');
      }
      await baseClient.query(`CREATE DATABASE "${DATABASE_NAME}" OWNER "home_test"`);
      databaseCreated = true;
    } finally { await baseClient.end(); }
  }

  async function dropOnlyIsolatedDatabase(): Promise<void> {
    if (!databaseCreated || !databaseUrl) return;
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      const identity = await baseClient.query<{
        readonly database: string; readonly user: string; readonly owner: string | null;
        readonly databaseExists: boolean; readonly targetSessions: number;
      }>(`SELECT current_database() AS "database", current_user AS "user",
          (SELECT pg_get_userbyid("datdba") FROM "pg_database" WHERE "datname"=$1) AS "owner",
          EXISTS (SELECT 1 FROM "pg_database" WHERE "datname"=$1) AS "databaseExists",
          (SELECT count(*)::int FROM "pg_stat_activity" WHERE "datname"=$1) AS "targetSessions"`, [DATABASE_NAME]);
      const row = identity.rows[0];
      if (row?.database !== 'home_history_test' || row.user !== 'home_test' || row.owner !== 'home_test') {
        throw new Error('Refusing to remove the workspace export database after its guarded identity changed.');
      }
      if (!row.databaseExists) { databaseCreated = false; return; }
      if (row.targetSessions !== 0) throw new Error('Refusing workspace export database teardown while sessions remain connected.');
      await baseClient.query(`DROP DATABASE "${DATABASE_NAME}"`);
      databaseCreated = false;
    } finally { await baseClient.end(); }
  }

  function cookie(token: string): string { return `${SESSION_COOKIE_NAME}=${token}`; }
  function requiredDataSource(): DataSource {
    if (!dataSource?.isInitialized) throw new Error('The isolated workspace export database is not initialized.');
    return dataSource;
  }
});
