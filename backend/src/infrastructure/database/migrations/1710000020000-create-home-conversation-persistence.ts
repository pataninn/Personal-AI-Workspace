import type { MigrationInterface, QueryRunner } from 'typeorm';

import { HomeConversationRollbackBlockedError } from '@/modules/home-assistant/domain/home-conversation-errors';

/** Creates owner-scoped Home conversation, turn, and transcript storage. */
export class CreateHomeConversationPersistence1710000020000 implements MigrationInterface {
  public readonly name = 'CreateHomeConversationPersistence1710000020000';

  /** Creates additive tables without changing project conversation storage. */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "home_conversation_scope" AS ENUM ('home', 'workspace')`);
    await queryRunner.query(`CREATE TYPE "home_turn_status" AS ENUM ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled', 'unknown')`);
    await queryRunner.query(`CREATE TYPE "home_message_role" AS ENUM ('user', 'assistant', 'system', 'tool')`);
    await queryRunner.query(`
      CREATE TABLE "home_conversations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "scope" "home_conversation_scope" NOT NULL,
        "workspace_id" uuid NULL,
        "title" text NOT NULL,
        "create_request_key" text NOT NULL,
        "create_request_fingerprint" text NOT NULL,
        "last_activity_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_home_conversations_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_home_conversations_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_home_conversations_owner_id" UNIQUE ("owner_id", "id"),
        CONSTRAINT "CHK_home_conversations_scope" CHECK (("scope" = 'home' AND "workspace_id" IS NULL) OR ("scope" = 'workspace' AND "workspace_id" IS NOT NULL))
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "home_turns" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "sequence" integer NOT NULL,
        "request_key" text NOT NULL,
        "request_fingerprint" text NOT NULL,
        "status" "home_turn_status" NOT NULL DEFAULT 'pending',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_home_turns_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_home_turns_owner_conversation" FOREIGN KEY ("owner_id", "conversation_id") REFERENCES "home_conversations" ("owner_id", "id") ON DELETE CASCADE,
        CONSTRAINT "UQ_home_turns_owner_conversation_id" UNIQUE ("owner_id", "conversation_id", "id"),
        CONSTRAINT "UQ_home_turns_owner_conversation_seq" UNIQUE ("owner_id", "conversation_id", "sequence"),
        CONSTRAINT "UQ_home_turns_request_scope" UNIQUE ("owner_id", "conversation_id", "request_key"),
        CONSTRAINT "CHK_home_turns_sequence_positive" CHECK ("sequence" > 0)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "home_messages" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "turn_id" uuid NOT NULL,
        "sequence" integer NOT NULL,
        "role" "home_message_role" NOT NULL,
        "content" text NOT NULL,
        "request_key" text NOT NULL,
        "request_fingerprint" text NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_home_messages_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_home_messages_turn_owner" FOREIGN KEY ("owner_id", "conversation_id", "turn_id") REFERENCES "home_turns" ("owner_id", "conversation_id", "id") ON DELETE CASCADE,
        CONSTRAINT "UQ_home_messages_owner_conversation_seq" UNIQUE ("owner_id", "conversation_id", "sequence"),
        CONSTRAINT "UQ_home_messages_turn_request" UNIQUE ("owner_id", "turn_id", "request_key"),
        CONSTRAINT "CHK_home_messages_sequence_positive" CHECK ("sequence" > 0)
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_home_conversations_home_request" ON "home_conversations" ("owner_id", "create_request_key") WHERE "scope" = \'home\'');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_home_conversations_workspace_request" ON "home_conversations" ("owner_id", "workspace_id", "create_request_key") WHERE "scope" = \'workspace\'');
    await queryRunner.query('CREATE INDEX "IDX_home_conversations_owner_scope_activity" ON "home_conversations" ("owner_id", "scope", "workspace_id", "last_activity_at" DESC, "id" ASC)');
    await queryRunner.query('COMMENT ON COLUMN "home_conversations"."workspace_id" IS \'Historical workspace association; intentionally no project foreign key so deleting a workspace does not erase Home history.\'');
  }

  /** Refuses rollback while any persisted Home history could be lost. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { has_records: boolean }[] = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM "home_conversations"
        UNION ALL SELECT 1 FROM "home_turns"
        UNION ALL SELECT 1 FROM "home_messages"
      ) AS "has_records"
    `);
    if (rows[0]?.has_records) {
      throw new HomeConversationRollbackBlockedError();
    }
    await queryRunner.query('DROP INDEX "IDX_home_conversations_owner_scope_activity"');
    await queryRunner.query('DROP INDEX "UQ_home_conversations_workspace_request"');
    await queryRunner.query('DROP INDEX "UQ_home_conversations_home_request"');
    await queryRunner.query('DROP TABLE "home_messages"');
    await queryRunner.query('DROP TABLE "home_turns"');
    await queryRunner.query('DROP TABLE "home_conversations"');
    await queryRunner.query('DROP TYPE "home_message_role"');
    await queryRunner.query('DROP TYPE "home_turn_status"');
    await queryRunner.query('DROP TYPE "home_conversation_scope"');
  }
}
