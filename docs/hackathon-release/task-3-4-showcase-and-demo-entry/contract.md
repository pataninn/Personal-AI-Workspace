# Contract: Protected showcase and private demo copies

## Change History

- 2026-10-19: Drafted from the Task 3.4 architecture preflight and UI spec, with compatibility to Tasks 2.2, 3.2, 3.3, and Task 4.1.
- 2026-10-19: Finalized DTOs and OpenAPI routes against delivered Task 4.1 source. Existing workspace files have project-relative paths rather than UUIDs, so admin selection uses safe relative paths and public snapshot files receive generated UUIDs. Migration 1710000033000 is additive.

## Ownership

- Task 3.4 owns immutable showcase publication, demo-copy pinning/provisioning, copy readiness, and the owner-wide content gate.
- auth owns session, principal, role, CSRF, and expiry checks. Admin role grants access only to the active administrator's own projects.
- projects, tasks, and memory remain source authorities. Preview uses IProjectRepository.findByIdForOwner, IProjectTaskRepository.listTasks, IProjectFactRepository.findActiveByIds, and the existing workspace list/download boundaries.
- Task 2.2 owns trusted project-root resolution; Task 3.2 owns logical bytes, reservations, file operations, and reconciliation; Task 3.3 owns admission idempotency, abuse counters, cookie behavior, and fixed expiry; Task 4.1 owns default assistant-policy rows and trusted provider configuration; Task 3.5 owns expiry cleanup, copy fencing, and pin release.
- No operator content exists. Start unpublished and do not insert a sample or publish automatically.

## Scope

The public resource is the current sanitized immutable snapshot, never an owned Project or tool context. It contains selected project display metadata, selected tasks and checklist items, selected active project facts, and selected regular-file bytes. Skills are omitted until Task 6.2 defines a persisted source and allowlist.

Public DTOs contain snapshot-generated UUIDs only. They omit source owner/project/resource UUIDs, task suggestion/run/conversation provenance, fact keys/verification metadata, host paths, context selection, private histories, policies, and credentials. Admin preview may accept canonical project-relative file names as selection input; absolute paths, roots, traversal, symlinks, protected paths, and caller-selected storage locations are rejected. The administrator reviews the exact projection and file bytes before publication; allowlisting alone cannot detect secrets in selected prose or files.

A new admission is eligible only when a current version and finite required settings are available. Current pointer check, version pin, reserved target project UUID, copy job, owner, empty account_limits, and admission counters commit atomically. If unpublished or a known required prerequisite is unavailable, reject before owner/counter creation. Task 3.3's identity/session response and cookie remain unchanged; its state ready means identity and empty storage bootstrap are ready, not that the copy is open.

Each copy has a separate pending | ready | failed state. A pending, failed, missing, expired, or unpinned copy cannot expose owner content. While a copy is not ready, only session read/logout, demo admission resume, copy status/retry, public showcase reads, and availability are allowed. The server gate covers all other API reads/writes, streams, files, chat/runs/tools, background operations, and exports; client routing is not authorization.

## Endpoints / Events

All JSON uses the existing { data, error } envelope.

| Method and path | Access | Behavior |
| --- | --- | --- |
| GET /api/v1/showcases/current | Public | Current snapshot only; 404 SHOWCASE_NOT_PUBLISHED when absent. |
| GET /api/v1/showcases/current/files/{fileId} | Public | Current-version file bytes only; attachment/octet-stream for active content and nosniff. |
| GET /api/v1/demo/availability | Public | Only { available: boolean }; false when unpublished or bounded prerequisites are unavailable. |
| POST /api/v1/admin/showcases/previews | Active admin; exact Origin and CSRF | Exact allowlisted projection and file bytes; no publication mutation. |
| POST /api/v1/admin/showcases/versions | Active admin; exact Origin and CSRF | Re-read same selection and publish only if preview digest/revision still match; idempotent by admin key. |
| POST /api/v1/demo/session | Existing Task 3.3 rules | Existing request/cookie/expiry/replay behavior. A new admission pins the current version and reserved copy IDs. |
| GET /api/v1/demo/showcase-copy | Current demo session | Returns safe copy state and required projectId: null until fully ready, then only the private target UUID scoped to the authenticated owner for workspace navigation. An old admission without a pin returns failed, retryAllowed false. |
| POST /api/v1/demo/showcase-copy/retries | Current demo session; exact Origin and CSRF | Bounded retry/observation of the same known-safe copy; no identity, version, ID, expiry, credit, or counter change. |

There are no public write endpoints. Snapshot IDs passed to owner APIs do not grant owner access.

## Request Shapes

All JSON objects are strict. UUIDs use RFC 4122 text form. Arrays reject duplicates and are bounded by configured limits.

POST /admin/showcases/previews:

    {
      "projectId": "uuid",
      "selection": {
        "taskIds": ["uuid"],
        "factIds": ["uuid"],
        "filePaths": ["docs/overview.md"]
      }
    }

projectId, taskIds and factIds refer only to the active administrator's own active project and active resources. filePaths are normalized workspace-relative POSIX paths selected from the existing safe workspace listing. Each must resolve as a regular file through the trusted owner/project boundary. Empty arrays are valid; project name/objective remain in the projection. A missing, foreign, archived, protected, unsafe, directory, symlink, or unlisted selection rejects the whole preview.

POST /admin/showcases/versions repeats projectId and selection and adds:

    {
      "previewDigest": "<64 lowercase hex SHA-256>",
      "sourceRevision": "<64 lowercase hex SHA-256>"
    }

Idempotency-Key is required and uses the existing API convention ^[A-Za-z0-9._:-]{1,128}$. Persist only its digest, scoped to the active administrator. Same key/fingerprint replays the original result; reuse with a different fingerprint returns 409 IDEMPOTENCY_KEY_REUSED.

POST /demo/showcase-copy/retries accepts exactly {}. Owner, admission, pinned version, target IDs, attempt count, and expiry come from durable server state.

## Response Shapes

OpenAPI DTOs:

- Uuid: string, format uuid.
- Sha256: string matching ^[0-9a-f]{64}$.
- ShowcaseChecklistItemDto: { id: Uuid, title: string, completed: boolean }.
- ShowcaseTaskDto: { id: Uuid, title: string, details: string|null, status: todo|in_progress|blocked|done|archived, importance: low|medium|high|urgent, deadline: YYYY-MM-DD|null, checklist: ShowcaseChecklistItemDto[] }.
- ShowcaseFactDto: { id: Uuid, title: string, content: string }.
- ShowcaseFileDto: { id: Uuid, name: safe relative display name, mediaType: server-owned safe MIME type, byteLength: nonnegative integer }.
- CurrentShowcaseDto: { version: Uuid, publishedAt: ISO-8601 UTC, project: { name: string, objective: string|null }, tasks: ShowcaseTaskDto[], facts: ShowcaseFactDto[], files: ShowcaseFileDto[] }.
- PreviewFileDto is { name, mediaType, byteLength, sha256, contentBase64 } and deliberately omits generated public IDs. This is admin-only exact source bytes; it is not included in the public DTO.
- ShowcasePreviewDto: { project, tasks: selected visitor fields without generated IDs, facts: selected visitor fields, files: PreviewFileDto[], previewDigest: Sha256, sourceRevision: Sha256, totals: { itemCount: integer, fileCount: integer, snapshotBytes: integer }, exclusions: string[] }.
- DemoAvailabilityDto: { available: boolean }.
- DemoShowcaseCopyDto: { state: pending|ready|failed, projectId: Uuid|null, retryAllowed: boolean, workspaceMode: planning|file_backed|null, capabilities: { planning: true, fileAccess: boolean }|null }. projectId is null unless state is ready; when ready, it is the private target project UUID scoped to the authenticated owner.

JSON responses wrap these data shapes in the existing envelope. Public current DTO has no digest, source/owner IDs, quota, paths, skills, policy, capabilities, or private target project ID. The target UUID is returned only by authenticated owner copy-status/retry responses after readiness. File bytes are never base64 in public JSON.

GET /showcases/current/files/{fileId} returns raw bytes with Content-Length, Content-Disposition: attachment, X-Content-Type-Options: nosniff, and a closed server-owned media type. Active and unknown types are application/octet-stream; HTML/SVG are never inline.

Availability is HTTP 200. Copy status is HTTP 202 while pending and 200 otherwise. projectId, workspaceMode, and capabilities are null until the copy is fully ready; planning-only readiness uses workspaceMode: planning and fileAccess: false. Retry returns the same DTO with 202 while pending.

Preview file bytes are base64 only in the authenticated admin response, enabling escaped text display or exact-byte download for binary content. The response is bounded by the same finite snapshot limits. Generated public item IDs are allocated at publish and are not visitor-visible content during preview.

POST /admin/showcases/versions returns { data: { version: UUID, publishedAt: ISO-8601 UTC }, error: null }. The first successful publish returns HTTP 201; a matching same-key replay returns the same version and timestamp with HTTP 200. A different normalized request under the same administrator/key returns 409 IDEMPOTENCY_KEY_REUSED.

## Validation and Error Cases

| HTTP / code | Behavior |
| --- | --- |
| 400 VALIDATION_ERROR | Invalid strict shape, UUID/digest/revision/key, duplicate selection, or invalid relative path. Field names only in details. |
| 401 SESSION_UNAUTHENTICATED | Missing, invalid, revoked, or expired session. |
| 403 ADMIN_REQUIRED, ORIGIN_FORBIDDEN, CSRF_INVALID | Not active admin or state-changing request fails existing Origin/CSRF checks. |
| 404 SHOWCASE_NOT_PUBLISHED | No current publication. |
| 404 SHOWCASE_FILE_NOT_FOUND | File is not in current version; does not distinguish unknown, old, or foreign IDs. |
| 404 PROJECT_NOT_FOUND / SHOWCASE_SOURCE_NOT_FOUND | Source project/resource is outside the administrator's active owned scope; foreign existence is not disclosed. |
| 409 SHOWCASE_PREVIEW_STALE | Project/selected row revision, file listing/path, bytes, or hash changed after preview; pointer unchanged. |
| 409 IDEMPOTENCY_KEY_REUSED | Publish key already used with another normalized fingerprint. |
| 409 DEMO_COPY_NOT_RETRYABLE | Copy ready, terminal, over attempt limit, or has unknown side effects. |
| 413 SHOWCASE_LIMIT_EXCEEDED | Finite item/file/per-file/total bound exceeded; no partial publication. |
| 413 STORAGE_QUOTA_EXCEEDED | Existing Task 3.2 quota rejects positive copy growth; no partial copy becomes ready. |
| 503 DEMO_SHOWCASE_UNAVAILABLE | New admission cannot pin current version or known prerequisites/config are unavailable; reject before owner/counter creation. |
| 503 DEMO_COPY_UNAVAILABLE | Copy/root/accounting unavailable; no private content exposed. |
| 503 SHOWCASE_PUBLICATION_UNAVAILABLE | Preview/publish persistence, settings, or trusted source boundary unavailable; current pointer unchanged. |
| 409 DEMO_REGULAR_SESSION_ACTIVE | Existing Task 3.3 behavior; preserve regular cookie/session. |
| 429 DEMO_ADMISSION_RATE_LIMITED | Existing Task 3.3 abuse limits remain authoritative. |

Responses/logs never contain raw paths, host roots, IPs, source/owner IDs, quota totals, provider details, credentials, or exception text. Preview source values are returned only to the active admin who requested them.

## Copy and Admission Invariants

1. Keep Task 3.3 abuse-lock order. In the same admission transaction, lock/read the singleton publication pointer before counters or owner insert; absent/unsafe publication rolls back with DEMO_SHOWCASE_UNAVAILABLE. Persist the pinned version and reserved target project UUID with that admission. A concurrent publication affects later admissions only.
2. Same-key replay remains status-only and never returns a cookie. Valid demo cookies resume without expiry extension. Regular cookies remain unchanged. Existing admissions without pins are never attached retroactively.
3. Task 3.3 empty-account bootstrap (including reconcileReferences(ownerId, [])) finishes before copy content, project roots, quota references, file reservations, or mappings are created.
4. The durable copy stores admission/owner, nonready pinnedVersionId, reserved target project UUID, snapshot-to-target ID map, file plan, phase/claim generation, bounded attempts, safe failure category, and timestamps. Store no arbitrary/absolute path. Allocate stable IDs and operation keys before side effects. Keep the pin until ready or Task 3.5 proves no worker can resume and cleanup is complete.
5. In one bounded PostgreSQL transaction create hidden target project and selected task/checklist/fact rows with fresh IDs/owner links. Copy only project name/objective and allowlisted task/fact fields. Do not copy conversations, runs, policies, context, exclusions, roots, or provider permissions. Task 4.1's project insert trigger creates one default policy row; verify it exists before ready. A null provider pair is a persisted default, not runtime availability.
6. If files exist, create a managed root from reserved owner/project IDs. Reserve Task 3.2 quota before each file write; write through the trusted gateway; verify path/hash/size; settle after IO. Never hold DB/account locks over file IO. Retries reuse version/IDs/target paths/manifest/operation keys. Unknown outcomes stay unavailable until Task 3.2 reconciliation proves the result. No /workspace, recovery, or temp fallback.
7. Fileless copies may be planning-only only if normal setup supports it; then report fileAccess false. A known missing managed root rejects new file-backed admission before owner creation. If unavailable later, keep the copy hidden until safe repair/reconciliation.
8. Copy transitions and Task 3.5 cleanup share lock order admission -> owner -> copy. Commit claims/fences before external work. Ready requires same claim generation, active unexpired owner, verified complete DB/file manifest, settled quota, default policy row, and no cleanup fence. No DB transaction spans filesystem/runtime/provider work.
9. While unready, an app-wide API gate permits only session read/logout, demo admission resume, copy status/retry, public showcase GETs, and availability. Every other current/future owner-content route is denied by default, including streams.
10. Retry only known-safe failures with no unknown quota/filesystem side effects, same cookie owner/version/IDs, exact Origin+CSRF, finite attempt budget, and no expiry/credit/counter change. Copy state is separate from Task 3.3 admission state.
11. Retain only a finite number of versions: current plus all nonready pins. Prune only unpinned older versions and reject publish when the cap cannot be met. Shared snapshot bytes are not charged to accounts; copied bytes/rows count to the demo owner under Task 3.2.

## Persistence, Configuration, and Compatibility

Migration 1710000033000-create-showcase-and-demo-copies.ts is additive after delivered 1710000032000-create-assistant-scope-policies.ts. Do not edit migrations 0029-0032. Persist immutable sanitized version JSON, per-version file bytea rows, singleton publication pointer, publish idempotency digest/fingerprint, and one durable copy/ID-map record per admission. A foreign key on nullable pinnedVersionId prevents pruning while a nonready copy needs the version; clear it only after verified ready. Down migration refuses while published versions, active pins, or copy records exist.

Required all-or-none finite positive integer settings; no production values/defaults are invented:

- SHOWCASE_MAX_SNAPSHOT_BYTES
- SHOWCASE_MAX_FILE_BYTES
- SHOWCASE_MAX_ITEMS (tasks + checklist items + facts + files)
- SHOWCASE_MAX_FILES
- SHOWCASE_MAX_RETAINED_VERSIONS
- DEMO_SHOWCASE_COPY_MAX_ATTEMPTS

maxFileBytes <= maxSnapshotBytes; maxFiles <= maxItems. Snapshot bytes are canonical UTF-8 projection bytes plus exact selected file bytes. Base64 transport overhead is not charged to this persisted-content bound. Missing/invalid settings disable preview/publication and new admission; ready copies and public reads remain available.

sourceRevision is SHA-256 of canonical selected source IDs/row versions, active project ID/version, and each normalized relative file path plus verified hash/length. It is admin-only and not persisted in public snapshot. previewDigest is SHA-256 of canonical visitor-visible fields and exact file hashes/lengths; generated IDs are excluded. Publish recomputes both. Ordering is deterministic: tasks by position then source UUID, checklist in source order, facts by key then source UUID, files by normalized path.

Project policy default comes only from Task 4.1's same-transaction DB trigger; do not seed/copy/change source policy or infer provider availability. Publication affects future admissions only. Ready copies no longer pin source bytes.

## Versioning / Compatibility Notes

- Add all eight endpoint operations to OpenAPI 3.0.3 with strict request/response schemas, safe errors, binary file response, UUID and SHA-256 formats, enums, CSRF/Origin, and Idempotency-Key.
- Public snapshot and target clone IDs are generated. Existing files have no UUID in the source API; copied path names exist only under a new owner/project root and never act as root authority.
- Task 3.3 session response, cookie, fixed expiry, empty bootstrap, abuse limits, regular-session conflict, and status-only replay remain unchanged. Session may exist while copy is pending, but owner content is gated.
- Task 3.5 must use the admission/owner/copy order and pin-release rule. It never deletes administrator source content or shared showcase versions.
- Task 6.2 defines persisted skills before skills can enter future snapshots.

## Open Questions

None block implementation. The operator must choose showcase content and finite settings; absent either, the system stays unpublished/unavailable. No provider readiness, physical mount proof, production limits, public TLS, or deployment evidence is claimed.
