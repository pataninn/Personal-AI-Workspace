import type { MigrationInterface, QueryRunner } from 'typeorm';

import { HomeConsentRollbackBlockedError } from '@/modules/home-assistant/domain/home-conversation-errors';

/** Adds bounded Home consent disclosure state and replay event kinds. */
export class AddHomeConsentDisclosures1710000024000 implements MigrationInterface {
  public readonly name = 'AddHomeConsentDisclosures1710000024000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "home_conversation_events" DROP CONSTRAINT "CHK_home_conversation_events_shape"');
    await queryRunner.query(`
      ALTER TABLE "home_conversation_events" ADD CONSTRAINT "CHK_home_conversation_events_shape" CHECK (
        ("event_type" = 'conversation.created' AND "turn_id" IS NULL AND "entity_id" IS NULL)
        OR ("event_type" IN ('turn.created', 'turn.status_changed') AND "turn_id" IS NOT NULL AND "entity_id" IS NULL)
        OR ("event_type" IN ('message.appended', 'action.receipt') AND "turn_id" IS NOT NULL AND "entity_id" IS NOT NULL)
        OR ("event_type" IN ('consent.requested', 'consent.decided') AND "turn_id" IS NOT NULL AND "entity_id" IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "home_conversation_events" ADD CONSTRAINT "CHK_home_conversation_events_consent_payload" CHECK (
        "event_type" NOT IN ('consent.requested', 'consent.decided') OR (
          "payload" ?& ARRAY['phase', 'categories', 'providerProfile', 'model', 'scopeKind', 'scopeId', 'itemCount', 'byteLimit']
          AND
          "payload"->>'phase' IN ('initial', 'tool_result')
          AND length("payload"->>'providerProfile') BETWEEN 1 AND 80
          AND length("payload"->>'model') BETWEEN 1 AND 160
          AND "payload"->>'scopeKind' IN ('home', 'workspace')
          AND CASE WHEN "payload"->>'scopeKind' = 'home' THEN "payload"->'scopeId' = 'null'::jsonb
                   WHEN "payload"->>'scopeKind' = 'workspace' THEN jsonb_typeof("payload"->'scopeId') = 'string'
                   ELSE false END
          AND ("payload"->>'itemCount') ~ '^[1-9][0-9]{0,5}$'
          AND ("payload"->>'byteLimit') ~ '^[1-9][0-9]{0,6}$'
          AND ("payload"->>'byteLimit')::integer <= 262144
          AND CASE WHEN jsonb_typeof("payload"->'categories') = 'array' THEN
            jsonb_array_length("payload"->'categories') BETWEEN 1 AND 4
            AND "payload"->'categories' <@ '["current_message", "bounded_home_history", "task_metadata", "workspace_metadata"]'::jsonb
          ELSE false END
          AND CASE WHEN "event_type" = 'consent.decided' THEN "payload" ? 'decision' AND "payload"->>'decision' IN ('allow', 'deny') ELSE NOT ("payload" ? 'decision') END
          AND CASE WHEN "event_type" = 'consent.decided'
            THEN "payload" - ARRAY['phase', 'categories', 'providerProfile', 'model', 'scopeKind', 'scopeId', 'itemCount', 'byteLimit', 'decision'] = '{}'::jsonb
            ELSE "payload" - ARRAY['phase', 'categories', 'providerProfile', 'model', 'scopeKind', 'scopeId', 'itemCount', 'byteLimit'] = '{}'::jsonb END
        )
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "home_turn_consent_disclosures" (
        "disclosure_id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "turn_id" uuid NOT NULL,
        "phase" text NOT NULL,
        "provider_profile" text NOT NULL,
        "provider_name" text NOT NULL,
        "model" text NOT NULL,
        "scope_kind" text NOT NULL,
        "scope_id" uuid NULL,
        "categories" jsonb NOT NULL,
        "item_count" integer NOT NULL,
        "byte_limit" integer NOT NULL,
        "runtime_request_id" text NULL,
        "result_fingerprint" text NULL,
        "decision" text NULL,
        "delivery_state" text NOT NULL DEFAULT 'awaiting_decision',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_home_turn_consent_disclosures" PRIMARY KEY ("disclosure_id"),
        CONSTRAINT "FK_home_turn_consent_owner_turn" FOREIGN KEY ("owner_id", "conversation_id", "turn_id")
          REFERENCES "home_turns" ("owner_id", "conversation_id", "id") ON DELETE CASCADE,
        CONSTRAINT "CHK_home_consent_phase" CHECK ("phase" IN ('initial', 'tool_result')),
        CONSTRAINT "CHK_home_consent_provider" CHECK (length("provider_profile") BETWEEN 1 AND 80 AND length("provider_name") BETWEEN 1 AND 120 AND length("model") BETWEEN 1 AND 160),
        CONSTRAINT "CHK_home_consent_scope" CHECK (("scope_kind" = 'home' AND "scope_id" IS NULL) OR ("scope_kind" = 'workspace' AND "scope_id" IS NOT NULL)),
        CONSTRAINT "CHK_home_consent_categories" CHECK (
          CASE WHEN jsonb_typeof("categories") = 'array' THEN
            jsonb_array_length("categories") BETWEEN 1 AND 4
            AND "categories" <@ '["current_message", "bounded_home_history", "task_metadata", "workspace_metadata"]'::jsonb
          ELSE false END
        ),
        CONSTRAINT "CHK_home_consent_count_bytes" CHECK ("item_count" BETWEEN 1 AND 100000 AND "byte_limit" BETWEEN 1 AND 262144),
        CONSTRAINT "CHK_home_consent_decision" CHECK ("decision" IS NULL OR "decision" IN ('allow', 'deny')),
        CONSTRAINT "CHK_home_consent_delivery_state" CHECK ("delivery_state" IN ('awaiting_decision', 'starting', 'accepted', 'unavailable', 'unknown', 'not_required')),
        CONSTRAINT "CHK_home_consent_decision_state" CHECK (
          ("decision" IS NULL AND "delivery_state" = 'awaiting_decision')
          OR ("decision" = 'allow' AND "delivery_state" IN ('starting', 'accepted', 'unavailable', 'unknown'))
          OR ("decision" = 'deny' AND (("phase" = 'initial' AND "delivery_state" = 'not_required') OR ("phase" = 'tool_result' AND "delivery_state" IN ('not_required', 'accepted', 'unknown'))))
        ),
        CONSTRAINT "CHK_home_consent_runtime_request" CHECK (
          ("phase" = 'initial' AND "runtime_request_id" IS NULL AND "result_fingerprint" IS NULL)
          OR ("phase" = 'tool_result' AND "runtime_request_id" IS NOT NULL AND "runtime_request_id" ~ '^[A-Za-z0-9_-]{1,128}$'
            AND "result_fingerprint" IS NOT NULL AND "result_fingerprint" ~ '^[0-9a-f]{64}$')
        )
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_home_consent_initial_turn" ON "home_turn_consent_disclosures" ("owner_id", "conversation_id", "turn_id") WHERE "phase" = 'initial'`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_home_consent_runtime_request" ON "home_turn_consent_disclosures" ("turn_id", "runtime_request_id") WHERE "runtime_request_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_home_consent_turn_phase" ON "home_turn_consent_disclosures" ("owner_id", "conversation_id", "turn_id", "phase", "created_at")`);
    await queryRunner.query(`COMMENT ON TABLE "home_turn_consent_disclosures" IS 'One-turn consent metadata only; prompts, tool arguments, provider output, and result contents are never stored here.'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { has_disclosures: boolean; has_consent_events: boolean }[] = await queryRunner.query(`
      SELECT EXISTS (SELECT 1 FROM "home_turn_consent_disclosures") AS "has_disclosures",
             EXISTS (SELECT 1 FROM "home_conversation_events" WHERE "event_type" IN ('consent.requested', 'consent.decided')) AS "has_consent_events"
    `);
    if (rows[0]?.has_disclosures || rows[0]?.has_consent_events) throw new HomeConsentRollbackBlockedError();
    await queryRunner.query('DROP INDEX "IDX_home_consent_turn_phase"');
    await queryRunner.query('DROP INDEX "UQ_home_consent_runtime_request"');
    await queryRunner.query('DROP INDEX "UQ_home_consent_initial_turn"');
    await queryRunner.query('DROP TABLE "home_turn_consent_disclosures"');
    await queryRunner.query('ALTER TABLE "home_conversation_events" DROP CONSTRAINT "CHK_home_conversation_events_consent_payload"');
    await queryRunner.query('ALTER TABLE "home_conversation_events" DROP CONSTRAINT "CHK_home_conversation_events_shape"');
    await queryRunner.query(`
      ALTER TABLE "home_conversation_events" ADD CONSTRAINT "CHK_home_conversation_events_shape" CHECK (
        ("event_type" = 'conversation.created' AND "turn_id" IS NULL AND "entity_id" IS NULL)
        OR ("event_type" IN ('turn.created', 'turn.status_changed') AND "turn_id" IS NOT NULL AND "entity_id" IS NULL)
        OR ("event_type" IN ('message.appended', 'action.receipt') AND "turn_id" IS NOT NULL AND "entity_id" IS NOT NULL)
      )
    `);
  }
}
