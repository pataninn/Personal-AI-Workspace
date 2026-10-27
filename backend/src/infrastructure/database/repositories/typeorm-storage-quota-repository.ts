import type { DataSource, QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';

import {
  accountingUnavailable,
  fileStateChanged,
  operationConflict,
  reconciliationPending
} from '@/modules/storage-quotas/domain/storage-quota-errors';
import {
  assertByteCount,
  assertStorageAdmission,
  positivePart,
  referenceDelta
} from '@/modules/storage-quotas/domain/storage-quota-policy';
import { storageFileOperationFingerprint } from '@/modules/storage-quotas/domain/storage-file-operation-fingerprint';
import type {
  StorageAccountingState,
  StorageFileOperationCommand,
  StorageFileOperationReservation,
  StorageFileReferencePlan,
  StorageResourceReference,
  StorageResourceReferenceChange,
  StorageUnresolvedFileOperation,
  StorageUsageSnapshot,
  StorageTrustedFileScope,
  StorageVerifiedFileChange
} from '@/modules/storage-quotas/domain/storage-quota-types';
import type {
  IStorageQuotaRepository,
  StorageDatabaseMutationResult,
  StorageTrustedFileScopeResolver,
  StorageQuotaTransaction
} from '@/modules/storage-quotas/repositories/storage-quota-repository';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import { projectRootOverlapKey } from '@/modules/projects/domain/project-root-policy';

interface AccountRow {
  storage_limit_bytes: string | null;
}

interface TotalsRow {
  used_bytes: string;
  reserved_bytes: string;
  accounting_state: StorageAccountingState;
  updated_at: Date | string;
}

interface ReferenceRow {
  byte_count: string;
  sha256: string | null;
}

interface ReservationRow {
  id: string;
  fingerprint: string;
  status: 'pending' | 'unknown' | 'settled' | 'released';
  reserved_growth_bytes: string;
  reference_changes: readonly StoredFileChange[];
  outcome: readonly StorageVerifiedFileChange[] | string | null;
}

interface NormalizedReservationRow extends Omit<ReservationRow, 'outcome'> {
  outcome: readonly StorageVerifiedFileChange[] | null;
}

interface StoredFileChange extends Omit<StorageFileReferencePlan, 'expectedPriorBytes' | 'intendedBytes'> {
  readonly expectedPriorBytes: string | null;
  readonly intendedBytes: string | null;
}

interface LockedAccount {
  readonly limitBytes: bigint | null;
  readonly usedBytes: bigint;
  readonly reservedBytes: bigint;
  readonly state: StorageAccountingState;
}

const MAX_BIGINT = 9_223_372_036_854_775_807n;

/** Serializes owner-scoped root allocation changes after the account_limits row lock. */
export async function lockStorageRootOwner(transaction: StorageQuotaTransaction, ownerId: string): Promise<void> {
  await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`projects:${ownerId}`]);
}

/** Storage accounting adapter. Callers pass their open transaction for relational mutations. */
export class TypeOrmStorageQuotaRepository implements IStorageQuotaRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async readUsage(ownerId: string): Promise<StorageUsageSnapshot> {
    const rows = await this.dataSource.query(
      `SELECT l."storage_limit_bytes", t."used_bytes", t."reserved_bytes", t."accounting_state", t."updated_at"
       FROM "account_limits" l LEFT JOIN "storage_account_totals" t ON t."owner_id" = l."owner_id"
       WHERE l."owner_id" = $1`,
      [ownerId]
    ) as (AccountRow & Partial<TotalsRow>)[];
    const row = rows[0];
    if (!row) throw accountingUnavailable();

    const limitBytes = toBigIntOrNull(row.storage_limit_bytes);
    const state = row.accounting_state ?? 'reconciling';
    if (state !== 'ready' || row.used_bytes === undefined || row.reserved_bytes === undefined) {
      return { state, usedBytes: null, reservedBytes: null, limitBytes, availableBytes: null, overLimit: null, asOf: null };
    }

    const usedBytes = BigInt(row.used_bytes);
    const reservedBytes = BigInt(row.reserved_bytes);
    const availableBytes = limitBytes === null ? null : maxZero(limitBytes - usedBytes - reservedBytes);
    return {
      state,
      usedBytes,
      reservedBytes,
      limitBytes,
      availableBytes,
      overLimit: limitBytes !== null && usedBytes + reservedBytes > limitBytes,
      asOf: toDate(row.updated_at)
    };
  }

  public async runDatabaseMutation<T>(
    transaction: StorageQuotaTransaction,
    input: { readonly ownerId: string; readonly maximumGrowthBytes: bigint },
    mutate: () => Promise<StorageDatabaseMutationResult<T>>,
    options?: { readonly beforeReferences?: () => Promise<void> }
  ): Promise<T> {
    assertByteCount(input.maximumGrowthBytes, 'maximum growth bytes');
    await this.lockActivePrincipal(transaction, input.ownerId);
    const account = await this.lockAccount(transaction, input.ownerId);
    if (account.state !== 'ready') throw accountingUnavailable();
    const savepoint = `storage_quota_${randomUUID().replaceAll('-', '')}`;
    await transaction.query(`SAVEPOINT "${savepoint}"`);
    try {
      await options?.beforeReferences?.();
      const mutation = await mutate();
      assertUniqueReferences(mutation.references.map((change) => change.reference));
      const totalDelta = await this.measureDatabaseReferenceDelta(transaction, input.ownerId, mutation.references);
      const requestedGrowthBytes = positivePart(totalDelta);
      if (requestedGrowthBytes > input.maximumGrowthBytes) throw accountingUnavailable();
      assertStorageAdmission({ ...account, requestedGrowthBytes });
      const nextUsed = account.usedBytes + totalDelta;
      assertCounter(nextUsed);
      await this.persistDatabaseReferenceChanges(transaction, input.ownerId, nextUsed, mutation.references);
      await transaction.query(`RELEASE SAVEPOINT "${savepoint}"`);
      return mutation.result;
    } catch (error: unknown) {
      await transaction.query(`ROLLBACK TO SAVEPOINT "${savepoint}"`);
      await transaction.query(`RELEASE SAVEPOINT "${savepoint}"`);
      throw error;
    }
  }

  public async reserveFileOperation(
    command: StorageFileOperationCommand,
    resolveTrustedScope: StorageTrustedFileScopeResolver
  ): Promise<StorageFileOperationReservation> {
    validateFileCommand(command);
    return this.inTransaction(async (transaction) => {
      await this.lockActivePrincipal(transaction, command.ownerId);
      const account = await this.lockAccount(transaction, command.ownerId);
      if (account.state !== 'ready') throw accountingUnavailable();
      await lockStorageRootOwner(transaction, command.ownerId);

      const existingRows = await queryRows<ReservationRow>(transaction,
        `SELECT "id", "fingerprint", "status", "reserved_growth_bytes", "reference_changes", "outcome"
         FROM "storage_filesystem_reservations" WHERE "owner_id" = $1 AND "operation_key" = $2`,
        [command.ownerId, command.operationKey]);
      const existing = existingRows[0];
      if (existing) {
        if (existing.fingerprint !== command.fingerprint) throw operationConflict();
        return reservationResult(existing, true);
      }

      let delta = 0n;
      for (const change of command.changes) {
        const current = await this.getReference(transaction, referenceFromPlan(command.ownerId, change));
        if ((current?.bytes ?? null) !== change.expectedPriorBytes || (current?.sha256 ?? null) !== change.expectedPriorSha256) {
          throw fileStateChanged();
        }
        delta += referenceDelta(current?.bytes ?? null, change.intendedBytes);
      }
      const reservedGrowthBytes = positivePart(delta);
      const trustedScope = await resolveTrustedScope(transaction, {
        ownerId: command.ownerId,
        projectId: command.projectId,
        rootKeys: [command.rootKey]
      });
      assertTrustedScope(command, trustedScope);
      assertStorageAdmission({ ...account, requestedGrowthBytes: reservedGrowthBytes });

      const activeRows = await queryRows<{ resource_kind: string; resource_key: string; copy_key: string }>(transaction,
        `SELECT "resource_kind", "resource_key", "copy_key" FROM "storage_filesystem_reservation_references"
         WHERE "owner_id" = $1 FOR UPDATE`, [command.ownerId]);
      const activeKeys = new Set(activeRows.map((row) => `${row.resource_kind}\u0000${row.resource_key}\u0000${row.copy_key}`));
      if (command.changes.some((change) => activeKeys.has(`${change.kind}\u0000${change.resourceKey}\u0000${change.copyKey}`))) {
        throw fileStateChanged();
      }

      const target = command.changes.find((change) => change.rootKey === command.rootKey && change.relativeKey === command.targetKey);
      if (!target) throw new TypeError('The target path must be included in the file operation reference changes.');
      const anticipatedRecoveryBytes = command.changes.reduce((sum, change) => {
        if (change.kind !== 'recovery_file' || change.intendedBytes === null) return sum;
        return sum + positivePart(change.intendedBytes - (change.expectedPriorBytes ?? 0n));
      }, 0n);
      assertCounter(anticipatedRecoveryBytes);
      const storedChanges = command.changes.map(toStoredChange);
      const rows = await queryRows<{ id: string }>(transaction,
        `INSERT INTO "storage_filesystem_reservations" (
           "owner_id", "project_id", "operation_key", "fingerprint", "root_key", "target_key",
           "expected_prior_sha256", "expected_prior_size_bytes", "intended_sha256", "intended_size_bytes",
           "anticipated_recovery_bytes", "reserved_growth_bytes", "reference_changes", "status"
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, 'pending')
         RETURNING "id"`,
        [
          command.ownerId, command.projectId, command.operationKey, command.fingerprint, command.rootKey, command.targetKey,
          target.expectedPriorSha256, target.expectedPriorBytes?.toString() ?? null,
          target.intendedSha256, target.intendedBytes?.toString() ?? null,
          anticipatedRecoveryBytes.toString(), reservedGrowthBytes.toString(), JSON.stringify(storedChanges)
        ]);
      const operationId = rows[0]?.id;
      if (!operationId) throw accountingUnavailable();
      for (const change of command.changes) {
        await transaction.query(
          `INSERT INTO "storage_filesystem_reservation_references" ("owner_id", "resource_kind", "resource_key", "copy_key", "reservation_id")
           VALUES ($1, $2, $3, $4, $5)`,
          [command.ownerId, change.kind, change.resourceKey, change.copyKey, operationId]
        );
      }
      await transaction.query(
        `UPDATE "storage_account_totals" SET "reserved_bytes" = "reserved_bytes" + $2, "updated_at" = clock_timestamp()
         WHERE "owner_id" = $1`,
        [command.ownerId, reservedGrowthBytes.toString()]
      );
      return { operationId, state: 'reserved', outcome: null, replay: false, trustedScope };
    });
  }

  public async listUnresolvedFileOperations(ownerId: string): Promise<readonly StorageUnresolvedFileOperation[]> {
    const rows = await this.dataSource.query(
      `SELECT "id", "owner_id", "project_id", "operation_key", "fingerprint", "root_key", "target_key",
              "reserved_growth_bytes", "reference_changes", "status"
       FROM "storage_filesystem_reservations"
       WHERE "owner_id" = $1 AND "status" IN ('pending', 'unknown')
       ORDER BY "created_at" ASC, "id" ASC`,
      [ownerId]
    ) as {
      id: string;
      owner_id: string;
      project_id: string | null;
      operation_key: string;
      fingerprint: string;
      root_key: string;
      target_key: string;
      reserved_growth_bytes: string;
      reference_changes: readonly StoredFileChange[] | string;
      status: 'pending' | 'unknown';
    }[];
    return rows.map((row) => ({
      operationId: row.id,
      state: row.status,
      reservedGrowthBytes: BigInt(row.reserved_growth_bytes),
      command: {
        ownerId: row.owner_id,
        operationKey: row.operation_key,
        fingerprint: row.fingerprint,
        projectId: row.project_id,
        rootKey: row.root_key,
        targetKey: row.target_key,
        changes: parseStoredChanges(row.reference_changes)
      }
    }));
  }

  public async settleFileOperation(
    ownerId: string,
    operationId: string,
    actualChanges: readonly StorageVerifiedFileChange[]
  ): Promise<StorageFileOperationReservation> {
    const result = await this.inTransaction(async (transaction) => {
      const account = await this.lockAccount(transaction, ownerId);
      const reservation = await this.lockReservation(transaction, ownerId, operationId);
      if (reservation.status === 'settled' || reservation.status === 'released') return reservationResult(reservation, true);
      const observed = [...actualChanges];
      const knownLocations = changeLocationsMatch(reservation.reference_changes, actualChanges);
      let delta = 0n;
      if (knownLocations) {
        for (const change of actualChanges) {
          const current = await this.getReference(transaction, verifiedReference(ownerId, change));
          delta += referenceDelta(current?.bytes ?? null, change.bytes);
        }
      }
      const reservedGrowthBytes = BigInt(reservation.reserved_growth_bytes);
      if (!knownLocations) {
        await transaction.query(
          `UPDATE "storage_account_totals" SET "accounting_state" = 'unavailable', "updated_at" = clock_timestamp() WHERE "owner_id" = $1`,
          [ownerId]
        );
        await transaction.query(
          `UPDATE "storage_filesystem_reservations" SET "status" = 'unknown', "observed_changes" = $3::jsonb,
             "updated_at" = clock_timestamp() WHERE "owner_id" = $1 AND "id" = $2`,
          [ownerId, operationId, JSON.stringify(observed.map(toJsonVerifiedChange))]
        );
        return { pending: true as const };
      }

      const nextUsed = account.usedBytes + delta;
      const nextReserved = account.reservedBytes - reservedGrowthBytes;
      if (nextUsed < 0n || nextUsed > MAX_BIGINT || nextReserved < 0n) {
        await transaction.query(
          `UPDATE "storage_account_totals" SET "accounting_state" = 'unavailable', "updated_at" = clock_timestamp() WHERE "owner_id" = $1`,
          [ownerId]
        );
        await transaction.query(
          `UPDATE "storage_filesystem_reservations" SET "status" = 'unknown', "observed_changes" = $3::jsonb,
             "updated_at" = clock_timestamp() WHERE "owner_id" = $1 AND "id" = $2`,
          [ownerId, operationId, JSON.stringify(observed.map(toJsonVerifiedChange))]
        );
        return { pending: true as const };
      }

      for (const change of actualChanges) {
        const ref = verifiedReference(ownerId, change);
        await this.writeReference(transaction, {
          reference: ref,
          nextBytes: change.bytes,
          nextSha256: change.sha256
        });
      }
      // A filesystem error can still leave a fully observable state that differs from the
      // intended result (for example, a claim conflict after a recovery copy was written).
      // Settle that exact state when its locations are known and its positive net growth was
      // reserved; only growth beyond the durable reservation needs reconciliation.
      const unexpected = positivePart(delta) > reservedGrowthBytes;
      await transaction.query(
        `UPDATE "storage_account_totals" SET "used_bytes" = $2, "reserved_bytes" = $3,
           "accounting_state" = CASE WHEN $4 THEN 'unavailable' ELSE "accounting_state" END,
           "updated_at" = clock_timestamp()
         WHERE "owner_id" = $1`,
        [ownerId, nextUsed.toString(), nextReserved.toString(), unexpected]
      );
      await transaction.query(
        `UPDATE "storage_filesystem_reservations" SET "status" = 'settled', "outcome" = $3::jsonb,
           "observed_changes" = $3::jsonb, "reserved_growth_bytes" = 0, "updated_at" = clock_timestamp()
         WHERE "owner_id" = $1 AND "id" = $2`,
        [ownerId, operationId, JSON.stringify(observed.map(toJsonVerifiedChange))]
      );
      await transaction.query('DELETE FROM "storage_filesystem_reservation_references" WHERE "reservation_id" = $1', [operationId]);
      if (unexpected) return { pending: true as const };
      return { settled: true as const, reservation: { ...reservation, status: 'settled' as const, outcome: observed } };
    });
    if ('pending' in result) throw reconciliationPending(operationId);
    if ('settled' in result) return { operationId, state: 'settled', outcome: result.reservation.outcome, replay: false };
    return { ...result, operationId };
  }

  /** Releases recovery-copy charges only after the caller has verified their physical purge. */
  public async releaseRecoveryReferencesAfterVerifiedPurge(
    ownerId: string,
    projectId: string,
    runIds: readonly string[]
  ): Promise<void> {
    const uniqueRunIds = [...new Set(runIds)];
    if (uniqueRunIds.length !== runIds.length) throw new TypeError('Recovery run identifiers must be unique.');
    if (uniqueRunIds.length === 0) return;
    let inconsistent = false;
    await this.inTransaction(async (transaction) => {
      await this.lockExistingPrincipal(transaction, ownerId);
      const account = await this.lockAccount(transaction, ownerId);
      await lockStorageRootOwner(transaction, ownerId);
      const unresolved = await queryRows<{ readonly id: string }>(transaction,
        `SELECT "id" FROM "storage_filesystem_reservations"
         WHERE "owner_id" = $1 AND "project_id" = $2 AND "status" IN ('pending', 'unknown') FOR UPDATE`,
        [ownerId, projectId]);
      if (unresolved.length > 0) throw accountingUnavailable();

      const references = await queryRows<{ readonly byte_count: string }>(transaction,
        `SELECT "byte_count" FROM "storage_resource_references"
         WHERE "owner_id" = $1 AND "project_id" = $2 AND "resource_kind" = 'recovery_file'
           AND "root_key" = 'recovery-v1' AND "resource_key" = ANY($3::text[])
         FOR UPDATE`,
        [ownerId, projectId, uniqueRunIds]);
      const releasedBytes = references.reduce((sum, reference) => sum + BigInt(reference.byte_count), 0n);
      if (releasedBytes > account.usedBytes) {
        await transaction.query(
          `UPDATE "storage_account_totals" SET "accounting_state" = 'unavailable', "updated_at" = clock_timestamp()
           WHERE "owner_id" = $1`, [ownerId]);
        inconsistent = true;
        return;
      }
      await transaction.query(
        `DELETE FROM "storage_resource_references"
         WHERE "owner_id" = $1 AND "project_id" = $2 AND "resource_kind" = 'recovery_file'
           AND "root_key" = 'recovery-v1' AND "resource_key" = ANY($3::text[])`,
        [ownerId, projectId, uniqueRunIds]);
      await transaction.query(
        `UPDATE "storage_account_totals" SET "used_bytes" = $2, "updated_at" = clock_timestamp()
         WHERE "owner_id" = $1`,
        [ownerId, (account.usedBytes - releasedBytes).toString()]);
    });
    if (inconsistent) throw accountingUnavailable();
  }

  /** Releases only a manifested managed root's file charges after demo maintenance verifies its purge. */
  public async releaseDemoProjectReferencesAfterVerifiedPurge(
    ownerId: string,
    rootKey: string,
    admissionId: string,
    generation: string,
    leaseToken: string
  ): Promise<void> {
    await this.inTransaction(async (transaction) => {
      const account = await this.lockAccount(transaction, ownerId);
      if (account.state !== 'ready') throw accountingUnavailable();
      await lockStorageRootOwner(transaction, ownerId);
      const cleanup = await queryRows<{ readonly generation: string }>(transaction,
        `SELECT c."generation" FROM "demo_expiry_cleanups" c
         JOIN "demo_admissions" a ON a."id"=c."admission_id"
         WHERE c."admission_id"=$1 AND c."generation"=$2 AND c."lease_token"=$3
           AND c."lease_expires_at">clock_timestamp() AND c."phase"='purging' AND a."owner_id"=$4
         FOR UPDATE OF c, a`, [admissionId, generation, leaseToken, ownerId]);
      if (!cleanup[0]) throw accountingUnavailable();
      const unresolved = await queryRows<{ readonly id: string }>(transaction,
        `SELECT "id" FROM "storage_filesystem_reservations"
         WHERE "owner_id"=$1 AND "root_key"=$2 AND "status" IN ('pending','unknown') FOR UPDATE`, [ownerId, rootKey]);
      if (unresolved.length > 0) throw accountingUnavailable();
      const references = await queryRows<{ readonly byte_count: string }>(transaction,
        `SELECT "byte_count" FROM "storage_resource_references"
         WHERE "owner_id"=$1 AND "root_key"=$2 AND "resource_kind" IN ('project_file','retained_root') FOR UPDATE`, [ownerId, rootKey]);
      const releasedBytes = references.reduce((sum, reference) => sum + BigInt(reference.byte_count), 0n);
      if (releasedBytes > account.usedBytes) throw accountingUnavailable();
      await transaction.query(
        `DELETE FROM "storage_resource_references"
         WHERE "owner_id"=$1 AND "root_key"=$2 AND "resource_kind" IN ('project_file','retained_root')`, [ownerId, rootKey]);
      await transaction.query(
        `UPDATE "storage_account_totals" SET "used_bytes"=$2, "updated_at"=clock_timestamp() WHERE "owner_id"=$1`,
        [ownerId, (account.usedBytes - releasedBytes).toString()]);
    });
  }

  /** Detaches one exact project only after this demo cleanup generation owns the purge phase. */
  public async retireDemoProjectRoot(
    ownerId: string,
    projectId: string,
    rootKey: string | null,
    admissionId: string,
    generation: string,
    leaseToken: string
  ): Promise<void> {
    await this.inTransaction(async (transaction) => {
      const account = await this.lockAccount(transaction, ownerId);
      if (account.state !== 'ready') throw accountingUnavailable();
      await lockStorageRootOwner(transaction, ownerId);
      const cleanup = await queryRows<{ readonly generation: string }>(transaction,
        `SELECT c."generation" FROM "demo_expiry_cleanups" c JOIN "demo_admissions" a ON a."id"=c."admission_id"
         WHERE c."admission_id"=$1 AND c."generation"=$2 AND c."lease_token"=$3
           AND c."lease_expires_at">clock_timestamp() AND c."phase"='purging' AND a."owner_id"=$4
         FOR UPDATE OF c,a`, [admissionId, generation, leaseToken, ownerId]);
      if (!cleanup[0]) throw accountingUnavailable();
      const unresolved = await queryRows<{ readonly id: string }>(transaction,
        `SELECT "id" FROM "storage_filesystem_reservations"
         WHERE "owner_id"=$1 AND "project_id"=$2 AND "status" IN ('pending','unknown') FOR UPDATE`, [ownerId, projectId]);
      if (unresolved.length > 0) throw accountingUnavailable();
      if (rootKey === null) {
        const mappings = await queryRows<{ readonly root_key: string }>(transaction,
          'SELECT "root_key" FROM "storage_root_mappings" WHERE "owner_id"=$1 AND "project_id"=$2 FOR UPDATE', [ownerId, projectId]);
        if (mappings.length > 0) throw accountingUnavailable();
      } else {
        if (rootKey !== projectRootOverlapKey(`projects/${projectId}`)) throw accountingUnavailable();
        const mappings = await queryRows<{ readonly storage_kind: string; readonly relative_root: string; readonly state: string }>(transaction,
          `SELECT "storage_kind","relative_root","state" FROM "storage_root_mappings"
           WHERE "owner_id"=$1 AND "project_id"=$2 AND "root_key"=$3 AND "locator_project_id"=$2 FOR UPDATE`,
          [ownerId, projectId, rootKey]);
        if (mappings.length !== 1 || mappings[0]?.storage_kind !== 'managed'
          || mappings[0].relative_root !== `projects/${projectId}` || mappings[0].state !== 'active') throw accountingUnavailable();
        await transaction.query(`UPDATE "storage_root_mappings" SET "project_id"=NULL,"state"='retained',"updated_at"=clock_timestamp()
          WHERE "owner_id"=$1 AND "project_id"=$2 AND "root_key"=$3`, [ownerId, projectId, rootKey]);
        await transaction.query(`UPDATE "storage_resource_references" SET "resource_kind"='retained_root',"project_id"=NULL,"updated_at"=clock_timestamp()
          WHERE "owner_id"=$1 AND "project_id"=$2 AND "root_key"=$3 AND "resource_kind"='project_file'`, [ownerId, projectId, rootKey]);
      }
      const deleted = await queryRows<{ readonly id: string }>(transaction,
        'DELETE FROM "projects" WHERE "owner_id"=$1 AND "id"=$2 RETURNING "id"', [ownerId, projectId]);
      if (deleted.length !== 1) throw accountingUnavailable();
    });
  }

  /** Deletes a retained mapping only after the caller proved the managed root absent. */
  public async deleteDemoRetainedRoot(
    ownerId: string,
    rootKey: string,
    admissionId: string,
    generation: string,
    leaseToken: string
  ): Promise<void> {
    await this.inTransaction(async (transaction) => {
      const account = await this.lockAccount(transaction, ownerId);
      if (account.state !== 'ready') throw accountingUnavailable();
      await lockStorageRootOwner(transaction, ownerId);
      const cleanup = await queryRows<{ readonly generation: string }>(transaction,
        `SELECT c."generation" FROM "demo_expiry_cleanups" c JOIN "demo_admissions" a ON a."id"=c."admission_id"
         WHERE c."admission_id"=$1 AND c."generation"=$2 AND c."lease_token"=$3
           AND c."lease_expires_at">clock_timestamp() AND c."phase"='purging' AND a."owner_id"=$4
         FOR UPDATE OF c,a`, [admissionId, generation, leaseToken, ownerId]);
      if (!cleanup[0]) throw accountingUnavailable();
      const mapping = await queryRows<{ readonly locator_project_id: string; readonly storage_kind: string; readonly relative_root: string }>(transaction,
        `SELECT "locator_project_id","storage_kind","relative_root" FROM "storage_root_mappings"
         WHERE "owner_id"=$1 AND "root_key"=$2 AND "project_id" IS NULL AND "state"='retained' FOR UPDATE`, [ownerId, rootKey]);
      if (mapping.length !== 1 || mapping[0]?.storage_kind !== 'managed'
        || mapping[0].relative_root !== `projects/${mapping[0].locator_project_id}`) throw accountingUnavailable();
      const blockers = await queryRows<{ readonly has_references: boolean; readonly has_reservations: boolean }>(transaction,
        `SELECT EXISTS(SELECT 1 FROM "storage_resource_references" WHERE "owner_id"=$1 AND "root_key"=$2) AS "has_references",
           EXISTS(SELECT 1 FROM "storage_filesystem_reservations" WHERE "owner_id"=$1 AND "root_key"=$2 AND "status" IN ('pending','unknown')) AS "has_reservations"`,
        [ownerId, rootKey]);
      if (blockers[0]?.has_references || blockers[0]?.has_reservations) throw accountingUnavailable();
      await transaction.query("SELECT set_config('app.storage_root_removal_verified',$1,true)", [`${ownerId}:${rootKey}`]);
      const deleted = await queryRows<{ readonly root_key: string }>(transaction,
        `DELETE FROM "storage_root_mappings" WHERE "owner_id"=$1 AND "root_key"=$2 AND "state"='retained' AND "project_id" IS NULL RETURNING "root_key"`,
        [ownerId, rootKey]);
      if (deleted.length !== 1) throw accountingUnavailable();
    });
  }

  /** Reconciles all remaining database-content charges and settled reservation rows before owner deletion. */
  public async purgeDemoOwnedReferences(
    ownerId: string,
    admissionId: string,
    generation: string,
    leaseToken: string
  ): Promise<void> {
    await this.inTransaction(async (transaction) => {
      const account = await this.lockAccount(transaction, ownerId);
      if (account.state !== 'ready') throw accountingUnavailable();
      await lockStorageRootOwner(transaction, ownerId);
      const cleanup = await queryRows<{ readonly generation: string }>(transaction,
        `SELECT c."generation" FROM "demo_expiry_cleanups" c JOIN "demo_admissions" a ON a."id"=c."admission_id"
         WHERE c."admission_id"=$1 AND c."generation"=$2 AND c."lease_token"=$3
           AND c."lease_expires_at">clock_timestamp() AND c."phase"='purging' AND a."owner_id"=$4
         FOR UPDATE OF c,a`, [admissionId, generation, leaseToken, ownerId]);
      if (!cleanup[0]) throw accountingUnavailable();
      const unresolved = await queryRows<{ readonly id: string }>(transaction,
        `SELECT "id" FROM "storage_filesystem_reservations" WHERE "owner_id"=$1 AND "status" IN ('pending','unknown') FOR UPDATE`, [ownerId]);
      if (unresolved.length > 0) throw accountingUnavailable();
      const unsafe = await queryRows<{ readonly has_external_references: boolean; readonly has_mappings: boolean }>(transaction,
        `SELECT EXISTS(SELECT 1 FROM "storage_resource_references" WHERE "owner_id"=$1 AND "resource_kind"<>'database_content') AS "has_external_references",
           EXISTS(SELECT 1 FROM "storage_root_mappings" WHERE "owner_id"=$1) AS "has_mappings"`, [ownerId]);
      if (unsafe[0]?.has_external_references || unsafe[0]?.has_mappings) throw accountingUnavailable();
      const references = await queryRows<{ readonly byte_count: string }>(transaction,
        `SELECT "byte_count" FROM "storage_resource_references" WHERE "owner_id"=$1 AND "resource_kind"='database_content' FOR UPDATE`, [ownerId]);
      const releasedBytes = references.reduce((sum, reference) => sum + BigInt(reference.byte_count), 0n);
      if (releasedBytes > account.usedBytes) throw accountingUnavailable();
      await transaction.query('DELETE FROM "storage_resource_references" WHERE "owner_id"=$1 AND "resource_kind"=\'database_content\'', [ownerId]);
      await transaction.query(`UPDATE "storage_account_totals" SET "used_bytes"=$2,"updated_at"=clock_timestamp() WHERE "owner_id"=$1`,
        [ownerId, (account.usedBytes - releasedBytes).toString()]);
      await transaction.query(`DELETE FROM "storage_filesystem_reservation_references" WHERE "owner_id"=$1`, [ownerId]);
      await transaction.query(`DELETE FROM "storage_filesystem_reservations" WHERE "owner_id"=$1 AND "status" IN ('settled','released')`, [ownerId]);
    });
  }

  public async releaseFileOperationWithNoSideEffect(ownerId: string, operationId: string): Promise<void> {
    await this.inTransaction(async (transaction) => {
      const account = await this.lockAccount(transaction, ownerId);
      const reservation = await this.lockReservation(transaction, ownerId, operationId);
      if (reservation.status === 'released' || reservation.status === 'settled') return;
      const growth = BigInt(reservation.reserved_growth_bytes);
      const nextReserved = account.reservedBytes - growth;
      if (nextReserved < 0n) throw accountingUnavailable();
      await transaction.query(
        `UPDATE "storage_account_totals" SET "reserved_bytes" = $2, "updated_at" = clock_timestamp() WHERE "owner_id" = $1`,
        [ownerId, nextReserved.toString()]
      );
      await transaction.query(
        `UPDATE "storage_filesystem_reservations" SET "status" = 'released', "reserved_growth_bytes" = 0, "updated_at" = clock_timestamp()
         WHERE "owner_id" = $1 AND "id" = $2`,
        [ownerId, operationId]
      );
      await transaction.query('DELETE FROM "storage_filesystem_reservation_references" WHERE "reservation_id" = $1', [operationId]);
    });
  }

  public async markFileOperationUnknown(
    ownerId: string,
    operationId: string,
    observedChanges: readonly StorageVerifiedFileChange[] = []
  ): Promise<void> {
    await this.inTransaction(async (transaction) => {
      await this.lockAccount(transaction, ownerId);
      const reservation = await this.lockReservation(transaction, ownerId, operationId);
      if (reservation.status === 'settled' || reservation.status === 'released') return;
      await transaction.query(
        `UPDATE "storage_filesystem_reservations" SET "status" = 'unknown', "observed_changes" = $3::jsonb,
           "updated_at" = clock_timestamp() WHERE "owner_id" = $1 AND "id" = $2`,
        [ownerId, operationId, JSON.stringify(observedChanges.map(toJsonVerifiedChange))]
      );
    });
  }

  public async reconcileReferences(ownerId: string, references: readonly StorageResourceReference[]): Promise<void> {
    assertUniqueReferences(references);
    for (const reference of references) {
      if (reference.ownerId !== ownerId) throw new TypeError('Reconciliation references must belong to the requested owner.');
      validateReference(reference);
    }
    await this.inTransaction(async (transaction) => {
      const account = await this.lockAccount(transaction, ownerId);
      const pending = await queryRows<{ count: string }>(transaction,
        `SELECT count(*)::text AS "count" FROM "storage_filesystem_reservations"
         WHERE "owner_id" = $1 AND "status" IN ('pending', 'unknown')`, [ownerId]);
      if (BigInt(pending[0]?.count ?? '0') > 0n) throw accountingUnavailable();

      const totalBytes = references.reduce((sum, reference) => sum + reference.bytes, 0n);
      assertCounter(totalBytes);
      if (account.reservedBytes !== 0n) throw accountingUnavailable();
      await transaction.query('DELETE FROM "storage_resource_references" WHERE "owner_id" = $1', [ownerId]);
      for (const reference of references) {
        await transaction.query(
          `INSERT INTO "storage_resource_references" (
             "owner_id", "resource_kind", "resource_key", "copy_key", "project_id", "root_key", "relative_key", "byte_count", "sha256"
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [reference.ownerId, reference.kind, reference.resourceKey, reference.copyKey, reference.projectId,
            reference.rootKey, reference.relativeKey, reference.bytes.toString(), reference.sha256]
        );
      }
      await transaction.query(
        `UPDATE "storage_account_totals" SET "used_bytes" = $2, "accounting_state" = 'ready', "updated_at" = clock_timestamp()
         WHERE "owner_id" = $1`,
        [ownerId, totalBytes.toString()]
      );
    });
  }

  public async markAccountUnavailable(ownerId: string): Promise<void> {
    await this.inTransaction(async (transaction) => {
      await this.lockAccount(transaction, ownerId);
      await transaction.query(
        `UPDATE "storage_account_totals" SET "accounting_state" = 'unavailable', "updated_at" = clock_timestamp()
         WHERE "owner_id" = $1`,
        [ownerId]
      );
    });
  }

  private async lockAccount(transaction: StorageQuotaTransaction, ownerId: string): Promise<LockedAccount> {
    // This serialization row is always acquired before storage counters, references, or resource rows.
    await transaction.query('INSERT INTO "account_limits" ("owner_id") VALUES ($1) ON CONFLICT ("owner_id") DO NOTHING', [ownerId]);
    const limits = await queryRows<AccountRow>(transaction,
      'SELECT "storage_limit_bytes" FROM "account_limits" WHERE "owner_id" = $1 FOR UPDATE', [ownerId]);
    if (!limits[0]) throw accountingUnavailable();

    await transaction.query(
      `INSERT INTO "storage_account_totals" ("owner_id", "accounting_state") VALUES ($1, 'reconciling') ON CONFLICT ("owner_id") DO NOTHING`,
      [ownerId]
    );
    const totals = await queryRows<TotalsRow>(transaction,
      `SELECT "used_bytes", "reserved_bytes", "accounting_state" FROM "storage_account_totals" WHERE "owner_id" = $1 FOR UPDATE`,
      [ownerId]);
    if (!totals[0]) throw accountingUnavailable();
    return {
      limitBytes: toBigIntOrNull(limits[0].storage_limit_bytes),
      usedBytes: BigInt(totals[0].used_bytes),
      reservedBytes: BigInt(totals[0].reserved_bytes),
      state: totals[0].accounting_state
    };
  }

  private async lockActivePrincipal(transaction: StorageQuotaTransaction, ownerId: string): Promise<void> {
    const principals = await queryRows<{ id: string }>(transaction,
      'SELECT "id" FROM "users" WHERE "id" = $1 AND "is_active" = true AND ("expires_at" IS NULL OR "expires_at" > now()) FOR SHARE',
      [ownerId]);
    if (!principals[0]) throw new UnauthenticatedError();
  }

  private async lockExistingPrincipal(transaction: StorageQuotaTransaction, ownerId: string): Promise<void> {
    const principals = await queryRows<{ id: string }>(transaction,
      'SELECT "id" FROM "users" WHERE "id" = $1 FOR SHARE', [ownerId]);
    if (!principals[0]) throw accountingUnavailable();
  }

  private async measureDatabaseReferenceDelta(
    transaction: StorageQuotaTransaction,
    ownerId: string,
    changes: readonly StorageResourceReferenceChange[]
  ): Promise<bigint> {
    let totalDelta = 0n;
    for (const change of changes) {
      validateReference(change.reference);
      if (change.reference.ownerId !== ownerId) throw new TypeError('Storage references must belong to the mutation owner.');
      if (change.reference.kind !== 'database_content') throw new TypeError('Filesystem references require a durable file-operation reservation.');
      if (change.nextBytes !== null) assertByteCount(change.nextBytes, 'next reference bytes');
      const prior = await this.getReference(transaction, change.reference);
      totalDelta += referenceDelta(prior?.bytes ?? null, change.nextBytes);
    }
    return totalDelta;
  }

  private async persistDatabaseReferenceChanges(
    transaction: StorageQuotaTransaction,
    ownerId: string,
    nextUsed: bigint,
    changes: readonly StorageResourceReferenceChange[]
  ): Promise<void> {
    for (const change of changes) await this.writeReference(transaction, change);
    await transaction.query(
      `UPDATE "storage_account_totals" SET "used_bytes" = $2, "updated_at" = clock_timestamp()
       WHERE "owner_id" = $1`,
      [ownerId, nextUsed.toString()]
    );
  }

  private async lockReservation(transaction: StorageQuotaTransaction, ownerId: string, operationId: string): Promise<NormalizedReservationRow> {
    const rows = await queryRows<ReservationRow>(transaction,
      `SELECT "id", "fingerprint", "status", "reserved_growth_bytes", "reference_changes", "outcome"
       FROM "storage_filesystem_reservations" WHERE "owner_id" = $1 AND "id" = $2 FOR UPDATE`,
      [ownerId, operationId]);
    if (!rows[0]) throw accountingUnavailable();
    return normalizeReservationRow(rows[0]);
  }

  private async getReference(transaction: StorageQuotaTransaction, reference: StorageResourceReference): Promise<{ bytes: bigint; sha256: string | null } | null> {
    const rows = await queryRows<ReferenceRow>(transaction,
      `SELECT "byte_count", "sha256" FROM "storage_resource_references"
       WHERE "owner_id" = $1 AND "resource_kind" = $2 AND "resource_key" = $3 AND "copy_key" = $4 FOR UPDATE`,
      [reference.ownerId, reference.kind, reference.resourceKey, reference.copyKey]);
    const row = rows[0];
    return row ? { bytes: BigInt(row.byte_count), sha256: row.sha256 } : null;
  }

  private async writeReference(transaction: StorageQuotaTransaction, change: StorageResourceReferenceChange): Promise<void> {
    const reference = change.reference;
    if (change.nextBytes === null) {
      await transaction.query(
        `DELETE FROM "storage_resource_references" WHERE "owner_id" = $1 AND "resource_kind" = $2 AND "resource_key" = $3 AND "copy_key" = $4`,
        [reference.ownerId, reference.kind, reference.resourceKey, reference.copyKey]);
      return;
    }
    await transaction.query(
      `INSERT INTO "storage_resource_references" (
         "owner_id", "resource_kind", "resource_key", "copy_key", "project_id", "root_key", "relative_key", "byte_count", "sha256"
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT ("owner_id", "resource_kind", "resource_key", "copy_key") DO UPDATE SET
         "project_id" = EXCLUDED."project_id", "root_key" = EXCLUDED."root_key", "relative_key" = EXCLUDED."relative_key",
         "byte_count" = EXCLUDED."byte_count", "sha256" = EXCLUDED."sha256", "updated_at" = clock_timestamp()`,
      [reference.ownerId, reference.kind, reference.resourceKey, reference.copyKey, reference.projectId,
        reference.rootKey, reference.relativeKey, change.nextBytes.toString(), change.nextSha256]
    );
  }

  private async inTransaction<T>(action: (transaction: QueryRunner) => Promise<T>): Promise<T> {
    const transaction = this.dataSource.createQueryRunner();
    await transaction.connect();
    await transaction.startTransaction();
    try {
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

async function queryRows<T>(transaction: StorageQuotaTransaction, sql: string, parameters?: unknown[]): Promise<T[]> {
  const result: unknown = await transaction.query(sql, parameters);
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0] as T[];
  }
  return result as T[];
}

function validateFileCommand(command: StorageFileOperationCommand): void {
  if (!command.ownerId || command.operationKey.length < 1 || command.operationKey.length > 128
    || !/^[a-f0-9]{64}$/u.test(command.fingerprint) || command.rootKey.length < 1 || command.rootKey.length > 2048
    || command.changes.length === 0 || command.changes.length > 8) throw new TypeError('The file operation reservation is invalid.');
  if (command.targetKey.length < 1 || command.targetKey.length > 2048 || !isSafeRelativeKey(command.targetKey)) {
    throw new TypeError('The file operation target must be a safe relative key.');
  }
  assertUniqueReferences(command.changes.map((change) => referenceFromPlan(command.ownerId, change)));
  for (const change of command.changes) {
    const expectedRoot = change.kind === 'recovery_file' ? 'recovery-v1' : command.rootKey;
    if (change.projectId !== command.projectId || change.rootKey !== expectedRoot
      || !isSafeRelativeKey(change.relativeKey) || change.resourceKey.length < 1 || change.resourceKey.length > 2048
      || change.copyKey.length < 1 || change.copyKey.length > 2048) throw new TypeError('The file operation reference is invalid.');
    if (change.expectedPriorBytes !== null) assertByteCount(change.expectedPriorBytes, 'expected prior bytes');
    if (change.intendedBytes !== null) assertByteCount(change.intendedBytes, 'intended bytes');
    validateSha(change.expectedPriorSha256);
    validateSha(change.intendedSha256);
  }
  const { fingerprint, ...fingerprintInput } = command;
  if (storageFileOperationFingerprint(fingerprintInput) !== fingerprint) throw new TypeError('The operation fingerprint does not match its planned effects.');
}

function assertTrustedScope(command: StorageFileOperationCommand, scope: StorageTrustedFileScope): void {
  if (scope.ownerId !== command.ownerId || scope.projectId !== command.projectId || !command.projectId) {
    throw new TypeError('The file reservation did not resolve its persisted owner/project scope.');
  }
  const roots = scope.roots.filter((root) => root.rootKey === command.rootKey);
  if (roots.length !== 1) throw new TypeError('The file reservation did not resolve the target trusted root.');
  const root = roots[0];
  if (!root || root.ownerId !== command.ownerId || root.projectId !== command.projectId) {
    throw new TypeError('The file reservation did not resolve the target trusted root.');
  }
}

function validateReference(reference: StorageResourceReference): void {
  if (!reference.ownerId || !reference.resourceKey || reference.resourceKey.length > 2048 || !reference.copyKey || reference.copyKey.length > 2048) {
    throw new TypeError('The storage reference identity is invalid.');
  }
  assertByteCount(reference.bytes);
  validateSha(reference.sha256);
  if (reference.kind === 'database_content') {
    if (reference.rootKey !== null || reference.relativeKey !== null) throw new TypeError('Database references cannot name a filesystem path.');
  } else if (!reference.rootKey || reference.rootKey.length > 2048 || !reference.relativeKey || !isSafeRelativeKey(reference.relativeKey)) {
    throw new TypeError('Filesystem references require a trusted root key and safe relative key.');
  }
}

function assertUniqueReferences(references: readonly StorageResourceReference[]): void {
  const ids = references.map(referenceId);
  if (new Set(ids).size !== ids.length) throw new TypeError('A storage mutation cannot change the same reference more than once.');
}

function referenceId(reference: Pick<StorageResourceReference, 'kind' | 'resourceKey' | 'copyKey'>): string {
  return `${reference.kind}\u0000${reference.resourceKey}\u0000${reference.copyKey}`;
}

function referenceFromPlan(ownerId: string, plan: StorageFileReferencePlan): StorageResourceReference {
  return {
    ownerId, kind: plan.kind, resourceKey: plan.resourceKey, copyKey: plan.copyKey, bytes: plan.expectedPriorBytes ?? 0n,
    projectId: plan.projectId, rootKey: plan.rootKey, relativeKey: plan.relativeKey, sha256: plan.expectedPriorSha256
  };
}

function verifiedReference(ownerId: string, change: StorageVerifiedFileChange): StorageResourceReference {
  return {
    ownerId, kind: change.kind, resourceKey: change.resourceKey, copyKey: change.copyKey,
    bytes: change.bytes ?? 0n, projectId: change.projectId, rootKey: change.rootKey,
    relativeKey: change.relativeKey, sha256: change.sha256
  };
}

function toStoredChange(change: StorageFileReferencePlan): StoredFileChange {
  return {
    ...change,
    expectedPriorBytes: change.expectedPriorBytes?.toString() ?? null,
    intendedBytes: change.intendedBytes?.toString() ?? null
  };
}

function normalizeReservationRow(row: ReservationRow | NormalizedReservationRow): NormalizedReservationRow {
  const changes = readStoredChanges(row.reference_changes);
  const rawOutcome = typeof row.outcome === 'string' ? JSON.parse(row.outcome) as readonly StorageVerifiedFileChange[] : row.outcome;
  const outcome = rawOutcome?.map((change) => ({
    ...change,
    bytes: change.bytes === null ? null : BigInt(String(change.bytes))
  })) ?? null;
  return { ...row, reference_changes: changes, outcome };
}

function parseStoredChanges(value: readonly StoredFileChange[] | string): StorageFileReferencePlan[] {
  return readStoredChanges(value).map((change) => ({
    ...change,
    expectedPriorBytes: change.expectedPriorBytes === null ? null : BigInt(change.expectedPriorBytes),
    intendedBytes: change.intendedBytes === null ? null : BigInt(change.intendedBytes)
  }));
}

function readStoredChanges(value: readonly StoredFileChange[] | string): StoredFileChange[] {
  return typeof value === 'string' ? JSON.parse(value) as StoredFileChange[] : [...value];
}

function reservationResult(row: ReservationRow | NormalizedReservationRow, replay: boolean): StorageFileOperationReservation {
  const normalized = normalizeReservationRow(row);
  return { operationId: row.id, state: row.status === 'pending' ? 'reserved' : row.status, outcome: normalized.outcome ?? null, replay };
}

function changeLocationsMatch(plans: readonly StoredFileChange[], actual: readonly StorageVerifiedFileChange[]): boolean {
  if (plans.length !== actual.length) return false;
  return plans.every((plan) => {
    const observed = actual.find((change) => sameReference(plan, change));
    return observed !== undefined
      && observed.projectId === plan.projectId
      && observed.rootKey === plan.rootKey
      && observed.relativeKey === plan.relativeKey;
  });
}

function sameReference(plan: Pick<StorageFileReferencePlan, 'kind' | 'resourceKey' | 'copyKey'>, change: StorageVerifiedFileChange): boolean {
  return plan.kind === change.kind && plan.resourceKey === change.resourceKey && plan.copyKey === change.copyKey;
}

function toJsonVerifiedChange(change: StorageVerifiedFileChange): Record<string, unknown> {
  return { ...change, bytes: change.bytes?.toString() ?? null };
}

function toBigIntOrNull(value: string | null | undefined): bigint | null {
  return value === null || value === undefined ? null : BigInt(value);
}

function toDate(value: Date | string | undefined): Date | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function maxZero(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function assertCounter(value: bigint): void {
  if (value < 0n || value > MAX_BIGINT) throw accountingUnavailable();
}

function validateSha(value: string | null): void {
  if (value !== null && !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError('A SHA-256 digest must be lowercase hexadecimal.');
}

function isSafeRelativeKey(value: string): boolean {
  if (value.length === 0 || value.length > 2048 || value.startsWith('/') || value.includes('\\') || value.includes('\u0000')) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}
