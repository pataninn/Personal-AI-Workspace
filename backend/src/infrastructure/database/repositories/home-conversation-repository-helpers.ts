import type { DataSource, QueryRunner } from 'typeorm';
import { lockProjectWriteState } from '@/infrastructure/database/project-removal-write-barrier';

import {
  HomeConversationNotFoundError,
  HomeRequestKeyReusedError
} from '@/modules/home-assistant/domain/home-conversation-errors';
import type { HomeConversationRow } from '@/infrastructure/database/repositories/home-conversation-persistence-mappers';

/** Runs a repository write in a transaction and always releases its runner. */
export async function withTransaction<T>(dataSource: DataSource, action: (queryRunner: QueryRunner) => Promise<T>): Promise<T> {
  const queryRunner = dataSource.createQueryRunner();
  try {
    await queryRunner.connect();
    await queryRunner.startTransaction();
    const result = await action(queryRunner);
    await queryRunner.commitTransaction();
    return result;
  } catch (error: unknown) {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    throw error;
  } finally {
    await queryRunner.release();
  }
}

/** Serializes retries of the same creation identity within the transaction. */
export async function lockIntent(queryRunner: QueryRunner, intent: string): Promise<void> {
  await queryRunner.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [intent]);
}

/** Requires an active workspace with no pending removal, owned by the requested user. */
async function requireActiveOwnedWorkspace(queryRunner: QueryRunner, ownerId: string, workspaceId: string) {
  const workspace = await lockProjectWriteState(queryRunner, ownerId, workspaceId);
  if (!workspace || workspace.status !== 'active' || workspace.removalPending) {
    throw new HomeConversationNotFoundError();
  }
  return workspace;
}

/** Public Home workspace conversations are limited to planning-only projects. */
export async function assertWorkspaceOwned(queryRunner: QueryRunner, ownerId: string, workspaceId: string): Promise<void> {
  const workspace = await requireActiveOwnedWorkspace(queryRunner, ownerId, workspaceId);
  if (workspace.relativeRoot !== null) throw new HomeConversationNotFoundError();
}

/** Trusted scheduler conversations may target any active, owned workspace. */
export async function assertScheduledWorkspaceOwned(queryRunner: QueryRunner, ownerId: string, workspaceId: string): Promise<void> {
  await requireActiveOwnedWorkspace(queryRunner, ownerId, workspaceId);
}

/** Locks and returns a conversation only when it belongs to the supplied owner. */
export async function lockConversation(queryRunner: QueryRunner, ownerId: string, conversationId: string): Promise<HomeConversationRow | null> {
  const rows: readonly HomeConversationRow[] = await queryRunner.query(
    `SELECT "id", "owner_id", "scope", "workspace_id", "title", "last_event_sequence", "last_activity_at", "created_at", "updated_at"
     FROM "home_conversations" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1 FOR UPDATE`,
    [ownerId, conversationId]
  );
  return rows[0] ?? null;
}

/** Rejects reuse of an idempotency key when the canonical request differs. */
export function assertRequestFingerprint(existing: string, requested: string, operation: 'conversation' | 'turn' | 'message'): void {
  if (existing !== requested) {
    throw new HomeRequestKeyReusedError(operation);
  }
}
