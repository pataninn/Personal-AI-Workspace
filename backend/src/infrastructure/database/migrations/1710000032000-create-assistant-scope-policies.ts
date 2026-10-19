import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Stores bounded, versioned authorization profiles for Home and owned workspaces. */
export class CreateAssistantScopePolicies1710000032000 implements MigrationInterface {
  public readonly name = 'CreateAssistantScopePolicies1710000032000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // This value records server policy authority; it is distinct from a user's legacy approval.
    // It is only written by later requests after this migration has committed.
    await queryRunner.query(`ALTER TYPE "ai_run_decision" ADD VALUE IF NOT EXISTS 'policy_authorized'`);
    await queryRunner.query(`ALTER TYPE "change_set_decision" ADD VALUE IF NOT EXISTS 'policy_authorized'`);
    await queryRunner.query(`ALTER TYPE "sandbox_command_decision" ADD VALUE IF NOT EXISTS 'policy_authorized'`);
    await queryRunner.query(`
      CREATE TABLE "assistant_policy_provider_configuration" (
        "singleton_id" boolean NOT NULL DEFAULT true,
        "provider_profile" text NULL,
        "model" text NULL,
        "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "PK_assistant_policy_provider_configuration" PRIMARY KEY ("singleton_id"),
        CONSTRAINT "CHK_assistant_policy_provider_configuration_singleton" CHECK ("singleton_id" = true),
        CONSTRAINT "CHK_assistant_policy_provider_configuration_pair" CHECK (
          ("provider_profile" IS NULL AND "model" IS NULL)
          OR ("provider_profile" IS NOT NULL AND length("provider_profile") BETWEEN 1 AND 100
              AND "model" IS NOT NULL AND length("model") BETWEEN 1 AND 200)
        )
      )
    `);
    await queryRunner.query('INSERT INTO "assistant_policy_provider_configuration" ("singleton_id") VALUES (true)');
    await queryRunner.query(`
      CREATE TABLE "assistant_scope_policies" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "scope_kind" text NOT NULL,
        "project_id" uuid NULL,
        "policy_profile" text NOT NULL,
        "provider_profile" text NULL,
        "model" text NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "revoked_at" timestamptz NULL,
        "revision" bigint NOT NULL DEFAULT 1,
        "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "PK_assistant_scope_policies_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_assistant_scope_policies_scope" CHECK (
          ("scope_kind" = 'home' AND "project_id" IS NULL AND "policy_profile" = 'home_in_scope_v1')
          OR ("scope_kind" = 'project' AND "project_id" IS NOT NULL AND "policy_profile" = 'workspace_in_scope_v1')
        ),
        CONSTRAINT "CHK_assistant_scope_policies_provider_pair" CHECK (
          ("provider_profile" IS NULL AND "model" IS NULL)
          OR ("provider_profile" IS NOT NULL AND length("provider_profile") BETWEEN 1 AND 100
              AND "model" IS NOT NULL AND length("model") BETWEEN 1 AND 200)
        ),
        CONSTRAINT "CHK_assistant_scope_policies_revocation" CHECK ("enabled" = ("revoked_at" IS NULL)),
        CONSTRAINT "CHK_assistant_scope_policies_revision" CHECK ("revision" > 0),
        CONSTRAINT "FK_assistant_scope_policies_owner" FOREIGN KEY ("owner_id")
          REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_assistant_scope_policies_project_owner" FOREIGN KEY ("owner_id", "project_id")
          REFERENCES "projects" ("owner_id", "id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_assistant_scope_policies_home_owner"
      ON "assistant_scope_policies" ("owner_id") WHERE "scope_kind" = 'home'`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_assistant_scope_policies_project_owner"
      ON "assistant_scope_policies" ("owner_id", "project_id") WHERE "scope_kind" = 'project'`);
    await queryRunner.query('CREATE INDEX "IDX_assistant_scope_policies_owner_enabled" ON "assistant_scope_policies" ("owner_id", "enabled")');

    await queryRunner.query(`
      INSERT INTO "assistant_scope_policies" ("owner_id", "scope_kind", "policy_profile")
      SELECT "id", 'home', 'home_in_scope_v1' FROM "users"
      ON CONFLICT DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO "assistant_scope_policies" ("owner_id", "scope_kind", "project_id", "policy_profile")
      SELECT "owner_id", 'project', "id", 'workspace_in_scope_v1' FROM "projects"
      ON CONFLICT DO NOTHING
    `);

    // Database-level provisioning covers regular, demo, bootstrap, and future cloned scopes
    // without introducing a second caller-controlled policy creation path.
    await queryRunner.query(`CREATE FUNCTION "ensure_home_assistant_scope_policy"() RETURNS trigger AS $$
      BEGIN
        INSERT INTO "assistant_scope_policies" ("owner_id", "scope_kind", "policy_profile", "provider_profile", "model")
        SELECT NEW."id", 'home', 'home_in_scope_v1', "provider_profile", "model"
        FROM "assistant_policy_provider_configuration" WHERE "singleton_id" = true
        ON CONFLICT DO NOTHING;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(`CREATE TRIGGER "TRG_users_assistant_scope_policy"
      AFTER INSERT ON "users" FOR EACH ROW EXECUTE FUNCTION "ensure_home_assistant_scope_policy"()`);
    await queryRunner.query(`CREATE FUNCTION "ensure_project_assistant_scope_policy"() RETURNS trigger AS $$
      BEGIN
        INSERT INTO "assistant_scope_policies" ("owner_id", "scope_kind", "project_id", "policy_profile", "provider_profile", "model")
        SELECT NEW."owner_id", 'project', NEW."id", 'workspace_in_scope_v1', "provider_profile", "model"
        FROM "assistant_policy_provider_configuration" WHERE "singleton_id" = true
        ON CONFLICT DO NOTHING;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(`CREATE TRIGGER "TRG_projects_assistant_scope_policy"
      AFTER INSERT ON "projects" FOR EACH ROW EXECUTE FUNCTION "ensure_project_assistant_scope_policy"()`);

    await queryRunner.query(`ALTER TABLE "ai_runs"
      ADD COLUMN "policy_revision" bigint NULL,
      ADD CONSTRAINT "CHK_ai_runs_policy_revision" CHECK (
        ("policy_revision" IS NULL OR "policy_revision" > 0)
        AND (("decision"::text = 'policy_authorized' AND "policy_revision" IS NOT NULL)
          OR ("decision"::text <> 'policy_authorized' AND "policy_revision" IS NULL))
      )`);
    await queryRunner.query(`ALTER TABLE "home_turns"
      ADD COLUMN "home_policy_revision" bigint NULL,
      ADD COLUMN "workspace_policy_revision" bigint NULL,
      ADD CONSTRAINT "CHK_home_turns_home_policy_revision" CHECK ("home_policy_revision" IS NULL OR "home_policy_revision" > 0),
      ADD CONSTRAINT "CHK_home_turns_workspace_policy_revision" CHECK ("workspace_policy_revision" IS NULL OR "workspace_policy_revision" > 0)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { has_policies: boolean; has_policy_bound_runs: boolean; has_policy_bound_home_turns: boolean; has_policy_authorized_runs: boolean; has_policy_authorized_change_sets: boolean; has_policy_authorized_commands: boolean }[] =
      await queryRunner.query(`
        SELECT EXISTS (SELECT 1 FROM "assistant_scope_policies") AS "has_policies",
          EXISTS (SELECT 1 FROM "ai_runs" WHERE "policy_revision" IS NOT NULL) AS "has_policy_bound_runs",
          EXISTS (SELECT 1 FROM "ai_runs" WHERE "decision"::text = 'policy_authorized') AS "has_policy_authorized_runs",
          EXISTS (SELECT 1 FROM "ai_run_change_sets" WHERE "decision"::text = 'policy_authorized') AS "has_policy_authorized_change_sets",
          EXISTS (SELECT 1 FROM "sandbox_commands" WHERE "decision"::text = 'policy_authorized') AS "has_policy_authorized_commands",
          EXISTS (SELECT 1 FROM "home_turns" WHERE "home_policy_revision" IS NOT NULL OR "workspace_policy_revision" IS NOT NULL) AS "has_policy_bound_home_turns"
      `);
    if (rows[0]?.has_policies || rows[0]?.has_policy_bound_runs || rows[0]?.has_policy_authorized_runs
      || rows[0]?.has_policy_authorized_change_sets || rows[0]?.has_policy_authorized_commands || rows[0]?.has_policy_bound_home_turns) {
      throw new Error('Assistant scope policy rollback is blocked while policies or policy-bound history exists.');
    }

    await queryRunner.query('DROP TRIGGER "TRG_projects_assistant_scope_policy" ON "projects"');
    await queryRunner.query('DROP FUNCTION "ensure_project_assistant_scope_policy"()');
    await queryRunner.query('DROP TRIGGER "TRG_users_assistant_scope_policy" ON "users"');
    await queryRunner.query('DROP FUNCTION "ensure_home_assistant_scope_policy"()');
    await queryRunner.query(`ALTER TABLE "home_turns"
      DROP CONSTRAINT "CHK_home_turns_workspace_policy_revision",
      DROP CONSTRAINT "CHK_home_turns_home_policy_revision",
      DROP COLUMN "workspace_policy_revision",
      DROP COLUMN "home_policy_revision"`);
    await queryRunner.query(`ALTER TABLE "ai_runs"
      DROP CONSTRAINT "CHK_ai_runs_policy_revision",
      DROP COLUMN "policy_revision"`);
    await queryRunner.query('DROP INDEX "IDX_assistant_scope_policies_owner_enabled"');
    await queryRunner.query('DROP INDEX "UQ_assistant_scope_policies_project_owner"');
    await queryRunner.query('DROP INDEX "UQ_assistant_scope_policies_home_owner"');
    await queryRunner.query('DROP TABLE "assistant_scope_policies"');
    await queryRunner.query('DROP TABLE "assistant_policy_provider_configuration"');
    await queryRunner.query(`ALTER TYPE "ai_run_decision" RENAME TO "ai_run_decision_with_policy"`);
    await queryRunner.query(`CREATE TYPE "ai_run_decision" AS ENUM ('pending', 'approved', 'rejected')`);
    await queryRunner.query(`ALTER TABLE "ai_runs" ALTER COLUMN "decision" TYPE "ai_run_decision" USING "decision"::text::"ai_run_decision"`);
    await queryRunner.query('DROP TYPE "ai_run_decision_with_policy"');
    await queryRunner.query(`ALTER TYPE "change_set_decision" RENAME TO "change_set_decision_with_policy"`);
    await queryRunner.query(`CREATE TYPE "change_set_decision" AS ENUM ('pending', 'approved', 'rejected')`);
    await queryRunner.query(`ALTER TABLE "ai_run_change_sets" ALTER COLUMN "decision" TYPE "change_set_decision" USING "decision"::text::"change_set_decision"`);
    await queryRunner.query('DROP TYPE "change_set_decision_with_policy"');
    await queryRunner.query(`ALTER TYPE "sandbox_command_decision" RENAME TO "sandbox_command_decision_with_policy"`);
    await queryRunner.query(`CREATE TYPE "sandbox_command_decision" AS ENUM ('pending', 'approved', 'rejected', 'not_applicable')`);
    await queryRunner.query(`ALTER TABLE "sandbox_commands" ALTER COLUMN "decision" TYPE "sandbox_command_decision" USING "decision"::text::"sandbox_command_decision"`);
    await queryRunner.query('DROP TYPE "sandbox_command_decision_with_policy"');
  }
}
