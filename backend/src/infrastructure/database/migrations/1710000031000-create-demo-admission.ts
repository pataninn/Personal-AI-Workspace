import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds bounded anonymous demo admission, deduplication, and run-start records. */
export class CreateDemoAdmission1710000031000 implements MigrationInterface {
  public readonly name = 'CreateDemoAdmission1710000031000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "demo_admissions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "request_key_digest" char(64) NOT NULL UNIQUE CHECK ("request_key_digest" ~ '^[0-9a-f]{64}$'),
        "owner_id" uuid NULL REFERENCES "users"("id") ON DELETE SET NULL,
        "network_key_id" char(16) NOT NULL CHECK ("network_key_id" ~ '^[0-9a-f]{16}$'),
        "network_hash" char(64) NOT NULL CHECK ("network_hash" ~ '^[0-9a-f]{64}$'),
        "status" text NOT NULL CHECK ("status" IN ('pending', 'ready', 'failed')),
        "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        "expires_at" timestamptz NULL,
        "attempts" integer NOT NULL DEFAULT 0 CHECK ("attempts" BETWEEN 0 AND 3),
        "failure_code" text NULL CHECK ("failure_code" IS NULL OR "failure_code" IN ('storage_unavailable', 'storage_not_empty', 'session_unavailable')),
        "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "CHK_demo_admissions_owner_state" CHECK (
          ("status" = 'pending' AND "failure_code" IS NULL AND (("owner_id" IS NULL AND "expires_at" IS NULL) OR ("owner_id" IS NOT NULL AND "expires_at" IS NOT NULL)))
          OR ("status" = 'ready' AND "expires_at" IS NOT NULL AND "failure_code" IS NULL)
          OR ("status" = 'failed' AND "failure_code" IS NOT NULL)
        )
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_demo_admissions_created_at" ON "demo_admissions" ("created_at")');
    await queryRunner.query('CREATE INDEX "IDX_demo_admissions_expiry" ON "demo_admissions" ("expires_at") WHERE "expires_at" IS NOT NULL');
    await queryRunner.query(`
      CREATE TABLE "demo_admission_counters" (
        "scope_kind" text NOT NULL CHECK ("scope_kind" IN ('global_admission', 'network_admission')),
        "scope_key" text NOT NULL CHECK (length("scope_key") BETWEEN 1 AND 64),
        "network_key_id" char(16) NULL,
        "window_start" timestamptz NOT NULL,
        "window_end" timestamptz NOT NULL,
        "window_seconds" integer NOT NULL CHECK ("window_seconds" BETWEEN 60 AND 604800),
        "max_count" integer NOT NULL CHECK ("max_count" BETWEEN 1 AND 1000000),
        "count" integer NOT NULL DEFAULT 0 CHECK ("count" >= 0 AND "count" <= "max_count"),
        "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "PK_demo_admission_counters" PRIMARY KEY ("scope_kind", "scope_key", "window_seconds", "window_start"),
        CONSTRAINT "CHK_demo_admission_counter_window" CHECK ("window_end" > "window_start"),
        CONSTRAINT "CHK_demo_admission_counter_scope" CHECK (
          ("scope_kind" = 'global_admission' AND "scope_key" = 'global' AND "network_key_id" IS NULL)
          OR ("scope_kind" = 'network_admission' AND "scope_key" <> 'global' AND "network_key_id" IS NOT NULL)
        )
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_demo_admission_counters_expiry" ON "demo_admission_counters" ("window_end")');
    await queryRunner.query(`
      CREATE TABLE "demo_run_start_events" (
        "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "run_id" uuid NOT NULL,
        "window_start" timestamptz NOT NULL,
        "window_end" timestamptz NOT NULL,
        "window_seconds" integer NOT NULL CHECK ("window_seconds" BETWEEN 60 AND 604800),
        "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "PK_demo_run_start_events" PRIMARY KEY ("owner_id", "run_id"),
        CONSTRAINT "CHK_demo_run_start_window" CHECK ("window_end" > "window_start")
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_demo_run_start_events_owner_window" ON "demo_run_start_events" ("owner_id", "window_start", "window_end")');
    await queryRunner.query('CREATE INDEX "IDX_demo_run_start_events_expiry" ON "demo_run_start_events" ("window_end")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { has_admissions: boolean; has_counters: boolean; has_run_starts: boolean; has_demo_users: boolean }[] =
      await queryRunner.query(`
        SELECT EXISTS (SELECT 1 FROM "demo_admissions") AS "has_admissions",
               EXISTS (SELECT 1 FROM "demo_admission_counters") AS "has_counters",
               EXISTS (SELECT 1 FROM "demo_run_start_events") AS "has_run_starts",
               EXISTS (SELECT 1 FROM "users" WHERE "account_kind" = 'demo') AS "has_demo_users"
      `);
    if (rows[0]?.has_admissions || rows[0]?.has_counters || rows[0]?.has_run_starts || rows[0]?.has_demo_users) {
      throw new Error('Demo admission rollback is blocked while admission history or demo accounts exist.');
    }
    await queryRunner.query('DROP INDEX "IDX_demo_run_start_events_expiry"');
    await queryRunner.query('DROP INDEX "IDX_demo_run_start_events_owner_window"');
    await queryRunner.query('DROP TABLE "demo_run_start_events"');
    await queryRunner.query('DROP INDEX "IDX_demo_admission_counters_expiry"');
    await queryRunner.query('DROP TABLE "demo_admission_counters"');
    await queryRunner.query('DROP INDEX "IDX_demo_admissions_expiry"');
    await queryRunner.query('DROP INDEX "IDX_demo_admissions_created_at"');
    await queryRunner.query('DROP TABLE "demo_admissions"');
  }
}
