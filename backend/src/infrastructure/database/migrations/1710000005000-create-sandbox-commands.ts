import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSandboxCommands1710000005000 implements MigrationInterface {
  public readonly name = 'CreateSandboxCommands1710000005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "sandbox_command_classification" AS ENUM ('safe', 'sensitive', 'blocked')`);
    await queryRunner.query(`CREATE TYPE "sandbox_command_decision" AS ENUM ('pending', 'approved', 'rejected', 'not_applicable')`);
    await queryRunner.query(`CREATE TYPE "sandbox_command_status" AS ENUM ('awaiting_approval', 'running', 'completed', 'failed', 'timed_out', 'output_truncated', 'rejected', 'blocked', 'cancel_requested', 'cancelled', 'review_required')`);
    await queryRunner.query(`CREATE TABLE "sandbox_commands" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "owner_id" uuid NOT NULL,
      "project_id" uuid NOT NULL,
      "run_id" uuid NOT NULL,
      "proposal_hash" text NOT NULL,
      "command" text NOT NULL,
      "args" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "cwd" text NOT NULL DEFAULT '.',
      "summary" text NOT NULL,
      "classification" "sandbox_command_classification" NOT NULL,
      "blocked_reason" text NULL,
      "decision" "sandbox_command_decision" NOT NULL DEFAULT 'pending',
      "status" "sandbox_command_status" NOT NULL DEFAULT 'awaiting_approval',
      "limits" jsonb NOT NULL,
      "result" jsonb NULL,
      "cancel_requested" boolean NOT NULL DEFAULT false,
      "create_idempotency_key" text NOT NULL,
      "create_fingerprint" text NOT NULL,
      "decision_idempotency_key" text NULL,
      "decision_fingerprint" text NULL,
      "cancel_idempotency_key" text NULL,
      "cancel_fingerprint" text NULL,
      "safe_message" text NOT NULL,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT "PK_sandbox_commands_id" PRIMARY KEY ("id"),
      CONSTRAINT "FK_sandbox_commands_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
      CONSTRAINT "FK_sandbox_commands_project_id" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
      CONSTRAINT "FK_sandbox_commands_run_id" FOREIGN KEY ("run_id") REFERENCES "ai_runs" ("id") ON DELETE CASCADE,
      CONSTRAINT "CHK_sandbox_commands_decision_fingerprint_pair" CHECK (("decision_idempotency_key" IS NULL) = ("decision_fingerprint" IS NULL)),
      CONSTRAINT "CHK_sandbox_commands_cancel_fingerprint_pair" CHECK (("cancel_idempotency_key" IS NULL) = ("cancel_fingerprint" IS NULL))
    )`);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_sandbox_commands_create_idempotency" ON "sandbox_commands" ("owner_id", "run_id", "create_idempotency_key")');
    await queryRunner.query('CREATE INDEX "IDX_sandbox_commands_run_created" ON "sandbox_commands" ("owner_id", "run_id", "created_at" ASC, "id" ASC)');
    await queryRunner.query('CREATE INDEX "IDX_sandbox_commands_proposal_hash" ON "sandbox_commands" ("proposal_hash")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_sandbox_commands_proposal_hash"');
    await queryRunner.query('DROP INDEX "IDX_sandbox_commands_run_created"');
    await queryRunner.query('DROP INDEX "UQ_sandbox_commands_create_idempotency"');
    await queryRunner.query('DROP TABLE "sandbox_commands"');
    await queryRunner.query('DROP TYPE "sandbox_command_status"');
    await queryRunner.query('DROP TYPE "sandbox_command_decision"');
    await queryRunner.query('DROP TYPE "sandbox_command_classification"');
  }
}
