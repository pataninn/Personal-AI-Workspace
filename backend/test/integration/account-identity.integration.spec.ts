import type { DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmSessionRepository, TypeOrmUserRepository } from '@/infrastructure/database/repositories/typeorm-auth-repositories';
import { SetupRequiredError, UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import type { IClock, IOpaqueTokenProvider, IPasswordHasher } from '@/modules/auth/repositories/security-providers';
import { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { LoginUseCase } from '@/modules/auth/use-cases/login';

const IDENTITY_DATABASE = 'home_history_task_2_1_identity_test';
const OWNER_PASSWORD_HASH = 'identity-test-owner-hash';
const OWNER_TOKEN = 'identity-test-owner-session-token-0001';
const NOW = new Date('2026-10-19T12:00:00.000Z');

interface PgClient {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
  end(): Promise<void>;
}

const { Client } = require('pg') as { readonly Client: new (options: { readonly connectionString: string }) => PgClient };
const databaseUrl = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

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

describeDatabase('Account identity PostgreSQL integration', () => {
  let identityUrl: string;
  let dataSource: DataSource | undefined;
  let databaseCreated = false;
  let users: TypeOrmUserRepository;
  let sessions: TypeOrmSessionRepository;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded account identity test database URL is required.');
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
      `, [IDENTITY_DATABASE]);
      if (identity.rows[0]?.database !== 'home_history_test'
        || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.canCreateDatabase !== true) {
        throw new Error('The guarded test role cannot create the separate account identity database.');
      }
      if (identity.rows[0]?.databaseExists) {
        throw new Error('The fixed Task 2.1 database already exists; inspect ownership before retrying.');
      }
      await baseClient.query(`CREATE DATABASE "${IDENTITY_DATABASE}" OWNER "home_test"`);
      databaseCreated = true;
    } finally {
      await baseClient.end();
    }

    const target = new URL(databaseUrl);
    target.pathname = `/${IDENTITY_DATABASE}`;
    identityUrl = target.toString();
    dataSource = createDataSource({ url: identityUrl });
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
    users = new TypeOrmUserRepository(dataSource);
    sessions = new TypeOrmSessionRepository(dataSource);
  }, 120_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (!databaseCreated || !databaseUrl) return;
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      await baseClient.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [IDENTITY_DATABASE]
      );
      await baseClient.query(`DROP DATABASE "${IDENTITY_DATABASE}"`);
      databaseCreated = false;
    } finally {
      await baseClient.end();
    }
  }, 30_000);

  it('bootstraps one owner, normalizes login, and serializes account disabling with session revocation', async () => {
    if (!dataSource) throw new Error('The isolated account identity database was not initialized.');
    const initialDemoId = '62a00000-0000-4000-8000-000000000000';
    await dataSource.query(`
      INSERT INTO "users" ("id", "scope_key", "identifier", "account_kind", "role", "display_name", "password_hash", "expires_at")
      VALUES ($1, 'demo:identity-bootstrap', NULL, 'demo', 'user', 'Bootstrap Demo Fixture', NULL, $2)
    `, [initialDemoId, new Date(NOW.getTime() + 60_000)]);
    expect(await users.hasAnyRegularAccounts()).toBe(false);
    const setupLogin = new LoginUseCase(
      users,
      sessions,
      { hash: async (password) => `hash:${password}`, verify: async () => false },
      { createToken: () => OWNER_TOKEN, digestToken: (token) => `identity-test-hash:${token}`, createCsrfToken: (token) => `identity-test-csrf:${token}` },
      { now: () => NOW },
      { sessionLifetimeMs: 60_000 }
    );
    await expect(setupLogin.execute({ identifier: 'unknown-user', password: 'any-password' })).rejects.toBeInstanceOf(SetupRequiredError);

    const firstBootstrap = await users.bootstrapInitialAdmin({ displayName: 'Identity Test Owner', passwordHash: OWNER_PASSWORD_HASH });
    const secondBootstrap = await users.bootstrapInitialAdmin({ displayName: 'Replacement Owner', passwordHash: 'must-not-replace' });
    expect(firstBootstrap).toBe(true);
    expect(secondBootstrap).toBe(false);
    expect(await users.hasAnyRegularAccounts()).toBe(true);
    const owner = await users.findByIdentifier('owner');
    expect(owner).toMatchObject({
      displayName: 'Identity Test Owner',
      identifier: 'owner',
      accountKind: 'regular',
      role: 'admin',
      passwordHash: OWNER_PASSWORD_HASH,
      isActive: true,
      expiresAt: null
    });
    expect(await users.findByIdentifier('replacement-owner')).toBeNull();

    const passwordHasher: IPasswordHasher = {
      hash: async (password) => `hash:${password}`,
      verify: async (password, hash) => hash === OWNER_PASSWORD_HASH && password === 'owner-password'
    };
    const tokenProvider: IOpaqueTokenProvider = {
      createToken: () => OWNER_TOKEN,
      digestToken: (token) => `identity-test-hash:${token}`,
      createCsrfToken: (token) => `identity-test-csrf:${token}`
    };
    const clock: IClock = { now: () => NOW };
    const login = new LoginUseCase(users, sessions, passwordHasher, tokenProvider, clock, { sessionLifetimeMs: 60_000 });
    const signedIn = await login.execute({ identifier: '  OWNER  ', password: 'owner-password' });
    expect(signedIn.principal).toEqual({
      id: owner?.id,
      displayName: 'Identity Test Owner',
      accountKind: 'regular',
      role: 'admin'
    });
    const getSession = new GetSessionUseCase(sessions, tokenProvider, clock);
    await expect(getSession.execute(OWNER_TOKEN)).resolves.toMatchObject({ principal: signedIn.principal });

    const regular = await users.createRegularAccount({
      identifier: 'member-one',
      role: 'user',
      displayName: 'Identity Test Member',
      passwordHash: 'member-password-hash'
    });
    expect(regular).toMatchObject({ identifier: 'member-one', accountKind: 'regular', role: 'user', isActive: true });
    const generatedScope: readonly { readonly scope_key: string }[] = await dataSource.query(
      'SELECT "scope_key" FROM "users" WHERE "id" = $1',
      [regular.id]
    );
    expect(generatedScope[0]?.scope_key).toMatch(/^account:[0-9a-f]{32}$/u);
    await expect(users.createRegularAccount({
      identifier: 'member-one', role: 'user', displayName: 'Duplicate', passwordHash: 'other-hash'
    })).rejects.toThrow();

    const memberTokenHash = 'identity-test-member-session';
    await sessions.create({ userId: regular.id, tokenHash: memberTokenHash, expiresAt: new Date(NOW.getTime() + 60_000) });
    expect(await users.disableAccount(owner!.id, regular.id)).toBe('disabled');
    const revokedMemberSession: readonly { readonly revoked_at: Date | null }[] = await dataSource.query(
      'SELECT "revoked_at" FROM "sessions" WHERE "token_hash" = $1',
      [memberTokenHash]
    );
    expect(revokedMemberSession[0]?.revoked_at).toBeInstanceOf(Date);
    await expect(sessions.findByTokenHash(memberTokenHash)).resolves.toBeNull();

    const secondAdmin = await users.createRegularAccount({
      identifier: 'admin-two',
      role: 'admin',
      displayName: 'Identity Test Admin Two',
      passwordHash: 'admin-two-password-hash'
    });
    const thirdAdmin = await users.createRegularAccount({
      identifier: 'admin-three',
      role: 'admin',
      displayName: 'Identity Test Admin Three',
      passwordHash: 'admin-three-password-hash'
    });
    expect(await users.disableAccount(owner!.id, thirdAdmin.id)).toBe('disabled');
    const adminsBeforeRace: readonly { readonly id: string }[] = await dataSource.query(
      'SELECT "id" FROM "users" WHERE "role" = \'admin\' AND "is_active" = true ORDER BY "id"'
    );
    expect(adminsBeforeRace.map((admin) => admin.id).sort()).toEqual([owner!.id, secondAdmin.id].sort());

    const concurrentDisable = await Promise.all([
      users.disableAccount(owner!.id, secondAdmin.id),
      users.disableAccount(secondAdmin.id, owner!.id)
    ]);
    expect(concurrentDisable.sort()).toEqual(['disabled', 'forbidden']);
    const activeAdmins: readonly { readonly id: string }[] = await dataSource.query(
      'SELECT "id" FROM "users" WHERE "role" = \'admin\' AND "is_active" = true ORDER BY "id"'
    );
    expect(activeAdmins).toHaveLength(1);
    expect(await users.disableAccount(activeAdmins[0]!.id, activeAdmins[0]!.id)).toBe('last-active-admin');
  }, 30_000);

  it('keeps demo accounts passwordless and denies sessions after the account expiry', async () => {
    if (!dataSource) throw new Error('The isolated account identity database was not initialized.');
    const demoId = '62a00000-0000-4000-8000-000000000001';
    const demoTokenHash = 'identity-test-expired-demo-session';
    await dataSource.query(`
      INSERT INTO "users" ("id", "scope_key", "identifier", "account_kind", "role", "display_name", "password_hash", "expires_at")
      VALUES ($1, 'demo:identity-test', NULL, 'demo', 'user', 'Expired Demo Fixture', NULL, $2)
    `, [demoId, new Date(NOW.getTime() - 1_000)]);
    const demo = await users.findById(demoId);
    expect(demo).toMatchObject({ identifier: null, accountKind: 'demo', role: 'user', passwordHash: null });
    expect(await users.findByIdentifier('expired-demo-fixture')).toBeNull();

    const tokenProvider: IOpaqueTokenProvider = {
      createToken: () => 'identity-test-unused-token',
      digestToken: (token) => token === 'expired-demo-token' ? demoTokenHash : `identity-test-hash:${token}`,
      createCsrfToken: (token) => `identity-test-csrf:${token}`
    };
    await sessions.create({ userId: demoId, tokenHash: demoTokenHash, expiresAt: new Date(NOW.getTime() + 60_000) });
    const getSession = new GetSessionUseCase(sessions, tokenProvider, { now: () => NOW });
    await expect(getSession.execute('expired-demo-token')).rejects.toBeInstanceOf(UnauthenticatedError);
  }, 30_000);
});
