import type { DataSource, QueryRunner } from 'typeorm';

import {
  HomeConversationNotFoundError,
  HomeTurnNotFoundError,
  HomeTurnTransitionInvalidError
} from '@/modules/home-assistant/domain/home-conversation-errors';
import type {
  HomeConversation,
  HomeConversationPage,
  HomeMessage,
  HomeMessagePage,
  HomeTurn,
  HomeTurnPage,
  PersistedHomeResource
} from '@/modules/home-assistant/domain/home-conversation-types';
import { canTransitionHomeTurn } from '@/modules/home-assistant/domain/home-conversation-types';
import type {
  AppendHomeMessageInput,
  CreateHomeConversationInput,
  CreateHomeTurnInput,
  IHomeConversationRepository,
  ListHomeConversationsInput,
  ListHomeMessagesInput,
  ListHomeTurnsInput,
  UpdateHomeTurnStatusInput
} from '@/modules/home-assistant/repositories/home-conversation-repository';
import {
  assertRequestFingerprint,
  assertWorkspaceOwned,
  lockConversation,
  lockIntent,
  withTransaction
} from '@/infrastructure/database/repositories/home-conversation-repository-helpers';
import {
  decodeHomeConversationCursor,
  encodeHomeConversationCursor,
  toHomeConversation,
  toHomeMessage,
  toHomeTurn,
  type HomeConversationListRow,
  type HomeConversationRow,
  type HomeMessageRow,
  type HomeTurnRow
} from '@/infrastructure/database/repositories/home-conversation-persistence-mappers';

interface KeyedRow {
  readonly request_fingerprint: string;
}

interface SequenceRow {
  readonly sequence: number | string;
}

interface HomeMessageKeyedRow extends HomeMessageRow, KeyedRow {}

/** TypeORM adapter for durable Home conversations, turns, and messages. */
export class TypeOrmHomeConversationRepository implements IHomeConversationRepository {
  public constructor(private readonly dataSource: DataSource) {}

  /** Lists conversations in one owner scope using stable activity pagination. */
  public async listForOwner(input: ListHomeConversationsInput): Promise<HomeConversationPage> {
    const parameters: unknown[] = [input.ownerId, input.scope.kind];
    let scopeFilter = ' AND "workspace_id" IS NULL';
    if (input.scope.kind === 'workspace') {
      parameters.push(input.scope.workspaceId);
      scopeFilter = ` AND "workspace_id" = $${parameters.length}`;
    }
    let cursorFilter = '';
    if (input.cursor) {
      const cursor = decodeHomeConversationCursor(input.cursor);
      parameters.push(cursor.lastActivityAt, cursor.id);
      cursorFilter = ` AND ("last_activity_at" < $${parameters.length - 1} OR ("last_activity_at" = $${parameters.length - 1} AND "id" > $${parameters.length}))`;
    }
    parameters.push(input.limit + 1);
    const rows: readonly HomeConversationListRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "scope", "workspace_id", "title", "last_activity_at",
              to_char("last_activity_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursor_activity_at",
              "created_at", "updated_at"
       FROM "home_conversations" WHERE "owner_id" = $1 AND "scope" = $2${scopeFilter}${cursorFilter}
       ORDER BY "last_activity_at" DESC, "id" ASC LIMIT $${parameters.length}`,
      parameters
    );
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const lastPageRow = pageRows[pageRows.length - 1];
    return {
      conversations: pageRows.map(toHomeConversation),
      nextCursor: hasMore && lastPageRow ? encodeHomeConversationCursor(lastPageRow.cursor_activity_at, lastPageRow.id) : null
    };
  }

  /** Finds a conversation only when it belongs to the supplied owner. */
  public async findForOwner(ownerId: string, conversationId: string): Promise<HomeConversation | null> {
    const rows: readonly HomeConversationRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "scope", "workspace_id", "title", "last_activity_at", "created_at", "updated_at"
       FROM "home_conversations" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1`,
      [ownerId, conversationId]
    );
    return rows[0] ? toHomeConversation(rows[0]) : null;
  }

  /** Creates an owner-scoped conversation or replays the matching request. */
  public async create(input: CreateHomeConversationInput): Promise<PersistedHomeResource<HomeConversation>> {
    return withTransaction(this.dataSource, async (queryRunner) => {
      const workspaceId = input.scope.kind === 'workspace' ? input.scope.workspaceId : null;
      await lockIntent(queryRunner, JSON.stringify(['conversation', input.ownerId, input.scope.kind, workspaceId, input.requestKey]));
      const existing = await this.findConversationRequest(queryRunner, input.ownerId, input.scope.kind, workspaceId, input.requestKey);
      if (existing) {
        assertRequestFingerprint(existing.request_fingerprint, input.requestFingerprint, 'conversation');
        return { resource: toHomeConversation(existing), replayed: true };
      }
      if (input.scope.kind === 'workspace') {
        await assertWorkspaceOwned(queryRunner, input.ownerId, input.scope.workspaceId);
      }
      const rows: readonly HomeConversationRow[] = await queryRunner.query(
        `INSERT INTO "home_conversations" ("owner_id", "scope", "workspace_id", "title", "create_request_key", "create_request_fingerprint")
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING "id", "owner_id", "scope", "workspace_id", "title", "last_activity_at", "created_at", "updated_at"`,
        [input.ownerId, input.scope.kind, workspaceId, input.title, input.requestKey, input.requestFingerprint]
      );
      const row = rows[0];
      if (!row) {
        throw new HomeConversationNotFoundError();
      }
      return { resource: toHomeConversation(row), replayed: false };
    });
  }

  /** Creates a sequenced turn or replays its matching request. */
  public async createTurn(input: CreateHomeTurnInput): Promise<PersistedHomeResource<HomeTurn>> {
    return withTransaction(this.dataSource, async (queryRunner) => {
      const conversation = await lockConversation(queryRunner, input.ownerId, input.conversationId);
      if (!conversation) {
        throw new HomeConversationNotFoundError();
      }
      const existingRows: readonly (HomeTurnRow & KeyedRow)[] = await queryRunner.query(
        `SELECT "id", "owner_id", "conversation_id", "sequence", "request_key", "request_fingerprint", "status", "created_at", "updated_at"
         FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "request_key" = $3 LIMIT 1`,
        [input.ownerId, input.conversationId, input.requestKey]
      );
      const existing = existingRows[0];
      if (existing) {
        assertRequestFingerprint(existing.request_fingerprint, input.requestFingerprint, 'turn');
        return { resource: toHomeTurn(existing), replayed: true };
      }
      const sequenceRows: readonly SequenceRow[] = await queryRunner.query(
        'SELECT COALESCE(MAX("sequence"), 0) + 1 AS "sequence" FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2',
        [input.ownerId, input.conversationId]
      );
      const sequence = Number(sequenceRows[0]?.sequence ?? 1);
      const rows: readonly HomeTurnRow[] = await queryRunner.query(
        `INSERT INTO "home_turns" ("owner_id", "conversation_id", "sequence", "request_key", "request_fingerprint")
         VALUES ($1, $2, $3, $4, $5)
         RETURNING "id", "owner_id", "conversation_id", "sequence", "request_key", "status", "created_at", "updated_at"`,
        [input.ownerId, input.conversationId, sequence, input.requestKey, input.requestFingerprint]
      );
      const row = rows[0];
      if (!row) {
        throw new HomeConversationNotFoundError();
      }
      await queryRunner.query('UPDATE "home_conversations" SET "last_activity_at" = now(), "updated_at" = now() WHERE "owner_id" = $1 AND "id" = $2', [input.ownerId, input.conversationId]);
      return { resource: toHomeTurn(row), replayed: false };
    });
  }

  /** Lists a conversation's turns in ascending sequence order. */
  public async listTurnsForOwner(input: ListHomeTurnsInput): Promise<HomeTurnPage | null> {
    const conversation = await this.findForOwner(input.ownerId, input.conversationId);
    if (!conversation) {
      return null;
    }
    const parameters: unknown[] = [input.ownerId, input.conversationId];
    const afterFilter = input.afterSequence === undefined ? '' : ' AND "sequence" > $3';
    if (input.afterSequence !== undefined) {
      parameters.push(input.afterSequence);
    }
    parameters.push(input.limit + 1);
    const rows: readonly HomeTurnRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "conversation_id", "sequence", "request_key", "status", "created_at", "updated_at"
       FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2${afterFilter}
       ORDER BY "sequence" ASC LIMIT $${parameters.length}`,
      parameters
    );
    const turns = rows.map(toHomeTurn);
    const hasMore = turns.length > input.limit;
    const page = hasMore ? turns.slice(0, input.limit) : turns;
    return { turns: page, nextAfterSequence: hasMore ? page[page.length - 1]?.sequence ?? null : null };
  }

  /** Updates a turn only within the supplied owner and conversation. */
  public async updateTurnStatus(input: UpdateHomeTurnStatusInput): Promise<HomeTurn | null> {
    return withTransaction(this.dataSource, async (queryRunner) => {
      const conversation = await lockConversation(queryRunner, input.ownerId, input.conversationId);
      if (!conversation) {
        return null;
      }
      const currentRows: readonly HomeTurnRow[] = await queryRunner.query(
        `SELECT "id", "owner_id", "conversation_id", "sequence", "request_key", "status", "created_at", "updated_at"
         FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.conversationId, input.turnId]
      );
      const current = currentRows[0];
      if (!current) {
        return null;
      }
      if (!canTransitionHomeTurn(current.status, input.status)) {
        throw new HomeTurnTransitionInvalidError(current.status, input.status);
      }
      if (current.status === input.status) {
        return toHomeTurn(current);
      }
      const rows: readonly HomeTurnRow[] = await queryRunner.query(
        `UPDATE "home_turns" SET "status" = $4, "updated_at" = now()
         WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3
         RETURNING "id", "owner_id", "conversation_id", "sequence", "request_key", "status", "created_at", "updated_at"`,
        [input.ownerId, input.conversationId, input.turnId, input.status]
      );
      const row = rows[0];
      if (!row) {
        return null;
      }
      await queryRunner.query('UPDATE "home_conversations" SET "last_activity_at" = now(), "updated_at" = now() WHERE "owner_id" = $1 AND "id" = $2', [input.ownerId, input.conversationId]);
      return toHomeTurn(row);
    });
  }

  /** Appends a sequenced message or replays its matching request. */
  public async appendMessage(input: AppendHomeMessageInput): Promise<PersistedHomeResource<HomeMessage>> {
    return withTransaction(this.dataSource, async (queryRunner) => {
      const conversation = await lockConversation(queryRunner, input.ownerId, input.conversationId);
      if (!conversation) {
        throw new HomeConversationNotFoundError();
      }
      const existingRows: readonly HomeMessageKeyedRow[] = await queryRunner.query(
        `SELECT "id", "owner_id", "conversation_id", "turn_id", "sequence", "role", "content", "request_key", "request_fingerprint", "created_at"
         FROM "home_messages" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "turn_id" = $3 AND "request_key" = $4 LIMIT 1`,
        [input.ownerId, input.conversationId, input.turnId, input.requestKey]
      );
      const existing = existingRows[0];
      if (existing) {
        assertRequestFingerprint(existing.request_fingerprint, input.requestFingerprint, 'message');
        return { resource: toHomeMessage(existing), replayed: true };
      }
      const turnRows: readonly { id: string }[] = await queryRunner.query(
        `SELECT "id" FROM "home_turns" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "id" = $3 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.conversationId, input.turnId]
      );
      if (!turnRows[0]) {
        throw new HomeTurnNotFoundError();
      }
      const sequenceRows: readonly SequenceRow[] = await queryRunner.query(
        'SELECT COALESCE(MAX("sequence"), 0) + 1 AS "sequence" FROM "home_messages" WHERE "owner_id" = $1 AND "conversation_id" = $2',
        [input.ownerId, input.conversationId]
      );
      const sequence = Number(sequenceRows[0]?.sequence ?? 1);
      const rows: readonly HomeMessageRow[] = await queryRunner.query(
        `INSERT INTO "home_messages" ("owner_id", "conversation_id", "turn_id", "sequence", "role", "content", "request_key", "request_fingerprint")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING "id", "owner_id", "conversation_id", "turn_id", "sequence", "role", "content", "created_at"`,
        [input.ownerId, input.conversationId, input.turnId, sequence, input.role, input.content, input.requestKey, input.requestFingerprint]
      );
      const row = rows[0];
      if (!row) {
        throw new HomeTurnNotFoundError();
      }
      await queryRunner.query('UPDATE "home_conversations" SET "last_activity_at" = now(), "updated_at" = now() WHERE "owner_id" = $1 AND "id" = $2', [input.ownerId, input.conversationId]);
      return { resource: toHomeMessage(row), replayed: false };
    });
  }

  /** Lists messages from one owner-scoped conversation in sequence order. */
  public async listMessagesForOwner(input: ListHomeMessagesInput): Promise<HomeMessagePage | null> {
    const conversation = await this.findForOwner(input.ownerId, input.conversationId);
    if (!conversation) {
      return null;
    }
    const parameters: unknown[] = [input.ownerId, input.conversationId];
    const beforeFilter = input.beforeSequence === undefined ? '' : ' AND "sequence" < $3';
    if (input.beforeSequence !== undefined) {
      parameters.push(input.beforeSequence);
    }
    parameters.push(input.limit + 1);
    const rows: readonly HomeMessageRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "conversation_id", "turn_id", "sequence", "role", "content", "created_at"
       FROM "home_messages" WHERE "owner_id" = $1 AND "conversation_id" = $2${beforeFilter}
       ORDER BY "sequence" DESC LIMIT $${parameters.length}`,
      parameters
    );
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const messages = pageRows.map(toHomeMessage).reverse();
    return { messages, nextBeforeSequence: hasMore ? messages[0]?.sequence ?? null : null };
  }

  private async findConversationRequest(queryRunner: QueryRunner, ownerId: string, scope: 'home' | 'workspace', workspaceId: string | null, requestKey: string): Promise<(HomeConversationRow & KeyedRow) | null> {
    const rows: readonly (HomeConversationRow & KeyedRow)[] = await queryRunner.query(
      `SELECT "id", "owner_id", "scope", "workspace_id", "title", "create_request_fingerprint" AS "request_fingerprint", "last_activity_at", "created_at", "updated_at"
       FROM "home_conversations" WHERE "owner_id" = $1 AND "scope" = $2 AND "workspace_id" IS NOT DISTINCT FROM $3 AND "create_request_key" = $4 LIMIT 1`,
      [ownerId, scope, workspaceId, requestKey]
    );
    return rows[0] ?? null;
  }
}
