import { randomUUID } from 'node:crypto';
import type { DataSource, QueryRunner } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmActionLedgerRepository } from '@/infrastructure/database/repositories/typeorm-action-ledger-repository';
import { TypeOrmHomeActionEventRecorder } from '@/infrastructure/database/repositories/typeorm-home-action-event-recorder';
import { TypeOrmHomeConversationRepository } from '@/infrastructure/database/repositories/typeorm-home-conversation-repository';
import type { ActionLedgerExecutionInput } from '@/modules/action-ledger/domain/action-ledger-types';
import { HomeTurnNotActiveError } from '@/modules/home-assistant/domain/home-conversation-errors';

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
    conversations = new TypeOrmHomeConversationRepository(dataSource);
    await dataSource.query(`
      CREATE TABLE "home_event_test_targets" ("id" uuid PRIMARY KEY, "version" integer NOT NULL)
    `);
    await dataSource.query('INSERT INTO "home_event_test_targets" ("id", "version") VALUES ($1, 1)', [TARGET_ID]);
  }, 120_000);

  afterAll(async () => {
    if (dataSource.isInitialized) {
      await dataSource.query('DROP TABLE IF EXISTS "home_event_test_targets"');
      await dataSource.query('DELETE FROM "users" WHERE "id" IN ($1, $2)', [OWNER_ID, OTHER_OWNER_ID]);
      await dataSource.destroy();
    }
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
    const activePlanningWorkspaceId = await createWorkspace(dataSource, OWNER_ID, 'active-planning', null, 'active');
    const fileWorkspaceId = await createWorkspace(dataSource, OWNER_ID, 'file-backed', 'repo/home', 'active');
    const archivedWorkspaceId = await createWorkspace(dataSource, OWNER_ID, 'archived-planning', null, 'archived');
    const foreignWorkspaceId = await createWorkspace(dataSource, OTHER_OWNER_ID, 'foreign-planning', null, 'active');

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
      await lockHolder.query('SELECT "id" FROM "home_conversations" WHERE "owner_id" = $1 AND "id" = $2 FOR UPDATE', [OWNER_ID, cancellableConversation.id]);
      cancellationPromise = conversations.cancelTurn({ ownerId: OWNER_ID, conversationId: cancellableConversation.id, turnId: pending.resource.id });
      await waitForConversationLockWaiters(dataSource, 1);
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
      await waitForConversationLockWaiters(dataSource, 2);
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

async function createWorkspace(dataSource: DataSource, ownerId: string, slug: string, relativeRoot: string | null, status: 'active' | 'archived'): Promise<string> {
  const projectId = randomUUID();
  const fileBacked = relativeRoot !== null;
  const persistedRoot = fileBacked ? `projects/${projectId}` : null;
  const rows: readonly { id: string }[] = await dataSource.query(
    `INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "status", "storage_kind")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING "id"`,
    [projectId, ownerId, slug, slug, persistedRoot, persistedRoot === null ? null : persistedRoot.toLowerCase(), status, fileBacked ? 'managed' : null]
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('The isolated workspace fixture was not created.');
  return id;
}

async function waitForConversationLockWaiters(dataSource: DataSource, minimum: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows: readonly { count: number | string }[] = await dataSource.query(`
      SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
      WHERE "datname" = current_database() AND "usename" = current_user
        AND "wait_event_type" = 'Lock' AND "query" ILIKE '%home_conversations%'
    `);
    if (Number(rows[0]?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${minimum} Home conversation row-lock waiter(s).`);
}
