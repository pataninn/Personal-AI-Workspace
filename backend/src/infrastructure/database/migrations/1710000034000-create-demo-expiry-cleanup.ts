import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Stores restartable demo expiry work and root-creation effect receipts. */
export class CreateDemoExpiryCleanup1710000034000 implements MigrationInterface {
  public readonly name = 'CreateDemoExpiryCleanup1710000034000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "demo_admissions" DROP CONSTRAINT "demo_admissions_failure_code_check"`);
    await queryRunner.query(`ALTER TABLE "demo_admissions" ADD CONSTRAINT "CHK_demo_admissions_failure_code"
      CHECK ("failure_code" IS NULL OR "failure_code" IN ('storage_unavailable', 'storage_not_empty', 'session_unavailable', 'expired'))`);
    await queryRunner.query('ALTER TABLE "credit_provider_call_reservations" ALTER COLUMN "owner_id" DROP NOT NULL');
    await queryRunner.query('ALTER TABLE "credit_usage_entries" ALTER COLUMN "owner_id" DROP NOT NULL');
    await queryRunner.query(`
      CREATE TABLE "demo_expiry_cleanups" (
        "admission_id" uuid PRIMARY KEY REFERENCES "demo_admissions"("id") ON DELETE RESTRICT,
        "generation" uuid NOT NULL DEFAULT gen_random_uuid(),
        "phase" text NOT NULL CHECK ("phase" IN ('fenced', 'draining', 'purging', 'finalizing')),
        "manifest" jsonb NOT NULL CHECK (jsonb_typeof("manifest") = 'object'),
        "lease_token" uuid NULL,
        "lease_expires_at" timestamptz NULL,
        "next_attempt_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        "attempts" integer NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
        "failure_code" text NULL CHECK ("failure_code" IS NULL OR "failure_code" IN ('busy', 'cancellation', 'unknown_effect', 'unsafe_root', 'storage')),
        "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "CHK_demo_expiry_cleanup_lease" CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_demo_expiry_cleanup_due"
      ON "demo_expiry_cleanups" ("next_attempt_at", "lease_expires_at", "created_at")`);
    await queryRunner.query(`
      CREATE TABLE "demo_copy_effect_receipts" (
        "admission_id" uuid PRIMARY KEY REFERENCES "demo_admissions"("id") ON DELETE RESTRICT,
        "owner_id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "effect_kind" text NOT NULL CHECK ("effect_kind" = 'managed_project_root_create'),
        "claim_token" uuid NULL,
        "outcome" text NOT NULL CHECK ("outcome" IN ('pending', 'absent', 'verified', 'unknown')),
        "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        "completed_at" timestamptz NULL,
        "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "CHK_demo_copy_effect_receipt_completion" CHECK (("outcome" = 'pending') = ("completed_at" IS NULL))
      )
    `);
    await queryRunner.query(`
      INSERT INTO "demo_copy_effect_receipts" ("admission_id", "owner_id", "project_id", "effect_kind", "claim_token", "outcome", "completed_at")
      SELECT c."admission_id", c."owner_id", c."target_project_id", 'managed_project_root_create', c."claim_token",
        CASE WHEN c."phase" IN ('root_created', 'database_created', 'files_pending', 'complete') THEN 'verified'
             WHEN c."phase" = 'root_pending' AND c."claim_token" IS NOT NULL THEN 'pending'
             ELSE 'unknown' END,
        CASE WHEN c."phase" IN ('root_created', 'database_created', 'files_pending', 'complete') THEN clock_timestamp()
             WHEN c."phase" = 'root_pending' AND c."claim_token" IS NOT NULL THEN NULL
             ELSE clock_timestamp() END
      FROM "demo_showcase_copies" c
      WHERE c."workspace_mode" = 'file_backed' OR c."phase" IN ('root_pending', 'root_created', 'database_created', 'files_pending')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { readonly has_jobs: boolean; readonly has_receipts: boolean; readonly has_tombstones: boolean;
      readonly has_detached_credit_rows: boolean }[] =
      await queryRunner.query(`SELECT EXISTS (SELECT 1 FROM "demo_expiry_cleanups") AS "has_jobs",
        EXISTS (SELECT 1 FROM "demo_copy_effect_receipts") AS "has_receipts",
        EXISTS (SELECT 1 FROM "demo_admissions" WHERE "failure_code" = 'expired') AS "has_tombstones",
        (EXISTS (SELECT 1 FROM "credit_provider_call_reservations" WHERE "owner_id" IS NULL)
          OR EXISTS (SELECT 1 FROM "credit_usage_entries" WHERE "owner_id" IS NULL)) AS "has_detached_credit_rows"`);
    if (rows[0]?.has_jobs || rows[0]?.has_receipts || rows[0]?.has_tombstones || rows[0]?.has_detached_credit_rows) {
      throw new Error('Demo expiry rollback is blocked while cleanup work, effect receipts, replay tombstones, or detached credit ledger rows exist.');
    }
    await queryRunner.query('DROP TABLE "demo_copy_effect_receipts"');
    await queryRunner.query('DROP INDEX "IDX_demo_expiry_cleanup_due"');
    await queryRunner.query('DROP TABLE "demo_expiry_cleanups"');
    await queryRunner.query('ALTER TABLE "demo_admissions" DROP CONSTRAINT "CHK_demo_admissions_failure_code"');
    await queryRunner.query(`ALTER TABLE "demo_admissions" ADD CONSTRAINT "demo_admissions_failure_code_check"
      CHECK ("failure_code" IS NULL OR "failure_code" IN ('storage_unavailable', 'storage_not_empty', 'session_unavailable'))`);
    await queryRunner.query('ALTER TABLE "credit_usage_entries" ALTER COLUMN "owner_id" SET NOT NULL');
    await queryRunner.query('ALTER TABLE "credit_provider_call_reservations" ALTER COLUMN "owner_id" SET NOT NULL');
  }
}
