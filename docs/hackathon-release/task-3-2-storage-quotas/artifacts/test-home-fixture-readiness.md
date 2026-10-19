# Home and R1 fixture readiness regression evidence

Date: 2026-10-19

## Scope

Only the five assigned PostgreSQL integration specs were in the Jest command:

- `test/integration/r1-release-http-postgres.integration.spec.ts`
- `test/integration/home-planning-command-parity.integration.spec.ts`
- `test/integration/home-planning-proposal-execution.integration.spec.ts`
- `test/integration/home-consent.integration.spec.ts`
- `test/integration/home-conversation-events.integration.spec.ts`

The protected fixture value was loaded into the PowerShell process only. A preflight verified the client URL host, port, protocol, database and user, then verified the connected PostgreSQL database, current role and database owner. The same database identity was verified after the run. No URL or password was printed or saved.

## Command

Run from `Personal-AI-Workspace/backend`:

```powershell
node .\node_modules\jest\bin\jest.js --config jest.integration.config.cjs --runInBand --runTestsByPath test/integration/r1-release-http-postgres.integration.spec.ts test/integration/home-planning-command-parity.integration.spec.ts test/integration/home-planning-proposal-execution.integration.spec.ts test/integration/home-consent.integration.spec.ts test/integration/home-conversation-events.integration.spec.ts
```

## Initial guarded run

Exit code: `1`. Jest reported 5 suites total: 3 passed and 2 failed; 15 tests total: 13 passed and 2 failed; 0 snapshots; 28.902 seconds.

The passing suites were R1 release HTTP, Home planning command parity, and Home proposal execution. The two failures were 5-second Jest test timeouts in existing cancellation race tests:

- `home-conversation-events.integration.spec.ts`: "rolls back the event cursor after a failed atomic submit and rolls back target plus receipt after cancellation wins" (line 128).
- `home-consent.integration.spec.ts`: "rechecks activity after cancellation wins a queued conversation-lock race" (line 196).

The timeout came from stale fixture instrumentation that expected both blocked writers to have SQL text mentioning `home_conversations`. Under the intended storage lock order, the first writer waits on the fixture-held conversation row while holding the owner quota lock; the competing writer waits on `account_limits` before it can issue a conversation query. The tests have since been updated to identify the exact lock edges by blocker backend PID: lock-holder -> conversation waiter -> account-limit waiter. Original race sequencing, cancellation-first outcome assertions, and the bounded 5-second polling remain intact.

## Corrected main-developer runs

The main developer reran the same five-spec command above after the helper correction. Result: exit 0; 5 suites passed, 5 total; 15 tests passed, 15 total; 16.667 seconds. Both blocker-PID race assertions passed. This is a main-developer-executed result; this agent did not independently rerun the corrected batch.

The main developer then ran the complete guarded PostgreSQL integration suite. Result: exit 0; 29 suites passed, 29 total; 105 tests passed, 105 total. It included all five fixture specs above and the latest R1 test. The full-suite command was not provided to this agent, so no command string is asserted here. Main has the PostgreSQL fixture window; this agent made no further database calls.

## Validation and fixture lifecycle

- Main developer ran `node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` on the shared tree after the waiter-helper correction: exit `0`.
- `git diff --check` passed for the five owned specs.
- The connected target was `home_test` / `home_history_test`, reached through the approved loopback endpoint on port `55441`; pre- and post-run checks matched.
- The base test database remained present. The five suites created or dropped no database; they use their existing owner-scoped fixtures and cleanup.
- The initial five-spec command completed, and the corrected five-spec rerun and complete suite were subsequently executed by the main developer. The fixture window is now returned to main; this agent has no running PostgreSQL command.
- Initial attempts stopped before test execution: sandbox denied reading the restricted environment file; a subsequent PowerShell parsing attempt failed; and a first preflight compared the container-side PostgreSQL address to the client loopback endpoint. The corrected URL and connected-identity guard then passed and executed the Jest command above. These were tooling/preflight failures, not test results.