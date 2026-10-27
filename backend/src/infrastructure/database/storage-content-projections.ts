import type { StorageResourceReference } from '@/modules/storage-quotas/domain/storage-quota-types';
import type { StorageQuotaTransaction } from '@/modules/storage-quotas/repositories/storage-quota-repository';
import { lockProjectWriteState } from '@/infrastructure/database/project-removal-write-barrier';
import { HomeConversationNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';

export type StorageContentEntity =
  | 'projects'
  | 'conversations'
  | 'conversation_idempotency_keys'
  | 'messages'
  | 'project_tasks'
  | 'project_task_suggestions'
  | 'project_facts'
  | 'skill_revisions'
  | 'ai_runs'
  | 'ai_run_change_sets'
  | 'sandbox_commands'
  | 'action_ledger_records'
  | 'home_conversations'
  | 'home_messages'
  | 'home_conversation_events'
  | 'home_change_proposal_items';

export interface StorageContentIdentity {
  readonly entity: StorageContentEntity;
  readonly id: string;
  readonly sequence?: number;
}

export interface StorageContentMutationScope<TResult> {
  /** Select only content identities that may be removed or changed by the mutation. */
  readonly before: (transaction: StorageQuotaTransaction) => Promise<readonly StorageContentIdentity[]>;
  /** Select only content identities that exist after the mutation. */
  readonly after: (transaction: StorageQuotaTransaction, result: TResult) => Promise<readonly StorageContentIdentity[]>;
}

export function fixedContentScope<TResult>(identities: readonly StorageContentIdentity[]): StorageContentMutationScope<TResult> {
  return { before: async () => identities, after: async () => identities };
}

export function resultContentScope<TResult>(select: (result: TResult) => readonly StorageContentIdentity[]): StorageContentMutationScope<TResult> {
  return { before: async () => [], after: async (_transaction, result) => select(result) };
}

export function requestFingerprintContentScope<TResult>(input: {
  readonly ownerId: string;
  readonly projectId: string;
  readonly operation: 'conversation' | 'message';
  readonly idempotencyKey: string;
  readonly resourceIdentity: (result: TResult) => StorageContentIdentity;
  readonly idempotencyId: (result: TResult) => string;
}): StorageContentMutationScope<TResult> {
  let existingId: string | null = null;
  return {
    before: async (transaction) => {
      const rows = await transaction.query(
        `SELECT "id" FROM "conversation_idempotency_keys"
         WHERE "owner_id" = $1 AND "project_id" = $2 AND "operation" = $3 AND "idempotency_key" = $4 LIMIT 1`,
        [input.ownerId, input.projectId, input.operation, input.idempotencyKey]
      ) as readonly { id: string }[];
      existingId = rows[0]?.id ?? null;
      return existingId ? [{ entity: 'conversation_idempotency_keys', id: existingId }] : [];
    },
    after: async (_transaction, result) => {
      const idempotencyId = input.idempotencyId(result);
      if (!idempotencyId) throw new TypeError('A persisted conversation request must identify its idempotency row.');
      return [
        input.resourceIdentity(result),
        { entity: 'conversation_idempotency_keys', id: idempotencyId }
      ];
    }
  };
}

export function homeConversationContentScope<TResult>(input: {
  readonly ownerId: string;
  readonly conversationId: string | null;
  readonly conversationIdBefore?: (transaction: StorageQuotaTransaction) => Promise<string | null>;
  readonly conversationIdFromResult?: (result: TResult) => string | null;
  readonly turnIdsFromResult?: (result: TResult) => readonly string[];
}): StorageContentMutationScope<TResult> {
  let previousEventSequence = 0;
  let resolvedConversationId: string | null = input.conversationId;
  return {
    before: async (transaction) => {
      resolvedConversationId = input.conversationId ?? await input.conversationIdBefore?.(transaction) ?? null;
      if (resolvedConversationId) {
        const rows = await transaction.query(
          'SELECT "last_event_sequence", "workspace_id" FROM "home_conversations" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1',
          [input.ownerId, resolvedConversationId]
        ) as readonly { last_event_sequence: number | string; workspace_id: string | null }[];
        previousEventSequence = Number(rows[0]?.last_event_sequence ?? 0);
        if (rows[0]?.workspace_id) {
          const workspace = await lockProjectWriteState(transaction, input.ownerId, rows[0].workspace_id);
          if (!workspace || workspace.status !== 'active' || workspace.removalPending) throw new HomeConversationNotFoundError();
        }
      }
      return [];
    },
    after: async (transaction, result) => {
      const conversationId = input.conversationId ?? resolvedConversationId ?? input.conversationIdFromResult?.(result) ?? null;
      if (!conversationId) throw new TypeError('A Home content mutation must identify its conversation.');
      const rows = await transaction.query(
        'SELECT "last_event_sequence" FROM "home_conversations" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1',
        [input.ownerId, conversationId]
      ) as readonly { last_event_sequence: number | string }[];
      if (!rows[0]) {
        if (result === null || result === undefined) return [{ entity: 'home_conversations', id: conversationId }];
        throw new TypeError('A Home content mutation conversation was not found after the write.');
      }
      const lastEventSequence = Number(rows[0].last_event_sequence);
      const eventCount = lastEventSequence - previousEventSequence;
      if (!Number.isSafeInteger(eventCount) || eventCount < 0 || eventCount > 1000) {
        throw new TypeError('A Home content mutation exceeded the bounded event accounting scope.');
      }
      const identities: StorageContentIdentity[] = [{ entity: 'home_conversations', id: conversationId }];
      for (let sequence = previousEventSequence + 1; sequence <= lastEventSequence; sequence += 1) {
        identities.push({ entity: 'home_conversation_events', id: conversationId, sequence });
      }
      const turnIds = input.turnIdsFromResult?.(result) ?? [];
      if (turnIds.length > 0) {
        const messageRows = await transaction.query(
          'SELECT "id" FROM "home_messages" WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "turn_id" = ANY($3::uuid[])',
          [input.ownerId, conversationId, turnIds]
        ) as readonly { id: string }[];
        identities.push(...messageRows.map((row) => ({ entity: 'home_messages' as const, id: row.id })));
      }
      return identities;
    }
  };
}

interface CanonicalRow {
  readonly resource_key: string;
  readonly copy_key: string;
  readonly project_id: string | null;
  readonly byte_count: string;
}

interface StoredRow extends CanonicalRow {
  readonly root_key: string | null;
  readonly relative_key: string | null;
  readonly sha256: string | null;
}

const COPIES: Readonly<Record<StorageContentEntity, readonly string[]>> = {
  projects: ['name', 'objective'],
  conversations: ['title'],
  conversation_idempotency_keys: ['request_fingerprint'],
  messages: ['content'],
  project_tasks: ['title', 'details', 'subtasks', 'idempotency_snapshot'],
  project_task_suggestions: ['title', 'details', 'subtasks'],
  project_facts: ['title', 'content'],
  skill_revisions: ['title', 'instructions', 'declared_tools'],
  ai_runs: ['request', 'manifest'],
  ai_run_change_sets: ['operations', 'backup_checkpoints', 'result'],
  sandbox_commands: ['command', 'args', 'summary', 'result'],
  action_ledger_records: ['reversible_fields', 'outcome'],
  home_conversations: ['title'],
  home_messages: ['content'],
  home_conversation_events: ['payload'],
  home_change_proposal_items: ['command']
};

const PROJECTIONS: Readonly<Record<Exclude<StorageContentEntity, 'home_conversation_events'>, (ids: readonly string[]) => string>> = {
  projects: () => `SELECT 'projects:' || p."id"::text AS "resource_key", 'name' AS "copy_key", NULL::text AS "project_id", octet_length(p."name")::text AS "byte_count"
    FROM "projects" p WHERE p."owner_id" = $1 AND p."id" = ANY($2::uuid[])
    UNION ALL SELECT 'projects:' || p."id"::text, 'objective', NULL::text, octet_length(p."objective")::text
    FROM "projects" p WHERE p."owner_id" = $1 AND p."id" = ANY($2::uuid[]) AND p."objective" IS NOT NULL`,
  conversations: () => `SELECT 'conversations:' || c."id"::text AS "resource_key", 'title' AS "copy_key", c."project_id"::text AS "project_id", octet_length(c."title")::text AS "byte_count"
    FROM "conversations" c WHERE c."owner_id" = $1 AND c."id" = ANY($2::uuid[])`,
  conversation_idempotency_keys: () => `SELECT 'conversation_idempotency_keys:' || k."id"::text AS "resource_key", 'request_fingerprint' AS "copy_key", k."project_id"::text AS "project_id", octet_length(k."request_fingerprint")::text AS "byte_count"
    FROM "conversation_idempotency_keys" k WHERE k."owner_id" = $1 AND k."id" = ANY($2::uuid[])`,
  messages: () => `SELECT 'messages:' || m."id"::text AS "resource_key", 'content' AS "copy_key", c."project_id"::text AS "project_id", octet_length(m."content")::text AS "byte_count"
    FROM "messages" m JOIN "conversations" c ON c."id" = m."conversation_id" WHERE c."owner_id" = $1 AND m."id" = ANY($2::uuid[])`,
  project_tasks: () => `SELECT 'project_tasks:' || t."id"::text AS "resource_key", 'title' AS "copy_key", t."project_id"::text AS "project_id", octet_length(t."title")::text AS "byte_count"
    FROM "project_tasks" t WHERE t."owner_id" = $1 AND t."id" = ANY($2::uuid[])
    UNION ALL SELECT 'project_tasks:' || t."id"::text, 'details', t."project_id"::text, octet_length(t."details")::text FROM "project_tasks" t WHERE t."owner_id" = $1 AND t."id" = ANY($2::uuid[]) AND t."details" IS NOT NULL
    UNION ALL SELECT 'project_tasks:' || t."id"::text, 'subtasks', t."project_id"::text, octet_length(t."subtasks"::text)::text FROM "project_tasks" t WHERE t."owner_id" = $1 AND t."id" = ANY($2::uuid[])
    UNION ALL SELECT 'project_tasks:' || t."id"::text, 'idempotency_snapshot', t."project_id"::text, octet_length(t."idempotency_snapshot"::text)::text FROM "project_tasks" t WHERE t."owner_id" = $1 AND t."id" = ANY($2::uuid[]) AND t."idempotency_snapshot" IS NOT NULL`,
  project_task_suggestions: () => `SELECT 'project_task_suggestions:' || s."id"::text AS "resource_key", 'title' AS "copy_key", s."project_id"::text AS "project_id", octet_length(s."title")::text AS "byte_count"
    FROM "project_task_suggestions" s WHERE s."owner_id" = $1 AND s."id" = ANY($2::uuid[])
    UNION ALL SELECT 'project_task_suggestions:' || s."id"::text, 'details', s."project_id"::text, octet_length(s."details")::text FROM "project_task_suggestions" s WHERE s."owner_id" = $1 AND s."id" = ANY($2::uuid[]) AND s."details" IS NOT NULL
    UNION ALL SELECT 'project_task_suggestions:' || s."id"::text, 'subtasks', s."project_id"::text, octet_length(s."subtasks"::text)::text FROM "project_task_suggestions" s WHERE s."owner_id" = $1 AND s."id" = ANY($2::uuid[])`,
  project_facts: () => `SELECT 'project_facts:' || f."id"::text AS "resource_key", 'title' AS "copy_key", f."project_id"::text AS "project_id", octet_length(f."title")::text AS "byte_count"
    FROM "project_facts" f WHERE f."owner_id" = $1 AND f."id" = ANY($2::uuid[])
    UNION ALL SELECT 'project_facts:' || f."id"::text, 'content', f."project_id"::text, octet_length(f."content")::text FROM "project_facts" f WHERE f."owner_id" = $1 AND f."id" = ANY($2::uuid[])
  `,
  skill_revisions: () => `SELECT 'skill_revisions:' || r."id"::text AS "resource_key", 'title' AS "copy_key", s."workspace_id"::text AS "project_id", octet_length(r."title")::text AS "byte_count"
    FROM "skill_revisions" r JOIN "skills" s ON s."owner_id" = r."owner_id" AND s."id" = r."skill_id" WHERE r."owner_id" = $1 AND r."id" = ANY($2::uuid[])
    UNION ALL SELECT 'skill_revisions:' || r."id"::text, 'instructions', s."workspace_id"::text, octet_length(r."instructions")::text
    FROM "skill_revisions" r JOIN "skills" s ON s."owner_id" = r."owner_id" AND s."id" = r."skill_id" WHERE r."owner_id" = $1 AND r."id" = ANY($2::uuid[])
    UNION ALL SELECT 'skill_revisions:' || r."id"::text, 'declared_tools', s."workspace_id"::text, octet_length(r."declared_tools"::text)::text
    FROM "skill_revisions" r JOIN "skills" s ON s."owner_id" = r."owner_id" AND s."id" = r."skill_id" WHERE r."owner_id" = $1 AND r."id" = ANY($2::uuid[])`,
  ai_runs: () => `SELECT 'ai_runs:' || r."id"::text AS "resource_key", 'request' AS "copy_key", r."project_id"::text AS "project_id", octet_length(r."request")::text AS "byte_count"
    FROM "ai_runs" r WHERE r."owner_id" = $1 AND r."id" = ANY($2::uuid[])
    UNION ALL SELECT 'ai_runs:' || r."id"::text, 'manifest', r."project_id"::text, octet_length(r."manifest"::text)::text FROM "ai_runs" r WHERE r."owner_id" = $1 AND r."id" = ANY($2::uuid[])`,
  ai_run_change_sets: () => `SELECT 'ai_run_change_sets:' || c."id"::text AS "resource_key", 'operations' AS "copy_key", c."project_id"::text AS "project_id", octet_length(c."operations"::text)::text AS "byte_count"
    FROM "ai_run_change_sets" c WHERE c."owner_id" = $1 AND c."id" = ANY($2::uuid[])
    UNION ALL SELECT 'ai_run_change_sets:' || c."id"::text, 'backup_checkpoints', c."project_id"::text, octet_length(c."backup_checkpoints"::text)::text FROM "ai_run_change_sets" c WHERE c."owner_id" = $1 AND c."id" = ANY($2::uuid[])
    UNION ALL SELECT 'ai_run_change_sets:' || c."id"::text, 'result', c."project_id"::text, octet_length(c."result"::text)::text FROM "ai_run_change_sets" c WHERE c."owner_id" = $1 AND c."id" = ANY($2::uuid[]) AND c."result" IS NOT NULL`,
  sandbox_commands: () => `SELECT 'sandbox_commands:' || s."id"::text AS "resource_key", 'command' AS "copy_key", s."project_id"::text AS "project_id", octet_length(s."command")::text AS "byte_count"
    FROM "sandbox_commands" s WHERE s."owner_id" = $1 AND s."id" = ANY($2::uuid[])
    UNION ALL SELECT 'sandbox_commands:' || s."id"::text, 'args', s."project_id"::text, octet_length(s."args"::text)::text FROM "sandbox_commands" s WHERE s."owner_id" = $1 AND s."id" = ANY($2::uuid[])
    UNION ALL SELECT 'sandbox_commands:' || s."id"::text, 'summary', s."project_id"::text, octet_length(s."summary")::text FROM "sandbox_commands" s WHERE s."owner_id" = $1 AND s."id" = ANY($2::uuid[])
    UNION ALL SELECT 'sandbox_commands:' || s."id"::text, 'result', s."project_id"::text, octet_length(s."result"::text)::text FROM "sandbox_commands" s WHERE s."owner_id" = $1 AND s."id" = ANY($2::uuid[]) AND s."result" IS NOT NULL`,
  action_ledger_records: () => `SELECT 'action_ledger_records:' || a."id"::text AS "resource_key", 'reversible_fields' AS "copy_key", NULL::text AS "project_id", octet_length(a."reversible_fields"::text)::text AS "byte_count"
    FROM "action_ledger_records" a WHERE a."owner_id" = $1 AND a."id" = ANY($2::uuid[])
    UNION ALL SELECT 'action_ledger_records:' || a."id"::text, 'outcome', NULL::text, octet_length(a."outcome"::text)::text FROM "action_ledger_records" a WHERE a."owner_id" = $1 AND a."id" = ANY($2::uuid[])`,
  home_conversations: () => `SELECT 'home_conversations:' || h."id"::text AS "resource_key", 'title' AS "copy_key", NULL::text AS "project_id", octet_length(h."title")::text AS "byte_count"
    FROM "home_conversations" h WHERE h."owner_id" = $1 AND h."id" = ANY($2::uuid[])`,
  home_messages: () => `SELECT 'home_messages:' || m."id"::text AS "resource_key", 'content' AS "copy_key", NULL::text AS "project_id", octet_length(m."content")::text AS "byte_count"
    FROM "home_messages" m WHERE m."owner_id" = $1 AND m."id" = ANY($2::uuid[])`,
  home_change_proposal_items: () => `SELECT 'home_change_proposal_items:' || p."id"::text AS "resource_key", 'command' AS "copy_key", NULL::text AS "project_id", octet_length(p."command"::text)::text AS "byte_count"
    FROM "home_change_proposal_items" p WHERE p."owner_id" = $1 AND p."id" = ANY($2::uuid[])`
};

export async function scanContentIdentities(
  transaction: StorageQuotaTransaction,
  ownerId: string,
  identities: readonly StorageContentIdentity[]
): Promise<readonly StorageResourceReference[]> {
  const grouped = groupIdentities(identities);
  const rows: CanonicalRow[] = [];
  for (const [entity, ids] of grouped.ids) {
    if (entity === 'home_conversation_events') throw new TypeError('Home event identities must use their conversation sequence key.');
    const projection = PROJECTIONS[entity];
    if (ids.length === 0) continue;
    const result = await transaction.query(projection(ids), [ownerId, ids]);
    rows.push(...(result as CanonicalRow[]));
  }
  if (grouped.events.length > 0) {
    const eventRows = await transaction.query(
      `SELECT 'home_conversation_events:' || e."conversation_id"::text || ':' || e."sequence"::text AS "resource_key", 'payload' AS "copy_key", NULL::text AS "project_id", octet_length(e."payload"::text)::text AS "byte_count"
       FROM "home_conversation_events" e JOIN unnest($2::uuid[], $3::integer[]) AS wanted("conversation_id", "sequence")
         ON wanted."conversation_id" = e."conversation_id" AND wanted."sequence" = e."sequence"
       WHERE e."owner_id" = $1`,
      [ownerId, grouped.events.map((event) => event.id), grouped.events.map((event) => event.sequence)]
    );
    rows.push(...(eventRows as CanonicalRow[]));
  }
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

export async function readStoredContentReferences(
  transaction: StorageQuotaTransaction,
  ownerId: string,
  identities: readonly StorageContentIdentity[]
): Promise<readonly StorageResourceReference[]> {
  const pairs: { resourceKey: string; copyKey: string }[] = [];
  for (const identity of dedupeIdentities(identities)) {
    if (identity.entity === 'home_conversation_events') {
      pairs.push({ resourceKey: `${identity.entity}:${identity.id}:${identity.sequence}`, copyKey: 'payload' });
    } else {
      for (const copyKey of COPIES[identity.entity]) pairs.push({ resourceKey: `${identity.entity}:${identity.id}`, copyKey });
    }
  }
  if (pairs.length === 0) return [];
  const result = await transaction.query(
    `SELECT r."resource_key", r."copy_key", r."project_id", r."byte_count", r."root_key", r."relative_key", r."sha256"
     FROM "storage_resource_references" r
     JOIN unnest($2::text[], $3::text[]) AS wanted("resource_key", "copy_key")
       ON wanted."resource_key" = r."resource_key" AND wanted."copy_key" = r."copy_key"
     WHERE r."owner_id" = $1 AND r."resource_kind" = 'database_content'`,
    [ownerId, pairs.map((pair) => pair.resourceKey), pairs.map((pair) => pair.copyKey)]
  ) as StoredRow[];
  return result.map((row) => ({
    ownerId,
    kind: 'database_content',
    resourceKey: row.resource_key,
    copyKey: row.copy_key,
    bytes: BigInt(row.byte_count),
    projectId: row.project_id,
    rootKey: row.root_key,
    relativeKey: row.relative_key,
    sha256: row.sha256
  }));
}

function groupIdentities(identities: readonly StorageContentIdentity[]): {
  ids: Map<StorageContentEntity, string[]>;
  events: { id: string; sequence: number }[];
} {
  const ids = new Map<StorageContentEntity, string[]>();
  const events: { id: string; sequence: number }[] = [];
  for (const identity of dedupeIdentities(identities)) {
    if (identity.entity === 'home_conversation_events') {
      if (!Number.isSafeInteger(identity.sequence) || identity.sequence! <= 0) throw new TypeError('A Home event identity requires a positive sequence.');
      events.push({ id: identity.id, sequence: identity.sequence! });
      continue;
    }
    const values = ids.get(identity.entity) ?? [];
    values.push(identity.id);
    ids.set(identity.entity, values);
  }
  return { ids, events };
}

function dedupeIdentities(identities: readonly StorageContentIdentity[]): StorageContentIdentity[] {
  const map = new Map<string, StorageContentIdentity>();
  for (const identity of identities) {
    if (!Object.prototype.hasOwnProperty.call(COPIES, identity.entity)) throw new TypeError('The storage content entity is not supported.');
    if (!identity.id || identity.id.length > 128) throw new TypeError('A storage content identity is invalid.');
    const key = `${identity.entity}\u0000${identity.id}\u0000${identity.sequence ?? ''}`;
    map.set(key, identity);
  }
  return [...map.values()];
}
