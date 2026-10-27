import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Persists workspace storage mapping and closes owner/project relationship gaps. */
export class EnforceProjectOwnershipBoundaries1710000027000 implements MigrationInterface {
  public readonly name = 'EnforceProjectOwnershipBoundaries1710000027000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$
      DECLARE local_owner uuid;
      DECLARE local_scope_count integer;
      DECLARE user_count integer;
      BEGIN
        SELECT "id" INTO local_owner FROM "users" WHERE "scope_key" = 'local' AND "account_kind" = 'regular' AND "role" = 'admin';
        SELECT count(*) INTO local_scope_count FROM "users" WHERE "scope_key" = 'local';
        SELECT count(*) INTO user_count FROM "users";
        IF user_count = 0 THEN
          IF EXISTS (SELECT 1 FROM "projects") OR EXISTS (SELECT 1 FROM "home_conversations") OR EXISTS (SELECT 1 FROM "sessions") THEN
            RAISE EXCEPTION 'fresh ownership migration requires no user-owned records';
          END IF;
        ELSE
          IF local_scope_count <> 1 OR local_owner IS NULL THEN
            RAISE EXCEPTION 'ownership migration requires one valid bootstrap owner when users already exist';
          END IF;
          IF EXISTS (SELECT 1 FROM "projects" WHERE "relative_root" IS NOT NULL AND "owner_id" <> local_owner) THEN
            RAISE EXCEPTION 'non-owner legacy project roots require an explicit safe mapping before managed storage can be enabled';
          END IF;
        END IF;
        IF EXISTS (
          SELECT 1 FROM "ai_runs" r
          LEFT JOIN "projects" p ON p."id" = r."project_id" AND p."owner_id" = r."owner_id"
          LEFT JOIN "conversations" c ON c."id" = r."conversation_id" AND c."owner_id" = r."owner_id" AND c."project_id" = r."project_id"
          WHERE p."id" IS NULL OR c."id" IS NULL OR p."relative_root" IS NULL OR r."relative_root" <> p."relative_root"
        ) THEN
          RAISE EXCEPTION 'historical AI run workspace mappings are inconsistent';
        END IF;
      END $$`);

    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN "storage_kind" text NULL`);
    await queryRunner.query(`UPDATE "projects" SET "storage_kind" = CASE WHEN "relative_root" IS NULL THEN NULL ELSE 'legacy' END`);
    await queryRunner.query(`ALTER TABLE "projects"
      ADD CONSTRAINT "CHK_projects_storage_kind" CHECK (
        ("relative_root" IS NULL AND "storage_kind" IS NULL)
        OR ("relative_root" IS NOT NULL AND "storage_kind" IS NOT NULL AND "storage_kind" IN ('legacy', 'managed'))
      ),
      ADD CONSTRAINT "CHK_projects_managed_root_suffix" CHECK ("storage_kind" <> 'managed' OR "relative_root" = 'projects/' || "id"::text)`);
    await queryRunner.query(`CREATE FUNCTION "enforce_legacy_project_owner"() RETURNS trigger AS $$
      BEGIN
        IF NEW."storage_kind" = 'legacy' AND NOT EXISTS (
          SELECT 1 FROM "users" WHERE "id" = NEW."owner_id" AND "scope_key" = 'local'
        ) THEN
          RAISE EXCEPTION 'legacy project storage is reserved for the bootstrap owner';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(`CREATE TRIGGER "TRG_projects_legacy_owner" BEFORE INSERT OR UPDATE OF "owner_id", "storage_kind" ON "projects" FOR EACH ROW EXECUTE FUNCTION "enforce_legacy_project_owner"()`);

    await queryRunner.query(`CREATE FUNCTION "protect_bootstrap_owner_scope"() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD."scope_key" = 'local' THEN
            RAISE EXCEPTION 'the bootstrap owner scope is immutable';
          END IF;
          RETURN OLD;
        END IF;
        IF TG_OP = 'UPDATE' AND (OLD."scope_key" = 'local' OR NEW."scope_key" = 'local') THEN
          RAISE EXCEPTION 'the bootstrap owner scope is immutable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(`CREATE TRIGGER "TRG_users_bootstrap_scope_immutable" BEFORE UPDATE OF "scope_key" ON "users" FOR EACH ROW EXECUTE FUNCTION "protect_bootstrap_owner_scope"()`);
    await queryRunner.query(`CREATE TRIGGER "TRG_users_bootstrap_scope_delete" BEFORE DELETE ON "users" FOR EACH ROW EXECUTE FUNCTION "protect_bootstrap_owner_scope"()`);

    await queryRunner.query(`ALTER TABLE "ai_runs" ADD COLUMN "storage_kind" text NULL`);
    await queryRunner.query(`UPDATE "ai_runs" r SET "storage_kind" = p."storage_kind" FROM "projects" p WHERE p."id" = r."project_id" AND p."owner_id" = r."owner_id"`);
    await queryRunner.query(`ALTER TABLE "ai_runs" ALTER COLUMN "storage_kind" SET NOT NULL,
      ADD CONSTRAINT "CHK_ai_runs_storage_kind" CHECK ("storage_kind" IN ('legacy', 'managed'))`);

    await queryRunner.query(`ALTER TABLE "conversations"
      ADD CONSTRAINT "UQ_conversations_owner_project_id" UNIQUE ("owner_id", "project_id", "id"),
      ADD CONSTRAINT "FK_conversations_project_owner" FOREIGN KEY ("owner_id", "project_id") REFERENCES "projects" ("owner_id", "id") ON DELETE CASCADE`);
    await queryRunner.query(`ALTER TABLE "conversation_idempotency_keys"
      ADD CONSTRAINT "FK_conversation_idempotency_project_owner" FOREIGN KEY ("owner_id", "project_id") REFERENCES "projects" ("owner_id", "id") ON DELETE CASCADE,
      ADD CONSTRAINT "FK_conversation_idempotency_conversation_scope" FOREIGN KEY ("owner_id", "project_id", "conversation_id") REFERENCES "conversations" ("owner_id", "project_id", "id") ON DELETE CASCADE`);
    await queryRunner.query(`ALTER TABLE "ai_runs"
      ADD CONSTRAINT "UQ_ai_runs_owner_project_id" UNIQUE ("owner_id", "project_id", "id"),
      ADD CONSTRAINT "FK_ai_runs_project_owner" FOREIGN KEY ("owner_id", "project_id") REFERENCES "projects" ("owner_id", "id") ON DELETE CASCADE,
      ADD CONSTRAINT "FK_ai_runs_conversation_scope" FOREIGN KEY ("owner_id", "project_id", "conversation_id") REFERENCES "conversations" ("owner_id", "project_id", "id") ON DELETE CASCADE`);
    await queryRunner.query(`ALTER TABLE "sandbox_commands"
      ADD CONSTRAINT "FK_sandbox_commands_project_owner" FOREIGN KEY ("owner_id", "project_id") REFERENCES "projects" ("owner_id", "id") ON DELETE CASCADE,
      ADD CONSTRAINT "FK_sandbox_commands_run_scope" FOREIGN KEY ("owner_id", "project_id", "run_id") REFERENCES "ai_runs" ("owner_id", "project_id", "id") ON DELETE CASCADE`);
    await queryRunner.query(`ALTER TABLE "ai_run_change_sets"
      ADD CONSTRAINT "FK_ai_run_change_sets_project_owner" FOREIGN KEY ("owner_id", "project_id") REFERENCES "projects" ("owner_id", "id") ON DELETE CASCADE,
      ADD CONSTRAINT "FK_ai_run_change_sets_run_scope" FOREIGN KEY ("owner_id", "project_id", "run_id") REFERENCES "ai_runs" ("owner_id", "project_id", "id") ON DELETE CASCADE`);
    await queryRunner.query(`ALTER TABLE "project_facts"
      ADD CONSTRAINT "FK_project_facts_project_owner" FOREIGN KEY ("owner_id", "project_id") REFERENCES "projects" ("owner_id", "id") ON DELETE CASCADE`);
    // The inbox-persistence migration already installed this composite relationship.
    await queryRunner.query(`ALTER TABLE "project_task_suggestions"
      ADD CONSTRAINT "FK_project_task_suggestions_project_owner" FOREIGN KEY ("owner_id", "project_id") REFERENCES "projects" ("owner_id", "id") ON DELETE CASCADE,
      ADD CONSTRAINT "FK_project_task_suggestions_run_scope" FOREIGN KEY ("owner_id", "project_id", "run_id") REFERENCES "ai_runs" ("owner_id", "project_id", "id") ON DELETE CASCADE,
      ADD CONSTRAINT "FK_project_task_suggestions_conversation_scope" FOREIGN KEY ("owner_id", "project_id", "conversation_id") REFERENCES "conversations" ("owner_id", "project_id", "id") ON DELETE CASCADE`);
    // The inbox-persistence migration already installed this composite relationship.
    await queryRunner.query(`ALTER TABLE "project_task_events"
      ADD CONSTRAINT "FK_project_task_events_project_owner" FOREIGN KEY ("owner_id", "project_id") REFERENCES "projects" ("owner_id", "id") ON DELETE CASCADE,
      ADD CONSTRAINT "FK_project_task_events_run_scope" FOREIGN KEY ("owner_id", "project_id", "run_id") REFERENCES "ai_runs" ("owner_id", "project_id", "id") ON DELETE CASCADE,
      ADD CONSTRAINT "CHK_project_task_events_actor_owner" CHECK ("actor_kind" <> 'user' OR "actor_user_id" = "owner_id")`);
    await queryRunner.query(`ALTER TABLE "home_conversations"
      ADD CONSTRAINT "FK_home_conversations_workspace_owner" FOREIGN KEY ("owner_id", "workspace_id") REFERENCES "projects" ("owner_id", "id") ON DELETE CASCADE`);
    await queryRunner.query(`ALTER TABLE "home_change_proposals"
      ADD CONSTRAINT "FK_home_change_proposals_workspace_owner" FOREIGN KEY ("owner_id", "scope_id") REFERENCES "projects" ("owner_id", "id") ON DELETE CASCADE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { has_managed_storage: boolean }[] = await queryRunner.query(`
      SELECT EXISTS (SELECT 1 FROM "projects" WHERE "storage_kind" = 'managed')
        OR EXISTS (SELECT 1 FROM "ai_runs" WHERE "storage_kind" = 'managed') AS "has_managed_storage"
    `);
    if (rows[0]?.has_managed_storage) throw new Error('Cannot revert workspace ownership boundaries while managed project data exists.');

    await queryRunner.query(`ALTER TABLE "home_change_proposals" DROP CONSTRAINT "FK_home_change_proposals_workspace_owner"`);
    await queryRunner.query(`ALTER TABLE "home_conversations" DROP CONSTRAINT "FK_home_conversations_workspace_owner"`);
    await queryRunner.query(`ALTER TABLE "project_task_events" DROP CONSTRAINT "CHK_project_task_events_actor_owner", DROP CONSTRAINT "FK_project_task_events_run_scope", DROP CONSTRAINT "FK_project_task_events_project_owner"`);
    await queryRunner.query(`ALTER TABLE "project_task_suggestions" DROP CONSTRAINT "FK_project_task_suggestions_conversation_scope", DROP CONSTRAINT "FK_project_task_suggestions_run_scope", DROP CONSTRAINT "FK_project_task_suggestions_project_owner"`);
    await queryRunner.query(`ALTER TABLE "project_facts" DROP CONSTRAINT "FK_project_facts_project_owner"`);
    await queryRunner.query(`ALTER TABLE "ai_run_change_sets" DROP CONSTRAINT "FK_ai_run_change_sets_run_scope", DROP CONSTRAINT "FK_ai_run_change_sets_project_owner"`);
    await queryRunner.query(`ALTER TABLE "sandbox_commands" DROP CONSTRAINT "FK_sandbox_commands_run_scope", DROP CONSTRAINT "FK_sandbox_commands_project_owner"`);
    await queryRunner.query(`ALTER TABLE "ai_runs" DROP CONSTRAINT "FK_ai_runs_conversation_scope", DROP CONSTRAINT "FK_ai_runs_project_owner", DROP CONSTRAINT "UQ_ai_runs_owner_project_id", DROP CONSTRAINT "CHK_ai_runs_storage_kind", DROP COLUMN "storage_kind"`);
    await queryRunner.query(`ALTER TABLE "conversation_idempotency_keys" DROP CONSTRAINT "FK_conversation_idempotency_conversation_scope", DROP CONSTRAINT "FK_conversation_idempotency_project_owner"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP CONSTRAINT "FK_conversations_project_owner", DROP CONSTRAINT "UQ_conversations_owner_project_id"`);
    await queryRunner.query(`DROP TRIGGER "TRG_projects_legacy_owner" ON "projects"`);
    await queryRunner.query(`DROP FUNCTION "enforce_legacy_project_owner"()`);
    await queryRunner.query(`DROP TRIGGER "TRG_users_bootstrap_scope_delete" ON "users"`);
    await queryRunner.query(`DROP TRIGGER "TRG_users_bootstrap_scope_immutable" ON "users"`);
    await queryRunner.query(`DROP FUNCTION "protect_bootstrap_owner_scope"()`);
    await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT "CHK_projects_managed_root_suffix", DROP CONSTRAINT "CHK_projects_storage_kind", DROP COLUMN "storage_kind"`);
  }
}
