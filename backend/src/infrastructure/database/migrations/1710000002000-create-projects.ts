import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProjects1710000002000 implements MigrationInterface {
  public readonly name = 'CreateProjects1710000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "project_status" AS ENUM ('active', 'archived')
    `);
    await queryRunner.query(`
      CREATE TABLE "projects" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "name" text NOT NULL,
        "slug" text NOT NULL,
        "relative_root" text NOT NULL,
        "relative_root_key" text NOT NULL,
        "status" "project_status" NOT NULL DEFAULT 'active',
        "version" integer NOT NULL DEFAULT 1,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_projects_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_projects_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_projects_version_positive" CHECK ("version" > 0)
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_projects_owner_slug_active" ON "projects" ("owner_id", "slug") WHERE "status" = \'active\'');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_projects_owner_root_key_active" ON "projects" ("owner_id", "relative_root_key") WHERE "status" = \'active\'');
    await queryRunner.query('CREATE INDEX "IDX_projects_owner_status" ON "projects" ("owner_id", "status")');
    await queryRunner.query('CREATE INDEX "IDX_projects_owner_updated_at" ON "projects" ("owner_id", "updated_at")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_projects_owner_updated_at"');
    await queryRunner.query('DROP INDEX "IDX_projects_owner_status"');
    await queryRunner.query('DROP INDEX "UQ_projects_owner_root_key_active"');
    await queryRunner.query('DROP INDEX "UQ_projects_owner_slug_active"');
    await queryRunner.query('DROP TABLE "projects"');
    await queryRunner.query('DROP TYPE "project_status"');
  }
}
