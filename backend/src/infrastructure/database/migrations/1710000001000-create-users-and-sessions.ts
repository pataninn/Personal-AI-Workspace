import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUsersAndSessions1710000001000 implements MigrationInterface {
  public readonly name = 'CreateUsersAndSessions1710000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "scope_key" text NOT NULL DEFAULT 'local',
        "display_name" text NOT NULL DEFAULT 'Local user',
        "password_hash" text NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_users_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_scope_key" UNIQUE ("scope_key")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "token_hash" text NOT NULL,
        "expires_at" TIMESTAMPTZ NOT NULL,
        "revoked_at" TIMESTAMPTZ NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sessions_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_sessions_token_hash" UNIQUE ("token_hash"),
        CONSTRAINT "FK_sessions_user_id" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_sessions_user_id" ON "sessions" ("user_id")');
    await queryRunner.query('CREATE INDEX "IDX_sessions_expires_at" ON "sessions" ("expires_at")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_sessions_expires_at"');
    await queryRunner.query('DROP INDEX "IDX_sessions_user_id"');
    await queryRunner.query('DROP TABLE "sessions"');
    await queryRunner.query('DROP TABLE "users"');
  }
}
