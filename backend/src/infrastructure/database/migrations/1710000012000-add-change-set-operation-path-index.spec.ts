import { AddChangeSetOperationPathIndex1710000012000 } from '@/infrastructure/database/migrations/1710000012000-add-change-set-operation-path-index';

describe('AddChangeSetOperationPathIndex migration', () => {
  it('adds, backfills, and indexes source and destination paths', async () => {
    const queries: string[] = [];
    const migration = new AddChangeSetOperationPathIndex1710000012000();
    await migration.up({ query: async (query: string) => { queries.push(query); } } as never);
    expect(queries[0]).toContain('ADD COLUMN "operation_paths" text[] NOT NULL');
    expect(queries[1]).toContain("operation.item->>'path'");
    expect(queries[1]).toContain("operation.item->>'destinationPath'");
    expect(queries[2]).toContain('USING GIN ("operation_paths")');
    expect(queries[3]).toContain('("owner_id", "project_id", "created_at" DESC, "id" ASC)');
  });

  it('reverts indexes before removing the projected path column', async () => {
    const queries: string[] = [];
    const migration = new AddChangeSetOperationPathIndex1710000012000();
    await migration.down({ query: async (query: string) => { queries.push(query); } } as never);
    expect(queries).toEqual([
      'DROP INDEX "IDX_ai_run_change_sets_owner_project_created"',
      'DROP INDEX "IDX_ai_run_change_sets_operation_paths"',
      'ALTER TABLE "ai_run_change_sets" DROP COLUMN "operation_paths"'
    ]);
  });
});
