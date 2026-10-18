import type { DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { HomeConsentRollbackBlockedError, HomeTurnNotActiveError } from '@/modules/home-assistant/domain/home-conversation-errors';
import { AddHomeConsentDisclosures1710000024000 } from '@/infrastructure/database/migrations/1710000024000-add-home-consent-disclosures';
import { TypeOrmHomeConversationRepository } from '@/infrastructure/database/repositories/typeorm-home-conversation-repository';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER_ID = '22222222-2222-4222-8222-222222222222';
const databaseUrl = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;
if (databaseUrl) {
  const testDatabaseUrl = new URL(databaseUrl);
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!['postgres:', 'postgresql:'].includes(testDatabaseUrl.protocol)
    || !allowedHosts.has(testDatabaseUrl.hostname)
    || testDatabaseUrl.pathname !== '/home_history_test'
    || testDatabaseUrl.username !== 'home_test') {
    throw new Error('HOME_CONVERSATION_TEST_DATABASE_URL must point to the isolated home_test/home_history_test database on loopback.');
  }
}
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('Home consent persistence PostgreSQL integration', () => {
  const dataSource = createDataSource({ url: databaseUrl ?? 'postgres://disabled:disabled@127.0.0.1:1/disabled' });
  let conversations: TypeOrmHomeConversationRepository;

  beforeAll(async () => {
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
    const migrations: readonly { name: string }[] = await dataSource.query('SELECT "name" FROM "migrations"');
    expect(migrations.map((migration) => migration.name)).toContain('AddHomeConsentDisclosures1710000024000');
    expect(migrations).toHaveLength(dataSource.migrations.length);
    await dataSource.query('DELETE FROM "users" WHERE "id" IN ($1, $2)', [OWNER_ID, OTHER_OWNER_ID]);
    await dataSource.query(
      `INSERT INTO "users" ("id", "scope_key", "identifier", "display_name", "password_hash") VALUES
       ($1, 'consent-test-owner', 'consent-test-owner', 'Consent Test', 'x'), ($2, 'consent-test-other', 'consent-test-other', 'Consent Other', 'x')`,
      [OWNER_ID, OTHER_OWNER_ID]
    );
    conversations = new TypeOrmHomeConversationRepository(dataSource);
  }, 120_000);

  afterAll(async () => {
    if (dataSource.isInitialized) {
      await dataSource.query('DROP TRIGGER IF EXISTS "home_test_reject_consent_event_trigger" ON "home_conversation_events"');
      await dataSource.query('DROP FUNCTION IF EXISTS "home_test_reject_consent_event"()');
      await dataSource.query('DELETE FROM "users" WHERE "id" IN ($1, $2)', [OWNER_ID, OTHER_OWNER_ID]);
      await dataSource.destroy();
    }
  });

  it('commits consent events and safe disclosure metadata with turn state, and replays only for its owner', async () => {
    const conversation = await createConversation('consent-order');
    const turn = await conversations.submitTurn({
      ownerId: OWNER_ID, conversationId: conversation.id, requestKey: 'consent-submit', requestFingerprint: 'consent-submit-fp',
      message: 'Make a plan.', initialStatus: 'pending',
      initialDisclosure: {
        disclosureId: '33333333-3333-4333-8333-333333333333', phase: 'initial',
        provider: { profile: 'nebius-token-factory', name: 'Nebius Token Factory', model: 'test-model' },
        scope: { kind: 'home' }, categories: ['current_message'], itemCount: 1, byteLimit: 262144
      }
    });
    expect(turn.turn.status).toBe('pending');
    expect(turn.execution).toMatchObject({ state: 'consent_required' });
    expect(turn.disclosure?.decision).toBeNull();

    const requested = await conversations.listEventsForOwner({ ownerId: OWNER_ID, conversationId: conversation.id, afterSequence: 0, limit: 10 });
    expect(requested?.events.map((event) => event.type)).toEqual(['conversation.created', 'turn.created', 'message.appended', 'consent.requested']);
    expect(requested?.events[3]?.payload).toEqual({
      phase: 'initial', categories: ['current_message'], providerProfile: 'nebius-token-factory', model: 'test-model',
      scopeKind: 'home', scopeId: null, itemCount: 1, byteLimit: 262144
    });
    expect(JSON.stringify(requested?.events)).not.toContain('Make a plan.');

    const decision = await conversations.decideConsent({
      ownerId: OWNER_ID, conversationId: conversation.id, turnId: turn.turn.id,
      disclosureId: '33333333-3333-4333-8333-333333333333', decision: 'allow'
    });
    expect(decision?.disclosure.deliveryState).toBe('starting');
    const accepted = await conversations.updateConsentDelivery({
      ownerId: OWNER_ID, conversationId: conversation.id, turnId: turn.turn.id,
      disclosureId: '33333333-3333-4333-8333-333333333333', deliveryState: 'accepted'
    });
    expect(accepted?.status).toBe('running');

    const fingerprint = 'a'.repeat(64);
    const dynamic = await conversations.createToolResultDisclosure({
      ownerId: OWNER_ID, conversationId: conversation.id, turnId: turn.turn.id,
      draft: {
        disclosureId: '44444444-4444-4444-8444-444444444444', phase: 'tool_result', runtimeRequestId: 'fixture-read-1', resultFingerprint: fingerprint,
        provider: { profile: 'nebius-token-factory', name: 'Nebius Token Factory', model: 'test-model' },
        scope: { kind: 'home' }, categories: ['task_metadata'], itemCount: 1, byteLimit: 128
      }
    });
    expect(dynamic?.disclosure.resultFingerprint).toBe(fingerprint);
    const rows: readonly { disclosure_id: string; result_fingerprint: string; keys: string[] }[] = await dataSource.query(
      `SELECT "disclosure_id", "result_fingerprint", ARRAY(SELECT jsonb_object_keys(to_jsonb(d))) AS "keys"
       FROM "home_turn_consent_disclosures" d WHERE "disclosure_id" = $1`, [dynamic?.disclosure.disclosureId]
    );
    expect(rows[0]?.keys).not.toContain('data');
    expect(rows[0]?.result_fingerprint).toBe(fingerprint);
    const migration = new AddHomeConsentDisclosures1710000024000();
    const rollbackRunner = dataSource.createQueryRunner();
    await rollbackRunner.connect();
    try {
      await expect(migration.down(rollbackRunner)).rejects.toBeInstanceOf(HomeConsentRollbackBlockedError);
    } finally {
      await rollbackRunner.release();
    }

    const foreign = await conversations.listEventsForOwner({ ownerId: OTHER_OWNER_ID, conversationId: conversation.id, afterSequence: 0, limit: 20 });
    expect(foreign).toBeNull();
    const all = await conversations.listEventsForOwner({ ownerId: OWNER_ID, conversationId: conversation.id, afterSequence: 0, limit: 20 });
    expect(all?.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(all?.events.map((event) => event.type)).toEqual([
      'conversation.created', 'turn.created', 'message.appended', 'consent.requested', 'consent.decided', 'turn.status_changed', 'consent.requested'
    ]);
  });

  it('rolls back the turn, disclosure, and cursor when the consent event cannot be committed', async () => {
    const conversation = await createConversation('consent-rollback');
    await dataSource.query(`
      CREATE FUNCTION "home_test_reject_consent_event"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."event_type" = 'consent.requested' THEN
          RAISE EXCEPTION 'intentional isolated consent rollback check';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await dataSource.query(`CREATE TRIGGER "home_test_reject_consent_event_trigger" BEFORE INSERT ON "home_conversation_events" FOR EACH ROW EXECUTE FUNCTION "home_test_reject_consent_event"()`);
    try {
      await expect(conversations.submitTurn({
        ownerId: OWNER_ID, conversationId: conversation.id, requestKey: 'consent-rollback-submit', requestFingerprint: 'consent-rollback-fp',
        message: 'rollback sentinel', initialStatus: 'pending',
        initialDisclosure: {
          disclosureId: '55555555-5555-4555-8555-555555555555', phase: 'initial',
          provider: { profile: 'nebius-token-factory', name: 'Nebius Token Factory', model: 'test-model' },
          scope: { kind: 'home' }, categories: ['current_message'], itemCount: 1, byteLimit: 262144
        }
      })).rejects.toThrow('intentional isolated consent rollback check');
    } finally {
      await dataSource.query('DROP TRIGGER IF EXISTS "home_test_reject_consent_event_trigger" ON "home_conversation_events"');
      await dataSource.query('DROP FUNCTION IF EXISTS "home_test_reject_consent_event"()');
    }
    const events = await conversations.listEventsForOwner({ ownerId: OWNER_ID, conversationId: conversation.id, afterSequence: 0, limit: 20 });
    const turns = await conversations.listTurnsForOwner({ ownerId: OWNER_ID, conversationId: conversation.id, limit: 20 });
    expect(events?.events.map((event) => event.sequence)).toEqual([1]);
    expect(events?.lastEventSequence).toBe(1);
    expect(turns?.turns).toHaveLength(0);
    const disclosureRows: readonly { count: string }[] = await dataSource.query('SELECT COUNT(*)::text AS "count" FROM "home_turn_consent_disclosures" WHERE "disclosure_id" = $1', ['55555555-5555-4555-8555-555555555555']);
    expect(Number(disclosureRows[0]?.count)).toBe(0);
  });

  it('binds bounded consent metadata to the current message sequence and owner-scoped transcript', async () => {
    const conversation = await createConversation('consent-history-cutoff');
    const prior = await conversations.submitTurn({
      ownerId: OWNER_ID, conversationId: conversation.id, requestKey: 'history-prior-submit', requestFingerprint: 'history-prior-fp',
      message: 'Prior user message.', initialStatus: 'pending'
    });
    await conversations.updateTurnStatus({ ownerId: OWNER_ID, conversationId: conversation.id, turnId: prior.turn.id, status: 'running' });
    await conversations.completeTurnWithAssistant({
      ownerId: OWNER_ID, conversationId: conversation.id, turnId: prior.turn.id, content: 'Prior assistant reply.', status: 'completed'
    });

    const current = await conversations.submitTurn({
      ownerId: OWNER_ID, conversationId: conversation.id, requestKey: 'history-current-submit', requestFingerprint: 'history-current-fp',
      message: 'Continue.', initialStatus: 'pending',
      initialDisclosure: {
        disclosureId: '88888888-8888-4888-8888-888888888888', phase: 'initial',
        provider: { profile: 'nebius-token-factory', name: 'Nebius Token Factory', model: 'test-model' },
        scope: { kind: 'home' }, categories: ['current_message'], itemCount: 1, byteLimit: 262144
      }
    });
    await conversations.submitTurn({
      ownerId: OWNER_ID, conversationId: conversation.id, requestKey: 'history-later-submit', requestFingerprint: 'history-later-fp',
      message: 'Later message.', initialStatus: 'unsupported'
    });

    expect(current.disclosure).toMatchObject({ categories: ['current_message', 'bounded_home_history'], itemCount: 3 });
    const selected = await conversations.listMessagesForOwner({
      ownerId: OWNER_ID, conversationId: conversation.id, beforeSequence: current.message.sequence, limit: 8, transcriptOnly: true
    });
    expect(selected?.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Prior user message.'], ['assistant', 'Prior assistant reply.']
    ]);
    const eventPage = await conversations.listEventsForOwner({ ownerId: OWNER_ID, conversationId: conversation.id, afterSequence: 0, limit: 20 });
    const requested = eventPage?.events.find((event) => event.entityId === '88888888-8888-4888-8888-888888888888');
    expect(requested?.payload).toMatchObject({ categories: ['current_message', 'bounded_home_history'], itemCount: 3, scopeKind: 'home' });
  });

  it('rechecks activity after cancellation wins a queued conversation-lock race', async () => {
    const conversation = await createConversation('consent-cancel-race');
    const submission = await conversations.submitTurn({
      ownerId: OWNER_ID, conversationId: conversation.id, requestKey: 'cancel-race-submit', requestFingerprint: 'cancel-race-fp',
      message: 'Make a plan.', initialStatus: 'pending',
      initialDisclosure: {
        disclosureId: '66666666-6666-4666-8666-666666666666', phase: 'initial',
        provider: { profile: 'nebius-token-factory', name: 'Nebius Token Factory', model: 'test-model' },
        scope: { kind: 'home' }, categories: ['current_message'], itemCount: 1, byteLimit: 262144
      }
    });
    await conversations.decideConsent({ ownerId: OWNER_ID, conversationId: conversation.id, turnId: submission.turn.id, disclosureId: '66666666-6666-4666-8666-666666666666', decision: 'allow' });
    await conversations.updateConsentDelivery({ ownerId: OWNER_ID, conversationId: conversation.id, turnId: submission.turn.id, disclosureId: '66666666-6666-4666-8666-666666666666', deliveryState: 'accepted' });

    const lockHolder = dataSource.createQueryRunner();
    let cancelPromise: ReturnType<typeof conversations.cancelTurn> | undefined;
    let disclosurePromise: ReturnType<typeof conversations.createToolResultDisclosure> | undefined;
    let raceFinished = false;
    await lockHolder.connect();
    await lockHolder.startTransaction();
    try {
      await lockHolder.query('SELECT "id" FROM "home_conversations" WHERE "owner_id" = $1 AND "id" = $2 FOR UPDATE', [OWNER_ID, conversation.id]);
      cancelPromise = conversations.cancelTurn({ ownerId: OWNER_ID, conversationId: conversation.id, turnId: submission.turn.id });
      await waitForConversationLockWaiters(dataSource, 1);
      disclosurePromise = conversations.createToolResultDisclosure({
        ownerId: OWNER_ID, conversationId: conversation.id, turnId: submission.turn.id,
        draft: {
          disclosureId: '77777777-7777-4777-8777-777777777777', phase: 'tool_result', runtimeRequestId: 'fixture-read-after-cancel', resultFingerprint: 'b'.repeat(64),
          provider: { profile: 'nebius-token-factory', name: 'Nebius Token Factory', model: 'test-model' },
          scope: { kind: 'home' }, categories: ['task_metadata'], itemCount: 1, byteLimit: 128
        }
      });
      await waitForConversationLockWaiters(dataSource, 2);
      await lockHolder.commitTransaction();

      expect((await cancelPromise)?.resource.status).toBe('cancel_requested');
      await expect(disclosurePromise).rejects.toBeInstanceOf(HomeTurnNotActiveError);
      raceFinished = true;
      const turn = await conversations.findTurnForOwner(OWNER_ID, conversation.id, submission.turn.id);
      const events = await conversations.listEventsForOwner({ ownerId: OWNER_ID, conversationId: conversation.id, afterSequence: 0, limit: 20 });
      expect(turn?.status).toBe('cancel_requested');
      expect(events?.events.filter((event) => event.type === 'consent.requested')).toHaveLength(1);
      expect(events?.events.at(-1)?.type).toBe('turn.status_changed');
    } finally {
      if (lockHolder.isTransactionActive) await lockHolder.rollbackTransaction();
      await lockHolder.release();
      if (!raceFinished) {
        const pending: Promise<unknown>[] = [];
        if (cancelPromise) pending.push(cancelPromise);
        if (disclosurePromise) pending.push(disclosurePromise);
        await Promise.allSettled(pending);
      }
    }
  });

  async function createConversation(key: string) {
    const result = await conversations.create({ ownerId: OWNER_ID, scope: { kind: 'home' }, title: 'Consent test', requestKey: key, requestFingerprint: `${key}-fp` });
    return result.resource;
  }
});

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
