# QA Report: Task 4.2 — Execute Home task and workspace actions through canonical use cases

## Change History

- 2026-10-19: Independent QA reviewed the contract, UI spec, architecture preflight, source manifest, developer self-review, browser artifacts, and focused test evidence. Independently reran five Jest suites / 31 tests, four Vitest files / 24 tests, and the bridge Python suite / 23 tests; all passed.
- 2026-10-19: The shared task session updated the Task 4.2 Low accessibility refinement in the Tech Debt Log. This QA pass created .codex/docs/hackathon-release/task-4-2-direct-home-actions/qa-report.md and .codex/docs/hackathon-release/task-4-2-direct-home-actions/artifacts/qa-focused-reruns.txt.
- 2026-10-19: Reviewed the developer's browser history: initial 2/3 was caused by the transient Home drawer closing on reload; the test reopened the same conversation and the final run passed 3/3. No new browser run was needed.

## Test Evidence Reviewed

- [x] Developer frontend unit tests — Vitest: independently reran the four touched suites, 24/24 passed.
- [x] Developer backend unit tests — Jest: independently reran five focused suites, 31/31 passed.
- [x] Developer backend integration tests — Jest: no new PostgreSQL run was started because Task 4.2 changes no persistence implementation or schema. Reused the prior guarded Home command-parity PostgreSQL proof (2 suites / 5 tests) and Task 3.2 action-ledger transaction/replay/rollback proof (1 suite / 1 test). The Task 4.2 integration-spec diff only narrows its helper for the new result union. Scope and evidence are recorded in artifacts/qa-focused-reruns.txt.
- [x] Developer frontend E2E tests — Playwright: reviewed the final local preview run (3/3) and its synthetic screenshot/JSON evidence. Task tracker declares Playwright MCP N/A; no MCP result is claimed.
- [x] TypeScript and preview build: developer evidence reports backend, frontend app, frontend node type checks, and Vite preview build passed.

## Functional Acceptance Review

- [x] API behavior verified: receipt GET and undo summaries expose only the added persisted actor/turn provenance with existing authentication, owner scoping, validation, and error envelopes.
- [x] Business rules and edge cases verified: direct actions continue through the existing canonical handlers and ledger; assistant provenance uses the persisted turn; replays do not create another receipt; earlier receipts remain valid after a later conflict.
- [x] Error cases verified: only ProjectTaskVersionConflictError and ProjectVersionConflictError become the fixed VERSION_CONFLICT result. Idempotency reuse, policy/auth/scope errors, unsupported results, and transport uncertainty retain their fail-closed paths. A failed action has no success receipt.
- [x] Migration or persistence outcomes verified: no migration or database source change was made. The unchanged task/action-ledger transaction and replay boundary is supported by the prior guarded PostgreSQL evidence cited above; the new conflict mapping is covered by focused unit tests.
- [x] contract.md alignment verified: receipt provenance, bounded conflict, exact result validation, and no synthetic receipt behavior agree with the implemented source and tests.

## Review Lenses Applied

- [x] Security review: applied to owner-scoped receipt access, direct tool dispatch, result validation, and browser-visible error handling.
- [x] Performance review: applied to the additive receipt fields and existing Activity lookups; no new query, migration, dependency, or unbounded payload was introduced.
- [x] Usability and accessibility review: applied to source/action/outcome labels, receipt states, read-only legacy previews, and the documented Low live-status refinement.

## Findings Summary

### functional acceptance

PASS. The backend maps only the two exact canonical version exceptions to a bounded conflict result. The handler creates no receipt for that result, and unrelated failures are rethrown. Existing receipt DTOs expose actorKind and nullable turnId; Activity labels source from those fields and uses the persisted turn for placement. The browser journey shows the receipt and undo flow with synthetic data. It makes no live provider or production-data claim.

### security

No Critical or High findings. Receipt lookup continues to derive owner identity from the authenticated principal and delegates to the owner-scoped use case. The Hermes TypeScript validator and Python bridge accept only the fixed result envelope/code; exception text or arbitrary HTTP 409 values do not cross the boundary. The task introduces no new authorization bypass or public endpoint. Playwright MCP and Chrome DevTools MCP were declared N/A in tasks.md; no runtime MCP evidence is claimed.

### performance

No material regression found. The new response fields are two small persisted values, and the UI uses the existing receipt/target query path. No query, schema, dependency, or bulk processing change needs a profiler trace for this bounded task.

### usability and accessibility

The receipt heading shows the action and stored source, and ready receipts show their current applied/undo state. The one Low finding is that the loading text “Checking receipt…” is rendered in a plain span without a polite live status, so assistive technology may not announce that transient lookup. The project manager recorded this accepted refinement in .codex/docs/hackathon-release/tasks.md Tech Debt Log. It does not block the receipt flow or its labels.

## Evidence Index

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| Independent focused reruns | Local Jest, Vitest, Python unittest runners | 5 Jest suites / 31 tests, 4 Vitest files / 24 tests, bridge Python 23 tests; corrected runner invocations; persistence boundary | artifacts/qa-focused-reruns.txt |
| Developer implementation and test summary | N/A — developer-authored source | Changed paths, type checks, preview build, initial browser failure and corrected 3/3 result | dev-summary.md |
| Developer self-review | N/A — source review | Exact conflict classes, safe validators, no receipt on failure, no migration | self-review.md |
| Task 4.2 API/UI contracts and architecture | N/A — project docs | Acceptance criteria, outcome semantics, security boundaries, UI and accessibility states | contract.md, ui-spec.md, architecture-preflight.md |
| Exact changed-source list | N/A — project source manifest | Touched source and test files, including the command-parity integration helper | exact-source-manifest.txt |
| Browser preview screenshot | Local Playwright CLI; MCP declared N/A | Synthetic Home Activity receipt with readable action/source and undo state | artifacts/home-receipt-journey.png |
| Browser preview network/evidence JSON | Local Playwright CLI; MCP declared N/A | Synthetic receipt/target/undo reads, zero retired proposal mutations, no external calls; no live provider claim | artifacts/home-receipt-journey-browser-evidence.json |
| Home command-parity PostgreSQL proof | Prior guarded local Jest/PostgreSQL run | Canonical Home task/workspace commands, replay, assistant attribution, owner rejection, atomic receipt/event behavior; final 2 suites / 5 tests | .codex/docs/home-assistant/task-4-2-planning-tools-and-provider-consent/artifacts/command-parity-postgres.md |
| Task/action-ledger PostgreSQL proof | Prior guarded local Jest/PostgreSQL run | Unchanged task/action-ledger replay and transactional rollback of task, event, receipt, and quota accounting; 1 suite / 1 test | .codex/docs/hackathon-release/task-3-2-storage-quotas/artifacts/test-project-task-storage-quota.md |
| Required MCP status | N/A — declared by project tracker | Playwright MCP, Chrome DevTools MCP, and Context7 inputs are N/A for this task | .codex/docs/hackathon-release/tasks.md Task 4.2 |
| Accepted Low refinement | N/A — project task tracker | Plain-span receipt loading state without polite live announcement | .codex/docs/hackathon-release/tasks.md Tech Debt Log |

## Definition of Done Checklist

### Universal

- [x] Code follows project coding standards; developer self-review passed and focused source review found no unjustified any, commented-out code, unlinked TODO, or debug statement.
- [x] Backend, frontend app, and frontend node TypeScript checks passed in developer evidence.
- [x] Implementation follows the task architecture and preserves existing Clean Architecture/FSD layer boundaries; no new dependency or circular import was introduced.
- [x] Receipt response shape is documented in OpenAPI and covered by its focused Jest test. README changes are not applicable because setup, commands, and architecture did not change.
- [x] The existing Home Activity component was adapted; no new shared component requiring a usage comment or Storybook story was added.
- [x] No schema change was made, so no migration was needed.
- [x] Focused unit and bridge tests passed; existing guarded PostgreSQL coverage is reused for the unchanged persistence boundary; the corrected Playwright journey passed. No skips are reported for the focused sets.
- [x] Developer self-review and required developer test review are complete.
- [x] Required browser and external-library MCP inputs are explicitly N/A in the task tracker; synthetic local browser evidence is identified as such and indexed here.

### Frontend

- [x] Activity receipt source/action labels and loading/error/undo states match the UI spec, with the Low loading-announcement refinement recorded as debt.
- [x] No new hardcoded configuration/localization strings were introduced; the project has no translation runtime.
- [x] Existing responsive Home layout and shared token styling are retained; the new labels wrap within the receipt card and the reviewed preview shows no horizontal overflow.
- [x] Semantic heading, link, and button controls are used; focused component and browser tests pass.
- [x] No unexpected browser runtime issue was identified. The retained synthetic flow includes expected auth bootstrap and undo error responses.
- [x] Receipt controls have test IDs; the corrected preview covers the drawer reopening after reload. No live-provider behavior is claimed.

### Backend

- [x] Receipt/undo DTOs preserve owner-scoped access and validation while exposing only persisted provenance.
- [x] Existing endpoints retain their established status and error behavior; tool arguments remain validated by the existing strict schemas before canonical use cases run.
- [x] No secrets or credentials were introduced.
- [x] Known conflicts map to one fixed safe code; unrelated failures keep their previous handling.
- [x] No new endpoint, schema, migration, idempotency store, proposal acceptance path, or batch persistence was introduced.
- [x] Existing guarded PostgreSQL evidence covers the unchanged canonical mutation/ledger persistence boundary; no new persistence path was introduced.

### QA Gate

- [x] Frontend unit tests: PASS, 24/24.
- [x] Backend unit tests: PASS, 31/31.
- [x] Bridge tests: PASS, 23/23.
- [x] Frontend E2E: PASS, 3/3 on the corrected synthetic preview journey.
- [x] Security review: PASS; no Critical or High finding.
- [x] Performance review: PASS; no material regression found.
- [x] Usability and accessibility review: PASS with the accepted Low finding recorded in Tech Debt Log.
- [x] Tester verdict: PASS.

## Verdict: PASS

## Failure Details (if FAIL)

N/A. One Low accessibility refinement remains recorded as tech debt; it does not violate core acceptance criteria or the Definition of Done.
