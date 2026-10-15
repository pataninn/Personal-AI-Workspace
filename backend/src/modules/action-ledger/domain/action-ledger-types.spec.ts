import { Buffer } from 'node:buffer';

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
import { normalizeTaskDetails, normalizeTaskTitle } from '@/modules/tasks/domain/project-task-validation';
import { normalizeTaskSubtasks } from '@/modules/tasks/domain/task-planning-validation';

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

  it('accepts a maximum valid task receipt above the former 8 KiB limit', () => {
    const makeSubtasks = (title: string, completed: boolean) => normalizeTaskSubtasks(Array.from({ length: 50 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      title,
      completed
    }))).map(({ id, title: itemTitle, completed: itemCompleted }) => ({ id, title: itemTitle, completed: itemCompleted }));
    const beforeTitle = normalizeTaskTitle('🧊'.repeat(120));
    const afterTitle = normalizeTaskTitle('🌍'.repeat(120));
    const beforeDetails = normalizeTaskDetails('\\'.repeat(4096)) ?? '';
    const afterDetails = normalizeTaskDetails('"'.repeat(4096)) ?? '';
    const reversibleFields = {
      title: { before: beforeTitle, after: afterTitle },
      details: { before: beforeDetails, after: afterDetails },
      status: { before: 'todo', after: 'done' },
      position: { before: 0, after: 1 },
      projectId: { before: null, after: '33333333-3333-4333-8333-333333333333' },
      importance: { before: 'low', after: 'urgent' },
      deadline: { before: null, after: '2026-12-31' },
      archivedAt: { before: null, after: '2026-10-16T10:00:00.000Z' },
      subtasks: { before: makeSubtasks(beforeTitle, false), after: makeSubtasks(afterTitle, true) }
    } satisfies ActionLedgerMutationResult['reversibleFields'];
    const serializedBytes = Buffer.byteLength(JSON.stringify(reversibleFields), 'utf8');

    expect(serializedBytes).toBeGreaterThan(8192);
    expect(Buffer.byteLength(beforeDetails, 'utf8')).toBe(4096);
    expect(Buffer.byteLength(afterDetails, 'utf8')).toBe(4096);
    expect(serializedBytes).toBeLessThanOrEqual(81920);
    expect(() => assertActionLedgerMutationResult(validInput, { ...validMutation, reversibleFields })).not.toThrow();
  });

  it('rejects reversible JSON beyond the 80 KiB cap', () => {
    const reversibleFields = { title: { before: 'x'.repeat(40960), after: 'y'.repeat(40960) } };

    expect(() => assertActionLedgerMutationResult(validInput, {
      ...validMutation,
      reversibleFields
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
