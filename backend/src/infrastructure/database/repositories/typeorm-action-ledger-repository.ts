import type { DataSource, QueryRunner } from 'typeorm';

import {
  ActionLedgerOperationKeyReusedError,
  ActionLedgerUndoNotAvailableError
} from '@/modules/action-ledger/domain/action-ledger-errors';
import {
  assertActionLedgerExecutionInput,
  assertActionLedgerMutationResult,
  assertActionLedgerOperationIdentity,
  type ActionLedgerExecutionInput,
  type ActionLedgerMutationResult,
  type ActionLedgerRecord,
  type PersistedActionLedgerRecord
} from '@/modules/action-ledger/domain/action-ledger-types';
import type { IActionLedgerRepository } from '@/modules/action-ledger/repositories/action-ledger-repository';
import { toActionLedgerRecord, type ActionLedgerRow } from '@/infrastructure/database/repositories/action-ledger-persistence-mappers';

const ACTION_LEDGER_COLUMNS = `"id", "owner_id", "operation_key", "request_fingerprint", "actor_kind", "turn_id",
  "target_kind", "target_id", "action_kind", "expected_version", "pre_version", "post_version",
  "reversible_fields", "outcome", "undo_status", "undo_of_action_id", "undo_action_id", "created_at"`;

/** Persists action receipts and runs the target participant on the receipt's transaction. */
export class TypeOrmActionLedgerRepository implements IActionLedgerRepository<QueryRunner> {
  public constructor(private readonly dataSource: DataSource) {}

  /** Replays or applies one owner-scoped operation with mutation and receipt in one transaction. */
  public async executeAtomically(
    input: ActionLedgerExecutionInput,
    mutate: (transaction: QueryRunner) => Promise<ActionLedgerMutationResult>
  ): Promise<PersistedActionLedgerRecord> {
    assertActionLedgerExecutionInput(input);
    return this.withTransaction(async (queryRunner) => {
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

      return { record: toActionLedgerRecord(row), replayed: false };
    });
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

  private async withTransaction<T>(action: (queryRunner: QueryRunner) => Promise<T>): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      const result = await action(queryRunner);
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
