import type {
  ActionLedgerExecutionInput,
  ActionLedgerMutationResult,
  ActionLedgerRecord,
  PersistedActionLedgerRecord
} from '@/modules/action-ledger/domain/action-ledger-types';

/** Persistence contract for owner-scoped, idempotent action receipts. */
export interface IActionLedgerRepository<TTransaction> {
  /** Serializes an operation key and commits mutation plus receipt in one transaction. */
  executeAtomically(
    input: ActionLedgerExecutionInput,
    mutate: (transaction: TTransaction) => Promise<ActionLedgerMutationResult>,
    eventContext?: unknown
  ): Promise<PersistedActionLedgerRecord>;

  /** Finds an operation only when it belongs to the supplied owner. */
  findForOwner(ownerId: string, operationKey: string): Promise<ActionLedgerRecord | null>;
}
