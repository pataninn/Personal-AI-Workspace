import { createHash } from 'node:crypto';

import type { DataSource, QueryRunner } from 'typeorm';

import {
  ConversationNotFoundError,
  ConversationQueryInvalidError,
  IdempotencyKeyReusedError,
  ProjectArchivedError
} from '@/modules/conversations/domain/conversation-errors';
import type {
  Conversation,
  ConversationPage,
  Message,
  MessagePage,
  MessageRole,
  PersistedResource
} from '@/modules/conversations/domain/conversation-types';
import type {
  AddMessageRecord,
  CreateConversationRecord,
  FindConversationInput,
  IConversationRepository,
  ListConversationsInput
} from '@/modules/conversations/repositories/conversation-repository';

interface ConversationRow {
  readonly id: string;
  readonly owner_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly status: 'active' | 'archived';
  readonly last_activity_at: Date | string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface MessageRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly role: MessageRole;
  readonly sequence: number;
  readonly content: string;
  readonly created_at: Date | string;
}

interface IdempotencyRow {
  readonly request_fingerprint: string;
  readonly resource_id: string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    lastActivityAt: toDate(row.last_activity_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    sequence: row.sequence,
    content: row.content,
    createdAt: toDate(row.created_at)
  };
}

function cursorValue(cursor: string): { readonly lastActivityAt: string; readonly id: string } {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object') {
      throw new Error('not an object');
    }
    const value = decoded as { lastActivityAt?: unknown; id?: unknown };
    if (typeof value.lastActivityAt !== 'string' || typeof value.id !== 'string') {
      throw new Error('invalid fields');
    }
    return { lastActivityAt: value.lastActivityAt, id: value.id };
  } catch {
    throw new ConversationQueryInvalidError('cursor', 'The conversation cursor is invalid.');
  }
}

function encodeCursor(conversation: Conversation): string {
  return Buffer.from(JSON.stringify({ lastActivityAt: conversation.lastActivityAt.toISOString(), id: conversation.id })).toString('base64url');
}

async function lockIntent(queryRunner: QueryRunner, value: string): Promise<void> {
  await queryRunner.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [value]);
}

async function assertProjectWritable(queryRunner: QueryRunner, ownerId: string, projectId: string): Promise<void> {
  const rows: readonly { status: 'active' | 'archived' }[] = await queryRunner.query(
    'SELECT "status" FROM "projects" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1 FOR UPDATE',
    [ownerId, projectId]
  );
  if (!rows[0]) {
    throw new ConversationNotFoundError();
  }
  if (rows[0].status === 'archived') {
    throw new ProjectArchivedError();
  }
}

export class TypeOrmConversationRepository implements IConversationRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async listByProjectForOwner(input: ListConversationsInput): Promise<ConversationPage> {
    const parameters: unknown[] = [input.ownerId, input.projectId];
    let cursorFilter = '';
    if (input.cursor) {
      const cursor = cursorValue(input.cursor);
      parameters.push(cursor.lastActivityAt, cursor.id);
      cursorFilter = ' AND ("last_activity_at" < $3 OR ("last_activity_at" = $3 AND "id" > $4))';
    }
    parameters.push(input.limit + 1);
    const rows: readonly ConversationRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "project_id", "title", "status", "last_activity_at", "created_at", "updated_at"
       FROM "conversations" WHERE "owner_id" = $1 AND "project_id" = $2${cursorFilter}
       ORDER BY "last_activity_at" DESC, "id" ASC LIMIT $${parameters.length}`,
      parameters
    );
    const conversations = rows.map(toConversation);
    const hasMore = conversations.length > input.limit;
    const page = hasMore ? conversations.slice(0, input.limit) : conversations;
    return { conversations: page, nextCursor: hasMore ? encodeCursor(page[page.length - 1] as Conversation) : null };
  }

  public async findWithMessagesForOwner(input: FindConversationInput): Promise<MessagePage | null> {
    const conversationRows: readonly ConversationRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "project_id", "title", "status", "last_activity_at", "created_at", "updated_at"
       FROM "conversations" WHERE "owner_id" = $1 AND "project_id" = $2 AND "id" = $3 LIMIT 1`,
      [input.ownerId, input.projectId, input.conversationId]
    );
    const row = conversationRows[0];
    if (!row) {
      return null;
    }
    const parameters: unknown[] = [input.conversationId];
    const beforeFilter = input.beforeSequence === undefined ? '' : ' AND "sequence" < $2';
    if (input.beforeSequence !== undefined) {
      parameters.push(input.beforeSequence);
    }
    parameters.push(input.limit + 1);
    const messageRows: readonly MessageRow[] = await this.dataSource.query(
      `SELECT "id", "conversation_id", "role", "sequence", "content", "created_at"
       FROM "messages" WHERE "conversation_id" = $1${beforeFilter}
       ORDER BY "sequence" DESC LIMIT $${parameters.length}`,
      parameters
    );
    const hasMore = messageRows.length > input.limit;
    const pageRows = hasMore ? messageRows.slice(0, input.limit) : messageRows;
    const messages = pageRows.map(toMessage).reverse();
    return {
      conversation: toConversation(row),
      messages,
      nextBeforeSequence: hasMore ? messages[0]?.sequence ?? null : null
    };
  }

  public async create(input: CreateConversationRecord): Promise<PersistedResource<Conversation>> {
    const queryRunner = await this.startTransaction();
    try {
      await assertProjectWritable(queryRunner, input.ownerId, input.projectId);
      await lockIntent(queryRunner, `conversation:create:${input.ownerId}:${input.projectId}:${input.idempotencyKey}`);
      const replay = await this.findIdempotency(queryRunner, input, 'conversation');
      if (replay) {
        const resource = await this.findConversation(queryRunner, input.ownerId, input.projectId, replay.resource_id);
        if (!resource) {
          throw new ConversationNotFoundError();
        }
        await queryRunner.commitTransaction();
        return { resource, replayed: true };
      }
      const rows: readonly ConversationRow[] = await queryRunner.query(
        `INSERT INTO "conversations" ("owner_id", "project_id", "title")
         VALUES ($1, $2, $3)
         RETURNING "id", "owner_id", "project_id", "title", "status", "last_activity_at", "created_at", "updated_at"`,
        [input.ownerId, input.projectId, input.title]
      );
      const row = rows[0];
      if (!row) {
        throw new Error('The conversation could not be created.');
      }
      await this.insertIdempotency(queryRunner, input, 'conversation', row.id);
      await queryRunner.commitTransaction();
      return { resource: toConversation(row), replayed: false };
    } catch (error: unknown) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async addUserMessage(input: AddMessageRecord): Promise<PersistedResource<Message>> {
    const queryRunner = await this.startTransaction();
    try {
      await assertProjectWritable(queryRunner, input.ownerId, input.projectId);
      await lockIntent(queryRunner, `message:${input.ownerId}:${input.projectId}:${input.conversationId}:${input.idempotencyKey}`);
      const replay = await this.findIdempotency(queryRunner, input, 'message');
      if (replay) {
        const resource = await this.findMessage(queryRunner, input, replay.resource_id);
        if (!resource) {
          throw new ConversationNotFoundError();
        }
        await queryRunner.commitTransaction();
        return { resource, replayed: true };
      }
      const conversation = await this.findConversation(queryRunner, input.ownerId, input.projectId, input.conversationId, true);
      if (!conversation) {
        throw new ConversationNotFoundError();
      }
      const sequenceRows: readonly { sequence: number }[] = await queryRunner.query(
        'SELECT COALESCE(MAX("sequence"), 0) + 1 AS "sequence" FROM "messages" WHERE "conversation_id" = $1',
        [input.conversationId]
      );
      const sequence = Number(sequenceRows[0]?.sequence ?? 1);
      const rows: readonly MessageRow[] = await queryRunner.query(
        `INSERT INTO "messages" ("conversation_id", "role", "sequence", "content", "content_hash", "content_length")
         VALUES ($1, 'user', $2, $3, $4, $5)
         RETURNING "id", "conversation_id", "role", "sequence", "content", "created_at"`,
        [input.conversationId, sequence, input.content, hashContent(input.content), input.content.length]
      );
      const row = rows[0];
      if (!row) {
        throw new Error('The message could not be created.');
      }
      await queryRunner.query('UPDATE "conversations" SET "last_activity_at" = now(), "updated_at" = now() WHERE "id" = $1', [input.conversationId]);
      await this.insertIdempotency(queryRunner, input, 'message', row.id, input.conversationId);
      await queryRunner.commitTransaction();
      return { resource: toMessage(row), replayed: false };
    } catch (error: unknown) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async startTransaction(): Promise<QueryRunner> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    return queryRunner;
  }

  private async findIdempotency(queryRunner: QueryRunner, input: CreateConversationRecord | AddMessageRecord, operation: 'conversation' | 'message'): Promise<IdempotencyRow | null> {
    const rows: readonly IdempotencyRow[] = await queryRunner.query(
      `SELECT "request_fingerprint", "resource_id" FROM "conversation_idempotency_keys"
       WHERE "owner_id" = $1 AND "project_id" = $2 AND "operation" = $3 AND "idempotency_key" = $4 LIMIT 1`,
      [input.ownerId, input.projectId, operation, input.idempotencyKey]
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    if (row.request_fingerprint !== input.requestFingerprint) {
      throw new IdempotencyKeyReusedError();
    }
    return row;
  }

  private async insertIdempotency(queryRunner: QueryRunner, input: CreateConversationRecord | AddMessageRecord, operation: 'conversation' | 'message', resourceId: string, conversationId?: string): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "conversation_idempotency_keys" ("owner_id", "project_id", "conversation_id", "operation", "idempotency_key", "request_fingerprint", "resource_id")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.ownerId, input.projectId, conversationId ?? null, operation, input.idempotencyKey, input.requestFingerprint, resourceId]
    );
  }

  private async findConversation(queryRunner: QueryRunner, ownerId: string, projectId: string, conversationId: string, forUpdate = false): Promise<Conversation | null> {
    const rows: readonly ConversationRow[] = await queryRunner.query(
      `SELECT "id", "owner_id", "project_id", "title", "status", "last_activity_at", "created_at", "updated_at"
       FROM "conversations" WHERE "owner_id" = $1 AND "project_id" = $2 AND "id" = $3 LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
      [ownerId, projectId, conversationId]
    );
    return rows[0] ? toConversation(rows[0]) : null;
  }

  private async findMessage(queryRunner: QueryRunner, input: AddMessageRecord, messageId: string): Promise<Message | null> {
    const rows: readonly MessageRow[] = await queryRunner.query(
      `SELECT m."id", m."conversation_id", m."role", m."sequence", m."content", m."created_at"
       FROM "messages" m INNER JOIN "conversations" c ON c."id" = m."conversation_id"
       WHERE m."id" = $1 AND m."conversation_id" = $2 AND c."owner_id" = $3 AND c."project_id" = $4 LIMIT 1`,
      [messageId, input.conversationId, input.ownerId, input.projectId]
    );
    return rows[0] ? toMessage(rows[0]) : null;
  }
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
