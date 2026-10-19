import type { DataSource, QueryRunner } from 'typeorm';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import type { StorageContentIdentity, StorageContentMutationScope } from '@/infrastructure/database/storage-content-projections';
import type { StorageQuotaTransaction } from '@/modules/storage-quotas/repositories/storage-quota-repository';

import {
  ActionLedgerOperationKeyReusedError,
  ActionLedgerUndoNotAvailableError
} from '@/modules/action-ledger/domain/action-ledger-errors';
import {
  assertActionLedgerExecutionInput,
  assertActionLedgerMutationResult,
  assertActionLedgerOperationIdentity,
  assertActionLedgerRecordIdentity,
  type ActionLedgerExecutionInput,
  type ActionLedgerMutationResult,
  type ActionLedgerRecord,
  type PersistedActionLedgerRecord
} from '@/modules/action-ledger/domain/action-ledger-types';
import type { IActionLedgerRepository } from '@/modules/action-ledger/repositories/action-ledger-repository';
import type { IActionLedgerEventRecorder } from '@/modules/action-ledger/repositories/action-ledger-event-recorder';
import type { IActionLedgerUndoRepository } from '@/modules/action-ledger/repositories/action-ledger-undo-repository';
import { toActionLedgerRecord, type ActionLedgerRow } from '@/infrastructure/database/repositories/action-ledger-persistence-mappers';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';

const ACTION_LEDGER_COLUMNS = `"id", "owner_id", "operation_key", "request_fingerprint", "actor_kind", "turn_id",
  "target_kind", "target_id", "action_kind", "expected_version", "pre_version", "post_version",
  "reversible_fields", "outcome", "undo_status", "undo_of_action_id", "undo_action_id", "created_at"`;

/** Persists action receipts and runs the target participant on the receipt's transaction. */
export class TypeOrmActionLedgerRepository implements IActionLedgerRepository<QueryRunner>, IActionLedgerUndoRepository<QueryRunner> {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly eventRecorder?: IActionLedgerEventRecorder<QueryRunner>,
    private readonly storageAccounting = new TypeOrmStorageContentAccounting(dataSource)
  ) {}

  /** Replays or applies one owner-scoped operation with mutation and receipt in one transaction. */
  public async executeAtomically(
    input: ActionLedgerExecutionInput,
    mutate: (transaction: QueryRunner) => Promise<ActionLedgerMutationResult>,
    eventContext?: unknown
  ): Promise<PersistedActionLedgerRecord> {
    assertActionLedgerExecutionInput(input);
    return this.withTransaction(input.ownerId, async (queryRunner) => {
      const principals: readonly { readonly id: string }[] = await queryRunner.query(
        'SELECT "id" FROM "users" WHERE "id" = $1 AND "is_active" = true AND ("expires_at" IS NULL OR "expires_at" > now()) FOR SHARE',
        [input.ownerId]
      );
      if (!principals[0]) throw new UnauthenticatedError();
      const lockIdentity = JSON.stringify(['action-ledger', input.ownerId, input.operationKey]);
      await queryRunner.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockIdentity]);
      const existing = await this.findByOperation(queryRunner, input.ownerId, input.operationKey);
      if (existing) {
        if (existing.request_fingerprint !== input.requestFingerprint) {
          throw new ActionLedgerOperationKeyReusedError();
        }
        return { record: toActionLedgerRecord(existing), replayed: true };
      }

      if (input.actionKind === 'undo') {
        await this.lockUndoTarget(queryRunner, input);
      }

      const mutation = await mutate(queryRunner);
      assertActionLedgerMutationResult(input, mutation);
      const rows: readonly ActionLedgerRow[] = await queryRunner.query(
        `INSERT INTO "action_ledger_records" (
           "owner_id", "operation_key", "request_fingerprint", "actor_kind", "turn_id",
           "target_kind", "target_id", "action_kind", "expected_version", "pre_version", "post_version",
           "reversible_fields", "outcome", "undo_status", "undo_of_action_id"
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15)
         RETURNING ${ACTION_LEDGER_COLUMNS}`,
        [
          input.ownerId,
          input.operationKey,
          input.requestFingerprint,
          input.actorKind,
          input.turnId,
          input.targetKind,
          input.targetId,
          input.actionKind,
          input.expectedVersion,
          mutation.preVersion,
          mutation.postVersion,
          JSON.stringify(mutation.reversibleFields),
          JSON.stringify(mutation.outcome),
          mutation.undoStatus,
          input.undoOfActionId
        ]
      );
      const row = rows[0];
      if (!row) {
        throw new Error('The action receipt was not returned after insert.');
      }

      if (input.undoOfActionId !== null) {
        const updatedOriginal: readonly { id: string }[] = await queryRunner.query(
          `UPDATE "action_ledger_records" SET "undo_status" = 'undone', "undo_action_id" = $3
           WHERE "owner_id" = $1 AND "id" = $2 AND "undo_status" = 'available'
           RETURNING "id"`,
          [input.ownerId, input.undoOfActionId, row.id]
        );
        if (!updatedOriginal[0]) {
          throw new ActionLedgerUndoNotAvailableError();
        }
      }

      const record = toActionLedgerRecord(row);
      if (record.turnId !== null) {
        if (!this.eventRecorder) {
          throw new Error('An event recorder is required for assistant action receipts.');
        }
        await this.eventRecorder.recordAction(queryRunner, record, eventContext);
      }

      return { record, replayed: false };
    }, actionContentScope(input, eventContext));
  }

  /** Reads an operation using both owner and key, never the key alone. */
  public async findForOwner(ownerId: string, operationKey: string): Promise<ActionLedgerRecord | null> {
    assertActionLedgerOperationIdentity(ownerId, operationKey);
    const rows: readonly ActionLedgerRow[] = await this.dataSource.query(
      `SELECT ${ACTION_LEDGER_COLUMNS} FROM "action_ledger_records"
       WHERE "owner_id" = $1 AND "operation_key" = $2 LIMIT 1`,
      [ownerId, operationKey]
    );
    return rows[0] ? toActionLedgerRecord(rows[0]) : null;
  }

  /** Finds an original action only within its authenticated owner's receipt history. */
  public async findActionByIdForOwner(ownerId: string, actionId: string): Promise<ActionLedgerRecord | null> {
    assertActionLedgerRecordIdentity(ownerId, actionId);
    const rows: readonly ActionLedgerRow[] = await this.dataSource.query(
      `SELECT ${ACTION_LEDGER_COLUMNS} FROM "action_ledger_records"
       WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1`,
      [ownerId, actionId]
    );
    return rows[0] ? toActionLedgerRecord(rows[0]) : null;
  }

  private async findByOperation(queryRunner: QueryRunner, ownerId: string, operationKey: string): Promise<ActionLedgerRow | null> {
    const rows: readonly ActionLedgerRow[] = await queryRunner.query(
      `SELECT ${ACTION_LEDGER_COLUMNS} FROM "action_ledger_records"
       WHERE "owner_id" = $1 AND "operation_key" = $2 LIMIT 1`,
      [ownerId, operationKey]
    );
    return rows[0] ?? null;
  }

  private async lockUndoTarget(queryRunner: QueryRunner, input: ActionLedgerExecutionInput): Promise<void> {
    const rows: readonly { id: string }[] = await queryRunner.query(
      `SELECT "id" FROM "action_ledger_records"
       WHERE "owner_id" = $1 AND "id" = $2 AND "target_kind" = $3 AND "target_id" = $4 AND "undo_status" = 'available'
       LIMIT 1 FOR UPDATE`,
      [input.ownerId, input.undoOfActionId, input.targetKind, input.targetId]
    );
    if (!rows[0]) {
      throw new ActionLedgerUndoNotAvailableError();
    }
  }

  private async withTransaction<T>(ownerId: string, action: (queryRunner: QueryRunner) => Promise<T>, scope: StorageContentMutationScope<T>): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      const result = await this.storageAccounting.runMutation(queryRunner, ownerId, () => action(queryRunner), scope);
      await queryRunner.commitTransaction();
      return result;
    } catch (error: unknown) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}

function actionContentScope(
  input: ActionLedgerExecutionInput,
  eventContext: unknown
): StorageContentMutationScope<PersistedActionLedgerRecord> {
  let conversationId: string | null = null;
  let previousEventSequence = 0;
  const proposalItemId = getHomeProposalItemId(eventContext);
  const targetIdentity: StorageContentIdentity = {
    entity: input.targetKind === 'task' ? 'project_tasks' : 'projects',
    id: input.targetId
  };
  return {
    before: async (transaction) => {
      if (input.turnId !== null) {
        const turnRows = await transaction.query(
          'SELECT "conversation_id" FROM "home_turns" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1',
          [input.ownerId, input.turnId]
        ) as readonly { conversation_id: string }[];
        conversationId = turnRows[0]?.conversation_id ?? null;
        if (conversationId) {
          const eventRows = await transaction.query(
            'SELECT "last_event_sequence" FROM "home_conversations" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1',
            [input.ownerId, conversationId]
          ) as readonly { last_event_sequence: number | string }[];
          previousEventSequence = Number(eventRows[0]?.last_event_sequence ?? 0);
        }
      }
      return [targetIdentity, ...(proposalItemId ? [{ entity: 'home_change_proposal_items' as const, id: proposalItemId }] : [])];
    },
    after: async (transaction, result) => {
      const identities: StorageContentIdentity[] = [
        targetIdentity,
        { entity: 'action_ledger_records', id: result.record.id },
        ...(proposalItemId ? [{ entity: 'home_change_proposal_items' as const, id: proposalItemId }] : [])
      ];
      if (input.actionKind === 'task.delete') {
        const receiptRows = await transaction.query(
          'SELECT "id" FROM "action_ledger_records" WHERE "owner_id" = $1 AND "target_kind" = \'task\' AND "target_id" = $2',
          [input.ownerId, input.targetId]
        ) as readonly { id: string }[];
        identities.push(...receiptRows.map(({ id }) => ({ entity: 'action_ledger_records' as const, id })));
      }
      if (input.turnId !== null && conversationId) {
        const eventRows = await transaction.query(
          'SELECT "last_event_sequence" FROM "home_conversations" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1',
          [input.ownerId, conversationId]
        ) as readonly { last_event_sequence: number | string }[];
        const lastEventSequence = Number(eventRows[0]?.last_event_sequence ?? previousEventSequence);
        const eventCount = lastEventSequence - previousEventSequence;
        if (!Number.isSafeInteger(eventCount) || eventCount < 0 || eventCount > 100) {
          throw new TypeError('An action-ledger mutation exceeded the bounded Home event accounting scope.');
        }
        for (let sequence = previousEventSequence + 1; sequence <= lastEventSequence; sequence += 1) {
          identities.push({ entity: 'home_conversation_events', id: conversationId, sequence });
        }
      }
      return identities;
    }
  };
}

function getHomeProposalItemId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>).itemId;
  return typeof candidate === 'string' ? candidate : null;
}
