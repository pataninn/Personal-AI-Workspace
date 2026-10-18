import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds regular/demo identity fields and preserves the legacy local owner. */
export class AddAccountIdentity1710000026000 implements MigrationInterface {
  public readonly name = 'AddAccountIdentity1710000026000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL');
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN "identifier" text NULL,
        ADD COLUMN "account_kind" text NOT NULL DEFAULT 'regular',
        ADD COLUMN "role" text NOT NULL DEFAULT 'user',
        ADD COLUMN "expires_at" timestamptz NULL
    `);
    await queryRunner.query(`
      UPDATE "users"
      SET "identifier" = CASE
            WHEN "scope_key" = 'local' THEN 'owner'
            ELSE 'legacy-' || replace("id"::text, '-', '')
          END,
          "role" = CASE WHEN "scope_key" = 'local' THEN 'admin' ELSE 'user' END
      WHERE "identifier" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD CONSTRAINT "UQ_users_identifier" UNIQUE ("identifier"),
        ADD CONSTRAINT "CHK_users_account_kind" CHECK ("account_kind" IN ('regular', 'demo')),
        ADD CONSTRAINT "CHK_users_role" CHECK ("role" IN ('user', 'admin')),
        ADD CONSTRAINT "CHK_users_identifier_format" CHECK ("identifier" IS NULL OR "identifier" ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
        ADD CONSTRAINT "CHK_users_identity_shape" CHECK (
          ("account_kind" = 'regular' AND "identifier" IS NOT NULL AND "password_hash" IS NOT NULL AND "expires_at" IS NULL)
          OR ("account_kind" = 'demo' AND "identifier" IS NULL AND "password_hash" IS NULL AND "expires_at" IS NOT NULL AND "role" = 'user')
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { has_managed_accounts: boolean; has_passwordless_accounts: boolean }[] = await queryRunner.query(`
      SELECT EXISTS (SELECT 1 FROM "users" WHERE "scope_key" LIKE 'account:%') AS "has_managed_accounts",
             EXISTS (SELECT 1 FROM "users" WHERE "password_hash" IS NULL) AS "has_passwordless_accounts"
    `);
    if (rows[0]?.has_managed_accounts || rows[0]?.has_passwordless_accounts) {
      throw new Error('Account identity rollback is blocked while managed or passwordless accounts exist.');
    }

    await queryRunner.query('ALTER TABLE "users" DROP CONSTRAINT "CHK_users_identity_shape"');
    await queryRunner.query('ALTER TABLE "users" DROP CONSTRAINT "CHK_users_identifier_format"');
    await queryRunner.query('ALTER TABLE "users" DROP CONSTRAINT "CHK_users_role"');
    await queryRunner.query('ALTER TABLE "users" DROP CONSTRAINT "CHK_users_account_kind"');
    await queryRunner.query('ALTER TABLE "users" DROP CONSTRAINT "UQ_users_identifier"');
    await queryRunner.query('ALTER TABLE "users" DROP COLUMN "expires_at", DROP COLUMN "role", DROP COLUMN "account_kind", DROP COLUMN "identifier"');
    await queryRunner.query('ALTER TABLE "users" ALTER COLUMN "password_hash" SET NOT NULL');
  }
}
