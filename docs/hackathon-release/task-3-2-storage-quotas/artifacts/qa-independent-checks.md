# Task 3.2 independent QA checks

Date: 2026-10-19

## Focused PostgreSQL verification

The test-only connection setting was loaded privately from the protected fixture file. Its value was never printed or copied into this artifact. The strict fixture guard verified the loopback PostgreSQL instance on port 55441, base database `home_history_test`, role `home_test`, and the per-spec disposable database names. All six target databases were absent before the run and absent after it; the target specs also enforce their own identity and cleanup guards.

From `Personal-AI-Workspace/backend`:

```text
node ./node_modules/jest/bin/jest.js --config jest.integration.config.cjs --runInBand --runTestsByPath test/integration/storage-quota.integration.spec.ts test/integration/storage-quota-startup-reconciliation.integration.spec.ts test/integration/project-removal-storage-quota.integration.spec.ts test/integration/project-fact-storage-quota.integration.spec.ts test/integration/project-conversation-storage-quota.integration.spec.ts test/integration/project-task-storage-quota.integration.spec.ts
```

Result: exit 0; **6 suites / 10 tests passed** in 17.269 seconds. This independent run covers generic admission/reservation and rollback, startup reconciliation, project-removal/cascade accounting, facts, conversations/idempotency copies, and task/action-ledger copies.

The generic quota suite was then rerun alone using the same guarded fixture:

```text
node ./node_modules/jest/bin/jest.js --config jest.integration.config.cjs --runInBand --runTestsByPath test/integration/storage-quota.integration.spec.ts
```

Result: exit 0; **1 suite / 3 tests passed** in 5.886 seconds. This is a focused rerun of a suite already included in the 6/10 result, not additional unique coverage.

## Focused unit and type verification

From `Personal-AI-Workspace/backend`:

```text
node ./node_modules/jest/bin/jest.js --config jest.config.cjs --runInBand --runTestsByPath src/infrastructure/database/storage-content-references.spec.ts src/infrastructure/database/storage-content-accounting.spec.ts src/infrastructure/database/repositories/typeorm-storage-quota-repository.spec.ts src/infrastructure/database/repositories/typeorm-storage-root-mapping-repository.spec.ts src/infrastructure/database/repositories/typeorm-project-removal-repository.spec.ts src/infrastructure/database/project-removal-write-barrier.spec.ts src/infrastructure/workspace/storage-quota-file-mutation.spec.ts src/infrastructure/workspace/storage-quota-reconciliation.spec.ts src/infrastructure/workspace/workspace-mutation-gateway.spec.ts src/infrastructure/workspace/project-recovery-cleaner.spec.ts src/infrastructure/workspace/workspace-boundary.spec.ts src/infrastructure/staging/local-staging-gateway.spec.ts src/infrastructure/startup/periodic-maintenance.spec.ts src/infrastructure/startup/physical-storage-space-monitor.spec.ts src/modules/storage-quotas/domain/storage-quota-policy.spec.ts src/modules/storage-quotas/domain/storage-file-operation-fingerprint.spec.ts src/modules/storage-quotas/use-cases/get-storage-usage.spec.ts src/modules/storage-quotas/controllers/account-storage-router.spec.ts src/openapi/storage-quota-openapi.spec.ts src/infrastructure/database/repositories/typeorm-home-conversation-repository.spec.ts src/infrastructure/database/repositories/typeorm-conversation-repository.spec.ts src/infrastructure/database/repositories/typeorm-change-set-repository.spec.ts src/infrastructure/database/repositories/typeorm-action-ledger-repository.spec.ts src/modules/ai-runs/use-cases/change-set-use-cases.spec.ts
```

Result: exit 0; **24 suites / 167 tests passed** in 6.553 seconds.

```text
node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

Result: exit 0.

## Scope notes

- No frontend or browser flow is in this task. `tasks.md` declares Playwright, Chrome DevTools, and Context7 evidence as N/A.
- The suite results above are independent focused runs. Developer broad regression remains separately recorded as 138 backend unit suites / 825 tests, 29 guarded PostgreSQL suites / 105 tests, typecheck pass, and `git diff --check` pass.
- The Compose full boundary command remains 7/8 because of the already logged baseline NVIDIA-key assertion for the current Hermes/Nebius topology. The dedicated managed-storage overlay/parser assertion passes. This does not prove host mount source, physical separation, or deployment capacity; Task 8.1 owns those checks.
- No provider call was made. The physical disk hook observes process-visible `statfs` capacity only.
