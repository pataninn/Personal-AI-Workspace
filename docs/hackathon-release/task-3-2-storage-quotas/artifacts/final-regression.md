# Task 3.2 final developer regression

Date: 2026-10-19

All database tests used the disposable loopback PostgreSQL fixture on port 55441. The guarded environment value was loaded only into each test process, validated before launch, and never printed or saved. Each integration spec independently validates its target database before creating it and verifies the target is removed afterward.

## Current-tree checks

| Check | Command | Result |
|---|---|---|
| Backend typecheck, including integration fixtures | From `backend`: `node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | Exit 0. |
| Complete backend unit suite | From `backend`: `node ./node_modules/jest/bin/jest.js --config jest.config.cjs --runInBand` | Exit 0; 138 suites / 825 tests passed in 15.739 s. |
| Complete guarded PostgreSQL integration suite | From `backend`, with the protected fixture setting loaded privately: `node ./node_modules/jest/bin/jest.js --config jest.integration.config.cjs --runInBand` | Exit 0; 29 suites / 105 tests passed in 47.637 s. This includes the latest populated-migration/demo expiry fixture, all five readiness-adjusted Home/R1 suites, the isolated accounting suite, and resource-specific quota tests. |
| Five readiness-adjusted Home/R1 suites | From `backend`: `node ./node_modules/jest/bin/jest.js --config jest.integration.config.cjs --runInBand --runTestsByPath test/integration/r1-release-http-postgres.integration.spec.ts test/integration/home-planning-command-parity.integration.spec.ts test/integration/home-planning-proposal-execution.integration.spec.ts test/integration/home-consent.integration.spec.ts test/integration/home-conversation-events.integration.spec.ts` | Exit 0; 5 suites / 15 tests passed in 16.667 s. Also included in the complete integration run above. |
| Compose boundary test | From app root: `node --test scripts/compose-boundary-check.test.mjs` | Exit 1; 7 of 8 subtests passed. The optional managed-storage bind-overlay test passed. The sole failure is an unchanged pre-existing assertion requiring `nvidia_api_key` in the base app service even though the current Compose default is the Nebius provider and the base file does not wire that secret. No Compose source or boundary-test file was changed for Task 3.2. |
| Whitespace/conflict check | From app root: `git diff --check` | Exit 0. Git emitted only CRLF-to-LF working-copy notices for `backend/openapi.json` and `typeorm-home-conversation-repository.ts`. |

The storage API and account-limit read path are included in the unit, integration, typecheck, and OpenAPI coverage. The focused Node test above exercises Compose boundary assertions; it is not a Docker mount-source or deployment-capacity proof.

## Resource-specific PostgreSQL evidence

- `storage-quota.integration.spec.ts`: migration 0029, concurrent account-lock admission, caller-transaction rollback, over-limit shrink, and exact file reservation settle/replay. This generic suite isolates its database-content inventory between tests so prior references cannot contaminate a later expected counter.
- `project-fact-storage-quota.integration.spec.ts`: UTF-8 fact title/content, denied-create rollback, shrink while over limit, verify, and retained soft-delete.
- `project-conversation-storage-quota.integration.spec.ts`: conversation title/message and each raw request fingerprint copy, replay without duplicate charge, denied append rollback, foreign-owner not-found, and the removal write barrier.
- `project-task-storage-quota.integration.spec.ts`: task suggestion acceptance, title/details/subtasks and retained idempotency snapshot, action-ledger reversible/outcome JSONB, replay, denied mutation rollback, and shrink while over limit. `action_ledger_records.request_fingerprint` is a SHA-256 identity hash and is excluded; the raw `conversation_idempotency_keys.request_fingerprint` is content and is charged.
- `project-removal-storage-quota.integration.spec.ts`: durable barrier before quarantine, blocked writer, verified retained project-root charge, exact reference release for project conversation fingerprints and cascaded Home conversation/message/event/proposal-item content, owner-scoped retained Home content, and restart restoration of quarantined recovery data.
- `storage-quota-startup-reconciliation.integration.spec.ts`: verified interrupted-write settlement; missing project root keeps reservation charged/unavailable; verified recovery copy and retained root accounting; empty owner readiness; deterministic managed orphan registration; known-owner unsafe path isolation; unattributable global namespace blocking.
- `r1-populated-migration.integration.spec.ts`: complete fresh/populated migration chains, compatibility and rollback guard, plus an actual expiring demo principal with a managed mapped project. Expiry is committed while a runtime is paused; no late user content/task/tool event is emitted. The historical rollback subfixture stops at migration 0027 so it tests its original rollback contract without undoing current guarded migrations.

The complete PostgreSQL run is the source of the test counts; individual resource suites above are not added again to those totals.

## Earlier failures and resolutions

An earlier integrated PostgreSQL attempt exited 1 with 8 failing suites / 21 failing tests (105 total). It exposed test setup issues and one stale waiter observer rather than a quota-policy relaxation. The R1/Home fixtures now reconcile their real canonical database content and mapped temporary roots before assertions; the R1 expiry case uses the demo principal and its own project; the rollback fixture is isolated to its historical migrations; the generic quota test resets its canonical inventory between cases; and the project-file HTTP fake uses a valid owner UUID and trusted scope.

Two Home concurrency tests initially timed out while waiting for two SQL statements whose text mentioned `home_conversations`. Under the intended lock order, the first writer waits for the test-held conversation row while holding the account quota lock; the second writer is queued on `account_limits` before issuing a conversation query. The tests now observe the exact blocker-PID chain (holder → conversation waiter → account-lock waiter), keep the existing five-second deadline and winner assertions, and pass both focused and full guarded runs.

The first attempt to rerun the five guarded specs did not launch Jest because the restricted env-file ACL denied the default shell. A scoped authorized read was then used; the strict guard passed before test launch. No PostgreSQL operation occurred during the denied attempt.

## Coverage limits

PostgreSQL admission assertions exist for project task/subtask/suggestion/action-ledger copies, project facts, project conversations/messages/idempotency text, generic relational references/reservations, startup backfill, and project removal/cascade release. Project metadata create/update, Home conversation/proposal/event writes, AI-run output, change-set, sandbox-command, and some task event/status paths have focused repository/use-case unit coverage but are not claimed as separate PostgreSQL quota-denial tests. Filesystem adapter unit tests use temporary roots; startup/removal PostgreSQL tests also exercise real temporary roots and recovery files.

No hosted provider call was made. `statfs` reports process-visible free space only. The Compose parser/boundary checks do not inspect deployed Docker mount sources, prove host-root separation, or validate a configured operational threshold; Task 8.1 owns those deployment checks.
