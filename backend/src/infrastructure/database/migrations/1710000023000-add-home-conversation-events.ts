import type { MigrationInterface, QueryRunner } from 'typeorm';

import { HomeConversationEventRollbackBlockedError } from '@/modules/home-assistant/domain/home-conversation-errors';

/** Adds the transaction-ordered event cursor for persistent Home conversation history. */
export class AddHomeConversationEvents1710000023000 implements MigrationInterface {
  public readonly name = 'AddHomeConversationEvents1710000023000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "home_turn_status" ADD VALUE 'cancel_requested'`);
    await queryRunner.query(`ALTER TYPE "home_turn_status" ADD VALUE 'unsupported'`);
    await queryRunner.query(`
      ALTER TABLE "home_conversations"
      ADD COLUMN "last_event_sequence" integer NOT NULL DEFAULT 0,
      ADD CONSTRAINT "CHK_home_conversations_last_event_sequence" CHECK ("last_event_sequence" >= 0)
    `);
    await queryRunner.query(`
      CREATE TABLE "home_conversation_events" (
        "owner_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "sequence" integer NOT NULL,
        "event_type" text NOT NULL,
        "turn_id" uuid NULL,
        "entity_id" uuid NULL,
        "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_home_conversation_events" PRIMARY KEY ("owner_id", "conversation_id", "sequence"),
        CONSTRAINT "FK_home_conversation_events_conversation" FOREIGN KEY ("owner_id", "conversation_id")
          REFERENCES "home_conversations" ("owner_id", "id") ON DELETE CASCADE,
        CONSTRAINT "FK_home_conversation_events_turn" FOREIGN KEY ("owner_id", "conversation_id", "turn_id")
          REFERENCES "home_turns" ("owner_id", "conversation_id", "id") ON DELETE CASCADE,
        CONSTRAINT "CHK_home_conversation_events_sequence" CHECK ("sequence" > 0),
        CONSTRAINT "CHK_home_conversation_events_payload" CHECK (jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 4096),
        CONSTRAINT "CHK_home_conversation_events_shape" CHECK (
          ("event_type" = 'conversation.created' AND "turn_id" IS NULL AND "entity_id" IS NULL)
          OR ("event_type" IN ('turn.created', 'turn.status_changed') AND "turn_id" IS NOT NULL AND "entity_id" IS NULL)
          OR ("event_type" IN ('message.appended', 'action.receipt') AND "turn_id" IS NOT NULL AND "entity_id" IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`COMMENT ON TABLE "home_conversation_events" IS 'Append-only, per-conversation replay events. Payloads contain bounded metadata and never transcript or provider content.'`);
    await queryRunner.query(`COMMENT ON COLUMN "home_conversations"."last_event_sequence" IS 'Committed Home event high-water mark; allocated under the conversation row lock.'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { has_events: boolean; has_new_status: boolean; has_nonzero_cursor: boolean }[] = await queryRunner.query(`
      SELECT
        EXISTS (SELECT 1 FROM "home_conversation_events") AS "has_events",
        EXISTS (SELECT 1 FROM "home_turns" WHERE "status" IN ('cancel_requested', 'unsupported')) AS "has_new_status",
        EXISTS (SELECT 1 FROM "home_conversations" WHERE "last_event_sequence" <> 0) AS "has_nonzero_cursor"
    `);
    if (rows[0]?.has_events || rows[0]?.has_new_status || rows[0]?.has_nonzero_cursor) {
      throw new HomeConversationEventRollbackBlockedError();
    }

    await queryRunner.query('DROP TABLE "home_conversation_events"');
    await queryRunner.query(`ALTER TABLE "home_conversations"
      DROP CONSTRAINT "CHK_home_conversations_last_event_sequence",
      DROP COLUMN "last_event_sequence"`);
    await queryRunner.query('ALTER TYPE "home_turn_status" RENAME TO "home_turn_status_with_home_runtime"');
    await queryRunner.query(`CREATE TYPE "home_turn_status" AS ENUM ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled', 'unknown')`);
    await queryRunner.query(`ALTER TABLE "home_turns" ALTER COLUMN "status" TYPE "home_turn_status"
      USING "status"::text::"home_turn_status"`);
    await queryRunner.query('DROP TYPE "home_turn_status_with_home_runtime"');
  }
}
