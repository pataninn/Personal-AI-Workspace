import type { QueryRunner } from 'typeorm';

import { CreateAiRunsAndEgress1710000004000 } from '@/infrastructure/database/migrations/1710000004000-create-ai-runs-and-egress';

describe('CreateAiRunsAndEgress1710000004000', () => {
  it('creates and reverses the durable run/consent checkpoint schema', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new CreateAiRunsAndEgress1710000004000();
    const queryRunner = { query } as unknown as QueryRunner;

    await migration.up(queryRunner);
    await migration.down(queryRunner);

    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('CREATE TYPE "ai_run_status"'));
    expect(query).toHaveBeenNthCalledWith(6, expect.stringContaining('CREATE TABLE "ai_runs"'));
    expect(query).toHaveBeenNthCalledWith(7, 'CREATE UNIQUE INDEX "UQ_ai_runs_create_idempotency" ON "ai_runs" ("owner_id", "project_id", "create_idempotency_key")');
    expect(query).toHaveBeenNthCalledWith(8, expect.stringContaining('IDX_ai_runs_owner_project_updated'));
    expect(query).toHaveBeenNthCalledWith(9, expect.stringContaining('IDX_ai_runs_conversation'));
    expect(query).toHaveBeenNthCalledWith(10, expect.stringContaining('IDX_ai_runs_manifest_hash'));
    expect(query).toHaveBeenNthCalledWith(11, 'DROP INDEX "IDX_ai_runs_manifest_hash"');
    expect(query).toHaveBeenNthCalledWith(20, 'DROP TYPE "ai_run_status"');
  });
});
