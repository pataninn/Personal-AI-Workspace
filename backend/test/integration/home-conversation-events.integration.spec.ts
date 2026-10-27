import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DataSource, QueryRunner } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmActionLedgerRepository } from '@/infrastructure/database/repositories/typeorm-action-ledger-repository';
import { TypeOrmHomeActionEventRecorder } from '@/infrastructure/database/repositories/typeorm-home-action-event-recorder';
import { TypeOrmHomeConversationRepository } from '@/infrastructure/database/repositories/typeorm-home-conversation-repository';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmStorageRootMappingRepository } from '@/infrastructure/database/repositories/typeorm-storage-root-mapping-repository';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { StorageQuotaRootScanner, type TrustedStorageRoot } from '@/infrastructure/workspace/storage-quota-reconciliation';
import type { ActionLedgerExecutionInput } from '@/modules/action-ledger/domain/action-ledger-types';
import { HomeTurnNotActiveError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type { StorageResourceReference } from '@/modules/storage-quotas/domain/storage-quota-types';
import type { StorageRootMapping } from '@/modules/storage-quotas/repositories/storage-root-mapping-repository';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';
const databaseUrl = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;
if (databaseUrl) {
  const testDatabaseUrl = new URL(databaseUrl);
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (
    !['postgres:', 'postgresql:'].includes(testDatabaseUrl.protocol) ||
    !allowedHosts.has(testDatabaseUrl.hostname) ||
    testDatabaseUrl.pathname !== '/home_history_test' ||
    testDatabaseUrl.username !== 'home_test'
  ) {
    throw new Error('HOME_CONVERSATION_TEST_DATABASE_URL must point to the isolated home_test/home_history_test database on loopback.');
  }
}
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('Home durable events PostgreSQL integration', () => {
  const dataSource = createDataSource({ url: databaseUrl ?? 'postgres://disabled:disabled@127.0.0.1:1/disabled' });
  let conversations: TypeOrmHomeConversationRepository;
  let workspaceRoot: string;
  let recoveryRoot: string;
  let activePlanningWorkspaceId: string;
  let fileWorkspaceId: string;
  let archivedWorkspaceId: string;
  let foreignWorkspaceId: string;

  beforeAll(async () => {
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
    const migrationRows: readonly { name: string }[] = await dataSource.query('SELECT "name" FROM "migrations"');
    expect(migrationRows.map((migration) => migration.name)).toContain('AddHomeConversationEvents1710000023000');
    const migrationCountRows: readonly { count: string }[] = await dataSource.query('SELECT COUNT(*)::text AS "count" FROM "migrations"');
    expect(Number(migrationCountRows[0]?.count)).toBe(dataSource.migrations.length);
    await dataSource.query('DROP TABLE IF EXISTS "home_event_test_targets"');
    await dataSource.query('DELETE FROM "users" WHERE "id" IN ($1, $2)', [OWNER_ID, OTHER_OWNER_ID]);
    await dataSource.query(
      `INSERT INTO "users" ("id", "scope_key", "identifier", "display_name", "password_hash") VALUES
       ($1, 'home-test-owner', 'home-test-owner', 'Home Test', 'x'), ($2, 'home-test-other', 'home-test-other', 'Home Other', 'x')`,
      [OWNER_ID, OTHER_OWNER_ID]
    );
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pai-home-events-managed-'));
    recoveryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pai-home-events-recovery-'));
    conversations = new TypeOrmHomeConversationRepository(dataSource);
    await dataSource.query(`
      CREATE TABLE "home_event_test_targets" ("id" uuid PRIMARY KEY, "version" integer NOT NULL)
    `);
    await dataSource.query('INSERT INTO "home_event_test_targets" ("id", "version") VALUES ($1, 1)', [TARGET_ID]);
    activePlanningWorkspaceId = await createWorkspace(dataSource, workspaceRoot, OWNER_ID, 'active-planning', null, 'active');
    fileWorkspaceId = await createWorkspace(dataSource, workspaceRoot, OWNER_ID, 'file-backed', 'repo/home', 'active');
    archivedWorkspaceId = await createWorkspace(dataSource, workspaceRoot, OWNER_ID, 'archived-planning', null, 'archived');
    foreignWorkspaceId = await createWorkspace(dataSource, workspaceRoot, OTHER_OWNER_ID, 'foreign-planning', null, 'active');
    await reconcileMappedOwners(dataSource, [OWNER_ID, OTHER_OWNER_ID], workspaceRoot, recoveryRoot);
  }, 120_000);

  afterAll(async () => {
    if (dataSource.isInitialized) {
      await dataSource.query('DROP TABLE IF EXISTS "home_event_test_targets"');
      await removeFixtureRootsAndMappings(dataSource, [OWNER_ID, OTHER_OWNER_ID], workspaceRoot);
      await dataSource.query('DELETE FROM "users" WHERE "id" IN ($1, $2)', [OWNER_ID, OTHER_OWNER_ID]);
      await dataSource.destroy();
    }
    if (workspaceRoot) await fs.rm(workspaceRoot, { recursive: true, force: true });
    if (recoveryRoot) await fs.rm(recoveryRoot, { recursive: true, force: true });
  });

  it('replays committed events in per-conversation sequence and hides foreign owner history', async () => {
    const conversation = await createHomeConversation(conversations, OWNER_ID, 'ordered');
    const [first, second] = await Promise.all([
      conversations.submitTurn({ ownerId: OWNER_ID, conversationId: conversation.id, requestKey: 'ordered-1', requestFingerprint: 'fp-1', message: 'First.', initialStatus: 'unsupported' }),
      conversations.submitTurn({ ownerId: OWNER_ID, conversationId: conversation.id, requestKey: 'ordered-2', requestFingerprint: 'fp-2', message: 'Second.', initialStatus: 'unsupported' })
    ]);
    const replay = await conversations.submitTurn({ ownerId: OWNER_ID, conversationId: conversation.id, requestKey: 'ordered-1', requestFingerprint: 'fp-1', message: 'First.', initialStatus: 'unsupported' });
    expect(replay.replayed).toBe(true);
    expect(replay.turn.id).toBe(first.turn.id);
    expect(replay.message.id).toBe(first.message.id);

    const pageOne = await conversations.listEventsForOwner({ ownerId: OWNER_ID, conversationId: conversation.id, afterSequence: 0, limit: 3 });
    expect(pageOne?.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(pageOne?.events[0]?.type).toBe('conversation.created');
    expect(pageOne?.nextAfterSequence).toBe(3);
    expect(pageOne?.lastEventSequence).toBe(5);
    const pageTwo = await conversations.listEventsForOwner({ ownerId: OWNER_ID, conversationId: conversation.id, afterSequence: pageOne?.nextAfterSequence ?? 0, limit: 10 });
    expect(pageTwo?.events.map((event) => event.sequence)).toEqual([4, 5]);
    const committedEvents = [...(pageOne?.events ?? []), ...(pageTwo?.events ?? [])];
    expect(committedEvents.filter((event) => event.type === 'turn.created')).toHaveLength(2);
    expect(committedEvents.filter((event) => event.type === 'message.appended')).toHaveLength(2);
    expect(await conversations.findForOwner(OTHER_OWNER_ID, conversation.id)).toBeNull();
    expect(await conversations.listEventsForOwner({ ownerId: OTHER_OWNER_ID, conversationId: conversation.id, afterSequence: 0, limit: 10 })).toBeNull();
    expect(first.turn.sequence).not.toBe(second.turn.sequence);
  });

  it('accepts only active owner-owned rootless workspace chat scopes', async () => {
    const created = await conversations.create({
      ownerId: OWNER_ID, scope: { kind: 'workspace', workspaceId: activePlanningWorkspaceId }, title: 'Planning',
      requestKey: 'planning-create', requestFingerprint: 'planning-fingerprint'
    });
    expect(created.resource.scope).toEqual({ kind: 'workspace', workspaceId: activePlanningWorkspaceId });

    for (const workspaceId of [fileWorkspaceId, archivedWorkspaceId, foreignWorkspaceId]) {
      await expect(conversations.create({
        ownerId: OWNER_ID, scope: { kind: 'workspace', workspaceId }, title: 'Blocked',
        requestKey: `blocked-${workspaceId}`, requestFingerprint: 'blocked-fingerprint'
      })).rejects.toThrow('The Home conversation was not found.');
    }
  });

  it('rolls back the event cursor after a failed atomic submit and rolls back target plus receipt after cancellation wins', async () => {
    const rollbackConversation = await createHomeConversation(conversations, OWNER_ID, 'atomic-rollback');
    await dataSource.query(`
      CREATE FUNCTION "home_test_reject_message"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."content" = 'rollback sentinel' THEN
          RAISE EXCEPTION 'intentional isolated Home rollback check';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await dataSource.query(`CREATE TRIGGER "home_test_reject_message_trigger" BEFORE INSERT ON "home_messages" FOR EACH ROW EXECUTE FUNCTION "home_test_reject_message"()`);
    try {
      await expect(conversations.submitTurn({
        ownerId: OWNER_ID, conversationId: rollbackConversation.id, requestKey: 'rollback-submit',
        requestFingerprint: 'rollback-fingerprint', message: 'rollback sentinel', initialStatus: 'unsupported'
      })).rejects.toThrow('intentional isolated Home rollback check');
    } finally {
      await dataSource.query('DROP TRIGGER IF EXISTS "home_test_reject_message_trigger" ON "home_messages"');
      await dataSource.query('DROP FUNCTION IF EXISTS "home_test_reject_message"()');
    }
    const afterRollback = await conversations.listEventsForOwner({ ownerId: OWNER_ID, conversationId: rollbackConversation.id, afterSequence: 0, limit: 10 });
    expect(afterRollback?.events.map((event) => event.sequence)).toEqual([1]);
    expect(afterRollback?.lastEventSequence).toBe(1);
    expect((await conversations.listTurnsForOwner({ ownerId: OWNER_ID, conversationId: rollbackConversation.id, limit: 10 }))?.turns).toHaveLength(0);

    const cancellableConversation = await createHomeConversation(conversations, OWNER_ID, 'cancel-recorder');
    const pending = await conversations.createTurn({ ownerId: OWNER_ID, conversationId: cancellableConversation.id, requestKey: 'action-turn', requestFingerprint: 'action-fingerprint' });
    await conversations.updateTurnStatus({ ownerId: OWNER_ID, conversationId: cancellableConversation.id, turnId: pending.resource.id, status: 'running' });

    const actionLedger = new TypeOrmActionLedgerRepository(dataSource, new TypeOrmHomeActionEventRecorder());
    const input: ActionLedgerExecutionInput = {
      ownerId: OWNER_ID,
      operationKey: 'cancelled-turn-action',
      requestFingerprint: 'a'.repeat(64),
      actorKind: 'assistant',
      turnId: pending.resource.id,
      targetKind: 'task',
      targetId: TARGET_ID,
      actionKind: 'task.update',
      expectedVersion: 1,
      undoOfActionId: null
    };
    const lockHolder = dataSource.createQueryRunner();
    let cancellationPromise: ReturnType<typeof conversations.cancelTurn> | undefined;
    let actionPromise: ReturnType<typeof actionLedger.executeAtomically> | undefined;
    let raceCompleted = false;
    await lockHolder.connect();
    await lockHolder.startTransaction();
    try {
      const lockHolderBackend: readonly { readonly pid: number | string }[] = await lockHolder.query('SELECT pg_backend_pid() AS "pid"');
      const lockHolderPid = Number(lockHolderBackend[0]?.pid);
      if (!Number.isSafeInteger(lockHolderPid) || lockHolderPid < 1) throw new Error('The Home race fixture could not identify its lock-holder backend.');
      await lockHolder.query('SELECT "id" FROM "home_conversations" WHERE "owner_id" = $1 AND "id" = $2 FOR UPDATE', [OWNER_ID, cancellableConversation.id]);
      cancellationPromise = conversations.cancelTurn({ ownerId: OWNER_ID, conversationId: cancellableConversation.id, turnId: pending.resource.id });
      const cancellationBackendPid = await waitForBlockedBackend(dataSource, lockHolderPid, '%home_conversations%');
      actionPromise = actionLedger.executeAtomically(input, async (transaction: QueryRunner) => {
        await transaction.query('UPDATE "home_event_test_targets" SET "version" = 2 WHERE "id" = $1', [TARGET_ID]);
        return {
          preVersion: 1,
          postVersion: 2,
          reversibleFields: {},
          outcome: { targetId: TARGET_ID, targetVersion: 2 },
          undoStatus: 'not_reversible'
        };
      });
      await waitForBlockedBackend(dataSource, cancellationBackendPid, '%account_limits%');
      await lockHolder.commitTransaction();

      const cancellation = await cancellationPromise;
      expect(cancellation?.resource.status).toBe('cancel_requested');
      const sequenceAfterCancellation = (await conversations.findForOwner(OWNER_ID, cancellableConversation.id))?.lastEventSequence;
      await expect(actionPromise).rejects.toBeInstanceOf(HomeTurnNotActiveError);
      raceCompleted = true;

      const targetRows: readonly { version: number }[] = await dataSource.query('SELECT "version" FROM "home_event_test_targets" WHERE "id" = $1', [TARGET_ID]);
      const receiptRows: readonly { count: string }[] = await dataSource.query('SELECT COUNT(*)::text AS "count" FROM "action_ledger_records" WHERE "operation_key" = $1', [input.operationKey]);
      const afterAction = await conversations.findForOwner(OWNER_ID, cancellableConversation.id);
      expect(targetRows[0]?.version).toBe(1);
      expect(Number(receiptRows[0]?.count)).toBe(0);
      expect(afterAction?.lastEventSequence).toBe(sequenceAfterCancellation);
    } finally {
      if (lockHolder.isTransactionActive) await lockHolder.rollbackTransaction();
      await lockHolder.release();
      if (!raceCompleted) {
        const outstanding: Promise<unknown>[] = [];
        if (cancellationPromise) outstanding.push(cancellationPromise);
        if (actionPromise) outstanding.push(actionPromise);
        await Promise.allSettled(outstanding);
      }
    }

  });
});

async function createHomeConversation(repository: TypeOrmHomeConversationRepository, ownerId: string, key: string) {
  return repository.create({ ownerId, scope: { kind: 'home' }, title: 'Home', requestKey: key, requestFingerprint: `${key}-fingerprint` }).then((result) => result.resource);
}

async function createWorkspace(
  dataSource: DataSource,
  workspaceRoot: string,
  ownerId: string,
  slug: string,
  relativeRoot: string | null,
  status: 'active' | 'archived'
): Promise<string> {
  const projectId = randomUUID();
  const fileBacked = relativeRoot !== null;
  const persistedRoot = fileBacked ? `projects/${projectId}` : null;
  const rootKey = persistedRoot?.toLowerCase() ?? null;
  if (persistedRoot && rootKey) await fs.mkdir(path.join(workspaceRoot, ownerId, ...persistedRoot.split('/')), { recursive: true });
  const rows: readonly { id: string }[] = await dataSource.query(
    `INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "status", "storage_kind")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING "id"`,
    [projectId, ownerId, slug, slug, persistedRoot, rootKey, status, fileBacked ? 'managed' : null]
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('The isolated workspace fixture was not created.');
  if (rootKey && persistedRoot) {
    await dataSource.query(
      `INSERT INTO "storage_root_mappings" ("owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state")
       VALUES ($1, $2, $2, $3, 'managed', $4, 'active')`,
      [ownerId, id, rootKey, persistedRoot]
    );
  }
  return id;
}

async function waitForBlockedBackend(dataSource: DataSource, blockerPid: number, queryPattern: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows: readonly { readonly pid: number | string }[] = await dataSource.query(`
      SELECT "pid"::text AS "pid" FROM pg_stat_activity
      WHERE "pid" <> pg_backend_pid() AND "datname" = current_database()
        AND "wait_event_type" = 'Lock' AND $1::int = ANY(pg_blocking_pids("pid"))
        AND "query" ILIKE $2
      ORDER BY "pid" LIMIT 2
    `, [blockerPid, queryPattern]);
    if (rows.length === 1) {
      const blockedPid = Number(rows[0]?.pid);
      if (Number.isSafeInteger(blockedPid) && blockedPid > 0) return blockedPid;
    }
    if (rows.length > 1) throw new Error('More than one backend matched the expected Home race lock edge.');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for the expected Home race lock edge on ${queryPattern}.`);
}

async function reconcileMappedOwners(
  dataSource: DataSource,
  ownerIds: readonly string[],
  workspaceRoot: string,
  recoveryRoot: string
): Promise<void> {
  const quota = new TypeOrmStorageQuotaRepository(dataSource);
  const accounting = new TypeOrmStorageContentAccounting(dataSource, quota);
  const mappings = new TypeOrmStorageRootMappingRepository(dataSource);
  const scanner = new StorageQuotaRootScanner();
  for (const ownerId of ownerIds) {
    const ownerMappings = await mappings.listMappings(ownerId);
    const databaseReferences = await scanDatabaseOwner(dataSource, accounting, ownerId);
    const fileReferences = await scanner.scan([
      ...await resolveFixtureRoots(dataSource, ownerId, ownerMappings, workspaceRoot),
      emptyRecoveryRoot(ownerId, recoveryRoot)
    ]);
    await quota.reconcileReferences(ownerId, [...databaseReferences, ...fileReferences]);
  }
}

async function resolveFixtureRoots(
  dataSource: DataSource,
  ownerId: string,
  mappings: readonly StorageRootMapping[],
  workspaceRoot: string
): Promise<readonly TrustedStorageRoot[]> {
  const projects: readonly { id: string; relative_root: string; relative_root_key: string; storage_kind: 'legacy' | 'managed' | null }[] = await dataSource.query(
    'SELECT "id", "relative_root", "relative_root_key", "storage_kind" FROM "projects" WHERE "owner_id" = $1 AND "relative_root" IS NOT NULL',
    [ownerId]
  );
  if (projects.length !== mappings.length) throw new Error('Every rooted Home fixture must have an active root mapping.');
  return mappings.map((mapping) => {
    const project = projects.find((row) => row.id === mapping.projectId);
    if (!project || mapping.ownerId !== ownerId || mapping.state !== 'active' || mapping.storageKind !== 'managed'
      || mapping.relativeRoot !== project.relative_root || mapping.rootKey !== project.relative_root_key
      || mapping.storageKind !== project.storage_kind) {
      throw new Error('A Home fixture root mapping does not match its project row.');
    }
    return {
      ownerId,
      projectId: mapping.projectId,
      rootKey: mapping.rootKey,
      absolutePath: path.join(workspaceRoot, ownerId, ...mapping.relativeRoot.split('/')),
      classifyFile: () => 'project_file'
    };
  });
}

function emptyRecoveryRoot(ownerId: string, recoveryRoot: string): TrustedStorageRoot {
  return {
    ownerId,
    projectId: null,
    rootKey: 'recovery-v1',
    absolutePath: recoveryRoot,
    classifyFile: () => 'recovery_file',
    referenceForFile: () => null
  };
}

async function scanDatabaseOwner(
  dataSource: DataSource,
  accounting: TypeOrmStorageContentAccounting,
  ownerId: string
): Promise<readonly StorageResourceReference[]> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    const references = await accounting.scanDatabaseContent(runner, ownerId);
    await runner.commitTransaction();
    return references;
  } catch (error: unknown) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

async function removeFixtureRootsAndMappings(
  dataSource: DataSource,
  ownerIds: readonly string[],
  workspaceRoot: string
): Promise<void> {
  await removeDirectoryAndVerify(workspaceRoot);
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    await assertNoFixtureReservations(runner, ownerIds);
    await runner.query('DELETE FROM "storage_resource_references" WHERE "owner_id" = ANY($1::uuid[])', [ownerIds]);
    await runner.query(
      `UPDATE "storage_root_mappings" SET "project_id" = NULL, "state" = 'retained'
       WHERE "owner_id" = ANY($1::uuid[]) AND "state" = 'active'`, [ownerIds]
    );
    await deleteVerifiedFixtureMappings(runner, ownerIds);
    await runner.commitTransaction();
  } catch (error: unknown) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

async function assertNoFixtureReservations(runner: QueryRunner, ownerIds: readonly string[]): Promise<void> {
  const rows: readonly { count: string }[] = await runner.query(
    'SELECT COUNT(*)::text AS "count" FROM "storage_filesystem_reservations" WHERE "owner_id" = ANY($1::uuid[])',
    [ownerIds]
  );
  if (Number(rows[0]?.count ?? '0') > 0) throw new Error('Home fixture roots still have quota reservations at cleanup.');
}

async function deleteVerifiedFixtureMappings(runner: QueryRunner, ownerIds: readonly string[]): Promise<void> {
  const mappings: readonly { owner_id: string; root_key: string }[] = await runner.query(
    'SELECT "owner_id", "root_key" FROM "storage_root_mappings" WHERE "owner_id" = ANY($1::uuid[]) ORDER BY "owner_id", "root_key"',
    [ownerIds]
  );
  for (const mapping of mappings) {
    await runner.query("SELECT set_config('app.storage_root_removal_verified', $1, true)", [`${mapping.owner_id}:${mapping.root_key}`]);
    await runner.query('DELETE FROM "storage_root_mappings" WHERE "owner_id" = $1 AND "root_key" = $2', [mapping.owner_id, mapping.root_key]);
  }
}

async function removeDirectoryAndVerify(directory: string): Promise<void> {
  if (!directory) return;
  await fs.rm(directory, { recursive: true, force: true });
  try {
    await fs.lstat(directory);
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) return;
    throw error;
  }
  throw new Error('A Home fixture root remained after its verified cleanup.');
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
