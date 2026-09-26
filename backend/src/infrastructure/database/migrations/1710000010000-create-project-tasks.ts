import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProjectTasks1710000010000 implements MigrationInterface {
  public readonly name = 'CreateProjectTasks1710000010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "project_task_status" AS ENUM ('todo', 'in_progress', 'blocked', 'done', 'archived')`);
    await queryRunner.query(`CREATE TYPE "project_task_source_kind" AS ENUM ('user', 'assistant_suggestion')`);
    await queryRunner.query(`CREATE TYPE "project_task_suggestion_status" AS ENUM ('pending', 'accepted', 'dismissed')`);

    await queryRunner.query(`
      CREATE TABLE "project_task_order_states" (
        "project_id" uuid NOT NULL,
        "owner_id" uuid NOT NULL,
        "version" integer NOT NULL DEFAULT 1,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_task_order_states_project_id" PRIMARY KEY ("project_id"),
        CONSTRAINT "FK_project_task_order_states_project_id" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_project_task_order_states_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_project_task_order_states_version_positive" CHECK ("version" > 0)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "project_task_suggestions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "run_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "ordinal" smallint NOT NULL,
        "title" text NOT NULL,
        "details" text NULL,
        "status" "project_task_suggestion_status" NOT NULL DEFAULT 'pending',
        "version" integer NOT NULL DEFAULT 1,
        "resolved_by_user_id" uuid NULL,
        "resolved_at" TIMESTAMPTZ NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_task_suggestions_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_project_task_suggestions_owner_project_id" UNIQUE ("owner_id", "project_id", "id"),
        CONSTRAINT "FK_project_task_suggestions_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_project_task_suggestions_project_id" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_project_task_suggestions_run_id" FOREIGN KEY ("run_id") REFERENCES "ai_runs" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_project_task_suggestions_conversation_id" FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_project_task_suggestions_resolved_by_user_id" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users" ("id") ON DELETE SET NULL,
        CONSTRAINT "CHK_project_task_suggestions_ordinal" CHECK ("ordinal" BETWEEN 0 AND 4),
        CONSTRAINT "CHK_project_task_suggestions_version_positive" CHECK ("version" > 0),
        CONSTRAINT "CHK_project_task_suggestions_title_length" CHECK (char_length("title") BETWEEN 1 AND 120),
        CONSTRAINT "CHK_project_task_suggestions_details_length" CHECK ("details" IS NULL OR octet_length("details") <= 4096),
        CONSTRAINT "CHK_project_task_suggestions_resolution" CHECK (("status" = 'pending' AND "resolved_at" IS NULL) OR ("status" <> 'pending' AND "resolved_at" IS NOT NULL))
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_project_task_suggestions_run_ordinal" ON "project_task_suggestions" ("run_id", "ordinal")');
    await queryRunner.query('CREATE INDEX "IDX_project_task_suggestions_owner_project_status_created" ON "project_task_suggestions" ("owner_id", "project_id", "status", "created_at" ASC, "id" ASC)');
    await queryRunner.query('CREATE INDEX "IDX_project_task_suggestions_run" ON "project_task_suggestions" ("run_id", "id")');
    await queryRunner.query('CREATE INDEX "IDX_project_task_suggestions_conversation" ON "project_task_suggestions" ("conversation_id", "id")');

    await queryRunner.query(`
      CREATE TABLE "project_tasks" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "title" text NOT NULL,
        "details" text NULL,
        "status" "project_task_status" NOT NULL DEFAULT 'todo',
        "position" integer NOT NULL,
        "version" integer NOT NULL DEFAULT 1,
        "source_kind" "project_task_source_kind" NOT NULL DEFAULT 'user',
        "source_suggestion_id" uuid NULL,
        "idempotency_key" text NULL,
        "request_fingerprint" text NULL,
        "idempotency_snapshot" jsonb NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "completed_at" TIMESTAMPTZ NULL,
        "archived_at" TIMESTAMPTZ NULL,
        CONSTRAINT "PK_project_tasks_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_project_tasks_owner_project_id" UNIQUE ("owner_id", "project_id", "id"),
        CONSTRAINT "FK_project_tasks_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_project_tasks_project_id" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_project_tasks_source_suggestion" FOREIGN KEY ("owner_id", "project_id", "source_suggestion_id") REFERENCES "project_task_suggestions" ("owner_id", "project_id", "id") ON DELETE CASCADE,
        CONSTRAINT "CHK_project_tasks_version_positive" CHECK ("version" > 0),
        CONSTRAINT "CHK_project_tasks_position_nonnegative" CHECK ("position" >= 0),
        CONSTRAINT "CHK_project_tasks_title_length" CHECK (char_length("title") BETWEEN 1 AND 120),
        CONSTRAINT "CHK_project_tasks_details_length" CHECK ("details" IS NULL OR octet_length("details") <= 4096),
        CONSTRAINT "CHK_project_tasks_source_link" CHECK (("source_kind" = 'user' AND "source_suggestion_id" IS NULL) OR ("source_kind" = 'assistant_suggestion' AND "source_suggestion_id" IS NOT NULL)),
        CONSTRAINT "CHK_project_tasks_idempotency_pair" CHECK (("idempotency_key" IS NULL) = ("request_fingerprint" IS NULL))
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_project_tasks_owner_project_status_position" ON "project_tasks" ("owner_id", "project_id", "status", "position", "id")');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_project_tasks_active_position" ON "project_tasks" ("owner_id", "project_id", "position") WHERE "status" <> \'archived\'');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_project_tasks_source_suggestion" ON "project_tasks" ("source_suggestion_id") WHERE "source_suggestion_id" IS NOT NULL');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_project_tasks_idempotency" ON "project_tasks" ("owner_id", "project_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL');

    await queryRunner.query(`
      CREATE TABLE "project_task_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "task_id" uuid NULL,
        "suggestion_id" uuid NULL,
        "run_id" uuid NULL,
        "actor_kind" text NOT NULL,
        "actor_user_id" uuid NULL,
        "event_type" text NOT NULL,
        "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_task_events_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_project_task_events_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_project_task_events_project_id" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_project_task_events_task" FOREIGN KEY ("owner_id", "project_id", "task_id") REFERENCES "project_tasks" ("owner_id", "project_id", "id") ON DELETE CASCADE,
        CONSTRAINT "FK_project_task_events_suggestion" FOREIGN KEY ("owner_id", "project_id", "suggestion_id") REFERENCES "project_task_suggestions" ("owner_id", "project_id", "id") ON DELETE CASCADE,
        CONSTRAINT "FK_project_task_events_run_id" FOREIGN KEY ("run_id") REFERENCES "ai_runs" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_project_task_events_actor_user_id" FOREIGN KEY ("actor_user_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_project_task_events_actor" CHECK (("actor_kind" = 'user' AND "actor_user_id" IS NOT NULL) OR ("actor_kind" = 'assistant' AND "actor_user_id" IS NULL)),
        CONSTRAINT "CHK_project_task_events_type" CHECK ("event_type" IN ('task.created', 'task.updated', 'task.status_changed', 'task.reordered', 'task.suggestion_proposed', 'task.suggestion_accepted', 'task.suggestion_dismissed')),
        CONSTRAINT "CHK_project_task_events_subject" CHECK ("task_id" IS NOT NULL OR "suggestion_id" IS NOT NULL)
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_project_task_events_owner_project_time" ON "project_task_events" ("owner_id", "project_id", "occurred_at" DESC, "id" DESC)');
    await queryRunner.query('CREATE INDEX "IDX_project_task_events_task" ON "project_task_events" ("task_id", "occurred_at" DESC, "id" DESC) WHERE "task_id" IS NOT NULL');
    await queryRunner.query('CREATE INDEX "IDX_project_task_events_suggestion" ON "project_task_events" ("suggestion_id", "occurred_at" DESC, "id" DESC) WHERE "suggestion_id" IS NOT NULL');
    await queryRunner.query('CREATE INDEX "IDX_project_task_events_run" ON "project_task_events" ("run_id", "occurred_at" ASC, "id" ASC) WHERE "run_id" IS NOT NULL');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_project_task_events_suggestion_proposed" ON "project_task_events" ("suggestion_id", "event_type") WHERE "suggestion_id" IS NOT NULL AND "event_type" = \'task.suggestion_proposed\'');

    await queryRunner.query(`
      INSERT INTO "project_task_order_states" ("project_id", "owner_id")
      SELECT "id", "owner_id" FROM "projects"
      ON CONFLICT ("project_id") DO NOTHING
    `);
    await queryRunner.query(`
      CREATE FUNCTION "create_project_task_order_state"() RETURNS trigger AS $$
      BEGIN
        INSERT INTO "project_task_order_states" ("project_id", "owner_id") VALUES (NEW."id", NEW."owner_id") ON CONFLICT ("project_id") DO NOTHING;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`CREATE TRIGGER "TRG_projects_task_order_state" AFTER INSERT ON "projects" FOR EACH ROW EXECUTE FUNCTION "create_project_task_order_state"()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TRIGGER "TRG_projects_task_order_state" ON "projects"');
    await queryRunner.query('DROP FUNCTION "create_project_task_order_state"()');
    await queryRunner.query('DROP INDEX "UQ_project_task_events_suggestion_proposed"');
    await queryRunner.query('DROP INDEX "IDX_project_task_events_run"');
    await queryRunner.query('DROP INDEX "IDX_project_task_events_suggestion"');
    await queryRunner.query('DROP INDEX "IDX_project_task_events_task"');
    await queryRunner.query('DROP INDEX "IDX_project_task_events_owner_project_time"');
    await queryRunner.query('DROP TABLE "project_task_events"');
    await queryRunner.query('DROP INDEX "UQ_project_tasks_idempotency"');
    await queryRunner.query('DROP INDEX "UQ_project_tasks_source_suggestion"');
    await queryRunner.query('DROP INDEX "UQ_project_tasks_active_position"');
    await queryRunner.query('DROP INDEX "IDX_project_tasks_owner_project_status_position"');
    await queryRunner.query('DROP TABLE "project_tasks"');
    await queryRunner.query('DROP INDEX "IDX_project_task_suggestions_conversation"');
    await queryRunner.query('DROP INDEX "IDX_project_task_suggestions_run"');
    await queryRunner.query('DROP INDEX "IDX_project_task_suggestions_owner_project_status_created"');
    await queryRunner.query('DROP INDEX "UQ_project_task_suggestions_run_ordinal"');
    await queryRunner.query('DROP TABLE "project_task_suggestions"');
    await queryRunner.query('DROP TABLE "project_task_order_states"');
    await queryRunner.query('DROP TYPE "project_task_suggestion_status"');
    await queryRunner.query('DROP TYPE "project_task_source_kind"');
    await queryRunner.query('DROP TYPE "project_task_status"');
  }
}
