import { AddInboxTaskPersistence1710000018000 } from '@/infrastructure/database/migrations/1710000018000-add-inbox-task-persistence';

function queryRunnerFor(flags: Record<string, boolean> = {}) {
  const queries: string[] = [];
  const queryRunner = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('task_owner_mismatch')) {
        return [{ task_owner_mismatch: flags.task_owner_mismatch ?? false, order_state_owner_mismatch: flags.order_state_owner_mismatch ?? false }];
      }
      if (sql.includes('has_inbox_tasks')) {
        return [{
          has_inbox_tasks: flags.has_inbox_tasks ?? false,
          has_changed_inbox_order: flags.has_changed_inbox_order ?? false,
          has_moved_or_orphaned_suggestion_tasks: flags.has_moved_or_orphaned_suggestion_tasks ?? false,
          has_history_incompatible_with_legacy_keys: flags.has_history_incompatible_with_legacy_keys ?? false
        }];
      }
      return [];
    }
  } as never;
  return { queryRunner, queries };
}

describe('AddInboxTaskPersistence migration', () => {
  it('snapshots suggestion provenance and adds owner-scoped Inbox membership, order, and lookup constraints', async () => {
    const { queryRunner, queries } = queryRunnerFor();
    await new AddInboxTaskPersistence1710000018000().up(queryRunner);
    const sql = queries.join('\n');

    expect(sql).toContain('WHERE t."owner_id" <> p."owner_id"');
    expect(sql).toContain('ADD CONSTRAINT "UQ_projects_owner_id" UNIQUE ("owner_id", "id")');
    expect(sql).toContain('"source_suggestion_project_id" = s."project_id"');
    expect(sql).toContain('"source_run_id" = s."run_id"');
    expect(sql).toContain('"source_conversation_id" = s."conversation_id"');
    expect(sql).toContain('DROP CONSTRAINT "FK_project_tasks_source_suggestion"');
    expect(sql).toContain('ALTER COLUMN "project_id" DROP NOT NULL');
    expect(sql).toContain('ADD CONSTRAINT "UQ_project_tasks_owner_task" UNIQUE ("owner_id", "id")');
    expect(sql).toContain('FOREIGN KEY ("owner_id", "project_id") REFERENCES "projects" ("owner_id", "id")');
    expect(sql).toContain('"UQ_project_tasks_inbox_active_position"');
    expect(sql).toContain('"IDX_project_tasks_owner_inbox_status_position"');
    expect(sql).toContain('"UQ_project_tasks_inbox_idempotency"');
    expect(sql).toContain('"UQ_project_task_order_states_inbox_owner"');
    expect(sql).toContain('CREATE TRIGGER "TRG_users_inbox_task_order_state"');
    expect(sql).toContain('DROP CONSTRAINT "FK_project_task_events_run_id"');
    expect(sql).toContain('ADD CONSTRAINT "FK_project_task_events_owner_task"');
  });

  it('rejects pre-existing cross-owner task membership before changing schema', async () => {
    const { queryRunner, queries } = queryRunnerFor({ task_owner_mismatch: true });

    await expect(new AddInboxTaskPersistence1710000018000().up(queryRunner)).rejects.toThrow(/ownership is inconsistent/);
    expect(queries).toHaveLength(1);
  });

  it('checks Inbox data and detached history before rollback DDL, then restores the project constraints safely', async () => {
    const { queryRunner, queries } = queryRunnerFor();
    await new AddInboxTaskPersistence1710000018000().down(queryRunner);
    const sql = queries.join('\n');

    expect(queries[0]).toContain('has_inbox_tasks');
    expect(sql).toContain('DROP TRIGGER "TRG_users_inbox_task_order_state"');
    expect(sql).toContain('DELETE FROM "project_task_order_states" WHERE "project_id" IS NULL');
    expect(sql).toContain('ALTER COLUMN "project_id" SET NOT NULL');
    expect(sql).toContain('ADD CONSTRAINT "FK_project_task_events_task"');
    expect(sql).toContain('ADD CONSTRAINT "FK_project_tasks_source_suggestion"');
    expect(sql).toContain('DROP COLUMN "source_accepted_at"');
    expect(queries[queries.length - 1]).toContain('DROP CONSTRAINT "UQ_projects_owner_id"');
  });

  it('refuses a destructive rollback before dropping any constraints when Inbox data exists', async () => {
    const { queryRunner, queries } = queryRunnerFor({ has_inbox_tasks: true });

    await expect(new AddInboxTaskPersistence1710000018000().down(queryRunner)).rejects.toThrow(/Inbox data or detached task history/);
    expect(queries).toHaveLength(1);
  });
});
