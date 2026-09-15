import type { QueryRunner } from 'typeorm';

import { CreateUsersAndSessions1710000001000 } from '@/infrastructure/database/migrations/1710000001000-create-users-and-sessions';

describe('CreateUsersAndSessions1710000001000', () => {
  it('creates and reverses the local users and opaque sessions schema', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const queryRunner = { query } as unknown as QueryRunner;
    const migration = new CreateUsersAndSessions1710000001000();

    await migration.up(queryRunner);
    await migration.down(queryRunner);

    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('CREATE TABLE "users"'));
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('CREATE TABLE "sessions"'));
    expect(query).toHaveBeenNthCalledWith(3, 'CREATE INDEX "IDX_sessions_user_id" ON "sessions" ("user_id")');
    expect(query).toHaveBeenNthCalledWith(4, 'CREATE INDEX "IDX_sessions_expires_at" ON "sessions" ("expires_at")');
    expect(query).toHaveBeenNthCalledWith(5, 'DROP INDEX "IDX_sessions_expires_at"');
    expect(query).toHaveBeenNthCalledWith(6, 'DROP INDEX "IDX_sessions_user_id"');
    expect(query).toHaveBeenNthCalledWith(7, 'DROP TABLE "sessions"');
    expect(query).toHaveBeenNthCalledWith(8, 'DROP TABLE "users"');
  });
});
