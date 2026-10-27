import type { QueryRunner } from 'typeorm';

import { CreateAssistantScopePolicies1710000032000 } from '@/infrastructure/database/migrations/1710000032000-create-assistant-scope-policies';

describe('CreateAssistantScopePolicies1710000032000', () => {
  it('backfills bounded account/workspace profiles, provisions future scopes and versions execution records', async () => {
    const statements: string[] = [];
    const query = jest.fn(async (sql: string) => { statements.push(sql); return []; });
    await new CreateAssistantScopePolicies1710000032000().up({ query } as unknown as QueryRunner);
    const sql = statements.join('\n');

    expect(sql).toContain(`ALTER TYPE "ai_run_decision" ADD VALUE IF NOT EXISTS 'policy_authorized'`);
    expect(sql).toContain(`ALTER TYPE "change_set_decision" ADD VALUE IF NOT EXISTS 'policy_authorized'`);
    expect(sql).toContain(`ALTER TYPE "sandbox_command_decision" ADD VALUE IF NOT EXISTS 'policy_authorized'`);
    expect(sql).toContain('CREATE TABLE "assistant_scope_policies"');
    expect(sql).toContain("'home_in_scope_v1'");
    expect(sql).toContain("'workspace_in_scope_v1'");
    expect(sql).toContain('FOREIGN KEY ("owner_id", "project_id")');
    expect(sql).toContain('"provider_profile" IS NULL AND "model" IS NULL');
    expect(sql).toContain('"enabled" = ("revoked_at" IS NULL)');
    expect(sql).toContain('INSERT INTO "assistant_scope_policies" ("owner_id", "scope_kind", "policy_profile")');
    expect(sql).toContain('CREATE TRIGGER "TRG_users_assistant_scope_policy"');
    expect(sql).toContain('CREATE TRIGGER "TRG_projects_assistant_scope_policy"');
    expect(sql).toContain('ADD COLUMN "policy_revision" bigint NULL');
    expect(sql).toContain('"decision"::text = \'policy_authorized\' AND "policy_revision" IS NOT NULL');
    expect(sql).toContain('ADD COLUMN "home_policy_revision" bigint NULL');
    expect(sql).toContain('ADD COLUMN "workspace_policy_revision" bigint NULL');
  });

  it('refuses rollback when durable policy or execution history exists', async () => {
    const query = jest.fn().mockResolvedValueOnce([{
      has_policies: false,
      has_policy_bound_runs: false,
      has_policy_authorized_runs: false,
      has_policy_authorized_change_sets: false,
      has_policy_authorized_commands: false,
      has_policy_bound_home_turns: true
    }]);
    await expect(new CreateAssistantScopePolicies1710000032000().down({ query } as unknown as QueryRunner))
      .rejects.toThrow('rollback is blocked');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('drops only empty policy-owned objects in dependency order', async () => {
    const statements: string[] = [];
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT EXISTS')) {
        return [{ has_policies: false, has_policy_bound_runs: false, has_policy_authorized_runs: false, has_policy_authorized_change_sets: false, has_policy_authorized_commands: false, has_policy_bound_home_turns: false }];
      }
      statements.push(sql);
      return [];
    });
    await new CreateAssistantScopePolicies1710000032000().down({ query } as unknown as QueryRunner);
    expect(statements[0]).toContain('DROP TRIGGER "TRG_projects_assistant_scope_policy"');
    expect(statements).toContain('DROP TABLE "assistant_scope_policies"');
    expect(statements).toContain('DROP TABLE "assistant_policy_provider_configuration"');
    expect(statements).toContain('ALTER TABLE "ai_runs" ALTER COLUMN "decision" TYPE "ai_run_decision" USING "decision"::text::"ai_run_decision"');
    expect(statements).toContain('ALTER TABLE "ai_run_change_sets" ALTER COLUMN "decision" TYPE "change_set_decision" USING "decision"::text::"change_set_decision"');
    expect(statements).toContain('ALTER TABLE "sandbox_commands" ALTER COLUMN "decision" TYPE "sandbox_command_decision" USING "decision"::text::"sandbox_command_decision"');
    expect(statements).toContain('DROP TYPE "change_set_decision_with_policy"');
    expect(statements).toContain('DROP TYPE "sandbox_command_decision_with_policy"');
  });
});
