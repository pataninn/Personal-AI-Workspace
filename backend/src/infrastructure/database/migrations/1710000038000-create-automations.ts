import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Persists one workspace-scoped schedule and its fenced Home-turn occurrences. */
export class CreateAutomations1710000038000 implements MigrationInterface {
  public readonly name = 'CreateAutomations1710000038000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "automation_schedules" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "workspace_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "skill_id" uuid NOT NULL,
        "skill_revision_id" uuid NOT NULL,
        "skill_version" integer NOT NULL CHECK ("skill_version" > 0),
        "local_time" time NOT NULL,
        "time_zone" text NOT NULL CHECK (length("time_zone") BETWEEN 1 AND 128),
        "enabled" boolean NOT NULL DEFAULT true,
        "revision" integer NOT NULL DEFAULT 1 CHECK ("revision" > 0),
        "next_due_at" timestamptz NULL,
        "create_key_digest" text NOT NULL CHECK ("create_key_digest" ~ '^[a-f0-9]{64}$'),
        "request_fingerprint" text NOT NULL CHECK ("request_fingerprint" ~ '^[a-f0-9]{64}$'),
        "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "PK_automation_schedules_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_automation_schedules_owner_id" UNIQUE ("owner_id", "id"),
        CONSTRAINT "UQ_automation_schedules_scope" UNIQUE ("owner_id", "id", "conversation_id"),
        CONSTRAINT "UQ_automation_schedules_create_key" UNIQUE ("owner_id", "create_key_digest"),
        CONSTRAINT "FK_automation_schedules_owner" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_automation_schedules_workspace" FOREIGN KEY ("owner_id", "workspace_id") REFERENCES "projects" ("owner_id", "id") ON DELETE CASCADE,
        CONSTRAINT "FK_automation_schedules_conversation" FOREIGN KEY ("owner_id", "conversation_id") REFERENCES "home_conversations" ("owner_id", "id") ON DELETE CASCADE,
        CONSTRAINT "FK_automation_schedules_skill" FOREIGN KEY ("owner_id", "skill_id") REFERENCES "skills" ("owner_id", "id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_automation_schedules_due" ON "automation_schedules" ("next_due_at", "id") WHERE "enabled" = true');
    await queryRunner.query(`
      CREATE TABLE "automation_occurrences" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "schedule_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "kind" text NOT NULL CHECK ("kind" IN ('scheduled', 'manual')),
        "intended_for_utc" timestamptz NOT NULL,
        "local_date" date NOT NULL,
        "status" text NOT NULL DEFAULT 'queued' CHECK ("status" IN ('queued', 'claimed', 'dispatching', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'interrupted_unknown', 'skipped')),
        "schedule_revision" integer NOT NULL CHECK ("schedule_revision" > 0),
        "skill_version" integer NOT NULL CHECK ("skill_version" > 0),
        "skill_revision_id" uuid NOT NULL,
        "request_key_digest" text NOT NULL CHECK ("request_key_digest" ~ '^[a-f0-9]{64}$'),
        "request_fingerprint" text NOT NULL CHECK ("request_fingerprint" ~ '^[a-f0-9]{64}$'),
        "skill_invocation_id" uuid NULL,
        "home_turn_id" uuid NULL,
        "attempt_count" integer NOT NULL DEFAULT 0 CHECK ("attempt_count" BETWEEN 0 AND 3),
        "failure_code" text NULL CHECK ("failure_code" IS NULL OR length("failure_code") BETWEEN 1 AND 64),
        "claim_generation" bigint NOT NULL DEFAULT 0 CHECK ("claim_generation" >= 0),
        "lease_token" uuid NULL,
        "lease_expires_at" timestamptz NULL,
        "heartbeat_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "PK_automation_occurrences_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_automation_occurrences_owner_id" UNIQUE ("owner_id", "id"),
        CONSTRAINT "UQ_automation_occurrences_owner_conversation_id" UNIQUE ("owner_id", "conversation_id", "id"),
        CONSTRAINT "UQ_automation_occurrences_schedule_instant" UNIQUE ("schedule_id", "intended_for_utc"),
        CONSTRAINT "UQ_automation_occurrences_request" UNIQUE ("owner_id", "schedule_id", "request_key_digest"),
        CONSTRAINT "FK_automation_occurrences_owner" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_automation_occurrences_schedule" FOREIGN KEY ("owner_id", "schedule_id", "conversation_id") REFERENCES "automation_schedules" ("owner_id", "id", "conversation_id") ON DELETE CASCADE,
        CONSTRAINT "FK_automation_occurrences_conversation" FOREIGN KEY ("owner_id", "conversation_id") REFERENCES "home_conversations" ("owner_id", "id") ON DELETE CASCADE,
        CONSTRAINT "FK_automation_occurrences_invocation" FOREIGN KEY ("owner_id", "conversation_id", "skill_invocation_id") REFERENCES "skill_invocations" ("owner_id", "conversation_id", "id") ON DELETE SET NULL ("skill_invocation_id"),
        CONSTRAINT "CHK_automation_occurrences_lease_pair" CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL))
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_automation_occurrences_claim" ON "automation_occurrences" ("status", "lease_expires_at", "intended_for_utc", "id") WHERE "status" IN (\'queued\', \'claimed\', \'dispatching\', \'running\', \'cancel_requested\')');
    await queryRunner.query(`
      ALTER TABLE "home_turns" ADD COLUMN "automation_occurrence_id" uuid NULL,
        ADD CONSTRAINT "FK_home_turns_automation_occurrence"
          FOREIGN KEY ("owner_id", "conversation_id", "automation_occurrence_id")
          REFERENCES "automation_occurrences" ("owner_id", "conversation_id", "id") ON DELETE CASCADE
    `);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_home_turns_automation_occurrence" ON "home_turns" ("automation_occurrence_id") WHERE "automation_occurrence_id" IS NOT NULL');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { readonly has_schedules: boolean; readonly has_occurrences: boolean; readonly has_turn_bindings: boolean }[] = await queryRunner.query(`
      SELECT EXISTS (SELECT 1 FROM "automation_schedules") AS "has_schedules",
        EXISTS (SELECT 1 FROM "automation_occurrences") AS "has_occurrences",
        EXISTS (SELECT 1 FROM "home_turns" WHERE "automation_occurrence_id" IS NOT NULL) AS "has_turn_bindings"
    `);
    if (rows[0]?.has_schedules || rows[0]?.has_occurrences || rows[0]?.has_turn_bindings) {
      throw new Error('Automation rollback is blocked while schedules, occurrences, or Home turn bindings exist.');
    }
    await queryRunner.query('DROP INDEX "UQ_home_turns_automation_occurrence"');
    await queryRunner.query('ALTER TABLE "home_turns" DROP CONSTRAINT "FK_home_turns_automation_occurrence", DROP COLUMN "automation_occurrence_id"');
    await queryRunner.query('DROP INDEX "IDX_automation_occurrences_claim"');
    await queryRunner.query('DROP TABLE "automation_occurrences"');
    await queryRunner.query('DROP INDEX "IDX_automation_schedules_due"');
    await queryRunner.query('DROP TABLE "automation_schedules"');
  }
}
