# QA Report: Enforce account storage limits on every persistent write

## Change History

- 2026-10-19: Independent final QA completed. The earlier source-only integration precheck is historical; its Home cascade and conversation idempotency reference gaps were fixed and are covered by current removal integration evidence.

## Test Evidence Reviewed

- [x] Developer backend unit tests — Jest: 138 suites / 825 tests pass in the final current-tree run.
- [x] Independent focused backend unit tests — Jest: 24 suites / 167 tests pass.
- [x] Developer backend integration tests — Jest: 29 guarded PostgreSQL suites / 105 tests pass.
- [x] Independent focused backend integration tests — Jest: 6 suites / 10 tests pass; the generic quota suite was also independently rerun (1 suite / 3 tests, overlapping the six-suite run).
- [x] Backend type check: developer and independent runs pass.
- [x] Frontend unit and E2E tests: not applicable; Task 3.2 changes backend behavior only.
- [x] Whitespace/conflict check: developer `git diff --check` passes.
- [x] Compose boundary evidence reviewed: managed overlay/parser check passes; full baseline boundary check is 7/8 for the already logged NVIDIA-key/topology mismatch.

## Functional Acceptance Review

- [x] API behavior verified: authenticated `GET /api/v1/account/storage` derives the owner from the session, returns decimal byte strings, hides totals while reconciling/unavailable, and documents quota/accounting errors in OpenAPI.
- [x] Business rules and edge cases verified: exact UTF-8 and normalized JSONB bytes, per-copy accounting, concurrent positive growth, idempotent replay, rollback, over-limit shrink/delete, soft-delete retention, and safe reservation outcomes are covered by current unit and PostgreSQL evidence.
- [x] Error cases verified: quota/accounting failures, ownership hiding, no-side-effect release, verified settlement, and ambiguous/unknown outcomes retain their reservation or fail closed.
- [x] Migration and persistence outcomes verified: migrations 0029/0030 are registered and reversible; fresh/populated chains, backfill/readiness, persisted references, root mappings, rollback guards, and removal cascades are covered in the developer PostgreSQL regression and focused evidence.
- [x] `contract.md` alignment verified: all persistent write boundaries use the shared owner accounting path; relational writes use scoped identities and caller transactions; full scans are limited to startup/reconciliation; filesystem reservations commit before I/O; deletion releases only verified removed copies.
- [x] Startup and filesystem acceptance reviewed: pre-listen reconciliation fails closed for uncertain inventory; retained roots/recovery data remain charged until verified purge; staging is bounded and expired artifacts are safely swept.
- [x] Physical monitoring acceptance reviewed: optional, transition-only process-visible `statfs` observations do not change logical quota or readiness.

## Review Lenses Applied

- [x] Security review: owner authority is server-derived; relational mutations lock and verify the active principal; persisted root mappings determine trusted paths; unsafe roots/entries and ambiguous outcomes fail closed; public errors omit paths and other-account data.
- [x] Performance review: ordinary relational writes project only affected native IDs; full-owner scans are reserved for reconciliation; filesystem/provider work runs outside database transactions; staging cleanup is single-flight and bounded.
- [x] Usability and accessibility: not applicable; this task changes no user interface.

## Findings Summary

### functional acceptance

No blocking findings. Current contracts and code cover positive-growth admission, exact retained copies, counter rollback, shrink/delete while over limit, durable file reservations, startup reconciliation, project removal, and the owner-scoped usage API. The initial source-only precheck is superseded by the current cascade scope and focused PostgreSQL test.

### security

No Critical or High findings. File and recovery access is rooted in server-owned mappings and validated paths. Unknown filesystem or database outcomes remain unavailable/reconcilable rather than being treated as a successful no-op. No secrets or content paths are exposed by the storage DTO/errors.

### performance

No blocking findings. The final hot relational path is scoped to affected content identities; complete scans occur during quiescent startup/reconciliation only. Account-level serialization is intentional and filesystem operations do not hold its database lock.

### usability and accessibility

Not applicable for this backend-only task.

### non-blocking limits

The current task evidence does not claim an independent PostgreSQL quota-denial test for every Home, AI-run, change-set, sandbox, and project-metadata writer; these paths have focused unit coverage and use the shared repository boundary. This limitation is stated in the developer coverage matrix. No hosted provider call, physical host mount-source proof, or deployed capacity threshold is claimed; deployment verification belongs to Task 8.1. The Compose 7/8 baseline assertion is already recorded in the `tasks.md` Tech Debt Log and does not fail the new managed-overlay check.

## Evidence Index

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| Independent QA test log | Direct local Node/Jest/TypeScript runners | Six guarded PostgreSQL suites, focused quota rerun, 24 focused unit suites, independent typecheck; sanitized fixture details | [qa-independent-checks.md](artifacts/qa-independent-checks.md) |
| Developer final regression | Direct local Node/Jest runners | Full current-tree unit and guarded PostgreSQL results, resource-specific cases, Compose boundary result | [final-regression.md](artifacts/final-regression.md) |
| Developer filesystem/staging/removal validation | Direct local Jest runners | File reservations, recovery cleanup, staging, project-removal and cascade proof | [filesystem-staging-removal-validation.md](artifacts/filesystem-staging-removal-validation.md) |
| Storage API tests | Direct local Jest runners | Authenticated DTO, owner isolation, decimal byte serialization, status/error and OpenAPI coverage | [api-focused-test-results.md](artifacts/api-focused-test-results.md) |
| Task/fact/conversation persistence tests | Direct guarded PostgreSQL Jest integration | Exact JSONB/UTF-8 bytes, idempotency copies, denial rollback, over-limit shrink, retained soft-delete | [test-project-task-storage-quota.md](artifacts/test-project-task-storage-quota.md), [test-conversation-storage-quota.md](artifacts/test-conversation-storage-quota.md), project fact test in `final-regression.md` |
| Current implementation and source manifest | Repository source review | Scoped relational projections, file reservations, startup reconciliation, staging, authenticated route, migrations, and composition wiring | `backend/src/infrastructure/database/storage-content-accounting.ts`, `storage-content-projections.ts`, `repositories/typeorm-storage-quota-repository.ts`, `backend/src/infrastructure/workspace/`, `backend/src/infrastructure/startup/`, `backend/src/infrastructure/staging/`, `backend/src/modules/storage-quotas/`, `backend/openapi.json`; source inventory in [dev-summary.md](dev-summary.md), “Files Changed” |
| Developer handoff/self-review | Developer report | Full test status, change inventory, coverage boundaries, known limitations, and self-review notes | [dev-summary.md](dev-summary.md), “Code Review Findings (and resolutions)” |
| Required MCP inputs | `tasks.md` | Browser and Context7 evidence are explicitly N/A for backend-only scope | `.codex/docs/hackathon-release/tasks.md`, Task 3.2 MCP Inputs & Required Evidence |

## Definition of Done Checklist

- [x] Code quality: developer self-review passed; independent backend typecheck passed; source review found no blocking standards issue.
- [x] Architecture: implementation matches `architecture.md`; accounting remains in the storage/infrastructure boundary and callers retain transaction ownership.
- [x] Documentation: API and errors are in OpenAPI; setup and limitations are documented in README and task evidence.
- [x] Database: additive 0029/0030 migrations are registered, reversible, and covered by fresh/populated PostgreSQL evidence.
- [x] Testing: developer unit, PostgreSQL integration and typecheck checks pass; independent focused unit and PostgreSQL checks pass; no test is skipped as proof.
- [x] Backend DoD: API status/error behavior and authenticated owner scope are tested; no caller path or storage location is accepted as quota authority; storage errors do not reveal host paths.
- [x] Review: developer self-review and required test review are recorded; independent security and performance reviews found no blocking issue.
- [x] MCP evidence: `tasks.md` declares Playwright, Chrome DevTools and Context7 as N/A for this backend-only task; no required MCP artifact is missing.
- [x] Non-blocking Compose baseline debt is recorded in the `tasks.md` Tech Debt Log.

## Verdict: PASS

## Failure Details

Not applicable. No Critical or High findings remain open. The known Compose baseline assertion and deployment-only host mount/capacity checks remain outside this task's acceptance boundary and are explicitly tracked.
