# Contract: Canonical task deletion and archive removal

## Change History

- 2026-10-19: Created from release architecture sections 4.2 and 11, Task 4.2's implemented mutation/receipt contract, and the Task 1.1 and Task 5.3 delete interaction specifications.

## Ownership

- The authenticated session supplies the owner. Request bodies, task IDs, Home arguments, and event text never supply an owner or authorization decision.
- The tasks use case owns one canonical deletion command. Its transaction participant owns task row removal, collection ordering, and removal of reversible action content. Controllers only validate and map transport fields.
- The existing action ledger owns operation idempotency and receipts. A delete receipt is minimal and cannot be undone.
- Task 4.3 owns task archival/deletion behavior. Archived workspaces and conversations remain separate read-only states.
- Home direct deletion uses Task 4.2's persisted principal, turn, scope, policy and capability checks. The skills invocation gate and binding are owned by Task 6.2.

## Scope

- Add one owner-scoped, versioned delete for both Inbox tasks and workspace tasks.
- Remove task archive commands, task archive filters and task archived state from public request/response schemas, task domain transitions, and UI.
- Convert existing archived task rows without dropping their content. Preserve a metadata-only mapping for rollback.
- Reconcile task ordering, checklist/event references, accepted suggestion provenance, existing action receipts, operation replay, and version conflicts.
- Keep Task 5.3 editor/save/draft/navigation behavior out of scope. Current task list and detail surfaces use the existing delete confirmation pattern.

## Endpoints / Events

- DELETE /api/v1/tasks/{taskId} is the only task deletion endpoint. It requires an authenticated session, same-origin write check, CSRF token, If-Match task version, and Idempotency-Key.
- Remove DELETE /api/v1/projects/{workspaceId}/tasks/{taskId}; callers use the canonical global task path for assigned and unassigned tasks.
- Remove POST /api/v1/tasks/{taskId}/archive and home_archive_task.
- Add Home tool home_delete_task with taskId and expectedVersion. An explicit scoped chat request does not show a second confirmation dialog.
- A successful deletion and its task.delete action receipt commit in the existing action-ledger transaction. The receipt is not reversible. No deleted task content is copied into a task event or receipt.
- Deleting a task cascades its task-scoped event rows. The resolved suggestion that originally produced the task remains historical suggestion metadata; it is not reset or made pending again. The migration rollback map is intentionally retained after deletion so rollback can fail closed instead of recreating deleted content.

## Request Shapes

DELETE request headers:

- If-Match: one quoted positive task version, from 1 through 2,147,483,647.
- Idempotency-Key: 1 through 128 characters matching the existing API key alphabet.
- No request body.

Home tool:

- home_delete_task: taskId is a UUID and expectedVersion is a positive integer from 1 through 2,147,483,647. The server derives owner, turn, scope, policy, and stable operation key.

## Response Shapes

DELETE returns HTTP 200 with the existing data envelope:

- taskId: deleted task UUID.
- orderVersion: the incremented owner collection order version.
- receipt: minimal task.delete receipt metadata (id, actionKind, undoStatus, and bounded outcome fields).
- replayed: true only when this exact owner-scoped operation key already committed.

The receipt has actionKind task.delete, undoStatus not_reversible, targetId taskId, targetVersion null, and sourceOrderVersion orderVersion. It contains no task title, details, checklist, or reversible fields. An exact retry returns the same receipt and orderVersion without another deletion or order-version advance.

The Home tool returns the existing bounded immediate receipt result and replay flag. It does not return the deleted task body.

## Validation and Error Cases

- Invalid task UUID or headers return existing validation/precondition errors. Missing If-Match uses the existing task-version-required response.
- A task absent from the authenticated owner's scope returns the existing non-disclosing not-found response.
- An extant task with a stale If-Match returns the existing task-version conflict.
- Reusing an idempotency key with a different owner/action/target/version fingerprint returns the existing idempotency conflict.
- A concurrent second delete cannot recreate or restore the task. An exact owner/key/fingerprint retry returns the recorded receipt after current principal, Home policy, and bound-skill checks, without looking up the deleted task, mutating a workspace, or recording another event. A changed fingerprint or new key does not take this path; an unrelated operation after deletion receives the non-disclosing not-found response.
- Exact Home undo receipt replay follows the same no-effect rule after current principal, Home policy, and bound-skill checks. A task-create undo physically removes the child before workspace-create undo checks the existing empty-workspace guard; replaying the child undo never recreates it.
- A pre-existing task action receipt may no longer be undone after deletion. In the same delete transaction, prior task receipts lose reversible field values and become not_reversible while retaining minimal operation identity and outcome metadata. Undo of task.delete is unsupported.
- Home delete is denied when the task is missing, foreign, outside persisted scope, the current policy/capability is unavailable, or the expected version conflicts. Only the exact expected-version conflict follows Task 4.2's bounded VERSION_CONFLICT continuation; no success receipt is fabricated.

## Versioning / Compatibility Notes

- Migration 1710000036000 is registered immediately after 0035 skills; do not edit delivered migrations.
- Before conversion, store each legacy archived task's prior status, archived/completed/updated timestamps, version, and position in a metadata-only rollback map. Convert to done when completedAt is present and todo otherwise; preserve all task content. Bump converted task versions. Keep current task order, then append converted tasks deterministically by archived timestamp, prior position, creation timestamp, and task ID so unique collection-order indexes can be enforced for workspace and Inbox tasks.
- Remove task archivedAt and archived status storage after establishing the mapping. Task status filters no longer accept `archived`; `includeArchived` remains available to include tasks from archived workspaces.
- Migration rollback restores only mapped rows that still match their migration version and position. It fails closed if a mapped task has since changed or has been deleted. The rollback map remains after deletion, and rollback never recreates intentionally deleted content.
- Existing task.archive receipts remain readable as historical metadata, but migration marks them not_reversible and runtime undo no longer applies them. No public mutation, Home tool, or proposal command can create a new task archive action.
- No new operation store, proposal execution path, or task restoration path is introduced.

## Open Questions

- None. The operation envelope and migration rollback boundary follow existing task/action-ledger patterns and the release architecture.
