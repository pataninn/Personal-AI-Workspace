import type { DataSource } from 'typeorm';

import type { AssistantScopePolicy, AssistantScopePolicyScope } from '@/modules/assistant-policy/domain/assistant-scope-policy';
import type { IAssistantScopePolicyRepository } from '@/modules/assistant-policy/repositories/assistant-scope-policy-repository';

interface AssistantScopePolicyRow {
  readonly id: string;
  readonly owner_id: string;
  readonly scope_kind: 'home' | 'project';
  readonly project_id: string | null;
  readonly policy_profile: 'home_in_scope_v1' | 'workspace_in_scope_v1';
  readonly provider_profile: string | null;
  readonly model: string | null;
  readonly enabled: boolean;
  readonly revoked_at: Date | string | null;
  readonly revision: string | number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

export class TypeOrmAssistantScopePolicyRepository implements IAssistantScopePolicyRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async find(scope: AssistantScopePolicyScope): Promise<AssistantScopePolicy | null> {
    const rows: readonly AssistantScopePolicyRow[] = await this.dataSource.query(
      `SELECT * FROM "assistant_scope_policies"
       WHERE "owner_id" = $1 AND "scope_kind" = $2
         AND (("scope_kind" = 'home' AND "project_id" IS NULL)
           OR ("scope_kind" = 'project' AND "project_id" = $3))
       LIMIT 1`,
      [scope.ownerId, scope.scopeKind, scope.projectId]
    );
    return rows[0] ? toPolicy(rows[0]) : null;
  }

  /**
   * Trusted startup/config-sync boundary. It updates the singleton used by insert triggers and
   * fills only still-null pairs on enabled, unrevoked policies; prior non-null grants stay pinned.
   */
  public async synchronizeProviderConfiguration(input: { readonly providerProfile: string | null; readonly model: string | null }): Promise<void> {
    const configured = input.providerProfile?.trim() && input.model?.trim()
      ? { providerProfile: input.providerProfile, model: input.model }
      : null;
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE "assistant_policy_provider_configuration"
         SET "provider_profile" = $1, "model" = $2, "updated_at" = clock_timestamp()
         WHERE "singleton_id" = true`,
        [configured?.providerProfile ?? null, configured?.model ?? null]
      );
      if (!configured) return;
      await manager.query(
        `UPDATE "assistant_scope_policies"
         SET "provider_profile" = $1, "model" = $2, "revision" = "revision" + 1, "updated_at" = clock_timestamp()
         WHERE "enabled" = true AND "revoked_at" IS NULL
           AND "provider_profile" IS NULL AND "model" IS NULL`,
        [configured.providerProfile, configured.model]
      );
    });
  }

  /** Trusted configuration sync may initialize only an unconfigured, active policy row. */
  public async fillConfiguredProvider(input: {
    readonly scope: AssistantScopePolicyScope;
    readonly providerProfile: string;
    readonly model: string;
  }): Promise<AssistantScopePolicy | null> {
    if (input.providerProfile.trim().length === 0 || input.model.trim().length === 0) return null;
    const result: unknown = await this.dataSource.query(
      `UPDATE "assistant_scope_policies"
       SET "provider_profile" = $4, "model" = $5, "revision" = "revision" + 1, "updated_at" = clock_timestamp()
       WHERE "owner_id" = $1 AND "scope_kind" = $2
         AND (("scope_kind" = 'home' AND "project_id" IS NULL)
           OR ("scope_kind" = 'project' AND "project_id" = $3))
         AND "enabled" = true AND "revoked_at" IS NULL
         AND "provider_profile" IS NULL AND "model" IS NULL
       RETURNING *`,
      [input.scope.ownerId, input.scope.scopeKind, input.scope.projectId, input.providerProfile, input.model]
    );
    const rows = rowsFromReturningQuery<AssistantScopePolicyRow>(result);
    if (rows[0]) return toPolicy(rows[0]);
    const current = await this.find(input.scope);
    if (current?.enabled && current.revokedAt === null
      && current.providerProfile === input.providerProfile && current.model === input.model) return current;
    return null;
  }

  /** Repeated revocation is idempotent and can never revive or widen a policy. */
  public async revoke(scope: AssistantScopePolicyScope): Promise<AssistantScopePolicy | null> {
    const result: unknown = await this.dataSource.query(
      `UPDATE "assistant_scope_policies"
       SET "enabled" = false,
           "revoked_at" = COALESCE("revoked_at", clock_timestamp()),
           "revision" = CASE WHEN "enabled" THEN "revision" + 1 ELSE "revision" END,
           "updated_at" = CASE WHEN "enabled" THEN clock_timestamp() ELSE "updated_at" END
       WHERE "owner_id" = $1 AND "scope_kind" = $2
         AND (("scope_kind" = 'home' AND "project_id" IS NULL)
           OR ("scope_kind" = 'project' AND "project_id" = $3))
       RETURNING *`,
      [scope.ownerId, scope.scopeKind, scope.projectId]
    );
    const rows = rowsFromReturningQuery<AssistantScopePolicyRow>(result);
    return rows[0] ? toPolicy(rows[0]) : this.find(scope);
  }
}

function toPolicy(row: AssistantScopePolicyRow): AssistantScopePolicy {
  return {
    id: row.id,
    ownerId: row.owner_id,
    scopeKind: row.scope_kind,
    projectId: row.project_id,
    policyProfile: row.policy_profile,
    providerProfile: row.provider_profile,
    model: row.model,
    enabled: row.enabled,
    revokedAt: row.revoked_at === null ? null : toDate(row.revoked_at),
    revision: String(row.revision),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function rowsFromReturningQuery<T>(result: unknown): readonly T[] {
  if (!Array.isArray(result)) return [];
  const records = result[0];
  return Array.isArray(records) ? records as readonly T[] : result as readonly T[];
}
