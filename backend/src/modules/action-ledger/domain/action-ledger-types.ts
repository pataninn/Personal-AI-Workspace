import { Buffer } from 'node:buffer';

import {
  ActionLedgerInputInvalidError,
  ActionLedgerMutationResultInvalidError
} from '@/modules/action-ledger/domain/action-ledger-errors';

export type ActionLedgerActorKind = 'manual' | 'assistant';
export type ActionLedgerTargetKind = 'task' | 'workspace';
export type ActionLedgerActionKind =
  | 'task.create'
  | 'task.update'
  | 'task.move'
  | 'task.reorder'
  | 'task.archive'
  | 'task.restore'
  | 'workspace.create'
  | 'workspace.update'
  | 'workspace.archive'
  | 'workspace.restore'
  | 'undo';
export type ActionLedgerUndoStatus = 'not_reversible' | 'available' | 'undone';
export type ActionLedgerJsonValue = string | number | boolean | null | readonly ActionLedgerJsonValue[] | ActionLedgerJsonObject;
export interface ActionLedgerJsonObject {
  readonly [key: string]: ActionLedgerJsonValue;
}

export interface ActionLedgerOutcome {
  readonly targetId: string;
  readonly targetVersion: number | null;
  readonly sourceOrderVersion?: number | null;
  readonly destinationOrderVersion?: number | null;
}

export type ActionLedgerReversibleFieldName =
  | 'title'
  | 'details'
  | 'status'
  | 'position'
  | 'projectId'
  | 'importance'
  | 'deadline'
  | 'archivedAt'
  | 'completedAt'
  | 'subtasks'
  | 'name'
  | 'objective';

export interface ActionLedgerReversibleField {
  readonly before: ActionLedgerJsonValue;
  readonly after: ActionLedgerJsonValue;
}

export type ActionLedgerReversibleFields = Readonly<Partial<Record<ActionLedgerReversibleFieldName, ActionLedgerReversibleField>>>;

export interface ActionLedgerExecutionInput {
  readonly ownerId: string;
  readonly operationKey: string;
  readonly requestFingerprint: string;
  readonly actorKind: ActionLedgerActorKind;
  readonly turnId: string | null;
  readonly targetKind: ActionLedgerTargetKind;
  readonly targetId: string;
  readonly actionKind: ActionLedgerActionKind;
  readonly expectedVersion: number | null;
  readonly undoOfActionId: string | null;
}

export interface ActionLedgerMutationResult {
  readonly preVersion: number | null;
  readonly postVersion: number | null;
  readonly reversibleFields: ActionLedgerReversibleFields;
  readonly outcome: ActionLedgerOutcome;
  readonly undoStatus: 'not_reversible' | 'available';
}

export interface ActionLedgerRecord extends ActionLedgerExecutionInput {
  readonly id: string;
  readonly preVersion: number | null;
  readonly postVersion: number | null;
  readonly reversibleFields: ActionLedgerReversibleFields;
  readonly outcome: ActionLedgerOutcome;
  readonly undoStatus: ActionLedgerUndoStatus;
  readonly undoActionId: string | null;
  readonly createdAt: string;
}

export interface PersistedActionLedgerRecord {
  readonly record: ActionLedgerRecord;
  readonly replayed: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVERSIBLE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'title', 'details', 'status', 'position', 'projectId', 'importance', 'deadline', 'archivedAt', 'completedAt', 'subtasks', 'name', 'objective'
]);
const MAX_REVERSIBLE_FIELDS_JSON_BYTES = 81920;
const MAX_OUTCOME_JSON_BYTES = 4096;
const MAX_DATABASE_INTEGER = 2147483647;

/** Validates owner-scoped action identity before repository I/O. */
export function assertActionLedgerExecutionInput(input: ActionLedgerExecutionInput): void {
  assertUuid(input.ownerId, 'ownerId');
  assertBoundedText(input.operationKey, 200, 'operationKey');
  assertBoundedText(input.requestFingerprint, 256, 'requestFingerprint');
  assertUuid(input.targetId, 'targetId');
  if (input.turnId !== null) {
    assertUuid(input.turnId, 'turnId');
  }
  if (input.actorKind === 'manual' && input.turnId !== null) {
    throw new ActionLedgerInputInvalidError('Manual actions must not invent or attach an assistant turn.');
  }
  if (input.actionKind !== 'undo' && input.undoOfActionId !== null) {
    throw new ActionLedgerInputInvalidError('Only an undo action may reference an original action.');
  }
  if (input.actionKind === 'undo' && input.undoOfActionId === null) {
    throw new ActionLedgerInputInvalidError('An undo action must reference the action it reverses.');
  }
  if (input.undoOfActionId !== null) {
    assertUuid(input.undoOfActionId, 'undoOfActionId');
  }
  if (input.actionKind.startsWith('task.') && input.targetKind !== 'task') {
    throw new ActionLedgerInputInvalidError('Task actions must target a task.');
  }
  if (input.actionKind.startsWith('workspace.') && input.targetKind !== 'workspace') {
    throw new ActionLedgerInputInvalidError('Workspace actions must target a workspace.');
  }
  assertVersion(input.expectedVersion, 'expectedVersion');
}

/** Validates the receipt values returned after an owner repository applies its mutation. */
export function assertActionLedgerMutationResult(
  input: ActionLedgerExecutionInput,
  result: ActionLedgerMutationResult
): void {
  assertVersion(result.preVersion, 'preVersion');
  assertVersion(result.postVersion, 'postVersion');
  if (input.expectedVersion !== null && result.preVersion !== input.expectedVersion) {
    throw new ActionLedgerMutationResultInvalidError();
  }
  if (result.preVersion !== null && result.postVersion !== null && result.postVersion <= result.preVersion) {
    throw new ActionLedgerMutationResultInvalidError();
  }
  assertActionLedgerOutcome(input, result.outcome);
  if (result.undoStatus !== 'not_reversible' && result.undoStatus !== 'available') {
    throw new ActionLedgerMutationResultInvalidError();
  }
  if (input.actionKind === 'undo' && result.undoStatus !== 'not_reversible') {
    throw new ActionLedgerMutationResultInvalidError();
  }
  assertReversibleFields(result.reversibleFields);
}

/** Validates owner/operation identity for a read without exposing cross-owner records. */
export function assertActionLedgerOperationIdentity(ownerId: string, operationKey: string): void {
  assertUuid(ownerId, 'ownerId');
  assertBoundedText(operationKey, 200, 'operationKey');
}

/** Validates owner-scoped lookup identity without accepting an arbitrary SQL identifier. */
export function assertActionLedgerRecordIdentity(ownerId: string, actionId: string): void {
  assertUuid(ownerId, 'ownerId');
  assertUuid(actionId, 'actionId');
}

function assertUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new ActionLedgerInputInvalidError(`${field} must be a UUID.`);
  }
}

function assertBoundedText(value: string, maxLength: number, field: string): void {
  if (value.trim().length === 0 || value.length > maxLength) {
    throw new ActionLedgerInputInvalidError(`${field} must be non-empty and at most ${maxLength} characters.`);
  }
}

function assertVersion(value: number | null, field: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value <= 0 || value > MAX_DATABASE_INTEGER)) {
    throw new ActionLedgerInputInvalidError(`${field} must be a positive safe integer or null.`);
  }
}

function assertReversibleFields(value: ActionLedgerReversibleFields): void {
  if (!isPlainObject(value)) {
    throw new ActionLedgerInputInvalidError('reversibleFields must be an object.');
  }
  for (const [field, entry] of Object.entries(value)) {
    if (!REVERSIBLE_FIELD_NAMES.has(field) || !isPlainObject(entry) || Object.keys(entry).length !== 2 || !('before' in entry) || !('after' in entry)) {
      throw new ActionLedgerInputInvalidError('reversibleFields may contain only changed allowlisted fields with before and after values.');
    }
    if (!isJsonValue(entry.before) || !isJsonValue(entry.after)) {
      throw new ActionLedgerInputInvalidError('reversibleFields must contain JSON values.');
    }
  }
  assertJsonSize(value, MAX_REVERSIBLE_FIELDS_JSON_BYTES, 'reversibleFields');
}

function assertActionLedgerOutcome(input: ActionLedgerExecutionInput, value: ActionLedgerOutcome): void {
  if (!isPlainObject(value) || !Object.values(value).every((entry) => isJsonValue(entry))) {
    throw new ActionLedgerInputInvalidError('outcome must be a JSON object.');
  }
  const allowedFields = new Set(['targetId', 'targetVersion', 'sourceOrderVersion', 'destinationOrderVersion']);
  if (Object.keys(value).some((field) => !allowedFields.has(field)) || value.targetId !== input.targetId) {
    throw new ActionLedgerInputInvalidError('outcome may contain only the saved target and version metadata.');
  }
  assertVersion(value.targetVersion, 'outcome.targetVersion');
  assertVersion(value.sourceOrderVersion ?? null, 'outcome.sourceOrderVersion');
  assertVersion(value.destinationOrderVersion ?? null, 'outcome.destinationOrderVersion');
  assertJsonSize(value, MAX_OUTCOME_JSON_BYTES, 'outcome');
}

function assertJsonSize(value: object, maxBytes: number, field: string): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ActionLedgerInputInvalidError('JSON fields must be serializable.');
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new ActionLedgerInputInvalidError(`${field} must not exceed ${maxBytes} bytes.`);
  }
}

function isJsonValue(value: unknown, depth = 0): value is ActionLedgerJsonValue {
  if (depth > 16) {
    return false;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  return isPlainObject(value) && Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
