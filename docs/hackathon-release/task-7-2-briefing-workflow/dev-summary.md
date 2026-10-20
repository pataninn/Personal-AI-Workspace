# Dev Summary: Task 7.2 — Produce and persist useful daily briefings

## Change History

- 2026-10-20: Implementation and focused validation completed. Contract and evidence were refreshed after addressing the output-cap and interrupted-reservation pre-review findings.

## What Was Implemented

Implemented the bounded task-source snapshot on each occurrence, exact owner/workspace/version occurrence history, and owner-scoped provider-usage projection over the existing Credits ledger. Home task reads persist exact source revisions under the occurrence fence before returning them to the runtime. Home provider sends use the existing admission and settlement path, with the same effective output cap at admission and the HTTP send boundary. Interrupted Home turns retain in-flight reservations as unknown without releasing reserved units or redispatching the turn.

## Files Changed

### Backend

- `backend/src/infrastructure/database/migrations/1710000039000-add-automation-task-sources.ts`
- `backend/src/infrastructure/database/repositories/typeorm-automation-repository.ts`
- `backend/src/infrastructure/database/repositories/typeorm-credit-ledger-repository.ts`
- `backend/src/infrastructure/hermes/hermes-home-planning-runtime.ts`
- `backend/src/infrastructure/hermes/hermes-home-planning-runtime.spec.ts`
- `backend/src/modules/automations/controllers/automation-router.ts`
- `backend/src/modules/automations/controllers/automation-router.spec.ts`
- `backend/src/modules/automations/domain/automation-types.ts`
- `backend/src/modules/automations/repositories/automation-repository.ts`
- `backend/src/modules/automations/use-cases/automation-use-cases.ts`
- `backend/src/modules/automations/use-cases/list-automation-occurrences.spec.ts`
- `backend/src/modules/credits/repositories/credit-ledger-repository.ts`
- `backend/src/modules/credits/repositories/provider-call-usage-history.ts`
- `backend/src/modules/credits/use-cases/get-home-turn-provider-usage.ts`
- `backend/src/modules/credits/use-cases/get-home-turn-provider-usage.spec.ts`
- `backend/src/modules/credits/use-cases/handle-home-provider-credit-receipt.ts`
- `backend/src/modules/credits/use-cases/provider-call-credit-admission.spec.ts` (updates the existing ledger mock for the new Home usage and unknown-retention methods)
- `backend/src/modules/home-assistant/repositories/home-automation-source-recorder.ts`
- `backend/src/modules/home-assistant/repositories/home-provider-credit-receipt-handler.ts`
- `backend/src/modules/home-assistant/repositories/home-planning-runtime.ts`
- `backend/src/modules/home-assistant/repositories/home-planning-tool-request-handler.ts`
- `backend/src/modules/home-assistant/use-cases/get-home-turn.ts`
- `backend/src/modules/home-assistant/use-cases/get-home-turn.spec.ts`
- `backend/src/modules/home-assistant/use-cases/home-planning-tool-request-handler.ts`
- `backend/src/modules/home-assistant/use-cases/home-planning-tool-request-handler.spec.ts`
- `backend/src/openapi/automations-openapi.spec.ts`
- `backend/test/integration/automation-scheduler.integration.spec.ts`
- `backend/test/integration/credit-ledger.integration.spec.ts`

### Hermes bridge

- `deploy/hermes-bridge/acp.py`
- `deploy/hermes-bridge/planning_lifecycle.py`
- `deploy/hermes-bridge/runtime/planning_acp_runner.py`
- `deploy/hermes-bridge/runtime/provider_credit.py`
- `deploy/hermes-bridge/server.py`
- `deploy/hermes-bridge/tests/test_planning_runtime.py`
- `deploy/hermes-bridge/tests/test_provider_credit.py`

### Shared localized hunks

- `backend/src/composition-root.ts`: Home runtime, receipt, source recorder, effective cap, and usage-history wiring. Task 6.4's export provider/startup-cleanup hunks remain sibling-owned.
- `backend/src/infrastructure/database/data-source.ts`: Task 7.2 migration `0039` registration; sibling-owned Task 6.4 migration `0040` follows it.
- `backend/openapi.json`: Task 7.2 occurrence fields; Task 6.4 export schema/routes remain sibling-owned.

### Docs

- `.codex/docs/hackathon-release/task-7-2-briefing-workflow/contract.md`
- `.codex/docs/hackathon-release/task-7-2-briefing-workflow/dev-summary.md`
- `.codex/docs/hackathon-release/task-7-2-briefing-workflow/artifacts/validation.md`
- `.codex/docs/hackathon-release/task-7-2-briefing-workflow/artifacts/source-manifest.md`

See [source-manifest.md](artifacts/source-manifest.md) for file responsibilities and the exact shared hunk ownership. No Task 7.2 frontend files changed.

No new endpoint was added. `GET /api/v1/automations/schedules/:scheduleId/occurrences` now returns the additive `taskSources` and `providerUsage` fields.

## Contract Notes

The occurrence stores at most 256 exact task `{id, revision}` pairs; `skill_invocations.context_revisions` remains immutable. Existing `/api/v1/automations/...` response shapes are extended without adding routes. Usage reads use existing `home_turn` provider-call ledger rows, and the daily briefing result remains in its existing Home assistant message.

## Architecture Alignment Notes

The implementation reuses the existing schedule, skill invocation, Home turn, task-read, Credits admission/settlement, and cleanup owners. The only schema change is additive occurrence metadata in migration `0039`; `context_revisions` remains unchanged. No duplicate narrative store, credit ledger, scheduler, or provider path was introduced. Migration `0040` remains Task 6.4-owned.

## Evidence Collected

- Backend typecheck, 8 focused Jest suites / 57 tests, 61 bridge unit tests (58 passed; 3 baseline Linux-only skips), and all three exact guarded PostgreSQL cases passed. Exact filters, skips, guard conditions, earlier failed attempts, and their successful postguards are recorded in [validation.md](artifacts/validation.md).
- Deterministic runner proof used the actual configured Hermes runner hook with a local HTTPX transport and observed reserve, local send, and settle ordering. It did not contact a provider. The output-cap regression rejects a 512-token request under a configured cap of 64 before egress.
- Pinned-source evidence reviewed Hermes 0.20.6 commit `5fc308a70719a83cccdbba4c0e39c23f5a8239d5` at `agent/chat_completion_helpers.py`; see the tester-owned [pre-review](pre-review.md) for the direct source link. This supports the current synchronous Chat Completions and streaming-usage path only; it is not live provider/deployment evidence.
- Evidence is stored in `.codex/docs/hackathon-release/task-7-2-briefing-workflow/artifacts/`.

## MCP Notes

No MCP evidence was required or collected. This is a backend and local bridge change; there are no user-facing screens in Task 7.2.

## Code Review Findings (and resolutions)

Self-review checked the lease and owner fences, clean architecture boundaries, DTO serialization, migration ordering, per-send credit admission/settlement, output-cap equality, unknown reservation retention, and supported sync bridge path. The pre-review's high-severity cap mismatch was resolved by deriving the runner and reservation cap from one effective value and enforcing every explicit HTTP output cap before egress. The interrupted-turn pending trap was resolved by atomically retaining all matching in-flight reservations as unknown before clearing process-local state. The PostgreSQL test also exposed and fixed TypeORM's `[rows, rowCount]` `UPDATE ... RETURNING` wrapper count. No blocking self-review findings remain.

## Test Coverage Summary

TypeScript: backend `tsc -p tsconfig.json --noEmit --pretty false` passed. Backend Jest: 8 suites / 57 tests passed. Python unittest: 61 total, 58 passed and 3 pre-existing Linux-only enforcement skips. Guarded PostgreSQL: each of the 3 approved named tests passed individually on its existing isolated target with strict base identity/target absence preguards, normal harness teardown, and separate-process clean postguards. This is not the full backend integration matrix. Details and every failed attempt are in [validation.md](artifacts/validation.md).

## Known Limitations / Tech Debt

- Unknown provider outcomes intentionally retain reserved allowance and remain unknown; this prevents unaccounted automatic retries but can leave allowance held until the existing ledger is reconciled.
- Three Python enforcement tests require Linux x86_64 kernel features and were skipped in this Windows environment. They are baseline platform checks, not new 7.2 admission coverage.
- Live Nebius/Nemotron provider and deployment evidence belongs to Task 8.2. No browser evidence applies; the 7.3 interface remains separate.

## Ready for QA: YES

Implementation matches the current contract and focused required checks pass. Ready for independent QA; live provider proof remains out of scope for this task.
