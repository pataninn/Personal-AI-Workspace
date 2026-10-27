import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds persisted demo administration settings and safe account-limit audit history. */
export class AdminDemoPolicy1710000037000 implements MigrationInterface {
  public readonly name = 'AdminDemoPolicy1710000037000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "credit_runtime_policy"
        ADD COLUMN "demo_default_daily_limit_units" bigint NULL CHECK ("demo_default_daily_limit_units" IS NULL OR "demo_default_daily_limit_units" >= 0),
        ADD COLUMN "demo_default_lifetime_limit_units" bigint NULL CHECK ("demo_default_lifetime_limit_units" IS NULL OR "demo_default_lifetime_limit_units" >= 0),
        ADD COLUMN "demo_session_ttl_hours" integer NULL CHECK ("demo_session_ttl_hours" IS NULL OR "demo_session_ttl_hours" BETWEEN 1 AND 24),
        ADD COLUMN "demo_global_admission_max" integer NULL CHECK ("demo_global_admission_max" IS NULL OR "demo_global_admission_max" BETWEEN 1 AND 1000000),
        ADD COLUMN "demo_global_admission_window_seconds" integer NULL CHECK ("demo_global_admission_window_seconds" IS NULL OR "demo_global_admission_window_seconds" BETWEEN 60 AND 604800),
        ADD COLUMN "demo_network_admission_max" integer NULL CHECK ("demo_network_admission_max" IS NULL OR "demo_network_admission_max" BETWEEN 1 AND 1000000),
        ADD COLUMN "demo_network_admission_window_seconds" integer NULL CHECK ("demo_network_admission_window_seconds" IS NULL OR "demo_network_admission_window_seconds" BETWEEN 60 AND 604800),
        ADD COLUMN "demo_run_start_max" integer NULL CHECK ("demo_run_start_max" IS NULL OR "demo_run_start_max" BETWEEN 1 AND 1000000),
        ADD COLUMN "demo_run_start_window_seconds" integer NULL CHECK ("demo_run_start_window_seconds" IS NULL OR "demo_run_start_window_seconds" BETWEEN 60 AND 604800),
        ADD COLUMN "demo_settings_bootstrapped" boolean NOT NULL DEFAULT false,
        ADD CONSTRAINT "CHK_credit_runtime_policy_demo_admission" CHECK (
          ("demo_global_admission_max" IS NULL AND "demo_global_admission_window_seconds" IS NULL
            AND "demo_network_admission_max" IS NULL AND "demo_network_admission_window_seconds" IS NULL
            AND "demo_run_start_max" IS NULL AND "demo_run_start_window_seconds" IS NULL)
          OR ("demo_global_admission_max" IS NOT NULL AND "demo_global_admission_window_seconds" IS NOT NULL
            AND "demo_network_admission_max" IS NOT NULL AND "demo_network_admission_window_seconds" IS NOT NULL
            AND "demo_run_start_max" IS NOT NULL AND "demo_run_start_window_seconds" IS NOT NULL
            AND "demo_network_admission_window_seconds" <= "demo_global_admission_window_seconds")
        )
    `);
    await queryRunner.query(`
      ALTER TABLE "account_limits"
        ADD COLUMN "limits_revision" bigint NOT NULL DEFAULT 1 CHECK ("limits_revision" > 0),
        ADD COLUMN "demo_credit_limits_configured" boolean NOT NULL DEFAULT false
    `);
    // Existing demo identities keep their issued null/number values and retain their historical meaning.
    await queryRunner.query(`UPDATE "account_limits" l SET "demo_credit_limits_configured" = true
      FROM "users" u WHERE u."id" = l."owner_id" AND u."account_kind" = 'demo'`);
    await queryRunner.query(`
      CREATE TABLE "admin_audit_events" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "actor_id" uuid NULL REFERENCES "users"("id") ON DELETE SET NULL,
        "action" text NOT NULL CHECK (length("action") BETWEEN 1 AND 64),
        "target_account_id" uuid NULL,
        "old_values" jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof("old_values") = 'object'),
        "new_values" jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof("new_values") = 'object'),
        "created_at" timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_admin_audit_events_created" ON "admin_audit_events" ("created_at" DESC)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { has_audit: boolean; has_unconfigured_demo: boolean; changed_policy: boolean }[] = await queryRunner.query(`
      SELECT EXISTS (SELECT 1 FROM "admin_audit_events") AS "has_audit",
        EXISTS (SELECT 1 FROM "account_limits" l JOIN "users" u ON u."id" = l."owner_id"
          WHERE u."account_kind" = 'demo' AND l."demo_credit_limits_configured" = false) AS "has_unconfigured_demo",
        EXISTS (SELECT 1 FROM "credit_runtime_policy" WHERE "demo_settings_bootstrapped" = true
          OR "demo_default_daily_limit_units" IS NOT NULL OR "demo_default_lifetime_limit_units" IS NOT NULL
          OR "demo_session_ttl_hours" IS NOT NULL OR "demo_global_admission_max" IS NOT NULL
          OR "demo_global_admission_window_seconds" IS NOT NULL OR "demo_network_admission_max" IS NOT NULL
          OR "demo_network_admission_window_seconds" IS NOT NULL OR "demo_run_start_max" IS NOT NULL
          OR "demo_run_start_window_seconds" IS NOT NULL) AS "changed_policy"
    `);
    if (rows[0]?.has_audit || rows[0]?.has_unconfigured_demo || rows[0]?.changed_policy) {
      throw new Error('Admin policy rollback is blocked after settings, demo accounts, or audit history have been written.');
    }
    await queryRunner.query('DROP INDEX "IDX_admin_audit_events_created"');
    await queryRunner.query('DROP TABLE "admin_audit_events"');
    await queryRunner.query('ALTER TABLE "account_limits" DROP COLUMN "demo_credit_limits_configured", DROP COLUMN "limits_revision"');
    await queryRunner.query(`ALTER TABLE "credit_runtime_policy" DROP CONSTRAINT "CHK_credit_runtime_policy_demo_admission",
      DROP COLUMN "demo_settings_bootstrapped", DROP COLUMN "demo_run_start_window_seconds", DROP COLUMN "demo_run_start_max",
      DROP COLUMN "demo_network_admission_window_seconds", DROP COLUMN "demo_network_admission_max",
      DROP COLUMN "demo_global_admission_window_seconds", DROP COLUMN "demo_global_admission_max",
      DROP COLUMN "demo_session_ttl_hours", DROP COLUMN "demo_default_lifetime_limit_units", DROP COLUMN "demo_default_daily_limit_units"`);
  }
}
