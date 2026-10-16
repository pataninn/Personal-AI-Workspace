import type { QueryRunner } from 'typeorm';

import type { ActionLedgerRecord } from '@/modules/action-ledger/domain/action-ledger-types';
import type { IActionLedgerEventRecorder } from '@/modules/action-ledger/repositories/action-ledger-event-recorder';
import { HomeTurnNotActiveError, HomeTurnNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import { appendHomeConversationEvent } from '@/infrastructure/database/repositories/home-conversation-event-persistence';
import { lockConversation } from '@/infrastructure/database/repositories/home-conversation-repository-helpers';

interface HomeTurnConversationRow {
  readonly conversation_id: string;
}

interface HomeTurnStatusRow {
  readonly status: string;
}

/** Appends only safe action receipt metadata using the ledger's active transaction. */
export class TypeOrmHomeActionEventRecorder implements IActionLedgerEventRecorder<QueryRunner> {
  public async recordAction(transaction: QueryRunner, record: ActionLedgerRecord): Promise<void> {
    if (record.turnId === null) return;

    const turnRows: readonly HomeTurnConversationRow[] = await transaction.query(
      `SELECT "conversation_id" FROM "home_turns"
       WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1`,
      [record.ownerId, record.turnId]
    );
    const conversationId = turnRows[0]?.conversation_id;
    if (!conversationId) throw new HomeTurnNotFoundError();

    const conversation = await lockConversation(transaction, record.ownerId, conversationId);
    if (!conversation) throw new HomeTurnNotFoundError();

    const statusRows: readonly HomeTurnStatusRow[] = await transaction.query(
      `SELECT "status" FROM "home_turns"
       WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3
       LIMIT 1 FOR UPDATE`,
      [record.ownerId, conversationId, record.turnId]
    );
    if (statusRows[0]?.status !== 'running') throw new HomeTurnNotActiveError();

    await appendHomeConversationEvent(transaction, {
      ownerId: record.ownerId,
      conversationId,
      type: 'action.receipt',
      turnId: record.turnId,
      entityId: record.id,
      payload: {
        actionKind: record.actionKind,
        targetKind: record.targetKind,
        targetId: record.targetId
      }
    });
  }
}
