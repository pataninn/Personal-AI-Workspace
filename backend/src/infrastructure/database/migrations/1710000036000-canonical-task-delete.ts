import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Converts legacy task archives in place and makes Inbox/workspace deletion one owner-scoped operation. */
export class CanonicalTaskDelete1710000036000 implements MigrationInterface {
  public readonly name = 'CanonicalTaskDelete1710000036000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const unsafeRows: readonly { readonly task_version_overflow: boolean; readonly order_version_overflow: boolean; readonly position_overflow: boolean }[] = await queryRunner.query(`
      SELECT
        EXISTS (SELECT 1 FROM "project_tasks" WHERE "status" = 'archived' AND "version" = 2147483647) AS "task_version_overflow",
        EXISTS (
          SELECT 1 FROM "project_task_order_states" s
          JOIN (SELECT DISTINCT "owner_id", "project_id" FROM "project_tasks" WHERE "status" = 'archived') a
            ON s."owner_id" = a."owner_id" AND s."project_id" IS NOT DISTINCT FROM a."project_id"
          WHERE s."version" = 2147483647
        ) AS "order_version_overflow",
        EXISTS (
          SELECT 1 FROM (
            SELECT "owner_id", "project_id",
              COALESCE(max("position") FILTER (WHERE "status" <> 'archived'), -1)::bigint + count(*) FILTER (WHERE "status" = 'archived')::bigint AS "last_position"
            FROM "project_tasks"
            GROUP BY "owner_id", "project_id"
          ) collections WHERE collections."last_position" > 2147483647
        ) AS "position_overflow"
    `);
    if (unsafeRows[0]?.task_version_overflow || unsafeRows[0]?.order_version_overflow || unsafeRows[0]?.position_overflow) {
      throw new Error('Task archive conversion would overflow an existing task, position, or collection version.');
    }

    await queryRunner.query(`
      CREATE TABLE "task_archive_migration_map" (
        "task_id" uuid NOT NULL,
        "owner_id" uuid NOT NULL,
        "legacy_status" text NOT NULL CHECK ("legacy_status" = 'archived'),
        "archived_at" timestamptz NULL,
        "completed_at" timestamptz NULL,
        "updated_at" timestamptz NOT NULL,
        "version" integer NOT NULL,
        "position" integer NOT NULL,
        "converted_version" integer NOT NULL,
        "converted_position" integer NOT NULL,
        CONSTRAINT "PK_task_archive_migration_map" PRIMARY KEY ("owner_id", "task_id")
      )
    `);
    await queryRunner.query(`
      WITH "ordered_archives" AS (
        SELECT t."id", t."owner_id", t."project_id", t."archived_at", t."completed_at", t."updated_at", t."version", t."position",
          COALESCE((SELECT max(active."position") FROM "project_tasks" active
                    WHERE active."owner_id" = t."owner_id" AND active."project_id" IS NOT DISTINCT FROM t."project_id"
                      AND active."status" <> 'archived'), -1)
            + row_number() OVER (PARTITION BY t."owner_id", t."project_id" ORDER BY t."archived_at" NULLS LAST, t."position", t."created_at", t."id") AS "converted_position"
        FROM "project_tasks" t WHERE t."status" = 'archived'
      )
      INSERT INTO "task_archive_migration_map" (
        "task_id", "owner_id", "legacy_status", "archived_at", "completed_at", "updated_at", "version", "position", "converted_version", "converted_position"
      )
      SELECT "id", "owner_id", 'archived', "archived_at", "completed_at", "updated_at", "version", "position", "version" + 1, "converted_position"
      FROM "ordered_archives"
    `);
    await queryRunner.query(`
      CREATE TABLE "task_archive_receipt_migration_map" (
        "owner_id" uuid NOT NULL,
        "task_id" uuid NOT NULL,
        "receipt_id" uuid NOT NULL,
        "undo_status" "action_ledger_undo_status" NOT NULL,
        "reversible_fields" jsonb NOT NULL,
        CONSTRAINT "PK_task_archive_receipt_migration_map" PRIMARY KEY ("owner_id", "receipt_id"),
        CONSTRAINT "FK_task_archive_receipt_map_task" FOREIGN KEY ("owner_id", "task_id") REFERENCES "task_archive_migration_map" ("owner_id", "task_id") ON DELETE CASCADE,
        CONSTRAINT "FK_task_archive_receipt_map_receipt" FOREIGN KEY ("owner_id", "receipt_id") REFERENCES "action_ledger_records" ("owner_id", "id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      INSERT INTO "task_archive_receipt_migration_map" ("owner_id", "task_id", "receipt_id", "undo_status", "reversible_fields")
      SELECT r."owner_id", r."target_id", r."id", r."undo_status", r."reversible_fields"
      FROM "action_ledger_records" r
      JOIN "task_archive_migration_map" m ON m."owner_id" = r."owner_id" AND m."task_id" = r."target_id"
      WHERE r."target_kind" = 'task' AND r."action_kind" = 'task.archive' AND r."undo_status" = 'available'
    `);
    await queryRunner.query(`
      UPDATE "action_ledger_records" r SET "undo_status" = 'not_reversible', "reversible_fields" = '{}'::jsonb
      FROM "task_archive_migration_map" m
      WHERE r."owner_id" = m."owner_id" AND r."target_kind" = 'task' AND r."target_id" = m."task_id"
        AND r."action_kind" = 'task.archive' AND r."undo_status" = 'available'
    `);
    await queryRunner.query(`
      UPDATE "project_tasks" t SET
        "position" = m."converted_position",
        "status" = CASE WHEN t."completed_at" IS NOT NULL THEN 'done'::"project_task_status" ELSE 'todo'::"project_task_status" END,
        "version" = m."converted_version",
        "updated_at" = now()
      FROM "task_archive_migration_map" m
      WHERE t."owner_id" = m."owner_id" AND t."id" = m."task_id"
    `);
    await queryRunner.query(`
      UPDATE "project_task_order_states" s SET "version" = s."version" + 1, "updated_at" = now()
      FROM (SELECT DISTINCT t."owner_id", t."project_id" FROM "task_archive_migration_map" m JOIN "project_tasks" t ON t."owner_id" = m."owner_id" AND t."id" = m."task_id") changed
      WHERE s."owner_id" = changed."owner_id" AND s."project_id" IS NOT DISTINCT FROM changed."project_id"
    `);

    await queryRunner.query('DROP INDEX "UQ_project_tasks_active_position"');
    await queryRunner.query('DROP INDEX "UQ_project_tasks_inbox_active_position"');
    await queryRunner.query('DROP INDEX "IDX_project_tasks_owner_project_status_position"');
    await queryRunner.query('DROP INDEX "IDX_project_tasks_owner_inbox_status_position"');
    await queryRunner.query('DROP INDEX "IDX_project_tasks_owner_open_deadline_importance"');
    await queryRunner.query('ALTER TABLE "project_tasks" ALTER COLUMN "status" DROP DEFAULT');
    await queryRunner.query(`CREATE TYPE "project_task_status_new" AS ENUM ('todo', 'in_progress', 'blocked', 'done')`);
    await queryRunner.query('ALTER TABLE "project_tasks" ALTER COLUMN "status" TYPE "project_task_status_new" USING "status"::text::"project_task_status_new"');
    await queryRunner.query('DROP TYPE "project_task_status"');
    await queryRunner.query('ALTER TYPE "project_task_status_new" RENAME TO "project_task_status"');
    await queryRunner.query('ALTER TABLE "project_tasks" ALTER COLUMN "status" SET DEFAULT \'todo\'');
    await queryRunner.query('ALTER TABLE "project_tasks" DROP COLUMN "archived_at"');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_project_tasks_collection_position" ON "project_tasks" ("owner_id", "project_id", "position")');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_project_tasks_inbox_position" ON "project_tasks" ("owner_id", "position") WHERE "project_id" IS NULL');
    await queryRunner.query('CREATE INDEX "IDX_project_tasks_owner_project_status_position" ON "project_tasks" ("owner_id", "project_id", "status", "position", "id")');
    await queryRunner.query('CREATE INDEX "IDX_project_tasks_owner_inbox_status_position" ON "project_tasks" ("owner_id", "status", "position", "id") WHERE "project_id" IS NULL');
    await queryRunner.query(`CREATE INDEX "IDX_project_tasks_owner_open_deadline_importance"
      ON "project_tasks" ("owner_id", "deadline" ASC NULLS LAST, "importance" DESC, "updated_at" DESC, "id")
      WHERE "status" IN ('todo', 'in_progress', 'blocked')`);

    await queryRunner.query('ALTER TABLE "action_ledger_records" DROP CONSTRAINT "CHK_action_ledger_records_undo_link"');
    await queryRunner.query('ALTER TYPE "action_ledger_action_kind" RENAME TO "action_ledger_action_kind_old"');
    await queryRunner.query(`CREATE TYPE "action_ledger_action_kind" AS ENUM (
      'task.create', 'task.update', 'task.move', 'task.reorder', 'task.archive', 'task.delete', 'task.restore',
      'workspace.create', 'workspace.update', 'workspace.archive', 'workspace.restore', 'undo'
    )`);
    await queryRunner.query('ALTER TABLE "action_ledger_records" ALTER COLUMN "action_kind" TYPE "action_ledger_action_kind" USING "action_kind"::text::"action_ledger_action_kind"');
    await queryRunner.query('DROP TYPE "action_ledger_action_kind_old"');
    await queryRunner.query(`ALTER TABLE "action_ledger_records" ADD CONSTRAINT "CHK_action_ledger_records_undo_link"
      CHECK (("action_kind" = 'undo') = ("undo_of_action_id" IS NOT NULL))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const unsafeRows: readonly { readonly has_delete_receipts: boolean; readonly changed_mapped_tasks: boolean; readonly changed_archive_receipts: boolean }[] = await queryRunner.query(`
      SELECT
        EXISTS (SELECT 1 FROM "action_ledger_records" WHERE "action_kind"::text = 'task.delete') AS "has_delete_receipts",
        EXISTS (
          SELECT 1 FROM "task_archive_migration_map" m LEFT JOIN "project_tasks" t ON t."owner_id" = m."owner_id" AND t."id" = m."task_id"
          WHERE t."id" IS NULL OR t."version" <> m."converted_version" OR t."position" <> m."converted_position"
            OR t."status"::text <> CASE WHEN m."completed_at" IS NOT NULL THEN 'done' ELSE 'todo' END
        ) AS "changed_mapped_tasks",
        EXISTS (
          SELECT 1 FROM "task_archive_receipt_migration_map" m JOIN "action_ledger_records" r ON r."owner_id" = m."owner_id" AND r."id" = m."receipt_id"
          WHERE r."undo_status" <> 'not_reversible' OR r."reversible_fields" <> '{}'::jsonb
        ) AS "changed_archive_receipts"
    `);
    if (unsafeRows[0]?.has_delete_receipts || unsafeRows[0]?.changed_mapped_tasks || unsafeRows[0]?.changed_archive_receipts) {
      throw new Error('Cannot roll back canonical task deletion after a delete receipt or a changed converted task/archive receipt exists.');
    }

    await queryRunner.query('DROP INDEX "UQ_project_tasks_collection_position"');
    await queryRunner.query('DROP INDEX "UQ_project_tasks_inbox_position"');
    await queryRunner.query('DROP INDEX "IDX_project_tasks_owner_project_status_position"');
    await queryRunner.query('DROP INDEX "IDX_project_tasks_owner_inbox_status_position"');
    await queryRunner.query('DROP INDEX "IDX_project_tasks_owner_open_deadline_importance"');
    await queryRunner.query(`CREATE TYPE "project_task_status_old" AS ENUM ('todo', 'in_progress', 'blocked', 'done', 'archived')`);
    await queryRunner.query('ALTER TABLE "project_tasks" ALTER COLUMN "status" DROP DEFAULT');
    await queryRunner.query('ALTER TABLE "project_tasks" ALTER COLUMN "status" TYPE "project_task_status_old" USING "status"::text::"project_task_status_old"');
    await queryRunner.query('DROP TYPE "project_task_status"');
    await queryRunner.query('ALTER TYPE "project_task_status_old" RENAME TO "project_task_status"');
    await queryRunner.query('ALTER TABLE "project_tasks" ADD COLUMN "archived_at" timestamptz NULL');
    await queryRunner.query(`
      UPDATE "project_tasks" t SET
        "status" = m."legacy_status"::"project_task_status",
        "archived_at" = m."archived_at",
        "completed_at" = m."completed_at",
        "updated_at" = m."updated_at",
        "version" = m."version",
        "position" = m."position"
      FROM "task_archive_migration_map" m
      WHERE t."owner_id" = m."owner_id" AND t."id" = m."task_id"
    `);
    await queryRunner.query('ALTER TABLE "project_tasks" ALTER COLUMN "status" SET DEFAULT \'todo\'');
    await queryRunner.query(`
      UPDATE "action_ledger_records" r SET "undo_status" = m."undo_status", "reversible_fields" = m."reversible_fields"
      FROM "task_archive_receipt_migration_map" m WHERE r."owner_id" = m."owner_id" AND r."id" = m."receipt_id"
    `);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_project_tasks_active_position" ON "project_tasks" ("owner_id", "project_id", "position") WHERE "status" <> \'archived\'');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_project_tasks_inbox_active_position" ON "project_tasks" ("owner_id", "position") WHERE "project_id" IS NULL AND "status" <> \'archived\'');
    await queryRunner.query('CREATE INDEX "IDX_project_tasks_owner_project_status_position" ON "project_tasks" ("owner_id", "project_id", "status", "position", "id")');
    await queryRunner.query('CREATE INDEX "IDX_project_tasks_owner_inbox_status_position" ON "project_tasks" ("owner_id", "status", "position", "id") WHERE "project_id" IS NULL');
    await queryRunner.query(`CREATE INDEX "IDX_project_tasks_owner_open_deadline_importance"
      ON "project_tasks" ("owner_id", "deadline" ASC NULLS LAST, "importance" DESC, "updated_at" DESC, "id")
      WHERE "status" IN ('todo', 'in_progress', 'blocked')`);
    await queryRunner.query(`
      UPDATE "project_task_order_states" s SET "version" = s."version" + 1, "updated_at" = now()
      WHERE EXISTS (SELECT 1 FROM "task_archive_migration_map" m JOIN "project_tasks" t ON t."owner_id" = m."owner_id" AND t."id" = m."task_id"
                    WHERE s."owner_id" = m."owner_id" AND s."project_id" IS NOT DISTINCT FROM t."project_id")
    `);
    await queryRunner.query('DROP TABLE "task_archive_receipt_migration_map"');
    await queryRunner.query('DROP TABLE "task_archive_migration_map"');

    await queryRunner.query('ALTER TABLE "action_ledger_records" DROP CONSTRAINT "CHK_action_ledger_records_undo_link"');
    await queryRunner.query('ALTER TYPE "action_ledger_action_kind" RENAME TO "action_ledger_action_kind_new"');
    await queryRunner.query(`CREATE TYPE "action_ledger_action_kind" AS ENUM (
      'task.create', 'task.update', 'task.move', 'task.reorder', 'task.archive', 'task.restore',
      'workspace.create', 'workspace.update', 'workspace.archive', 'workspace.restore', 'undo'
    )`);
    await queryRunner.query('ALTER TABLE "action_ledger_records" ALTER COLUMN "action_kind" TYPE "action_ledger_action_kind" USING "action_kind"::text::"action_ledger_action_kind"');
    await queryRunner.query('DROP TYPE "action_ledger_action_kind_new"');
    await queryRunner.query(`ALTER TABLE "action_ledger_records" ADD CONSTRAINT "CHK_action_ledger_records_undo_link"
      CHECK (("action_kind" = 'undo') = ("undo_of_action_id" IS NOT NULL))`);
  }
}
