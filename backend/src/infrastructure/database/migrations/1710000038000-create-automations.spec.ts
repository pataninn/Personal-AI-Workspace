import type { QueryRunner } from 'typeorm';

import { CreateAutomations1710000038000 } from '@/infrastructure/database/migrations/1710000038000-create-automations';

describe('CreateAutomations1710000038000', () => {
  it('creates durable schedules, occurrence leases, and the Home-turn occurrence fence', async () => {
    const statements: string[] = [];
    const queryRunner = { query: jest.fn(async (sql: string) => { statements.push(sql); return []; }) } as unknown as QueryRunner;

    await new CreateAutomations1710000038000().up(queryRunner);

    expect(statements.some((sql) => sql.includes('CREATE TABLE "automation_schedules"'))).toBe(true);
    expect(statements.some((sql) => sql.includes('UNIQUE ("schedule_id", "intended_for_utc")'))).toBe(true);
    expect(statements.some((sql) => sql.includes('SKIP') === false && sql.includes('lease_expires_at'))).toBe(true);
    expect(statements.some((sql) => sql.includes('ADD COLUMN "automation_occurrence_id"'))).toBe(true);
  });

  it('refuses to roll back while schedules or occurrence bindings exist', async () => {
    const queryRunner = { query: jest.fn(async () => [{ has_schedules: true, has_occurrences: false, has_turn_bindings: false }]) } as unknown as QueryRunner;

    await expect(new CreateAutomations1710000038000().down(queryRunner)).rejects.toThrow('rollback is blocked');
    expect(queryRunner.query).toHaveBeenCalledTimes(1);
  });
});
