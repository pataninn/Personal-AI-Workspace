# Contract: Enforce account storage limits on every persistent write

## Change History

- 2026-10-19: Initial contract based on release architecture §§7.2, 10, and 11; Task 3.2 preflight; Task 2.2 ownership boundaries; and Task 3.1's shared account-limit and lock-order contract. No code, migration, tests, or database state was changed.
- 2026-10-19: Initial foundation added under the explicit Task 3.2 file handoff: quota domain rules, QueryRunner-aware relational accounting, durable filesystem reservations, a trusted-root scanner, and the additive schema migration. Focused PostgreSQL coverage now validates the migration and generic accounting/reservation transactions; production write-boundary wiring and full recovery-path coverage remain outstanding.
- 2026-10-19: Updated after production integration: migrations 0029/0030, the authenticated usage route, transaction-scoped relational writers, durable file/recovery reservations, project-removal barriers, startup reconciliation and orphan inventory, staging cleanup, and process-visible disk observation are implemented. The write-path matrix and evidence in `dev-summary.md` distinguish PostgreSQL writer-admission proof from unit-only paths and deployment-only checks.

## Ownership

- The authenticated principal and persisted project, conversation, run, or job ownership determine the account charged. Never accept an owner ID or host path from a request as quota authority.
- Task 3.1 owns the single per-owner `account_limits` row and its credit fields. Task 3.2 extends that row with nullable `storage_limit_bytes BIGINT`; it does not create another account-limits table or edit Task 3.1's migration.
- Storage totals, per-resource accounting references, and filesystem reservations are separate from credit usage and provider-call reservations. Existing credits and storage share `account_limits` as the serialization row.
- Every database-only content write locks the account's `account_limits` row before storage-counter/reference and resource, task, or action-ledger rows, and performs accounting with the resource mutation in its existing QueryRunner transaction. Do not hold this account-row lock or a database transaction during filesystem I/O.
- Future callers in Tasks 6.2, 6.3, 6.4, 7.1, and 7.2 use the same storage-quota application port. Their persistent writes remain independently owned by those tasks.

## Scope

### Logical-byte measure

All values are nonnegative integer bytes. Five decimal GB is exactly 5,000,000,000 bytes. A nullable storage limit means unlimited; zero allows no positive growth. A configured limit is never inferred from a display unit.

- For text, charge `octet_length(normalized stored text)` in PostgreSQL or the equivalent `Buffer.byteLength(value, 'utf8')` after the exact normalization used before persistence. Do not use JavaScript character count, the legacy `messages.content_length`, a token estimate, or filesystem allocated blocks.
- For each retained content-bearing JSONB field, charge `octet_length(value::text)` for the PostgreSQL-normalized JSONB representation, including its keys and nested structure. A field is charged once per persisted copy. Exclude standalone IDs, hashes, timestamps, paths, status/cursor fields, and derived byte counters. Metadata-only task reorder/status event details do not add transcript bytes.
- Include project names/objectives; project conversation titles and message content; task titles/details/checklist JSON; retained task suggestions and content-bearing task-event details; Home conversation titles, message content, and retained event payload JSON; project fact titles/content; AI-run requests/manifests and retained result content; change-set operations, retained checkpoints/results when they contain content; sandbox command/argument/summary/result content; Home proposal command JSON; action-ledger reversible/outcome JSON; and task idempotency snapshots while retained.
- Include every retained copy independently. A task and its retained idempotency snapshot, a proposal and its retained command, an action receipt and its reversible fields, a database record and a promoted file, and a live file and a recovery version are separate charges. Do not deduplicate by content hash. Replaying the same idempotent operation updates no second reference or charge; distinct persisted copies each count.
- A project fact's soft delete only sets `deleted_at` and retains title/content, so it remains charged until the stored content is actually cleared or purged. Accepted/cancelled proposals, retained action receipts, and undo/recovery content remain charged while their content exists.
- For files and recovery snapshots, charge the `lstat/stat.size` of each regular file beneath the trusted root selected by the persisted Task 2.2 owner/project storage mapping. Never follow symlinks/reparse points. Keep file and recovery-version references keyed independently of a project row so deleting that row cannot erase a charge.
- Exclude database indexes/tuple overhead, shared curated template source bytes, and transient staging, sandbox, or export copies. A user-owned template copy is charged. Logical quota is not a physical disk quota; physical disk monitoring stays separate. The application observes process-visible free bytes for trusted workspace/managed/recovery targets via `statfs`; this does not prove host-volume capacity or deployment configuration.
- Direct edits to host-mounted authoritative roots are unsupported. The app owns writes to those roots; reconciliation detects unaccounted drift and fails closed for that account. A missing, unreadable, or unsafe root is never treated as zero bytes.

### Persistence and admission

Use one per-owner storage counter row with `used_bytes`, `reserved_bytes`, and an explicit accounting state, plus stable per-copy references and durable filesystem-operation reservations. These structures are separate from `account_limits`; only its `storage_limit_bytes` is shared with credit work.

For a relational write, reuse its current QueryRunner transaction. Lock `account_limits` first, verify the account's storage accounting is ready, read the canonical before/after byte totals, and compute the exact delta. If the delta is positive and `limit_bytes` is non-null, reject when `used_bytes + reserved_bytes + delta > limit_bytes`. Otherwise write the resource, update its stable accounting reference, and apply the counter delta in the same transaction. A rollback changes none of the resource, references, or counter. Zero/negative deltas remain available while over limit. Reorders and status changes with no content-bearing payload have zero content delta. In-place updates replace the same resource reference; they never add a second charge.

Existing boundaries to gate are:

- Projects: `TypeOrmProjectRepository.create`, `createPlanning`, and `updateObjective`.
- Project tasks, subtasks, suggestions, task events, action-ledger mutations, and idempotency snapshots: `TypeOrmProjectTaskRepository` transaction and public write methods plus `task-suggestion-completion-writer.ts`; existing task mutation/action-ledger transaction participants must acquire the account lock before target/receipt rows.
- Project conversations/messages: `TypeOrmConversationRepository.create` and its message append transaction.
- Home conversations/messages/events: `TypeOrmHomeConversationRepository` create, submit, append, and assistant-completion transactions plus `home-conversation-event-persistence.ts`.
- Home proposal commands: `TypeOrmHomeChangeProposalRepository` draft, edit, remove, and seal transactions. State-only transitions do not rewrite or release retained commands.
- Facts: `TypeOrmProjectFactRepository` currently uses direct autocommit queries; create/update/delete must become transaction-aware. Soft-delete does not release retained bytes.
- Runs and retained tool output: `TypeOrmAiRunRepository`, `TypeOrmProposedChangeSetRepository`, `TypeOrmSandboxCommandRepository`, `TypeOrmActionLedgerRepository`, and `TypeOrmHomeActionEventRecorder`.
- Files/recovery: manual upload/edit/delete through `ProjectFileActions` and `ProjectFileGateway`; promoted changes through `WorkspaceMutationGatewayAdapter`; retained versions through `ProjectRecoveryCleaner` and `TypeOrmProjectRemovalRepository`. All paths use the trusted legacy or managed root mapping, never a request path.

For filesystem work, persist an idempotent reservation in a short PostgreSQL transaction before any authoritative backup, promotion, rename, or unlink. It records owner/project and trusted root reference, operation key/fingerprint, target key, expected prior hash/size, intended final hash/size, anticipated retained recovery bytes, positive reserved growth, and pending state. Commit before filesystem I/O. The reservation increases `reserved_bytes`; a successful, verified target/recovery stat atomically updates per-copy references and `used_bytes`, reduces the reservation, and records the operation outcome. A known failure can release the reservation only after proving no authoritative side effect remains. Ambiguous filesystem or database outcomes stay fully reserved and reconcilable; never report them as a confirmed no-op or release bytes speculatively.

Reserve the exact maximum net increase before writing: new live bytes plus newly retained recovery bytes minus the replaced live charge and any copies actually removed. File deletion releases live bytes only after verified unlink; a retained recovery copy remains charged. Rename preserves the live content charge and adds any retained copies. An operation that creates a retained recovery copy is positive growth if its exact total account bytes increase, even when the new live file is smaller. Positive growth is rejected when over quota; delete and any update whose exact total delta is nonpositive remain available. Limits lowered below current usage never delete content or cancel already admitted reservations; they block new positive growth until usage is within the limit.

Reconciliation derives database totals from canonical retained rows, and file totals from the trusted project roots and recovery manifests. Backfill existing accounts before marking them ready; never initialize an unscanned account to zero. Preserve outstanding reservations and their byte charges until each operation's outcome is proven. If a scan finds more retained data than the recorded total, account for the actual bytes, mark the account over limit, and block further growth. Failed scans, unknown ownership, absent roots, or unsafe paths leave accounting unavailable and deny positive growth. A deletion/project-removal job can remove a database row without removing the authoritative project folder: remove database-content references with the database deletion, but transfer the folder charge to an owner-scoped retained-root reference independent of the project row. Release that charge only after actual root removal is verified. Recovery cleaner purge releases only the recovery files actually confirmed absent.

### Existing payload bounds

Quota enforcement does not relax source validation or let unbounded data reach persistence. Measure actual normalized UTF-8/JSONB bytes at the persistence boundary, even where a route currently limits character count.

- Manual file upload and direct file writes: 8 MiB (8,388,608 bytes) per file. Text-content requests: at most 512 KiB (524,288 UTF-8 bytes); the existing string-length validator alone is insufficient for multibyte text.
- Workspace file paths retain the existing 2,048-character route bound; storage reference and reservation keys accept that same maximum.
- Project and Home conversations: titles at most 160 characters and messages at most 20,000 JavaScript string code units. Home assistant output is at most 256 KiB; persisted Home runtime history is capped at 4 MiB. AI change sets: 256 KiB content per operation, 2 MiB total operation content, and at most 100 operations. Project assistant output: 64 KiB. AI run request: 8,000 UTF-8 bytes; assembled context: 256 KiB total, at most 20 messages and 32 KiB per message.
- Tasks: title at most 120 Unicode code points; details at most 4,096 UTF-8 bytes; at most 50 simple single-tier checklist items, each title at most 120 code points. A run produces at most five task suggestions.
- Facts: title at most 120 characters and content at most 4,096 UTF-8 bytes.
- Home event payload: at most 4,096 serialized JSONB bytes. Home proposal: at most 20 items and 128 KiB serialized command JSON per proposal. Each action-ledger reversible-fields and outcome JSONB value is at most 8 KiB.
- Transient AI staging keeps the existing 256 KiB per-file cap, has a 2 MiB total per-run cap, expires no later than 24 hours after creation, and remains outside account usage. Normal run cleanup is immediate; a cleanup sweep removes expired staging. Unknown-size streams are capped while staging, measured exactly, and only then eligible for an exact-size persistent reservation. Exports remain separately bounded and expire independently of account quota; Task 6.4 owns their exact limit and TTL.

### Project deletion and retention

Deleting project metadata is not proof that its authoritative file tree was deleted. The existing project-removal workflow preserves that folder. Its file charge must survive project-row deletion in an owner-scoped retained-root item until a later verified filesystem deletion. Database rows actually deleted in the same transaction may release their own content references, but detached receipts, proposal commands, recovery files, or any other retained copies continue to count. No counter release is based only on an API's soft-delete flag, task status, cleanup request, or queued job.

### Required implementation coverage

Use real PostgreSQL integration coverage for account-row serialization, concurrent positive deltas, rollback, idempotent replay, limit reduction below usage, and delete/shrink while over limit. Include exact UTF-8/JSONB bytes, duplicate retained copies, decimal 5 GB, task/subtask/message/proposal/event/action-ledger/fact cases, and a populated-account backfill.

Use injected temporary filesystem roots with real filesystem operations for concurrent promotions, overwrite plus recovery copy, rename, delete with retained recovery, verified purge, symlink/reparse rejection, cleanup failure, each ambiguous crash point, idempotent replay, and reconciliation. Exercise both persisted legacy and managed root mappings and project deletion with the authoritative folder retained. Tests must prove that only verified deletion releases a file charge and that unknown outcomes keep their reservation.

## Endpoints / Events

No new write endpoint or public event is introduced. Existing persistent-write routes retain their current request shapes and use the quota service at the server persistence boundary.

Add `GET /api/v1/account/storage` as an authenticated, owner-scoped read. It returns only the signed-in principal's storage state. Reads require the existing session/auth middleware; as a GET, the route does not require a CSRF token. The endpoint is not an admin limit mutation surface. Task 3.6 owns administrative limit changes.

All new/updated routes and statuses are added to the existing OpenAPI spec. Every existing write endpoint that can fail for quota/accounting reasons documents those responses.

## Request Shapes

### `GET /api/v1/account/storage`

No request body or query parameters. The owner comes from the authenticated session. There is no client-supplied account ID, project ID, quota value, or root path.

Existing resource writes keep their current request DTOs, idempotency keys, CSRF/origin protections, and ownership checks. A server-generated operation UUID is used for file mutations that do not already have a stable operation key.

## Response Shapes

All responses use the existing `{ data, error }` envelope. Successful storage DTO:

```json
{
  "data": {
    "storage": {
      "state": "ready",
      "unit": "bytes",
      "unitSystem": "decimal-si",
      "usedBytes": "1234",
      "reservedBytes": "200",
      "limitBytes": "5000000000",
      "availableBytes": "4999998566",
      "overLimit": false,
      "asOf": "2026-10-19T00:00:00.000Z"
    }
  },
  "error": null
}
```

Byte counts are base-10 integer strings so PostgreSQL BIGINT values remain exact in JSON. `limitBytes: null` and `availableBytes: null` mean unlimited. `availableBytes = max(limitBytes - usedBytes - reservedBytes, 0)`. `overLimit` is true when configured limit is less than `usedBytes + reservedBytes`. Human-readable presentation uses decimal SI units (1 kB = 1,000 bytes; 1 MB = 1,000,000 bytes; 1 GB = 1,000,000,000 bytes) and preserves the exact byte count for accessibility/details. The API returns exact bytes; Task 6.4 owns the usage settings display.

When accounting is `reconciling` or `unavailable`, return HTTP 200 with that state and null `usedBytes`, `reservedBytes`, `availableBytes`, `overLimit`, and `asOf`; the configured `limitBytes` remains visible. This avoids presenting an unverified zero as current use. Writes fail closed during those states.

## Validation and Error Cases

- `STORAGE_QUOTA_EXCEEDED` — HTTP 413 for a positive write delta that would exceed the configured limit. The safe error details are decimal strings: `usedBytes`, `reservedBytes`, `limitBytes`, and `requestedGrowthBytes`. Include no path, file content, or other account data.
- `STORAGE_ACCOUNTING_UNAVAILABLE` — HTTP 503 for positive writes while backfill/reconciliation is incomplete or canonical storage cannot be safely measured. Do not reveal filesystem paths.
- `STORAGE_RECONCILIATION_PENDING` — HTTP 503 when a filesystem operation has an ambiguous outcome. Include its opaque operation ID only; the reservation stays charged until reconciliation.
- `FILE_TOO_LARGE` — preserve the existing HTTP 413 per-payload error for a source-limit violation. Existing validation errors remain HTTP 400, unauthenticated requests remain 401, and foreign resources retain Task 2.2's non-disclosing ownership behavior.
- A lower limit may place an account over quota. Reads and net-zero/negative writes continue; positive writes return `STORAGE_QUOTA_EXCEEDED`. A limit of zero differs from null.
- A replay with the same operation key and fingerprint returns its prior outcome without another charge. Reusing an operation key with different content remains an existing idempotency conflict (HTTP 409); quota logic does not override it.
- OpenAPI schemas document the endpoint's nullable/decimal-string fields and all quota/accounting error codes/statuses. No provider, project path, raw content, or foreign owner's totals appear in error details.

## Versioning / Compatibility Notes

- This is additive API/schema evolution. Existing resource endpoints and payload limits remain compatible; writes gain quota checks and may return the new 413/503 errors. The current auth session remains the authority.
- Add `storage_limit_bytes` to the Task 3.1 `account_limits` row and add separate storage counter, per-copy reference, filesystem reservation, and active-reference-lock tables. The migration initializes every existing account in `reconciling`; a canonical database/file scan must backfill each account before marking it ready or admitting growth. Migration rollback must refuse to drop nonempty accounting/limit data.
- `null` retains unlimited behavior until Task 3.6 configures an account limit. Setting a limit below current use leaves content intact and blocks only positive growth. No historic content is dropped during backfill.
- Shared curated template bytes are excluded; copies become account content when persisted. Task 6.2 skills and Task 7.2 briefings call the same storage port; Task 6.4 export/staging uses separate transient bounds and its UI formats this endpoint's exact byte DTO.
- Reconciliation repairs accounting from canonical retained data; it never releases an uncertain reservation or a retained-root charge based on missing metadata alone. Storage usage does not promise physical disk usage or provider-side erasure.

## Open Questions

- None blocking. This contract treats authoritative host-mounted workspace roots as application-exclusive; external direct edits are unsupported and detected as drift during reconciliation.
- Task 6.4 owns the consumer display and should use the documented decimal SI conversion while retaining exact byte values.

## Implementation Ownership and Current Boundary

- `backend/src/modules/storage-quotas/**` owns storage-quota domain rules, usage DTO/use case, and repository ports. `GET /api/v1/account/storage` derives its owner only from the authenticated session.
- Migrations `1710000029000-add-account-storage-limit.ts` and `1710000030000-create-storage-root-mappings.ts` extend the Task 3.1 account-limit row and add durable totals, content references, file reservations, and owner-scoped active/retained root mappings. Both are registered in `data-source.ts`.
- Relational writer integrations use the caller's QueryRunner and an explicit affected-content identity scope. PostgreSQL measures canonical stored text/JSONB bytes; full owner scans are confined to startup/reconciliation. File reservations commit before I/O and settle only from verified actual state.
- Project removal commits an owner/root/run barrier before filesystem quarantine. It rejects new scoped writes and run admissions, accounts for rows removed by cascades, retains project roots and recovery references until verified purge, and keeps action-ledger receipts that outlive the project.
- Startup reconciliation marks owners unavailable before scanning, resolves only provable reservations at the quiescent pre-listen boundary, inventories attached/retained and managed orphan roots, then atomically replaces references and marks a fully measured owner ready. An unattributable global recovery/managed-root entry prevents global readiness; an unsafe owner-specific root leaves that owner unavailable. It never initializes an unscanned owner to zero.
- Staging is transient, limited to 256 KiB per file and 2 MiB per run, marked with a fixed 24-hour expiry, cleaned after confirmed lifecycle completion or by the bounded periodic sweep, and rejected at run start when stale.
- `STORAGE_DISK_WARNING_FREE_BYTES` is optional and has no default. When configured, process-visible `statfs.bavail * bsize` observations produce transition-only internal warnings for `/workspace`, enabled managed storage, and `RECOVERY_ROOT`. They do not affect account readiness, logical quota, or public DTOs. Task 8.1 owns host mount/source verification and deployment threshold configuration.
- Future write paths in Tasks 6.2, 6.3, 6.4, 7.1, and 7.2 must use the existing storage mutation/reservation boundary; this task does not claim those future integrations.

Current automated coverage and its limits are recorded in `dev-summary.md` and the task artifacts. Real PostgreSQL tests cover fact, conversation/idempotency, task/subtask/action-ledger, project-removal/Home cascades, startup reconciliation, and generic reservation/accounting paths. Other run/change-set/sandbox/Home write adapters have focused unit coverage; those unit tests are not presented as independent PostgreSQL admission proof. No provider call, host mount-source validation, or deployed physical-disk alert has been exercised.
