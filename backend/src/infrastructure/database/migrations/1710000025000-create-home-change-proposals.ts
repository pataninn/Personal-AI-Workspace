import type { MigrationInterface, QueryRunner } from 'typeorm';

import { HomeProposalRollbackBlockedError } from '@/modules/home-assistant/domain/home-planning-errors';

/** Adds durable, editable Home change proposals and safe replay events. */
export class CreateHomeChangeProposals1710000025000 implements MigrationInterface {
  public readonly name = 'CreateHomeChangeProposals1710000025000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "home_conversation_events" DROP CONSTRAINT "CHK_home_conversation_events_shape"');
    await queryRunner.query(`
      ALTER TABLE "home_conversation_events" ADD CONSTRAINT "CHK_home_conversation_events_shape" CHECK (
        ("event_type" = 'conversation.created' AND "turn_id" IS NULL AND "entity_id" IS NULL)
        OR ("event_type" IN ('turn.created', 'turn.status_changed') AND "turn_id" IS NOT NULL AND "entity_id" IS NULL)
        OR ("event_type" IN ('message.appended', 'action.receipt', 'consent.requested', 'consent.decided',
          'proposal.created', 'proposal.updated', 'proposal.accepted', 'proposal.cancelled', 'proposal.item_status_changed')
          AND "turn_id" IS NOT NULL AND "entity_id" IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "home_conversation_events" ADD CONSTRAINT "CHK_home_conversation_events_proposal_payload" CHECK (
        "event_type" NOT LIKE 'proposal.%' OR CASE "event_type"
          WHEN 'proposal.created' THEN
            "payload" ?& ARRAY['state', 'revision', 'itemCount']
            AND "payload" - ARRAY['state', 'revision', 'itemCount'] = '{}'::jsonb
            AND "payload"->>'state' = 'review_required'
            AND ("payload"->>'revision') ~ '^[1-9][0-9]{0,8}$'
            AND ("payload"->>'itemCount') ~ '^[1-9][0-9]{0,2}$'
          WHEN 'proposal.updated' THEN
            "payload" ?& ARRAY['state', 'revision', 'itemCount']
            AND "payload" - ARRAY['state', 'revision', 'itemCount'] = '{}'::jsonb
            AND ("payload"->>'state') IN ('review_required', 'accepted', 'executing', 'partial', 'completed', 'cancelled', 'unknown')
            AND ("payload"->>'revision') ~ '^[1-9][0-9]{0,8}$'
            AND ("payload"->>'itemCount') ~ '^(0|[1-9][0-9]{0,2})$'
          WHEN 'proposal.accepted' THEN
            "payload" ?& ARRAY['acceptanceId', 'revision', 'itemCount']
            AND "payload" - ARRAY['acceptanceId', 'revision', 'itemCount'] = '{}'::jsonb
            AND ("payload"->>'acceptanceId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            AND ("payload"->>'revision') ~ '^[1-9][0-9]{0,8}$'
            AND ("payload"->>'itemCount') ~ '^[1-9][0-9]{0,2}$'
          WHEN 'proposal.cancelled' THEN
            "payload" ? 'state' AND "payload" - ARRAY['state'] = '{}'::jsonb AND "payload"->>'state' = 'cancelled'
          WHEN 'proposal.item_status_changed' THEN
            "payload" ?& ARRAY['itemId', 'actionKind', 'targetKind', 'itemState']
            AND "payload" - ARRAY['itemId', 'actionKind', 'targetKind', 'itemState', 'targetId', 'receiptId', 'resultCode'] = '{}'::jsonb
            AND ("payload"->>'itemId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            AND ("payload"->>'actionKind') IN ('task.create', 'task.update', 'task.move', 'task.archive', 'workspace.create', 'workspace.update_objective')
            AND ("payload"->>'targetKind') IN ('task', 'workspace')
            AND ("payload"->>'itemState') IN ('ready', 'executing', 'saved', 'failed', 'conflicted', 'blocked', 'cancelled', 'unknown')
            AND (NOT ("payload" ? 'targetId') OR ("payload"->>'targetId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
            AND (NOT ("payload" ? 'receiptId') OR ("payload"->>'receiptId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
            AND (NOT ("payload" ? 'resultCode') OR length("payload"->>'resultCode') BETWEEN 1 AND 80)
          ELSE false
        END
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "home_change_proposals" (
        "id" uuid NOT NULL,
        "owner_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "source_turn_id" uuid NOT NULL,
        "scope_kind" "home_conversation_scope" NOT NULL,
        "scope_id" uuid NULL,
        "runtime_request_id" text NOT NULL,
        "request_fingerprint" text NOT NULL,
        "state" text NOT NULL DEFAULT 'review_required',
        "revision" integer NOT NULL DEFAULT 1,
        "accepted_revision" integer NULL,
        "acceptance_id" uuid NULL,
        "item_count" integer NOT NULL,
        "command_bytes" integer NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_home_change_proposals" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_home_change_proposals_owner_conversation_id" UNIQUE ("owner_id", "conversation_id", "id"),
        CONSTRAINT "UQ_home_change_proposals_owner_id" UNIQUE ("owner_id", "id"),
        CONSTRAINT "UQ_home_change_proposals_request" UNIQUE ("owner_id", "source_turn_id", "runtime_request_id"),
        CONSTRAINT "FK_home_change_proposals_conversation" FOREIGN KEY ("owner_id", "conversation_id")
          REFERENCES "home_conversations" ("owner_id", "id") ON DELETE CASCADE,
        CONSTRAINT "FK_home_change_proposals_turn" FOREIGN KEY ("owner_id", "conversation_id", "source_turn_id")
          REFERENCES "home_turns" ("owner_id", "conversation_id", "id") ON DELETE CASCADE,
        CONSTRAINT "CHK_home_change_proposals_scope" CHECK (("scope_kind" = 'home' AND "scope_id" IS NULL) OR ("scope_kind" = 'workspace' AND "scope_id" IS NOT NULL)),
        CONSTRAINT "CHK_home_change_proposals_request_id" CHECK ("runtime_request_id" ~ '^[A-Za-z0-9_-]{1,128}$'),
        CONSTRAINT "CHK_home_change_proposals_fingerprint" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "CHK_home_change_proposals_state" CHECK ("state" IN ('review_required', 'accepted', 'executing', 'partial', 'completed', 'cancelled', 'unknown')),
        CONSTRAINT "CHK_home_change_proposals_revision" CHECK ("revision" > 0 AND ("accepted_revision" IS NULL OR "accepted_revision" = "revision")),
        CONSTRAINT "CHK_home_change_proposals_acceptance" CHECK (("state" = 'review_required' AND "acceptance_id" IS NULL AND "accepted_revision" IS NULL) OR ("state" <> 'review_required' AND "state" <> 'cancelled' AND "acceptance_id" IS NOT NULL AND "accepted_revision" IS NOT NULL) OR ("state" = 'cancelled' AND (("acceptance_id" IS NULL AND "accepted_revision" IS NULL) OR ("acceptance_id" IS NOT NULL AND "accepted_revision" IS NOT NULL)))),
        CONSTRAINT "CHK_home_change_proposals_bounds" CHECK ("item_count" BETWEEN 0 AND 20 AND "command_bytes" BETWEEN 1 AND 131072)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "home_change_proposal_items" (
        "id" uuid NOT NULL,
        "owner_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "proposal_id" uuid NOT NULL,
        "position" integer NOT NULL,
        "action_kind" text NOT NULL,
        "target_kind" "action_ledger_target_kind" NOT NULL,
        "target_id" uuid NOT NULL,
        "expected_version" integer NULL,
        "state" text NOT NULL DEFAULT 'ready',
        "operation_key" text NULL,
        "request_fingerprint" text NULL,
        "receipt_id" uuid NULL,
        "result_code" text NULL,
        "command" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_home_change_proposal_items" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_home_change_proposal_items_position" UNIQUE ("owner_id", "conversation_id", "proposal_id", "position"),
        CONSTRAINT "UQ_home_change_proposal_items_owner_id" UNIQUE ("owner_id", "id"),
        CONSTRAINT "FK_home_change_proposal_items_proposal" FOREIGN KEY ("owner_id", "conversation_id", "proposal_id")
          REFERENCES "home_change_proposals" ("owner_id", "conversation_id", "id") ON DELETE CASCADE,
        CONSTRAINT "FK_home_change_proposal_items_receipt" FOREIGN KEY ("owner_id", "receipt_id")
          REFERENCES "action_ledger_records" ("owner_id", "id") ON DELETE NO ACTION,
        CONSTRAINT "CHK_home_change_proposal_items_position" CHECK ("position" BETWEEN 0 AND 19),
        CONSTRAINT "CHK_home_change_proposal_items_action" CHECK ("action_kind" IN ('task.create', 'task.update', 'task.move', 'task.archive', 'workspace.create', 'workspace.update_objective')),
        CONSTRAINT "CHK_home_change_proposal_items_state" CHECK ("state" IN ('ready', 'executing', 'saved', 'failed', 'conflicted', 'blocked', 'cancelled', 'unknown')),
        CONSTRAINT "CHK_home_change_proposal_items_command" CHECK (jsonb_typeof("command") = 'object' AND octet_length("command"::text) BETWEEN 2 AND 131072),
        CONSTRAINT "CHK_home_change_proposal_items_operation" CHECK (("operation_key" IS NULL AND "request_fingerprint" IS NULL) OR ("operation_key" IS NOT NULL AND length("operation_key") BETWEEN 1 AND 200 AND "request_fingerprint" IS NOT NULL AND "request_fingerprint" ~ '^[0-9a-f]{64}$')),
        CONSTRAINT "CHK_home_change_proposal_items_result_code" CHECK ("result_code" IS NULL OR length("result_code") BETWEEN 1 AND 80)
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_home_change_proposals_conversation" ON "home_change_proposals" ("owner_id", "conversation_id", "created_at" DESC, "id" DESC)');
    await queryRunner.query('CREATE INDEX "IDX_home_change_proposals_turn" ON "home_change_proposals" ("owner_id", "conversation_id", "source_turn_id")');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_home_change_proposal_item_operation" ON "home_change_proposal_items" ("owner_id", "operation_key") WHERE "operation_key" IS NOT NULL');
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_home_change_proposal_existing_target" ON "home_change_proposal_items" ("owner_id", "proposal_id", "target_kind", "target_id") WHERE "action_kind" NOT IN ('task.create', 'workspace.create')`);
    await queryRunner.query('CREATE INDEX "IDX_home_change_proposal_items_target" ON "home_change_proposal_items" ("owner_id", "proposal_id", "target_kind", "target_id")');
    await queryRunner.query(`COMMENT ON TABLE "home_change_proposals" IS 'Owner-scoped Home proposals; draft commands are reviewed in Home and accepted execution is never auto-resumed.'`);
    await queryRunner.query(`COMMENT ON COLUMN "home_change_proposal_items"."command" IS 'Bounded canonical Home command payload; event payloads contain metadata only.'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { has_proposals: boolean; has_events: boolean }[] = await queryRunner.query(`
      SELECT EXISTS (SELECT 1 FROM "home_change_proposals") AS "has_proposals",
             EXISTS (SELECT 1 FROM "home_conversation_events" WHERE "event_type" LIKE 'proposal.%') AS "has_events"
    `);
    if (rows[0]?.has_proposals || rows[0]?.has_events) throw new HomeProposalRollbackBlockedError();
    await queryRunner.query('DROP INDEX "IDX_home_change_proposal_items_target"');
    await queryRunner.query('DROP INDEX "UQ_home_change_proposal_existing_target"');
    await queryRunner.query('DROP INDEX "UQ_home_change_proposal_item_operation"');
    await queryRunner.query('DROP INDEX "IDX_home_change_proposals_turn"');
    await queryRunner.query('DROP INDEX "IDX_home_change_proposals_conversation"');
    await queryRunner.query('DROP TABLE "home_change_proposal_items"');
    await queryRunner.query('DROP TABLE "home_change_proposals"');
    await queryRunner.query('ALTER TABLE "home_conversation_events" DROP CONSTRAINT "CHK_home_conversation_events_proposal_payload"');
    await queryRunner.query('ALTER TABLE "home_conversation_events" DROP CONSTRAINT "CHK_home_conversation_events_shape"');
    await queryRunner.query(`
      ALTER TABLE "home_conversation_events" ADD CONSTRAINT "CHK_home_conversation_events_shape" CHECK (
        ("event_type" = 'conversation.created' AND "turn_id" IS NULL AND "entity_id" IS NULL)
        OR ("event_type" IN ('turn.created', 'turn.status_changed') AND "turn_id" IS NOT NULL AND "entity_id" IS NULL)
        OR ("event_type" IN ('message.appended', 'action.receipt') AND "turn_id" IS NOT NULL AND "entity_id" IS NOT NULL)
        OR ("event_type" IN ('consent.requested', 'consent.decided') AND "turn_id" IS NOT NULL AND "entity_id" IS NOT NULL)
      )
    `);
  }
}
