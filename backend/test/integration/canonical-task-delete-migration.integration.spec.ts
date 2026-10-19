import { randomUUID } from 'node:crypto';
import type { DataSource, QueryRunner } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { CanonicalTaskDelete1710000036000 } from '@/infrastructure/database/migrations/1710000036000-canonical-task-delete';

const databaseUrl = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;
if (databaseUrl) {
  const target = new URL(databaseUrl);
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !allowedHosts.has(target.hostname)
    || target.port !== '55441'
    || target.pathname !== '/home_history_test'
    || target.username !== 'home_test') {
    throw new Error('HOME_CONVERSATION_TEST_DATABASE_URL must target home_test/home_history_test on loopback port 55441.');
  }
}

const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('canonical task delete migration PostgreSQL integration', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;
  let schema: string;

  beforeAll(async () => {
    const configured = createDataSource({ url: databaseUrl ?? 'postgres://disabled:disabled@127.0.0.1:1/disabled' });
    dataSource = configured;
    await dataSource.initialize();
    queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    schema = `task_delete_${randomUUID().replace(/-/gu, '')}`;
    await queryRunner.query(`CREATE SCHEMA "${schema}"`);
    await queryRunner.query(`SET search_path TO "${schema}", public`);

    const taskDeleteMigrationName = new CanonicalTaskDelete1710000036000().name;
    for (const migration of dataSource.migrations) {
      if (migration.name === taskDeleteMigrationName) continue;
      await migration.up(queryRunner);
    }
  }, 120_000);

  afterAll(async () => {
    if (queryRunner?.isReleased === false) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      if (schema) await queryRunner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await queryRunner.release();
    }
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('preserves converted content, restores legacy mappings on rollback, and never resurrects a deleted task', async () => {
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    const overflowWorkspaceId = randomUUID();
    const openTaskId = randomUUID();
    const completedArchiveId = randomUUID();
    const openArchiveId = randomUUID();
    const overflowActiveTaskId = randomUUID();
    const overflowArchiveTaskId = randomUUID();
    const archiveReceiptId = randomUUID();
    const fixedCreatedAt = '2026-10-01T01:02:03.000Z';
    const fixedUpdatedAt = '2026-10-02T03:04:05.000Z';
    const fixedArchivedAt = '2026-10-02T02:03:04.000Z';
    const fixedCompletedAt = '2026-10-01T05:06:07.000Z';

    await queryRunner.query(
      'INSERT INTO "users" ("id", "scope_key", "identifier", "display_name", "password_hash") VALUES ($1, $2, $2, $3, $4)',
      [ownerId, `task-delete-migration-${ownerId}`, 'Task Delete Migration Test', 'test-only']
    );
    for (const [id, slug] of [[workspaceId, 'task-delete-main'], [overflowWorkspaceId, 'task-delete-overflow']] as const) {
      await queryRunner.query(
        `INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind")
         VALUES ($1, $2, $3, $4, NULL, NULL, NULL)`,
        [id, ownerId, slug, slug]
      );
    }
    await queryRunner.query(`
      INSERT INTO "project_tasks" (
        "id", "owner_id", "project_id", "title", "details", "status", "position", "version", "created_at", "updated_at",
        "completed_at", "archived_at", "importance", "deadline", "subtasks"
      ) VALUES
        ($1, $2, $3, 'Open task', 'keep this text', 'todo', 0, 1, $8, $9, NULL, NULL, 'medium', NULL, '[{"id":"list-a","title":"Check mapping","completed":true}]'::jsonb),
        ($4, $2, $3, 'Completed archive', 'completed content', 'archived', 0, 4, $8, $9, $10, $11, 'high', '2026-10-19', '[{"id":"list-b","title":"Keep checklist","completed":false}]'::jsonb),
        ($5, $2, $3, 'Open archive', 'open content', 'archived', 1, 2, $8, $9, NULL, $11, 'low', NULL, '[]'::jsonb),
        ($6, $2, $7, 'Overflow active', NULL, 'todo', 2147483647, 1, $8, $9, NULL, NULL, 'medium', NULL, '[]'::jsonb),
        ($7, $2, $7, 'Overflow archive', NULL, 'archived', 0, 1, $8, $9, NULL, $11, 'medium', NULL, '[]'::jsonb)
    `, [openTaskId, ownerId, workspaceId, completedArchiveId, openArchiveId, overflowActiveTaskId, overflowWorkspaceId,
      fixedCreatedAt, fixedUpdatedAt, fixedCompletedAt, fixedArchivedAt]);
    await queryRunner.query(`
      INSERT INTO "action_ledger_records" (
        "id", "owner_id", "operation_key", "request_fingerprint", "actor_kind", "target_kind", "target_id", "action_kind",
        "expected_version", "pre_version", "post_version", "reversible_fields", "outcome", "undo_status", "created_at"
      ) VALUES (
        $1, $2, 'legacy-archive-receipt', 'legacy-archive-fingerprint', 'manual', 'task', $3, 'task.archive',
        4, 4, 5,
        '{"status":{"before":"todo","after":"archived"},"archivedAt":{"before":null,"after":"2026-10-02T02:03:04.000Z"}}'::jsonb,
        jsonb_build_object('targetId', $4::text, 'targetVersion', 5, 'sourceOrderVersion', 2), 'available', $5
      )`, [archiveReceiptId, ownerId, completedArchiveId, completedArchiveId, fixedCreatedAt]);

    const migration = new CanonicalTaskDelete1710000036000();
    await expect(migration.up(queryRunner)).rejects.toThrow(/overflow an existing task, position, or collection version/u);
    const migrationMapBeforeConversion: readonly { count: string }[] = await queryRunner.query(
      `SELECT count(*)::text AS "count" FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'task_archive_migration_map'`, [schema]
    );
    expect(Number(migrationMapBeforeConversion[0]?.count)).toBe(0);

    await queryRunner.query('DELETE FROM "projects" WHERE "owner_id" = $1 AND "id" = $2', [ownerId, overflowWorkspaceId]);
    await migration.up(queryRunner);

    const converted: readonly { id: string; title: string; details: string | null; status: string; position: number; version: number; completed_at: Date | null; archived_at?: Date | null; importance: string; deadline: string | null; subtasks: unknown; updated_at: Date }[] = await queryRunner.query(
      `SELECT "id", "title", "details", "status", "position", "version", "completed_at", "importance", to_char("deadline", 'YYYY-MM-DD') AS "deadline", "subtasks", "updated_at"
       FROM "project_tasks" WHERE "owner_id" = $1 AND "project_id" = $2 ORDER BY "position"`, [ownerId, workspaceId]
    );
    expect(converted).toHaveLength(3);
    expect(converted.map(({ id, status, position, version }) => ({ id, status, position, version }))).toEqual([
      { id: openTaskId, status: 'todo', position: 0, version: 1 },
      { id: completedArchiveId, status: 'done', position: 1, version: 5 },
      { id: openArchiveId, status: 'todo', position: 2, version: 3 }
    ]);
    expect(converted[1]).toMatchObject({ details: 'completed content', importance: 'high', deadline: '2026-10-19', subtasks: [{ title: 'Keep checklist', completed: false }] });
    expect(converted[1]?.completed_at?.toISOString()).toBe(fixedCompletedAt);
    expect(converted[1]?.updated_at?.toISOString()).not.toBe(fixedUpdatedAt);

    const receipt: readonly { undo_status: string; reversible_fields: Record<string, unknown> }[] = await queryRunner.query(
      'SELECT "undo_status", "reversible_fields" FROM "action_ledger_records" WHERE "owner_id" = $1 AND "id" = $2', [ownerId, archiveReceiptId]
    );
    expect(receipt).toEqual([{ undo_status: 'not_reversible', reversible_fields: {} }]);
    const orderStateAfterUp: readonly { version: number }[] = await queryRunner.query(
      'SELECT "version" FROM "project_task_order_states" WHERE "owner_id" = $1 AND "project_id" = $2', [ownerId, workspaceId]
    );
    expect(orderStateAfterUp[0]?.version).toBe(2);

    await migration.down(queryRunner);
    const restored: readonly { id: string; status: string; position: number; version: number; archived_at: Date | null; completed_at: Date | null; updated_at: Date }[] = await queryRunner.query(
      `SELECT "id", "status", "position", "version", "archived_at", "completed_at", "updated_at"
       FROM "project_tasks" WHERE "owner_id" = $1 AND "project_id" = $2 ORDER BY "id"`, [ownerId, workspaceId]
    );
    expect(restored.find(({ id }) => id === completedArchiveId)).toMatchObject({
      status: 'archived', position: 0, version: 4, archived_at: new Date(fixedArchivedAt), completed_at: new Date(fixedCompletedAt), updated_at: new Date(fixedUpdatedAt)
    });
    expect(restored.find(({ id }) => id === openArchiveId)).toMatchObject({
      status: 'archived', position: 1, version: 2, archived_at: new Date(fixedArchivedAt), completed_at: null, updated_at: new Date(fixedUpdatedAt)
    });
    const restoredReceipt: readonly { undo_status: string; reversible_fields: Record<string, unknown> }[] = await queryRunner.query(
      'SELECT "undo_status", "reversible_fields" FROM "action_ledger_records" WHERE "owner_id" = $1 AND "id" = $2', [ownerId, archiveReceiptId]
    );
    expect(restoredReceipt[0]?.undo_status).toBe('available');
    expect(restoredReceipt[0]?.reversible_fields).toMatchObject({ status: { before: 'todo', after: 'archived' } });

    await migration.up(queryRunner);
    await queryRunner.query('DELETE FROM "project_tasks" WHERE "owner_id" = $1 AND "id" = $2', [ownerId, completedArchiveId]);
    await expect(migration.down(queryRunner)).rejects.toThrow(/delete receipt or a changed converted task/u);
    const noResurrection: readonly { task_count: string; mapping_count: string }[] = await queryRunner.query(`
      SELECT
        (SELECT count(*)::text FROM "project_tasks" WHERE "owner_id" = $1 AND "id" = $2) AS "task_count",
        (SELECT count(*)::text FROM "task_archive_migration_map" WHERE "owner_id" = $1 AND "task_id" = $2) AS "mapping_count"
    `, [ownerId, completedArchiveId]);
    expect(noResurrection).toEqual([{ task_count: '0', mapping_count: '1' }]);
  });
});
