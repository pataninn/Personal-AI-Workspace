# Dev Summary: Enforce account storage limits on every persistent write

## Change History

- 2026-10-19: Completed the integrated storage-quota implementation, current-tree validation, and release-boundary review. The source manifest, scoped coverage matrix, exact results, and known limitations follow.

## What Was Implemented

- Implemented exact integer-byte accounting, owner-scoped usage, authenticated `GET /api/v1/account/storage`, safe quota/accounting errors, and OpenAPI documentation.
- Added migrations 0029/0030 for storage totals, references, durable file reservations, the shared account limit, and active/retained root mappings. Existing accounts remain reconciling until canonical inventory is verified.
- Wired relational writes through caller-owned QueryRunner transactions and scoped identity projections. PostgreSQL derives exact stored UTF-8/JSONB sizes for affected copies on hot writes; whole-owner scans are reserved for startup/reconciliation.
- Wired file/recovery writes through committed reservations, verified settlement, durable project-removal barriers, retained-root charging, and recovery cleanup. Startup reconciles only at the pre-listen quiescent boundary and fails closed on unknown or unsafe inventory.
- Added bounded staging lifecycle checks and process-visible physical free-space observations. The optional disk threshold emits transition-only internal warnings and does not change logical quota or readiness.

## Files Changed

### Backend

- `backend/src/modules/storage-quotas/domain/storage-quota-errors.ts`
- `backend/src/modules/storage-quotas/domain/storage-quota-types.ts`
- `backend/src/modules/storage-quotas/domain/storage-quota-policy.ts`
- `backend/src/modules/storage-quotas/domain/storage-quota-policy.spec.ts`
- `backend/src/modules/storage-quotas/domain/storage-file-operation-fingerprint.ts`
- `backend/src/modules/storage-quotas/domain/storage-file-operation-fingerprint.spec.ts`
- `backend/src/modules/storage-quotas/repositories/storage-quota-repository.ts`
- `backend/src/modules/storage-quotas/use-cases/get-storage-usage.ts`
- `backend/src/modules/storage-quotas/use-cases/get-storage-usage.spec.ts`
- `backend/src/modules/storage-quotas/repositories/storage-root-mapping-repository.ts`
- `backend/src/modules/storage-quotas/controllers/account-storage-router.ts`
- `backend/src/modules/storage-quotas/controllers/account-storage-router.spec.ts`
- `backend/src/infrastructure/database/migrations/1710000029000-add-account-storage-limit.ts`
- `backend/src/infrastructure/database/migrations/1710000029000-add-account-storage-limit.spec.ts`
- `backend/src/infrastructure/database/repositories/typeorm-storage-quota-repository.ts`
- `backend/src/infrastructure/database/repositories/typeorm-storage-quota-repository.spec.ts`
- `backend/src/infrastructure/workspace/storage-quota-file-mutation.ts`
- `backend/src/infrastructure/workspace/storage-quota-file-mutation.spec.ts`
- `backend/src/infrastructure/workspace/storage-quota-reconciliation.ts`
- `backend/src/infrastructure/workspace/storage-quota-reconciliation.spec.ts`
- `backend/test/integration/storage-quota.integration.spec.ts`

Additional backend and setup files:

- Application wiring/API: `backend/src/app.ts`, `backend/src/server.ts`, `backend/src/composition-root.ts`, `backend/openapi.json`, `backend/src/openapi/storage-quota-openapi.spec.ts`, `backend/src/infrastructure/config/app-config.ts`, `backend/src/infrastructure/config/app-config.spec.ts`, `backend/src/infrastructure/database/data-source.ts`.
- Migrations and accounting: `backend/src/infrastructure/database/migrations/1710000029000-add-account-storage-limit.ts` and `.spec.ts`; `backend/src/infrastructure/database/migrations/1710000030000-create-storage-root-mappings.ts` and `.spec.ts`; `backend/src/infrastructure/database/project-removal-write-barrier.ts` and `.spec.ts`; `backend/src/infrastructure/database/storage-content-accounting.ts` and `.spec.ts`; `backend/src/infrastructure/database/storage-content-projections.ts`; `backend/src/infrastructure/database/storage-content-references.ts` and `.spec.ts`.
- Relational repositories: `backend/src/infrastructure/database/repositories/home-conversation-repository-helpers.ts`; `typeorm-action-ledger-repository.ts` and `.spec.ts`; `typeorm-ai-run-repository.ts` and `.spec.ts`; `typeorm-change-set-repository.ts` and `.spec.ts`; `typeorm-conversation-repository.ts` and `.spec.ts`; `typeorm-home-change-proposal-repository.ts`; `typeorm-home-conversation-repository.ts` and `.spec.ts`; `typeorm-project-fact-repository.ts` and `.spec.ts`; `typeorm-project-file-access.ts` and `.review.spec.ts`; `typeorm-project-removal-repository.ts` and `.spec.ts`; `typeorm-project-repository.ts` and `.spec.ts`; `typeorm-project-task-repository.ts` and `.spec.ts`; `typeorm-sandbox-command-repository.ts`; `typeorm-task-mutation-participant.spec.ts`; `typeorm-storage-quota-repository.ts` and `.spec.ts`; `typeorm-storage-root-mapping-repository.ts` and `.spec.ts`.
- Startup, staging, and workspace: `backend/src/infrastructure/startup/periodic-maintenance.ts` and `.spec.ts`; `physical-storage-space-monitor.ts` and `.spec.ts`; `storage-quota-startup-reconciler.ts`; `backend/src/infrastructure/staging/fake-staging-gateway.ts`; `local-staging-gateway.ts` and `.spec.ts`; `backend/src/infrastructure/workspace/storage-quota-file-mutation.ts` and `.spec.ts`; `storage-quota-reconciliation.ts` and `.spec.ts`; `project-recovery-cleaner.ts` and `.spec.ts`; `workspace-boundary.ts` and `.spec.ts`; `workspace-mutation-gateway.ts` and `.spec.ts`.
- Use cases and ports: `backend/src/modules/ai-runs/repositories/staging-gateway.ts`; `workspace-mutation-gateway.ts`; `backend/src/modules/ai-runs/use-cases/ai-run-use-cases.spec.ts`; `cancel-ai-run-use-case.ts`; `change-set-use-cases.ts` and `.spec.ts`; `direct-egress-use-case.spec.ts`; `start-ai-run-use-case.ts` and `.spec.ts`; `backend/src/modules/files/repositories/project-file-access.ts`; `backend/src/modules/files/use-cases/project-file-actions.ts`; `backend/src/modules/projects/repositories/project-repository.ts`; `workspace-boundary.ts`; `backend/src/modules/projects/use-cases/project-use-cases.spec.ts`; `update-project-status.ts`.
- Resource integration tests: `backend/test/integration/project-fact-storage-quota.integration.spec.ts`; `project-conversation-storage-quota.integration.spec.ts`; `project-task-storage-quota.integration.spec.ts`; `project-removal-storage-quota.integration.spec.ts`; `storage-quota-startup-reconciliation.integration.spec.ts`.
- Readiness fixture updates: `backend/test/integration/home-consent.integration.spec.ts`; `home-conversation-events.integration.spec.ts`; `home-planning-command-parity.integration.spec.ts`; `home-planning-proposal-execution.integration.spec.ts`; `r1-populated-migration.integration.spec.ts`; `r1-release-http-postgres.integration.spec.ts`; `project-file-actions-review.integration.spec.ts`.
- Setup docs/config: `README.md`; `.env.example`.

The current app worktree inventory contains 107 Task 3.2 paths. The six unrelated baseline files (including pre-existing untracked `ponytail-review.md`) remain outside this task.

### Shared

- `.codex/docs/hackathon-release/task-3-2-storage-quotas/contract.md`
- `.codex/docs/hackathon-release/task-3-2-storage-quotas/dev-summary.md`
- `.codex/docs/hackathon-release/task-3-2-storage-quotas/artifacts/storage-quota-validation.md`
- `.codex/docs/hackathon-release/task-3-2-storage-quotas/artifacts/final-regression.md`
- `.codex/docs/hackathon-release/task-3-2-storage-quotas/artifacts/filesystem-staging-removal-validation.md`
- `.codex/docs/hackathon-release/task-3-2-storage-quotas/artifacts/api-focused-test-results.md`
- `.codex/docs/hackathon-release/task-3-2-storage-quotas/artifacts/test-conversation-storage-quota.md`
- `.codex/docs/hackathon-release/task-3-2-storage-quotas/artifacts/test-project-task-storage-quota.md`
- `.codex/docs/hackathon-release/task-3-2-storage-quotas/artifacts/test-home-fixture-readiness.md`

## Contract Notes

- Byte counts stay exact as PostgreSQL `BIGINT` values and are serialized as decimal strings in the usage DTO. The shared `account_limits` row is the lock anchor; storage counters remain separate from credit counters.
- The owner comes only from the authenticated session. The API never exposes root paths or another account's data. Null limits mean unlimited; zero blocks positive growth.
- Relational writes charge exact stored UTF-8 and PostgreSQL-normalized JSONB bytes for each retained content copy. Operation hashes and metadata-only fields are excluded; raw persisted user-content fingerprints are included.
- README documents storage settings and the intentionally fail-closed paid-runtime prerequisites. A provider key or price alone cannot enable a runtime without an enforceable request bound and admission path.

## Architecture Alignment Notes

- Domain policy and DTO mapping stay inside the storage module; SQL and filesystem operations remain in infrastructure adapters. Relational mutations use scoped IDs and the existing QueryRunner; whole-account scans run only at reconciliation.
- Filesystem writes commit a durable reservation before I/O and settle verified outcomes, release proven no-side-effect outcomes, or retain ambiguous outcomes for reconciliation. No database lock spans filesystem/provider work.
- Startup marks accounts reconciling before scanning, resolves only provable reservations at the quiescent pre-listen boundary, inventories attached/retained and validated managed-orphan roots, and finalizes readiness only after a final reservation check.
- Staging is transient, capped at 256 KiB per file and 2 MiB per run, marked with a strict 24-hour expiry, checked before prepared runs start, and cleaned after confirmed destruction or by a bounded sweep.
- `STORAGE_DISK_WARNING_FREE_BYTES` is optional and has no default. If set, process-visible `statfs.bavail * bsize` observations produce transition-only internal warnings for `/workspace`, configured managed storage, and `RECOVERY_ROOT`; unavailable observations are unknown, not zero. This hook does not affect readiness, logical quota, write admission, or the public DTO. Task 8.1 owns host-mount verification and deployment threshold setup.

## Evidence Collected

- `.codex/docs/hackathon-release/task-3-2-storage-quotas/artifacts/final-regression.md` records final typecheck, unit, PostgreSQL, Compose-boundary, and resource-specific results.
- `.codex/docs/hackathon-release/task-3-2-storage-quotas/artifacts/filesystem-staging-removal-validation.md` records filesystem, staging, cleanup, and project-removal evidence.
- `.codex/docs/hackathon-release/task-3-2-storage-quotas/artifacts/api-focused-test-results.md`, `artifacts/test-conversation-storage-quota.md`, `artifacts/test-project-task-storage-quota.md`, and `artifacts/test-home-fixture-readiness.md` record focused slice evidence.
- `artifacts/qa-early-review.md` and `artifacts/qa-integration-precheck.md` are historical source-only reviews; their findings are resolved in the implementation/current tests and they are not the final QA verdict.

## MCP Notes

- This task changes backend APIs and setup, not browser UI. No Context7 or browser evidence was needed; no provider/runtime calls were made.

## Code Review Findings (and resolutions)

- Aligned storage path validation and schema limits with the existing 2,048-character file route.
- Made migration rollback refuse to drop an account after reconciliation, even when its current counters are zero.
- Normalized persisted JSONB outcome byte strings back to `bigint` on idempotent file-operation replay.
- Early review found full-owner canonical scans on hot relational writes. The final hot path scopes queries to native affected IDs; full scans are confined to serialized startup/reconciliation.
- Source review found project removal omitted raw conversation fingerprints and content deleted by Home/project cascades. The final scope and PostgreSQL test verify those references are released while detached/retained copies remain charged.
- Startup review found managed namespace orphans. Validated owner/project UUID directories are registered as retained; unsafe owner-specific roots leave that owner unavailable, and unattributable global entries block readiness.
- Home race-test observers initially waited for the wrong SQL edge under account-first lock ordering. They now observe the exact blocker-PID chain without changing deadlines or winner assertions.
- The Compose boundary suite remains 7/8: its sole failure is a pre-existing NVIDIA-key assertion inconsistent with the current Nebius base provider default. The managed-storage overlay check passes; no Compose source or boundary assertion was changed.
- Self-review found no embedded credentials, database URLs, debug logging, or new request-path filesystem authority in the changed storage code.

## Write-Path Coverage Matrix

| Writer / operation | Wiring and charged copies | Transaction / deletion behavior | Evidence |
| --- | --- | --- | --- |
| Project metadata create/planning/update | Names and objectives are measured in the same owner transaction | Same QueryRunner accounting; positive net delta checked before commit | Focused unit coverage; no dedicated PostgreSQL quota-denial writer test |
| Project facts | Title/content text and JSONB; verify and soft-delete retain content | Same QueryRunner; shrink remains available over limit | PostgreSQL fact quota test (1 suite / 1 test) |
| Project conversations/messages | Titles, message bodies, raw `conversation_idempotency_keys.request_fingerprint` copies | Same QueryRunner and removal barrier; replay does not double-charge | PostgreSQL conversation quota test (1 / 1) |
| Tasks/subtasks/suggestions/action ledger | Task title/details/checklist/subtasks JSONB, retained suggestions, reversible/outcome JSONB; action-ledger SHA-256 fingerprints are metadata and excluded | Participant and repository writes share the transaction; removal barrier applies | PostgreSQL task/action-ledger test (1 / 1) |
| Project removal/cascades | Releases only rows removed; retains authoritative root, detached receipts, recovery copies, surviving Home content | Durable barrier precedes quarantine; verified purge is required to release retained file/recovery bytes | PostgreSQL removal/cascade test (1 / 2), includes raw fingerprints and Home cascades |
| Home conversation/event/proposal writes | Home titles/messages/events/proposal commands and action-ledger content copies | Owner/account transaction and workspace project-job barrier when scoped | Focused unit coverage; five Home/R1 compatibility PG suites pass, but no separate quota-denial test for each Home writer |
| AI-run output, change sets, sandbox commands | Run/user content, assistant output, suggestions, operation/checkpoint/command JSON | Same transaction and removal barrier; expired-principal output suppressed | Focused unit coverage; R1 PG expiry test proves late-output denial, not individual quota denial for each writer |
| Project files and recovery | Verified live bytes, recovery copies, retained project roots | Committed reservation before I/O; verified settlement only; unknown outcomes stay charged | Temp filesystem tests plus PG reservation/startup/removal checks; no host mount-source proof |
| Startup/backfill/orphan inventory | Canonical DB content, attached/retained roots, recovery refs, validated managed orphan dirs | Quiescent pre-listen reconciliation; unknown/unsafe inventory is never treated as zero | Guarded PG migration/startup coverage included in full 29/105 |
| Staging/physical monitoring | Staging is transient and excluded from account usage; disk observations are process-visible only | Bounded 24h sweep and transition warnings; no logical quota/readiness effect | Unit/temp-FS checks; deployment threshold and host capacity remain Task 8.1 |

## Final Test Coverage Summary

- Backend TypeScript check: `node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` from `backend` — exit 0.
- Complete backend Jest unit suite: `node ./node_modules/jest/bin/jest.js --config jest.config.cjs --runInBand` from `backend` — exit 0, 138 suites / 825 tests.
- Complete guarded PostgreSQL Jest integration suite: `node ./node_modules/jest/bin/jest.js --config jest.integration.config.cjs --runInBand` from `backend`, with the isolated fixture loaded privately and strict prelaunch identity checks — exit 0, 29 suites / 105 tests.
- The five adjusted Home/R1 fixture suites also passed 5 suites / 15 tests and are included in the full PostgreSQL total.
- `node --test scripts/compose-boundary-check.test.mjs`: exit 1, 7/8 pass. One unchanged baseline assertion expects an NVIDIA key despite the current Nebius default; the managed-storage overlay check passes.
- `git diff --check`: exit 0; only CRLF normalization notices were emitted.

The following foundation-only results are historical and superseded by the complete current-tree runs above.

## Historical Foundation Test Coverage

- Backend TypeScript check: `tsc --noEmit -p tsconfig.json` — PASS.
- Focused backend Jest: 7 storage suites, 31 tests — PASS.
- Guarded PostgreSQL Jest integration: 1 suite, 3 tests — PASS, exit code 0. The integration test applied the full registered migration chain, including migration 0029, and created/dropped its unique test database.

## Current Known Limitations / Tech Debt

- Run, change-set, sandbox, some Home, and project-metadata paths have focused unit coverage but are not each independently proven by a PostgreSQL quota-denial test; the matrix above distinguishes those limits.
- No hosted provider calls were made. Paid runtime remains fail-closed pending a verified hard input bound and enforceable all-egress admission boundary.
- Compose/parser tests do not prove deployed host mount source, mount identity, physical separation, or a production alert threshold; Task 8.1 owns these deployment checks.
- `storage-quota-validation.md` is a historical foundation artifact. Final current-tree evidence is in `artifacts/final-regression.md`.

## Ready for QA: YES
