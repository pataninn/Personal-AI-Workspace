import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProviderPermissions1710000013000 implements MigrationInterface {
  public readonly name = 'CreateProviderPermissions1710000013000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_projects_owner_id" ON "projects" ("owner_id", "id")');
    await queryRunner.query(`
      CREATE TABLE "provider_permissions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "provider_profile" text NOT NULL,
        "model" text NOT NULL,
        "capability" text NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "expires_at" TIMESTAMPTZ NULL,
        "revoked_at" TIMESTAMPTZ NULL,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_provider_permissions_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_provider_permissions_owner_project_id" UNIQUE ("owner_id", "project_id", "id"),
        CONSTRAINT "FK_provider_permissions_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_provider_permissions_project_owner" FOREIGN KEY ("owner_id", "project_id") REFERENCES "projects" ("owner_id", "id") ON DELETE CASCADE,
        CONSTRAINT "CHK_provider_permissions_provider_profile" CHECK (length("provider_profile") BETWEEN 1 AND 100),
        CONSTRAINT "CHK_provider_permissions_model" CHECK (length("model") BETWEEN 1 AND 200),
        CONSTRAINT "CHK_provider_permissions_capability" CHECK ("capability" = 'send_selected_context')
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_provider_permissions_active_scope" ON "provider_permissions" ("owner_id", "project_id", "provider_profile", "model", "capability") WHERE "revoked_at" IS NULL');
    await queryRunner.query('CREATE INDEX "IDX_provider_permissions_owner_project_created" ON "provider_permissions" ("owner_id", "project_id", "created_at" DESC, "id" ASC)');
    await queryRunner.query('ALTER TABLE "ai_runs" ADD COLUMN "provider_permission_id" uuid NULL');
    await queryRunner.query(`ALTER TABLE "ai_runs" ADD CONSTRAINT "FK_ai_runs_provider_permission_scope"
      FOREIGN KEY ("owner_id", "project_id", "provider_permission_id")
      REFERENCES "provider_permissions" ("owner_id", "project_id", "id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "ai_runs" DROP CONSTRAINT "FK_ai_runs_provider_permission_scope"');
    await queryRunner.query('ALTER TABLE "ai_runs" DROP COLUMN "provider_permission_id"');
    await queryRunner.query('DROP INDEX "IDX_provider_permissions_owner_project_created"');
    await queryRunner.query('DROP INDEX "UQ_provider_permissions_active_scope"');
    await queryRunner.query('DROP TABLE "provider_permissions"');
    await queryRunner.query('DROP INDEX "UQ_projects_owner_id"');
  }
}
