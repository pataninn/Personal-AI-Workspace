import {
  ActionLedgerOperationKeyReusedError,
  ActionLedgerUndoNotAvailableError
} from '@/modules/action-ledger/domain/action-ledger-errors';
import type {
  ActionLedgerExecutionInput,
  ActionLedgerMutationResult,
  ActionLedgerRecord,
  PersistedActionLedgerRecord
} from '@/modules/action-ledger/domain/action-ledger-types';
import { ActionUndoNotFoundError, ActionUndoOperationKeyReusedError } from '@/modules/home-assistant/domain/action-undo-errors';
import { ActionUndoUseCases } from '@/modules/home-assistant/use-cases/action-undo-use-cases';
import type { IActionLedgerUndoRepository } from '@/modules/action-ledger/repositories/action-ledger-undo-repository';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const ACTION = '33333333-3333-4333-8333-333333333333';
const UNDO = '44444444-4444-4444-8444-444444444444';

function taskCreateRecord(): ActionLedgerRecord {
  return {
    id: ACTION, ownerId: OWNER, operationKey: 'create-task', requestFingerprint: 'create-fingerprint',
    actorKind: 'manual', turnId: null, targetKind: 'task', targetId: TASK, actionKind: 'task.create', expectedVersion: null,
    preVersion: null, postVersion: 1, reversibleFields: {},
    outcome: { targetId: TASK, targetVersion: 1, destinationOrderVersion: 2 },
    undoStatus: 'available', undoOfActionId: null, undoActionId: null, createdAt: '2026-10-16T00:00:00.000Z'
  };
}

class FakeUndoLedger implements IActionLedgerUndoRepository<string> {
  public original: ActionLedgerRecord | null = taskCreateRecord();
  public readonly operations = new Map<string, PersistedActionLedgerRecord>();

  public async findActionByIdForOwner(ownerId: string, actionId: string): Promise<ActionLedgerRecord | null> {
    return ownerId === OWNER && this.original?.id === actionId ? this.original : null;
  }

  public async findForOwner(ownerId: string, operationKey: string): Promise<ActionLedgerRecord | null> {
    return ownerId === OWNER ? this.operations.get(operationKey)?.record ?? null : null;
  }

  public async executeAtomically(
    input: ActionLedgerExecutionInput,
    mutate: (transaction: string) => Promise<ActionLedgerMutationResult>
  ): Promise<PersistedActionLedgerRecord> {
    const previous = this.operations.get(input.operationKey);
    if (previous) {
      if (previous.record.requestFingerprint !== input.requestFingerprint) throw new ActionLedgerOperationKeyReusedError();
      return { ...previous, replayed: true };
    }
    if (this.original?.undoStatus !== 'available') throw new ActionLedgerUndoNotAvailableError();
    const result = await mutate('tx');
    const record: ActionLedgerRecord = {
      ...input,
      id: UNDO,
      ...result,
      undoActionId: null,
      createdAt: '2026-10-16T00:01:00.000Z'
    };
    this.original = { ...this.original, undoStatus: 'undone', undoActionId: UNDO };
    const persisted = { record, replayed: false };
    this.operations.set(input.operationKey, persisted);
    return persisted;
  }
}

function mutationResult(): ActionLedgerMutationResult {
  return {
    preVersion: 1,
    postVersion: 2,
    reversibleFields: {},
    outcome: { targetId: TASK, targetVersion: 2, sourceOrderVersion: 3 },
    undoStatus: 'not_reversible'
  };
}

describe('ActionUndoUseCases', () => {
  it('loads one receipt within the authenticated owner boundary', async () => {
    const ledger = new FakeUndoLedger();
    const useCase = new ActionUndoUseCases(ledger, {} as never, {} as never);

    await expect(useCase.getReceipt({ ownerId: OWNER, actionId: ACTION })).resolves.toEqual(taskCreateRecord());
    await expect(useCase.getReceipt({ ownerId: '55555555-5555-4555-8555-555555555555', actionId: ACTION }))
      .rejects.toBeInstanceOf(ActionUndoNotFoundError);
  });

  it('replays the same idempotency key before rejecting the now-undone original action', async () => {
    const ledger = new FakeUndoLedger();
    const taskParticipant = {
      undoTaskInTransaction: jest.fn(async () => mutationResult()),
      getGlobalTask: jest.fn(async () => null)
    };
    const useCase = new ActionUndoUseCases(ledger, taskParticipant as never, {} as never);
    const input = { ownerId: OWNER, actionId: ACTION, operationKey: 'undo-task-1' };

    const first = await useCase.undo(input);
    const receiptReplay = await useCase.findUndoReplay(input);
    const retry = await useCase.undo(input);

    expect(first.replayed).toBe(false);
    expect(receiptReplay).toMatchObject({ actionKind: 'undo', targetId: TASK, undoOfActionId: ACTION });
    expect(retry.replayed).toBe(true);
    expect(retry.undoReceipt.id).toBe(UNDO);
    expect(taskParticipant.undoTaskInTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns owner-safe conflicts for another key after undo and for key reuse with another request', async () => {
    const ledger = new FakeUndoLedger();
    const taskParticipant = {
      undoTaskInTransaction: jest.fn(async () => mutationResult()),
      getGlobalTask: jest.fn(async () => null)
    };
    const useCase = new ActionUndoUseCases(ledger, taskParticipant as never, {} as never);

    await useCase.undo({ ownerId: OWNER, actionId: ACTION, operationKey: 'undo-task-1' });
    await expect(useCase.undo({ ownerId: OWNER, actionId: ACTION, operationKey: 'undo-task-2' }))
      .rejects.toMatchObject({ reason: 'already_undone' });
    expect(taskParticipant.undoTaskInTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of an undo key when the validated composite child list changes', async () => {
    const ledger = new FakeUndoLedger();
    ledger.original = {
      ...taskCreateRecord(), targetKind: 'workspace', targetId: TASK, actionKind: 'workspace.create',
      preVersion: null, postVersion: 2, outcome: { targetId: TASK, targetVersion: 2 }
    };
    const workspaceParticipant = {
      undoWorkspaceInTransaction: jest.fn(async () => ({ ...mutationResult(), outcome: { targetId: TASK, targetVersion: 3 } })),
      findByIdForOwner: jest.fn(async () => null)
    };
    const useCase = new ActionUndoUseCases(ledger, {} as never, workspaceParticipant as never);

    await useCase.undo({ ownerId: OWNER, actionId: ACTION, operationKey: 'undo-workspace', completedTaskCreateActionIds: [TASK] });
    await expect(useCase.undo({ ownerId: OWNER, actionId: ACTION, operationKey: 'undo-workspace', completedTaskCreateActionIds: [UNDO] }))
      .rejects.toBeInstanceOf(ActionUndoOperationKeyReusedError);
    expect(workspaceParticipant.undoWorkspaceInTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not disclose missing or foreign action IDs', async () => {
    const ledger = new FakeUndoLedger();
    ledger.original = null;
    const taskParticipant = {
      undoTaskInTransaction: jest.fn(async () => mutationResult()),
      getGlobalTask: jest.fn(async () => null)
    };
    const useCase = new ActionUndoUseCases(ledger, taskParticipant as never, {} as never);

    await expect(useCase.undo({ ownerId: OWNER, actionId: ACTION, operationKey: 'undo-task-1' }))
      .rejects.toBeInstanceOf(ActionUndoNotFoundError);
    expect(taskParticipant.undoTaskInTransaction).not.toHaveBeenCalled();
  });
});
