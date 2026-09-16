import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAiRunsAndEgress1710000004000 implements MigrationInterface {
  public readonly name = 'CreateAiRunsAndEgress1710000004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "ai_run_status" AS ENUM ('pending_approval', 'rejected', 'staging', 'ready', 'failed', 'review_required')`);
    await queryRunner.query(`CREATE TYPE "ai_run_phase" AS ENUM ('manifest', 'decision', 'staging', 'runtime', 'review')`);
    await queryRunner.query(`CREATE TYPE "ai_run_decision" AS ENUM ('pending', 'approved', 'rejected')`);
    await queryRunner.query(`CREATE TYPE "ai_run_cleanup_status" AS ENUM ('not_started', 'complete', 'unknown')`);
    await queryRunner.query(`CREATE TYPE "ai_run_provider_transmission" AS ENUM ('not_started', 'not_started_confirmed', 'unknown')`);
    await queryRunner.query(`
      CREATE TABLE "ai_runs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "request" text NOT NULL,
        "relative_root" text NOT NULL,
        "requested_paths" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "manifest" jsonb NOT NULL,
        "manifest_hash" text NOT NULL,
        "manifest_invalidated" boolean NOT NULL DEFAULT false,
        "status" "ai_run_status" NOT NULL DEFAULT 'pending_approval',
        "phase" "ai_run_phase" NOT NULL DEFAULT 'decision',
        "decision" "ai_run_decision" NOT NULL DEFAULT 'pending',
        "cleanup" "ai_run_cleanup_status" NOT NULL DEFAULT 'not_started',
        "provider_transmission" "ai_run_provider_transmission" NOT NULL DEFAULT 'not_started_confirmed',
        "staging_item_count" integer NOT NULL DEFAULT 0,
        "runtime_kind" text NULL,
        "sandbox_ready" boolean NOT NULL DEFAULT false,
        "create_idempotency_key" text NOT NULL,
        "request_fingerprint" text NOT NULL,
        "decision_idempotency_key" text NULL,
        "decision_fingerprint" text NULL,
        "safe_message" text NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_runs_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ai_runs_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_ai_runs_project_id" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_ai_runs_conversation_id" FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_ai_runs_staging_item_count_nonnegative" CHECK ("staging_item_count" >= 0),
        CONSTRAINT "CHK_ai_runs_decision_fingerprint_pair" CHECK (("decision_idempotency_key" IS NULL) = ("decision_fingerprint" IS NULL))
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_ai_runs_create_idempotency" ON "ai_runs" ("owner_id", "project_id", "create_idempotency_key")');
    await queryRunner.query('CREATE INDEX "IDX_ai_runs_owner_project_updated" ON "ai_runs" ("owner_id", "project_id", "updated_at" DESC, "id" ASC)');
    await queryRunner.query('CREATE INDEX "IDX_ai_runs_conversation" ON "ai_runs" ("conversation_id", "created_at" DESC)');
    await queryRunner.query('CREATE INDEX "IDX_ai_runs_manifest_hash" ON "ai_runs" ("manifest_hash")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_ai_runs_manifest_hash"');
    await queryRunner.query('DROP INDEX "IDX_ai_runs_conversation"');
    await queryRunner.query('DROP INDEX "IDX_ai_runs_owner_project_updated"');
    await queryRunner.query('DROP INDEX "UQ_ai_runs_create_idempotency"');
    await queryRunner.query('DROP TABLE "ai_runs"');
    await queryRunner.query('DROP TYPE "ai_run_provider_transmission"');
    await queryRunner.query('DROP TYPE "ai_run_cleanup_status"');
    await queryRunner.query('DROP TYPE "ai_run_decision"');
    await queryRunner.query('DROP TYPE "ai_run_phase"');
    await queryRunner.query('DROP TYPE "ai_run_status"');
  }
}
