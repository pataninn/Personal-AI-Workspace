import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAiRunProviderUsage1710000011000 implements MigrationInterface {
  public readonly name = 'AddAiRunProviderUsage1710000011000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_runs"
      ADD COLUMN "provider_prompt_tokens" bigint NULL,
      ADD COLUMN "provider_completion_tokens" bigint NULL,
      ADD COLUMN "provider_total_tokens" bigint NULL,
      ADD CONSTRAINT "CHK_ai_runs_provider_prompt_tokens_nonnegative" CHECK ("provider_prompt_tokens" IS NULL OR "provider_prompt_tokens" >= 0),
      ADD CONSTRAINT "CHK_ai_runs_provider_completion_tokens_nonnegative" CHECK ("provider_completion_tokens" IS NULL OR "provider_completion_tokens" >= 0),
      ADD CONSTRAINT "CHK_ai_runs_provider_total_tokens_nonnegative" CHECK ("provider_total_tokens" IS NULL OR "provider_total_tokens" >= 0)`);
    await queryRunner.query('CREATE INDEX "IDX_ai_runs_owner_project_created" ON "ai_runs" ("owner_id", "project_id", "created_at" DESC, "id" ASC)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_ai_runs_owner_project_created"');
    await queryRunner.query(`ALTER TABLE "ai_runs" DROP CONSTRAINT "CHK_ai_runs_provider_total_tokens_nonnegative", DROP CONSTRAINT "CHK_ai_runs_provider_completion_tokens_nonnegative", DROP CONSTRAINT "CHK_ai_runs_provider_prompt_tokens_nonnegative", DROP COLUMN "provider_total_tokens", DROP COLUMN "provider_completion_tokens", DROP COLUMN "provider_prompt_tokens"`);
  }
}
