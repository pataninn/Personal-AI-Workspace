# Contract: Enforce Ownership Across APIs, Tools, Storage, and Streams

## Change History

- 2026-10-19: Initial Task 2.2 contract. This records the externally observable ownership, workspace, and late-work rules before application changes.

## Ownership

- The signed-in session principal is the only authority for interactive requests. A caller-provided owner/account ID, model argument, project ID, or event cursor never establishes ownership.
- Background work may act only for a persisted run/job whose owner and workspace relationship are reloaded from trusted storage. A browser/model-supplied identity is never copied into a job as authority.
- A live SSE connection is session-bound: before private delivery it revalidates both current account status and the exact session that opened the stream. Revoking or expiring that session closes the stream even if the account remains active. Browser-session revocation does not cancel an already-persisted background job by itself; the job uses its trusted persisted run/account scope and rechecks current account status at its own durable boundaries.
- The reserved legacy `/workspace` mapping is bound to the persisted immutable user identity whose `scope_key` is `local`. The editable sign-in identifier `owner` is never used to select or transfer that mapping. Database constraints prevent changing the local scope to another account or assigning it to another account.
- Admin role grants account administration only; it does not widen project, file, tool, event, or run visibility.
- All resources, child relationships, and storage scopes are checked against the same principal. Foreign and missing resource identifiers use the existing indistinguishable not-found behavior.

## Scope

- Apply one reusable application authorization policy across project, task, conversation, fact, AI run, history, change-set, sandbox command, action/event, and workspace-file access.
- Add database relationship constraints where practical so a child cannot reference a parent owned by a different account or workspace, even if a use-case check is bypassed.
- Allocate file-backed workspace roots on the server from authenticated account and project identity. The caller cannot select or attach an arbitrary path. New roots for every account, including the bootstrap owner, live under `/account-workspaces/<account-namespace>/projects/<project-id>`; pre-existing bootstrap-owner projects retain their original `relativeRoot` under the reserved `/workspace` mapping.
- Persist each project's storage kind so legacy and managed roots resolve only against their corresponding fixed mount. Require an operator-provisioned persistent account-workspaces mount with a verified identity marker; never fall back to `/workspace` or create an unconfigured root.
- Preserve current path normalization, containment, symlink/reparse-point checks, protected paths, OpenShell containment, redaction, command validation, staging, and promotion safeguards.
- Revalidate account/session activity for interactive requests, and project ownership/status plus persisted run/job authority at tool dispatch and each durable output/promotion boundary. For direct-provider fetch and Hermes bridge creation, the persisted active-principal check (using the database clock in the TypeORM adapter) is the dispatch admission boundary: a disable or expiry committed before that check suppresses dispatch. If the check succeeds first, that one external dispatch is treated as in flight; the check and external send are not claimed to be transactionally serialized. Recheck before each later dispatch and durable output/promotion, and never hold an account-row lock across provider inference.
- Revalidate both account and connected-session activity on an open event stream. Close or stop delivery as soon as either is invalid; do not continue streaming buffered or newly published private events.
- The public project representation no longer includes `relativeRoot` or another host-path/storage-namespace label. File capability is represented by `workspaceMode` and `capabilities.fileAccess`.

## Endpoints / Events

- `POST /api/v1/projects` remains the project creation endpoint. It accepts a name, optional objective, and optional workspace mode. File-backed mode is the default. The server allocates its root.
- `PATCH /api/v1/projects/:projectId/root-attachment` remains available for a legacy planning-only project. Its request has no path field; the server allocates a managed root after checking the authenticated principal and project. This route is not exposed as an attachment control in the UI in this task.
- `GET /api/v1/projects`, `GET /api/v1/projects/:projectId`, project search/reuse, task/conversation/memory/run/history/file endpoints, and event replay/stream endpoints remain principal-scoped.
- Existing SSE event names and payloads remain unchanged for authorized streams. When the principal becomes inactive, the connection stops receiving events and closes without returning foreign-account state.
- Tool invocation and output promotion are internal application boundaries. They accept a trusted persisted principal/run scope, not authority fields from model-generated arguments.

## Request Shapes

Project creation:

```json
{
  "name": "Project name",
  "workspaceMode": "file_backed",
  "objective": "Optional planning objective"
}
```

- `workspaceMode` is `file_backed` or `planning`; omission defaults to `file_backed`.
- `relativeRoot` and all host-path/root-selection fields are rejected as unknown input.
- A planning project has no file capability. A file-backed project gets a server-managed root. If the managed mount is unavailable, allocation fails with a retryable generic storage error and the response reports no file capability for existing managed projects.
- The legacy root-attachment request has an empty JSON object body. A path field is rejected.
- Existing request version and idempotency requirements on mutations remain in force.

## Response Shapes

Project responses retain their current project metadata and include:

```json
{
  "id": "uuid",
  "name": "Project name",
  "slug": "project-name",
  "objective": null,
  "workspaceMode": "file_backed",
  "capabilities": { "planning": true, "fileAccess": true },
  "status": "active",
  "version": 1,
  "createdAt": "ISO-8601 timestamp",
  "updatedAt": "ISO-8601 timestamp"
}
```

- `relativeRoot`, account namespace, host path, and a derived path label are omitted from all public project responses.
- File navigation and capabilities are rendered from `capabilities.fileAccess`, not from a path string.
- Unauthorized and nonexistent resources return the same existing not-found envelope and status.
- Existing error envelopes remain unchanged. Authorization checks must not reveal whether an identifier belongs to another account.

## Validation and Error Cases

- Invalid body shape, including a caller-supplied path, returns the existing `VALIDATION_ERROR` envelope.
- Unknown or foreign resource IDs return the resource's existing indistinguishable not-found error without revealing foreign ownership. Malformed IDs retain each endpoint's existing validation behavior.
- Disabled/expired principals are rejected using the existing session/authentication failure contract before new reads or mutations. Long-running operations and streams recheck current status at their next boundary.
- A missing, archived, wrong-owner, or file-disabled project cannot be used for project-scoped file access, run output, or mutation.
- Roots are generated server-side and checked against both reserved legacy storage and every existing managed root. Traversal, absolute paths, drive aliases, symlinks, reparse points, case/Unicode aliases, protected paths, and cross-root overlap remain rejected.
- Invalid cross-owner or cross-project child references fail application validation and database constraints; transaction failure leaves no partial child or event rows.
- Output produced after principal disablement/expiry or loss of run authority is not promoted and is not delivered or persisted as assistant content, task suggestions, file-change receipts, or private run-event payloads. Internal cancellation, cleanup, provider-usage/reconciliation, and review metadata may still be recorded when required to stop work safely and reconcile an already-issued provider call; these records do not authorize further output.
- Event subscribers stop when the principal is no longer active; event IDs/cursors do not bypass owner checks.

## Versioning / Compatibility Notes

- The existing immutable UUID user primary key supplies each account's managed storage namespace; the editable login identifier is never used in path resolution. Database migration preserves the bootstrap-owner identity and marks pre-existing projects owned by that identity as legacy while preserving their existing path mapping and data. It must fail closed if non-owner legacy roots exist and a safe mapping cannot be proven; it must not move or delete user files implicitly.
- Existing records and historical run roots remain readable only through their owning account's validated mapping. Public API clients must stop relying on `relativeRoot` and use `workspaceMode`/`capabilities.fileAccess`.
- Project creation clients that previously supplied `relativeRoot` must send only project data and mode. Unknown path fields are rejected rather than honored or silently attached.
- Existing active sessions retain their principal identity; current account disablement/expiry is checked from persisted state and cannot be bypassed by a still-open cookie or run.
- The account namespace, storage kind, fixed mount paths, and resolved root are internal persistence/runtime details and never appear in project DTOs or UI.

## Open Questions

- None. The physical root mapping uses the isolated `/account-workspaces` mount for all new roots and preserves existing bootstrap-owner project roots under `/workspace`.
