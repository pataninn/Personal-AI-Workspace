# Contract: Expire and clean up demos safely

## Change History

- 2026-10-19: Established before implementation against delivered Task 3.4 commit `ae188ba9d39264ff4b981dc745b7a1daafd70c20`, migration 1710000033000, and the refreshed architecture preflight.
- 2026-10-19: Implementation is ready for QA. The change adds no HTTP endpoint or public response field.
- 2026-10-19: QA cycle 1 exposed restrictive credit-ledger owner references. Following the architecture-preflight retention decision, migration 0034 now owns a narrow nullable-owner seam that preserves detached terminal ledger rows and their reservation links.

## Ownership

- Task 3.5 owns durable expiry cleanup claims, cleanup phases, cleanup generation, terminal admission replay state, and safe removal of expired demo-owned content.
- Auth owns immediate session/account expiry rejection. Task 3.3 owns admission keys, replay behavior, and global/network counters. Task 3.4 owns copy provisioning and showcase publication. Task 3.2 owns storage quota accounting and reservations. Existing run, sandbox, project-removal, and recovery modules remain owners of their cancellation and cleanup operations.
- No endpoint or public DTO changes are planned. Internal cleanup state must not be returned by demo APIs.
- This task owns additive migration `1710000034000` only; delivered migrations 0029–0033 remain immutable.

## Scope

- The database clock selects admissions whose demo owner has expired, including pending, failed, and ready admissions. An admission without an owner is never re-provisioned or bootstrapped by cleanup or same-key replay.
- A cleanup claim records an immutable UUID manifest, generation, lease, phase, retry timing, attempt count, and safe failure code. It contains identifiers only, never caller-supplied or absolute filesystem paths.
- The fence transaction follows `demo_admissions → users → demo_showcase_copies`; it disables the account and copy retry, revokes the copy claim, and commits before cancellation or filesystem work.
- An in-flight root creation has a durable receipt keyed by its stable operation ID. A stale copy worker may report only the outcome of its own receipt; its revoked claim cannot advance readiness. Pending or unknown receipts block deletion. A claim lease alone never proves filesystem quiescence.
- Cleanup reuses run/command cancellation, project-removal recovery, strict managed-root mapping, file-operation reconciliation, quota accounting, and recovery-tree validation. Cleanup waits for every active run/command and pending/unknown storage operation to become terminal.
- Purge targets exact manifested demo project roots and recovery run UUIDs. It preserves regular users and roots, administrator source rows, all published/current showcase versions, admission/network counters, and credit campaign/global spending totals.
- Settled provider reservations and per-call usage entries are immutable retained financial history. Migration 0034 makes only their `owner_id` columns nullable while preserving existing foreign-key actions and the usage-to-reservation `RESTRICT` link. Finalization holds the demo user row lock, locks all its provider reservations, blocks `in_flight` as busy and `unknown` as an unresolved effect, and only for terminal `settled`, `released`, or `over_bound` rows nulls `owner_id` in both tables before deleting the user. All pricing, token, charge, source, call/attempt, status, reservation-link, daily-demo, and campaign details remain intact.
- Reservation creation, settlement, unknown retention, and known-not-sent release serialize on the same user row; cleanup must not take `credit_runtime_policy` after locking the admission/user. A terminal settlement replay with a detached owner returns its stored result before owner-specific locks. Owner-scoped queries continue filtering by `owner_id = $1`, so detached entries are excluded from live-account reads.
- Admission replay ends as status-only `failed` with internal failure code `expired`; owner deletion sets its nullable owner reference to null. The unique request digest remains for existing replay retention.
- Exports and schedules remain future module-owned cleanup contributors. This task does not invent their tables or paths.

## Endpoints / Events

No HTTP endpoints, events, or public response states are added. Existing periodic maintenance invokes one bounded expiry-cleanup pass at startup and on its existing interval. Existing demo availability, session, copy-status, and retry contracts remain unchanged.

## Request Shapes

No request shapes change. Cleanup inputs come only from persisted admission, owner, copy, run/command, reservation, root-mapping, and recovery records. Every manifest member is a UUID or a stable operation identifier validated against its owning row before use.

## Response Shapes

No public response shapes change. The internal maintenance use case returns a bounded count of finalized cleanup records; it does not expose cleanup state through an endpoint. Logs expose safe operation context only, never request-key digests, IPs, owner paths, source IDs, credentials, or raw exception text.

## Validation and Error Cases

- Expired authentication remains rejected before cleanup runs.
- Admission and copy rows are locked in the established admission → owner → copy order. Cleanup claims use bounded `FOR UPDATE SKIP LOCKED` selection and never acquire admission advisory locks after row locks.
- Stale generation, stale copy token, inactive owner, or non-ready admission prevents copy readiness, dispatch, promotion, download, and owner-content writes.
- Active runs/commands, unresolved provider outcomes, incomplete root receipts, pending/unknown reservations, project-removal jobs, recovery items, remaining mappings/references, or unsafe paths keep cleanup pending.
- A managed-root mismatch, legacy root, `/workspace` fallback, missing marker, traversal/reparse path, unknown namespace child, or unmanifested ID fails closed and records a safe retryable failure.
- Quota rows and references are changed only through the existing account-limit-first storage boundary. References and reservations are released only after verified physical deletion.
- Cleanup failure cannot reset global admission/network counters, credit usage, owner expiry, or showcase pointers. Same-key replay cannot create a user, session, bootstrap state, or allowance.
- A detached credit reservation or usage row prevents migration 0034 rollback; rollback must not restore `NOT NULL` or erase retained ledger details.

## Versioning / Compatibility Notes

- Migration 1710000034000 is additive and reversible only while no cleanup jobs, effect receipts, or expiry tombstones depend on it; `down` must refuse rather than delete replay history or in-progress work.
- Existing Task 3.3 status-only replay, fixed expiry, cookies, rate limits, and public DTOs remain compatible.
- Existing Task 3.4 lock order and pin rules remain authoritative. Incomplete copy pins are retained until effects and owner content are quiescent; shared showcase versions and source data are never deleted.
- Task 6.4 export and Task 7.1 schedule implementations must later add exact artifact/job IDs, pre-download/pre-dispatch expiry and cleanup-generation checks, and a purge receipt before their resources can be considered cleanable.

## Open Questions

- The existing root-create call has no operation receipt. Task 3.5 will add the narrow durable receipt barrier; an unacknowledged/unknown receipt intentionally blocks deletion until the operation can be resolved safely.
- Cleanup timing remains the existing storage-maintenance interval. Access expiry is immediate and independent of that interval.
