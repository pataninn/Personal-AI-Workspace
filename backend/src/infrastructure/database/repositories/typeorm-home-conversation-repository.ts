import { DEFAULT_CONVERSATION_TITLE, validGeneratedTitle } from '@/modules/conversations/domain/generated-conversation-title';
import { createHash } from 'node:crypto';
import type { DataSource, QueryRunner } from 'typeorm';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { homeConversationContentScope } from '@/infrastructure/database/storage-content-projections';

import {
  HomeConversationNotFoundError,
  HomeConversationEventInvalidError,
  HomeConsentDecisionStaleError,
  HomeConversationInputInvalidError,
  HomeEventCursorInvalidError,
  HomeTurnNotFoundError,
  HomeTurnNotActiveError,
  HomeTurnNotCancellableError,
  HomeTurnTransitionInvalidError
} from '@/modules/home-assistant/domain/home-conversation-errors';
import type {
  HomeConsentDecisionResult,
  HomeConsentDisclosureResult,
  HomeConsentDisclosureRecord,
  HomeConsentDisclosureDraft,
  HomeTurnExecution,
  HomeConversation,
  HomeConversationEventPage,
  HomeConversationPage,
  HomeMessage,
  HomeMessagePage,
  HomeTurn,
  HomeTurnPage,
  HomeTurnSubmission,
  PersistedHomeResource
} from '@/modules/home-assistant/domain/home-conversation-types';
import { canTransitionHomeTurn } from '@/modules/home-assistant/domain/home-conversation-types';
import type {
  AppendHomeMessageInput,
  CompleteHomeTurnWithAssistantInput,
  CancelHomeTurnInput,
  DecideHomeConsentInput,
  CreateHomeConversationInput,
  CreateHomeTurnInput,
  CreateHomeToolResultDisclosureInput,
  IHomeConversationRepository,
  ListHomeEventsInput,
  ListHomeConversationsInput,
  ListHomeMessagesInput,
  ListHomeTurnsInput,
  SubmitHomeTurnInput,
  HomeAutomationFence,
  UpdateHomeConsentDeliveryInput,
  UpdateHomeToolResultDeliveryInput,
  UpdateHomeTurnStatusInput
} from '@/modules/home-assistant/repositories/home-conversation-repository';
import {
  assertRequestFingerprint,
  assertScheduledWorkspaceOwned,
  assertWorkspaceOwned,
  lockConversation,
  lockIntent,
  withTransaction
} from '@/infrastructure/database/repositories/home-conversation-repository-helpers';
import {
  decodeHomeConversationCursor,
  encodeHomeConversationCursor,
  toHomeConversation,
  toHomeConversationEvent,
  toHomeMessage,
  toHomeTurn,
  type HomeConversationListRow,
  type HomeConversationEventRow,
  type HomeConversationRow,
  type HomeMessageRow,
  type HomeTurnRow
} from '@/infrastructure/database/repositories/home-conversation-persistence-mappers';
import { appendHomeConversationEvent } from '@/infrastructure/database/repositories/home-conversation-event-persistence';
import { toHomeConsentDisclosure, type HomeConsentDisclosureRow } from '@/infrastructure/database/repositories/home-consent-persistence-mappers';
import { buildHomePlanningContext, HOME_PLANNING_CONTEXT_LIMITS } from '@/modules/home-assistant/domain/home-planning-context';

interface KeyedRow {
  readonly request_fingerprint: string;
}

interface SequenceRow {
  readonly sequence: number | string;
}

interface InterruptedHomeTurnRow {
  readonly id: string;
  readonly owner_id: string;
  readonly conversation_id: string;
}

interface HomeConversationEventPageRow {
  readonly last_event_sequence: number | string;
  readonly sequence: number | string | null;
  readonly event_type: string | null;
  readonly turn_id: string | null;
  readonly entity_id: string | null;
  readonly payload: unknown;
  readonly created_at: Date | string | null;
}

function hasEventRow(row: HomeConversationEventPageRow): row is HomeConversationEventPageRow & HomeConversationEventRow {
  return row.sequence !== null && row.event_type !== null && row.created_at !== null;
}

interface HomeMessageKeyedRow extends HomeMessageRow, KeyedRow {}

interface HomePlanningHistoryRow {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** Normalizes TypeORM PostgreSQL UPDATE RETURNING rows and lightweight test adapters. */
function returnedRows<T>(result: unknown): readonly T[] {
  if (!Array.isArray(result)) return [];
  const rows = Array.isArray(result[0]) ? result[0] : result;
  return rows as readonly T[];
}

const CONSENT_DISCLOSURE_COLUMNS = `"disclosure_id", "owner_id", "conversation_id", "turn_id", "phase", "provider_profile", "provider_name", "model",
  "scope_kind", "scope_id", "categories", "item_count", "byte_limit", "runtime_request_id", "result_fingerprint", "decision", "delivery_state", "created_at", "updated_at"`;

function consentEventPayload(disclosure: HomeConsentDisclosureRecord): Readonly<Record<string, string | number | boolean | null | readonly string[]>> {
  return {
    phase: disclosure.phase,
    categories: disclosure.categories,
    providerProfile: disclosure.providerProfile,
    model: disclosure.model,
    scopeKind: disclosure.scope.kind,
    scopeId: disclosure.scope.kind === 'workspace' ? disclosure.scope.workspaceId : null,
    itemCount: disclosure.itemCount,
    byteLimit: disclosure.byteLimit
  };
}

function assertToolResultScope(conversation: HomeConversationRow, draft: { readonly scope: HomeConversation['scope'] }): void {
  if (draft.scope.kind !== conversation.scope
    || (draft.scope.kind === 'workspace' && draft.scope.workspaceId !== conversation.workspace_id)) {
    throw new HomeConsentDecisionStaleError();
  }
}

function executionForSubmission(turn: HomeTurn, disclosure: HomeConsentDisclosureRecord): HomeTurnExecution {
  if (turn.status === 'pending' && disclosure.deliveryState === 'awaiting_decision') {
    return {
      state: 'consent_required',
      disclosure: {
        disclosureId: disclosure.disclosureId,
        phase: disclosure.phase,
        provider: { profile: disclosure.providerProfile, name: disclosure.providerName, model: disclosure.model },
        scope: disclosure.scope,
        categories: disclosure.categories,
        itemCount: disclosure.itemCount,
        byteLimit: disclosure.byteLimit
      }
    };
  }
  if (turn.status === 'running') return { state: 'running' };
  return executionForStatus(turn.status);
}

function executionForStatus(status: HomeTurn['status']): HomeTurnExecution {
  if (status === 'running') return { state: 'running' };
  if (status === 'cancelled' || status === 'cancel_requested') return { state: 'cancelled' };
  if (status === 'unsupported') return { state: 'unsupported', code: 'PLANNING_RUNTIME_UNAVAILABLE' };
  if (status === 'unknown') return { state: 'unknown', code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' };
  return { state: 'unknown', code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' };
}

function consentDeliveryTurnStatus(current: HomeTurn['status'], delivery: UpdateHomeConsentDeliveryInput['deliveryState']): HomeTurn['status'] | null {
  if (delivery === 'accepted') return current === 'pending' ? 'running' : null;
  if (delivery === 'unavailable') {
    if (current === 'pending') return 'unsupported';
    if (current === 'cancel_requested') return 'cancelled';
  }
  if (delivery === 'unknown' && (current === 'pending' || current === 'cancel_requested')) return 'unknown';
  return null;
}

async function boundedInitialDisclosureDraft(
  queryRunner: QueryRunner,
  ownerId: string,
  conversationId: string,
  currentMessageSequence: number,
  currentMessage: string,
  draft: HomeConsentDisclosureDraft
): Promise<HomeConsentDisclosureDraft> {
  const rows: readonly HomePlanningHistoryRow[] = await queryRunner.query(
    `SELECT "role", "content" FROM "home_messages"
     WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "sequence" < $3
       AND "role" IN ('user', 'assistant')
     ORDER BY "sequence" DESC LIMIT $4`,
    [ownerId, conversationId, currentMessageSequence, HOME_PLANNING_CONTEXT_LIMITS.priorMessages]
  );
  const context = buildHomePlanningContext({ currentMessage, priorMessages: [...rows].reverse() });
  return { ...draft, categories: context.categories, itemCount: context.itemCount };
}

async function lockAutomationDispatch(queryRunner: QueryRunner, input: SubmitHomeTurnInput): Promise<void> {
  const fence = input.automationFence;
  if (!fence) return;
  if (!input.skillInvocationId) throw new HomeConversationEventInvalidError();
  const refs: readonly { readonly owner_id: string; readonly schedule_id: string; readonly kind: string; readonly schedule_revision: number }[] = await queryRunner.query(`
    SELECT "owner_id","schedule_id","kind","schedule_revision" FROM "automation_occurrences"
    WHERE "id"=$1 AND "owner_id"=$2 AND "conversation_id"=$3 AND "status"='dispatching'
      AND "home_turn_id" IS NULL AND "lease_token"=$4 AND "claim_generation"=$5 AND "lease_expires_at">clock_timestamp()
  `, [fence.occurrenceId, input.ownerId, input.conversationId, fence.leaseToken, fence.generation]);
  const ref = refs[0];
  if (!ref) throw new HomeConversationEventInvalidError();
  const owners: readonly { readonly id: string }[] = await queryRunner.query(`
    SELECT "id" FROM "users" WHERE "id"=$1 AND "is_active"=true
      AND ("expires_at" IS NULL OR "expires_at">clock_timestamp()) FOR UPDATE
  `, [input.ownerId]);
  if (!owners[0]) throw new HomeConversationEventInvalidError();
  const cleanup: readonly { readonly id: string }[] = await queryRunner.query(`
    SELECT dc."admission_id" AS "id" FROM "demo_expiry_cleanups" dc
    JOIN "demo_admissions" da ON da."id"=dc."admission_id" WHERE da."owner_id"=$1 LIMIT 1
  `, [input.ownerId]);
  if (cleanup[0]) throw new HomeConversationEventInvalidError();
  const schedules: readonly { readonly id: string; readonly workspace_id: string; readonly skill_id: string;
    readonly skill_revision_id: string; readonly skill_version: number; readonly revision: number; readonly enabled: boolean }[] = await queryRunner.query(`
    SELECT "id","workspace_id","skill_id","skill_revision_id","skill_version","revision","enabled"
    FROM "automation_schedules" WHERE "owner_id"=$1 AND "id"=$2 AND "conversation_id"=$3 FOR UPDATE
  `, [input.ownerId, ref.schedule_id, input.conversationId]);
  const schedule = schedules[0];
  if (!schedule || Number(schedule.revision) !== Number(ref.schedule_revision)
    || ref.kind !== 'manual' && !schedule.enabled) throw new HomeConversationEventInvalidError();
  const occurrences: readonly { readonly id: string }[] = await queryRunner.query(`
    SELECT "id" FROM "automation_occurrences" WHERE "id"=$1 AND "owner_id"=$2 AND "schedule_id"=$3
      AND "schedule_revision"=$4 AND "status"='dispatching' AND "lease_token"=$5 AND "claim_generation"=$6
      AND "lease_expires_at">clock_timestamp() FOR UPDATE
  `, [fence.occurrenceId, input.ownerId, ref.schedule_id, ref.schedule_revision, fence.leaseToken, fence.generation]);
  if (!occurrences[0]) throw new HomeConversationEventInvalidError();
  const workspaces: readonly { readonly id: string }[] = await queryRunner.query(`
    SELECT p."id" FROM "projects" p WHERE p."owner_id"=$1 AND p."id"=$2 AND p."status"='active'
      AND NOT EXISTS(SELECT 1 FROM "project_removal_jobs" j WHERE j."project_id"=p."id")
  `, [input.ownerId, schedule.workspace_id]);
  if (!workspaces[0]) throw new HomeConversationEventInvalidError();
  const skills: readonly { readonly id: string }[] = await queryRunner.query(`
    SELECT s."id" FROM "skills" s JOIN "skill_revisions" r ON r."owner_id"=s."owner_id" AND r."skill_id"=s."id"
      AND r."version"=s."current_version"
    WHERE s."owner_id"=$1 AND s."id"=$2 AND s."deleted_at" IS NULL
      AND (s."workspace_id" IS NULL OR s."workspace_id"=$3) AND r."id"=$4 AND r."enabled"=true
      AND r."version"=$5 AND jsonb_typeof(r."declared_tools")='array'
      AND r."declared_tools" <@ '["home_task_read","home_workspace_read"]'::jsonb
  `, [input.ownerId, schedule.skill_id, schedule.workspace_id, schedule.skill_revision_id, schedule.skill_version]);
  if (!skills[0]) throw new HomeConversationEventInvalidError();
  const invocations: readonly { readonly id: string }[] = await queryRunner.query(`
    SELECT "id" FROM "skill_invocations" WHERE "owner_id"=$1 AND "conversation_id"=$2 AND "id"=$3
      AND "skill_id"=$4 AND "skill_revision_id"=$5 AND "skill_version"=$6 AND "state"='claimed' FOR UPDATE
  `, [input.ownerId, input.conversationId, input.skillInvocationId, schedule.skill_id, schedule.skill_revision_id, schedule.skill_version]);
  if (!invocations[0]) throw new HomeConversationEventInvalidError();
}

async function lockAutomationCompletion(queryRunner: QueryRunner, input: CompleteHomeTurnWithAssistantInput): Promise<boolean> {
  const fence = input.automationFence;
  if (!fence) return true;
  const turns: readonly { readonly automation_occurrence_id: string | null; readonly skill_invocation_id: string | null;
    readonly status: string; readonly home_policy_revision: string | null; readonly workspace_policy_revision: string | null }[] = await queryRunner.query(`
    SELECT "automation_occurrence_id","skill_invocation_id","status","home_policy_revision","workspace_policy_revision"
    FROM "home_turns" WHERE "owner_id"=$1 AND "conversation_id"=$2 AND "id"=$3
  `, [input.ownerId, input.conversationId, input.turnId]);
  const turn = turns[0];
  if (!turn || turn.automation_occurrence_id !== fence.occurrenceId || !turn.skill_invocation_id
    || turn.status !== 'running' && turn.status !== 'unknown') return false;
  const refs: readonly { readonly schedule_id: string; readonly schedule_revision: number; readonly kind: string }[] = await queryRunner.query(`
    SELECT "schedule_id","schedule_revision","kind" FROM "automation_occurrences"
    WHERE "id"=$1 AND "owner_id"=$2 AND "conversation_id"=$3 AND "home_turn_id"=$4
      AND "lease_token"=$5 AND "claim_generation"=$6 AND "lease_expires_at">clock_timestamp()
  `, [fence.occurrenceId, input.ownerId, input.conversationId, input.turnId, fence.leaseToken, fence.generation]);
  const ref = refs[0];
  if (!ref) return false;
  const owners: readonly { readonly id: string }[] = await queryRunner.query(`
    SELECT "id" FROM "users" WHERE "id"=$1 AND "is_active"=true
      AND ("expires_at" IS NULL OR "expires_at">clock_timestamp()) FOR UPDATE
  `, [input.ownerId]);
  if (!owners[0]) return false;
  const cleanups: readonly { readonly id: string }[] = await queryRunner.query(`
    SELECT dc."admission_id" AS "id" FROM "demo_expiry_cleanups" dc
    JOIN "demo_admissions" da ON da."id"=dc."admission_id" WHERE da."owner_id"=$1 LIMIT 1
  `, [input.ownerId]);
  if (cleanups[0]) return false;
  const schedules: readonly { readonly id: string; readonly workspace_id: string; readonly skill_id: string;
    readonly skill_revision_id: string; readonly skill_version: number; readonly revision: number; readonly enabled: boolean }[] = await queryRunner.query(`
    SELECT "id","workspace_id","skill_id","skill_revision_id","skill_version","revision","enabled"
    FROM "automation_schedules" WHERE "owner_id"=$1 AND "id"=$2 AND "conversation_id"=$3 FOR UPDATE
  `, [input.ownerId, ref.schedule_id, input.conversationId]);
  const schedule = schedules[0];
  if (!schedule || Number(schedule.revision) !== Number(ref.schedule_revision)
    || ref.kind !== 'manual' && !schedule.enabled) return false;
  const occurrences: readonly { readonly id: string }[] = await queryRunner.query(`
    SELECT "id" FROM "automation_occurrences" WHERE "id"=$1 AND "owner_id"=$2 AND "schedule_id"=$3
      AND "schedule_revision"=$4 AND "home_turn_id"=$5 AND "lease_token"=$6 AND "claim_generation"=$7
      AND "lease_expires_at">clock_timestamp() FOR UPDATE
  `, [fence.occurrenceId, input.ownerId, ref.schedule_id, ref.schedule_revision, input.turnId, fence.leaseToken, fence.generation]);
  if (!occurrences[0]) return false;
  const workspaces: readonly { readonly id: string }[] = await queryRunner.query(`
    SELECT p."id" FROM "projects" p WHERE p."owner_id"=$1 AND p."id"=$2 AND p."status"='active'
      AND NOT EXISTS(SELECT 1 FROM "project_removal_jobs" j WHERE j."project_id"=p."id")
  `, [input.ownerId, schedule.workspace_id]);
  if (!workspaces[0]) return false;
  const skills: readonly { readonly id: string }[] = await queryRunner.query(`
    SELECT s."id" FROM "skills" s JOIN "skill_revisions" r ON r."owner_id"=s."owner_id" AND r."skill_id"=s."id"
      AND r."version"=s."current_version"
    WHERE s."owner_id"=$1 AND s."id"=$2 AND s."deleted_at" IS NULL
      AND (s."workspace_id" IS NULL OR s."workspace_id"=$3) AND r."id"=$4 AND r."enabled"=true
      AND r."version"=$5 AND jsonb_typeof(r."declared_tools")='array'
      AND r."declared_tools" <@ '["home_task_read","home_workspace_read"]'::jsonb
  `, [input.ownerId, schedule.skill_id, schedule.workspace_id, schedule.skill_revision_id, schedule.skill_version]);
  if (!skills[0]) return false;
  const currentPolicy: readonly { readonly id: string }[] = await queryRunner.query(`
    SELECT "id" FROM "assistant_scope_policies" WHERE "owner_id"=$1 AND "scope_kind"='home'
      AND "enabled"=true AND "revoked_at" IS NULL AND "revision"=$2 FOR SHARE
  `, [input.ownerId, turn.home_policy_revision]);
  if (!currentPolicy[0]) return false;
  const workspacePolicy: readonly { readonly id: string }[] = await queryRunner.query(`
    SELECT "id" FROM "assistant_scope_policies" WHERE "owner_id"=$1 AND "scope_kind"='project'
      AND "project_id"=$2 AND "enabled"=true AND "revoked_at" IS NULL AND "revision"=$3 FOR SHARE
  `, [input.ownerId, schedule.workspace_id, turn.workspace_policy_revision]);
  if (!workspacePolicy[0]) return false;
  const bindings: readonly { readonly id: string }[] = await queryRunner.query(`
    SELECT i."id" FROM "skill_invocations" i WHERE i."owner_id"=$1 AND i."conversation_id"=$2 AND i."id"=$3
      AND i."skill_id"=$4 AND i."skill_revision_id"=$5 AND i."skill_version"=$6
      AND i."state" IN ('bound','dispatching','accepted','unknown')
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(i."context_revisions") c
        WHERE (c->>'kind'='home_message' AND NOT EXISTS (
          SELECT 1 FROM "home_messages" m WHERE m."owner_id"=$1 AND m."conversation_id"=$2
            AND m."id"=(c->>'id')::uuid AND m."sequence"=(c->>'revision')::integer
        )) OR (c->>'kind'='project_fact' AND NOT EXISTS (
          SELECT 1 FROM "project_facts" f WHERE f."owner_id"=$1 AND f."project_id"=$7
            AND f."id"=(c->>'id')::uuid AND f."version"=(c->>'revision')::integer AND f."deleted_at" IS NULL
        ))
      ) FOR SHARE
  `, [input.ownerId, input.conversationId, turn.skill_invocation_id, schedule.skill_id,
    schedule.skill_revision_id, schedule.skill_version, schedule.workspace_id]);
  return bindings.length === 1;
}

/** TypeORM adapter for durable Home conversations, turns, and messages. */
export class TypeOrmHomeConversationRepository implements IHomeConversationRepository {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly storageAccounting = new TypeOrmStorageContentAccounting(dataSource)
  ) {}

  private withAccountedTransaction<T>(ownerId: string, action: (queryRunner: QueryRunner) => Promise<T>, scope: import('@/infrastructure/database/storage-content-projections').StorageContentMutationScope<T>): Promise<T> {
    return withTransaction(this.dataSource, (queryRunner) => this.storageAccounting.runMutation(queryRunner, ownerId, () => action(queryRunner), scope));
  }

  public async setGeneratedTitle(input: { readonly ownerId: string; readonly conversationId: string; readonly title: string }): Promise<boolean> {
    const title = validGeneratedTitle(input.title);
    if (!title) return false;
    return this.withAccountedTransaction(input.ownerId, async (runner) => {
      await lockConversation(runner, input.ownerId, input.conversationId);
      const rows: readonly { id: string }[] = await runner.query(`WITH changed AS (UPDATE "home_conversations" SET "title"=$3,"updated_at"=clock_timestamp() WHERE "owner_id"=$1 AND "id"=$2 AND "title"=$4 RETURNING "id") SELECT "id" FROM changed`, [input.ownerId, input.conversationId, title, DEFAULT_CONVERSATION_TITLE]);
      return rows.length === 1;
    }, homeConversationContentScope({ ownerId: input.ownerId, conversationId: input.conversationId }));
  }

  /** Lists conversations in one owner scope using stable activity pagination. */
  public async listForOwner(input: ListHomeConversationsInput): Promise<HomeConversationPage> {
    const parameters: unknown[] = [input.ownerId, input.scope.kind];
    let scopeFilter = ' AND "workspace_id" IS NULL';
    if (input.scope.kind === 'workspace') {
      parameters.push(input.scope.workspaceId);
      scopeFilter = ` AND "workspace_id" = $${parameters.length}`;
    }
    let cursorFilter = '';
    if (input.cursor !== undefined) {
      const cursor = decodeHomeConversationCursor(input.cursor);
      parameters.push(cursor.lastActivityAt, cursor.id);
      cursorFilter = ` AND ("last_activity_at" < $${parameters.length - 1} OR ("last_activity_at" = $${parameters.length - 1} AND "id" > $${parameters.length}))`;
    }
    parameters.push(input.limit + 1);
    const rows: readonly HomeConversationListRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "scope", "workspace_id", "title", "last_activity_at",
              "last_event_sequence",
              to_char("last_activity_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursor_activity_at",
              "created_at", "updated_at"
       FROM "home_conversations" WHERE "owner_id" = $1 AND "scope" = $2${scopeFilter}${cursorFilter}
       ORDER BY "last_activity_at" DESC, "id" ASC LIMIT $${parameters.length}`,
      parameters
    );
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const lastPageRow = pageRows[pageRows.length - 1];
    return {
      conversations: pageRows.map(toHomeConversation),
      nextCursor: hasMore && lastPageRow ? encodeHomeConversationCursor(lastPageRow.cursor_activity_at, lastPageRow.id) : null
    };
  }

  /** Finds a conversation only when it belongs to the supplied owner. */
  public async findForOwner(ownerId: string, conversationId: string): Promise<HomeConversation | null> {
    const rows: readonly HomeConversationRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "scope", "workspace_id", "title", "last_event_sequence", "last_activity_at", "created_at", "updated_at"
       FROM "home_conversations" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1`,
      [ownerId, conversationId]
    );
    return rows[0] ? toHomeConversation(rows[0]) : null;
  }

  /** Creates an owner-scoped conversation or replays the matching request. */
  public async create(input: CreateHomeConversationInput): Promise<PersistedHomeResource<HomeConversation>> {
    return this.createConversation(input, false);
  }

  /** Creates the scheduler-owned conversation for an active, owned workspace. */
  public async createForAutomation(input: CreateHomeConversationInput): Promise<PersistedHomeResource<HomeConversation>> {
    return this.createConversation(input, true);
  }

  private async createConversation(input: CreateHomeConversationInput, forAutomation: boolean): Promise<PersistedHomeResource<HomeConversation>> {
    return this.withAccountedTransaction(input.ownerId, async (queryRunner) => {
      const workspaceId = input.scope.kind === 'workspace' ? input.scope.workspaceId : null;
      await lockIntent(queryRunner, JSON.stringify(['conversation', input.ownerId, input.scope.kind, workspaceId, input.requestKey]));
      const existing = await this.findConversationRequest(queryRunner, input.ownerId, input.scope.kind, workspaceId, input.requestKey);
      if (existing) {
        assertRequestFingerprint(existing.request_fingerprint, input.requestFingerprint, 'conversation');
        return { resource: toHomeConversation(existing), replayed: true };
      }
      if (input.scope.kind === 'workspace') {
        if (forAutomation) await assertScheduledWorkspaceOwned(queryRunner, input.ownerId, input.scope.workspaceId);
        else await assertWorkspaceOwned(queryRunner, input.ownerId, input.scope.workspaceId);
      }
      const rows: readonly HomeConversationRow[] = await queryRunner.query(
        `INSERT INTO "home_conversations" ("owner_id", "scope", "workspace_id", "title", "create_request_key", "create_request_fingerprint")
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING "id", "owner_id", "scope", "workspace_id", "title", "last_event_sequence", "last_activity_at", "created_at", "updated_at"`,
        [input.ownerId, input.scope.kind, workspaceId, input.title, input.requestKey, input.requestFingerprint]
      );
      const row = rows[0];
      if (!row) {
        throw new HomeConversationNotFoundError();
      }
      const lastEventSequence = await appendHomeConversationEvent(queryRunner, {
        ownerId: input.ownerId,
        conversationId: row.id,
        type: 'conversation.created',
        turnId: null,
        entityId: null,
        payload: { scope: input.scope.kind }
      });
      return { resource: toHomeConversation({ ...row, last_event_sequence: lastEventSequence }), replayed: false };
    }, homeConversationContentScope({
      ownerId: input.ownerId,
      conversationId: null,
      conversationIdBefore: async (transaction) => {
        const workspaceId = input.scope.kind === 'workspace' ? input.scope.workspaceId : null;
        const rows = await transaction.query(
          `SELECT "id" FROM "home_conversations" WHERE "owner_id" = $1 AND "scope" = $2
             AND "workspace_id" IS NOT DISTINCT FROM $3 AND "create_request_key" = $4 LIMIT 1`,
          [input.ownerId, input.scope.kind, workspaceId, input.requestKey]
        ) as readonly { id: string }[];
        return rows[0]?.id ?? null;
      },
      conversationIdFromResult: (result: PersistedHomeResource<HomeConversation>) => result.resource.id
    }));
  }

  /** Creates a sequenced turn or replays its matching request. */
  public async createTurn(input: CreateHomeTurnInput): Promise<PersistedHomeResource<HomeTurn>> {
    return this.withAccountedTransaction(input.ownerId, async (queryRunner) => {
      const conversation = await lockConversation(queryRunner, input.ownerId, input.conversationId);
      if (!conversation) {
        throw new HomeConversationNotFoundError();
      }
      const existingRows: readonly (HomeTurnRow & KeyedRow)[] = await queryRunner.query(
        `SELECT "id", "owner_id", "conversation_id", "sequence", "request_key", "request_fingerprint", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "created_at", "updated_at"
         FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "request_key" = $3 LIMIT 1`,
        [input.ownerId, input.conversationId, input.requestKey]
      );
      const existing = existingRows[0];
      if (existing) {
        assertRequestFingerprint(existing.request_fingerprint, input.requestFingerprint, 'turn');
        return { resource: toHomeTurn(existing), replayed: true };
      }
      const sequenceRows: readonly SequenceRow[] = await queryRunner.query(
        'SELECT COALESCE(MAX("sequence"), 0) + 1 AS "sequence" FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2',
        [input.ownerId, input.conversationId]
      );
      const sequence = Number(sequenceRows[0]?.sequence ?? 1);
      const rows: readonly HomeTurnRow[] = await queryRunner.query(
        `INSERT INTO "home_turns" ("owner_id", "conversation_id", "sequence", "request_key", "request_fingerprint")
         VALUES ($1, $2, $3, $4, $5)
         RETURNING "id", "owner_id", "conversation_id", "sequence", "request_key", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "created_at", "updated_at"`,
        [input.ownerId, input.conversationId, sequence, input.requestKey, input.requestFingerprint]
      );
      const row = rows[0];
      if (!row) {
        throw new HomeConversationNotFoundError();
      }
      await appendHomeConversationEvent(queryRunner, {
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        type: 'turn.created',
        turnId: row.id,
        entityId: null,
        payload: { turnSequence: sequence, status: row.status }
      });
      return { resource: toHomeTurn(row), replayed: false };
    }, homeConversationContentScope({ ownerId: input.ownerId, conversationId: input.conversationId, turnIdsFromResult: (result: PersistedHomeResource<HomeTurn>) => [result.resource.id] }));
  }

  /** Persists a turn and its first user message as one idempotent state change. */
  public async submitTurn(input: SubmitHomeTurnInput): Promise<HomeTurnSubmission> {
    return this.withAccountedTransaction(input.ownerId, async (queryRunner) => {
      await lockAutomationDispatch(queryRunner, input);
      const conversation = await lockConversation(queryRunner, input.ownerId, input.conversationId);
      if (!conversation) throw new HomeConversationNotFoundError();

      const existingRows: readonly (HomeTurnRow & KeyedRow)[] = await queryRunner.query(
        `SELECT "id", "owner_id", "conversation_id", "sequence", "request_key", "request_fingerprint", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "automation_occurrence_id", "created_at", "updated_at"
         FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "request_key" = $3 LIMIT 1`,
        [input.ownerId, input.conversationId, input.requestKey]
      );
      const existing = existingRows[0];
      if (existing) {
        assertRequestFingerprint(existing.request_fingerprint, input.requestFingerprint, 'turn');
        if ((existing.skill_invocation_id ?? null) !== (input.skillInvocationId ?? null)) throw new HomeConversationEventInvalidError();
        if ((existing.automation_occurrence_id ?? null) !== (input.automationFence?.occurrenceId ?? null)) throw new HomeConversationEventInvalidError();
        const messageRows: readonly HomeMessageKeyedRow[] = await queryRunner.query(
          `SELECT "id", "owner_id", "conversation_id", "turn_id", "sequence", "role", "content", "request_key", "request_fingerprint", "created_at"
           FROM "home_messages" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "turn_id" = $3 AND "request_key" = $4 LIMIT 1`,
          [input.ownerId, input.conversationId, existing.id, input.requestKey]
        );
        const message = messageRows[0];
        if (!message) throw new HomeConversationEventInvalidError();
        assertRequestFingerprint(message.request_fingerprint, input.requestFingerprint, 'message');
        const disclosure = await this.findInitialDisclosure(queryRunner, input.ownerId, input.conversationId, existing.id);
        const turn = toHomeTurn(existing);
        return {
          turn,
          message: toHomeMessage(message),
          ...(disclosure ? { disclosure, execution: executionForSubmission(turn, disclosure) } : { execution: executionForStatus(turn.status) }),
          replayed: true
        };
      }

      if (input.initialDisclosure) {
        if (input.initialStatus !== 'pending'
          || input.initialDisclosure.scope.kind !== conversation.scope
          || (conversation.scope === 'workspace' && input.initialDisclosure.scope.kind === 'workspace'
            && input.initialDisclosure.scope.workspaceId !== conversation.workspace_id)) {
          throw new HomeConversationEventInvalidError();
        }
        if (conversation.scope === 'workspace' && conversation.workspace_id) {
          await assertWorkspaceOwned(queryRunner, input.ownerId, conversation.workspace_id);
        }
      }

      const turnSequenceRows: readonly SequenceRow[] = await queryRunner.query(
        'SELECT COALESCE(MAX("sequence"), 0) + 1 AS "sequence" FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2',
        [input.ownerId, input.conversationId]
      );
      const turnSequence = Number(turnSequenceRows[0]?.sequence ?? 1);
      const turnRows: readonly HomeTurnRow[] = await queryRunner.query(
        `INSERT INTO "home_turns" ("owner_id", "conversation_id", "sequence", "request_key", "request_fingerprint", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "automation_occurrence_id")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING "id", "owner_id", "conversation_id", "sequence", "request_key", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "automation_occurrence_id", "created_at", "updated_at"`,
        [input.ownerId, input.conversationId, turnSequence, input.requestKey, input.requestFingerprint, input.initialStatus, input.homePolicyRevision ?? null, input.workspacePolicyRevision ?? null, input.skillInvocationId ?? null, input.automationFence?.occurrenceId ?? null]
      );
      const turnRow = turnRows[0];
      if (!turnRow) throw new HomeTurnNotFoundError();

      if (input.skillInvocationId) {
        const boundRows = returnedRows<{ readonly id: string }>(await queryRunner.query(
          `UPDATE "skill_invocations" SET "state" = 'bound', "updated_at" = now()
           WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3 AND "state" = 'claimed'
           RETURNING "id"`,
          [input.ownerId, input.conversationId, input.skillInvocationId]
        ));
        if (boundRows[0]?.id !== input.skillInvocationId) throw new HomeConversationEventInvalidError();
      }
      if (input.automationFence) {
        const linked: readonly { readonly id: string }[] = await queryRunner.query(`
          UPDATE "automation_occurrences" SET "home_turn_id"=$7,"skill_invocation_id"=$8,
            "status"=CASE WHEN $9='running' THEN 'running' ELSE 'failed' END,
            "failure_code"=CASE WHEN $9='running' THEN NULL ELSE 'HOME_RUNTIME_UNAVAILABLE' END,
            "updated_at"=clock_timestamp()
          WHERE "id"=$1 AND "owner_id"=$2 AND "conversation_id"=$3 AND "status"='dispatching'
            AND "home_turn_id" IS NULL AND "lease_token"=$4 AND "claim_generation"=$5
            AND "lease_expires_at">clock_timestamp()
            AND EXISTS(SELECT 1 FROM "skill_invocations" i WHERE i."owner_id"=$2 AND i."conversation_id"=$3
              AND i."id"=$6 AND i."skill_revision_id"="automation_occurrences"."skill_revision_id"
              AND i."skill_version"="automation_occurrences"."skill_version")
          RETURNING "id"
        `, [input.automationFence.occurrenceId, input.ownerId, input.conversationId, input.automationFence.leaseToken,
          input.automationFence.generation, input.skillInvocationId, turnRow.id, input.skillInvocationId, input.initialStatus]);
        if (!linked[0] || !input.skillInvocationId) throw new HomeConversationEventInvalidError();
      }

      await appendHomeConversationEvent(queryRunner, {
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        type: 'turn.created',
        turnId: turnRow.id,
        entityId: null,
        payload: { turnSequence, status: turnRow.status }
      });

      const messageSequenceRows: readonly SequenceRow[] = await queryRunner.query(
        'SELECT COALESCE(MAX("sequence"), 0) + 1 AS "sequence" FROM "home_messages" WHERE "owner_id" = $1 AND "conversation_id" = $2',
        [input.ownerId, input.conversationId]
      );
      const messageSequence = Number(messageSequenceRows[0]?.sequence ?? 1);
      const initialDisclosure = input.initialDisclosure
        ? await boundedInitialDisclosureDraft(queryRunner, input.ownerId, input.conversationId, messageSequence, input.message, input.initialDisclosure)
        : null;
      const messageRows: readonly HomeMessageRow[] = await queryRunner.query(
        `INSERT INTO "home_messages" ("owner_id", "conversation_id", "turn_id", "sequence", "role", "content", "request_key", "request_fingerprint")
         VALUES ($1, $2, $3, $4, 'user', $5, $6, $7)
         RETURNING "id", "owner_id", "conversation_id", "turn_id", "sequence", "role", "content", "created_at"`,
        [input.ownerId, input.conversationId, turnRow.id, messageSequence, input.message, input.requestKey, input.requestFingerprint]
      );
      const messageRow = messageRows[0];
      if (!messageRow) throw new HomeTurnNotFoundError();

      await appendHomeConversationEvent(queryRunner, {
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        type: 'message.appended',
        turnId: turnRow.id,
        entityId: messageRow.id,
        payload: { messageSequence, role: messageRow.role }
      });
      const disclosure = initialDisclosure
        ? await this.insertInitialDisclosure(queryRunner, input.ownerId, input.conversationId, turnRow.id, initialDisclosure)
        : null;
      if (disclosure) {
        await appendHomeConversationEvent(queryRunner, {
          ownerId: input.ownerId,
          conversationId: input.conversationId,
          type: 'consent.requested',
          turnId: turnRow.id,
          entityId: disclosure.disclosureId,
          payload: consentEventPayload(disclosure)
        });
      }
      const turn = toHomeTurn(turnRow);
      return {
        turn,
        message: toHomeMessage(messageRow),
        ...(disclosure ? { disclosure, execution: executionForSubmission(turn, disclosure) } : { execution: executionForStatus(turn.status) }),
        replayed: false
      };
    }, homeConversationContentScope({ ownerId: input.ownerId, conversationId: input.conversationId, turnIdsFromResult: (result: HomeTurnSubmission) => [result.turn.id] }));
  }

  /** Locks the turn and disclosure before applying a one-turn consent decision. */
  public async decideConsent(input: DecideHomeConsentInput): Promise<HomeConsentDecisionResult | null> {
    return this.withAccountedTransaction(input.ownerId, async (queryRunner) => {
      if (!await lockConversation(queryRunner, input.ownerId, input.conversationId)) return null;
      const turnRows: readonly HomeTurnRow[] = await queryRunner.query(
        `SELECT "id", "owner_id", "conversation_id", "sequence", "request_key", "request_fingerprint", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "created_at", "updated_at"
         FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.conversationId, input.turnId]
      );
      const disclosure = await this.findConsentDisclosureInTransaction(queryRunner, input.ownerId, input.conversationId, input.turnId, input.disclosureId, true);
      const turnRow = turnRows[0];
      if (!turnRow || !disclosure) return null;
      if (disclosure.decision !== null) {
        if (disclosure.decision !== input.decision) throw new HomeConsentDecisionStaleError();
        return { turn: toHomeTurn(turnRow), disclosure, replayed: true };
      }
      const expectedStatus = disclosure.phase === 'initial' ? 'pending' : 'running';
      if (disclosure.deliveryState !== 'awaiting_decision' || turnRow.status !== expectedStatus) throw new HomeConsentDecisionStaleError();

      const deliveryState = input.decision === 'allow' ? 'starting' : 'not_required';
      const updatedDisclosureRows = returnedRows<HomeConsentDisclosureRow>(await queryRunner.query(
        `UPDATE "home_turn_consent_disclosures" SET "decision" = $5, "delivery_state" = $6, "updated_at" = now()
         WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "turn_id" = $3 AND "disclosure_id" = $4
         RETURNING ${CONSENT_DISCLOSURE_COLUMNS}`,
        [input.ownerId, input.conversationId, input.turnId, input.disclosureId, input.decision, deliveryState]
      ));
      const updatedDisclosure = updatedDisclosureRows[0];
      if (!updatedDisclosure) throw new HomeConsentDecisionStaleError();
      const mappedDisclosure = toHomeConsentDisclosure(updatedDisclosure);
      await appendHomeConversationEvent(queryRunner, {
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        type: 'consent.decided',
        turnId: input.turnId,
        entityId: input.disclosureId,
        payload: { ...consentEventPayload(mappedDisclosure), decision: input.decision }
      });

      let currentTurn = toHomeTurn(turnRow);
      if (input.decision === 'deny' && disclosure.phase === 'initial') {
        currentTurn = await this.changeTurnStatus(queryRunner, input.ownerId, input.conversationId, turnRow, 'cancelled');
      }
      return { turn: currentTurn, disclosure: mappedDisclosure, replayed: false };
    }, homeConversationContentScope({ ownerId: input.ownerId, conversationId: input.conversationId, turnIdsFromResult: (result: HomeConsentDecisionResult | null) => result ? [result.turn.id] : [] }));
  }

  /** Persists only safe metadata for a dynamic result and leaves the result in application memory. */
  public async createToolResultDisclosure(input: CreateHomeToolResultDisclosureInput): Promise<HomeConsentDisclosureResult | null> {
    return this.withAccountedTransaction(input.ownerId, async (queryRunner) => {
      const conversation = await lockConversation(queryRunner, input.ownerId, input.conversationId);
      if (!conversation) return null;
      const turnRows: readonly HomeTurnRow[] = await queryRunner.query(
        `SELECT "id", "owner_id", "conversation_id", "sequence", "request_key", "request_fingerprint", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "created_at", "updated_at"
         FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.conversationId, input.turnId]
      );
      const turn = turnRows[0];
      if (!turn || turn.status !== 'running') throw new HomeTurnNotActiveError();
      assertToolResultScope(conversation, input.draft);
      const initialDisclosure = await this.findInitialDisclosure(queryRunner, input.ownerId, input.conversationId, input.turnId);
      if (!initialDisclosure || initialDisclosure.decision !== 'allow' || initialDisclosure.deliveryState !== 'accepted'
        || initialDisclosure.providerProfile !== input.draft.provider.profile || initialDisclosure.providerName !== input.draft.provider.name
        || initialDisclosure.model !== input.draft.provider.model) throw new HomeConsentDecisionStaleError();

      const existingRows: readonly HomeConsentDisclosureRow[] = await queryRunner.query(
        `SELECT ${CONSENT_DISCLOSURE_COLUMNS} FROM "home_turn_consent_disclosures"
         WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "turn_id" = $3 AND "runtime_request_id" = $4 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.conversationId, input.turnId, input.draft.runtimeRequestId]
      );
      const existing = existingRows[0];
      if (existing) {
        const disclosure = toHomeConsentDisclosure(existing);
        if (disclosure.resultFingerprint !== input.draft.resultFingerprint
          || disclosure.providerProfile !== input.draft.provider.profile
          || disclosure.providerName !== input.draft.provider.name
          || disclosure.model !== input.draft.provider.model
          || JSON.stringify(disclosure.scope) !== JSON.stringify(input.draft.scope)
          || JSON.stringify(disclosure.categories) !== JSON.stringify(input.draft.categories)
          || disclosure.itemCount !== input.draft.itemCount || disclosure.byteLimit !== input.draft.byteLimit) {
          throw new HomeConsentDecisionStaleError();
        }
        return { disclosure, replayed: true };
      }

      const countRows: readonly { readonly disclosure_count: number | string }[] = await queryRunner.query(
        `SELECT COUNT(*) AS "disclosure_count" FROM "home_turn_consent_disclosures"
         WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "turn_id" = $3 AND "phase" = 'tool_result'`,
        [input.ownerId, input.conversationId, input.turnId]
      );
      if (Number(countRows[0]?.disclosure_count ?? 0) >= 50) throw new HomeConversationInputInvalidError('The Home planning run exceeded its consent request limit.');

      const disclosure = await this.insertToolResultDisclosure(queryRunner, input);
      await appendHomeConversationEvent(queryRunner, {
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        type: 'consent.requested',
        turnId: input.turnId,
        entityId: disclosure.disclosureId,
        payload: consentEventPayload(disclosure)
      });
      return { disclosure, replayed: false };
    }, homeConversationContentScope({ ownerId: input.ownerId, conversationId: input.conversationId, turnIdsFromResult: (result: HomeConsentDisclosureResult | null) => result ? [input.turnId] : [] }));
  }

  /** Applies a bridge start outcome only if the decision still owns this pending turn. */
  public async updateConsentDelivery(input: UpdateHomeConsentDeliveryInput): Promise<HomeTurn | null> {
    return this.withAccountedTransaction(input.ownerId, async (queryRunner) => {
      if (!await lockConversation(queryRunner, input.ownerId, input.conversationId)) return null;
      const turnRows: readonly HomeTurnRow[] = await queryRunner.query(
        `SELECT "id", "owner_id", "conversation_id", "sequence", "request_key", "request_fingerprint", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "created_at", "updated_at"
         FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.conversationId, input.turnId]
      );
      const current = turnRows[0];
      const disclosure = await this.findConsentDisclosureInTransaction(queryRunner, input.ownerId, input.conversationId, input.turnId, input.disclosureId, true);
      if (!current || !disclosure) return null;
      if (disclosure.phase !== 'initial') throw new HomeConsentDecisionStaleError();
      if (disclosure.deliveryState === input.deliveryState) return toHomeTurn(current);
      if (disclosure.decision !== 'allow' || disclosure.deliveryState !== 'starting') throw new HomeConsentDecisionStaleError();

      const updatedDisclosureRows = returnedRows<HomeConsentDisclosureRow>(await queryRunner.query(
        `UPDATE "home_turn_consent_disclosures" SET "delivery_state" = $5, "updated_at" = now()
         WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "turn_id" = $3 AND "disclosure_id" = $4
         RETURNING ${CONSENT_DISCLOSURE_COLUMNS}`,
        [input.ownerId, input.conversationId, input.turnId, input.disclosureId, input.deliveryState]
      ));
      if (!updatedDisclosureRows[0]) throw new HomeConsentDecisionStaleError();

      const nextStatus = consentDeliveryTurnStatus(current.status, input.deliveryState);
      return nextStatus && nextStatus !== current.status
        ? this.changeTurnStatus(queryRunner, input.ownerId, input.conversationId, current, nextStatus)
        : toHomeTurn(current);
    }, homeConversationContentScope({ ownerId: input.ownerId, conversationId: input.conversationId, turnIdsFromResult: (result: HomeTurn | null) => result ? [result.id] : [] }));
  }

  /** Records dynamic tool-result delivery and fails the turn closed when delivery is uncertain. */
  public async updateToolResultDelivery(input: UpdateHomeToolResultDeliveryInput): Promise<HomeTurn | null> {
    return this.withAccountedTransaction(input.ownerId, async (queryRunner) => {
      if (!await lockConversation(queryRunner, input.ownerId, input.conversationId)) return null;
      const turnRows: readonly HomeTurnRow[] = await queryRunner.query(
        `SELECT "id", "owner_id", "conversation_id", "sequence", "request_key", "request_fingerprint", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "created_at", "updated_at"
         FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.conversationId, input.turnId]
      );
      const current = turnRows[0];
      const disclosure = await this.findConsentDisclosureInTransaction(queryRunner, input.ownerId, input.conversationId, input.turnId, input.disclosureId, true);
      if (!current || !disclosure) return null;
      if (disclosure.phase !== 'tool_result' || disclosure.decision === null) throw new HomeConsentDecisionStaleError();
      if (disclosure.deliveryState === input.deliveryState) return toHomeTurn(current);
      if (!['starting', 'not_required'].includes(disclosure.deliveryState)) throw new HomeConsentDecisionStaleError();

      const updatedDisclosure = returnedRows<HomeConsentDisclosureRow>(await queryRunner.query(
        `UPDATE "home_turn_consent_disclosures" SET "delivery_state" = $5, "updated_at" = now()
         WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "turn_id" = $3 AND "disclosure_id" = $4
         RETURNING ${CONSENT_DISCLOSURE_COLUMNS}`,
        [input.ownerId, input.conversationId, input.turnId, input.disclosureId, input.deliveryState]
      ));
      if (!updatedDisclosure[0]) throw new HomeConsentDecisionStaleError();
      if (input.deliveryState === 'unknown' && (current.status === 'running' || current.status === 'cancel_requested')) {
        return this.changeTurnStatus(queryRunner, input.ownerId, input.conversationId, current, 'unknown');
      }
      return toHomeTurn(current);
    }, homeConversationContentScope({ ownerId: input.ownerId, conversationId: input.conversationId, turnIdsFromResult: (result: HomeTurn | null) => result ? [result.id] : [] }));
  }

  /** Reads one disclosure through all four Home ownership keys. */
  public async findConsentDisclosure(ownerId: string, conversationId: string, turnId: string, disclosureId: string): Promise<HomeConsentDisclosureRecord | null> {
    const rows: readonly HomeConsentDisclosureRow[] = await this.dataSource.query(
      `SELECT ${CONSENT_DISCLOSURE_COLUMNS} FROM "home_turn_consent_disclosures"
       WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "turn_id" = $3 AND "disclosure_id" = $4 LIMIT 1`,
      [ownerId, conversationId, turnId, disclosureId]
    );
    return rows[0] ? toHomeConsentDisclosure(rows[0]) : null;
  }

  /** Reads the user text attached to a single owner-scoped turn. */
  public async findUserMessageForTurn(ownerId: string, conversationId: string, turnId: string): Promise<HomeMessage | null> {
    const rows: readonly HomeMessageRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "conversation_id", "turn_id", "sequence", "role", "content", "created_at"
       FROM "home_messages" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "turn_id" = $3 AND "role" = 'user'
       ORDER BY "sequence" ASC LIMIT 1`,
      [ownerId, conversationId, turnId]
    );
    return rows[0] ? toHomeMessage(rows[0]) : null;
  }

  /** Lists a conversation's turns in ascending sequence order. */
  public async listTurnsForOwner(input: ListHomeTurnsInput): Promise<HomeTurnPage | null> {
    const conversation = await this.findForOwner(input.ownerId, input.conversationId);
    if (!conversation) {
      return null;
    }
    const parameters: unknown[] = [input.ownerId, input.conversationId];
    const afterFilter = input.afterSequence === undefined ? '' : ' AND "sequence" > $3';
    if (input.afterSequence !== undefined) {
      parameters.push(input.afterSequence);
    }
    parameters.push(input.limit + 1);
    const rows: readonly HomeTurnRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "conversation_id", "sequence", "request_key", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "automation_occurrence_id", "created_at", "updated_at"
       FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2${afterFilter}
       ORDER BY "sequence" ASC LIMIT $${parameters.length}`,
      parameters
    );
    const turns = rows.map(toHomeTurn);
    const hasMore = turns.length > input.limit;
    const page = hasMore ? turns.slice(0, input.limit) : turns;
    return { turns: page, nextAfterSequence: hasMore ? page[page.length - 1]?.sequence ?? null : null };
  }

  /** Finds one turn only when both owner and conversation match. */
  public async findTurnForOwner(ownerId: string, conversationId: string, turnId: string): Promise<HomeTurn | null> {
    const rows: readonly HomeTurnRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "conversation_id", "sequence", "request_key", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "automation_occurrence_id", "created_at", "updated_at"
       FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3 LIMIT 1`,
      [ownerId, conversationId, turnId]
    );
    return rows[0] ? toHomeTurn(rows[0]) : null;
  }

  /** Persists cancellation intent under the conversation lock and replays repeated requests. */
  public async cancelTurn(input: CancelHomeTurnInput): Promise<PersistedHomeResource<HomeTurn> | null> {
    return this.withAccountedTransaction(input.ownerId, async (queryRunner) => {
      const conversation = await lockConversation(queryRunner, input.ownerId, input.conversationId);
      if (!conversation) return null;

      const rows: readonly HomeTurnRow[] = await queryRunner.query(
        `SELECT "id", "owner_id", "conversation_id", "sequence", "request_key", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "created_at", "updated_at"
         FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.conversationId, input.turnId]
      );
      const current = rows[0];
      if (!current) return null;
      if (current.status === 'cancelled' || current.status === 'cancel_requested') {
        return { resource: toHomeTurn(current), replayed: true };
      }

      const initialDisclosure = current.status === 'pending'
        ? await this.findInitialDisclosure(queryRunner, input.ownerId, input.conversationId, input.turnId)
        : null;
      const status = current.status === 'pending'
        ? initialDisclosure?.deliveryState === 'starting' ? 'cancel_requested' : 'cancelled'
        : current.status === 'running' ? 'cancel_requested' : null;
      if (!status || !canTransitionHomeTurn(current.status, status)) throw new HomeTurnNotCancellableError();

      const updatedRows = returnedRows<HomeTurnRow>(await queryRunner.query(
        `UPDATE "home_turns" SET "status" = $4, "updated_at" = now()
         WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3
         RETURNING "id", "owner_id", "conversation_id", "sequence", "request_key", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "created_at", "updated_at"`,
        [input.ownerId, input.conversationId, input.turnId, status]
      ));
      const updated = updatedRows[0];
      if (!updated) return null;
      await appendHomeConversationEvent(queryRunner, {
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        type: 'turn.status_changed',
        turnId: input.turnId,
        entityId: null,
        payload: { status: updated.status }
      });
      return { resource: toHomeTurn(updated), replayed: false };
    }, homeConversationContentScope({ ownerId: input.ownerId, conversationId: input.conversationId, turnIdsFromResult: (result: PersistedHomeResource<HomeTurn> | null) => result ? [result.resource.id] : [] }));
  }

  /** Updates a turn only within the supplied owner and conversation. */
  public async updateTurnStatus(input: UpdateHomeTurnStatusInput): Promise<HomeTurn | null> {
    return this.withAccountedTransaction(input.ownerId, async (queryRunner) => {
      const conversation = await lockConversation(queryRunner, input.ownerId, input.conversationId);
      if (!conversation) {
        return null;
      }
      const currentRows: readonly HomeTurnRow[] = await queryRunner.query(
        `SELECT "id", "owner_id", "conversation_id", "sequence", "request_key", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "created_at", "updated_at"
         FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.conversationId, input.turnId]
      );
      const current = currentRows[0];
      if (!current) {
        return null;
      }
      if (!canTransitionHomeTurn(current.status, input.status)) {
        throw new HomeTurnTransitionInvalidError(current.status, input.status);
      }
      if (current.status === input.status) {
        return toHomeTurn(current);
      }
      const rows = returnedRows<HomeTurnRow>(await queryRunner.query(
        `UPDATE "home_turns" SET "status" = $4, "updated_at" = now()
         WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3
         RETURNING "id", "owner_id", "conversation_id", "sequence", "request_key", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "created_at", "updated_at"`,
        [input.ownerId, input.conversationId, input.turnId, input.status]
      ));
      const row = rows[0];
      if (!row) {
        return null;
      }
      await appendHomeConversationEvent(queryRunner, {
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        type: 'turn.status_changed',
        turnId: row.id,
        entityId: null,
        payload: { status: row.status }
      });
      return toHomeTurn(row);
    }, homeConversationContentScope({ ownerId: input.ownerId, conversationId: input.conversationId, turnIdsFromResult: (result: HomeTurn | null) => result ? [result.id] : [] }));
  }

  /** Commits the final assistant transcript entry and runtime status under one active-turn lock. */
  public async completeTurnWithAssistant(input: CompleteHomeTurnWithAssistantInput): Promise<HomeTurn | null> {
    if (Buffer.byteLength(input.content, 'utf8') > 262144) throw new HomeConversationEventInvalidError();
    return this.withAccountedTransaction(input.ownerId, async (queryRunner) => {
      if (!await lockAutomationCompletion(queryRunner, input)) return null;
      if (!await lockConversation(queryRunner, input.ownerId, input.conversationId)) return null;
      const rows: readonly HomeTurnRow[] = await queryRunner.query(
        `SELECT "id", "owner_id", "conversation_id", "sequence", "request_key", "request_fingerprint", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "automation_occurrence_id", "created_at", "updated_at"
         FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.conversationId, input.turnId]
      );
      const current = rows[0];
      if (!current) return null;
      if (current.automation_occurrence_id && !input.automationFence) return null;
      if (current.status !== 'running' && !(input.automationFence && current.status === 'unknown')) return toHomeTurn(current);

      if (input.content.length > 0) await this.insertAssistantMessage(queryRunner, input);
      return this.changeTurnStatus(queryRunner, input.ownerId, input.conversationId, current, input.status);
    }, homeConversationContentScope({ ownerId: input.ownerId, conversationId: input.conversationId, turnIdsFromResult: (result: HomeTurn | null) => result ? [result.id] : [] }));
  }

  /** Appends a sequenced message or replays its matching request. */
  public async appendMessage(input: AppendHomeMessageInput): Promise<PersistedHomeResource<HomeMessage>> {
    return this.withAccountedTransaction(input.ownerId, async (queryRunner) => {
      const conversation = await lockConversation(queryRunner, input.ownerId, input.conversationId);
      if (!conversation) {
        throw new HomeConversationNotFoundError();
      }
      const existingRows: readonly HomeMessageKeyedRow[] = await queryRunner.query(
        `SELECT "id", "owner_id", "conversation_id", "turn_id", "sequence", "role", "content", "request_key", "request_fingerprint", "created_at"
         FROM "home_messages" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "turn_id" = $3 AND "request_key" = $4 LIMIT 1`,
        [input.ownerId, input.conversationId, input.turnId, input.requestKey]
      );
      const existing = existingRows[0];
      if (existing) {
        assertRequestFingerprint(existing.request_fingerprint, input.requestFingerprint, 'message');
        return { resource: toHomeMessage(existing), replayed: true };
      }
      const turnRows: readonly { id: string }[] = await queryRunner.query(
        `SELECT "id" FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.conversationId, input.turnId]
      );
      if (!turnRows[0]) {
        throw new HomeTurnNotFoundError();
      }
      const sequenceRows: readonly SequenceRow[] = await queryRunner.query(
        'SELECT COALESCE(MAX("sequence"), 0) + 1 AS "sequence" FROM "home_messages" WHERE "owner_id" = $1 AND "conversation_id" = $2',
        [input.ownerId, input.conversationId]
      );
      const sequence = Number(sequenceRows[0]?.sequence ?? 1);
      const rows: readonly HomeMessageRow[] = await queryRunner.query(
        `INSERT INTO "home_messages" ("owner_id", "conversation_id", "turn_id", "sequence", "role", "content", "request_key", "request_fingerprint")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING "id", "owner_id", "conversation_id", "turn_id", "sequence", "role", "content", "created_at"`,
        [input.ownerId, input.conversationId, input.turnId, sequence, input.role, input.content, input.requestKey, input.requestFingerprint]
      );
      const row = rows[0];
      if (!row) {
        throw new HomeTurnNotFoundError();
      }
      await appendHomeConversationEvent(queryRunner, {
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        type: 'message.appended',
        turnId: input.turnId,
        entityId: row.id,
        payload: { messageSequence: sequence, role: row.role }
      });
      return { resource: toHomeMessage(row), replayed: false };
    }, homeConversationContentScope({ ownerId: input.ownerId, conversationId: input.conversationId, turnIdsFromResult: (result: PersistedHomeResource<HomeMessage>) => [input.turnId] }));
  }

  /** Lists messages from one owner-scoped conversation in sequence order. */
  public async listMessagesForOwner(input: ListHomeMessagesInput): Promise<HomeMessagePage | null> {
    const conversation = await this.findForOwner(input.ownerId, input.conversationId);
    if (!conversation) {
      return null;
    }
    const parameters: unknown[] = [input.ownerId, input.conversationId];
    const beforeFilter = input.beforeSequence === undefined ? '' : ' AND "sequence" < $3';
    const transcriptFilter = input.transcriptOnly ? ' AND "role" IN (\'user\', \'assistant\')' : '';
    if (input.beforeSequence !== undefined) {
      parameters.push(input.beforeSequence);
    }
    parameters.push(input.limit + 1);
    const rows: readonly HomeMessageRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "conversation_id", "turn_id", "sequence", "role", "content", "created_at"
       FROM "home_messages" WHERE "owner_id" = $1 AND "conversation_id" = $2${beforeFilter}${transcriptFilter}
       ORDER BY "sequence" DESC LIMIT $${parameters.length}`,
      parameters
    );
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const messages = pageRows.map(toHomeMessage).reverse();
    return { messages, nextBeforeSequence: hasMore ? messages[0]?.sequence ?? null : null };
  }

  /** Reads a bounded durable page strictly after the committed conversation cursor. */
  public async listEventsForOwner(input: ListHomeEventsInput): Promise<HomeConversationEventPage | null> {
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0 || input.afterSequence > 2147483647) {
      throw new HomeEventCursorInvalidError();
    }
    const rows: readonly HomeConversationEventPageRow[] = await this.dataSource.query(
      `SELECT c."last_event_sequence",
              e."sequence", e."event_type", e."turn_id", e."entity_id", e."payload", e."created_at"
       FROM "home_conversations" c
       LEFT JOIN LATERAL (
         SELECT "sequence", "event_type", "turn_id", "entity_id", "payload", "created_at"
         FROM "home_conversation_events"
         WHERE "owner_id" = c."owner_id" AND "conversation_id" = c."id" AND "sequence" > $3
         ORDER BY "sequence" ASC LIMIT $4
       ) e ON true
       WHERE c."owner_id" = $1 AND c."id" = $2
       ORDER BY e."sequence" ASC`,
      [input.ownerId, input.conversationId, input.afterSequence, input.limit + 1]
    );
    const conversationRow = rows[0];
    if (!conversationRow) return null;
    const eventRows = rows.filter(hasEventRow);
    const hasMore = eventRows.length > input.limit;
    const pageRows = hasMore ? eventRows.slice(0, input.limit) : eventRows;
    const events = pageRows.map(toHomeConversationEvent);
    return {
      events,
      nextAfterSequence: hasMore ? events[events.length - 1]?.sequence ?? null : null,
      lastEventSequence: Number(conversationRow.last_event_sequence)
    };
  }

  /** Marks unresolved turns as review-required without replaying any provider or task writes. */
  public async reconcileInterruptedTurns(): Promise<number> {
    const candidates: readonly InterruptedHomeTurnRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "conversation_id" FROM "home_turns"
       WHERE "status" IN ('pending', 'running', 'cancel_requested')
       ORDER BY "owner_id" ASC, "conversation_id" ASC, "sequence" ASC`
    );
    let reconciled = 0;
    for (const candidate of candidates) {
      const changed = await withTransaction(this.dataSource, async (queryRunner) => {
        const conversation = await lockConversation(queryRunner, candidate.owner_id, candidate.conversation_id);
        if (!conversation) return false;
        const rows: readonly HomeTurnRow[] = await queryRunner.query(
          `SELECT "id", "owner_id", "conversation_id", "sequence", "request_key", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "created_at", "updated_at"
           FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3 LIMIT 1 FOR UPDATE`,
          [candidate.owner_id, candidate.conversation_id, candidate.id]
        );
        const current = rows[0];
        if (!current || !['pending', 'running', 'cancel_requested'].includes(current.status)) return false;
        const updatedRows = returnedRows<HomeTurnRow>(await queryRunner.query(
          `UPDATE "home_turns" SET "status" = 'unknown', "updated_at" = now()
           WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3
           RETURNING "id", "owner_id", "conversation_id", "sequence", "request_key", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "created_at", "updated_at"`,
          [candidate.owner_id, candidate.conversation_id, candidate.id]
        ));
        const updated = updatedRows[0];
        if (!updated) return false;
        await appendHomeConversationEvent(queryRunner, {
          ownerId: candidate.owner_id,
          conversationId: candidate.conversation_id,
          type: 'turn.status_changed',
          turnId: candidate.id,
          entityId: null,
          payload: { status: updated.status, reason: 'interrupted' }
        });
        return true;
      });
      if (changed) reconciled += 1;
    }
    return reconciled;
  }

  private async insertInitialDisclosure(
    queryRunner: QueryRunner,
    ownerId: string,
    conversationId: string,
    turnId: string,
    draft: NonNullable<SubmitHomeTurnInput['initialDisclosure']>
  ): Promise<HomeConsentDisclosureRecord> {
    const scopeKind = draft.scope.kind;
    const scopeId = draft.scope.kind === 'workspace' ? draft.scope.workspaceId : null;
    const rows: readonly HomeConsentDisclosureRow[] = await queryRunner.query(
      `INSERT INTO "home_turn_consent_disclosures" (
         "disclosure_id", "owner_id", "conversation_id", "turn_id", "phase", "provider_profile", "provider_name", "model",
         "scope_kind", "scope_id", "categories", "item_count", "byte_limit", "delivery_state"
       ) VALUES ($1, $2, $3, $4, 'initial', $5, $6, $7, $8, $9, $10::jsonb, $11, $12, 'awaiting_decision')
       RETURNING ${CONSENT_DISCLOSURE_COLUMNS}`,
      [draft.disclosureId, ownerId, conversationId, turnId, draft.provider.profile, draft.provider.name, draft.provider.model,
        scopeKind, scopeId, JSON.stringify(draft.categories), draft.itemCount, draft.byteLimit]
    );
    const row = rows[0];
    if (!row) throw new HomeConversationEventInvalidError();
    return toHomeConsentDisclosure(row);
  }

  private async insertToolResultDisclosure(queryRunner: QueryRunner, input: CreateHomeToolResultDisclosureInput): Promise<HomeConsentDisclosureRecord> {
    const scopeId = input.draft.scope.kind === 'workspace' ? input.draft.scope.workspaceId : null;
    const rows: readonly HomeConsentDisclosureRow[] = await queryRunner.query(
      `INSERT INTO "home_turn_consent_disclosures" (
         "owner_id", "conversation_id", "turn_id", "phase", "provider_profile", "provider_name", "model", "scope_kind", "scope_id",
         "categories", "item_count", "byte_limit", "runtime_request_id", "result_fingerprint"
       ) VALUES ($1, $2, $3, 'tool_result', $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
       RETURNING ${CONSENT_DISCLOSURE_COLUMNS}`,
      [input.ownerId, input.conversationId, input.turnId, input.draft.provider.profile, input.draft.provider.name,
        input.draft.provider.model, input.draft.scope.kind, scopeId, JSON.stringify(input.draft.categories),
        input.draft.itemCount, input.draft.byteLimit, input.draft.runtimeRequestId, input.draft.resultFingerprint]
    );
    const row = rows[0];
    if (!row) throw new HomeConversationEventInvalidError();
    return toHomeConsentDisclosure(row);
  }

  private async insertAssistantMessage(queryRunner: QueryRunner, input: CompleteHomeTurnWithAssistantInput): Promise<void> {
    const sequenceRows: readonly SequenceRow[] = await queryRunner.query(
      'SELECT COALESCE(MAX("sequence"), 0) + 1 AS "sequence" FROM "home_messages" WHERE "owner_id" = $1 AND "conversation_id" = $2',
      [input.ownerId, input.conversationId]
    );
    const sequence = Number(sequenceRows[0]?.sequence ?? 1);
    const requestFingerprint = createHash('sha256').update(input.content, 'utf8').digest('hex');
    const rows: readonly HomeMessageRow[] = await queryRunner.query(
      `INSERT INTO "home_messages" ("owner_id", "conversation_id", "turn_id", "sequence", "role", "content", "request_key", "request_fingerprint")
       VALUES ($1, $2, $3, $4, 'assistant', $5, 'planning-assistant', $6)
       RETURNING "id", "owner_id", "conversation_id", "turn_id", "sequence", "role", "content", "created_at"`,
      [input.ownerId, input.conversationId, input.turnId, sequence, input.content, requestFingerprint]
    );
    const message = rows[0];
    if (!message) throw new HomeConversationEventInvalidError();
    await appendHomeConversationEvent(queryRunner, {
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      type: 'message.appended',
      turnId: input.turnId,
      entityId: message.id,
      payload: { messageSequence: sequence, role: 'assistant' }
    });
  }

  private async findInitialDisclosure(queryRunner: QueryRunner, ownerId: string, conversationId: string, turnId: string): Promise<HomeConsentDisclosureRecord | null> {
    const rows: readonly HomeConsentDisclosureRow[] = await queryRunner.query(
      `SELECT ${CONSENT_DISCLOSURE_COLUMNS} FROM "home_turn_consent_disclosures"
       WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "turn_id" = $3 AND "phase" = 'initial' LIMIT 1`,
      [ownerId, conversationId, turnId]
    );
    return rows[0] ? toHomeConsentDisclosure(rows[0]) : null;
  }

  private async findConsentDisclosureInTransaction(
    queryRunner: QueryRunner,
    ownerId: string,
    conversationId: string,
    turnId: string,
    disclosureId: string,
    forUpdate = false
  ): Promise<HomeConsentDisclosureRecord | null> {
    const rows: readonly HomeConsentDisclosureRow[] = await queryRunner.query(
      `SELECT ${CONSENT_DISCLOSURE_COLUMNS} FROM "home_turn_consent_disclosures"
       WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "turn_id" = $3 AND "disclosure_id" = $4 LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
      [ownerId, conversationId, turnId, disclosureId]
    );
    return rows[0] ? toHomeConsentDisclosure(rows[0]) : null;
  }

  private async changeTurnStatus(
    queryRunner: QueryRunner,
    ownerId: string,
    conversationId: string,
    current: HomeTurnRow,
    status: HomeTurn['status']
  ): Promise<HomeTurn> {
    if (!canTransitionHomeTurn(current.status, status)) throw new HomeTurnTransitionInvalidError(current.status, status);
    const rows = returnedRows<HomeTurnRow>(await queryRunner.query(
      `UPDATE "home_turns" SET "status" = $4, "updated_at" = now()
       WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3
       RETURNING "id", "owner_id", "conversation_id", "sequence", "request_key", "status", "home_policy_revision", "workspace_policy_revision", "skill_invocation_id", "created_at", "updated_at"`,
      [ownerId, conversationId, current.id, status]
    ));
    const updated = rows[0];
    if (!updated) throw new HomeTurnNotFoundError();
    await appendHomeConversationEvent(queryRunner, {
      ownerId,
      conversationId,
      type: 'turn.status_changed',
      turnId: current.id,
      entityId: null,
      payload: { status: updated.status }
    });
    return toHomeTurn(updated);
  }

  private async findConversationRequest(queryRunner: QueryRunner, ownerId: string, scope: 'home' | 'workspace', workspaceId: string | null, requestKey: string): Promise<(HomeConversationRow & KeyedRow) | null> {
    const rows: readonly (HomeConversationRow & KeyedRow)[] = await queryRunner.query(
      `SELECT "id", "owner_id", "scope", "workspace_id", "title", "last_event_sequence", "create_request_fingerprint" AS "request_fingerprint", "last_activity_at", "created_at", "updated_at"
       FROM "home_conversations" WHERE "owner_id" = $1 AND "scope" = $2 AND "workspace_id" IS NOT DISTINCT FROM $3 AND "create_request_key" = $4 LIMIT 1`,
      [ownerId, scope, workspaceId, requestKey]
    );
    return rows[0] ?? null;
  }
}
