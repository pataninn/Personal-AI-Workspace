import type { QueryRunner } from 'typeorm';

import type { ActionLedgerRecord } from '@/modules/action-ledger/domain/action-ledger-types';
import type { IActionLedgerEventRecorder } from '@/modules/action-ledger/repositories/action-ledger-event-recorder';
import { HomeTurnNotActiveError, HomeTurnNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import { HomeProposalCancelledError } from '@/modules/home-assistant/domain/home-planning-errors';
import type { HomeProposalLedgerEventContext } from '@/modules/home-assistant/domain/home-change-proposal-types';
import { appendHomeConversationEvent } from '@/infrastructure/database/repositories/home-conversation-event-persistence';
import { lockConversation } from '@/infrastructure/database/repositories/home-conversation-repository-helpers';

interface HomeTurnConversationRow {
  readonly conversation_id: string;
}

interface HomeTurnStatusRow {
  readonly status: string;
}

interface ProposalItemAuthorizationRow {
  readonly proposal_state: string;
  readonly item_state: string;
  readonly action_kind: string;
  readonly target_kind: 'task' | 'workspace';
  readonly target_id: string;
  readonly expected_version: number | null;
  readonly operation_key: string | null;
  readonly request_fingerprint: string | null;
  readonly receipt_id: string | null;
}

/** Appends only safe action receipt metadata using the ledger's active transaction. */
export class TypeOrmHomeActionEventRecorder implements IActionLedgerEventRecorder<QueryRunner> {
  public async recordAction(transaction: QueryRunner, record: ActionLedgerRecord, context?: unknown): Promise<void> {
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
    const status = statusRows[0]?.status;
    if (!status) throw new HomeTurnNotFoundError();
    if (context === undefined) {
      if (status !== 'running') throw new HomeTurnNotActiveError();
    } else {
      await assertAcceptedProposalItem(transaction, record, conversationId, context, status);
    }

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

    if (context !== undefined) await markProposalItemSaved(transaction, record, conversationId, context);
  }
}

async function assertAcceptedProposalItem(transaction: QueryRunner, record: ActionLedgerRecord, conversationId: string, context: unknown, turnStatus: string): Promise<void> {
  if (!isHomeProposalLedgerEventContext(context) || !['running', 'completed', 'unknown'].includes(turnStatus)) {
    if (turnStatus === 'cancel_requested' || turnStatus === 'cancelled') throw new HomeProposalCancelledError();
    throw new HomeTurnNotActiveError();
  }
  const rows: readonly ProposalItemAuthorizationRow[] = await transaction.query(
    `SELECT p."state" AS "proposal_state", i."state" AS "item_state", i."action_kind", i."target_kind", i."target_id", i."expected_version", i."operation_key", i."request_fingerprint", i."receipt_id"
     FROM "home_change_proposals" p
     JOIN "home_change_proposal_items" i ON i."owner_id" = p."owner_id" AND i."conversation_id" = p."conversation_id" AND i."proposal_id" = p."id"
     WHERE p."owner_id" = $1 AND p."conversation_id" = $2 AND p."source_turn_id" = $3 AND p."id" = $4 AND i."id" = $5
     LIMIT 1 FOR UPDATE OF p, i`,
    [record.ownerId, conversationId, record.turnId, context.proposalId, context.itemId]
  );
  const item = rows[0];
  if (item?.proposal_state === 'cancelled') throw new HomeProposalCancelledError();
  if (!item || !['accepted', 'executing', 'partial'].includes(item.proposal_state) || item.item_state !== 'executing'
    || item.operation_key !== record.operationKey || item.request_fingerprint !== record.requestFingerprint
    || item.target_kind !== record.targetKind || item.target_id !== record.targetId
    || item.expected_version !== record.expectedVersion || item.receipt_id !== null) {
    throw new HomeTurnNotActiveError();
  }
}

async function markProposalItemSaved(transaction: QueryRunner, record: ActionLedgerRecord, conversationId: string, context: unknown): Promise<void> {
  if (!isHomeProposalLedgerEventContext(context)) throw new HomeTurnNotActiveError();
  const rows: readonly { readonly id: string }[] = await transaction.query(
    `UPDATE "home_change_proposal_items" SET "state" = 'saved', "receipt_id" = $6, "result_code" = NULL, "updated_at" = now()
     WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "proposal_id" = $3 AND "id" = $4
       AND "state" = 'executing' AND "operation_key" = $5 AND "receipt_id" IS NULL
     RETURNING "id"`,
    [record.ownerId, conversationId, context.proposalId, context.itemId, record.operationKey, record.id]
  );
  if (!rows[0]) throw new HomeTurnNotActiveError();
  await appendHomeConversationEvent(transaction, {
    ownerId: record.ownerId,
    conversationId,
    type: 'proposal.item_status_changed',
    turnId: record.turnId,
    entityId: context.proposalId,
    payload: {
      itemId: context.itemId,
      actionKind: record.actionKind,
      targetKind: record.targetKind,
      targetId: record.targetId,
      itemState: 'saved',
      receiptId: record.id
    }
  });
}

function isHomeProposalLedgerEventContext(value: unknown): value is HomeProposalLedgerEventContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return Object.keys(context).length === 3 && context.kind === 'home_proposal_item'
    && typeof context.proposalId === 'string' && /^[0-9a-f-]{36}$/iu.test(context.proposalId)
    && typeof context.itemId === 'string' && /^[0-9a-f-]{36}$/iu.test(context.itemId);
}
