# QA Report: Atomic Credit Reservations and Runtime Metering

## Change History

- 2026-10-19: Independent functional, security, performance, migration, and documentation review completed. Final verdict recorded after the README and six-field configuration contract were aligned.

## Test Evidence Reviewed

- [x] Developer backend unit tests - Jest: 129 suites / 770 tests passed; focused credit/runtime tests 9 suites / 81 tests passed. The broad totals include the uncommitted Task 3.2 storage foundation present in the shared worktree.
- [x] Developer backend integration tests - Jest/PostgreSQL: full guarded isolated run 24 suites / 98 tests passed through migrations 0028 and 0029; focused credit suite 1 / 7 and populated migration fixture 1 / 3 passed. These broad totals also ran with Task 3.2's migration registered.
- [x] Independent backend integration tests - Jest/PostgreSQL: credit and R1 migration fixtures 2 suites / 10 tests passed.
- [x] Independent direct/Hermes fail-closed tests - Jest: 4 suites / 43 tests passed.
- [x] Backend TypeScript typecheck passed. The final README/contract changes were documentation-only; developer recorded a final `git diff --check` after those edits.
- [x] Frontend unit tests - N/A; Task 3.1 has no frontend changes.
- [x] Frontend E2E - N/A; Task 3.1 has no browser-facing behavior.

## Functional Acceptance Review

- [x] API behavior verified: no public endpoint or DTO was added or changed. The supported direct-provider path reserves before POST; production composition stays closed without verified price/bound configuration.
- [x] Business rules and edge cases verified: integer rounding, null/zero limits, account and deployment-wide demo races, daily-window/timezone behavior, attempt idempotency, settlement/release/unknown outcomes, over-bound usage, and overflow fail-closed handling have unit and PostgreSQL coverage.
- [x] Error cases verified: pause, unconfigured demo, inactive account, duplicate/over-budget calls, malformed totals, missing or uncertain usage, over-bound reports, and unrepresentable charges are handled without silently releasing the maximum reservation.
- [x] Migration and persistence verified: migration 0028 is additive and its rollback guards changed policy/configuration and durable ledger state. Independent PostgreSQL checks exercised the credit migration and the populated R1 ownership/session/data regression.
- [x] Contract alignment verified: the contract, config parser, and README list the same six NIM credit fields and 1-32 attempt cap. README documents the seeded global pause, fail-closed prerequisites, and that configuring a provider route does not enable paid sends.

## Review Lenses Applied

- [x] Security review: ownership and account state are resolved from persisted sources; admission is durable before direct provider transmission; missing bounders, incomplete configuration, paused policy, and unsupported bridge egress fail closed. Unknown post-send usage retains the maximum.
- [x] Performance review: admission and settlement use short transactions and deterministic row-lock order; no ledger lock spans provider or bridge I/O. The singleton policy lock serializes ledger mutations across accounts. This is an intentional consistency tradeoff for the current local/hackathon scope; no throughput benchmark or production scale claim is made.
- [x] Usability and accessibility review - N/A; no user-facing UI changed.

## Findings Summary

### functional acceptance

No open acceptance findings. Source and persisted behavior match the contract, including timezone snapshots, concurrent demo caps, unknown-charge retention, bigint overflow pausing, and migration rollback protections.

### security

No Critical or High findings remain. Paid inference is not represented as enabled: direct sends remain blocked without a verified model-specific input bounder, and Hermes project/Home paths return unavailable before bridge creation until every actual egress attempt can be admitted and metered. No live provider call, provider price, or deployment security proof is claimed.

### performance

No blocking performance finding. The global policy row intentionally serializes ledger decisions; transactions remain outside inference and bridge work. Production throughput is not measured.

### usability and accessibility

Not applicable to this backend-only task.

## Evidence Index

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| Task contract | Local document review | Scope, six-field configuration, units, limits, pause, settlement and fail-closed behavior | `contract.md` |
| Developer handoff | Local document review | Implementation summary, explicit paid-runtime limitations, Ready-for-QA declaration | `dev-summary.md` |
| Developer test record | Jest CLI / developer record | 129/770 backend unit tests, 24/98 isolated PostgreSQL tests, focused suites, typecheck, final diff check | `artifacts/developer-focused-checks.txt` |
| Independent focused runtime tests | Jest CLI | Direct provider and Hermes project/Home fail-closed behavior: 4 suites / 43 tests | `artifacts/qa-early-review.md` |
| Independent PostgreSQL rerun | Guarded PostgreSQL integration runner | Credit race/settlement/overflow cases and populated migration regression: 2 suites / 10 tests; URL and credentials omitted | `artifacts/qa-postgres-focused-rerun.txt` |
| Credit ledger integration test | Source and PostgreSQL test | Concurrent account/demo caps, settlement, timezone, pause, over-bound and overflow cases | `Personal-AI-Workspace/backend/test/integration/credit-ledger.integration.spec.ts` |
| Migration regression | Source and PostgreSQL test | Existing owner/session/legacy data assertions with additive migration rollback | `Personal-AI-Workspace/backend/test/integration/r1-populated-migration.integration.spec.ts` |
| Direct provider / runtime gates | Source review and Jest CLI | Admission before POST and closed production wiring without a verified bounder | `Personal-AI-Workspace/backend/src/infrastructure/ai-provider/nvidia-hosted-nim-provider.ts`; `Personal-AI-Workspace/backend/src/composition-root.ts` |
| Hermes runtime gates | Source review and Jest CLI | Project and Home paths fail before bridge creation while admission enforcement is disabled | `Personal-AI-Workspace/backend/src/infrastructure/hermes/hermes-agent-runtime.ts`; `Personal-AI-Workspace/backend/src/infrastructure/hermes/hermes-home-planning-runtime.ts` |
| Overflow settlement | Source review and PostgreSQL test | Unknown reservation, maximum retained, pause committed, no invalid bigint usage entry | `Personal-AI-Workspace/backend/src/infrastructure/database/repositories/typeorm-credit-ledger-repository.ts`; credit integration test above |
| Operator setup note | Local document review | All six settings, global pause, runtime prerequisites, and route setup not enabling paid sends | `Personal-AI-Workspace/README.md` |
| Runtime hook feasibility | Local pinned-source research | Why Hermes remains closed until actual egress attempts are enforceable | `artifacts/runtime-hook-feasibility.md` |
| Developer self-review and source manifest | Local document review | Review resolutions and Task 3.1/Task 3.2 shared-file boundary | `artifacts/developer-self-review.md`; `artifacts/developer-source-manifest.txt` |
| Task-owned source scan | Local read-only search | No TODO, console.log, debugger, or explicit `any` matches in reviewed credit/provider/runtime source paths | `Personal-AI-Workspace/backend/src/modules/credits/`; provider, runtime, config, migration, repository, and composition paths listed above |
| Required MCP evidence | N/A per `tasks.md` | Playwright MCP, Chrome DevTools MCP, and Context7 are explicitly N/A for Task 3.1; no browser or external framework claim is made | Task 3.1 MCP declaration in `.codex/docs/hackathon-release/tasks.md` |

The PostgreSQL fixture was an isolated guarded loopback test database. Its temporary URL was read only in-process and never included in artifacts. No application database, provider, or external service was contacted.

Task 3.1 owns migration 0028 only. Migration 0029 and its shared `data-source.ts` registration remain Task 3.2 work and must be excluded from the Task 3.1 commit. The focused R1 migration fixture locates the ownership-boundary migration and rolls back later additive migrations without naming 0029; the full integration result above reflects the current shared chain, not an isolated Task 3.1 commit checkout.

## Definition of Done Checklist

- [x] Code follows the backend layering in architecture sections 7.1 and 10; the reviewed task-owned source paths have no explicit `any`, TODO, console log, or debugger matches. Ledger transactions do not span provider or bridge work.
- [x] Backend TypeScript typecheck passed. Developer self-review/test review and independent source review found no open code-quality or dependency-boundary issue.
- [x] No new public endpoint or DTO was introduced, so endpoint status-code/OpenAPI additions are not applicable. Internal configuration and admission inputs are validated; no secret is added to code.
- [x] Additive reversible migration and rollback guards are included and tested.
- [x] Non-trivial domain logic has focused unit coverage; full backend Jest suite passed.
- [x] Required isolated PostgreSQL integration coverage passed, including independent tester rerun.
- [x] README was updated for setup/configuration and runtime status.
- [x] No skipped-test issue was reported in the relevant test evidence.
- [x] Security and performance reviews completed; frontend, E2E, usability/accessibility, and MCP browser evidence are N/A as declared for this backend-only task.
- [x] Evidence Index includes required artifacts and explicitly justifies N/A MCP inputs.
- [x] Task 3.2 migration 0029 source and its `data-source.ts` registration are explicitly outside Task 3.1's staged ownership; six unrelated baseline AI-run/ponytail changes remain excluded and untouched.

## Verdict: PASS

This PASS covers Task 3.1's offline credit-ledger and fail-closed runtime capability. It does not claim paid inference is currently available, that provider prices/bounds are production-verified, or that the whole release/deployment is accepted.
