# Task 3.5 validation receipt

## Focused backend checks

From `Personal-AI-Workspace/backend`:

```text
node node_modules/jest/bin/jest.js --config jest.config.cjs --runInBand --runTestsByPath src/infrastructure/database/repositories/typeorm-demo-expiry-cleanup-repository.spec.ts src/infrastructure/database/repositories/typeorm-demo-showcase-copy-manager.spec.ts src/infrastructure/workspace/workspace-boundary.spec.ts
```

Result: 3 suites passed, 15 tests passed. This includes the persisted unknown-root-receipt barrier, the copy-manager paths, exact managed-child removal, and fail-closed reparse-point handling.

```text
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

Result: the latest run exits nonzero due to concurrent Task 4.3 task-mutation diagnostics in `src/composition-root.ts`, `src/infrastructure/database/repositories/typeorm-project-task-repository.ts`, `src/modules/home-assistant/use-cases/{home-change-proposal-use-cases,home-planning-tool-request-handler}.ts`, `src/modules/tasks/**`, and related task tests. No diagnostic points to a Task 3.5-owned file. This is an out-of-scope concurrent change and is not counted as a passing type check.

To verify the exact Task 3.5 commit candidate without those unstaged changes, I created a detached worktree at HEAD `00e40200ad40ddda73605295b151f42e90466690`, overlaid the staged index snapshot, and linked the existing `backend/node_modules` directory. The same TypeScript command passed there. No dependencies were installed, and the shared worktree result above remains non-passing.

## Guarded PostgreSQL integration

The authorized focused run used `backend/jest.integration.config.cjs` and only `test/integration/demo-expiry-cleanup.integration.spec.ts`. Result: 1 suite passed, 3 tests passed; migration `CreateDemoExpiryCleanup1710000034000` was applied. The same-process preguard checked the approved base identity and zero `home_history_task_%` databases before Jest. The test-owned database was dropped; a separate new-process postguard checked the base identity and confirmed zero task databases remained. Fixture credentials were not written to this artifact or printed.

The replay case finalized an expired owner into a status-only `failed/expired` tombstone with `owner_id = null`, no remaining owner/session, and unchanged regular/admin/showcase/global and network-counter baselines. The root-effect case kept the owner, cleanup job, and managed project root while its receipt was pending/unknown. After the fixture advanced the receipt to `verified`, a fresh repository instance resumed from persisted PostgreSQL state, removed only the manifested demo project child, and retained the regular owner’s root/project and the published showcase version.

This verifies persisted restart recovery using a fresh repository instance. It does not claim that lease expiry proves an external filesystem call has stopped; unresolved receipts continue to block purge. The receipt transition in the integration fixture is an explicit test acknowledgment.

The credit-retention regression creates and settles real demo provider-call reservations, then proves in-flight (`busy`) and unknown (`unknown_effect`) rows block cleanup without detaching their owners. After resolving the unknown call, finalization nulls only reservation and usage `owner_id` fields while preserving all queried financial detail and reservation links. Daily and campaign totals, regular/admin users and project data, showcase publication, and admission counter baselines remain unchanged. Terminal settlement replay after detachment returns the recorded charge and changes no shared totals. The test also verifies that the expired owner/session are removed and the admission remains a status-only failed tombstone.

## Scope of verification

No browser, full repository suite, full production build, or paid inference run was performed. These are outside Task 3.5's backend cleanup scope and were not needed for the focused QA handoff.
