import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProjectFacts1710000009000 implements MigrationInterface {
  public readonly name = 'CreateProjectFacts1710000009000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "project_facts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "fact_key" text NOT NULL,
        "title" text NOT NULL,
        "content" text NOT NULL,
        "source_kind" text NOT NULL DEFAULT 'user',
        "version" integer NOT NULL DEFAULT 1,
        "verified_at" TIMESTAMPTZ NULL,
        "deleted_at" TIMESTAMPTZ NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_facts_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_project_facts_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_project_facts_project_id" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_project_facts_source_kind" CHECK ("source_kind" = 'user'),
        CONSTRAINT "CHK_project_facts_version_positive" CHECK ("version" > 0),
        CONSTRAINT "CHK_project_facts_title_length" CHECK (char_length("title") BETWEEN 1 AND 120),
        CONSTRAINT "CHK_project_facts_content_length" CHECK (octet_length("content") BETWEEN 1 AND 4096)
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_project_facts_active_key" ON "project_facts" ("owner_id", "project_id", "fact_key") WHERE "deleted_at" IS NULL');
    await queryRunner.query('CREATE INDEX "IDX_project_facts_owner_project_updated" ON "project_facts" ("owner_id", "project_id", "updated_at" DESC, "id" ASC) WHERE "deleted_at" IS NULL');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_project_facts_owner_project_updated"');
    await queryRunner.query('DROP INDEX "UQ_project_facts_active_key"');
    await queryRunner.query('DROP TABLE "project_facts"');
  }
}
