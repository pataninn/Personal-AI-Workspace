import type { MigrationInterface, QueryRunner } from 'typeorm';

function queryRow(result: unknown): Record<string, unknown> {
  if (!Array.isArray(result) || result.length !== 1 || typeof result[0] !== 'object' || result[0] === null || Array.isArray(result[0])) {
    throw new Error('The Inbox task migration could not read its safety check result.');
  }
  return result[0] as Record<string, unknown>;
}

function readFlag(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') {
    throw new Error('The Inbox task migration could not read its safety check result.');
  }
  return value;
}

export class AddInboxTaskPersistence1710000018000 implements MigrationInterface {
  public readonly name = 'AddInboxTaskPersistence1710000018000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const ownership = queryRow(await queryRunner.query(`
      SELECT
        EXISTS (
          SELECT 1 FROM "project_tasks" t
          JOIN "projects" p ON p."id" = t."project_id"
          WHERE t."owner_id" <> p."owner_id"
        ) AS "task_owner_mismatch",
        EXISTS (
          SELECT 1 FROM "project_task_order_states" s
          JOIN "projects" p ON p."id" = s."project_id"
          WHERE s."owner_id" <> p."owner_id"
        ) AS "order_state_owner_mismatch"
    `));
    if (readFlag(ownership, 'task_owner_mismatch') || readFlag(ownership, 'order_state_owner_mismatch')) {
      throw new Error('Cannot apply Inbox task persistence while existing task or order-state ownership is inconsistent. Review the affected records before retrying.');
    }

    await queryRunner.query('ALTER TABLE "projects" ADD CONSTRAINT "UQ_projects_owner_id" UNIQUE ("owner_id", "id")');
    await queryRunner.query(`ALTER TABLE "project_tasks"
      ADD COLUMN "source_suggestion_project_id" uuid NULL,
      ADD COLUMN "source_run_id" uuid NULL,
      ADD COLUMN "source_conversation_id" uuid NULL,
      ADD COLUMN "source_accepted_at" TIMESTAMPTZ NULL`);
    await queryRunner.query(`UPDATE "project_tasks" t
      SET "source_suggestion_project_id" = s."project_id",
          "source_run_id" = s."run_id",
          "source_conversation_id" = s."conversation_id",
          "source_accepted_at" = COALESCE(s."resolved_at", t."created_at")
      FROM "project_task_suggestions" s
      WHERE t."source_kind" = 'assistant_suggestion'
        AND s."owner_id" = t."owner_id"
        AND s."project_id" = t."project_id"
        AND s."id" = t."source_suggestion_id"`);
    await queryRunner.query(`ALTER TABLE "project_tasks"
      DROP CONSTRAINT "FK_project_tasks_source_suggestion",
      DROP CONSTRAINT "FK_project_tasks_project_id",
      DROP CONSTRAINT "CHK_project_tasks_source_link",
      ALTER COLUMN "project_id" DROP NOT NULL,
      ADD CONSTRAINT "UQ_project_tasks_owner_task" UNIQUE ("owner_id", "id"),
      ADD CONSTRAINT "FK_project_tasks_project_owner" FOREIGN KEY ("owner_id", "project_id") REFERENCES "projects" ("owner_id", "id") ON DELETE CASCADE,
      ADD CONSTRAINT "CHK_project_tasks_source_link" CHECK (
        ("source_kind" = 'user' AND "source_suggestion_id" IS NULL AND "source_suggestion_project_id" IS NULL AND "source_run_id" IS NULL AND "source_conversation_id" IS NULL AND "source_accepted_at" IS NULL)
        OR
        ("source_kind" = 'assistant_suggestion' AND "source_suggestion_id" IS NOT NULL AND "source_suggestion_project_id" IS NOT NULL AND "source_run_id" IS NOT NULL AND "source_conversation_id" IS NOT NULL AND "source_accepted_at" IS NOT NULL)
      )`);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_project_tasks_inbox_active_position" ON "project_tasks" ("owner_id", "position") WHERE "project_id" IS NULL AND "status" <> \'archived\'');
    await queryRunner.query('CREATE INDEX "IDX_project_tasks_owner_inbox_status_position" ON "project_tasks" ("owner_id", "status", "position", "id") WHERE "project_id" IS NULL');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_project_tasks_inbox_idempotency" ON "project_tasks" ("owner_id", "idempotency_key") WHERE "project_id" IS NULL AND "idempotency_key" IS NOT NULL');

    await queryRunner.query(`ALTER TABLE "project_task_order_states"
      DROP CONSTRAINT "PK_project_task_order_states_project_id",
      DROP CONSTRAINT "FK_project_task_order_states_project_id",
      ALTER COLUMN "project_id" DROP NOT NULL,
      ADD CONSTRAINT "UQ_project_task_order_states_project_id" UNIQUE ("project_id"),
      ADD CONSTRAINT "FK_project_task_order_states_project_owner" FOREIGN KEY ("owner_id", "project_id") REFERENCES "projects" ("owner_id", "id") ON DELETE CASCADE`);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_project_task_order_states_inbox_owner" ON "project_task_order_states" ("owner_id") WHERE "project_id" IS NULL');

    await queryRunner.query(`ALTER TABLE "project_task_events"
      DROP CONSTRAINT "FK_project_task_events_task",
      DROP CONSTRAINT "FK_project_task_events_suggestion",
      DROP CONSTRAINT "FK_project_task_events_project_id",
      DROP CONSTRAINT "FK_project_task_events_run_id",
      ALTER COLUMN "project_id" DROP NOT NULL,
      ADD CONSTRAINT "FK_project_task_events_owner_task" FOREIGN KEY ("owner_id", "task_id") REFERENCES "project_tasks" ("owner_id", "id") ON DELETE CASCADE`);
    await queryRunner.query('CREATE INDEX "IDX_project_task_events_owner_task" ON "project_task_events" ("owner_id", "task_id") WHERE "task_id" IS NOT NULL');

    await queryRunner.query(`INSERT INTO "project_task_order_states" ("owner_id", "project_id")
      SELECT "id", NULL FROM "users" ON CONFLICT DO NOTHING`);
    await queryRunner.query(`CREATE FUNCTION "create_owner_inbox_task_order_state"() RETURNS trigger AS $$
      BEGIN
        INSERT INTO "project_task_order_states" ("owner_id", "project_id") VALUES (NEW."id", NULL)
        ON CONFLICT ("owner_id") WHERE "project_id" IS NULL DO NOTHING;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await queryRunner.query('CREATE TRIGGER "TRG_users_inbox_task_order_state" AFTER INSERT ON "users" FOR EACH ROW EXECUTE FUNCTION "create_owner_inbox_task_order_state"()');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rollbackState = queryRow(await queryRunner.query(`
      SELECT
        EXISTS (SELECT 1 FROM "project_tasks" WHERE "project_id" IS NULL) AS "has_inbox_tasks",
        EXISTS (SELECT 1 FROM "project_task_order_states" WHERE "project_id" IS NULL AND "version" <> 1) AS "has_changed_inbox_order",
        EXISTS (
          SELECT 1 FROM "project_tasks" t
          WHERE t."source_suggestion_id" IS NOT NULL
            AND (
              t."source_suggestion_project_id" IS DISTINCT FROM t."project_id"
              OR NOT EXISTS (
                SELECT 1 FROM "project_task_suggestions" s
                WHERE s."owner_id" = t."owner_id"
                  AND s."project_id" = t."source_suggestion_project_id"
                  AND s."id" = t."source_suggestion_id"
              )
            )
        ) AS "has_moved_or_orphaned_suggestion_tasks",
        EXISTS (
          SELECT 1 FROM "project_task_events" e
          WHERE e."project_id" IS NULL
            OR NOT EXISTS (SELECT 1 FROM "projects" p WHERE p."id" = e."project_id")
            OR (e."task_id" IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM "project_tasks" t
              WHERE t."owner_id" = e."owner_id" AND t."project_id" = e."project_id" AND t."id" = e."task_id"
            ))
            OR (e."suggestion_id" IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM "project_task_suggestions" s
              WHERE s."owner_id" = e."owner_id" AND s."project_id" = e."project_id" AND s."id" = e."suggestion_id"
            ))
            OR (e."run_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ai_runs" r WHERE r."id" = e."run_id"))
        ) AS "has_history_incompatible_with_legacy_keys"
    `));
    if (
      readFlag(rollbackState, 'has_inbox_tasks') ||
      readFlag(rollbackState, 'has_changed_inbox_order') ||
      readFlag(rollbackState, 'has_moved_or_orphaned_suggestion_tasks') ||
      readFlag(rollbackState, 'has_history_incompatible_with_legacy_keys')
    ) {
      throw new Error('Cannot revert Inbox task persistence while Inbox data or detached task history exists. Preserve or return those records before retrying.');
    }

    await queryRunner.query('DROP TRIGGER "TRG_users_inbox_task_order_state" ON "users"');
    await queryRunner.query('DROP FUNCTION "create_owner_inbox_task_order_state"()');
    await queryRunner.query('DELETE FROM "project_task_order_states" WHERE "project_id" IS NULL');
    await queryRunner.query('DROP INDEX "UQ_project_task_order_states_inbox_owner"');
    await queryRunner.query(`ALTER TABLE "project_task_order_states"
      DROP CONSTRAINT "FK_project_task_order_states_project_owner",
      DROP CONSTRAINT "UQ_project_task_order_states_project_id",
      ALTER COLUMN "project_id" SET NOT NULL,
      ADD CONSTRAINT "PK_project_task_order_states_project_id" PRIMARY KEY ("project_id"),
      ADD CONSTRAINT "FK_project_task_order_states_project_id" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE`);

    await queryRunner.query('DROP INDEX "IDX_project_task_events_owner_task"');
    await queryRunner.query(`ALTER TABLE "project_task_events"
      DROP CONSTRAINT "FK_project_task_events_owner_task",
      ALTER COLUMN "project_id" SET NOT NULL,
      ADD CONSTRAINT "FK_project_task_events_project_id" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
      ADD CONSTRAINT "FK_project_task_events_task" FOREIGN KEY ("owner_id", "project_id", "task_id") REFERENCES "project_tasks" ("owner_id", "project_id", "id") ON DELETE CASCADE,
      ADD CONSTRAINT "FK_project_task_events_suggestion" FOREIGN KEY ("owner_id", "project_id", "suggestion_id") REFERENCES "project_task_suggestions" ("owner_id", "project_id", "id") ON DELETE CASCADE,
      ADD CONSTRAINT "FK_project_task_events_run_id" FOREIGN KEY ("run_id") REFERENCES "ai_runs" ("id") ON DELETE CASCADE`);

    await queryRunner.query('DROP INDEX "UQ_project_tasks_inbox_idempotency"');
    await queryRunner.query('DROP INDEX "IDX_project_tasks_owner_inbox_status_position"');
    await queryRunner.query('DROP INDEX "UQ_project_tasks_inbox_active_position"');
    await queryRunner.query(`ALTER TABLE "project_tasks"
      DROP CONSTRAINT "FK_project_tasks_project_owner",
      DROP CONSTRAINT "UQ_project_tasks_owner_task",
      DROP CONSTRAINT "CHK_project_tasks_source_link",
      ALTER COLUMN "project_id" SET NOT NULL,
      ADD CONSTRAINT "FK_project_tasks_project_id" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
      ADD CONSTRAINT "FK_project_tasks_source_suggestion" FOREIGN KEY ("owner_id", "project_id", "source_suggestion_id") REFERENCES "project_task_suggestions" ("owner_id", "project_id", "id") ON DELETE CASCADE,
      ADD CONSTRAINT "CHK_project_tasks_source_link" CHECK (("source_kind" = 'user' AND "source_suggestion_id" IS NULL) OR ("source_kind" = 'assistant_suggestion' AND "source_suggestion_id" IS NOT NULL))`);
    await queryRunner.query(`ALTER TABLE "project_tasks"
      DROP COLUMN "source_accepted_at",
      DROP COLUMN "source_conversation_id",
      DROP COLUMN "source_run_id",
      DROP COLUMN "source_suggestion_project_id"`);
    await queryRunner.query('ALTER TABLE "projects" DROP CONSTRAINT "UQ_projects_owner_id"');
  }
}
