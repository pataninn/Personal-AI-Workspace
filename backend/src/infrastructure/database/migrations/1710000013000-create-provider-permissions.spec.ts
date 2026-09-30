import { CreateProviderPermissions1710000013000 } from '@/infrastructure/database/migrations/1710000013000-create-provider-permissions';

describe('CreateProviderPermissions migration', () => {
  it('creates a project-bound, revocable grant scope and links authorized runs to it', async () => {
    const queries: string[] = [];
    const migration = new CreateProviderPermissions1710000013000();
    await migration.up({ query: async (query: string) => { queries.push(query); } } as never);
    expect(queries[0]).toContain('("owner_id", "id")');
    expect(queries[1]).toContain('"capability" = \'send_selected_context\'');
    expect(queries[1]).toContain('FOREIGN KEY ("owner_id", "project_id")');
    expect(queries[2]).toContain('WHERE "revoked_at" IS NULL');
    expect(queries[4]).toContain('"provider_permission_id" uuid NULL');
    expect(queries[5]).toContain('FOREIGN KEY ("owner_id", "project_id", "provider_permission_id")');
  });

  it('reverts the run reference before removing provider permission storage', async () => {
    const queries: string[] = [];
    const migration = new CreateProviderPermissions1710000013000();
    await migration.down({ query: async (query: string) => { queries.push(query); } } as never);
    expect(queries[0]).toContain('DROP CONSTRAINT "FK_ai_runs_provider_permission_scope"');
    expect(queries[1]).toContain('DROP COLUMN "provider_permission_id"');
    expect(queries.at(-1)).toBe('DROP INDEX "UQ_projects_owner_id"');
  });
});
