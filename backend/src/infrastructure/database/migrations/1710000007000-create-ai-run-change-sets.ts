import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAiRunChangeSets1710000007000 implements MigrationInterface {
  public readonly name = 'CreateAiRunChangeSets1710000007000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "change_set_status" AS ENUM ('awaiting_approval', 'applying', 'applied', 'rejected', 'stale', 'blocked', 'failed', 'needs_manual_review')`);
    await queryRunner.query(`CREATE TYPE "change_set_decision" AS ENUM ('pending', 'approved', 'rejected')`);
    await queryRunner.query(`CREATE TABLE "ai_run_change_sets" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "owner_id" uuid NOT NULL,
      "project_id" uuid NOT NULL,
      "run_id" uuid NOT NULL,
      "proposal_hash" text NOT NULL,
      "status" "change_set_status" NOT NULL DEFAULT 'awaiting_approval',
      "decision" "change_set_decision" NOT NULL DEFAULT 'pending',
      "operations" jsonb NOT NULL,
      "total_size_bytes" integer NOT NULL,
      "total_line_count" integer NOT NULL,
      "preview_limit_bytes" integer NOT NULL,
      "preview_limit_lines" integer NOT NULL,
      "fake_runtime" boolean NOT NULL DEFAULT true,
      "backup_checkpoints" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "result" jsonb NULL,
      "decision_idempotency_key" text NULL,
      "decision_fingerprint" text NULL,
      "safe_message" text NOT NULL,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT "PK_ai_run_change_sets_id" PRIMARY KEY ("id"),
      CONSTRAINT "FK_ai_run_change_sets_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
      CONSTRAINT "FK_ai_run_change_sets_project_id" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
      CONSTRAINT "FK_ai_run_change_sets_run_id" FOREIGN KEY ("run_id") REFERENCES "ai_runs" ("id") ON DELETE CASCADE,
      CONSTRAINT "UQ_ai_run_change_sets_run_id" UNIQUE ("run_id"),
      CONSTRAINT "CHK_ai_run_change_sets_size_nonnegative" CHECK ("total_size_bytes" >= 0),
      CONSTRAINT "CHK_ai_run_change_sets_lines_nonnegative" CHECK ("total_line_count" >= 0),
      CONSTRAINT "CHK_ai_run_change_sets_decision_fingerprint_pair" CHECK (("decision_idempotency_key" IS NULL) = ("decision_fingerprint" IS NULL))
    )`);
    await queryRunner.query('CREATE INDEX "IDX_ai_run_change_sets_owner_project_updated" ON "ai_run_change_sets" ("owner_id", "project_id", "updated_at" DESC)');
    await queryRunner.query('CREATE INDEX "IDX_ai_run_change_sets_proposal_hash" ON "ai_run_change_sets" ("proposal_hash")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_ai_run_change_sets_proposal_hash"');
    await queryRunner.query('DROP INDEX "IDX_ai_run_change_sets_owner_project_updated"');
    await queryRunner.query('DROP TABLE "ai_run_change_sets"');
    await queryRunner.query('DROP TYPE "change_set_decision"');
    await queryRunner.query('DROP TYPE "change_set_status"');
  }
}
