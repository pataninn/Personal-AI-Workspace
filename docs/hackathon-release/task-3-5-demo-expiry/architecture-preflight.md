# Task 3.5 — Demo expiry cleanup architecture preflight

## Change History

- 2026-10-19: Revalidated this preflight against the delivered Task 3.4 schema, copier, admission locking, and QA handoff. Replaced the earlier assumption that showcase-copy persistence was still pending.

## Scope and status

Backend-only source architecture for Task 3.5. Expiry authorization remains immediate; cleanup is eventual, bounded, restartable work attached to the existing periodic maintenance lifecycle. Use the existing Clean Architecture demo module and infrastructure adapters. There is no frontend/FSD change, no new endpoint or public DTO required by this design, and no Context7-dependent API. DDD, Hexagonal Architecture, a new worker service, queue framework, or generic cleanup framework are excluded. Ponytail FULL applies: extend the narrow seams below.

Migration 1710000033000 and the TypeOrmDemoShowcaseCopyManager are present in this checkout. Task 3.4 QA reports cycle-2 PASS, while tasks.md still records Task 3.4 as in progress pending its commit. This is source inspection, not runtime evidence. Before Task 3.5 implementation, the release owner must confirm the delivered Task 3.4 commit/hash matches the current source and migration 0033.

## Source-verified decisions

| Concern | Current behavior | Task 3.5 decision |
| --- | --- | --- |
| Expiry authorization | GetSessionUseCase rejects an expired session or expired account. TypeOrmUserRepository.isActive also checks is_active and expires_at. | Preserve these checks as the access boundary. Cleanup lag never grants access. Use PostgreSQL clock_timestamp() for due-work selection. |
| Admission and replay | Migration 0031 stores unique request_key_digest, nullable owner_id with ON DELETE SET NULL, expires_at, and public states pending/ready/failed. Same-key lookup returns status only; beginAdmission takes global/key advisory locks before looking up the key and before counter changes. | Discover expired owners across admission pending, failed, and ready states. At completion keep the digest row, set its public state to failed with an internal expired failure code, and let user deletion set owner_id NULL. Same-key replay stays status-only and cannot create an owner, bootstrap, recover a session, or increment counters. Preserve the global/network admission counters. |
| Showcase copy and pin | Migration 0033 stores one demo_showcase_copies row per admission, owner_id with ON DELETE RESTRICT, pinned_version_id with ON DELETE RESTRICT, fixed target_project_id, pending/ready/failed state, phase, claim_token, claim_expires_at, attempts/retry_allowed, failure_code, and ID map. Ready requires phase complete. The copier locks admission → user → copy. Readiness requires the same claim token plus active, unexpired owner and ready admission. A completed copy clears its pin; an incomplete copy retains it. | In the fence transaction disable retry and invalidate the current copy claim, but keep an incomplete pin until every copy effect is quiescent and its owner data is purged. Delete the copy row only at finalization; that releases its restrictive owner/version references. Never delete showcase_versions, showcase_files, showcase_publication, or administrator source rows. |
| Copy file effects | TypeOrmDemoShowcaseCopyManager persists a claim before work. Each file uses StorageQuotaFileMutation with a stable showcase-copy:<admission>:<file> operation key, a reservation before IO, trusted mapping resolution, byte/hash verification, then settle. Unknown reservations block copy readiness. | Treat pending/unknown reservations as live cleanup barriers. Never release them or forget them because cancellation was requested. Wait for settled/released status or safe reconciliation before deleting their root. |
| Copy root creation | A claimed file-backed copy writes phase root_pending, then calls createManagedProjectRoot outside a DB transaction, then records root_created and creates the project/mapping. The claim token fences later DB transitions, but root creation has no durable filesystem-operation receipt. | Required narrow Task 3.5/3.4 seam: journal root-create intent and its terminal verified/absent/unknown outcome under a stable operation ID. A stale copy may acknowledge only its own effect receipt after its claim is fenced; it cannot advance readiness. Cleanup must not purge a root while that receipt can still produce a late directory. An expired claim lease is not proof of quiescence. Keep cleanup pending on unknown outcomes. |
| Project and quota cleanup | Ordinary TypeOrmProjectRemovalRepository uses quota accounting and active-principal checks, removes project records, and deliberately retains authoritative roots and references. Its cleanupPending() resumes project_removal_jobs. Storage accounting locks account_limits before totals/references/resource rows. | Do not use ordinary project removal as the whole demo purge: it retains roots and its interactive mutation path rejects expired principals. Add a narrow maintenance-authorized owner purge that proves the cleanup generation, keeps account_limits → storage totals → root-allocation lock → mapping/reservation/reference → resource-row order, transitions mappings to retained, and removes them only after verified physical deletion. Keep project_removal_jobs intact until its existing recovery phase finishes. |
| Root and recovery boundaries | TypeOrmStorageRootMappingRepository resolves persisted owner/project mappings and deleteVerifiedRetained rejects remaining references or pending/unknown reservations. WorkspaceBoundaryAdapter validates managed marker, canonical target, containment, and reparse/symlink safety. ProjectRecoveryCleaner accepts only run UUIDs and validates the configured recovery root and tree. | Purge only exact manifested managed project roots resolved from persisted mappings. Legacy roots, /workspace, missing markers, unsafe/reparse paths, mapping mismatches, and unknown namespace children fail closed. Never recursively delete an owner or shared namespace directory. Use ProjectRecoveryCleaner only with manifested run IDs; never delete RECOVERY_ROOT. |
| Existing maintenance | startPeriodicMaintenance is single-flight per process and runs storage staging cleanup plus physical-volume observation. Project removal recovery and storage reconciliation also have existing startup hooks. | Add a bounded demo-expiry pass to this existing maintenance task. Use PostgreSQL leases and SKIP LOCKED claims for cross-process coordination. The timer is only a trigger; the persisted phase is the work record. Do not add another service or hold transactions across filesystem/runtime/provider IO. |

## System flow

```text
Authenticated request ── account/session expiry check ── deny at expiry
                                                       (independent of cleanup)

Existing periodic maintenance
  └─ bounded due admission claim
       └─ admission → owner → copy lock; persist owner fence + manifest + phase
            └─ cancel runs/commands; drain copy and file effects
                 └─ finish existing project-removal/recovery jobs
                      └─ purge manifested DB content, managed roots, recovery data
                           └─ reconcile quota; release pin/copy row
                                └─ tombstone admission; delete demo user
```

## Narrow implementation contract

1. Add an admission-owned cleanup phase, or one cleanup-job row keyed by admission. Persist a generation/fencing token, lease expiry, attempt count, next retry time, safe failure code, current phase, and an immutable manifest of typed owner/admission/copy/project/run/command/reservation/root-mapping IDs. Persist no absolute or caller-supplied path. Index the bounded due query. Keep this one demo workflow inside existing maintenance.

2. Select due rows using the persisted demo owner and database time, covering pending, failed, and ready admissions. Claim bounded batches with SKIP LOCKED. The cleanup row may be claimed first; source rows must then be locked in the existing order: demo_admissions FOR UPDATE → users FOR UPDATE → demo_showcase_copies FOR UPDATE. Never acquire the global/key admission advisory locks after locking an admission, and never update or reset global/network admission or spending counters.

3. In a short transaction mark the principal inactive, store the cleanup generation/immutable manifest/phase, set the copy retry_allowed false, and revoke its claim token. Expiry already denies normal access before this tick. Commit before cancellation or IO. Every resumed phase compares the current cleanup generation. Existing copy callbacks and later Task 4.1/provider/run callbacks must recheck owner expiry/activity and cleanup generation before a dispatch, durable write, event, promotion, or download.

4. Request cancellation through existing run/command use cases and gateways, then inspect persisted outcomes. Cancellation is not quiescence. Keep the job pending while a run, sandbox command, provider outcome, copy root operation, or filesystem reservation can still produce an effect. Existing stable file operation IDs are part of the manifest; unknown results remain charged and unavailable for reconciliation.

5. Finish any existing project_removal_jobs with the existing recovery cleaner before owner deletion. For demo-owned project records, the internal purge path must use the cleanup generation in place of the expired interactive-principal check while retaining account_limits-first accounting and existing root/reservation barriers. Ordinary project removal semantics remain unchanged. Transition each proven managed root to retained before deleting its project row; resolve and remove only that exact strict child, verify absence, release only its verified file references, then call the retained-mapping deletion guard. An untracked root_pending target may be adopted only from the exact manifest project UUID after managed-namespace inspection and conflict checks. Unknown children or legacy mappings keep the account/job unavailable.

6. Purge recovery using only manifest run UUIDs through ProjectRecoveryCleaner; retain project_removal_jobs and recovery charges until verified purge. Remove owner-scoped database content through the current ownership/canonical accounting inventory, including the copied tasks/facts, sessions, runs/commands, conversations/events, action records, and quota references. Preserve regular users, administrator source content, shared published versions, global admission/spending ledgers, and global counters.

7. Finalize only when no active copy claim/effect receipt, project-removal job, pending/unknown reservation, unresolved run/command, root mapping/reference, or recovery item remains. Delete the demo_showcase_copies row, update demo_admissions to failed with internal failure_code expired, then delete the user; its admission owner FK becomes NULL. Remove the cleanup record after successful finalization. Keep the unique request digest for its configured replay-retention period. Do not expose cleanup phases or new public states.

8. Task 6.4 exports and Task 7.1 schedules are future cleanup contributors: their owner modules must supply exact artifact/job IDs, pre-download/pre-dispatch expiry and cleanup-generation checks, and a purge receipt. Until delivered, do not invent their tables or paths.

## Files and module boundaries

- Use case and ports: Personal-AI-Workspace/backend/src/modules/demo/use-cases/ and the demo-owned repositories/domain contracts. No controller or route is needed.
- Persistence and wiring: Personal-AI-Workspace/backend/src/infrastructure/database/migrations/ (additive migration after 0033), the demo/admission/copy TypeORM repositories, Personal-AI-Workspace/backend/src/composition-root.ts, and Personal-AI-Workspace/backend/src/infrastructure/startup/periodic-maintenance.ts.
- Existing effect boundaries to reuse or narrowly extend: TypeOrmDemoShowcaseCopyManager; TypeOrmStorageQuotaRepository and TypeOrmStorageContentAccounting; TypeOrmProjectRemovalRepository; TypeOrmStorageRootMappingRepository; WorkspaceBoundaryAdapter; ProjectRecoveryCleaner; existing run and sandbox cancellation use cases/gateways.
- Migration ownership: the release owner reserves the exact next version when implementation starts. Never edit delivered migrations 0029–0033. Implement a reversible/additive migration; rollback must refuse while cleanup jobs or expiry tombstones remain rather than deleting replay history.

## Essential proof matrix

| Proof | Required result |
| --- | --- |
| Access before maintenance tick | Expired session/account is denied without waiting for cleanup. |
| Admission discovery and replay | Expired pending, failed, and ready owners are claimed; post-purge same-key replay reports only failed status and creates no owner/session, bootstrap, credit, or admission-counter change. |
| Lock/race and restart | Multiple claimers and restarts cannot skip/duplicate phases; cleanup and copy readiness serialize as admission → owner → copy; stale token cannot mark ready or release the pin early. |
| External effects | Cancellation-unknown, late provider callbacks, root creation, and file reservations cannot append or promote after purge. Unknown effects keep the phase/root unavailable until resolved. |
| Isolation | Regular-account rows/roots, admin source data, published/current showcase versions, and global counters/spending survive. |
| Filesystem/recovery | Traversal, legacy root, /workspace fallback, missing/wrong marker, reparse/symlink, mapping mismatch, overlapping or unknown namespace entries fail closed. Only manifested managed project children and run UUID recovery paths can be removed. |
| Quota/removal | account_limits ordering holds; references/reservations release only after verified deletion; project_removal_jobs survive until recovery completes; no zero/unknown shortcut. |
| Operations | Crash after each phase resumes; cleanup lag is measurable without logging keys, IPs, owner paths, source IDs, credentials, or exception text. |

This is an architecture preflight only. It records no runtime, PostgreSQL, migration, test, build, filesystem-mount, browser, or deployment proof. Task 3.4's QA evidence remains at .codex/docs/hackathon-release/task-3-4-showcase-and-demo-entry/qa-report.md; recheck the delivered source hash before implementation.


## QA cycle 1 — credit-ledger retention decision

Preserve settled per-call credit reservations and usage entries as durable financial audit detail. Migration 0028 currently makes reservation and usage `owner_id` non-null; the reservation owner FK cascades on user deletion, while usage owner and usage-to-reservation FKs restrict it. Extend Task 3.5's still-undelivered migration 0034 to make only those two `owner_id` columns nullable. Keep the existing FK actions, especially `credit_usage_entries.reservation_id ON DELETE RESTRICT`; do not delete ledger rows or change their pricing, token, charge, source, call/attempt, status, or reservation-link fields.

In finalization, preserve the established `demo_admissions → users → demo_showcase_copies` lock order and hold the demo `users` row `FOR UPDATE` while locking its credit reservations. Existing reserve, settle, retain-unknown, and release paths take `credit_runtime_policy` before the same user row, so that user lock serializes their state changes. Do not take `credit_runtime_policy` late in cleanup after admission/user locks: that would invert the ledger order against a transaction holding policy while waiting on the user. Treat `in_flight` as `busy` and `unknown` as `unknown_effect`; only `settled`, `released`, and `over_bound` reservations permit finalization. Once all are terminal, atomically set `owner_id = NULL` on every matching reservation and usage row before deleting the user. The existing FK actions then do not fire for these rows, and the reservation FK continues protecting the retained usage record. Leave shared `credit_demo_daily_windows` and `credit_demo_campaign_usage` totals unchanged. Owner-scoped queries continue filtering by `owner_id = $1`, excluding detached entries. A terminal settlement replay must return its stored result before any owner-specific lock when `owner_id` is null; unresolved rows must never be detached.

Before source repair, update the Task 3.5 contract to record this retention policy. The focused PostgreSQL regression must settle a real demo reservation, snapshot its immutable detail and global daily/campaign totals, finalize expiry, and assert the user/tombstone result, preserved reservation and usage rows with null ownership, unchanged shared totals, and unchanged regular/admin/showcase data. It must also prove an `in_flight`/`unknown` reservation blocks detachment and deletion until terminal resolution. Migration rollback must refuse once detached rows exist rather than restore `NOT NULL` or discard audit detail. Source inspection alone is not proof.
