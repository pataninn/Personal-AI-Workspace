import type { DataSource, QueryRunner } from 'typeorm';

import { PROVIDER_PERMISSION_CAPABILITY, type ProviderPermission, type ProviderPermissionScope } from '@/modules/ai-runs/domain/provider-permission';
import type { IProviderPermissionRepository } from '@/modules/ai-runs/repositories/provider-permission-repository';

interface ProviderPermissionRow {
  readonly id: string;
  readonly owner_id: string;
  readonly project_id: string;
  readonly provider_profile: string;
  readonly model: string;
  readonly capability: typeof PROVIDER_PERMISSION_CAPABILITY;
  readonly created_at: Date | string;
  readonly expires_at: Date | string | null;
  readonly revoked_at: Date | string | null;
}

export class TypeOrmProviderPermissionRepository implements IProviderPermissionRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async findActive(scope: ProviderPermissionScope): Promise<ProviderPermission | null> {
    const rows: readonly ProviderPermissionRow[] = await this.dataSource.query(
      `SELECT * FROM "provider_permissions"
       WHERE "owner_id" = $1 AND "project_id" = $2 AND "provider_profile" = $3 AND "model" = $4
         AND "capability" = $5 AND "revoked_at" IS NULL AND ("expires_at" IS NULL OR "expires_at" > now())
       ORDER BY "created_at" DESC LIMIT 1`,
      [scope.ownerId, scope.projectId, scope.providerProfile, scope.model, PROVIDER_PERMISSION_CAPABILITY]
    );
    return rows[0] ? toPermission(rows[0]) : null;
  }

  public async findActiveById(input: { readonly ownerId: string; readonly projectId: string; readonly permissionId: string }): Promise<ProviderPermission | null> {
    const rows: readonly ProviderPermissionRow[] = await this.dataSource.query(
      `SELECT * FROM "provider_permissions"
       WHERE "owner_id" = $1 AND "project_id" = $2 AND "id" = $3 AND "revoked_at" IS NULL
         AND ("expires_at" IS NULL OR "expires_at" > now()) LIMIT 1`,
      [input.ownerId, input.projectId, input.permissionId]
    );
    return rows[0] ? toPermission(rows[0]) : null;
  }

  public async listForProjectOwner(input: { readonly ownerId: string; readonly projectId: string }): Promise<readonly ProviderPermission[]> {
    const rows: readonly ProviderPermissionRow[] = await this.dataSource.query(
      `SELECT * FROM "provider_permissions" WHERE "owner_id" = $1 AND "project_id" = $2
       ORDER BY "created_at" DESC, "id" ASC LIMIT 100`,
      [input.ownerId, input.projectId]
    );
    return rows.map(toPermission);
  }

  public async grant(scope: ProviderPermissionScope): Promise<ProviderPermission> {
    const rows: readonly ProviderPermissionRow[] = await this.dataSource.query(
      `INSERT INTO "provider_permissions" ("owner_id", "project_id", "provider_profile", "model", "capability")
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ("owner_id", "project_id", "provider_profile", "model", "capability")
         WHERE "revoked_at" IS NULL DO NOTHING
       RETURNING *`,
      [scope.ownerId, scope.projectId, scope.providerProfile, scope.model, PROVIDER_PERMISSION_CAPABILITY]
    );
    const created = rows[0];
    if (created) return toPermission(created);
    const active = await this.findActive(scope);
    if (!active) throw new Error('The provider permission could not be saved.');
    return active;
  }

  public async revoke(input: { readonly ownerId: string; readonly projectId: string; readonly permissionId: string }): Promise<ProviderPermission | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const rows: readonly ProviderPermissionRow[] = await queryRunner.query(
        `SELECT * FROM "provider_permissions" WHERE "owner_id" = $1 AND "project_id" = $2 AND "id" = $3 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.projectId, input.permissionId]
      );
      const row = rows[0];
      if (!row) {
        await queryRunner.commitTransaction();
        return null;
      }
      if (row.revoked_at === null) {
        const revokedRows: readonly ProviderPermissionRow[] = await queryRunner.query(
          `UPDATE "provider_permissions" SET "revoked_at" = now(), "updated_at" = now()
           WHERE "owner_id" = $1 AND "project_id" = $2 AND "id" = $3 AND "revoked_at" IS NULL RETURNING *`,
          [input.ownerId, input.projectId, input.permissionId]
        );
        const revoked = revokedRows[0];
        if (!revoked) throw new Error('The provider permission could not be revoked.');
        await reopenUnstartedRuns(queryRunner, input.ownerId, input.projectId, input.permissionId);
        await queryRunner.commitTransaction();
        return toPermission(revoked);
      }
      await queryRunner.commitTransaction();
      return toPermission(row);
    } catch (error: unknown) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}

async function reopenUnstartedRuns(queryRunner: QueryRunner, ownerId: string, projectId: string, permissionId: string): Promise<void> {
  await queryRunner.query(
    `UPDATE "ai_runs" SET "status" = 'pending_approval', "phase" = 'decision', "decision" = 'pending',
       "provider_permission_id" = NULL, "decision_idempotency_key" = NULL, "decision_fingerprint" = NULL,
       "start_idempotency_key" = NULL, "start_fingerprint" = NULL,
       "runtime_kind" = NULL, "sandbox_ready" = false, "runtime_reference" = NULL, "staging_item_count" = 0,
       "safe_message" = 'The saved provider permission was revoked. Review this context before continuing.', "updated_at" = now()
     WHERE "owner_id" = $1 AND "project_id" = $2 AND "provider_permission_id" = $3
       AND "status" IN ('ready', 'queued') AND "provider_transmission" = 'not_started_confirmed'`,
    [ownerId, projectId, permissionId]
  );
}

function toPermission(row: ProviderPermissionRow): ProviderPermission {
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    providerProfile: row.provider_profile,
    model: row.model,
    capability: row.capability,
    createdAt: toDate(row.created_at),
    expiresAt: null,
    revokedAt: row.revoked_at === null ? null : toDate(row.revoked_at)
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
