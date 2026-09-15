import type { QueryRunner } from 'typeorm';

import { CreateApplicationMetadata1710000000000 } from '@/infrastructure/database/migrations/1710000000000-create-application-metadata';

describe('CreateApplicationMetadata1710000000000', () => {
  it('has reversible SQL for the foundation metadata table', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    // QueryRunner has a large framework surface; this test exercises only its SQL boundary.
    const queryRunner = { query } as unknown as QueryRunner;
    const migration = new CreateApplicationMetadata1710000000000();

    await migration.up(queryRunner);
    await migration.down(queryRunner);

    expect(query).toHaveBeenNthCalledWith(1, 'CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('CREATE TABLE "application_metadata"'));
    expect(query).toHaveBeenNthCalledWith(3, 'DROP TABLE "application_metadata"');
  });
});
