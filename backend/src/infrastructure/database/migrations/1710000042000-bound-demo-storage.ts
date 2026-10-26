import type { MigrationInterface, QueryRunner } from 'typeorm';

export class BoundDemoStorage1710000042000 implements MigrationInterface {
  public readonly name = 'BoundDemoStorage1710000042000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Only untouched legacy defaults are repaired; admin revisions retain their explicit policy.
    await queryRunner.query(`
      WITH changed AS (
        UPDATE "account_limits" l SET "storage_limit_bytes" = 67108864
        FROM "users" u WHERE u."id" = l."owner_id" AND u."account_kind" = 'demo'
          AND l."storage_limit_bytes" IS NULL AND l."limits_revision" = 1
        RETURNING l."owner_id"
      )
      INSERT INTO "admin_audit_events" ("actor_id", "action", "target_account_id", "old_values", "new_values")
      SELECT NULL, 'demo.storage-default.backfill', "owner_id",
        '{"storageLimitBytes":null,"limitsRevision":1}'::jsonb,
        '{"storageLimitBytes":"67108864","limitsRevision":1}'::jsonb FROM changed
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Do not remove a cap from new demos or overwrite a later administrator decision.
    await queryRunner.query(`
      UPDATE "account_limits" l SET "storage_limit_bytes" = NULL
      FROM "admin_audit_events" a, "users" u
      WHERE a."action" = 'demo.storage-default.backfill' AND a."target_account_id" = l."owner_id"
        AND u."id" = l."owner_id" AND u."account_kind" = 'demo'
        AND l."limits_revision" = 1 AND l."storage_limit_bytes" = 67108864
    `);
    await queryRunner.query(`DELETE FROM "admin_audit_events" WHERE "action" = 'demo.storage-default.backfill'`);
  }
}
