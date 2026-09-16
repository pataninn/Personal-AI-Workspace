import type { QueryRunner } from 'typeorm';

import { CreateAiRunChat1710000006000 } from '@/infrastructure/database/migrations/1710000006000-create-ai-run-chat';

describe('CreateAiRunChat1710000006000', () => {
  it('adds durable run/chat lifecycle columns and reversible indexes', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new CreateAiRunChat1710000006000();
    const queryRunner = { query } as unknown as QueryRunner;

    await migration.up(queryRunner);
    await migration.down(queryRunner);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ALTER TYPE "ai_run_status" ADD VALUE IF NOT EXISTS'));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ADD COLUMN "assistant_message_id" uuid'));
    expect(query).toHaveBeenCalledWith('CREATE UNIQUE INDEX "UQ_ai_runs_start_idempotency" ON "ai_runs" ("owner_id", "id", "start_idempotency_key") WHERE "start_idempotency_key" IS NOT NULL');
    expect(query).toHaveBeenCalledWith('CREATE UNIQUE INDEX "UQ_ai_runs_cancel_idempotency" ON "ai_runs" ("owner_id", "id", "cancel_idempotency_key") WHERE "cancel_idempotency_key" IS NOT NULL');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('DROP COLUMN "runtime_reference"'));
  });
});
