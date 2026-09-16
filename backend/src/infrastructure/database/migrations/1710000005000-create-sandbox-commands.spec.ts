import type { QueryRunner } from 'typeorm';

import { CreateSandboxCommands1710000005000 } from '@/infrastructure/database/migrations/1710000005000-create-sandbox-commands';

describe('CreateSandboxCommands1710000005000', () => {
  it('creates and reverses the durable command proposal schema', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new CreateSandboxCommands1710000005000();
    const queryRunner = { query } as unknown as QueryRunner;

    await migration.up(queryRunner);
    await migration.down(queryRunner);

    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('sandbox_command_classification'));
    expect(query).toHaveBeenNthCalledWith(4, expect.stringContaining('CREATE TABLE "sandbox_commands"'));
    expect(query).toHaveBeenNthCalledWith(5, expect.stringContaining('UQ_sandbox_commands_create_idempotency'));
    expect(query).toHaveBeenNthCalledWith(6, expect.stringContaining('IDX_sandbox_commands_run_created'));
    expect(query).toHaveBeenNthCalledWith(7, expect.stringContaining('IDX_sandbox_commands_proposal_hash'));
    expect(query).toHaveBeenNthCalledWith(8, 'DROP INDEX "IDX_sandbox_commands_proposal_hash"');
    expect(query).toHaveBeenNthCalledWith(14, 'DROP TYPE "sandbox_command_classification"');
  });
});
