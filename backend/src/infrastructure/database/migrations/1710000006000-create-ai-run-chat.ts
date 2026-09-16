import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAiRunChat1710000006000 implements MigrationInterface {
  public readonly name = 'CreateAiRunChat1710000006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of ['queued', 'running', 'waiting_approval', 'succeeded', 'cancel_requested', 'cancelled', 'blocked']) {
      await queryRunner.query(`ALTER TYPE "ai_run_status" ADD VALUE IF NOT EXISTS '${value}'`);
    }
    for (const value of ['inference', 'terminal']) {
      await queryRunner.query(`ALTER TYPE "ai_run_phase" ADD VALUE IF NOT EXISTS '${value}'`);
    }
    await queryRunner.query(`
      ALTER TABLE "ai_runs"
        ADD COLUMN "runtime_reference" text NULL,
        ADD COLUMN "request_message_id" uuid NULL,
        ADD COLUMN "assistant_message_id" uuid NULL,
        ADD COLUMN "assistant_complete" boolean NOT NULL DEFAULT false,
        ADD COLUMN "assistant_content_length" integer NULL,
        ADD COLUMN "start_idempotency_key" text NULL,
        ADD COLUMN "start_fingerprint" text NULL,
        ADD COLUMN "cancel_idempotency_key" text NULL,
        ADD COLUMN "cancel_fingerprint" text NULL,
        ADD CONSTRAINT "FK_ai_runs_request_message_id" FOREIGN KEY ("request_message_id") REFERENCES "messages" ("id") ON DELETE SET NULL,
        ADD CONSTRAINT "FK_ai_runs_assistant_message_id" FOREIGN KEY ("assistant_message_id") REFERENCES "messages" ("id") ON DELETE SET NULL,
        ADD CONSTRAINT "CHK_ai_runs_assistant_content_length_nonnegative" CHECK ("assistant_content_length" IS NULL OR "assistant_content_length" >= 0),
        ADD CONSTRAINT "CHK_ai_runs_start_fingerprint_pair" CHECK (("start_idempotency_key" IS NULL) = ("start_fingerprint" IS NULL)),
        ADD CONSTRAINT "CHK_ai_runs_cancel_fingerprint_pair" CHECK (("cancel_idempotency_key" IS NULL) = ("cancel_fingerprint" IS NULL))
    `);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_ai_runs_start_idempotency" ON "ai_runs" ("owner_id", "id", "start_idempotency_key") WHERE "start_idempotency_key" IS NOT NULL');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_ai_runs_cancel_idempotency" ON "ai_runs" ("owner_id", "id", "cancel_idempotency_key") WHERE "cancel_idempotency_key" IS NOT NULL');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "UQ_ai_runs_cancel_idempotency"');
    await queryRunner.query('DROP INDEX "UQ_ai_runs_start_idempotency"');
    await queryRunner.query('ALTER TABLE "ai_runs" DROP CONSTRAINT "CHK_ai_runs_cancel_fingerprint_pair", DROP CONSTRAINT "CHK_ai_runs_start_fingerprint_pair", DROP CONSTRAINT "CHK_ai_runs_assistant_content_length_nonnegative", DROP CONSTRAINT "FK_ai_runs_assistant_message_id", DROP CONSTRAINT "FK_ai_runs_request_message_id", DROP COLUMN "cancel_fingerprint", DROP COLUMN "cancel_idempotency_key", DROP COLUMN "start_fingerprint", DROP COLUMN "start_idempotency_key", DROP COLUMN "assistant_content_length", DROP COLUMN "assistant_complete", DROP COLUMN "assistant_message_id", DROP COLUMN "request_message_id", DROP COLUMN "runtime_reference"');
  }
}
