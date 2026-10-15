import type { MigrationInterface, QueryRunner } from 'typeorm';

import { ActionLedgerRollbackBlockedError } from '@/modules/action-ledger/domain/action-ledger-errors';

/** Creates durable owner-scoped action receipts independently from Home transcript storage. */
export class CreateActionLedgerPersistence1710000021000 implements MigrationInterface {
  public readonly name = 'CreateActionLedgerPersistence1710000021000';

  /** Creates additive action-ledger tables and lookup indexes. */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "action_ledger_actor_kind" AS ENUM ('manual', 'assistant')`);
    await queryRunner.query(`CREATE TYPE "action_ledger_target_kind" AS ENUM ('task', 'workspace')`);
    await queryRunner.query(`CREATE TYPE "action_ledger_action_kind" AS ENUM (
      'task.create', 'task.update', 'task.move', 'task.reorder', 'task.archive', 'task.restore',
      'workspace.create', 'workspace.update', 'workspace.archive', 'workspace.restore', 'undo'
    )`);
    await queryRunner.query(`CREATE TYPE "action_ledger_undo_status" AS ENUM ('not_reversible', 'available', 'undone')`);
    await queryRunner.query(`
      CREATE TABLE "action_ledger_records" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "operation_key" text NOT NULL,
        "request_fingerprint" text NOT NULL,
        "actor_kind" "action_ledger_actor_kind" NOT NULL,
        "turn_id" uuid NULL,
        "target_kind" "action_ledger_target_kind" NOT NULL,
        "target_id" uuid NOT NULL,
        "action_kind" "action_ledger_action_kind" NOT NULL,
        "expected_version" integer NULL,
        "pre_version" integer NULL,
        "post_version" integer NULL,
        "reversible_fields" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "outcome" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "undo_status" "action_ledger_undo_status" NOT NULL DEFAULT 'not_reversible',
        "undo_of_action_id" uuid NULL,
        "undo_action_id" uuid NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_action_ledger_records_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_action_ledger_records_owner_id" UNIQUE ("owner_id", "id"),
        CONSTRAINT "UQ_action_ledger_records_owner_operation" UNIQUE ("owner_id", "operation_key"),
        CONSTRAINT "FK_action_ledger_records_owner" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_action_ledger_records_undo_of" FOREIGN KEY ("owner_id", "undo_of_action_id") REFERENCES "action_ledger_records" ("owner_id", "id") ON DELETE NO ACTION,
        CONSTRAINT "FK_action_ledger_records_undo_action" FOREIGN KEY ("owner_id", "undo_action_id") REFERENCES "action_ledger_records" ("owner_id", "id") ON DELETE NO ACTION,
        CONSTRAINT "CHK_action_ledger_records_operation_key" CHECK (char_length("operation_key") BETWEEN 1 AND 200),
        CONSTRAINT "CHK_action_ledger_records_fingerprint" CHECK (char_length("request_fingerprint") BETWEEN 1 AND 256),
        CONSTRAINT "CHK_action_ledger_records_manual_turn" CHECK ("actor_kind" <> 'manual' OR "turn_id" IS NULL),
        CONSTRAINT "CHK_action_ledger_records_undo_link" CHECK (("action_kind" = 'undo') = ("undo_of_action_id" IS NOT NULL)),
        CONSTRAINT "CHK_action_ledger_records_undo_status" CHECK (("undo_status" = 'undone') = ("undo_action_id" IS NOT NULL)),
        CONSTRAINT "CHK_action_ledger_records_expected_version" CHECK ("expected_version" IS NULL OR ("pre_version" IS NOT NULL AND "expected_version" = "pre_version")),
        CONSTRAINT "CHK_action_ledger_records_pre_version" CHECK ("pre_version" IS NULL OR "pre_version" > 0),
        CONSTRAINT "CHK_action_ledger_records_post_version" CHECK ("post_version" IS NULL OR "post_version" > 0),
        CONSTRAINT "CHK_action_ledger_records_version_advance" CHECK ("pre_version" IS NULL OR "post_version" IS NULL OR "post_version" > "pre_version"),
        CONSTRAINT "CHK_action_ledger_records_reversible_object" CHECK (jsonb_typeof("reversible_fields") = 'object' AND octet_length("reversible_fields"::text) <= 8192),
        CONSTRAINT "CHK_action_ledger_records_outcome_object" CHECK (jsonb_typeof("outcome") = 'object' AND octet_length("outcome"::text) <= 8192)
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_action_ledger_records_owner_created" ON "action_ledger_records" ("owner_id", "created_at" DESC, "id" DESC)');
    await queryRunner.query('CREATE INDEX "IDX_action_ledger_records_owner_target" ON "action_ledger_records" ("owner_id", "target_kind", "target_id", "created_at" DESC)');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_action_ledger_records_one_undo" ON "action_ledger_records" ("owner_id", "undo_of_action_id") WHERE "undo_of_action_id" IS NOT NULL');
    await queryRunner.query(`COMMENT ON COLUMN "action_ledger_records"."turn_id" IS 'Historical turn identity only; no Home foreign key so transcript retention cannot erase action receipts.'`);
    await queryRunner.query(`COMMENT ON COLUMN "action_ledger_records"."target_id" IS 'Stable target identity only; no target foreign key so moves and removal preserve the action receipt.'`);
  }

  /** Refuses rollback while any action receipt could be lost. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { has_records: boolean }[] = await queryRunner.query(`
      SELECT EXISTS (SELECT 1 FROM "action_ledger_records") AS "has_records"
    `);
    if (rows[0]?.has_records) {
      throw new ActionLedgerRollbackBlockedError();
    }
    await queryRunner.query('DROP INDEX "UQ_action_ledger_records_one_undo"');
    await queryRunner.query('DROP INDEX "IDX_action_ledger_records_owner_target"');
    await queryRunner.query('DROP INDEX "IDX_action_ledger_records_owner_created"');
    await queryRunner.query('DROP TABLE "action_ledger_records"');
    await queryRunner.query('DROP TYPE "action_ledger_undo_status"');
    await queryRunner.query('DROP TYPE "action_ledger_action_kind"');
    await queryRunner.query('DROP TYPE "action_ledger_target_kind"');
    await queryRunner.query('DROP TYPE "action_ledger_actor_kind"');
  }
}
