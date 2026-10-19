# QA Report: Unify task deletion and remove archive behavior

## Change History

- 2026-10-19: Independent source, test, security, performance and usability review completed. Added tester-run focused Jest and guarded PostgreSQL evidence.

## Test Evidence Reviewed

- [x] Developer frontend unit tests — Vitest: 40/40 passed; earlier focused evidence.
- [x] Developer backend unit tests — Jest: focused 3 suites / 24 tests and workspace undo 1 suite / 15 tests passed.
- [x] Developer backend integration tests — Jest: migration 1/1 and Home parity 5/5 passed with clean guards.
- [x] Tester backend unit/API tests — Jest: 3 suites / 20 tests passed.
- [x] Tester backend integration tests — Jest: 4 non-database suites / 14 tests and guarded ownership suite 1/2 passed.
- [x] Frontend E2E — N/A for this task per tasks.md; no Playwright MCP evidence is claimed.
- [x] Backend TypeScript check passed; developer also records both frontend TypeScript project checks passing.

The previous 8-suite / 83-test backend and 40/40 frontend counts overlap the focused reruns and are not added to them. The storage-quota OpenAPI suite is not claimed as green; its seven unrelated missing 413 references are documented as baseline drift.

## Functional Acceptance Review

- [x] API behavior verified: one authenticated, versioned global DELETE handles Inbox and workspace tasks; removed archive and scoped-delete operations are absent from the runtime contract.
- [x] Business rules and edge cases verified: owner scope, stale version conflict, idempotent exact retry, changed-key/fingerprint lookup, ledger payload scrubbing, minimal receipt and no archive tool/filter/state.
- [x] Error cases verified: missing/foreign targets remain non-disclosing, stale versions conflict, and uncertain UI retry reuses the same request key.
- [x] Migration and persistence verified: migration 0036 preserves legacy task content while mapping archived status to done/todo; rollback fails closed after row change or deletion.
- [x] Undo and replay verified: task-create undo removes the task and task-scoped events; exact replay does not resurrect it. Workspace undo retains owner, version, root and empty-content checks.
- [x] contract.md alignment verified against the API, Home tool, ledger and migration behavior.

## Review Lenses Applied

- [x] Security review: owner isolation, current principal and Home/skill/policy gates, idempotency matching, CSRF/same-origin protection, and sensitive ledger payload removal reviewed.
- [x] Performance review: transaction and owner-scoped query paths reviewed; no material regression found for this focused mutation. No benchmark was required or claimed.
- [x] Usability and accessibility review: existing delete confirmation is reused; irreversible outcome is explicit, pending/error states are handled, and component tests cover confirmation and retry. Browser automation was not required by this task's tracker declaration.

## Findings Summary

### functional acceptance

PASS. Canonical delete, archive removal, migration conversion/rollback boundary, stale-version behavior, ledger scrubbing, exact replay and undo protections match the contract. The final migration and parity tests passed after earlier failures; focused request/query and guarded ownership replacement evidence also passed.

The initial six-file PostgreSQL attempt remains recorded as 3 suites passed / 3 failed. The raw log did not identify every original suite by name, so this report does not claim one-to-one mapping to those unavailable identifiers. The final evidence directly covers the known migration and replay failure classes and adds the independently rerun guarded ownership suite; no unresolved functional failure was reproduced.

### security

PASS. Delete derives ownership from the authenticated principal and is protected by same-origin and CSRF checks. Exact Home replay runs current principal, persisted Home scope, bound skill/capability and policy gates first, then matches owner/key/fingerprint/actor/turn/target/action/version. It returns only the cached minimal receipt without target lookup, mutation, a new event or workspace effect. Changed arguments do not use the replay shortcut. Deleted task content is scrubbed from reversible ledger payloads.

### performance

PASS. The delete remains inside the existing transactional ledger and collection-order boundary. No new broad read or unbounded payload path was found; no separate performance benchmark was required for this change.

### usability and accessibility

PASS. The existing confirmation pattern clearly says the task and checklist will be permanently deleted and cannot be undone. Confirm/cancel, pending state, stale-version message, uncertain retry and alert error states are represented in the task detail component tests. Task 4.3 declares Playwright MCP N/A; no browser run is claimed.

### accepted low-priority documentation debt

backend/openapi.json still has stale prose saying the project-task filter supports archived, although the schema/runtime accepts all, open and completed. The release Tech Debt Log records this Low item for later refinement. Seven separate Home/AI-run 413 response references are also missing at both recorded HEAD and current JSON; they are baseline drift, and their quota suite is not represented as passing here.

## Evidence Index

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| Independent tester checks | Jest CLI / local PostgreSQL | 3 unit/API suites / 20 tests; 4 non-DB integration suites / 14 tests; guarded ownership suite / 2 tests; preguard/postguard | [qa-independent-checks.md](artifacts/qa-independent-checks.md) |
| Developer verification receipt | Jest CLI / TypeScript CLI | Focused developer test outcomes, migration/parity guards, failed-attempt history, baseline OpenAPI comparison | [verification-receipt.md](artifacts/verification-receipt.md) |
| Developer summary and self-review | Local source review | Implementation scope, architecture boundary, no blocker claim, test inventory | [dev-summary.md](dev-summary.md), [code-review.md](artifacts/code-review.md) |
| Contract and source ownership | Local source review | Endpoint/tool semantics, error cases, replay, migration/rollback and undo rules | [contract.md](contract.md), [source-map.md](source-map.md), [source-hunk-manifest.md](source-hunk-manifest.md) |
| Release architecture | Local documentation review | Architecture sections 4.2 and 11 | [architecture.md](../architecture.md) |
| API route | Local source review | Authentication, same-origin, CSRF, global DELETE wiring | Personal-AI-Workspace/backend/src/modules/tasks/controllers/global-task-router.ts:295-304 |
| Home handler and task ledger | Local source review | Current gates, exact replay order, fingerprint and receipt matching | Personal-AI-Workspace/backend/src/modules/home-assistant/use-cases/home-planning-tool-request-handler.ts:60-69,144-166; Personal-AI-Workspace/backend/src/modules/tasks/use-cases/task-mutation-use-cases.ts:418-466 |
| Transactional task repository | Local source review | Owner/version check, reversible-payload scrub, physical deletion and order bump | Personal-AI-Workspace/backend/src/infrastructure/database/repositories/typeorm-project-task-repository.ts:980-1023 |
| Migration and integration tests | Jest CLI / local source review | Content-preserving conversion, fail-closed rollback, delete replay and no resurrection | Personal-AI-Workspace/backend/src/infrastructure/database/migrations/1710000036000-canonical-task-delete.ts; backend/test/integration/canonical-task-delete-migration.integration.spec.ts; backend/test/integration/home-planning-command-parity.integration.spec.ts |
| Workspace undo repository | Jest CLI / local source review | Owner/version/root/empty-content guards; repository suite 15/15 | Personal-AI-Workspace/backend/src/infrastructure/database/repositories/typeorm-project-repository.ts:224-316; typeorm-project-repository.spec.ts |
| Task detail UI | Vitest / local source review | Permanent-delete confirmation, pending and retry/error behavior | Personal-AI-Workspace/frontend/src/pages/task-detail/TaskDetailPage.tsx:236-267,352-354; TaskDetailPage.spec.tsx:156-170,195 |
| Required MCP declaration and tech debt | N/A, as declared by task | Playwright, Chrome DevTools and Context7 declared N/A; accepted Low OpenAPI prose debt and baseline 413 drift | tasks.md Task 4.3 and Tech Debt Log |
| Definition of Done | Local skill review | QA gate and severity model | .codex/skills/definition-of-done/SKILL.md |

## Definition of Done Checklist

- [x] Backend code type-check passes; developer self-review is approved for QA.
- [x] Implementation follows architecture 4.2/11, ownership boundaries and the Task 4.3 contract.
- [x] Canonical DELETE and Home tool are documented; focused OpenAPI and validation tests pass.
- [x] Migration is included and forward conversion preserves content; rollback fails closed and does not recreate deleted content.
- [x] Relevant backend unit and integration tests pass; focused frontend unit evidence passes; no skipped Task 4.3 test is used as proof.
- [x] UI confirmation, pending, error and retry states are covered by component tests.
- [x] Required MCP inputs are declared in tasks.md; Playwright, Chrome DevTools and Context7 are N/A for this task, and no unavailable tool is claimed.
- [x] Security, performance, usability and accessibility lenses are recorded above.
- [x] Low documentation debt and unrelated baseline OpenAPI drift are documented in the release Tech Debt Log/verification receipt.

## Verdict: PASS

No Critical or High finding remains open. The task-owned functional and security criteria are verified; accepted Low documentation drift is explicitly logged. Whole-tree work from concurrent tasks is outside this task's evidence scope and is not treated as Task 4.3 failure evidence.
