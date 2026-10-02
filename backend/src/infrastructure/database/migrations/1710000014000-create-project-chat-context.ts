import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProjectChatContext1710000014000 implements MigrationInterface {
  public readonly name = 'CreateProjectChatContext1710000014000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "project_chat_context" (
      "project_id" uuid PRIMARY KEY,
      "owner_id" uuid NOT NULL,
      "relative_paths" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "fact_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "include_project_conversations" boolean NOT NULL DEFAULT true,
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "FK_chat_context_project_owner" FOREIGN KEY ("owner_id", "project_id")
        REFERENCES "projects" ("owner_id", "id") ON DELETE CASCADE,
      CONSTRAINT "CHK_chat_context_arrays" CHECK (jsonb_typeof("relative_paths") = 'array' AND jsonb_typeof("fact_ids") = 'array')
    )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "project_chat_context"');
  }
}
