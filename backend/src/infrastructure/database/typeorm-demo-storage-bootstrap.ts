import type { DataSource } from 'typeorm';

import type { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import type { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { DemoAdmissionUnavailableError } from '@/modules/demo/domain/demo-admission-errors';
import type { IDemoStorageBootstrap } from '@/modules/demo/domain/demo-admission-types';

interface BootstrapCheckRow {
  readonly eligible: boolean;
  readonly has_persisted_state: boolean;
}

function rows<T>(value: unknown): readonly T[] {
  if (!Array.isArray(value)) throw new Error('The demo storage bootstrap query returned an unexpected result.');
  if (value.length === 2 && Array.isArray(value[0]) && typeof value[1] === 'number') return value[0] as readonly T[];
  return value as readonly T[];
}

/** Initializes only the provably empty account created by its pending admission row. */
export class TypeOrmDemoStorageBootstrap implements IDemoStorageBootstrap {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly contentAccounting: TypeOrmStorageContentAccounting,
    private readonly quotaRepository: TypeOrmStorageQuotaRepository
  ) {}

  public async initializeEmptyAccount(admissionId: string, ownerId: string): Promise<void> {
    const checks = rows<BootstrapCheckRow>(await this.dataSource.query(`
      SELECT EXISTS (
        SELECT 1 FROM "demo_admissions" a JOIN "users" u ON u."id" = a."owner_id"
        WHERE a."id" = $1 AND a."owner_id" = $2 AND a."status" = 'pending'
          AND u."account_kind" = 'demo' AND u."is_active" = true
          AND u."expires_at" > clock_timestamp()
      ) AS "eligible",
      (
        EXISTS (SELECT 1 FROM "projects" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "storage_root_mappings" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "storage_resource_references" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "storage_filesystem_reservations" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "project_removal_jobs" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "conversations" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "ai_runs" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "sandbox_commands" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "project_facts" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "project_tasks" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "project_task_suggestions" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "action_ledger_records" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "home_conversations" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "home_messages" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "home_conversation_events" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "home_change_proposals" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "home_change_proposal_items" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "credit_account_totals" WHERE "owner_id" = $2 AND ("settled_units" <> 0 OR "reserved_units" <> 0))
        OR EXISTS (SELECT 1 FROM "credit_provider_call_reservations" WHERE "owner_id" = $2)
        OR EXISTS (SELECT 1 FROM "credit_usage_entries" WHERE "owner_id" = $2)
      ) AS "has_persisted_state"
    `, [admissionId, ownerId]))[0];
    if (!checks?.eligible || checks.has_persisted_state) throw new DemoAdmissionUnavailableError();

    const contentReferences = await this.contentAccounting.scanDatabaseContent(this.dataSource, ownerId);
    if (contentReferences.length > 0) throw new DemoAdmissionUnavailableError();

    await this.quotaRepository.reconcileReferences(ownerId, []);
    const usage = await this.quotaRepository.readUsage(ownerId);
    if (usage.state !== 'ready' || usage.usedBytes !== 0n || usage.reservedBytes !== 0n) {
      throw new DemoAdmissionUnavailableError();
    }
  }
}
