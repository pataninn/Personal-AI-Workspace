# Verification Receipt: Task 4.3 canonical task delete

## Baseline and successful checks

HEAD: `57a477f060e3c4a2ffb11fd01f3d6d4a983c4db1`. PostgreSQL used the approved local fixture in process memory only; no URL or fixture contents were printed, tests ran serially, and no forced cleanup was used.

- `node node_modules/jest/bin/jest.js --runInBand src/modules/home-assistant/use-cases/home-planning-tool-request-handler.spec.ts src/modules/home-assistant/use-cases/action-undo-use-cases.spec.ts src/modules/tasks/use-cases/task-mutation-use-cases.spec.ts` — 3 suites / 24 tests passed.
- `node node_modules/jest/bin/jest.js --runInBand src/infrastructure/database/repositories/typeorm-project-repository.spec.ts` — 1 suite / 15 tests passed, including changed workspace and nonempty-content guards.
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` — passed.
- `node node_modules/jest/bin/jest.js --config jest.integration.config.cjs --runInBand --runTestsByPath test/integration/canonical-task-delete-migration.integration.spec.ts` — guarded PostgreSQL, 1 suite / 1 test passed.
- `node node_modules/jest/bin/jest.js --config jest.integration.config.cjs --runInBand --runTestsByPath test/integration/home-planning-command-parity.integration.spec.ts` — guarded PostgreSQL, 1 suite / 5 tests passed; includes task-create undo, repeated receipt replay after physical deletion, workspace undo, and no resurrection.
- Migration and parity pre/postguards confirmed `home_history_test` / `home_test` and zero `home_history_task_%` databases/sessions. Postguard ran in a separate process.
- Earlier focused Task 4.3 evidence retained from execution handoff: backend 8 suites / 83 tests; frontend Vitest 40/40 and both frontend TypeScript project checks passed. These counts are prior evidence and are not added to the reruns above.

## Final staged snapshot checks

- Backend: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` passed against an isolated tree exported from the final index.
- Frontend: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` and `node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit` passed against the staged frontend snapshot. The later index correction changed only a backend 3.6 fixture and Task 4.3 documentation.
- The first backend snapshot check found TS2339 on `bootstrapSettings` in the 3.6-only `r1-populated-migration.integration.spec.ts` fixture refactor. That foreign hunk/path was removed from the 4.3 snapshot; the final backend check passed.
- The final staged path list exactly matches 75 application source/test paths plus 10 documentation paths; `git diff --cached --check` is clean.
## Failed attempts retained

- An earlier approved six-file PostgreSQL run had 3 suites pass / 3 fail, 10 tests passed / 8 failed. It exposed migration SQL/enum dependencies and Home undo lookup ordering. Iterative migration checks found ambiguous owner/project references, enum-dependent index/check objects, and a timezone-sensitive assertion; the ledger mapper also needed to parse `task.delete`. The final migration and parity runs above passed.
- One guarded parity wrapper stopped at a JavaScript syntax error in its preguard; no database connection or Jest run occurred.
- The next wrapper's preguard and fresh-process postguard passed, but the unit Jest config reported “No tests found”. No integration test ran in that attempt; the successful run used the integration config and `--runTestsByPath`.
- The first focused Home-handler test compile failed because the new fixture omitted `undoReceipt` from destructuring. The test was corrected and the final focused run passed 24/24.

## Baseline OpenAPI drift

The check `storage quota OpenAPI contract › documents quota/accounting response codes, safe detail examples, and write coverage` has seven missing `413` response refs. A read-only comparison of HEAD and the current JSON found each missing at both:

- `POST /api/v1/home/conversations/{conversationId}/turns/{turnId}/consent-decisions`
- `PATCH /api/v1/home/conversations/{conversationId}/proposals/{proposalId}/items/{itemId}`
- `POST /api/v1/home/conversations/{conversationId}/proposals/{proposalId}/acceptance`
- `POST /api/v1/home/conversations/{conversationId}/proposals/{proposalId}/execution`
- `POST /api/v1/ai-runs/{runId}/egress-decision`
- `POST /api/v1/ai-runs/{runId}/proposed-change-set/decision`
- `POST /api/v1/ai-runs/{runId}/commands/{commandId}/decision`

Do not report that suite as passing. Task-owned global delete and project POST schema checks passed in the earlier focused OpenAPI run.

## Shared-worktree note

The initial staged whitespace check found an extra blank line at EOF in the Task 4.3 qa-independent-checks artifact; it was trimmed. The final `git diff --cached --check` is clean. CRLF normalization notices in concurrently edited files were informational; no foreign hunks were staged.