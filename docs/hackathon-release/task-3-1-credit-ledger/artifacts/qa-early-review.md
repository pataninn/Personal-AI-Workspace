# Task 3.1 early QA source-risk review

Date: 2026-10-19. Read-only review of the current implementation draft; no tests, PostgreSQL, provider calls, builds, or app-file edits were performed. This is not a verdict.

## Current strengths

- `credit-calculation.ts` uses `bigint`, separately rounds input/output upward, rejects invalid positive rates/counts, and caps computed totals at PostgreSQL bigint.
- `typeorm-credit-ledger-repository.ts` keeps reserve/settle/release in short `QueryRunner` transactions, uses database time, locks policy -> user -> account limits -> counters/windows -> reservation/run-budget rows, and does not hold DB locks across provider I/O.
- Unknown post-send results retain the reservation; known-not-sent release is limited to `in_flight`; settlement replay is status-checked and reservation/usage keys are unique.
- Direct provider draft has an optional credit configuration/bounder/admission and returns before fetch when any is absent; its fake-provider spec includes reserve-before-fetch and missing/denied setup cases. No production config is currently wired, so direct paid inference remains unavailable.

## Open source/evidence gaps to close before handoff

1. **Hermes pre-create gate is not yet visible in this snapshot.** `HermesAgentRuntime.startRun` and `HermesHomePlanningRuntime.startAccepted` can call bridge `create` / `planning-create`, and `composition-root.ts` wires those runtimes without an admission/disabled-policy check. Contract and runtime preflight require both to fail closed before bridge creation until every paid send/retry is admitted at a complete egress boundary. Add focused assertions that zero bridge create calls occur while this gate is closed.
2. **Over-bound settlement needs a real persistence assertion.** `settleProviderCall` marks an over-bound reservation, charges reported usage, and pauses policy, but current PG integration tests do not exercise that path. Add a PostgreSQL test proving the charged amount/status and that subsequent reservation is denied by the paused policy.
3. **Demo campaign concurrency is not yet proven.** The PG suite's concurrent overspend case covers regular daily/lifetime limits; demo daily/campaign limits are currently tested sequentially. Add simultaneous reservations at the global campaign limit and assert no overspend.
4. **Timezone database transitions need integration coverage.** Domain tests cover DST arithmetic and the old-zone boundary, but no current PG test exercises queued timezone application, persisted old/new windows, or settlement of a reservation into the window captured before the change.
5. **Rollback guard omits mutable operator policy.** `1710000028000-create-credit-ledger.ts` down checks usage/reservations/counters and some `account_limits` fields, but does not reject a changed `credit_runtime_policy` row or `max_concurrent_inference_calls`. It can drop an unpaused/campaign configuration with no usage. Guard against changed policy/account settings or explain the deliberate rollback loss; add a test for the chosen behavior.

## Evidence plan

- Unit/fake provider: missing price/bound/admission and denied reservation produce zero fetches; successful admission precedes exactly one fetch; reported usage settles once; partial usage, timeout, cancellation, and transport uncertainty retain the maximum.
- Runtime gates: direct mode remains unavailable without a verified bounder and price configuration; Hermes project and Home planning return the existing safe unavailable result before bridge create; assert the bridge/fetch is untouched.
- PostgreSQL: concurrent account daily/lifetime and demo daily/campaign admission, reservation/settlement/release idempotency, unknown retention, zero/null semantics, over-bound pause, timezone transition/snapshot, fresh migration, and rollback refusal after durable/configured state.

The runtime-preflight decision does not require a live provider run for offline ledger capability. It does prohibit claiming paid-runtime readiness until direct bounds/prices are verified and Hermes/Home all-egress admission is enforceable. See `../contract.md`, `../../runtime-metering-preflight.md`, and architecture §7.1/§10.

## Follow-up review of the implementation draft

This section supersedes the earlier “open source/evidence gaps” where marked resolved. Final QA remains pending broad regression and the post-change isolated PostgreSQL run.

- **Resolved: runtime fail-closed gates.** Production composition does not pass a verified input token bounder to the direct provider and configures both Hermes runtimes with `providerEgressAdmissionEnforced: false`. `UnsupportedOpenShellAgentRuntime` is selected for OpenShell. The independent focused Jest rerun passed 4 suites / 43 tests covering NVIDIA direct-provider, direct runtime, Hermes project, and Hermes Home behavior. No production provider request was made.
- **Resolved: database evidence for timezones and ordinary over-bound usage.** The current isolated PostgreSQL suite contains tests for applying the queued timezone at its old-zone boundary and settling into the captured window, plus persisted over-bound charge/status/global pause and denial of the next reservation. Developer reported the pre-campaign-race suite passed 1 suite / 6 tests; tester did not use PostgreSQL because the storage agent owned the fixture window.
- **Partially resolved: demo campaign concurrency.** Main added a two-way `Promise.allSettled` race against the demo campaign limit and asserts one admission, one `limit_exceeded`, and the resulting reserved counter. This newly added assertion has not yet been independently or developer-run against PostgreSQL in this review snapshot.
- **Resolved in source/unit coverage: migration rollback policy guard.** Migration down now refuses changed credit policy and account concurrency settings, with focused rollback specs.
- **New open issue sent to developer and project manager:** A validated provider usage report can be individually safe-integer token counts yet calculate to a cost greater than PostgreSQL `bigint`. `settleProviderCall` currently calls `maximumCreditUnits` before its transaction; overflow throws before marking the reservation `over_bound` or pausing policy. The caller retains only the reservation as unknown, while future admissions may proceed if account limits are null. Require a documented representable-range policy or an atomic pause/reconciliation path and a focused test.

Independent command and result:

```text
pnpm.cmd --dir Personal-AI-Workspace/backend test -- src/infrastructure/ai-provider/nvidia-hosted-nim-provider.spec.ts src/infrastructure/ai-provider/direct-provider-agent-runtime.spec.ts src/infrastructure/hermes/hermes-agent-runtime.spec.ts src/infrastructure/hermes/hermes-home-planning-runtime.spec.ts
4 suites passed, 43 tests passed, 0 snapshots; 4.186 seconds.
```

No app files were edited. No PostgreSQL, build, provider, or browser action was performed by the tester in this follow-up. This is not a final verdict.

## Final validation update

The final developer handoff and independent guarded rerun resolve the remaining items noted above. The updated credit PostgreSQL suite includes both independent-account demo daily/campaign races and the unrepresentable-charge pause path; tester reran it successfully together with the R1 populated-migration regression (2 suites / 10 tests). See `qa-postgres-focused-rerun.txt` and the final `../qa-report.md` for evidence and verdict. The earlier open-issue wording above is historical to the draft; it is no longer an open finding.
