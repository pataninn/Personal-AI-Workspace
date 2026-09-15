import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateApplicationMetadata1710000000000 implements MigrationInterface {
  public readonly name = 'CreateApplicationMetadata1710000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await queryRunner.query(`
      CREATE TABLE "application_metadata" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "key" text NOT NULL,
        "value" text NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_application_metadata_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_application_metadata_key" UNIQUE ("key")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "application_metadata"');
  }
}
