import type { DataSource, QueryRunner } from 'typeorm';

import {
  ActionLedgerMutationResultInvalidError,
  ActionLedgerOperationKeyReusedError,
  ActionLedgerUndoNotAvailableError
} from '@/modules/action-ledger/domain/action-ledger-errors';
import type {
  ActionLedgerExecutionInput,
  ActionLedgerMutationResult,
  ActionLedgerRecord
} from '@/modules/action-ledger/domain/action-ledger-types';
import { TypeOrmActionLedgerRepository } from '@/infrastructure/database/repositories/typeorm-action-ledger-repository';
import type { ActionLedgerRow } from '@/infrastructure/database/repositories/action-ledger-persistence-mappers';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const ORIGINAL_ACTION_ID = '44444444-4444-4444-8444-444444444444';

interface FakeLedgerState {
  readonly committedTargets: string[];
  readonly committedRecords: ActionLedgerRow[];
  readonly runnerQueries: string[];
  failCommit: boolean;
  failReceiptInsert: boolean;
  lastInsertRow: ActionLedgerRow | null;
  rollbackCount: number;
  releaseCount: number;
  lockWaitCount: number;
  waitForLockWaiter(): Promise<void>;
}

interface FakeTransaction {
  readonly id: number;
  readonly pendingTargets: string[];
  readonly pendingRecords: ActionLedgerRow[];
  readonly pendingUndoUpdates: Array<{ readonly originalId: string; readonly undoActionId: string }>;
  readonly lockKeys: Set<string>;
}

function createFakeDatabase(): { readonly dataSource: DataSource; readonly runner: QueryRunner; readonly state: FakeLedgerState } {
  let notifyLockWaiter: () => void = () => undefined;
  const lockWaitPromise = new Promise<void>((resolve) => { notifyLockWaiter = resolve; });
  const state: FakeLedgerState = {
    committedTargets: [],
    committedRecords: [],
    runnerQueries: [],
    failCommit: false,
    failReceiptInsert: false,
    lastInsertRow: null,
    rollbackCount: 0,
    releaseCount: 0,
    lockWaitCount: 0,
    waitForLockWaiter: () => lockWaitPromise
  };
  const locks = new Map<string, { readonly transaction: FakeTransaction; readonly waiters: Array<{ readonly transaction: FakeTransaction; readonly resolve: () => void }> }>();
  let nextId = 0;

  const createRunner = (): QueryRunner => {
    const transaction: FakeTransaction = {
      id: nextId + 1,
      pendingTargets: [],
      pendingRecords: [],
      pendingUndoUpdates: [],
      lockKeys: new Set()
    };
    let isTransactionActive = false;
    const releaseLocks = (): void => {
      for (const key of transaction.lockKeys) {
        const held = locks.get(key);
        if (!held || held.transaction !== transaction) {
          continue;
        }
        const next = held.waiters.shift();
        if (next) {
          next.transaction.lockKeys.add(key);
          locks.set(key, { transaction: next.transaction, waiters: held.waiters });
          next.resolve();
        } else {
          locks.delete(key);
        }
      }
      transaction.lockKeys.clear();
    };
    const query = async (sql: string, parameters: readonly unknown[] = []): Promise<readonly Record<string, unknown>[]> => {
      state.runnerQueries.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) {
        const key = String(parameters[0]);
        const current = locks.get(key);
        if (!current) {
          transaction.lockKeys.add(key);
          locks.set(key, { transaction, waiters: [] });
        } else if (current.transaction !== transaction) {
          state.lockWaitCount += 1;
          notifyLockWaiter();
          await new Promise<void>((resolve) => current.waiters.push({ transaction, resolve }));
        }
        return [];
      }
      if (sql.includes('INSERT INTO "target_mutations"')) {
        transaction.pendingTargets.push(String(parameters[0]));
        return [];
      }
      if (sql.includes('SELECT') && sql.includes('FROM "action_ledger_records"') && sql.includes('"operation_key"')) {
        const rows = [...state.committedRecords, ...transaction.pendingRecords].filter((row) => row.owner_id === parameters[0] && row.operation_key === parameters[1]);
        return rows as unknown as readonly Record<string, unknown>[];
      }
      if (sql.includes('SELECT') && sql.includes('FROM "action_ledger_records"') && sql.includes('"undo_status" = \'available\'')) {
        const rows = [...state.committedRecords, ...transaction.pendingRecords].filter((row) =>
          row.owner_id === parameters[0] && row.id === parameters[1] && row.target_kind === parameters[2] && row.target_id === parameters[3] && row.undo_status === 'available'
        );
        return rows.map((row) => ({ id: row.id }));
      }
      if (sql.includes('INSERT INTO "action_ledger_records"')) {
        if (state.failReceiptInsert) {
          throw new Error('receipt insert failed');
        }
        nextId += 1;
        const row: ActionLedgerRow = {
          id: nextId === 1 ? ORIGINAL_ACTION_ID : `55555555-5555-4555-8555-${String(nextId).padStart(12, '0')}`,
          owner_id: String(parameters[0]),
          operation_key: String(parameters[1]),
          request_fingerprint: String(parameters[2]),
          actor_kind: String(parameters[3]),
          turn_id: parameters[4] === null ? null : String(parameters[4]),
          target_kind: String(parameters[5]),
          target_id: String(parameters[6]),
          action_kind: String(parameters[7]),
          expected_version: parameters[8] === null ? null : Number(parameters[8]),
          pre_version: parameters[9] === null ? null : Number(parameters[9]),
          post_version: parameters[10] === null ? null : Number(parameters[10]),
          reversible_fields: JSON.parse(String(parameters[11])) as unknown,
          outcome: JSON.parse(String(parameters[12])) as unknown,
          undo_status: String(parameters[13]),
          undo_of_action_id: parameters[14] === null ? null : String(parameters[14]),
          undo_action_id: null,
          created_at: new Date('2026-10-15T00:00:00.000Z')
        };
        transaction.pendingRecords.push(row);
        state.lastInsertRow = row;
        return [row] as unknown as readonly Record<string, unknown>[];
      }
      if (sql.includes('UPDATE "action_ledger_records"')) {
        const original = [...state.committedRecords, ...transaction.pendingRecords].find((row) => row.owner_id === parameters[0] && row.id === parameters[1] && row.undo_status === 'available');
        if (!original) {
          return [];
        }
        transaction.pendingUndoUpdates.push({ originalId: original.id, undoActionId: String(parameters[2]) });
        return [{ id: original.id }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    };
    const runner = {
      get isTransactionActive() { return isTransactionActive; },
      connect: jest.fn(async () => undefined),
      startTransaction: jest.fn(async () => { isTransactionActive = true; }),
      commitTransaction: jest.fn(async () => {
        if (state.failCommit) {
          throw new Error('commit failed before commit');
        }
        state.committedTargets.push(...transaction.pendingTargets);
        state.committedRecords.push(...transaction.pendingRecords);
        for (const update of transaction.pendingUndoUpdates) {
          const original = state.committedRecords.find((row) => row.id === update.originalId);
          if (original) {
            (original as { undo_status: string }).undo_status = 'undone';
            (original as { undo_action_id: string | null }).undo_action_id = update.undoActionId;
          }
        }
        isTransactionActive = false;
        releaseLocks();
      }),
      rollbackTransaction: jest.fn(async () => {
        state.rollbackCount += 1;
        transaction.pendingTargets.length = 0;
        transaction.pendingRecords.length = 0;
        transaction.pendingUndoUpdates.length = 0;
        isTransactionActive = false;
        releaseLocks();
      }),
      release: jest.fn(async () => { state.releaseCount += 1; }),
      query: jest.fn(query)
    } as unknown as QueryRunner;
    return runner;
  };

  const runner = createRunner();
  let firstRunnerReturned = false;

  const dataSource = {
    createQueryRunner: jest.fn(() => {
      if (!firstRunnerReturned) {
        firstRunnerReturned = true;
        return runner;
      }
      return createRunner();
    }),
    query: jest.fn(async (sql: string, parameters: readonly unknown[] = []) => {
      if (sql.includes('FROM "action_ledger_records"')) {
        return state.committedRecords.filter((row) => row.owner_id === parameters[0] && row.operation_key === parameters[1]);
      }
      throw new Error(`Unexpected data source query: ${sql}`);
    })
  } as unknown as DataSource;
  return { dataSource, runner, state };
}

const input: ActionLedgerExecutionInput = {
  ownerId: OWNER_ID,
  operationKey: 'update-task-1',
  requestFingerprint: 'fingerprint-a',
  actorKind: 'manual',
  turnId: null,
  targetKind: 'task',
  targetId: TARGET_ID,
  actionKind: 'task.update',
  expectedVersion: 1,
  undoOfActionId: null
};

function mutationResult(): ActionLedgerMutationResult {
  return {
    preVersion: 1,
    postVersion: 2,
    reversibleFields: { status: { before: 'todo', after: 'in_progress' } },
    outcome: { targetId: TARGET_ID, targetVersion: 2 },
    undoStatus: 'available'
  };
}

describe('TypeOrmActionLedgerRepository', () => {
  it('commits the target mutation and receipt on the same transaction', async () => {
    const { dataSource, runner, state } = createFakeDatabase();
    const repository = new TypeOrmActionLedgerRepository(dataSource);
    const mutation = jest.fn(async (transaction: QueryRunner) => {
      await transaction.query('INSERT INTO "target_mutations" ("target_id") VALUES ($1)', [TARGET_ID]);
      return mutationResult();
    });

    const result = await repository.executeAtomically(input, mutation);

    expect(result.replayed).toBe(false);
    expect(result.record.actorKind).toBe('manual');
    expect(result.record.turnId).toBeNull();
    expect(state.committedTargets).toEqual([TARGET_ID]);
    expect(state.committedRecords).toHaveLength(1);
    expect(mutation.mock.calls[0]?.[0]).toBe(runner);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(state.runnerQueries[0]).toContain('pg_advisory_xact_lock');
    expect(state.runnerQueries[1]).toContain('"operation_key"');
  });

  it('rolls back the target mutation when receipt persistence fails', async () => {
    const { dataSource, state } = createFakeDatabase();
    state.failReceiptInsert = true;
    const repository = new TypeOrmActionLedgerRepository(dataSource);

    await expect(repository.executeAtomically(input, async (transaction) => {
      await transaction.query('INSERT INTO "target_mutations" ("target_id") VALUES ($1)', [TARGET_ID]);
      return mutationResult();
    })).rejects.toThrow('receipt insert failed');

    expect(state.committedTargets).toEqual([]);
    expect(state.committedRecords).toEqual([]);
    expect(state.rollbackCount).toBe(1);
  });

  it('rolls back and releases when commit fails before the transaction commits', async () => {
    const { dataSource, runner, state } = createFakeDatabase();
    state.failCommit = true;
    const repository = new TypeOrmActionLedgerRepository(dataSource);

    await expect(repository.executeAtomically(input, async (transaction) => {
      await transaction.query('INSERT INTO "target_mutations" ("target_id") VALUES ($1)', [TARGET_ID]);
      return mutationResult();
    })).rejects.toThrow('commit failed before commit');

    expect(state.committedTargets).toEqual([]);
    expect(state.committedRecords).toEqual([]);
    expect(state.rollbackCount).toBe(1);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(state.releaseCount).toBe(1);
  });

  it('rolls back a participant that returns a stale pre-version', async () => {
    const { dataSource, state } = createFakeDatabase();
    const repository = new TypeOrmActionLedgerRepository(dataSource);

    await expect(repository.executeAtomically(input, async (transaction) => {
      await transaction.query('INSERT INTO "target_mutations" ("target_id") VALUES ($1)', [TARGET_ID]);
      return { ...mutationResult(), preVersion: 2 };
    })).rejects.toBeInstanceOf(ActionLedgerMutationResultInvalidError);

    expect(state.committedTargets).toEqual([]);
    expect(state.committedRecords).toEqual([]);
    expect(state.rollbackCount).toBe(1);
  });

  it('replays an identical operation before invoking the mutation callback', async () => {
    const { dataSource, state } = createFakeDatabase();
    const repository = new TypeOrmActionLedgerRepository(dataSource);
    await repository.executeAtomically(input, async () => mutationResult());
    const mutation = jest.fn(async () => mutationResult());

    const replay = await repository.executeAtomically(input, mutation);

    expect(replay.replayed).toBe(true);
    expect(replay.record.operationKey).toBe(input.operationKey);
    expect(mutation).not.toHaveBeenCalled();
    expect(state.committedRecords).toHaveLength(1);
  });

  it('serializes a concurrent same-key request and replays after the first transaction commits', async () => {
    const { dataSource, state } = createFakeDatabase();
    const repository = new TypeOrmActionLedgerRepository(dataSource);
    let signalMutationStarted: () => void = () => undefined;
    let releaseFirstMutation: () => void = () => undefined;
    const mutationStarted = new Promise<void>((resolve) => { signalMutationStarted = resolve; });
    const firstMutationGate = new Promise<void>((resolve) => { releaseFirstMutation = resolve; });
    const first = repository.executeAtomically(input, async (transaction) => {
      await transaction.query('INSERT INTO "target_mutations" ("target_id") VALUES ($1)', [TARGET_ID]);
      signalMutationStarted();
      await firstMutationGate;
      return mutationResult();
    });
    await mutationStarted;
    const secondMutation = jest.fn(async () => mutationResult());
    const second = repository.executeAtomically(input, secondMutation);
    await state.waitForLockWaiter();

    expect(state.lockWaitCount).toBe(1);
    expect(secondMutation).not.toHaveBeenCalled();
    releaseFirstMutation();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.replayed).toBe(false);
    expect(secondResult.replayed).toBe(true);
    expect(secondMutation).not.toHaveBeenCalled();
    expect(state.committedRecords).toHaveLength(1);
    expect(state.committedTargets).toEqual([TARGET_ID]);
  });

  it('conflicts on a reused key with a different fingerprint before mutation', async () => {
    const { dataSource, state } = createFakeDatabase();
    const repository = new TypeOrmActionLedgerRepository(dataSource);
    await repository.executeAtomically(input, async () => mutationResult());
    const mutation = jest.fn(async () => mutationResult());

    await expect(repository.executeAtomically({ ...input, requestFingerprint: 'fingerprint-b' }, mutation)).rejects.toBeInstanceOf(ActionLedgerOperationKeyReusedError);

    expect(mutation).not.toHaveBeenCalled();
    expect(state.committedRecords).toHaveLength(1);
  });

  it('does not return another owner’s operation record', async () => {
    const { dataSource } = createFakeDatabase();
    const repository = new TypeOrmActionLedgerRepository(dataSource);
    await repository.executeAtomically(input, async () => mutationResult());

    await expect(repository.findForOwner(OTHER_OWNER_ID, input.operationKey)).resolves.toBeNull();
  });

  it('requires an available same-owner undo record before invoking a compensating mutation', async () => {
    const { dataSource } = createFakeDatabase();
    const repository = new TypeOrmActionLedgerRepository(dataSource);
    const mutation = jest.fn(async () => mutationResult());

    await expect(repository.executeAtomically({
      ...input,
      ownerId: OTHER_OWNER_ID,
      operationKey: 'undo-other-owner',
      requestFingerprint: 'undo-fingerprint',
      actionKind: 'undo',
      expectedVersion: 2,
      undoOfActionId: ORIGINAL_ACTION_ID
    }, mutation)).rejects.toBeInstanceOf(ActionLedgerUndoNotAvailableError);

    expect(mutation).not.toHaveBeenCalled();
  });

  it('commits the compensating receipt and original undo status with the target reversal', async () => {
    const { dataSource } = createFakeDatabase();
    const repository = new TypeOrmActionLedgerRepository(dataSource);
    const original = await repository.executeAtomically(input, async () => mutationResult());
    const undoInput: ActionLedgerExecutionInput = {
      ...input,
      operationKey: 'undo-task-update-1',
      requestFingerprint: 'undo-fingerprint',
      actionKind: 'undo',
      expectedVersion: 2,
      undoOfActionId: original.record.id
    };

    const undo = await repository.executeAtomically(undoInput, async (transaction) => {
      await transaction.query('INSERT INTO "target_mutations" ("target_id") VALUES ($1)', [TARGET_ID]);
      return {
        preVersion: 2,
        postVersion: 3,
        reversibleFields: { status: { before: 'in_progress', after: 'todo' } },
        outcome: { targetId: TARGET_ID, targetVersion: 3 },
        undoStatus: 'not_reversible'
      };
    });
    const updatedOriginal = await repository.findForOwner(OWNER_ID, input.operationKey);

    expect(undo.record.undoOfActionId).toBe(original.record.id);
    expect(updatedOriginal?.undoStatus).toBe('undone');
    expect(updatedOriginal?.undoActionId).toBe(undo.record.id);
  });
});
