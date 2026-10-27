import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmAdminPortalRepository } from '@/infrastructure/database/repositories/typeorm-admin-portal-repository';
import { TypeOrmSessionRepository, TypeOrmUserRepository } from '@/infrastructure/database/repositories/typeorm-auth-repositories';
import { TypeOrmProjectRepository } from '@/infrastructure/database/repositories/typeorm-project-repository';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmWorkspaceExportRepository } from '@/infrastructure/database/repositories/typeorm-workspace-export-repository';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { OpaqueTokenProvider } from '@/infrastructure/auth/opaque-token-provider';
import { WorkspaceBoundaryAdapter } from '@/infrastructure/workspace/workspace-boundary';
import { LoginUseCase } from '@/modules/auth/use-cases/login';
import { InvalidCredentialsError } from '@/modules/auth/domain/auth-errors';
import { CreateProjectUseCase } from '@/modules/projects/use-cases/create-project';

const databaseUrl = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;
const DATABASE_NAME = 'home_history_pr1_review_safety_test';
const describeDatabase = databaseUrl ? describe : describe.skip;
interface PgClient {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown>>(sql: string): Promise<{ readonly rows: readonly Row[] }>;
  end(): Promise<void>;
}
const { Client } = require('pg') as { readonly Client: new (options: { readonly connectionString: string }) => PgClient };

if (databaseUrl) {
  const target = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(target.hostname)
    || target.port !== '55441' || target.pathname !== '/home_history_test' || target.username !== 'home_test') {
    throw new Error('HOME_CONVERSATION_TEST_DATABASE_URL must target home_test/home_history_test on loopback port 55441.');
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function awaitGate(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<void>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The controlled database operation did not reach its expected gate.')), 5000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

describeDatabase('PR review database safety regressions', () => {
  let source: DataSource;
  let created = false;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded database URL is required.');
    const base = new Client({ connectionString: databaseUrl });
    await base.connect();
    try {
      const identity = await base.query<{ readonly database: string; readonly user: string; readonly can_create: boolean }>(
        'SELECT current_database() AS database,current_user AS "user",(SELECT rolcreatedb FROM pg_roles WHERE rolname=current_user) AS can_create');
      expect(identity.rows).toEqual([{ database: 'home_history_test', user: 'home_test', can_create: true }]);
      await base.query(`CREATE DATABASE "${DATABASE_NAME}" OWNER home_test`); created = true;
    }
    finally { await base.end(); }
    const target = new URL(databaseUrl); target.pathname = `/${DATABASE_NAME}`;
    source = createDataSource({ url: target.toString() });
    await source.initialize();
    await source.runMigrations({ transaction: 'all' });
  }, 120_000);

  afterAll(async () => {
    if (source?.isInitialized) await source.destroy();
    if (!created || !databaseUrl) return;
    const base = new Client({ connectionString: databaseUrl });
    await base.connect();
    try {
      const identity = await base.query<{ readonly database: string; readonly user: string; readonly owner: string }>(
        `SELECT current_database() AS database,current_user AS "user",(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='${DATABASE_NAME}') AS owner`);
      if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test' || identity.rows[0]?.owner !== 'home_test') {
        throw new Error('Refusing to remove the review test database because its guarded identity changed.');
      }
      await base.query(`DROP DATABASE "${DATABASE_NAME}"`);
    }
    finally { await base.end(); }
  });

  async function owner(): Promise<string> {
    const id = randomUUID();
    await source.query(`INSERT INTO users(id,scope_key,identifier,account_kind,role,display_name,password_hash)
      VALUES ($1,$2,$2,'regular','admin','Review fixture','old-test-hash')`, [id, `review-${id}`]);
    const quota = new TypeOrmStorageQuotaRepository(source);
    const accounting = new TypeOrmStorageContentAccounting(source, quota);
    await quota.reconcileReferences(id, await accounting.scanDatabaseContent(source, id));
    return id;
  }

  it('rejects an old credential verified concurrently with a completed admin reset', async () => {
    const id = await owner();
    const verifying = deferred(); const resume = deferred();
    const sessions = new TypeOrmSessionRepository(source);
    const login = new LoginUseCase(new TypeOrmUserRepository(source), sessions, {
      hash: async () => 'unused',
      verify: async (_password, hash) => { expect(hash).toBe('old-test-hash'); verifying.resolve(); await resume.promise; return true; }
    }, new OpaqueTokenProvider('review-session-test-secret-000000000000000000'), { now: () => new Date() }, { sessionLifetimeMs: 60_000 });
    const pending = login.execute({ identifier: `review-${id}`, password: 'valid-old-test-password' });
    const rejected = expect(pending).rejects.toBeInstanceOf(InvalidCredentialsError);
    try { await awaitGate(verifying.promise); await new TypeOrmAdminPortalRepository(source).resetPassword(id, id, 'new-test-hash'); }
    finally { resume.resolve(); }
    await rejected;
    const counts: readonly { readonly count: string }[] = await source.query('SELECT count(*)::text AS count FROM sessions WHERE user_id=$1 AND revoked_at IS NULL', [id]);
    expect(counts[0]?.count).toBe('0');
  });

  it('revokes a session issued before reset and accepts the current credentials afterward', async () => {
    const id = await owner();
    const sessions = new TypeOrmSessionRepository(source);
    await sessions.create({ userId: id, tokenHash: `before-${id}`, expiresAt: new Date(Date.now() + 60_000), expectedPasswordHash: 'old-test-hash' });
    await new TypeOrmAdminPortalRepository(source).resetPassword(id, id, 'new-test-hash');
    expect((await sessions.findByTokenHash(`before-${id}`))?.revokedAt).not.toBeNull();
    await expect(sessions.create({ userId: id, tokenHash: `after-${id}`, expiresAt: new Date(Date.now() + 60_000), expectedPasswordHash: 'new-test-hash' })).resolves.toMatchObject({ userId: id });
  });

  it('removes only uncommitted empty roots after quota rejection, while preserving committed or nonempty roots', async () => {
    const id = await owner();
    await source.query('UPDATE account_limits SET storage_limit_bytes=0 WHERE owner_id=$1', [id]);
    const fixture = managedBoundary();
    const projects = new TypeOrmProjectRepository(source);
    const failedId = randomUUID();
    await expect(new CreateProjectUseCase(projects, fixture.boundary, () => failedId).execute({ ownerId: id, name: 'Denied', workspaceMode: 'file_backed' }))
      .rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' });
    expect(fixture.entries.has(`/account-workspaces/${id}/projects/${failedId}`)).toBe(false);

    await source.query('UPDATE account_limits SET storage_limit_bytes=NULL WHERE owner_id=$1', [id]);
    const committedId = randomUUID();
    const create = projects.create.bind(projects);
    const lostCommit = jest.spyOn(projects, 'create').mockImplementationOnce(async (input) => { await create(input); throw new Error('commit response lost'); });
    await expect(new CreateProjectUseCase(projects, fixture.boundary, () => committedId).execute({ ownerId: id, name: 'Committed', workspaceMode: 'file_backed' })).rejects.toThrow('commit response lost');
    lostCommit.mockRestore();
    expect(fixture.entries.has(`/account-workspaces/${id}/projects/${committedId}`)).toBe(true);
    expect(await projects.findByIdForOwner(id, committedId)).not.toBeNull();

    const nonemptyId = randomUUID();
    const rejectedWrite = jest.spyOn(projects, 'create').mockImplementationOnce(async () => {
      fixture.entries.set(`/account-workspaces/${id}/projects/${nonemptyId}/unexpected.txt`, fixture.file());
      throw new Error('write rejected');
    });
    await expect(new CreateProjectUseCase(projects, fixture.boundary, () => nonemptyId).execute({ ownerId: id, name: 'Nonempty', workspaceMode: 'file_backed' })).rejects.toMatchObject({ code: 'WORKSPACE_STORAGE_UNAVAILABLE' });
    rejectedWrite.mockRestore();
    expect(fixture.entries.has(`/account-workspaces/${id}/projects/${nonemptyId}/unexpected.txt`)).toBe(true);

    const replacedId = randomUUID();
    const replacement = jest.spyOn(projects, 'create').mockImplementationOnce(async () => {
      fixture.entries.set(`/account-workspaces/${id}/projects/${replacedId}`, fixture.directory());
      throw new Error('write rejected');
    });
    await expect(new CreateProjectUseCase(projects, fixture.boundary, () => replacedId).execute({ ownerId: id, name: 'Replaced', workspaceMode: 'file_backed' })).rejects.toMatchObject({ code: 'WORKSPACE_STORAGE_UNAVAILABLE' });
    replacement.mockRestore();
    expect(fixture.entries.has(`/account-workspaces/${id}/projects/${replacedId}`)).toBe(true);
  });

  it('serializes simultaneous export and rename without a project/owner lock cycle', async () => {
    const id = await owner();
    const projects = new TypeOrmProjectRepository(source);
    const projectId = randomUUID();
    await projects.create({ id: projectId, ownerId: id, name: 'Concurrent', slug: 'concurrent', relativeRoot: null, storageKind: null, objective: null });
    const userLocked = deferred(); const exportRequestsOwner = deferred(); const resumeRename = deferred();
    const createRunner = source.createQueryRunner.bind(source);
    let paused = false;
    const hook = jest.spyOn(source, 'createQueryRunner').mockImplementation((mode) => {
      const runner = createRunner(mode);
      const query = runner.query.bind(runner);
      const intercept = async (sql: string, parameters?: unknown[], useStructuredResult?: boolean): Promise<unknown> => {
        if (sql.includes('FROM "users"') && sql.includes('FOR UPDATE')) exportRequestsOwner.resolve();
        const result: unknown = useStructuredResult === true ? await query(sql, parameters, true) : await query(sql, parameters);
        if (!paused && sql.includes('FROM "users"') && sql.includes('FOR SHARE')) {
          paused = true; userLocked.resolve(); await resumeRename.promise;
        }
        return result;
      };
      // Forward both TypeORM overloads unchanged; this hook only coordinates query timing.
      runner.query = intercept as typeof runner.query;
      return runner;
    });
    const rename = projects.rename({ ownerId: id, projectId, expectedVersion: 1, name: 'Renamed', slug: 'renamed' });
    // Observe early rejection while gate assertions are pending; the main assertion still awaits this promise.
    void rename.catch(() => undefined);
    try {
      await awaitGate(userLocked.promise);
      const exporting = new TypeOrmWorkspaceExportRepository(source).begin({ ownerId: id, workspaceId: projectId,
        keyDigest: 'a'.repeat(64), requestFingerprint: 'b'.repeat(64), builder: { processId: process.pid, startTicks: '1' } });
      void exporting.catch(() => undefined);
      await awaitGate(exportRequestsOwner.promise);
      resumeRename.resolve();
      await expect(Promise.all([rename, exporting])).resolves.toHaveLength(2);
    } finally { resumeRename.resolve(); hook.mockRestore(); }
  }, 15_000);
});

function managedBoundary() {
  let inode = 10;
  const directory = () => ({ dev: 1, ino: inode++, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false });
  const file = () => ({ dev: 1, ino: inode++, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false });
  const entries = new Map<string, ReturnType<typeof directory>>([
    ['/workspace', directory()], ['/workspace/.identity', file()], ['/account-workspaces', directory()],
    ['/account-workspaces/.personal-ai-managed-storage-identity', file()]
  ]);
  const boundary = new WorkspaceBoundaryAdapter({ containerRoot: '/workspace', identityFile: '/workspace/.identity', expectedIdentity: 'marker',
    managedContainerRoot: '/account-workspaces', managedIdentityFile: '/account-workspaces/.personal-ai-managed-storage-identity', managedExpectedIdentity: 'marker',
    fileSystem: {
      lstat: async (target) => { const entry = entries.get(target); if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return entry; },
      mkdir: async (target) => { if (entries.has(target)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); entries.set(target, directory()); },
      realpath: async (target) => target, readFile: async () => 'marker',
      readdir: async (target) => [...entries.keys()].filter((key) => key.startsWith(`${target}/`) && !key.slice(target.length + 1).includes('/')).map((key) => key.slice(target.length + 1)),
      rmdir: async (target) => { if ([...entries.keys()].some((key) => key.startsWith(`${target}/`))) throw new Error('nonempty'); entries.delete(target); }
    }
  });
  return { boundary, entries, file, directory };
}
