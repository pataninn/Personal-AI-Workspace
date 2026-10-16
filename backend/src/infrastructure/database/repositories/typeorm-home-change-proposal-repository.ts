import type { DataSource, QueryRunner } from 'typeorm';

import { HomeProposalCancelledError, HomeProposalDependencyConflictError, HomeProposalNotAcceptableError, HomeProposalNotEditableError, HomeProposalNotFoundError, HomeProposalRequestKeyReusedError, HomeProposalRevisionConflictError } from '@/modules/home-assistant/domain/home-planning-errors';
import { HomeTurnNotActiveError, HomeTurnNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type { HomeChangeProposal, HomeChangeProposalItem, HomeProposalAction, HomeProposalCommand, HomeProposalDeadlineResolution, HomeProposalItemState, HomeProposalState } from '@/modules/home-assistant/domain/home-change-proposal-types';
import type { HomeConversationScope } from '@/modules/home-assistant/domain/home-conversation-types';
import { appendHomeConversationEvent } from '@/infrastructure/database/repositories/home-conversation-event-persistence';
import { lockConversation } from '@/infrastructure/database/repositories/home-conversation-repository-helpers';
import { stableJson } from '@/modules/home-assistant/use-cases/home-planning-command-validation';
import type { CreateHomeProposalInput, HomeProposalListPage, IHomeChangeProposalRepository, ListHomeProposalsInput, SealHomeProposalInput, UpdateHomeProposalItemInput } from '@/modules/home-assistant/repositories/home-change-proposal-repository';

type Timestamp = Date | string;

interface ProposalRow {
  readonly id: string;
  readonly owner_id: string;
  readonly conversation_id: string;
  readonly source_turn_id: string;
  readonly scope_kind: 'home' | 'workspace';
  readonly scope_id: string | null;
  readonly state: HomeProposalState;
  readonly revision: number | string;
  readonly accepted_revision: number | string | null;
  readonly acceptance_id: string | null;
  readonly item_count: number | string;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly cursor_created_at?: string;
}

interface ProposalItemRow {
  readonly id: string;
  readonly position: number | string;
  readonly action_kind: HomeProposalAction;
  readonly target_kind: 'task' | 'workspace';
  readonly target_id: string;
  readonly expected_version: number | string | null;
  readonly state: HomeProposalItemState;
  readonly operation_key: string | null;
  readonly request_fingerprint: string | null;
  readonly receipt_id: string | null;
  readonly result_code: string | null;
  readonly command: HomeProposalCommand | string;
}

const PROPOSAL_SELECT = `"id", "owner_id", "conversation_id", "source_turn_id", "scope_kind", "scope_id", "state", "revision", "accepted_revision", "acceptance_id", "item_count", "created_at", "updated_at"`;
const ITEM_SELECT = `"id", "position", "action_kind", "target_kind", "target_id", "expected_version", "state", "operation_key", "request_fingerprint", "receipt_id", "result_code", "command"`;

function proposalScope(kind: 'home' | 'workspace', id: string | null): HomeConversationScope {
  if (kind === 'home' && id === null) return { kind: 'home' };
  if (kind === 'workspace' && id !== null) return { kind: 'workspace', workspaceId: id };
  throw new Error('The persisted Home proposal scope is invalid.');
}

function command(value: HomeProposalCommand | string): HomeProposalCommand {
  const result = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('The persisted proposal command is invalid.');
  return result as HomeProposalCommand;
}

function storedCommand(value: HomeProposalCommand | string): { readonly command: HomeProposalCommand; readonly deadlineResolution: HomeProposalDeadlineResolution | null } {
  const result = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('The persisted proposal command is invalid.');
  if (!('command' in result)) return { command: command(result as HomeProposalCommand), deadlineResolution: null };
  const envelope = result as { readonly command: unknown; readonly deadlineResolution?: unknown };
  const deadlineResolution = envelope.deadlineResolution;
  if (deadlineResolution === undefined || deadlineResolution === null) return { command: command(envelope.command as HomeProposalCommand), deadlineResolution: null };
  if (typeof deadlineResolution !== 'object' || Array.isArray(deadlineResolution)) throw new Error('The persisted proposal deadline resolution is invalid.');
  const resolution = deadlineResolution as Record<string, unknown>;
  if (typeof resolution.timeZone !== 'string' || resolution.timeZone.length === 0 || resolution.timeZone.length > 255
    || (resolution.source !== 'configured' && resolution.source !== 'utc-fallback')
    || (resolution.source === 'utc-fallback' && resolution.timeZone !== 'UTC')) {
    throw new Error('The persisted proposal deadline resolution is invalid.');
  }
  return {
    command: command(envelope.command as HomeProposalCommand),
    deadlineResolution: { timeZone: resolution.timeZone, source: resolution.source }
  };
}

function storedCommandJson(commandValue: HomeProposalCommand, deadlineResolution: HomeProposalDeadlineResolution | null): string {
  return JSON.stringify({ command: commandValue, deadlineResolution });
}

function toItem(row: ProposalItemRow): HomeChangeProposalItem {
  const stored = storedCommand(row.command);
  return {
    id: row.id,
    position: Number(row.position),
    action: row.action_kind,
    targetKind: row.target_kind,
    targetId: row.target_id,
    expectedVersion: row.expected_version === null ? null : Number(row.expected_version),
    state: row.state,
    operationKey: row.operation_key,
    requestFingerprint: row.request_fingerprint,
    receiptId: row.receipt_id,
    resultCode: row.result_code,
    command: stored.command,
    deadlineResolution: stored.deadlineResolution
  };
}

function toProposal(row: ProposalRow, items: readonly ProposalItemRow[]): HomeChangeProposal {
  return {
    id: row.id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    sourceTurnId: row.source_turn_id,
    scope: proposalScope(row.scope_kind, row.scope_id),
    state: row.state,
    revision: Number(row.revision),
    acceptedRevision: row.accepted_revision === null ? null : Number(row.accepted_revision),
    acceptanceId: row.acceptance_id,
    itemCount: Number(row.item_count),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
    items: items.map(toItem)
  };
}

function proposalEventPayload(state: HomeProposalState, revision: number, itemCount: number) {
  return { state, revision, itemCount };
}

function returnedRows<T>(result: unknown): readonly T[] {
  if (!Array.isArray(result)) return [];
  const rows = Array.isArray(result[0]) ? result[0] : result;
  return rows as readonly T[];
}

/** Persists proposal changes and their Home feed events with the conversation cursor transaction. */
export class TypeOrmHomeChangeProposalRepository implements IHomeChangeProposalRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async createDraft(input: CreateHomeProposalInput): Promise<{ readonly proposal: HomeChangeProposal; readonly replayed: boolean }> {
    const replayed = await this.withTransaction(async (transaction) => {
      const conversation = await lockConversation(transaction, input.ownerId, input.conversationId);
      if (!conversation) throw new HomeProposalNotFoundError();
      const prior: readonly { readonly id: string; readonly request_fingerprint: string }[] = await transaction.query(
        `SELECT "id", "request_fingerprint" FROM "home_change_proposals"
         WHERE "owner_id" = $1 AND "source_turn_id" = $2 AND "runtime_request_id" = $3 LIMIT 1`,
        [input.ownerId, input.sourceTurnId, input.requestId]
      );
      if (prior[0]) {
        if (prior[0].request_fingerprint !== input.requestFingerprint) throw new HomeProposalRequestKeyReusedError();
        return true;
      }
      const turnRows: readonly { readonly status: string }[] = await transaction.query(
        `SELECT "status" FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.conversationId, input.sourceTurnId]
      );
      if (!turnRows[0]) throw new HomeTurnNotFoundError();
      if (turnRows[0].status !== 'running') throw new HomeTurnNotActiveError();
      if (conversation.scope !== input.scope.kind || (input.scope.kind === 'workspace' && conversation.workspace_id !== input.scope.workspaceId)) {
        throw new HomeProposalNotFoundError();
      }
      await transaction.query(
        `INSERT INTO "home_change_proposals" ("id", "owner_id", "conversation_id", "source_turn_id", "scope_kind", "scope_id", "runtime_request_id", "request_fingerprint", "item_count", "command_bytes")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [input.id, input.ownerId, input.conversationId, input.sourceTurnId, input.scope.kind, input.scope.kind === 'workspace' ? input.scope.workspaceId : null, input.requestId, input.requestFingerprint, input.items.length, input.commandBytes]
      );
      for (const item of input.items) {
        await transaction.query(
          `INSERT INTO "home_change_proposal_items" ("id", "owner_id", "conversation_id", "proposal_id", "position", "action_kind", "target_kind", "target_id", "expected_version", "command")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
          [item.id, input.ownerId, input.conversationId, input.id, item.position, item.action, item.targetKind, item.targetId, item.expectedVersion, storedCommandJson(item.command, item.deadlineResolution)]
        );
      }
      await appendHomeConversationEvent(transaction, {
        ownerId: input.ownerId, conversationId: input.conversationId, type: 'proposal.created', turnId: input.sourceTurnId, entityId: input.id,
        payload: proposalEventPayload('review_required', 1, input.items.length)
      });
      return false;
    });
    const proposal = replayed
      ? await this.findRequest(input.ownerId, input.sourceTurnId, input.requestId)
      : await this.getForOwner(input.ownerId, input.conversationId, input.id);
    if (!proposal) throw new HomeProposalNotFoundError();
    return { proposal, replayed };
  }

  public async getForOwner(ownerId: string, conversationId: string, proposalId: string): Promise<HomeChangeProposal | null> {
    const headerRows: readonly ProposalRow[] = await this.dataSource.query(
      `SELECT ${PROPOSAL_SELECT} FROM "home_change_proposals" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3 LIMIT 1`,
      [ownerId, conversationId, proposalId]
    );
    const header = headerRows[0];
    if (!header) return null;
    const itemRows: readonly ProposalItemRow[] = await this.dataSource.query(
      `SELECT ${ITEM_SELECT} FROM "home_change_proposal_items" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "proposal_id" = $3 ORDER BY "position" ASC`,
      [ownerId, conversationId, proposalId]
    );
    return toProposal(header, itemRows);
  }

  public async listForOwner(input: ListHomeProposalsInput): Promise<HomeProposalListPage | null> {
    const conversation = await this.dataSource.query(
      `SELECT 1 FROM "home_conversations" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1`,
      [input.ownerId, input.conversationId]
    );
    if (!conversation[0]) return null;
    const rows: readonly ProposalRow[] = await this.dataSource.query(
      `SELECT p.${PROPOSAL_SELECT.replaceAll(', ', ', p.')}, to_char(p."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursor_created_at"
       FROM "home_change_proposals" p
       WHERE p."owner_id" = $1 AND p."conversation_id" = $2
         AND ($3::text IS NULL OR p."state" = $3)
         AND ($4::timestamptz IS NULL OR (p."created_at", p."id") < ($4::timestamptz, $5::uuid))
       ORDER BY p."created_at" DESC, p."id" DESC LIMIT $6`,
      [input.ownerId, input.conversationId, input.state ?? null, input.before?.createdAt ?? null, input.before?.id ?? null, input.limit + 1]
    );
    const hasMore = rows.length > input.limit;
    const visible = rows.slice(0, input.limit);
    const last = visible[visible.length - 1];
    return {
      proposals: visible.map((row) => ({
        id: row.id,
        ownerId: row.owner_id,
        conversationId: row.conversation_id,
        sourceTurnId: row.source_turn_id,
        scope: proposalScope(row.scope_kind, row.scope_id),
        state: row.state,
        revision: Number(row.revision),
        acceptedRevision: row.accepted_revision === null ? null : Number(row.accepted_revision),
        acceptanceId: row.acceptance_id,
        itemCount: Number(row.item_count),
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
        updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at)
      })),
      hasMore,
      lastPosition: hasMore && last?.cursor_created_at ? { createdAt: last.cursor_created_at, id: last.id } : null
    };
  }

  public async editItem(input: UpdateHomeProposalItemInput): Promise<HomeChangeProposal | null> {
    await this.withLockedProposal(input.ownerId, input.conversationId, input.proposalId, async (transaction, proposal) => {
      assertEditable(proposal, input.expectedRevision);
      const itemRows: readonly ProposalItemRow[] = await transaction.query(
        `SELECT ${ITEM_SELECT} FROM "home_change_proposal_items" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "proposal_id" = $3 AND "id" = $4 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.conversationId, input.proposalId, input.itemId]
      );
      if (!itemRows[0]) throw new HomeProposalNotFoundError();
      if (itemRows[0].action_kind !== input.command.action) throw new HomeProposalNotEditableError();
      await transaction.query(
        `UPDATE "home_change_proposal_items" SET "target_kind" = $5, "target_id" = $6, "expected_version" = $7, "command" = $8::jsonb, "updated_at" = now()
         WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "proposal_id" = $3 AND "id" = $4`,
        [input.ownerId, input.conversationId, input.proposalId, input.itemId, input.targetKind, input.targetId, input.expectedVersion, storedCommandJson(input.command, input.deadlineResolution)]
      );
      const updated = await this.updateHeaderAfterEdit(transaction, input.ownerId, input.conversationId, input.proposalId, input.commandBytes);
      await appendHomeConversationEvent(transaction, {
        ownerId: input.ownerId, conversationId: input.conversationId, type: 'proposal.updated', turnId: proposal.source_turn_id, entityId: input.proposalId,
        payload: proposalEventPayload('review_required', updated.revision, updated.item_count)
      });
    });
    return this.getForOwner(input.ownerId, input.conversationId, input.proposalId);
  }

  public async removeItem(input: { readonly ownerId: string; readonly conversationId: string; readonly proposalId: string; readonly itemId: string; readonly expectedRevision: number; readonly commandBytes: number }): Promise<HomeChangeProposal | null> {
    await this.withLockedProposal(input.ownerId, input.conversationId, input.proposalId, async (transaction, proposal) => {
      assertEditable(proposal, input.expectedRevision);
      const itemRows: readonly { readonly id: string; readonly action_kind: string; readonly target_id: string }[] = await transaction.query(
        `SELECT "id", "action_kind", "target_id" FROM "home_change_proposal_items" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "proposal_id" = $3 AND "id" = $4 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.conversationId, input.proposalId, input.itemId]
      );
      const item = itemRows[0];
      if (!item) throw new HomeProposalNotFoundError();
      if (item.action_kind === 'workspace.create') {
        const dependents: readonly { readonly id: string }[] = await transaction.query(
          `SELECT "id" FROM "home_change_proposal_items" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "proposal_id" = $3 AND "id" <> $4 AND "action_kind" IN ('task.create', 'task.move') AND COALESCE("command"->'command'->>'workspaceId', "command"->>'workspaceId') = $5 LIMIT 1`,
          [input.ownerId, input.conversationId, input.proposalId, input.itemId, item.target_id]
        );
        if (dependents[0]) throw new HomeProposalDependencyConflictError();
      }
      await transaction.query(
        `DELETE FROM "home_change_proposal_items" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "proposal_id" = $3 AND "id" = $4`,
        [input.ownerId, input.conversationId, input.proposalId, input.itemId]
      );
      const rows: readonly { readonly id: string; readonly position: number }[] = await transaction.query(
        `SELECT "id", "position" FROM "home_change_proposal_items" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "proposal_id" = $3 ORDER BY "position" ASC`,
        [input.ownerId, input.conversationId, input.proposalId]
      );
      for (const [position, row] of rows.entries()) {
        if (row.position !== position) await transaction.query(
          `UPDATE "home_change_proposal_items" SET "position" = $4 WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "proposal_id" = $3 AND "id" = $5`,
          [input.ownerId, input.conversationId, input.proposalId, position, row.id]
        );
      }
      const updated = await this.updateHeaderAfterEdit(transaction, input.ownerId, input.conversationId, input.proposalId, input.commandBytes);
      await appendHomeConversationEvent(transaction, {
        ownerId: input.ownerId, conversationId: input.conversationId, type: 'proposal.updated', turnId: proposal.source_turn_id, entityId: input.proposalId,
        payload: proposalEventPayload('review_required', updated.revision, updated.item_count)
      });
    });
    return this.getForOwner(input.ownerId, input.conversationId, input.proposalId);
  }

  public async seal(input: SealHomeProposalInput): Promise<HomeChangeProposal | null> {
    await this.withLockedProposal(input.ownerId, input.conversationId, input.proposalId, async (transaction, proposal) => {
      if (proposal.state !== 'review_required') {
        if (proposal.state !== 'cancelled' && proposal.accepted_revision !== null
          && Number(proposal.accepted_revision) === input.expectedRevision && proposal.acceptance_id !== null) return;
        if (proposal.accepted_revision !== null && Number(proposal.accepted_revision) !== input.expectedRevision) throw new HomeProposalRevisionConflictError();
        throw new HomeProposalNotAcceptableError();
      }
      if (proposal.revision !== input.expectedRevision) throw new HomeProposalRevisionConflictError();
      if (input.items.length === 0) throw new HomeProposalNotAcceptableError();
      const storedRows: readonly { readonly id: string; readonly command: HomeProposalCommand | string }[] = await transaction.query(
        `SELECT "id", "command" FROM "home_change_proposal_items" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "proposal_id" = $3 ORDER BY "position" ASC FOR UPDATE`,
        [input.ownerId, input.conversationId, input.proposalId]
      );
      if (storedRows.length !== input.items.length || storedRows.some((row, index) => {
        const sealedItem = input.items[index];
        if (row.id !== sealedItem?.itemId || !sealedItem) return true;
        const stored = storedCommand(row.command);
        return stableJson(stored.command) !== stableJson(sealedItem.command)
          || stableJson(stored.deadlineResolution) !== stableJson(sealedItem.deadlineResolution);
      })) {
        throw new HomeProposalRevisionConflictError();
      }
      for (const item of input.items) {
        await transaction.query(
          `UPDATE "home_change_proposal_items" SET "command" = $5::jsonb, "operation_key" = $6, "request_fingerprint" = $7, "state" = 'ready', "updated_at" = now()
           WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "proposal_id" = $3 AND "id" = $4`,
          [input.ownerId, input.conversationId, input.proposalId, item.itemId, storedCommandJson(item.command, item.deadlineResolution), item.operationKey, item.requestFingerprint]
        );
      }
      await transaction.query(
        `UPDATE "home_change_proposals" SET "state" = 'accepted', "acceptance_id" = $4, "accepted_revision" = "revision", "updated_at" = now()
         WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3`,
        [input.ownerId, input.conversationId, input.proposalId, input.acceptanceId]
      );
      await appendHomeConversationEvent(transaction, {
        ownerId: input.ownerId, conversationId: input.conversationId, type: 'proposal.accepted', turnId: proposal.source_turn_id, entityId: input.proposalId,
        payload: { acceptanceId: input.acceptanceId, revision: proposal.revision, itemCount: input.items.length }
      });
    });
    return this.getForOwner(input.ownerId, input.conversationId, input.proposalId);
  }

  public async updateExecutionState(input: { readonly ownerId: string; readonly conversationId: string; readonly proposalId: string; readonly state: Extract<HomeProposalState, 'executing' | 'partial' | 'completed' | 'unknown'> }): Promise<HomeChangeProposal | null> {
    await this.withLockedProposal(input.ownerId, input.conversationId, input.proposalId, async (transaction, proposal) => {
      if (!['accepted', 'executing', 'partial', 'unknown'].includes(proposal.state)) {
        if (proposal.state === 'completed' && input.state === 'completed') return;
        throw proposal.state === 'cancelled' ? new HomeProposalCancelledError() : new HomeProposalNotAcceptableError();
      }
      await transaction.query(
        `UPDATE "home_change_proposals" SET "state" = $4, "updated_at" = now() WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3`,
        [input.ownerId, input.conversationId, input.proposalId, input.state]
      );
      const itemCount = Number(proposal.item_count);
      await appendHomeConversationEvent(transaction, {
        ownerId: input.ownerId, conversationId: input.conversationId, type: 'proposal.updated', turnId: proposal.source_turn_id, entityId: input.proposalId,
        payload: proposalEventPayload(input.state, Number(proposal.revision), itemCount)
      });
    });
    return this.getForOwner(input.ownerId, input.conversationId, input.proposalId);
  }

  public async updateItemState(input: { readonly ownerId: string; readonly conversationId: string; readonly proposalId: string; readonly itemId: string; readonly state: HomeProposalItemState; readonly resultCode?: string | null; readonly receiptId?: string | null }): Promise<HomeChangeProposal | null> {
    await this.withLockedProposal(input.ownerId, input.conversationId, input.proposalId, async (transaction, proposal) => {
      if (proposal.state === 'cancelled') throw new HomeProposalCancelledError();
      const itemRows: readonly ProposalItemRow[] = await transaction.query(
        `SELECT ${ITEM_SELECT} FROM "home_change_proposal_items" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "proposal_id" = $3 AND "id" = $4 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.conversationId, input.proposalId, input.itemId]
      );
      const item = itemRows[0];
      if (!item) throw new HomeProposalNotFoundError();
      await transaction.query(
        `UPDATE "home_change_proposal_items" SET "state" = $5, "result_code" = $6, "receipt_id" = COALESCE($7, "receipt_id"), "updated_at" = now()
         WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "proposal_id" = $3 AND "id" = $4`,
        [input.ownerId, input.conversationId, input.proposalId, input.itemId, input.state, input.resultCode ?? null, input.receiptId ?? null]
      );
      await appendHomeConversationEvent(transaction, {
        ownerId: input.ownerId, conversationId: input.conversationId, type: 'proposal.item_status_changed', turnId: proposal.source_turn_id, entityId: input.proposalId,
        payload: {
          itemId: input.itemId,
          actionKind: item.action_kind,
          targetKind: item.target_kind,
          targetId: item.target_id,
          itemState: input.state,
          ...(input.receiptId ?? item.receipt_id ? { receiptId: input.receiptId ?? item.receipt_id } : {}),
          ...(input.resultCode ? { resultCode: input.resultCode } : {})
        }
      });
    });
    return this.getForOwner(input.ownerId, input.conversationId, input.proposalId);
  }

  public async cancel(input: { readonly ownerId: string; readonly conversationId: string; readonly proposalId: string; readonly expectedRevision: number }): Promise<HomeChangeProposal | null> {
    await this.withLockedProposal(input.ownerId, input.conversationId, input.proposalId, async (transaction, proposal) => {
      if (proposal.state === 'cancelled') return;
      if (proposal.state === 'completed') throw new HomeProposalNotAcceptableError();
      if (proposal.revision !== input.expectedRevision) throw new HomeProposalRevisionConflictError();
      await transaction.query(
        `UPDATE "home_change_proposals" SET "state" = 'cancelled', "updated_at" = now() WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3`,
        [input.ownerId, input.conversationId, input.proposalId]
      );
      const itemRows: readonly { readonly id: string; readonly action_kind: string; readonly target_kind: 'task' | 'workspace'; readonly target_id: string; readonly state: HomeProposalItemState; readonly receipt_id: string | null }[] = await transaction.query(
        `SELECT "id", "action_kind", "target_kind", "target_id", "state", "receipt_id" FROM "home_change_proposal_items" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "proposal_id" = $3 ORDER BY "position" ASC FOR UPDATE`,
        [input.ownerId, input.conversationId, input.proposalId]
      );
      for (const item of itemRows) {
        if (item.state === 'saved' || item.state === 'failed' || item.state === 'conflicted' || item.state === 'blocked') continue;
        await transaction.query(
          `UPDATE "home_change_proposal_items" SET "state" = 'cancelled', "updated_at" = now() WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "proposal_id" = $3 AND "id" = $4`,
          [input.ownerId, input.conversationId, input.proposalId, item.id]
        );
      }
      await appendHomeConversationEvent(transaction, {
        ownerId: input.ownerId, conversationId: input.conversationId, type: 'proposal.cancelled', turnId: proposal.source_turn_id, entityId: input.proposalId,
        payload: { state: 'cancelled' }
      });
    });
    return this.getForOwner(input.ownerId, input.conversationId, input.proposalId);
  }

  public async findRequest(ownerId: string, sourceTurnId: string, requestId: string): Promise<HomeChangeProposal | null> {
    const rows: readonly { readonly conversation_id: string; readonly id: string }[] = await this.dataSource.query(
      `SELECT "conversation_id", "id" FROM "home_change_proposals" WHERE "owner_id" = $1 AND "source_turn_id" = $2 AND "runtime_request_id" = $3 LIMIT 1`,
      [ownerId, sourceTurnId, requestId]
    );
    return rows[0] ? this.getForOwner(ownerId, rows[0].conversation_id, rows[0].id) : null;
  }

  private async withLockedProposal<T>(ownerId: string, conversationId: string, proposalId: string, action: (transaction: QueryRunner, proposal: ProposalRow) => Promise<T>): Promise<T> {
    return this.withTransaction(async (transaction) => {
      const conversation = await lockConversation(transaction, ownerId, conversationId);
      if (!conversation) throw new HomeProposalNotFoundError();
      const rows: readonly ProposalRow[] = await transaction.query(
        `SELECT ${PROPOSAL_SELECT} FROM "home_change_proposals" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3 LIMIT 1 FOR UPDATE`,
        [ownerId, conversationId, proposalId]
      );
      if (!rows[0]) throw new HomeProposalNotFoundError();
      return action(transaction, rows[0]);
    });
  }

  private async updateHeaderAfterEdit(transaction: QueryRunner, ownerId: string, conversationId: string, proposalId: string, commandBytes: number): Promise<{ revision: number; item_count: number }> {
    const rows = returnedRows<{ readonly revision: number; readonly item_count: number }>(await transaction.query(
      `UPDATE "home_change_proposals" SET "revision" = "revision" + 1, "item_count" = (SELECT count(*) FROM "home_change_proposal_items" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "proposal_id" = $3), "command_bytes" = $4, "updated_at" = now()
       WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3 RETURNING "revision", "item_count"`,
      [ownerId, conversationId, proposalId, commandBytes]
    ));
    if (!rows[0]) throw new HomeProposalNotFoundError();
    return { revision: Number(rows[0].revision), item_count: Number(rows[0].item_count) };
  }

  private async withTransaction<T>(action: (transaction: QueryRunner) => Promise<T>): Promise<T> {
    const transaction = this.dataSource.createQueryRunner();
    try {
      await transaction.connect();
      await transaction.startTransaction();
      const result = await action(transaction);
      await transaction.commitTransaction();
      return result;
    } catch (error: unknown) {
      if (transaction.isTransactionActive) await transaction.rollbackTransaction();
      throw error;
    } finally {
      await transaction.release();
    }
  }
}

function assertEditable(proposal: ProposalRow, expectedRevision: number): void {
  if (proposal.state !== 'review_required') throw new HomeProposalNotEditableError();
  if (Number(proposal.revision) !== expectedRevision) throw new HomeProposalRevisionConflictError();
}
