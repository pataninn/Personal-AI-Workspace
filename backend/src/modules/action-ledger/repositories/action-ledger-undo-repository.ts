import type {
  ActionLedgerExecutionInput,
  ActionLedgerMutationResult,
  ActionLedgerRecord,
  PersistedActionLedgerRecord
} from '@/modules/action-ledger/domain/action-ledger-types';

/** Generic owner-scoped receipt lookup and transaction port used by application coordinators. */
export interface IActionLedgerUndoRepository<TTransaction> {
  findActionByIdForOwner(ownerId: string, actionId: string): Promise<ActionLedgerRecord | null>;
  executeAtomically(
    input: ActionLedgerExecutionInput,
    mutate: (transaction: TTransaction) => Promise<ActionLedgerMutationResult>
  ): Promise<PersistedActionLedgerRecord>;
}
