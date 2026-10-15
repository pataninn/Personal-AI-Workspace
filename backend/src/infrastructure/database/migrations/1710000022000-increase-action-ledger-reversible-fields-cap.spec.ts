import type { QueryRunner } from 'typeorm';

import { ActionLedgerReversibleCapRollbackBlockedError } from '@/modules/action-ledger/domain/action-ledger-errors';
import { IncreaseActionLedgerReversibleFieldsCap1710000022000 } from '@/infrastructure/database/migrations/1710000022000-increase-action-ledger-reversible-fields-cap';

describe('IncreaseActionLedgerReversibleFieldsCap1710000022000', () => {
  it('raises only the reversible-fields database cap to 80 KiB', async () => {
    const statements: string[] = [];
    const runner = { query: jest.fn(async (sql: string) => { statements.push(sql); return []; }) } as unknown as QueryRunner;

    await new IncreaseActionLedgerReversibleFieldsCap1710000022000().up(runner);

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('<= 81920');
    expect(statements[0]).not.toContain('"outcome"');
  });

  it('refuses down migration before changing the constraint if a receipt exceeds the old cap', async () => {
    const statements: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        return [{ has_oversized: true }];
      })
    } as unknown as QueryRunner;

    await expect(new IncreaseActionLedgerReversibleFieldsCap1710000022000().down(runner))
      .rejects.toBeInstanceOf(ActionLedgerReversibleCapRollbackBlockedError);

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('octet_length("reversible_fields"::text) > 8192');
  });

  it('restores the old cap only after confirming all receipts fit it', async () => {
    const statements: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        return [{ has_oversized: false }];
      })
    } as unknown as QueryRunner;

    await new IncreaseActionLedgerReversibleFieldsCap1710000022000().down(runner);

    expect(statements).toHaveLength(2);
    expect(statements[1]).toContain('<= 8192');
  });
});
