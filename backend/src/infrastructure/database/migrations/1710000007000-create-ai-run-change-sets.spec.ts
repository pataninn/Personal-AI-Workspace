import { CreateAiRunChangeSets1710000007000 } from '@/infrastructure/database/migrations/1710000007000-create-ai-run-change-sets';

describe('CreateAiRunChangeSets migration', () => {
  it('creates reversible change-set status, decision, result, and scope storage', async () => {
    const queries: string[] = [];
    const queryRunner = { query: async (query: string) => { queries.push(query); } } as never;
    const migration = new CreateAiRunChangeSets1710000007000();

    await migration.up(queryRunner);
    await migration.down(queryRunner);

    expect(queries.join('\n')).toContain('CREATE TABLE "ai_run_change_sets"');
    expect(queries.join('\n')).toContain('"operations" jsonb NOT NULL');
    expect(queries.join('\n')).toContain('"result" jsonb NULL');
    expect(queries.join('\n')).toContain('"run_id" uuid NOT NULL');
    expect(queries.join('\n')).toContain('DROP TABLE "ai_run_change_sets"');
  });
});

