import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Stores owner-edited, immutable skill revisions and their Home turn bindings. */
export class CreateSkills1710000035000 implements MigrationInterface {
  public readonly name = 'CreateSkills1710000035000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "skills" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "workspace_id" uuid NULL,
        "current_version" integer NOT NULL DEFAULT 1 CHECK ("current_version" > 0),
        "deleted_at" timestamptz NULL,
        "create_request_key_digest" text NULL CHECK ("create_request_key_digest" IS NULL OR "create_request_key_digest" ~ '^[a-f0-9]{64}$'),
        "create_request_fingerprint" text NULL CHECK ("create_request_fingerprint" IS NULL OR "create_request_fingerprint" ~ '^[a-f0-9]{64}$'),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_skills_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_skills_owner" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_skills_owner_id" UNIQUE ("owner_id", "id"),
        CONSTRAINT "FK_skills_workspace_owner" FOREIGN KEY ("owner_id", "workspace_id") REFERENCES "projects" ("owner_id", "id") ON DELETE CASCADE,
        CONSTRAINT "CHK_skills_create_request_pair" CHECK (("create_request_key_digest" IS NULL) = ("create_request_fingerprint" IS NULL))
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_skills_owner_create_key" ON "skills" ("owner_id", "create_request_key_digest") WHERE "create_request_key_digest" IS NOT NULL');
    await queryRunner.query('CREATE INDEX "IDX_skills_owner_scope_updated" ON "skills" ("owner_id", "workspace_id", "updated_at" DESC, "id") WHERE "deleted_at" IS NULL');
    await queryRunner.query(`
      CREATE TABLE "skill_revisions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "skill_id" uuid NOT NULL,
        "version" integer NOT NULL CHECK ("version" > 0),
        "title" text NOT NULL CHECK (length(btrim("title")) BETWEEN 1 AND 120),
        "instructions" text NOT NULL CHECK (length(btrim("instructions")) > 0 AND octet_length("instructions") <= 16000),
        "enabled" boolean NOT NULL DEFAULT true,
        "declared_tools" jsonb NOT NULL CHECK (jsonb_typeof("declared_tools") = 'array' AND jsonb_array_length("declared_tools") <= 5 AND "declared_tools" <@ '["home_task_read", "home_task_write", "home_workspace_read", "home_workspace_write", "home_action_undo"]'::jsonb),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_skill_revisions_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_skill_revisions_skill_version" UNIQUE ("owner_id", "skill_id", "version"),
        CONSTRAINT "UQ_skill_revisions_version_id" UNIQUE ("owner_id", "skill_id", "version", "id"),
        CONSTRAINT "UQ_skill_revisions_owner_id" UNIQUE ("owner_id", "id"),
        CONSTRAINT "FK_skill_revisions_skill" FOREIGN KEY ("owner_id", "skill_id") REFERENCES "skills" ("owner_id", "id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`ALTER TABLE "skills" ADD CONSTRAINT "FK_skills_current_revision"
      FOREIGN KEY ("owner_id", "id", "current_version") REFERENCES "skill_revisions" ("owner_id", "skill_id", "version") DEFERRABLE INITIALLY DEFERRED`);
    await queryRunner.query('CREATE INDEX "IDX_skill_revisions_owner_skill" ON "skill_revisions" ("owner_id", "skill_id", "version" DESC)');
    await queryRunner.query(`
      CREATE TABLE "skill_invocations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "skill_id" uuid NOT NULL,
        "skill_revision_id" uuid NOT NULL,
        "skill_version" integer NOT NULL,
        "request_key_digest" text NOT NULL CHECK ("request_key_digest" ~ '^[a-f0-9]{64}$'),
        "request_fingerprint" text NOT NULL CHECK ("request_fingerprint" ~ '^[a-f0-9]{64}$'),
        "context_revisions" jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof("context_revisions") = 'array' AND jsonb_array_length("context_revisions") <= 33),
        "state" text NOT NULL DEFAULT 'claimed' CHECK ("state" IN ('claimed', 'bound', 'dispatching', 'accepted', 'unknown', 'denied')),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_skill_invocations_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_skill_invocations_owner_id" UNIQUE ("owner_id", "id"),
        CONSTRAINT "UQ_skill_invocations_owner_conversation_id" UNIQUE ("owner_id", "conversation_id", "id"),
        CONSTRAINT "UQ_skill_invocations_request" UNIQUE ("owner_id", "conversation_id", "request_key_digest"),
        CONSTRAINT "FK_skill_invocations_owner" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_skill_invocations_conversation" FOREIGN KEY ("owner_id", "conversation_id") REFERENCES "home_conversations" ("owner_id", "id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`ALTER TABLE "home_turns" ADD COLUMN "skill_invocation_id" uuid NULL`);
    await queryRunner.query(`ALTER TABLE "home_turns" ADD CONSTRAINT "FK_home_turns_skill_invocation"
      FOREIGN KEY ("owner_id", "conversation_id", "skill_invocation_id") REFERENCES "skill_invocations" ("owner_id", "conversation_id", "id") ON DELETE SET NULL ("skill_invocation_id")`);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_home_turns_skill_invocation" ON "home_turns" ("skill_invocation_id") WHERE "skill_invocation_id" IS NOT NULL');
    await queryRunner.query(`ALTER TABLE "showcase_versions" ADD COLUMN "skills" jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof("skills") = 'array')`);
    await queryRunner.query(`
      CREATE FUNCTION "reject_skill_revision_update"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'skill revisions are immutable';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query('CREATE TRIGGER "TRG_skill_revisions_immutable" BEFORE UPDATE ON "skill_revisions" FOR EACH ROW EXECUTE FUNCTION "reject_skill_revision_update"()');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { readonly has_skills: boolean; readonly has_invocations: boolean; readonly has_turn_bindings: boolean; readonly has_showcase_skills: boolean }[] = await queryRunner.query(`
      SELECT EXISTS (SELECT 1 FROM "skills") AS "has_skills",
             EXISTS (SELECT 1 FROM "skill_invocations") AS "has_invocations",
             EXISTS (SELECT 1 FROM "home_turns" WHERE "skill_invocation_id" IS NOT NULL) AS "has_turn_bindings",
             EXISTS (SELECT 1 FROM "showcase_versions" WHERE "skills" <> '[]'::jsonb) AS "has_showcase_skills"
    `);
    if (rows[0]?.has_skills || rows[0]?.has_invocations || rows[0]?.has_turn_bindings || rows[0]?.has_showcase_skills) {
      throw new Error('Skill rollback is blocked while skills, invocations, turn bindings, or showcase snapshots exist.');
    }
    await queryRunner.query('DROP TRIGGER "TRG_skill_revisions_immutable" ON "skill_revisions"');
    await queryRunner.query('DROP FUNCTION "reject_skill_revision_update"()');
    await queryRunner.query('ALTER TABLE "showcase_versions" DROP COLUMN "skills"');
    await queryRunner.query('DROP INDEX "UQ_home_turns_skill_invocation"');
    await queryRunner.query('ALTER TABLE "home_turns" DROP CONSTRAINT "FK_home_turns_skill_invocation"');
    await queryRunner.query('ALTER TABLE "home_turns" DROP COLUMN "skill_invocation_id"');
    await queryRunner.query('DROP TABLE "skill_invocations"');
    await queryRunner.query('ALTER TABLE "skills" DROP CONSTRAINT "FK_skills_current_revision"');
    await queryRunner.query('DROP INDEX "IDX_skill_revisions_owner_skill"');
    await queryRunner.query('DROP TABLE "skill_revisions"');
    await queryRunner.query('DROP INDEX "IDX_skills_owner_scope_updated"');
    await queryRunner.query('DROP INDEX "UQ_skills_owner_create_key"');
    await queryRunner.query('DROP TABLE "skills"');
  }
}
