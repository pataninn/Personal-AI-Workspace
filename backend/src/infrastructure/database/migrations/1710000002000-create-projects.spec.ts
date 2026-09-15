import type { QueryRunner } from 'typeorm';

import { CreateProjects1710000002000 } from '@/infrastructure/database/migrations/1710000002000-create-projects';

describe('CreateProjects1710000002000', () => {
  it('creates and reverses the owner-scoped project schema', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const queryRunner = { query } as unknown as QueryRunner;
    const migration = new CreateProjects1710000002000();

    await migration.up(queryRunner);
    await migration.down(queryRunner);

    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('CREATE TYPE "project_status"'));
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('CREATE TABLE "projects"'));
    expect(query).toHaveBeenNthCalledWith(3, expect.stringContaining('UQ_projects_owner_slug_active'));
    expect(query).toHaveBeenNthCalledWith(4, expect.stringContaining('UQ_projects_owner_root_key_active'));
    expect(query).toHaveBeenNthCalledWith(5, 'CREATE INDEX "IDX_projects_owner_status" ON "projects" ("owner_id", "status")');
    expect(query).toHaveBeenNthCalledWith(6, 'CREATE INDEX "IDX_projects_owner_updated_at" ON "projects" ("owner_id", "updated_at")');
    expect(query).toHaveBeenNthCalledWith(7, 'DROP INDEX "IDX_projects_owner_updated_at"');
    expect(query).toHaveBeenNthCalledWith(8, 'DROP INDEX "IDX_projects_owner_status"');
    expect(query).toHaveBeenNthCalledWith(9, 'DROP INDEX "UQ_projects_owner_root_key_active"');
    expect(query).toHaveBeenNthCalledWith(10, 'DROP INDEX "UQ_projects_owner_slug_active"');
    expect(query).toHaveBeenNthCalledWith(11, 'DROP TABLE "projects"');
    expect(query).toHaveBeenNthCalledWith(12, 'DROP TYPE "project_status"');
  });
});
