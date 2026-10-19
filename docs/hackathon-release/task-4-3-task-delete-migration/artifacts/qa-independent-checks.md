# Independent QA Checks: Task 4.3

Date: 2026-10-19

## Tester-run checks

All commands ran from the backend package using its installed Jest CLI; no dependencies were installed.

- Unit/API contract: Jest with src/openapi/global-task-openapi.spec.ts, src/modules/home-assistant/use-cases/home-planning-tool-request-handler.spec.ts, and src/modules/tasks/use-cases/task-mutation-use-cases.spec.ts — 3 suites / 20 tests passed.
- Non-database integrations: Jest with the integration config and test/integration/global-task-mutation.integration.spec.ts, global-task-query.integration.spec.ts, project-task-redesign.integration.spec.ts, and ownership-boundaries-http.integration.spec.ts — 4 suites / 14 tests passed.
- Guarded PostgreSQL ownership integration: test/integration/ownership-boundaries.integration.spec.ts with the integration config and --runTestsByPath — 1 suite / 2 tests passed. A same-process preguard confirmed base identity home_history_test / home_test and zero home_history_task_% databases. A separate fresh-process postguard confirmed the same identity, zero target databases, and a closed client. The private fixture URL stayed in process memory and was not printed or persisted.

The PostgreSQL command was scoped to the single released spec. No broad rerun, browser, build, or forced database cleanup was performed.

## Developer evidence reviewed

The developer's artifacts/verification-receipt.md records:

- Backend unit suites: 3 suites / 24 tests passed for Home handler, action undo, and task mutation.
- Workspace undo repository suite: 1 suite / 15 tests passed.
- Backend TypeScript check passed.
- Guarded migration integration: 1 suite / 1 test passed.
- Guarded Home command parity integration: 1 suite / 5 tests passed.
- Earlier focused evidence: backend 8 suites / 83 tests, frontend Vitest 40/40, and both frontend TypeScript projects passed. These overlapping counts are not added together.

The receipt also retains an earlier six-file PostgreSQL attempt with 3 suites passing and 3 failing (10 passing tests / 8 failing tests). It describes migration SQL/enum issues and Home undo lookup ordering, but the raw log did not preserve every original suite name. The final migration and Home parity runs cover those named behavior classes; the final focused request/query integrations and the separately guarded ownership suite add replacement evidence. This does not claim a one-to-one mapping to unavailable original suite identifiers.

The storage-quota OpenAPI check is not claimed as passing. Its seven missing Home/AI-run 413 response references are recorded as unchanged from baseline HEAD in the developer receipt and release Tech Debt Log.

## Source review

- Canonical DELETE is authenticated, same-origin and CSRF protected; the controller takes owner identity from the authenticated principal and requires the expected version and idempotency key.
- Home command resolution checks the active principal, persisted conversation/turn/scope, current bound skill/capability, and current policy before exact delete replay. The replay matcher checks owner, operation key, fingerprint, actor, turn, task target, action and expected version. A matching replay returns the stored minimal receipt before the deleted task lookup; a changed key or fingerprint continues through scoped target lookup and normal authorization.
- The transactional delete checks owner and version, scrubs reversible ledger payloads, removes the task, compacts ordering, advances the collection order version, and stores a minimal non-reversible receipt. Exact retries return that receipt without repeating effects.
- Migration 0036 converts archived task rows to done/todo while preserving task content and stores only rollback metadata. Rollback fails closed for changed or deleted mapped rows and does not recreate deleted tasks.
- Task-create undo removes task-scoped content; repeat receipt replay cannot resurrect it. Workspace undo remains owner/version checked, rejects attached roots and nonempty workspaces, and performs no filesystem operation.
- The task detail page uses the existing confirmation dialog with permanent-delete language, pending state, retry of the same idempotency key after an uncertain outcome, and an announced error state.
