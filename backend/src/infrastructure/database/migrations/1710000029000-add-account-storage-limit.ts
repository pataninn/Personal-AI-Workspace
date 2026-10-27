import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds the shared account storage limit and durable storage accounting state. */
export class AddAccountStorageLimit1710000029000 implements MigrationInterface {
  public readonly name = 'AddAccountStorageLimit1710000029000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "account_limits"
        ADD COLUMN "storage_limit_bytes" bigint NULL
        CHECK ("storage_limit_bytes" IS NULL OR "storage_limit_bytes" >= 0)
    `);
    await queryRunner.query(`
      CREATE TABLE "storage_account_totals" (
        "owner_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
        "used_bytes" bigint NOT NULL DEFAULT 0 CHECK ("used_bytes" >= 0),
        "reserved_bytes" bigint NOT NULL DEFAULT 0 CHECK ("reserved_bytes" >= 0),
        "accounting_state" text NOT NULL DEFAULT 'reconciling'
          CHECK ("accounting_state" IN ('reconciling', 'ready', 'unavailable')),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      INSERT INTO "storage_account_totals" ("owner_id", "accounting_state")
      SELECT "owner_id", 'reconciling' FROM "account_limits"
      ON CONFLICT ("owner_id") DO NOTHING
    `);
    await queryRunner.query(`
      CREATE TABLE "storage_resource_references" (
        "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "resource_kind" text NOT NULL CHECK ("resource_kind" IN ('database_content', 'project_file', 'recovery_file', 'retained_root')),
        "resource_key" text NOT NULL CHECK (length("resource_key") BETWEEN 1 AND 2048),
        "copy_key" text NOT NULL CHECK (length("copy_key") BETWEEN 1 AND 2048),
        "project_id" uuid NULL,
        "root_key" text NULL,
        "relative_key" text NULL CHECK ("relative_key" IS NULL OR length("relative_key") BETWEEN 1 AND 2048),
        "byte_count" bigint NOT NULL CHECK ("byte_count" >= 0),
        "sha256" text NULL CHECK ("sha256" IS NULL OR "sha256" ~ '^[a-f0-9]{64}$'),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_storage_resource_references" PRIMARY KEY ("owner_id", "resource_kind", "resource_key", "copy_key"),
        CONSTRAINT "CHK_storage_resource_reference_location" CHECK (
          ("resource_kind" = 'database_content' AND "root_key" IS NULL AND "relative_key" IS NULL)
          OR ("resource_kind" <> 'database_content' AND "root_key" IS NOT NULL AND "relative_key" IS NOT NULL)
        )
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_storage_resource_references_project" ON "storage_resource_references" ("owner_id", "project_id")');
    await queryRunner.query(`
      CREATE TABLE "storage_filesystem_reservations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "project_id" uuid NULL,
        "operation_key" text NOT NULL CHECK (length("operation_key") BETWEEN 1 AND 128),
        "fingerprint" text NOT NULL CHECK ("fingerprint" ~ '^[a-f0-9]{64}$'),
        "root_key" text NOT NULL CHECK (length("root_key") BETWEEN 1 AND 2048),
        "target_key" text NOT NULL CHECK (length("target_key") BETWEEN 1 AND 2048),
        "expected_prior_sha256" text NULL CHECK ("expected_prior_sha256" IS NULL OR "expected_prior_sha256" ~ '^[a-f0-9]{64}$'),
        "expected_prior_size_bytes" bigint NULL CHECK ("expected_prior_size_bytes" IS NULL OR "expected_prior_size_bytes" >= 0),
        "intended_sha256" text NULL CHECK ("intended_sha256" IS NULL OR "intended_sha256" ~ '^[a-f0-9]{64}$'),
        "intended_size_bytes" bigint NULL CHECK ("intended_size_bytes" IS NULL OR "intended_size_bytes" >= 0),
        "anticipated_recovery_bytes" bigint NOT NULL DEFAULT 0 CHECK ("anticipated_recovery_bytes" >= 0),
        "reserved_growth_bytes" bigint NOT NULL DEFAULT 0 CHECK ("reserved_growth_bytes" >= 0),
        "reference_changes" jsonb NOT NULL CHECK (jsonb_typeof("reference_changes") = 'array'),
        "observed_changes" jsonb NULL CHECK ("observed_changes" IS NULL OR jsonb_typeof("observed_changes") = 'array'),
        "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'unknown', 'settled', 'released')),
        "outcome" jsonb NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_storage_filesystem_reservations_operation" UNIQUE ("owner_id", "operation_key")
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_storage_filesystem_reservations_owner_status" ON "storage_filesystem_reservations" ("owner_id", "status")');
    await queryRunner.query(`
      CREATE TABLE "storage_filesystem_reservation_references" (
        "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "resource_kind" text NOT NULL CHECK ("resource_kind" IN ('project_file', 'recovery_file', 'retained_root')),
        "resource_key" text NOT NULL CHECK (length("resource_key") BETWEEN 1 AND 2048),
        "copy_key" text NOT NULL CHECK (length("copy_key") BETWEEN 1 AND 2048),
        "reservation_id" uuid NOT NULL REFERENCES "storage_filesystem_reservations"("id") ON DELETE CASCADE,
        CONSTRAINT "PK_storage_filesystem_reservation_references" PRIMARY KEY ("owner_id", "resource_kind", "resource_key", "copy_key")
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_storage_filesystem_reservation_references_reservation" ON "storage_filesystem_reservation_references" ("reservation_id")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly {
      has_references: boolean;
      has_reservations: boolean;
      has_usage: boolean;
      has_reserved_bytes: boolean;
      has_configured_limits: boolean;
      has_reconciled_accounts: boolean;
    }[] = await queryRunner.query(`
      SELECT EXISTS (SELECT 1 FROM "storage_resource_references") AS "has_references",
             EXISTS (SELECT 1 FROM "storage_filesystem_reservations") AS "has_reservations",
             EXISTS (SELECT 1 FROM "storage_account_totals" WHERE "used_bytes" <> 0) AS "has_usage",
             EXISTS (SELECT 1 FROM "storage_account_totals" WHERE "reserved_bytes" <> 0) AS "has_reserved_bytes",
             EXISTS (SELECT 1 FROM "account_limits" WHERE "storage_limit_bytes" IS NOT NULL) AS "has_configured_limits",
             EXISTS (SELECT 1 FROM "storage_account_totals" WHERE "accounting_state" <> 'reconciling') AS "has_reconciled_accounts"
    `);
    if (rows[0]?.has_references || rows[0]?.has_reservations || rows[0]?.has_usage || rows[0]?.has_reserved_bytes
      || rows[0]?.has_configured_limits || rows[0]?.has_reconciled_accounts) {
      throw new Error('Storage quota rollback is blocked after limits, content references, reservations, or usage have been written.');
    }

    await queryRunner.query('DROP INDEX "IDX_storage_filesystem_reservations_owner_status"');
    await queryRunner.query('DROP INDEX "IDX_storage_filesystem_reservation_references_reservation"');
    await queryRunner.query('DROP TABLE "storage_filesystem_reservation_references"');
    await queryRunner.query('DROP TABLE "storage_filesystem_reservations"');
    await queryRunner.query('DROP INDEX "IDX_storage_resource_references_project"');
    await queryRunner.query('DROP TABLE "storage_resource_references"');
    await queryRunner.query('DROP TABLE "storage_account_totals"');
    await queryRunner.query('ALTER TABLE "account_limits" DROP COLUMN "storage_limit_bytes"');
  }
}
