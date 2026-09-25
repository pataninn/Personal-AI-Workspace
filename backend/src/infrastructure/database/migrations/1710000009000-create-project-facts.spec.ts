import { CreateProjectFacts1710000009000 } from '@/infrastructure/database/migrations/1710000009000-create-project-facts';

describe('CreateProjectFacts migration', () => {
  it('creates project-owned versioned facts and reverses the schema change', async () => {
    const queries: string[] = [];
    const queryRunner = { query: async (query: string) => { queries.push(query); } } as never;
    const migration = new CreateProjectFacts1710000009000();

    await migration.up(queryRunner);
    await migration.down(queryRunner);

    expect(queries.join('\n')).toContain('CREATE TABLE "project_facts"');
    expect(queries.join('\n')).toContain('"project_id" uuid NOT NULL');
    expect(queries.join('\n')).toContain('"verified_at" TIMESTAMPTZ NULL');
    expect(queries.join('\n')).toContain('"deleted_at" TIMESTAMPTZ NULL');
    expect(queries.join('\n')).toContain('CREATE UNIQUE INDEX "UQ_project_facts_active_key"');
    expect(queries.join('\n')).toContain('DROP TABLE "project_facts"');
  });
});
