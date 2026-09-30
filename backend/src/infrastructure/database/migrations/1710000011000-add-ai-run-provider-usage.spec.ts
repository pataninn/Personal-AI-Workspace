import { AddAiRunProviderUsage1710000011000 } from '@/infrastructure/database/migrations/1710000011000-add-ai-run-provider-usage';

describe('AddAiRunProviderUsage migration', () => {
  it('adds nullable provider counts, nonnegative constraints, and the project activity index', async () => {
    const queries: string[] = [];
    const migration = new AddAiRunProviderUsage1710000011000();
    const queryRunner = { query: async (query: string) => { queries.push(query); } } as never;

    await migration.up(queryRunner);

    expect(queries[0]).toContain('ADD COLUMN "provider_prompt_tokens" bigint NULL');
    expect(queries[0]).toContain('"provider_total_tokens" >= 0');
    expect(queries[1]).toContain('"owner_id", "project_id", "created_at" DESC, "id" ASC');
  });

  it('reverts the index, constraints, and usage columns', async () => {
    const queries: string[] = [];
    const migration = new AddAiRunProviderUsage1710000011000();
    const queryRunner = { query: async (query: string) => { queries.push(query); } } as never;

    await migration.down(queryRunner);

    expect(queries[0]).toBe('DROP INDEX "IDX_ai_runs_owner_project_created"');
    expect(queries[1]).toContain('DROP COLUMN "provider_prompt_tokens"');
  });
});
