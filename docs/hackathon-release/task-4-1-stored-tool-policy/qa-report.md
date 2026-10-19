# QA Report: Replace per-turn consent with workspace-scoped automatic execution

## Change History

- 2026-10-19: First independent QA cycle found two Medium gaps: retired mutation routes still advertised success, and active Home/workspace chat lacked required provider/data disclosure. Verdict: FAIL.
- 2026-10-19: Second independent QA cycle verified both repairs, but reproduced the cancellation-status E2E ratio failure at 0.9888888597488403 versus the required 1.0. Verdict: FAIL.
- 2026-10-19: Final independent closeout reviewed the centered recovery-helper change, confirmed app/export source identity, and reviewed the latest preview and keyboard evidence. The recovery case and full recovery spec pass; the six-spec Home/workspace set remains 17/18 due to one initial-frame disabled-Send viewport assertion. The user accepted this Low visual/test debt to prioritize a complete working project. Final verdict: PASS with the debt explicitly retained and documented.

## Test Evidence Reviewed

- [x] Developer frontend unit tests — Vitest: 58 files / 298 tests, zero skips; passed and independently reviewed in the second cycle.
- [x] Developer backend unit tests — Jest: 151 suites / 902 tests; passed and independently reviewed in the first cycle.
- [x] Developer backend integration tests — guarded PostgreSQL: 34 suites / 119 tests; passed in developer evidence. Independent focused guarded set: 3 suites / 6 tests, passed with isolated targets absent afterward.
- [x] TypeScript: backend, frontend, and frontend-node checks passed; changed-scope frontend checks were independently completed.
- [x] Python bridge: isolated Linux suite 48/48 passed with zero skips; Windows evidence was 45 passed / 3 Linux-only skips.
- [x] Preview API Node tests: 26/26 passed in developer evidence.
- [x] Final recovery E2E: exact cancellation case 1/1 and full `run-recovery.preview.spec.ts` 2/2 passed after the test-helper correction.
- [x] Required six-spec Home/workspace preview set reviewed: 17/18. The remaining failure is the unchanged initial-viewport check in `provider-permissions.preview.spec.ts:19`; it is documented as accepted Low debt, not a green test.
- [x] Playwright MCP and Chrome DevTools MCP were unavailable. Local Playwright/Chrome evidence is identified as a substitute in the artifacts; no MCP results are claimed.

## Functional Acceptance Review

- [x] API behavior verified: eight retired decision/mutation writes document only `409 POLICY_ACTION_RETIRED` with the existing error schema and no-effect behavior. Read/history/status and separate cancellation routes remain available.
- [x] Business rules and edge cases verified: owner-derived policy, revision and scope checks, Home/workspace intersection, selected context, automatic run/command handling, cancellation, uncertain outcomes, and safe retry.
- [x] Error cases verified: unavailable policy/runtime is fail-closed; retired actions do not mutate state; uncertain and cancellation states require the documented recovery path.
- [x] Migration and persistence verified: backfill, trusted provisioning, revocation, transaction ordering, and rollback guards covered by PostgreSQL evidence.
- [x] `contract.md` alignment verified for policy reads, automatic-path transitions, retired writes, failure behavior, and recovery.
- [x] `ui-spec.md` alignment verified for active Home/workspace disclosure, provider/runtime-unavailable copy, no approval control, and keyboard/recovery behavior.

## Review Lenses Applied

- [x] Security review: owner/scope authorization, policy revision fences, fail-closed readiness, retired writes, persistence/claim ordering, and bounded bridge behavior reviewed. No Critical or High finding remains. No live provider or deployed egress claim is made.
- [x] Performance review: no material regression found. The latest source change affects only browser-test scrolling; policy summary and existing read paths were previously reviewed. No performance trace was required for this bounded change.
- [x] Usability and accessibility review: disclosure and error states, responsive captures, native keyboard focus, and recovery reachability reviewed. A full screen-reader audit is not claimed.

## Findings Summary

### functional acceptance

The earlier F1 OpenAPI mismatch and F2 disclosure gap are resolved. The final recovery test helper passes the existing exact viewport and behavior checks. One initial-frame viewport assertion remains failed in the six-spec set; normal Tab makes the enabled Send button fully visible, and Ctrl+Enter submits exactly once without a consent, decision, permission, or separate-start request. The user accepted this Low visual/test debt. Functional, security, credit, quota, storage, and data-loss criteria remain in force.

### security

No Critical or High finding identified. Policy authority remains server-derived and unavailable policy/runtime remains fail-closed. Playwright MCP and Chrome DevTools MCP were unavailable; fixtures are synthetic and do not prove live provider admission or deployed runtime security.

### performance

No material performance finding identified. No profiler claim is made.

### usability and accessibility

F2 provider/data disclosure is present in both active chat surfaces, including runtime-unavailable copy and terms links only for recognized provider labels. Low accepted debt: at 1280×720, the empty-state disabled Send control begins below the initial viewport. Read-only native Tab evidence shows the enabled control becomes fully visible on desktop and a 390×844 emulated viewport. The final automated result remains 17/18; the manual evidence does not replace or relabel it.

## Evidence Index

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| Final independent functional closeout | N/A — local source and evidence review | Latest helper-only scope, source hashes, 17/18 result, keyboard submit, accepted debt, limits | `artifacts/qa-final-functional-validation.md` |
| Final recovery helper validation | Local Playwright CLI; MCP unavailable | Exact cancellation 1/1, recovery spec 2/2, six-spec 17/18, 152-path export scope, cleanup | `artifacts/f3-native-center-validation.md` |
| Send visibility and submit diagnostic | Local Playwright/Chrome fixture; MCP unavailable | Initial viewport geometry, native Tab reachability, one Ctrl+Enter request and zero approval/start/external calls | `artifacts/provider-submit-diagnosis/validation.md`, `curated-geometry.json`, and four reviewed PNGs |
| First independent QA cycle | Local Node, Jest, PostgreSQL, and Linux bridge runners | Backend/frontend/type checks, persistence, bridge evidence, initial F1/F2 findings | `artifacts/qa-luna-independent-validation.md` |
| Second independent QA cycle | Local Playwright/Chrome; MCP unavailable | F1/F2 repairs, independent reproduction of prior cancellation ratio failure, browser cleanup and limits | `artifacts/qa-luna-second-cycle-validation.md` |
| API and disclosure repair evidence | Local Jest/Vitest/Playwright and source review | Eight 409-only writes, provider disclosure, focused tests, screenshots, previous E2E status | `artifacts/qa-repair-validation.md`, `artifacts/qa-repair-final/` |
| Migration and persistence | Local guarded PostgreSQL/Jest | Policy migration, provisioning, revocation, transactional behavior, change-set persistence | `artifacts/qa-luna-independent-validation.md` and `artifacts/qa-final-functional-validation.md` (reviewed summaries; raw runner transcripts omitted) |
| Bridge runtime tests | Local isolated Linux runner | 48/48 bridge tests with zero skips | `artifacts/bridge-command-validation.md` |
| Final source identity | Local SHA-256 and manifest review | Actual/export match for recovery spec and related UI paths; 152 unique task paths | `artifacts/qa-final-functional-validation.md`, `artifacts/task-source-manifest.txt` |
| Protected source boundary | Local handoff artifacts | Authorized three-line task patch and intended source boundary | `artifacts/protected-task-only.patch`, `dev-summary.md` |
| Accepted Low visual/test debt | Project task record | User priority, 17/18 result retained as failed, keyboard evidence and no functional/security waiver | `.codex/docs/hackathon-release/tasks.md` Task 4.1 and Tech Debt Log |
| Acceptance and standards | Project docs and skill | Task contract/spec, required MCP evidence, Definition of Done | `contract.md`, `ui-spec.md`, `.codex/docs/hackathon-release/tasks.md`, `.codex/skills/definition-of-done/SKILL.md` |
| Required MCP evidence status | N/A — unavailable | Playwright MCP and Chrome DevTools MCP unavailability is documented; local fixtures are substitutes, not MCP results | `.codex/docs/hackathon-release/tasks.md` Task 4.1; `artifacts/qa-luna-second-cycle-validation.md`; `artifacts/qa-luna-second-cycle-validation.md` |

## Definition of Done Checklist

### Universal

- [x] Coding standards and architecture reviewed; developer self-review is approved.
- [x] Backend, frontend, and frontend-node TypeScript checks pass.
- [x] No unsafe authorization shortcut, debug statement, or unlinked TODO was identified in reviewed task source.
- [x] Layer boundaries and migration registration/rollback guards align with the task architecture.
- [x] OpenAPI documents the new read route and the retired write behavior.
- [x] New shared UI component includes a usage comment.
- [x] Migration is registered, reversible, and covered by guarded PostgreSQL tests.
- [x] Required unit, integration, bridge, and preview evidence has been reviewed. The preview set is 17/18; its single Low visual/test item is accepted and recorded in the Task 4.1 Tech Debt Log under the user's explicit delivery priority. It is not called green.
- [x] Required MCP unavailability and the local substitute evidence are documented.

### Frontend

- [x] Matches `ui-spec.md` for Home/workspace disclosure and runtime states.
- [x] Loading, unavailable, error, ready, legacy-blocked, recovery, and cancellation states are covered by tests/evidence.
- [x] Existing localization/config conventions were followed.
- [x] Responsive layout and normal keyboard access are supported by preview evidence; full screen-reader verification is not claimed.
- [x] No unexpected browser errors were identified in synthetic fixtures; authored error responses are documented.
- [x] Interactive UI paths have focused behavior tests and test IDs.

### Backend

- [x] Retired decision handlers return `409 POLICY_ACTION_RETIRED` without decision or state-change effect.
- [x] Request validation and authentication/ownership checks follow repository conventions.
- [x] Errors map to safe HTTP responses; no task-source secrets or credentials were found.
- [x] OpenAPI status documentation and tests match retired endpoint behavior.
- [x] Migration and persistence tests pass; isolated QA targets were absent after postflight.

### QA Gate

- [x] Required frontend unit tests: PASS.
- [x] Required backend unit tests: PASS.
- [x] Required backend integration tests: PASS.
- [x] Frontend E2E evidence reviewed; one Low initial-viewport assertion remains failed and is explicitly accepted as debt, not reported as an all-green run.
- [x] Security review: no Critical or High finding.
- [x] Performance review: no material regression found.
- [x] Usability and accessibility review: disclosure and normal keyboard/recovery access verified; full assistive-technology audit not claimed.
- [x] Tester final verdict: PASS with the accepted Low debt stated above.

## Verdict: PASS

The task meets its functional, security, persistence, and documentation acceptance criteria. One Low initial-viewport assertion remains failed in the six-spec preview set (17/18); the user explicitly authorized deferring this minor visual issue, and it is recorded in the Task 4.1 Tech Debt Log. The exact automated result remains visible as 17/18. No feature, authorization, scope, security, credit, quota, storage, or data-loss gate was waived.
