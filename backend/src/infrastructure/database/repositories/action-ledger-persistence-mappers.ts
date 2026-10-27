import { ActionLedgerPersistenceInvariantError } from '@/modules/action-ledger/domain/action-ledger-errors';
import type {
  ActionLedgerActionKind,
  ActionLedgerActorKind,
  ActionLedgerOutcome,
  ActionLedgerRecord,
  ActionLedgerReversibleFields,
  ActionLedgerTargetKind,
  ActionLedgerUndoStatus
} from '@/modules/action-ledger/domain/action-ledger-types';

export interface ActionLedgerRow {
  readonly id: string;
  readonly owner_id: string;
  readonly operation_key: string;
  readonly request_fingerprint: string;
  readonly actor_kind: string;
  readonly turn_id: string | null;
  readonly target_kind: string;
  readonly target_id: string;
  readonly action_kind: string;
  readonly expected_version: number | string | null;
  readonly pre_version: number | string | null;
  readonly post_version: number | string | null;
  readonly reversible_fields: unknown;
  readonly outcome: unknown;
  readonly undo_status: string;
  readonly undo_of_action_id: string | null;
  readonly undo_action_id: string | null;
  readonly created_at: Date | string;
}

/** Maps a PostgreSQL row only after checking its persisted enum and JSON values. */
export function toActionLedgerRecord(row: ActionLedgerRow): ActionLedgerRecord {
  const actorKind = parseEnum(row.actor_kind, ['manual', 'assistant'] as const);
  const targetKind = parseEnum(row.target_kind, ['task', 'workspace'] as const);
  const actionKind = parseEnum(row.action_kind, [
    'task.create', 'task.update', 'task.move', 'task.reorder', 'task.archive', 'task.delete', 'task.restore',
    'workspace.create', 'workspace.update', 'workspace.archive', 'workspace.restore', 'undo'
  ] as const);
  const undoStatus = parseEnum(row.undo_status, ['not_reversible', 'available', 'undone'] as const);
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString();
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new ActionLedgerPersistenceInvariantError();
  }
  return {
    id: row.id,
    ownerId: row.owner_id,
    operationKey: row.operation_key,
    requestFingerprint: row.request_fingerprint,
    actorKind,
    turnId: row.turn_id,
    targetKind,
    targetId: row.target_id,
    actionKind,
    expectedVersion: parseVersion(row.expected_version),
    preVersion: parseVersion(row.pre_version),
    postVersion: parseVersion(row.post_version),
    reversibleFields: parseReversibleFields(row.reversible_fields),
    outcome: parseOutcome(row.outcome),
    undoStatus,
    undoOfActionId: row.undo_of_action_id,
    undoActionId: row.undo_action_id,
    createdAt
  };
}

function parseEnum<const T extends readonly string[]>(value: string, allowed: T): T[number] {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ActionLedgerPersistenceInvariantError();
  }
  return value as T[number];
}

function parseVersion(value: number | string | null): number | null {
  if (value === null) {
    return null;
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new ActionLedgerPersistenceInvariantError();
  }
  return version;
}

function parseOutcome(value: unknown): ActionLedgerOutcome {
  if (!isPlainObject(value)) {
    throw new ActionLedgerPersistenceInvariantError();
  }
  const allowed = new Set(['targetId', 'targetVersion', 'sourceOrderVersion', 'destinationOrderVersion']);
  if (Object.keys(value).some((field) => !allowed.has(field)) || typeof value.targetId !== 'string') {
    throw new ActionLedgerPersistenceInvariantError();
  }
  const targetVersion = parseVersion(value.targetVersion as number | string | null);
  const sourceOrderVersion = value.sourceOrderVersion === undefined ? undefined : parseVersion(value.sourceOrderVersion as number | string | null);
  const destinationOrderVersion = value.destinationOrderVersion === undefined ? undefined : parseVersion(value.destinationOrderVersion as number | string | null);
  return {
    targetId: value.targetId,
    targetVersion,
    ...(sourceOrderVersion === undefined ? {} : { sourceOrderVersion }),
    ...(destinationOrderVersion === undefined ? {} : { destinationOrderVersion })
  };
}

function parseReversibleFields(value: unknown): ActionLedgerReversibleFields {
  if (!isPlainObject(value)) {
    throw new ActionLedgerPersistenceInvariantError();
  }
  for (const entry of Object.values(value)) {
    if (!isPlainObject(entry) || Object.keys(entry).length !== 2 || !('before' in entry) || !('after' in entry)) {
      throw new ActionLedgerPersistenceInvariantError();
    }
  }
  return value as ActionLedgerReversibleFields;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
