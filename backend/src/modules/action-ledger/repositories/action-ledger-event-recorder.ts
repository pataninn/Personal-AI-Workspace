import type { ActionLedgerRecord } from '@/modules/action-ledger/domain/action-ledger-types';

/** Records an optional cross-feature event within the ledger's transaction. */
export interface IActionLedgerEventRecorder<TTransaction> {
  recordAction(transaction: TTransaction, record: ActionLedgerRecord): Promise<void>;
}
