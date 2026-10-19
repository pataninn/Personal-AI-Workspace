import type { DataSource } from 'typeorm';

import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import type {
  IStorageQuotaRepository,
  StorageQuotaTransaction
} from '@/modules/storage-quotas/repositories/storage-quota-repository';
import type { StorageContentIdentity, StorageContentMutationScope } from '@/infrastructure/database/storage-content-projections';
import { readStoredContentReferences, scanContentIdentities } from '@/infrastructure/database/storage-content-projections';
import type {
  StorageResourceReference,
  StorageResourceReferenceChange
} from '@/modules/storage-quotas/domain/storage-quota-types';

interface ContentReferenceRow {
  readonly resource_key: string;
  readonly copy_key: string;
  readonly project_id: string | null;
  readonly byte_count: string;
}

interface CanonicalReferenceRow extends ContentReferenceRow {}

const MAX_STORAGE_BYTES = 9_223_372_036_854_775_807n;

const CANONICAL_CONTENT_SQL = `
  SELECT 'projects:' || p."id"::text AS "resource_key", 'name' AS "copy_key", NULL::text AS "project_id", octet_length(p."name")::text AS "byte_count"
    FROM "projects" p WHERE p."owner_id" = $1
  UNION ALL SELECT 'projects:' || p."id"::text, 'objective', NULL::text, octet_length(p."objective")::text
    FROM "projects" p WHERE p."owner_id" = $1 AND p."objective" IS NOT NULL
  UNION ALL SELECT 'conversations:' || c."id"::text, 'title', c."project_id"::text, octet_length(c."title")::text
    FROM "conversations" c WHERE c."owner_id" = $1
  UNION ALL SELECT 'conversation_idempotency_keys:' || k."id"::text, 'request_fingerprint', k."project_id"::text, octet_length(k."request_fingerprint")::text
    FROM "conversation_idempotency_keys" k WHERE k."owner_id" = $1
  UNION ALL SELECT 'messages:' || m."id"::text, 'content', c."project_id"::text, octet_length(m."content")::text
    FROM "messages" m JOIN "conversations" c ON c."id" = m."conversation_id" WHERE c."owner_id" = $1
  UNION ALL SELECT 'project_tasks:' || t."id"::text, 'title', t."project_id"::text, octet_length(t."title")::text
    FROM "project_tasks" t WHERE t."owner_id" = $1
  UNION ALL SELECT 'project_tasks:' || t."id"::text, 'details', t."project_id"::text, octet_length(t."details")::text
    FROM "project_tasks" t WHERE t."owner_id" = $1 AND t."details" IS NOT NULL
  UNION ALL SELECT 'project_tasks:' || t."id"::text, 'subtasks', t."project_id"::text, octet_length(t."subtasks"::text)::text
    FROM "project_tasks" t WHERE t."owner_id" = $1
  UNION ALL SELECT 'project_tasks:' || t."id"::text, 'idempotency_snapshot', t."project_id"::text, octet_length(t."idempotency_snapshot"::text)::text
    FROM "project_tasks" t WHERE t."owner_id" = $1 AND t."idempotency_snapshot" IS NOT NULL
  UNION ALL SELECT 'project_task_suggestions:' || s."id"::text, 'title', s."project_id"::text, octet_length(s."title")::text
    FROM "project_task_suggestions" s WHERE s."owner_id" = $1
  UNION ALL SELECT 'project_task_suggestions:' || s."id"::text, 'details', s."project_id"::text, octet_length(s."details")::text
    FROM "project_task_suggestions" s WHERE s."owner_id" = $1 AND s."details" IS NOT NULL
  UNION ALL SELECT 'project_task_suggestions:' || s."id"::text, 'subtasks', s."project_id"::text, octet_length(s."subtasks"::text)::text
    FROM "project_task_suggestions" s WHERE s."owner_id" = $1
  UNION ALL SELECT 'project_facts:' || f."id"::text, 'title', f."project_id"::text, octet_length(f."title")::text
    FROM "project_facts" f WHERE f."owner_id" = $1
  UNION ALL SELECT 'project_facts:' || f."id"::text, 'content', f."project_id"::text, octet_length(f."content")::text
    FROM "project_facts" f WHERE f."owner_id" = $1
  UNION ALL SELECT 'ai_runs:' || r."id"::text, 'request', r."project_id"::text, octet_length(r."request")::text
    FROM "ai_runs" r WHERE r."owner_id" = $1
  UNION ALL SELECT 'ai_runs:' || r."id"::text, 'manifest', r."project_id"::text, octet_length(r."manifest"::text)::text
    FROM "ai_runs" r WHERE r."owner_id" = $1
  UNION ALL SELECT 'ai_run_change_sets:' || c."id"::text, 'operations', c."project_id"::text, octet_length(c."operations"::text)::text
    FROM "ai_run_change_sets" c WHERE c."owner_id" = $1
  UNION ALL SELECT 'ai_run_change_sets:' || c."id"::text, 'backup_checkpoints', c."project_id"::text, octet_length(c."backup_checkpoints"::text)::text
    FROM "ai_run_change_sets" c WHERE c."owner_id" = $1
  UNION ALL SELECT 'ai_run_change_sets:' || c."id"::text, 'result', c."project_id"::text, octet_length(c."result"::text)::text
    FROM "ai_run_change_sets" c WHERE c."owner_id" = $1 AND c."result" IS NOT NULL
  UNION ALL SELECT 'sandbox_commands:' || s."id"::text, 'command', s."project_id"::text, octet_length(s."command")::text
    FROM "sandbox_commands" s WHERE s."owner_id" = $1
  UNION ALL SELECT 'sandbox_commands:' || s."id"::text, 'args', s."project_id"::text, octet_length(s."args"::text)::text
    FROM "sandbox_commands" s WHERE s."owner_id" = $1
  UNION ALL SELECT 'sandbox_commands:' || s."id"::text, 'summary', s."project_id"::text, octet_length(s."summary")::text
    FROM "sandbox_commands" s WHERE s."owner_id" = $1
  UNION ALL SELECT 'sandbox_commands:' || s."id"::text, 'result', s."project_id"::text, octet_length(s."result"::text)::text
    FROM "sandbox_commands" s WHERE s."owner_id" = $1 AND s."result" IS NOT NULL
  UNION ALL SELECT 'action_ledger_records:' || a."id"::text, 'reversible_fields', NULL::text, octet_length(a."reversible_fields"::text)::text
    FROM "action_ledger_records" a WHERE a."owner_id" = $1
  UNION ALL SELECT 'action_ledger_records:' || a."id"::text, 'outcome', NULL::text, octet_length(a."outcome"::text)::text
    FROM "action_ledger_records" a WHERE a."owner_id" = $1
  UNION ALL SELECT 'home_conversations:' || h."id"::text, 'title', NULL::text, octet_length(h."title")::text
    FROM "home_conversations" h WHERE h."owner_id" = $1
  UNION ALL SELECT 'home_messages:' || m."id"::text, 'content', NULL::text, octet_length(m."content")::text
    FROM "home_messages" m WHERE m."owner_id" = $1
  UNION ALL SELECT 'home_conversation_events:' || e."conversation_id"::text || ':' || e."sequence"::text, 'payload', NULL::text, octet_length(e."payload"::text)::text
    FROM "home_conversation_events" e WHERE e."owner_id" = $1
  UNION ALL SELECT 'home_change_proposal_items:' || p."id"::text, 'command', NULL::text, octet_length(p."command"::text)::text
    FROM "home_change_proposal_items" p WHERE p."owner_id" = $1
`;

/** Adds transaction-scoped references for the canonical retained database content. */
export class TypeOrmStorageContentAccounting {
  private readonly quotaRepository: IStorageQuotaRepository;

  public constructor(dataSource: DataSource, quotaRepository?: IStorageQuotaRepository) {
    this.quotaRepository = quotaRepository ?? new TypeOrmStorageQuotaRepository(dataSource);
  }

  /** Runs a database mutation under the owner's quota lock and writes its exact reference diff. */
  public async runMutation<T>(
    transaction: StorageQuotaTransaction,
    ownerId: string,
    mutation: () => Promise<T>,
    scope: StorageContentMutationScope<T>,
    options?: { readonly beforeReferences?: () => Promise<void> }
  ): Promise<T> {
    return await this.quotaRepository.runDatabaseMutation(
      transaction,
      { ownerId, maximumGrowthBytes: MAX_STORAGE_BYTES },
      async () => {
        const before = await scope.before(transaction);
        const result = await mutation();
        const after = await scope.after(transaction, result);
        const identities = mergeIdentities(before, after);
        if (identities.length === 0) {
          throw new TypeError('An accounted mutation must name every changed content identity; metadata-only mutations must use an explicit non-content boundary.');
        }
        const previous = await readStoredContentReferences(transaction, ownerId, identities);
        const current = await scanContentIdentities(transaction, ownerId, identities);
        return { result, references: referenceDiff(previous, current) };
      },
      options
    );
  }

  /** Returns the owner's exact PostgreSQL-measured retained content references. */
  public async scanDatabaseContent(
    transaction: StorageQuotaTransaction,
    ownerId: string
  ): Promise<readonly StorageResourceReference[]> {
    const rows = await transaction.query(CANONICAL_CONTENT_SQL, [ownerId]) as readonly CanonicalReferenceRow[];
    return rows.map((row) => ({
      ownerId,
      kind: 'database_content',
      resourceKey: row.resource_key,
      copyKey: row.copy_key,
      bytes: BigInt(row.byte_count),
      projectId: row.project_id,
      rootKey: null,
      relativeKey: null,
      sha256: null
    }));
  }

}

function mergeIdentities(before: readonly StorageContentIdentity[], after: readonly StorageContentIdentity[]): StorageContentIdentity[] {
  const identities = new Map<string, StorageContentIdentity>();
  for (const identity of [...before, ...after]) {
    const key = `${identity.entity}\u0000${identity.id}\u0000${identity.sequence ?? ''}`;
    identities.set(key, identity);
  }
  return [...identities.values()];
}

function referenceDiff(
  previous: readonly StorageResourceReference[],
  current: readonly StorageResourceReference[]
): readonly StorageResourceReferenceChange[] {
  const previousByKey = new Map(previous.map((reference) => [referenceKey(reference), reference]));
  const currentByKey = new Map(current.map((reference) => [referenceKey(reference), reference]));
  const changes: StorageResourceReferenceChange[] = [];
  for (const [key, reference] of previousByKey) {
    const next = currentByKey.get(key);
    if (!next) changes.push({ reference, nextBytes: null, nextSha256: null });
    else if (next.bytes !== reference.bytes || next.projectId !== reference.projectId) {
      changes.push({ reference: next, nextBytes: next.bytes, nextSha256: null });
    }
  }
  for (const [key, reference] of currentByKey) {
    if (!previousByKey.has(key)) changes.push({ reference, nextBytes: reference.bytes, nextSha256: null });
  }
  return changes;
}

function referenceKey(reference: StorageResourceReference): string {
  return `${reference.resourceKey}\u0000${reference.copyKey}`;
}
