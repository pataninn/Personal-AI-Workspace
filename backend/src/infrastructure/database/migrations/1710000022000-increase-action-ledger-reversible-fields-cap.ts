import type { MigrationInterface, QueryRunner } from 'typeorm';

import { ActionLedgerReversibleCapRollbackBlockedError } from '@/modules/action-ledger/domain/action-ledger-errors';

/** Raises the reversible receipt cap enough for every valid task edit to retain its undo data. */
export class IncreaseActionLedgerReversibleFieldsCap1710000022000 implements MigrationInterface {
  public readonly name = 'IncreaseActionLedgerReversibleFieldsCap1710000022000';

  /** Expands only reversible fields; the compact outcome cap remains unchanged. */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "action_ledger_records"
        DROP CONSTRAINT "CHK_action_ledger_records_reversible_object",
        ADD CONSTRAINT "CHK_action_ledger_records_reversible_object"
          CHECK (jsonb_typeof("reversible_fields") = 'object' AND octet_length("reversible_fields"::text) <= 81920)
    `);
  }

  /** Refuses to restore the former cap if that would reject an existing receipt. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { has_oversized: boolean }[] = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM "action_ledger_records"
        WHERE octet_length("reversible_fields"::text) > 8192
      ) AS "has_oversized"
    `);
    if (rows[0]?.has_oversized) {
      throw new ActionLedgerReversibleCapRollbackBlockedError();
    }
    await queryRunner.query(`
      ALTER TABLE "action_ledger_records"
        DROP CONSTRAINT "CHK_action_ledger_records_reversible_object",
        ADD CONSTRAINT "CHK_action_ledger_records_reversible_object"
          CHECK (jsonb_typeof("reversible_fields") = 'object' AND octet_length("reversible_fields"::text) <= 8192)
    `);
  }
}
