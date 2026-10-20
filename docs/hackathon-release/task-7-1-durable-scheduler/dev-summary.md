# Dev Summary: Durable daily schedules and occurrence worker

## Change History

- 2026-10-19: Implemented the durable scheduler and its Home/runtime and cleanup fences.
- 2026-10-20: Fixed TypeORM delete-result accounting, completed the guarded expiry proof, and split API and worker lifecycle ownership.

## What Was Implemented

PostgreSQL schedules and occurrences, an independent bounded worker, schedule and Run now APIs, IANA local-time/DST resolution, and trusted Home invocation/pre-send/poll/result fences. Cleanup expiry and workspace removal now cancel linked Home work outside database locks and retain barriers for unresolved work. The schedule boundary remains one owned workspace and one read-only skill revision per conversation.

The expiry cleanup integration case passed after a narrow TypeORM mutation-result normalization. Failure-only stage diagnostics remain bounded to safe metadata and omit query parameters and messages.

API mode starts storage/project/demo maintenance only. The standalone `start:worker` / `dev:worker` entrypoint starts only the bounded scheduler loop, never opens HTTP, drains its active pass on SIGINT/SIGTERM, and closes PostgreSQL. Startup validation failures destroy an initialized data source.

## Files Changed

- Backend: automation domain, repository port, use cases, router, TypeORM repository, migration 0038, migration registration, composition, app routes, OpenAPI, standalone worker and lifecycle selector; Home/skills invocation and turn fences; demo-expiry cleanup and project-removal barriers.
- Tests: automation time/router/worker/repository/migration/OpenAPI tests, startup lifecycle, worker shutdown, composition startup cleanup, scheduler PostgreSQL integration suite, focused cleanup repository unit test, and the filtered cleanup case in the demo-expiry integration suite.
- Runtime configuration/docs: `backend/package.json` worker commands and root `README.md` process instructions.
- Docs: `contract.md`, `architecture-preflight.md`, `source-map.md`, `exact-source-manifest.txt`, and `artifacts/` evidence. The top-level `verification-receipt.md` retains the earlier attempt chronology.

Exact paths and existing seams are listed in `source-map.md`. Shared Home/router/composition/OpenAPI files also contain separate Task 6.3 changes; preserve that owner’s summary projection hunks.

## Contract Notes

One schedule binds to one active owned mutable workspace, one persisted Home conversation, and one current read-only skill revision. An occurrence has a stable request key and a fenced lease. Potentially sent or unknown work is reconciled without another runtime start. Starting the API alone no longer runs schedules; at least one standalone worker must share the database and application environment. API shapes and errors are in `contract.md` and OpenAPI.

## Architecture Alignment Notes

Uses PostgreSQL leases and `SKIP LOCKED`, existing Home skill invocation/runtime/policy/credit/storage paths, and native `Intl` time-zone handling. Worker mode uses the shared composition without an HTTP listener or additional queue/runtime. Shutdown drains the periodic pass before closing PostgreSQL. Cleanup retains the established lock order and does not purge settled financial ledger history.

## Evidence Collected

- Prior focused Jest evidence: automation scheduler integration 4/4, including a fresh child worker process that polled a persisted turn once and made zero new invocation calls; managed-workspace Home handler 14/14.
- Current Jest evidence: cleanup repository unit 1/1; automation OpenAPI contract 1/1.
- Current backend TypeScript check passed: `tsc --project tsconfig.json --noEmit --pretty false`.
- Lifecycle Jest evidence: 4 suites / 8 tests passed, covering API-versus-worker selection, signal handling, worker drain/database close, and startup-validation database cleanup. See `artifacts/worker-lifecycle.md`.
- Backend production build and alias replacement passed; the build emitted `dist/automations-worker.js`.
- The final guarded cleanup run passed 1/1 with 3 unrelated cases skipped and a fresh postguard; current proof is in `artifacts/verification-receipt.md`, with full earlier failures retained in the historical `verification-receipt.md` checkpoint.

## MCP Notes

Context7 was unavailable during the architecture preflight; installed Node `Intl` APIs were used. No browser evidence applies to this backend task.

## Code Review Findings (and resolutions)

The schedule dispatch and commit paths remain fenced by persisted current state, and unknown runtime outcomes are not retried. The lifecycle review found HTTP startup also started the scheduler; explicit API/worker mode now separates those loops. The storage regression was fixed without weakening quota invariants.

## Test Coverage Summary

Focused lifecycle Jest checks pass 4 suites / 8 tests. Backend typecheck, production build, and alias replacement pass. Prior scheduler 4/4, managed-workspace Home 14/14, and guarded cleanup PG 1/1 with 3 unrelated skips are retained.

## Known Limitations / Tech Debt

The standalone worker needs a process supervisor in deployment; deployment wiring is outside this task. No live paid inference was performed or claimed.

## Ready for QA: YES
