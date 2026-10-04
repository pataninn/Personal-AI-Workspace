import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddContextFileExclusions1710000015000 implements MigrationInterface {
  public readonly name = 'AddContextFileExclusions1710000015000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_chat_context"
      ADD COLUMN "excluded_paths" jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD CONSTRAINT "CHK_chat_context_excluded_paths" CHECK (jsonb_typeof("excluded_paths") = 'array')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_chat_context"
      DROP CONSTRAINT "CHK_chat_context_excluded_paths", DROP COLUMN "excluded_paths"`);
  }
}
