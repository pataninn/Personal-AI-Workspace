# Contract: Bounded workspace export

## Change History

- 2026-10-20: Initial implementation contract from the accepted architecture preflight and UI spec. Task 7.1 was delivered before implementation.
- 2026-10-20: Refreshed after inspecting the delivered project-removal and demo-expiry barriers. Task 6.4 adds exact export-ID capture to those existing barriers and requires builders to reach a confirmed terminal state before any artifact unlink or workspace/owner purge.
- 2026-10-20: Refreshed from the bounded pre-review: scan the complete structured projection with the existing `containsPotentialSecret` helper and fail the whole export with `422 EXPORT_CONTENT_UNSAFE` when a recognized credential pattern appears; use PostgreSQL `clock_timestamp()` for ready-key replay and download expiry comparisons.
- 2026-10-20: QA1 repair clarification: the same recognized-secret error applies to permitted file bytes (`422 EXPORT_CONTENT_UNSAFE`); direct `captureForExport` tests exercise a bounded temporary workspace, while Linux descriptor/no-follow and platform-specific reparse behavior are reported only for hosts where those primitives are available.

- 2026-10-20: Startup cleanup uses PostgreSQL `clock_timestamp()` to confirm a ready artifact is expired before unlinking; application host time cannot unlink a still-live export.

## Ownership

Task 6.4 owns the backend `workspace-exports` module, its owner-scoped snapshot and artifact lifecycle ports/adapters, one additive metadata migration, authenticated routes and OpenAPI definitions, the `/usage` export feature, and focused unit/integration/browser coverage. It reuses the existing owned-workspace list and usage/storage surfaces. Task 6.4 extends the existing `project_removal_jobs` row with an exact `export_ids` list and adds `exportIds` to the existing demo-expiry cleanup manifest. No parallel cleanup service or general generation framework is introduced. Task 6.4 does not own provider calls, account usage, storage quota accounting, import/restore, or schedule execution.

## Scope

Create one synchronous, short-lived JSON download for one active, mutable workspace owned by the authenticated principal. The frontend selects a candidate from the existing authenticated `GET /api/v1/projects` response (with archived projects excluded); that list is advisory. The create use case rechecks ownership, active status, account/session validity, editability, demo expiry, and absence of a workspace-removal barrier.

Keep the current `/usage`, account-usage, and account-storage behavior. No export list/management UI, import/restore, ZIP format, generic job framework, or provider request is introduced. Export artifacts do not consume AI credits or persistent logical storage quota.

### Portable JSON v1

The complete document is UTF-8 JSON with this exact top-level shape:

```json
{
  "manifest": {
    "format": "personal-ai-workspace-export",
    "version": 1,
    "createdAt": "2026-10-20T12:00:00.000Z",
    "databaseSnapshotAt": "2026-10-20T12:00:00.000Z",
    "filesReadStartedAt": "2026-10-20T12:00:00.000Z",
    "filesReadCompletedAt": "2026-10-20T12:00:01.000Z"
  },
  "workspace": { "id": "uuid", "name": "Workspace", "objective": null },
  "files": [
    { "path": "src/main.ts", "encoding": "base64", "sizeBytes": 12, "sha256": "64 lowercase hex characters", "content": "..." }
  ],
  "tasks": [],
  "memory": { "facts": [], "context": { "relativePaths": [], "factIds": [], "includeProjectConversations": true, "excludedPaths": [] } },
  "conversations": { "project": [], "home": [] },
  "skills": [],
  "schedules": []
}
```

All dates are ISO-8601 UTC strings. The database fields come from explicit owner/workspace-scoped projections read in one read-only repeatable-read snapshot. The manifest timestamps make clear that filesystem capture is separate and is not an atomic cross-database/filesystem snapshot.

Projection rules:

- `workspace` contains only `id`, `name`, and `objective`; never owner IDs, host paths, relative mount roots, or storage-kind internals.
- `files` contains every permitted regular file under the verified workspace root as a normalized workspace-relative path, raw byte size, SHA-256 digest, and base64 bytes. Preserve binary content exactly. Never silently skip an unreadable, changed, unsafe, or omitted entry.
- `tasks` contains every current task row for the workspace: `id`, `title`, `details`, `status`, `importance`, `deadline`, ordered `subtasks` (`id`, `title`, `completed`), `position`, `version`, user-facing `source` (`kind`, `label`, `acceptedAt`), `createdAt`, `updatedAt`, and `completedAt`. Migration `1710000036000` normalizes legacy archived tasks back into the current `project_tasks` status set, so the export includes those current rows without querying action receipts or ledger/event history. Do not export task suggestions, action receipts, AI-run records, or ledger/event data.
- `memory.facts` contains active workspace facts only: `id`, `key`, `title`, `content`, `version`, `verificationStatus`, `verifiedAt`, `createdAt`, and `updatedAt`. `memory.context` contains the persisted project chat-context settings only: `relativePaths`, `factIds`, `includeProjectConversations`, and `excludedPaths`; omit computed available paths and filesystem/internal flags.
- `conversations.project` contains transcript-only project conversations owned by this workspace. `conversations.home` contains transcript-only Home conversations whose persisted scope is this workspace. Each conversation projection has `id`, `title`, `createdAt`, `updatedAt`, and ordered `messages`; each message has `id`, `turnId`, `sequence`, `role`, `content`, and `createdAt`. Include user/assistant transcript messages only. Exclude account-wide Home conversations, other workspaces, event logs, provider requests, consent internals, and tool/runtime payloads.
- `skills` contains enabled or disabled skills explicitly bound to this workspace, using `id`, `title`, `instructions`, `declaredTools`, `enabled`, `version`, `createdAt`, and `updatedAt`. Exclude account-wide skills, owner IDs, revision-internal IDs, invocation data, and invocation context.
- `schedules` contains current definitions bound to this workspace: `id`, `conversationId`, `skillId`, `skillVersion`, `localTime`, `timeZone`, `enabled`, `revision`, `createdAt`, and `updatedAt`. Exclude owner/workspace IDs already represented by the document scope, derived `nextDueAt`, occurrence/run history, lease/fence fields, idempotency digests, and invocation internals. Schedule run history remains in its existing Home transcript.

Preserve record IDs, task/fact/skill versions, task order, checklist order/completion, message sequence values, and schedule revisions where present. Do not include provider/session credentials, account-wide data, another workspace's content, recovery trees, host paths, audit/security/action logs, quota/credit records, or any export lifecycle metadata. Run the existing `containsPotentialSecret` helper over the complete structured projection before artifact creation and use the same existing helper at the file boundary. If a recognized pattern appears, fail the whole export with `422 EXPORT_CONTENT_UNSAFE`; do not redact or silently drop individual values or rows. This limited pattern check does not detect arbitrary secrets a user typed into ordinary content.

Startup reconciliation unlinks a ready artifact only when its conditional `clock_timestamp()` expiry update succeeds. If PostgreSQL still considers it live, the file remains available even when the API host clock is ahead.

### Bounds and file boundary

- At most 1,000 regular files, 8 MiB per file, and 16 MiB total raw file bytes.
- At most 8 MiB of structured JSON data and 32 MiB of final serialized JSON. Enforce database row/page and serialization bounds; exceeding a bound fails the whole export with `413 EXPORT_TOO_LARGE`.
- One 60-second create deadline. Deadline exhaustion also fails closed with `413 EXPORT_TOO_LARGE`; remove partial bytes and do not publish a ready artifact.
- Add one narrow export enumeration/read operation at the existing file/workspace boundary. Do not treat `WorkspaceGateway.tree()` as complete. Derive the root only from the owner-scoped persisted workspace; reuse `WorkspaceRelativePath`, protected segment/name checks, storage-kind checks, canonical root containment, regular-file checks, reparse/symlink rejection, and no-follow reads. Never accept a client path or persist an absolute path.
- Unsafe, protected, changed, unreadable, or incomplete traversal fails the whole export. Only normalized relative paths appear in the document. Exclude protected secret/config/recovery names and known credential material through existing helpers.

### Temporary artifact lifecycle

Persist lifecycle metadata only; never store document bytes or an absolute filesystem path in PostgreSQL. The metadata row contains generated artifact UUID, owner/workspace IDs, lifecycle state, creation/expiry timestamps, byte count, the captured demo-cleanup generation when applicable, and SHA-256 digests of the idempotency key and canonical request fingerprint. The key digest is unique per owner. An additive migration is needed after the delivered Task 7.1 and Task 7.2 migrations; Task 7.2 owns `0039`, and Task 6.4 owns `0040`.

The private artifact adapter derives the path as `<private os.tmpdir() directory>/workspace-exports/<artifact UUID>.json`; it never accepts a client path or stores that path in the row. Create an exclusive private `.part` file with no-follow/exclusive semantics, stream bounded bytes, fsync/close, then atomically rename within the private directory. Mark the row `ready` only after the final database cleanup/owner/workspace fence succeeds. The 15-minute TTL begins at successful publication. Set download responses to `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

Count both in-progress builders and unexpired ready artifacts toward a maximum of two per owner. PostgreSQL `clock_timestamp()` is authoritative for publication TTL, active-ready counts, ready-key replay, and download expiry checks; application host time must not decide whether a DB-expiring artifact is still available. Failed, interrupted, expired, missing, or cleanup-fenced artifacts are never downloadable. Normal builder completion records a terminal lifecycle state only after any in-flight file operation has settled and partial/final output is safely removed or atomically published. A deadline timeout by itself never makes a writer terminal: if a builder has not safely stopped, cleanup remains pending and must not unlink its file or continue a workspace/owner purge. Startup reconciliation removes orphan partial files, marks provably abandoned `building` rows failed, and marks ready rows with missing files unavailable; it must not infer writer death from age alone. Cleanup is idempotent. A bounded 24-hour digest-only idempotency tombstone may remain after file expiry so an expired key cannot silently create a second artifact; remove it after that retention window. No artifact history or deletion control is exposed to the user.

Demo expiry and workspace removal must fence builders before publication, capture exact export IDs in their existing cleanup scope, wait until in-progress writes are confirmed terminal, unlink only those generated artifacts, and finalize the owner/workspace purge only after the unlink is confirmed. Workspace removal captures the export IDs while holding the existing project/removal locks and stores them on that project's existing `project_removal_jobs` row. A builder first locks the owner/workspace in the existing order, checks for removal/demo-expiry barriers, and inserts its `building` row in the same short transaction before file I/O; removal cannot miss a committed builder and a builder cannot register behind a committed barrier. Demo expiry captures the owner's exact export IDs into `manifest.exportIds` under the existing admission/owner fence and binds them to the cleanup row's existing `generation`. A builder captures the current cleanup generation (null when no demo cleanup exists), and before publication rechecks active owner/workspace, removal barrier, and unchanged demo-cleanup generation. Cleanup and publish use short database transactions; do not hold row locks while enumerating or writing files. Removal/expiry cleanup waits for every captured `building` row to become terminal before unlinking; a wait timeout records/retries pending cleanup without deleting metadata, unlinking a possibly active file, or proceeding with the workspace/owner purge. Startup reconciliation may mark a builder terminal only when it can prove the prior writer is gone; a timeout or stale timestamp alone is insufficient. Download repeats owner, active account/session, workspace, expiry, removal-barrier, and demo-cleanup-generation checks before opening the file. No financial ledger, credit, quota, or storage accounting rows are modified by export cleanup.

The private temporary directory is local to the application container; restart may remove a still-listed artifact. Detect this as unavailable, never regenerate it during GET, and let the user prepare a new export.

## Endpoints / Events

All JSON responses use the existing `{ "data": ..., "error": ... }` envelope. Errors use the existing `{ "data": null, "error": { "code", "message" } }` envelope and do not expose paths or filesystem details.

| Method and path | Auth / CSRF | Behavior |
| --- | --- | --- |
| `GET /api/v1/projects` | Existing authenticated session | Existing owned-workspace candidate list; no new workspace-list endpoint. The server remains authoritative when creating an export. |
| `POST /api/v1/workspace-exports` | Active owner session, same-origin and CSRF checks | Synchronously create one bounded artifact. Requires `Idempotency-Key`. New successful create returns `201`; exact ready replay returns `200`. |
| `GET /api/v1/workspace-exports/{exportId}` | Active owner session; GET has no CSRF requirement | Reauthorize and stream one ready artifact as `application/json` attachment. All missing/foreign/expired/removed/unavailable IDs have the same non-enumerating `404 WORKSPACE_EXPORT_UNAVAILABLE`. |

No status-polling, list, or delete endpoint is added. The download uses a server-derived filename `workspace-export-{exportId}.json`; it does not include a host path or untrusted workspace name.

## Request Shapes

`POST /api/v1/workspace-exports` requires JSON with exactly one property:

```json
{ "workspaceId": "<UUID>" }
```

Reject unknown properties, missing/invalid UUIDs, non-JSON bodies, and malformed `Idempotency-Key`. Match the current automation key format: 8–128 ASCII characters from `[A-Za-z0-9._~-]`. The owner ID comes exclusively from the authenticated session; the request cannot choose owner, filename, path, export format/version, include list, size limits, or expiry.

`GET /api/v1/workspace-exports/{exportId}` takes one UUID path parameter and no body. It is not an artifact-existence probe: authorization and lifecycle failures share the same public unavailable response.

## Response Shapes

New create (`201`) and exact ready replay (`200`) return:

```json
{
  "data": {
    "export": {
      "id": "<artifact UUID>",
      "workspaceId": "<workspace UUID>",
      "sizeBytes": 1234,
      "expiresAt": "<ISO-8601 UTC>"
    }
  },
  "error": null
}
```

`sizeBytes` is final serialized JSON bytes. `expiresAt` is the absolute server-generated expiry. The TTL begins only after successful publication. Do not return owner IDs, cleanup tokens, digests, filesystem paths, or document bytes in the JSON response.

Successful download returns the exact JSON bytes with `Content-Type: application/json; charset=utf-8`, `Content-Disposition: attachment; filename="workspace-export-{id}.json"`, `Content-Length`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. Denial errors remain JSON envelopes and must be sent before opening the artifact.

## Validation and Error Cases

- `400 VALIDATION_ERROR`: invalid strict body, UUID, key syntax, or JSON shape.
- `401 SESSION_UNAUTHENTICATED` / existing authentication error: no valid active session; existing session middleware remains authoritative for disabled or expired principals and clears cookies as it does today.
- `403` existing same-origin/CSRF errors: invalid write origin/token. Download remains authenticated and same-site through the existing session cookie.
- `404 WORKSPACE_UNAVAILABLE`: workspace missing, foreign, archived, non-mutable, demo-expired, or already entering removal. Do not distinguish workspace ownership or removal state.
- `404 WORKSPACE_EXPORT_UNAVAILABLE`: missing, foreign, expired, removed, cleanup-fenced, or missing-on-disk artifact; do not reveal whether another owner's artifact exists.
- `422 EXPORT_CONTENT_UNSAFE`: a string in the structured projection or permitted file bytes matches the existing bounded known-secret helper. Fail the whole export without returning or rewriting any workspace content; the user can remove the credential-like text and retry with a new idempotency key.
- `409 IDEMPOTENCY_KEY_REUSED`: an owner reused a key for a different canonical request/workspace. `409 EXPORT_IN_PROGRESS`: the exact key/request already has a builder; retry the same request/key. An expired/failed tombstone requires a new key and never silently starts a second create.
- `413 EXPORT_TOO_LARGE`: any file/count/structured/final-document/deadline bound is exceeded. Remove partial output and publish nothing.
- `429 EXPORT_LIMIT_REACHED`: two building or unexpired ready artifacts already exist for the owner. Do not expose another user's count or add a management action.
- `500 EXPORT_FAILED`: safe generic response for enumeration, consistency, serialization, or artifact-store failure. Keep diagnostics server-side; remove partial output and ensure no ready artifact remains.

An exact idempotency replay returns the same descriptor only while its artifact is ready and still authorized. Changed fingerprints never replay. PostgreSQL clock time decides whether a replay is expired; after expiry, a retained digest-only tombstone returns an expired-key conflict and requires a new key. Tombstones are removed after 24 hours. A retry while `building` returns `EXPORT_IN_PROGRESS` and starts no duplicate builder.

## Versioning / Compatibility Notes

- The JSON manifest's `format` is `personal-ai-workspace-export`; `version: 1` fixes the projection above. Any incompatible shape/content change requires a new integer version. This task does not create an importer.
- Preserve the existing `/usage`, `/api/v1/account/usage`, `/api/v1/account/storage`, project listing, authentication, CSRF, and response-envelope contracts. Export sizes and TTL do not affect persistent storage quotas, credit usage, or account usage totals.
- Add the new paths and exact create/error/download schemas to `backend/openapi.json`; document the download as binary `application/json` and include its security and no-store/nosniff headers. Do not rewrite unrelated OpenAPI descriptions.
- Use migration `1710000040000` (`0040`) for the export metadata plus the additive exact-ID cleanup references. Task 7.2 owns `0039`; never edit delivered migrations or remove either registry entry.
- Keep frontend code in a focused `features/workspace-export` slice under `/usage`; use the existing project/workspace entity and UI primitives. The export provider disclosure must use the current server-configured provider name when actually available, otherwise show the UI spec's unavailable copy; provider details are not part of the export.

## Open Questions

- None block implementation. Task 7.1 and Task 7.2 migrations are delivered, and the existing project-removal and demo-expiry barriers are the authoritative cleanup scopes. The exact-ID references and terminal-writer wait described above are the accepted minimal integration; no cleanup timeout may be treated as proof that a writer has stopped.

### Focused proof plan for implementation

1. Unit-test portable JSON v1 projections, stable IDs/versions/order, exact binary round-trip/base64 hash, strict DTO validation, idempotency replay/conflict, bounds, and partial-file cleanup.
2. PostgreSQL integration-test owner isolation, one repeatable-read structured snapshot, concurrent create/limit handling, exact-key replay, workspace-removal/demo-expiry fencing, expiry cleanup, and non-enumerating foreign/missing artifact denial.
3. Directly call `ProjectFileGateway.captureForExport` with a bounded temporary workspace containing nested text and binary files; verify complete bytes, protected-name omission, recognized-secret `422`, traversal/link rejection, and fail-closed changed/incomplete traversal. Report Windows-supported behavior and label Linux descriptor/no-follow and platform-specific reparse behavior only when unavailable on the test host.
4. OpenAPI checks must prove route methods/paths, strict request, response envelope/descriptor, error statuses, authenticated security, and binary download headers.
5. Playwright route-stub journey must cover workspace selection, prepare, download headers/file, 413, 429, unavailable/expired artifact, retry, and unchanged credit/storage cards. Label stubs honestly. Collect the required browser/runtime evidence in the owning task artifacts after implementation.
