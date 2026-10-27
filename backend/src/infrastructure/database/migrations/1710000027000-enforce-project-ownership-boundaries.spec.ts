import type { QueryRunner } from 'typeorm';

import { EnforceProjectOwnershipBoundaries1710000027000 } from '@/infrastructure/database/migrations/1710000027000-enforce-project-ownership-boundaries';

describe('EnforceProjectOwnershipBoundaries1710000027000', () => {
  it('fails closed on ambiguous legacy roots and adds persisted mapping plus composite owner relationships', async () => {
    const statements: string[] = [];
    const query = jest.fn(async (sql: string) => { statements.push(sql); return []; });
    await new EnforceProjectOwnershipBoundaries1710000027000().up({ query } as unknown as QueryRunner);
    const sql = statements.join('\n');

    expect(sql).toContain("WHERE \"scope_key\" = 'local'");
    expect(sql).toContain('IF user_count = 0 THEN');
    expect(sql).toContain('fresh ownership migration requires no user-owned records');
    expect(sql).toContain('ownership migration requires one valid bootstrap owner when users already exist');
    expect(sql).toContain('non-owner legacy project roots require an explicit safe mapping');
    expect(sql).toContain('historical AI run workspace mappings are inconsistent');
    expect(sql).toContain('ADD COLUMN "storage_kind" text NULL');
    expect(sql).toContain("CASE WHEN \"relative_root\" IS NULL THEN NULL ELSE 'legacy' END");
    expect(sql).toContain('ADD CONSTRAINT "FK_ai_runs_conversation_scope"');
    expect(sql).toContain('ADD CONSTRAINT "FK_project_task_suggestions_run_scope"');
    expect(sql).toContain('ADD CONSTRAINT "FK_home_conversations_workspace_owner"');
    expect(sql).not.toContain('ADD CONSTRAINT "FK_project_task_order_states_project_owner"');
    expect(sql).not.toContain('ADD CONSTRAINT "FK_project_tasks_project_owner"');
    expect(sql).toContain('CREATE TRIGGER "TRG_projects_legacy_owner"');
    expect(sql).toContain('CREATE TRIGGER "TRG_users_bootstrap_scope_immutable"');
    expect(sql).toContain('CREATE TRIGGER "TRG_users_bootstrap_scope_delete"');
    expect(sql).toContain('the bootstrap owner scope is immutable');
  });

  it('refuses rollback while managed project or run mappings exist', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ has_managed_storage: true }]);
    await expect(new EnforceProjectOwnershipBoundaries1710000027000().down({ query } as unknown as QueryRunner))
      .rejects.toThrow('Cannot revert workspace ownership boundaries while managed project data exists.');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
