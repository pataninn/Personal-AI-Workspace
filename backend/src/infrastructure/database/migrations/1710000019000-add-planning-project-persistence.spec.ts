import { AddPlanningProjectPersistence1710000019000 } from '@/infrastructure/database/migrations/1710000019000-add-planning-project-persistence';

function queryRunnerFor(flags: Record<string, boolean> = {}) {
  const queries: string[] = [];
  const queryRunner = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('has_planning_projects')) {
        return [{
          has_planning_projects: flags.has_planning_projects ?? false,
          has_project_objectives: flags.has_project_objectives ?? false
        }];
      }
      return [];
    }
  } as never;
  return { queryRunner, queries };
}

describe('AddPlanningProjectPersistence migration', () => {
  it('adds optional objective and permits only fully attached or rootless project rows', async () => {
    const { queryRunner, queries } = queryRunnerFor();
    await new AddPlanningProjectPersistence1710000019000().up(queryRunner);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('ADD COLUMN "objective" text NULL');
    expect(queries[0]).toContain('ALTER COLUMN "relative_root" DROP NOT NULL');
    expect(queries[0]).toContain('ALTER COLUMN "relative_root_key" DROP NOT NULL');
    expect(queries[0]).toContain('ADD CONSTRAINT "CHK_projects_root_pair"');
    expect(queries[0]).toContain('"relative_root" IS NULL AND "relative_root_key" IS NULL');
    expect(queries[0]).toContain('"relative_root" IS NOT NULL AND "relative_root_key" IS NOT NULL');
  });

  it('restores required roots only when rollback cannot discard planning data', async () => {
    const { queryRunner, queries } = queryRunnerFor();
    await new AddPlanningProjectPersistence1710000019000().down(queryRunner);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('has_planning_projects');
    expect(queries[0]).toContain('has_project_objectives');
    expect(queries[1]).toContain('ALTER COLUMN "relative_root" SET NOT NULL');
    expect(queries[1]).toContain('ALTER COLUMN "relative_root_key" SET NOT NULL');
    expect(queries[1]).toContain('DROP COLUMN "objective"');
  });

  it.each([
    { has_planning_projects: true },
    { has_project_objectives: true }
  ])('refuses rollback before DDL while planning data exists: %o', async (flags) => {
    const { queryRunner, queries } = queryRunnerFor(flags);
    await expect(new AddPlanningProjectPersistence1710000019000().down(queryRunner)).rejects.toThrow(/rootless projects or objectives exist/);
    expect(queries).toHaveLength(1);
  });
});
