import type { QueryRunner } from 'typeorm';

import { ActionLedgerRollbackBlockedError } from '@/modules/action-ledger/domain/action-ledger-errors';
import { CreateActionLedgerPersistence1710000021000 } from '@/infrastructure/database/migrations/1710000021000-create-action-ledger-persistence';

describe('CreateActionLedgerPersistence1710000021000', () => {
  it('creates owner-scoped replay and non-cascading undo links without target or turn dependencies', async () => {
    const statements: string[] = [];
    const runner = { query: jest.fn(async (sql: string) => { statements.push(sql); return []; }) } as unknown as QueryRunner;

    await new CreateActionLedgerPersistence1710000021000().up(runner);

    const tableSql = statements.find((statement) => statement.includes('CREATE TABLE "action_ledger_records"'));
    expect(tableSql).toContain('UNIQUE ("owner_id", "operation_key")');
    expect(tableSql).toContain('"actor_kind" <> \'manual\' OR "turn_id" IS NULL');
    expect(tableSql).toContain('REFERENCES "action_ledger_records" ("owner_id", "id")');
    expect(tableSql).toContain('FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE');
    expect(tableSql).toContain('"undo_of_action_id") REFERENCES "action_ledger_records" ("owner_id", "id") ON DELETE NO ACTION');
    expect(tableSql).toContain('"undo_action_id") REFERENCES "action_ledger_records" ("owner_id", "id") ON DELETE NO ACTION');
    expect(tableSql).not.toContain('"undo_of_action_id") REFERENCES "action_ledger_records" ("owner_id", "id") ON DELETE CASCADE');
    expect(tableSql).not.toContain('"undo_action_id") REFERENCES "action_ledger_records" ("owner_id", "id") ON DELETE CASCADE');
    expect(tableSql).not.toMatch(/FOREIGN KEY\s*\([^)]*"target_id"/);
    expect(statements.some((statement) => statement.includes('turn identity only'))).toBe(true);
  });

  it('refuses rollback before dropping schema while action receipts exist', async () => {
    const statements: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        return [{ has_records: true }];
      })
    } as unknown as QueryRunner;

    await expect(new CreateActionLedgerPersistence1710000021000().down(runner)).rejects.toBeInstanceOf(ActionLedgerRollbackBlockedError);

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('SELECT EXISTS');
  });

  it('drops the additive schema only after confirming that it is empty', async () => {
    const statements: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        return [{ has_records: false }];
      })
    } as unknown as QueryRunner;

    await new CreateActionLedgerPersistence1710000021000().down(runner);

    expect(statements[0]).toContain('SELECT EXISTS');
    expect(statements[statements.length - 1]).toContain('DROP TYPE "action_ledger_actor_kind"');
  });
});
