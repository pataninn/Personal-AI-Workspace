# Task 7.1 worker lifecycle verification

## Focused tests

From `Personal-AI-Workspace/backend`:

```text
node node_modules/jest/bin/jest.js --runInBand src/infrastructure/startup/application-lifecycle.spec.ts src/automations-worker.spec.ts src/infrastructure/startup/periodic-maintenance.spec.ts src/composition-root.spec.ts
```

Result: 4 suites passed, 8 tests passed. The lifecycle selector starts only API maintenance in API mode and only the scheduler in worker mode. Worker shutdown waits for the periodic handle to drain before destroying the initialized database; the SIGTERM handler removes both signal listeners, and a rejected signal wait still closes both resources. A composition startup validation failure destroys the initialized database.

## Type and production build

From `Personal-AI-Workspace/backend`:

```text
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --pretty false
node node_modules/typescript/bin/tsc -p tsconfig.build.json --pretty false
node node_modules/tsc-alias/dist/bin/index.js -p tsconfig.build.json
```

All commands exited successfully, and `dist/automations-worker.js` was emitted. The standalone entrypoint has no HTTP listener dependency.

## Scope

No new PostgreSQL or provider call was made. Existing guarded scheduler, child-process restart, managed-workspace, cleanup, and settled-credit evidence remains in `verification-receipt.md`.
