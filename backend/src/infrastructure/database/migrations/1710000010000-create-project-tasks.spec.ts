import { CreateProjectTasks1710000010000 } from '@/infrastructure/database/migrations/1710000010000-create-project-tasks';

describe('CreateProjectTasks migration', () => {
  it('creates project-scoped ordered tasks, suggestions, history, and project order state', async () => {
    const queries: string[] = [];
    const queryRunner = { query: async (query: string) => { queries.push(query); } } as never;
    const migration = new CreateProjectTasks1710000010000();

    await migration.up(queryRunner);

    const sql = queries.join('\n');
    expect(sql).toContain('CREATE TYPE "project_task_status"');
    expect(sql).toContain('CREATE TABLE "project_task_order_states"');
    expect(sql).toContain('CREATE TABLE "project_task_suggestions"');
    expect(sql).toContain('UNIQUE INDEX "UQ_project_task_suggestions_run_ordinal"');
    expect(sql).toContain('CREATE TABLE "project_tasks"');
    expect(sql).toContain('"CHK_project_tasks_source_link"');
    expect(sql).toContain('CREATE TABLE "project_task_events"');
    expect(sql).toContain('CREATE TRIGGER "TRG_projects_task_order_state"');
    expect(sql).toContain('INSERT INTO "project_task_order_states"');
  });

  it('reverses only task tables, trigger, indexes, and enums in dependency order', async () => {
    const queries: string[] = [];
    const queryRunner = { query: async (query: string) => { queries.push(query); } } as never;
    const migration = new CreateProjectTasks1710000010000();

    await migration.down(queryRunner);

    expect(queries[0]).toBe('DROP TRIGGER "TRG_projects_task_order_state" ON "projects"');
    expect(queries).toContain('DROP TABLE "project_task_events"');
    expect(queries).toContain('DROP TABLE "project_tasks"');
    expect(queries).toContain('DROP TABLE "project_task_suggestions"');
    expect(queries[queries.length - 1]).toBe('DROP TYPE "project_task_status"');
    expect(queries.some((query) => query.includes('DROP TABLE "projects"'))).toBe(false);
  });
});
