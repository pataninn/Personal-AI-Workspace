import type { DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmConversationRepository } from '@/infrastructure/database/repositories/typeorm-conversation-repository';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import type { AddMessageRecord, CreateConversationRecord } from '@/modules/conversations/repositories/conversation-repository';

const DATABASE_NAME = 'home_history_task_3_2_conversation_test';
const OWNER_ID = '3a320000-0000-4000-8000-000000000201';
const FOREIGN_OWNER_ID = '3a320000-0000-4000-8000-000000000202';
const PROJECT_ID = '3a320000-0000-4000-8000-000000000203';
const databaseUrl = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

interface PgClient {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
  end(): Promise<void>;
}

type OwnerCounts = { readonly conversations: string; readonly messages: string; readonly idempotencyKeys: string };
type ReferenceRow = { readonly resource_key: string; readonly copy_key: string; readonly byte_count: string };

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

describeDatabase('Project conversation storage quota PostgreSQL integration', () => {
  let dataSource: DataSource | undefined;
  let databaseCreated = false;
  let conversationRepository: TypeOrmConversationRepository;
  let quotaRepository: TypeOrmStorageQuotaRepository;
  let accounting: TypeOrmStorageContentAccounting;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded conversation quota database URL is required.');
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

    await seedOwnerAndProject(dataSource);
    quotaRepository = new TypeOrmStorageQuotaRepository(dataSource);
    accounting = new TypeOrmStorageContentAccounting(dataSource, quotaRepository);
    conversationRepository = new TypeOrmConversationRepository(dataSource, accounting);
    await reconcileOwner(dataSource, quotaRepository, accounting, OWNER_ID);
    await reconcileOwner(dataSource, quotaRepository, accounting, FOREIGN_OWNER_ID);
  }, 120_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (!databaseCreated || !databaseUrl) return;
    await dropIsolatedDatabase();
    databaseCreated = false;
  }, 30_000);

  it('charges UTF-8 title, message, and each retained fingerprint once; rolls back denied growth and honors ownership/removal barriers', async () => {
    const source = requiredDataSource();
    const initialUsage = await quotaRepository.readUsage(OWNER_ID);
    expect(initialUsage.state).toBe('ready');
    if (initialUsage.usedBytes === null) throw new Error('The seeded inventory must have verified byte totals.');
    const baselineBytes = initialUsage.usedBytes;
    await setStorageLimit(source, OWNER_ID, 10_000n);

    const title = 'é';
    const createFingerprint = title;
    const createKey = 'conversation-create-key-0001';
    const created = await conversationRepository.create(createInput(OWNER_ID, title, createKey));
    expect(created.replayed).toBe(false);
    const createReplay = await conversationRepository.create(createInput(OWNER_ID, title, createKey));
    expect(createReplay).toMatchObject({ replayed: true, resource: { id: created.resource.id } });

    const messageContent = '雪';
    const messageKey = 'conversation-message-key-0001';
    const messageFingerprint = JSON.stringify({ conversationId: created.resource.id, content: messageContent });
    const message = await conversationRepository.addUserMessage(messageInput(created.resource.id, messageContent, messageKey));
    expect(message.replayed).toBe(false);
    const messageReplay = await conversationRepository.addUserMessage(messageInput(created.resource.id, messageContent, messageKey));
    expect(messageReplay).toMatchObject({ replayed: true, resource: { id: message.resource.id } });

    const createFingerprintBytes = Buffer.byteLength(createFingerprint, 'utf8');
    const messageBytes = Buffer.byteLength(messageContent, 'utf8');
    const messageFingerprintBytes = Buffer.byteLength(messageFingerprint, 'utf8');
    const expectedUsage = baselineBytes + BigInt(createFingerprintBytes * 2 + messageBytes + messageFingerprintBytes);
    await expect(quotaRepository.readUsage(OWNER_ID)).resolves.toMatchObject({ state: 'ready', usedBytes: expectedUsage });
    await expect(readOwnerCounts(source, OWNER_ID)).resolves.toEqual({ conversations: '1', messages: '1', idempotencyKeys: '2' });

    const fingerprints = await readFingerprints(source, OWNER_ID);
    const createIdempotency = fingerprints.find((row) => row.operation === 'conversation');
    const messageIdempotency = fingerprints.find((row) => row.operation === 'message');
    expect(createIdempotency).toMatchObject({
      request_fingerprint: createFingerprint,
      byte_count: String(createFingerprintBytes),
      resource_id: created.resource.id
    });
    expect(messageIdempotency).toMatchObject({
      request_fingerprint: messageFingerprint,
      byte_count: String(messageFingerprintBytes),
      resource_id: message.resource.id
    });
    if (!createIdempotency || !messageIdempotency) throw new Error('Both retained fingerprint rows must be present.');

    const expectedReferences = [
      { resource_key: `conversation_idempotency_keys:${createIdempotency.id}`, copy_key: 'request_fingerprint', byte_count: String(createFingerprintBytes) },
      { resource_key: `conversation_idempotency_keys:${messageIdempotency.id}`, copy_key: 'request_fingerprint', byte_count: String(messageFingerprintBytes) },
      { resource_key: `conversations:${created.resource.id}`, copy_key: 'title', byte_count: String(createFingerprintBytes) },
      { resource_key: `messages:${message.resource.id}`, copy_key: 'content', byte_count: String(messageBytes) }
    ];
    expect(await readConversationReferences(source, OWNER_ID, created.resource.id, message.resource.id,
      createIdempotency.id, messageIdempotency.id)).toEqual(sortReferences(expectedReferences));

    await setStorageLimit(source, OWNER_ID, expectedUsage);
    const referencesBeforeDenial = await readReferences(source, OWNER_ID);
    await expect(conversationRepository.addUserMessage(messageInput(created.resource.id, 'a', 'conversation-message-key-denied')))
      .rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED', statusCode: 413 });
    await expect(readOwnerCounts(source, OWNER_ID)).resolves.toEqual({ conversations: '1', messages: '1', idempotencyKeys: '2' });
    await expect(readReferences(source, OWNER_ID)).resolves.toEqual(referencesBeforeDenial);
    await expect(quotaRepository.readUsage(OWNER_ID)).resolves.toMatchObject({ usedBytes: expectedUsage });

    await expect(conversationRepository.create(createInput(FOREIGN_OWNER_ID, 'foreign', 'foreign-create-key-0001')))
      .rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND', statusCode: 404 });
    await expect(readOwnerCounts(source, OWNER_ID)).resolves.toEqual({ conversations: '1', messages: '1', idempotencyKeys: '2' });
    await expect(readOwnerCounts(source, FOREIGN_OWNER_ID)).resolves.toEqual({ conversations: '0', messages: '0', idempotencyKeys: '0' });

    await source.query(
      'INSERT INTO "project_removal_jobs" ("owner_id", "project_id", "storage_root_key", "run_ids") VALUES ($1, $2, NULL, $3::jsonb)',
      [OWNER_ID, PROJECT_ID, '[]']
    );
    await expect(conversationRepository.addUserMessage(messageInput(created.resource.id, 'blocked by committed removal', 'conversation-message-key-removal')))
      .rejects.toMatchObject({ code: 'PROJECT_ARCHIVED', statusCode: 409 });
    await expect(readOwnerCounts(source, OWNER_ID)).resolves.toEqual({ conversations: '1', messages: '1', idempotencyKeys: '2' });
    await expect(readReferences(source, OWNER_ID)).resolves.toEqual(referencesBeforeDenial);
    await expect(quotaRepository.readUsage(OWNER_ID)).resolves.toMatchObject({ usedBytes: expectedUsage });
  });

  it('accounts for generated titles, rejects denied growth and foreign owners, and preserves an existing name', async () => {
    const source = requiredDataSource();
    await source.query('DELETE FROM "project_removal_jobs" WHERE "project_id"=$1', [PROJECT_ID]);
    await setStorageLimit(source, OWNER_ID, 10000n);
    const created = await conversationRepository.create(createInput(OWNER_ID, 'New chat', 'generated-title-key-0001'));
    const input = { ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: created.resource.id, title: 'Stacks and Queues Review' };
    const before = await quotaRepository.readUsage(OWNER_ID);
    if (before.usedBytes === null) throw new Error('Expected verified usage.');
    await expect(conversationRepository.setGeneratedTitle({ ...input, ownerId: FOREIGN_OWNER_ID })).rejects.toBeDefined();
    await setStorageLimit(source, OWNER_ID, before.usedBytes);
    await expect(conversationRepository.setGeneratedTitle(input)).rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' });
    const unchanged = await conversationRepository.findWithMessagesForOwner({ ...input, limit: 1 });
    expect(unchanged?.conversation.title).toBe('New chat');
    await setStorageLimit(source, OWNER_ID, 10000n);
    await expect(conversationRepository.setGeneratedTitle(input)).resolves.toBe(true);
    await expect(quotaRepository.readUsage(OWNER_ID)).resolves.toMatchObject({ usedBytes: before.usedBytes + BigInt(Buffer.byteLength(input.title) - Buffer.byteLength('New chat')) });
    await expect(conversationRepository.setGeneratedTitle({ ...input, title: 'Another title' })).resolves.toBe(false);
    const saved = await conversationRepository.findWithMessagesForOwner({ ...input, limit: 1 });
    expect(saved?.conversation.title).toBe(input.title);
  });

  function requiredDataSource(): DataSource {
    if (!dataSource) throw new Error('The isolated conversation quota database was not initialized.');
    return dataSource;
  }
});

async function createIsolatedDatabase(): Promise<void> {
  await withBaseClient(async (baseClient) => {
    const identity = await baseClient.query<{ readonly database: string; readonly user: string; readonly canCreateDatabase: boolean; readonly databaseExists: boolean }>(`SELECT current_database() AS "database", current_user AS "user",
         (SELECT "rolcreatedb" FROM "pg_roles" WHERE "rolname" = current_user) AS "canCreateDatabase",
         EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "databaseExists"`, [DATABASE_NAME]);
    if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
      || identity.rows[0]?.canCreateDatabase !== true) {
      throw new Error('The guarded role cannot create the isolated conversation quota database.');
    }
    if (identity.rows[0]?.databaseExists) throw new Error('The conversation quota database exists; inspect ownership before retrying.');
    await baseClient.query(`CREATE DATABASE "${DATABASE_NAME}" OWNER "home_test"`);
  });
}

async function dropIsolatedDatabase(): Promise<void> {
  await withBaseClient(async (baseClient) => {
    const identity = await baseClient.query<{ readonly database: string; readonly user: string; readonly owner: string | null; readonly exists: boolean }>(`SELECT current_database() AS "database", current_user AS "user",
         (SELECT pg_get_userbyid("datdba") FROM "pg_database" WHERE "datname" = $1) AS "owner",
         EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "exists"`, [DATABASE_NAME]);
    if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
      || identity.rows[0]?.owner !== 'home_test') {
      throw new Error('Refusing to remove the conversation quota database because its guarded identity changed.');
    }
    if (!identity.rows[0]?.exists) return;
    await baseClient.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [DATABASE_NAME]);
    await baseClient.query(`DROP DATABASE "${DATABASE_NAME}"`);
  });
}

async function withBaseClient<T>(operation: (client: PgClient) => Promise<T>): Promise<T> {
  if (!databaseUrl) throw new Error('The guarded conversation quota database URL is required.');
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function seedOwnerAndProject(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    INSERT INTO "users" ("id", "scope_key", "display_name", "password_hash", "identifier", "account_kind", "role", "expires_at")
    VALUES ($1, 'account:conversation-quota-test', 'Conversation quota test', 'fixture-hash', 'conversation-quota-test', 'regular', 'user', NULL),
           ($2, 'account:conversation-quota-foreign-test', 'Conversation quota foreign test', 'fixture-hash', 'conversation-quota-foreign-test', 'regular', 'user', NULL)
  `, [OWNER_ID, FOREIGN_OWNER_ID]);
  await dataSource.query('INSERT INTO "account_limits" ("owner_id", "storage_limit_bytes") VALUES ($1, 10000), ($2, 10000)', [OWNER_ID, FOREIGN_OWNER_ID]);
  await dataSource.query(`
    INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key")
    VALUES ($1, $2, 'Conversation quota project', 'conversation-quota-test', NULL, NULL)
  `, [PROJECT_ID, OWNER_ID]);
}

async function reconcileOwner(
  dataSource: DataSource,
  quotaRepository: TypeOrmStorageQuotaRepository,
  accounting: TypeOrmStorageContentAccounting,
  ownerId: string
): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  try {
    await queryRunner.startTransaction();
    const references = await accounting.scanDatabaseContent(queryRunner, ownerId);
    await queryRunner.commitTransaction();
    await quotaRepository.reconcileReferences(ownerId, references);
  } catch (error: unknown) {
    if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}

async function readOwnerCounts(dataSource: DataSource, ownerId: string): Promise<OwnerCounts> {
  const rows: readonly OwnerCounts[] = await dataSource.query(`
    SELECT
      (SELECT count(*)::text FROM "conversations" WHERE "owner_id" = $1) AS "conversations",
      (SELECT count(*)::text FROM "messages" m JOIN "conversations" c ON c."id" = m."conversation_id" WHERE c."owner_id" = $1) AS "messages",
      (SELECT count(*)::text FROM "conversation_idempotency_keys" WHERE "owner_id" = $1) AS "idempotencyKeys"
  `, [ownerId]);
  if (!rows[0]) throw new Error('The conversation counts query returned no row.');
  return rows[0];
}

async function readFingerprints(dataSource: DataSource, ownerId: string): Promise<readonly {
  readonly id: string;
  readonly operation: string;
  readonly request_fingerprint: string;
  readonly byte_count: string;
  readonly resource_id: string;
}[]> {
  return await dataSource.query(`
    SELECT "id", "operation", "request_fingerprint", octet_length("request_fingerprint")::text AS "byte_count", "resource_id"
    FROM "conversation_idempotency_keys" WHERE "owner_id" = $1 ORDER BY "operation"
  `, [ownerId]);
}

async function readConversationReferences(
  dataSource: DataSource,
  ownerId: string,
  conversationId: string,
  messageId: string,
  createIdempotencyId: string,
  messageIdempotencyId: string
): Promise<readonly ReferenceRow[]> {
  const resourceKeys = [
    `conversation_idempotency_keys:${createIdempotencyId}`,
    `conversation_idempotency_keys:${messageIdempotencyId}`,
    `conversations:${conversationId}`,
    `messages:${messageId}`
  ];
  const references = await readReferences(dataSource, ownerId, resourceKeys);
  return sortReferences(references);
}

async function readReferences(dataSource: DataSource, ownerId: string, resourceKeys?: readonly string[]): Promise<readonly ReferenceRow[]> {
  const filter = resourceKeys ? ' AND "resource_key" = ANY($2::text[])' : '';
  const values = resourceKeys ? [ownerId, resourceKeys] : [ownerId];
  return await dataSource.query(`
    SELECT "resource_key", "copy_key", "byte_count"::text AS "byte_count"
    FROM "storage_resource_references" WHERE "owner_id" = $1 AND "resource_kind" = 'database_content'${filter}
    ORDER BY "resource_key", "copy_key"
  `, values);
}

function sortReferences(references: readonly ReferenceRow[]): readonly ReferenceRow[] {
  return [...references].sort((left, right) => `${left.resource_key}/${left.copy_key}`.localeCompare(`${right.resource_key}/${right.copy_key}`));
}

function createInput(ownerId: string, title: string, idempotencyKey: string): CreateConversationRecord {
  return { ownerId, projectId: PROJECT_ID, title, idempotencyKey, requestFingerprint: title };
}

function messageInput(conversationId: string, content: string, idempotencyKey: string): AddMessageRecord {
  return { ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId, content, idempotencyKey, requestFingerprint: JSON.stringify({ conversationId, content }) };
}

async function setStorageLimit(dataSource: DataSource, ownerId: string, limitBytes: bigint): Promise<void> {
  await dataSource.query('UPDATE "account_limits" SET "storage_limit_bytes" = $2 WHERE "owner_id" = $1', [ownerId, limitBytes.toString()]);
}
