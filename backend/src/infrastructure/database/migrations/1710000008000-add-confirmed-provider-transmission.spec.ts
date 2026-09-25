import type { QueryRunner } from 'typeorm';

import { AddConfirmedProviderTransmission1710000008000 } from '@/infrastructure/database/migrations/1710000008000-add-confirmed-provider-transmission';

describe('AddConfirmedProviderTransmission1710000008000', () => {
  it('adds a durable confirmed transmission value and maps it conservatively on rollback', async () => {
    const queries: string[] = [];
    const queryRunner = { query: async (query: string) => { queries.push(query); } } as unknown as QueryRunner;
    const migration = new AddConfirmedProviderTransmission1710000008000();

    await migration.up(queryRunner);
    await migration.down(queryRunner);

    expect(queries.join('\n')).toContain("'transmitted_confirmed'");
    expect(queries.join('\n')).toContain("SET \"provider_transmission\" = 'unknown'");
    expect(queries.join('\n')).toContain('DROP TYPE "ai_run_provider_transmission_legacy"');
    expect(queries.join('\n')).toContain('DROP TYPE "ai_run_provider_transmission_current"');
  });
});
