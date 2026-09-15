import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateConversationsAndMessages1710000003000 implements MigrationInterface {
  public readonly name = 'CreateConversationsAndMessages1710000003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "conversation_status" AS ENUM ('active', 'archived')
    `);
    await queryRunner.query(`
      CREATE TYPE "message_role" AS ENUM ('user', 'assistant', 'system', 'tool')
    `);
    await queryRunner.query(`
      CREATE TABLE "conversations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "title" text NOT NULL,
        "status" "conversation_status" NOT NULL DEFAULT 'active',
        "last_activity_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversations_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_conversations_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_conversations_project_id" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "messages" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "conversation_id" uuid NOT NULL,
        "role" "message_role" NOT NULL,
        "sequence" integer NOT NULL,
        "content" text NOT NULL,
        "content_hash" text NOT NULL,
        "content_length" integer NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_messages_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_messages_conversation_id" FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_messages_conversation_sequence" UNIQUE ("conversation_id", "sequence"),
        CONSTRAINT "CHK_messages_sequence_positive" CHECK ("sequence" > 0),
        CONSTRAINT "CHK_messages_content_length_nonnegative" CHECK ("content_length" >= 0)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "conversation_idempotency_keys" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "conversation_id" uuid NULL,
        "operation" text NOT NULL,
        "idempotency_key" text NOT NULL,
        "request_fingerprint" text NOT NULL,
        "resource_id" uuid NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversation_idempotency_keys_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_conversation_idempotency_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_conversation_idempotency_project_id" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_conversation_idempotency_conversation_id" FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_conversation_idempotency_operation" CHECK ("operation" IN ('conversation', 'message'))
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_conversations_owner_project_activity" ON "conversations" ("owner_id", "project_id", "last_activity_at" DESC, "id" ASC)');
    await queryRunner.query('CREATE INDEX "IDX_messages_conversation_sequence" ON "messages" ("conversation_id", "sequence" DESC)');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_conversation_idempotency_scope" ON "conversation_idempotency_keys" ("owner_id", "project_id", "operation", "idempotency_key")');
    await queryRunner.query('CREATE INDEX "IDX_conversation_idempotency_resource" ON "conversation_idempotency_keys" ("conversation_id", "resource_id")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_conversation_idempotency_resource"');
    await queryRunner.query('DROP INDEX "UQ_conversation_idempotency_scope"');
    await queryRunner.query('DROP INDEX "IDX_messages_conversation_sequence"');
    await queryRunner.query('DROP INDEX "IDX_conversations_owner_project_activity"');
    await queryRunner.query('DROP TABLE "conversation_idempotency_keys"');
    await queryRunner.query('DROP TABLE "messages"');
    await queryRunner.query('DROP TABLE "conversations"');
    await queryRunner.query('DROP TYPE "message_role"');
    await queryRunner.query('DROP TYPE "conversation_status"');
  }
}
