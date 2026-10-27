import type { QueryRunner } from 'typeorm';

import { HomeConversationNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type {
  HomeConversationEventPayload,
  HomeConversationEventType
} from '@/modules/home-assistant/domain/home-conversation-types';

export interface AppendHomeConversationEventInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly type: HomeConversationEventType;
  readonly turnId: string | null;
  readonly entityId: string | null;
  readonly payload: HomeConversationEventPayload;
}

interface SequenceRow {
  readonly last_event_sequence: number | string;
}

/** Allocates a committed per-conversation cursor and appends its event in the caller's transaction. */
export async function appendHomeConversationEvent(
  queryRunner: QueryRunner,
  input: AppendHomeConversationEventInput
): Promise<number> {
  const updateResult: unknown = await queryRunner.query(
    `UPDATE "home_conversations"
     SET "last_event_sequence" = "last_event_sequence" + 1, "last_activity_at" = now(), "updated_at" = now()
     WHERE "owner_id" = $1 AND "id" = $2
     RETURNING "last_event_sequence"`,
    [input.ownerId, input.conversationId]
  );
  // TypeORM returns UPDATE results as [rows, affected], while test adapters may return rows directly.
  const rows: readonly SequenceRow[] = Array.isArray(updateResult) && Array.isArray(updateResult[0])
    ? updateResult[0] as readonly SequenceRow[]
    : Array.isArray(updateResult) ? updateResult as readonly SequenceRow[] : [];
  const sequence = rows[0] ? Number(rows[0].last_event_sequence) : NaN;
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new HomeConversationNotFoundError();
  }

  await queryRunner.query(
    `INSERT INTO "home_conversation_events" (
       "owner_id", "conversation_id", "sequence", "event_type", "turn_id", "entity_id", "payload"
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [input.ownerId, input.conversationId, sequence, input.type, input.turnId, input.entityId, JSON.stringify(input.payload)]
  );
  return sequence;
}
