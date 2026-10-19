# Task 3.4 Backend Verification Receipt

This receipt contains only fixture identity categories and test outcomes. It excludes connection strings, credentials, owner identifiers, project identifiers, file paths from test data, raw SQL error messages, and row values.

## Commands and final results

- Backend typecheck: node backend/node_modules/typescript/bin/tsc -p backend/tsconfig.json --noEmit — exit 0.
- HTTP gate integration: node backend/node_modules/jest/bin/jest.js --config backend/jest.integration.config.cjs --runInBand test/integration/demo-copy-gate-http.integration.spec.ts — exit 0, 1 suite / 3 tests passed. It exercises createApp and confirms denial before the private handler plus ready-demo, regular-session, copy-status, and public-read behavior.
- Focused backend Jest: 4 suites and 15 tests passed. Suites cover the copy manager status projection, showcase OpenAPI schema, showcase use cases, and demo-session use case.
- Guarded integration command: node backend/node_modules/jest/bin/jest.js --config backend/jest.integration.config.cjs --runInBand test/integration/demo-admission.integration.spec.ts — 1 suite, 4 tests passed.
- Pre-run guard: fixture-selected database identity was verified as loopback PostgreSQL on the approved test port and home_test/home_history_test identities. The task-scoped home_history_task_* database count was zero.
- Post-run guard: a separate new process verified the same base database identity and zero home_history_task_* databases. All database clients closed. No live test process or task database remained.

## Failed attempts and fixes

- An initial Jest invocation used the regular unit configuration and selected no integration tests; it did not connect to PostgreSQL or mutate a database. The test was rerun with the explicit integration configuration.
- Initial fixture setup attempts could not read the approved private environment entry under the default sandbox and could not resolve the PostgreSQL client when launched from the wrong working directory. Both stopped before connecting. The approved fixture was subsequently loaded in-process without printing its secret, and the installed backend client was run from the correct workspace context.
- A prior guarded attempt timed out during fixture beforeEach; its immediate fixture retry encountered a duplicate owner row. The fixture was reset before the final run, whose 4/4 result and postguard passed.
- An early guarded integration run found that the copy claim check read admission status from the wrong object boundary. The guard was corrected to use the locked admission row; expiry and readiness checks were retained.
- A later guarded run reached root project creation but clone insert failed with sanitized SQLSTATE 42P08 (ambiguous parameter). Review found a reused status parameter in SQL CASE expressions; clone insertion now passes explicit booleans for completed and archived timestamps.
- The next guarded run reached the final project-policy assertion. PostgreSQL returned the revision bigint using its configured string representation while the assertion expected a number. The test query now casts only that displayed assertion value to int; production storage types are unchanged.
- A first focused test typecheck found an incorrect Jest mock generic arity. The test type was corrected. The subsequent backend typecheck and four focused Jest suites passed.
- The final guarded integration run passed all four tests and its independent post-run guard.

## Data and security boundary

The approved PostgreSQL fixture used its test volume and a process-only fixture credential; neither the credential nor connection URL was printed or committed. No production resources, production user data, or provider credentials were used. The suite removed its task-scoped fixture databases and test-managed workspace, and the fresh postguard passed. Copy-failure diagnostics are test-only and sanitized; production failures remain generic.