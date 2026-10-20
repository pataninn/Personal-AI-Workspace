# QA Report: Task 7.2 — Produce and persist useful daily briefings

## Change History

- 2026-10-20: Official independent QA cycle 1. Refreshed source and validation review; the two pre-review findings are resolved in the reviewed implementation.

## Test Evidence Reviewed

- [x] Backend TypeScript typecheck — passed with `tsc -p tsconfig.json --noEmit --pretty false`.
- [x] Backend Jest — 8 focused suites, 57 tests passed.
- [x] Backend PostgreSQL integration — the three task-scoped cases passed individually with isolated-target preguards and fresh-process clean postguards. This was a focused set, not the full integration matrix.
- [x] Hermes bridge Python tests — 61 run, 58 passed, and 3 existing Linux-only enforcement tests skipped with the platform reason recorded.
- [x] Actual runner receipt path — deterministic local HTTPX transport observed reserve → local send → settle; no provider network call.
- [x] Frontend unit tests and Playwright E2E — not applicable; Task 7.2 changes no frontend files or user-facing screens.

These are developer-authored results reviewed against the code and test cases. I did not rerun tests, builds, PostgreSQL, browser, runtime, or provider calls in this QA cycle.

## Functional Acceptance Review

- [x] API behavior verified: the authenticated, paginated occurrence history adds task-source and ledger-usage fields without adding a route or request fields; OpenAPI coverage is included.
- [x] Business rules and edge cases verified: exact task revisions are recorded under the active occurrence fence before returning task data; the single effective output cap is used by admission and each outbound request; unknown receipts remain conservatively reserved.
- [x] Error cases verified: missing or oversized output limits, async sends, missing usage, and uncertain transport/stream outcomes fail closed; old bridges without receipt capability cannot create a planning run.
- [x] Persistence verified: migration 0039 is additive and its down migration refuses rollback while source references exist; focused PostgreSQL cases cover source capture/reclaim, exact owner/workspace/version projection, and owner/turn ledger usage with interruption retention.
- [x] Contract alignment verified: task-source snapshots contain IDs and revisions rather than copied task content; provider history comes from persisted Home-turn ledger rows; retries do not redispatch a possibly sent turn.

## Review Lenses Applied

- [x] Security review — owner, workspace, turn, capability, and lease checks reviewed.
- [x] Performance review — history/source/output bounds reviewed; no blocking performance concern found in this bounded backend change.
- [x] Usability and accessibility — not applicable; no UI changed.

## Findings Summary

### functional acceptance

PASS. The prior output-cap defect is fixed: the composition root derives one effective cap bounded by the supported runner maximum, passes it to both Credits admission and the planning runtime, and the runner sets Hermes `max_tokens` from it. The patched synchronous HTTPX boundary requires an explicit positive output limit within that cap before calling the original sender. This covers the pinned Hermes chat-completions client, including its auxiliary summary path; asynchronous sends fail closed. Reserve occurs before egress; actual usage settles before a non-stream response is returned or after stream consumption. Missing or uncertain usage marks the reservation unknown and blocks further calls.

The prior interrupted-receipt defect is fixed: `clearRuntime` marks all matching owner/`home_turn`/`turnId` reservations that remain `in_flight` as `unknown` before clearing process-local receipt state. The database transition does not release reserved units. A restarted or subsequently read unknown turn stays terminal/reconciled and is not started again. The guarded PostgreSQL case verifies an interrupted reservation becomes unknown while allowance remains held.

Historical task-source reads are filtered by authenticated owner, schedule workspace, task ID, and exact task version. Historical provider-usage reads filter both reservation and usage rows by authenticated owner and `source_kind/source_id = home_turn/{homeTurnId}`; they use recorded provider/model/usage, not current settings. No cross-owner projection or functional blocker was found.

The local transport test and pinned Hermes source establish the intercepted code path only. They do not establish live Nebius/Nemotron inference or deployed accounting; Task 8.2 owns that evidence.

### security

PASS. The route derives owner identity from the authenticated session. History SQL is parameterized and owner-scoped; task titles and links are projected only for the same owner, scheduled workspace, and exact current revision. Provider receipts are internal bridge events bound to the active Home turn, and unsupported bridge capability fails closed. No security blocker found.

### performance

PASS for this task's bounds. Occurrence pages are capped at 100, source references at 256 per occurrence, and provider attempts at 32 per Home turn. No UI or unbounded payload was introduced. No live performance trace was required by the task.

### usability and accessibility

Not applicable; no user-facing screen changed.

## Evidence Index

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| Task 7.2 task entry | N/A | Acceptance criteria, required evidence, scope | `.codex/docs/hackathon-release/tasks.md` — Task 7.2 |
| Task contract | N/A | Receipt, cap, unknown, history, source, and error semantics | `.codex/docs/hackathon-release/task-7-2-briefing-workflow/contract.md` |
| Architecture preflight and architecture | N/A | Layer ownership, credits and briefing boundaries | `.codex/docs/hackathon-release/task-7-2-briefing-workflow/architecture-preflight.md`; `.codex/docs/hackathon-release/architecture.md` sections 7.1 and 9.2 |
| Developer validation receipt | N/A | Typecheck, Jest, Python, guarded PostgreSQL, local transport | `.codex/docs/hackathon-release/task-7-2-briefing-workflow/artifacts/validation.md` |
| Source manifest | N/A | Changed-file ownership and shared hunks | `.codex/docs/hackathon-release/task-7-2-briefing-workflow/artifacts/source-manifest.md` |
| Developer summary | N/A | Implementation, self-review, test result summary | `.codex/docs/hackathon-release/task-7-2-briefing-workflow/dev-summary.md` |
| Prior source pre-review | N/A | Earlier findings and pinned-source reference; superseded by this official review | `.codex/docs/hackathon-release/task-7-2-briefing-workflow/pre-review.md` |
| Runner and per-send boundary | Local source/tests | Shared output cap, pre-send admission, settlement/unknown handling, capability handshake | `Personal-AI-Workspace/deploy/hermes-bridge/runtime/planning_acp_runner.py`; `runtime/provider_credit.py`; `planning_lifecycle.py`; `server.py`; `tests/test_provider_credit.py` |
| Home receipt and usage projection | Local source/tests | Interrupted reservation retention and owner/turn status projection | `Personal-AI-Workspace/backend/src/modules/home-assistant/use-cases/get-home-turn.ts`; `backend/src/modules/credits/use-cases/handle-home-provider-credit-receipt.ts`; `backend/src/modules/credits/use-cases/get-home-turn-provider-usage.ts` |
| Ledger and occurrence history | Local source/tests | Owner/source filters, exact workspace/version projection, migration and API contract | `Personal-AI-Workspace/backend/src/infrastructure/database/repositories/typeorm-credit-ledger-repository.ts`; `typeorm-automation-repository.ts`; `backend/src/infrastructure/database/migrations/1710000039000-add-automation-task-sources.ts`; `backend/src/modules/automations/controllers/automation-router.ts` |
| Hermes helper at pinned release commit | Official upstream source | Synchronous OpenAI client path used by the runner, including streaming usage | [chat_completion_helpers.py at commit 5fc308a](https://github.com/NousResearch/hermes-agent/blob/5fc308a70719a83cccdbba4c0e39c23f5a8239d5/agent/chat_completion_helpers.py) |

Task 7.2 declares Playwright MCP, Chrome DevTools MCP, and Context7 as N/A. No browser/runtime evidence or live provider call was required or claimed.

## Definition of Done Checklist

- [x] Backend TypeScript typecheck passed for the touched package.
- [x] Non-trivial backend and bridge logic has focused tests; all reported task tests pass.
- [x] PostgreSQL persistence/ownership cases pass with safe isolated-database guards.
- [x] Three skipped bridge tests are explicitly justified as existing Linux-only enforcement tests.
- [x] Developer self-review and required test review are recorded as PASS in `dev-summary.md`.
- [x] Implementation follows the existing Automations, Home, Credits, Hermes bridge, and TypeORM ownership boundaries.
- [x] OpenAPI coverage is updated and tested; migration 0039 includes a guarded down path.
- [x] Required MCP evidence is N/A for this backend-only task; no browser or live-provider claim is made.
- [x] Tester security and performance reviews completed; UI review is not applicable.
- [x] Task 7.2 contract and task-specific acceptance criteria are satisfied.

## Verdict: PASS
