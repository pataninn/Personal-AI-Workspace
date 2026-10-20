# QA Report: Implement durable daily schedules and job claiming

## Change History

- 2026-10-20, QA cycle 1: Reviewed the Task 7.1 contract, architecture preflight, developer summary, source map, exact source manifest, and implementation. Independently ran the schedule-time and worker unit suites (2 suites, 8 tests); both passed.
- 2026-10-20: Reviewed the accepted guarded PostgreSQL and lifecycle evidence. The existing PostgreSQL proof was reused; no new database run was needed.
- 2026-10-20: Recorded the accepted Low claim-index performance debt in the release Tech Debt Log. It does not affect correctness at the current bounded worker scale.

## Test Evidence Reviewed

- [ ] Developer frontend unit tests — Vitest (not applicable; backend-only task)
- [x] Developer backend unit tests — Jest
- [x] Developer backend integration tests — Jest with isolated PostgreSQL fixture
- [ ] Developer frontend E2E tests — Playwright (not applicable; backend-only task)

The focused evidence includes schedule-time tests (5), managed-workspace Home handler tests (14), lifecycle tests (4 suites / 8 tests), repository and OpenAPI checks, and the storage-quota query-result regression suite (11). The scheduler PostgreSQL suite passed 4/4. Its claim race used two repository instances/connections, not two worker processes. Its fresh-child restart case polled a persisted linked turn once, made zero skill invocation calls, and retained `interrupted_unknown`. The exact cleanup filter passed 1 case; its 3 unrelated skips are documented in the receipt. TypeScript typecheck, production build, alias replacement, and emission of `dist/automations-worker.js` passed.

Independent focused check, from `Personal-AI-Workspace/backend`:

```text
node node_modules/jest/bin/jest.js --runInBand src/modules/automations/domain/schedule-time.spec.ts src/modules/automations/use-cases/automation-worker.spec.ts
```

Result: 2 suites passed, 8 tests passed.

## Functional Acceptance Review

- [x] API behavior verified (applicable): authenticated owner-scoped schedule and occurrence routes, same-origin and CSRF checks for mutations, strict Zod body validation, bounded occurrence pages, OpenAPI coverage, and HTTP/router tests were reviewed.
- [x] Business rules and edge cases verified: local-time DST gap/fold behavior, downtime catch-up coalescing, stable Run now keys, lease takeover, stale-fence rejection, paused manual execution, read-only skill capability limits, and current owner/workspace/skill/context checks were reviewed against tests and source.
- [x] Error cases verified: invalid input, reused idempotency keys with a different fingerprint, revision conflicts, unavailable workspace/skill, expired leases, and unconfirmed cancellation outcomes are mapped to explicit errors or retained fail-closed states.
- [x] Migration or persistence outcomes verified (applicable): migration 0038 creates the schedule and occurrence constraints/indexes and refuses rollback while automation data remains. PostgreSQL evidence covers owner scoping, uniqueness/replay, claims, restart reconciliation, workspace-removal barriers, expiry purge, and settled-credit retention.
- [x] `contract.md` alignment verified (applicable): documented API behavior, PostgreSQL ownership, restart rules, cleanup barriers, and process ownership align with the reviewed implementation and OpenAPI spec.

The Home turn and occurrence link is committed before the runtime can start. A stable occurrence request key is reused, and a persisted potentially-sent turn is polled/reconciled without another runtime start. Final assistant output is fenced by the current lease, schedule revision, owner state, workspace, skill revision, policy, and captured context revisions. Cancellation runs outside database locks. Expired-demo purge and workspace removal remain blocked while scheduled work is unresolved; the guarded cleanup proof confirmed that settled credit rows and counters remain unchanged.

No live or paid provider inference is claimed. Task 7.2 provider-admission and receipt work remains a separate fail-closed dependency.

## Review Lenses Applied

- [x] Security review (applicable)
- [x] Performance review (applicable)
- [ ] Usability and accessibility review (not applicable; no user-facing UI changed)

## Findings Summary

### functional acceptance

PASS. The API, schedule persistence, DST resolution, worker lifecycle, unknown-outcome reconciliation, and cleanup barriers meet the Task 7.1 contract. The source map and manifest preserve Task 6.3's separate skill-run summary projection while retaining Task 7.1 scheduler dependency/fence wiring.

### security

PASS. Schedule routes derive the owner from the authenticated session; mutations require same-origin and CSRF checks; repository queries are parameterized and owner-scoped. Scheduled skills are constrained to the closed `home_task_read` / `home_workspace_read` capability set and are rechecked at dispatch and completion. The scheduler fence is internal and not accepted from HTTP input. No Critical, High, or Medium security finding remains open.

### performance

PASS with one accepted Low finding, already recorded in the release Tech Debt Log: `IDX_automation_occurrences_claim` omits `interrupted_unknown` even though `claimBatch` includes expired unknown occurrences for reconciliation. The bounded worker loop remains correct; a growing unresolved-unknown history could make that branch scan more rows. Extend the index and inspect its query plan if that history grows. No broad load matrix was run because the concrete risk is limited to this index and the current worker processes at most 8 items per pass.

### usability and accessibility

Not applicable. Task 7.1 changes backend APIs and worker lifecycle only.

## Evidence Index

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| Release architecture, section 9.1 | N/A — repository documentation | Scheduling requirements, lease/restart behavior, API/worker separation | `.codex/docs/hackathon-release/architecture.md`, §9.1 |
| Task 7.1 contract and architecture preflight | N/A — repository documentation | API contract, ownership, fencing, cancellation, cleanup, and lifecycle invariants | `task-7-1-durable-scheduler/contract.md`; `architecture-preflight.md` |
| Task 7.1 source map and exact source manifest | N/A — repository documentation | 46 source/test paths, 2 runtime/documentation paths, Task 6.3 shared-file boundary, and scheduler composition wiring | `task-7-1-durable-scheduler/source-map.md`; `exact-source-manifest.txt` |
| Developer summary and worker lifecycle receipt | Local Jest/TypeScript CLI | Focused unit suites, API/worker startup selection, graceful drain, startup cleanup, typecheck, build, and alias replacement | `task-7-1-durable-scheduler/dev-summary.md`; `artifacts/worker-lifecycle.md` |
| Guarded scheduler and cleanup verification receipts | Local Jest, PostgreSQL fixture, and child Node process; no MCP needed | Scheduler 4/4, two-repository-connection claim race, fresh-child restart reconciliation, filtered cleanup 1 pass / 3 expected skips, fresh database guards, and settled-credit preservation | `task-7-1-durable-scheduler/artifacts/verification-receipt.md`; `task-7-1-durable-scheduler/verification-receipt.md` |
| Independent focused Jest check | Local Node/Jest CLI | DST and worker reconciliation unit behavior; 2 suites / 8 tests passed | Command and result recorded in this report's Test Evidence Reviewed section |
| Security and performance source review | N/A — source review; no browser runtime required | Authentication/CSRF, ownership, closed read capability set, lease and output fences, bounded claims, and accepted Low index debt | Automation router, use cases, worker, migration 0038, Home fences, expiry cleanup, and project-removal repository under `Personal-AI-Workspace/backend/src/` |
| Task tracker Tech Debt Log | N/A — repository documentation | Accepted Low interrupted-unknown claim-index debt | `.codex/docs/hackathon-release/tasks.md`, Tech Debt Log |

Playwright MCP and Chrome DevTools MCP were marked N/A in `tasks.md`. Context7 was unavailable during preflight; no external timezone dependency was introduced, and native `Intl` behavior is covered by DST unit tests.

## Definition of Done Checklist

- [x] Coding standards reviewed in the changed scheduler and fence paths; no `any`, TODO, console logging, or debugger statements found in the reviewed core files. The cohesive TypeORM scheduler repository is 514 lines, above the skill's advisory 300-line guideline; this structural split is deferred under the user's priority for working completion.
- [x] Backend TypeScript typecheck passed; production build and alias replacement passed and emitted the standalone worker entrypoint.
- [x] Implementation follows architecture section 9.1 and preserves Clean Architecture boundaries.
- [x] New API routes are documented in OpenAPI; root README documents the separate worker commands and process environment.
- [x] Migration 0038 is additive and its rollback refuses to drop persisted schedule/occurrence data.
- [x] Non-trivial scheduling and worker logic has focused Jest coverage; applicable PostgreSQL integration evidence passed.
- [x] The 3 unrelated cases skipped by the focused cleanup filter are identified and justified in the verification receipt.
- [x] Developer self-review and required test review are recorded in `dev-summary.md`.
- [x] Task MCP requirements are satisfied: browser MCPs are N/A, Context7 unavailability and the native `Intl` replacement are documented, and evidence is indexed here.
- [x] Backend API validation, authentication, status/error mapping, and owner scoping are reviewed.
- [x] Tester security review passed; the accepted Low performance finding is logged in the task tracker.
- [x] Frontend unit, E2E, visual, and accessibility DoD checks evaluated as not applicable; no UI changed.
- [x] Tester final verdict: **PASS**.

## Verdict: PASS

## Failure Details (if FAIL)

None. The one accepted Low performance finding is documented in the Tech Debt Log and does not affect functional acceptance, security, quota behavior, or cleanup safety.
