import type { QueryRunner } from 'typeorm';
import { CreateCreditLedger1710000028000 } from '@/infrastructure/database/migrations/1710000028000-create-credit-ledger';

describe('CreateCreditLedger1710000028000', () => {
  it('creates integer account, demo, and provider-call accounting with safe defaults', async () => {
    const statements: string[] = [];
    const query = jest.fn(async (sql: string) => { statements.push(sql); return []; });
    await new CreateCreditLedger1710000028000().up({ query } as unknown as QueryRunner);
    const sql = statements.join('\n');

    expect(sql).toContain('CREATE TABLE "account_limits"');
    expect(sql).toContain('"daily_credit_limit_units" bigint NULL');
    expect(sql).toContain('"lifetime_credit_limit_units" bigint NULL');
    expect(sql).toContain('DEFAULT \'Asia/Shanghai\'');
    expect(sql).toContain('INSERT INTO "account_limits" ("owner_id")');
    expect(sql).toContain('CREATE TABLE "credit_runtime_policy"');
    expect(sql).toContain('"inference_paused" boolean NOT NULL DEFAULT true');
    expect(sql).toContain('VALUES (1, true)');
    expect(sql).toContain('"reserved_units" bigint NOT NULL DEFAULT 0');
    expect(sql).toContain('DEFAULT gen_random_uuid()');
    expect(sql).toContain('CONSTRAINT "UQ_credit_provider_call_attempt" UNIQUE');
    expect(sql).toContain('CONSTRAINT "UQ_credit_usage_call_attempt" UNIQUE');
    expect(sql).not.toContain('uuid_generate_v4');
  });

  it('refuses rollback after usage, reservations, counters, or operator limits exist', async () => {
    const query = jest.fn().mockResolvedValueOnce([{
      has_usage: false,
      has_reservations: false,
      changed_limits: true,
      has_counters: false,
      changed_policy: false
    }]);
    await expect(new CreateCreditLedger1710000028000().down({ query } as unknown as QueryRunner))
      .rejects.toThrow('Credit ledger rollback is blocked');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuses rollback after operator changes the global inference policy', async () => {
    const query = jest.fn().mockResolvedValueOnce([{
      has_usage: false,
      has_reservations: false,
      changed_limits: false,
      has_counters: false,
      changed_policy: true
    }]);
    await expect(new CreateCreditLedger1710000028000().down({ query } as unknown as QueryRunner))
      .rejects.toThrow('Credit ledger rollback is blocked');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('drops empty schema objects in dependency order', async () => {
    const statements: string[] = [];
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT EXISTS')) {
        return [{ has_usage: false, has_reservations: false, changed_limits: false, has_counters: false, changed_policy: false }];
      }
      statements.push(sql);
      return [];
    });
    await new CreateCreditLedger1710000028000().down({ query } as unknown as QueryRunner);
    expect(statements[0]).toBe('DROP TABLE "credit_usage_entries"');
    expect(statements.at(-1)).toBe('DROP TABLE "account_limits"');
  });
});
