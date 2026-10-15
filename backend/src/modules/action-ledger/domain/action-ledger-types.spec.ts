import {
  ActionLedgerInputInvalidError,
  ActionLedgerMutationResultInvalidError
} from '@/modules/action-ledger/domain/action-ledger-errors';
import {
  assertActionLedgerExecutionInput,
  assertActionLedgerMutationResult,
  type ActionLedgerExecutionInput,
  type ActionLedgerMutationResult
} from '@/modules/action-ledger/domain/action-ledger-types';

const validInput: ActionLedgerExecutionInput = {
  ownerId: '11111111-1111-4111-8111-111111111111',
  operationKey: 'manual-task-update-1',
  requestFingerprint: 'fingerprint-a',
  actorKind: 'manual',
  turnId: null,
  targetKind: 'task',
  targetId: '22222222-2222-4222-8222-222222222222',
  actionKind: 'task.update',
  expectedVersion: 2,
  undoOfActionId: null
};

const validMutation: ActionLedgerMutationResult = {
  preVersion: 2,
  postVersion: 3,
  reversibleFields: { status: { before: 'todo', after: 'in_progress' } },
  outcome: { targetId: validInput.targetId, targetVersion: 3 },
  undoStatus: 'available'
};

describe('Action ledger contract validation', () => {
  it('accepts a manual action with no assistant turn', () => {
    expect(() => assertActionLedgerExecutionInput(validInput)).not.toThrow();
  });

  it('rejects a fabricated turn on a manual action', () => {
    expect(() => assertActionLedgerExecutionInput({
      ...validInput,
      turnId: '33333333-3333-4333-8333-333333333333'
    })).toThrow(ActionLedgerInputInvalidError);
  });

  it('allows only changed allowlisted fields in reversible data', () => {
    expect(() => assertActionLedgerMutationResult(validInput, validMutation)).not.toThrow();
    expect(() => assertActionLedgerMutationResult(validInput, {
      ...validMutation,
      reversibleFields: { fullTask: { before: {}, after: {} } } as ActionLedgerMutationResult['reversibleFields']
    })).toThrow(ActionLedgerInputInvalidError);
  });

  it('rejects a mutation receipt whose pre-version differs from the expected version', () => {
    expect(() => assertActionLedgerMutationResult(validInput, { ...validMutation, preVersion: 1 })).toThrow(ActionLedgerMutationResultInvalidError);
  });

  it('rejects full target snapshots in the saved outcome', () => {
    expect(() => assertActionLedgerMutationResult(validInput, {
      ...validMutation,
      outcome: { targetId: validInput.targetId, targetVersion: 3, task: { title: 'entire task snapshot' } } as ActionLedgerMutationResult['outcome']
    })).toThrow(ActionLedgerInputInvalidError);
  });
});
