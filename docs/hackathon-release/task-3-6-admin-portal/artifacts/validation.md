# Task 3.6 Validation Record

## Automated checks

- Backend focused Jest unit tests: 5 suites, 19 tests passed. Command: node node_modules/jest/bin/jest.js --runInBand src/modules/admin-portal/use-cases/admin-portal-use-cases.spec.ts src/modules/admin-portal/controllers/admin-portal-router.spec.ts src/infrastructure/database/repositories/typeorm-admin-portal-repository.spec.ts src/infrastructure/database/repositories/typeorm-demo-admission-repository.spec.ts src/modules/demo/use-cases/create-demo-session.spec.ts
- Backend TypeScript: node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json passed.
- Frontend focused Vitest: 5 files, 43 tests passed. Command: node node_modules/vitest/vitest.mjs run --config vitest.config.mjs --configLoader runner src/entities/account-usage/model/use-account-usage.spec.tsx src/features/ai-run/ui/ChatComposer.spec.tsx src/features/ai-run/ui/AiRunEntry.spec.tsx src/features/home-chat/ui/HomeChat.spec.tsx src/widgets/demo-session-route/DemoContentGate.spec.tsx
- Frontend TypeScript: node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json passed.
- Vite production build passed: node node_modules/vite/bin/vite.js build --config vite.config.mjs --configLoader runner; 621 modules. Vite reported existing Radix use-client directive notices and a large-bundle warning.

## PostgreSQL integration

- Scope was limited to test/integration/admin-demo-policy.integration.spec.ts with the actual 1710000037000 migration explicitly included. Final command: node node_modules/jest/bin/jest.js --config jest.integration.config.cjs --runInBand --runTestsByPath test/integration/admin-demo-policy.integration.spec.ts; 1 suite and 1 test passed.
- The approved private fixture was read without printing credential values. The final run had a same-process preguard confirming exact approved database identity and zero home_history_task_% databases; it closed its clients. A separate fresh-process postguard confirmed the base identity and zero target databases.
- Two earlier Jest attempts failed before passing: the first exposed an untyped nullable SQL parameter (fixed with explicit casts); the second expected unknown while the global pause was enabled (the correct status was paused, so the assertion order was fixed). One fresh-process postguard after both failures confirmed base identity and zero targets. Do not interpret this as a separate postguard after each failure.
- One fixture read initially required the authorized escalated command. One guard-script quoting attempt failed before opening a database connection and did not run Jest. No credentials were printed and no force cleanup was used.

## Browser smoke

- CUA was unavailable; used the approved Playwright fallback against a fresh local production bundle and mock routes: node node_modules/@playwright/test/cli.js test --config=playwright.config.ts e2e/task-3-6-admin-usage.spec.ts --workers=1. Final result: 1 test passed.
- Journey covered account creation, zero daily limit, credential reset without displaying the submitted password, switching to the synthetic regular-user session, exhausted Usage, disabled Ask, and a manual task edit that remained usable.
- The smoke uses route stubs only. Unrelated app boot reads returned stubbed 404 responses for /api/v1/demo/availability, /api/v1/projects/overview?taskLimit=6, /api/v1/assistant/execution-policy?scope=home, and /api/v1/home/conversations?scope=home&limit=50. A POST /auth/logout request was reported as failed during navigation/cancellation. These do not establish live API integration or provider readiness.
- Two earlier browser attempts failed on selectors and were corrected. Initial temporary Vite configurations also failed (CommonJS export resolution and esbuild symlink access); the production Vite build and final preview succeeded.
- The preview used verified free port 5193 and owned PID 75652. The process was stopped and the port was checked for listener absence afterward.
- Reviewed screenshots: artifacts/admin-portal-mock-smoke.png and artifacts/usage-exhausted-mock-smoke.png.

## QA cycle 1 campaign-identity follow-up

- Official QA cycle 1 result remains recorded as FAIL in qa-report.md. Finding: an ordinary settings edit could switch or clear a configured campaign ID and therefore select another usage ledger.
- The repository checks the locked persisted ID after administrator authorization and expected-revision validation but before any mutation. A change or clear returns 409 DEMO_CAMPAIGN_ID_IMMUTABLE. Initial null-to-configured setup remains allowed. The UI presents a configured ID as read-only; same-ID cap edits stay enabled.
- Added repository regression coverage for changed ID, cleared ID, initial configuration, and no writes/audit/counter mutation on rejection. The existing same-ID cap-edit test asserts settled/reserved daily and campaign usage remain visible and no counter/ledger update or deletion occurs.
- Focused Jest rerun: typeorm-admin-portal-repository.spec.ts, 1 suite / 5 tests passed. One initial attempt failed because a broad mutation regex incorrectly matched SELECT ... FOR UPDATE; the regex was narrowed to SQL statements beginning with UPDATE/INSERT/DELETE, then the suite passed.
- Frontend TypeScript passed after the read-only field change. No schema, SQL write path, migration, or API request shape changed, so PostgreSQL, production build, and browser smoke were not rerun for this guard-only repair. The shared ApiError schema declares code as a string, so the new 409 code needs no enum change.
- Backend TypeScript initially reported errors in in-progress Task 7.1 automation files (missing beginDispatch implementation and unresolved skillRevisionId/skill references). After those shared edits stabilized, the same backend TypeScript command passed. No Task 3.6 source appeared in the earlier errors.
## OpenAPI contract follow-up before QA cycle 2

- Added Task 3.6 route definitions and component DTO schemas to backend/openapi.json, including owner-scoped usage, admin account operations, demo settings, and bounded audit metadata. Mutation operations specify session security plus exact Origin and CSRF headers. The contract states CAS, null-unlimited/string-zero, all-account emergency-pause, and immutable configured campaign ID behavior with HTTP 409 DEMO_CAMPAIGN_ID_IMMUTABLE; the shared ApiError.code remains a string.
- Direct JSON.parse validation passed. Focused Jest command `node node_modules/jest/bin/jest.js --runInBand src/openapi/admin-portal-openapi.spec.ts` passed 1 suite / 3 tests. The first run failed on an assertion expecting different wording for preserved counters; the endpoint description now names settled/reserved counters and ledger explicitly, and the rerun passed.
- This documentation and contract-test change does not alter runtime API behavior; no PostgreSQL, browser, or production-build rerun was needed.

## Scoped commit inventory

- The Task 3.6 staged snapshot contains 49 backend/frontend source and test paths before documentation snapshotting. The exact one-path-per-line inventory is exact-source-manifest.txt; shared files are partial-staged with foreign Task 7.1, 5.3, and task-delete hunks left outside the index. AppShell includes only Task 3.6 navigation; the Task 5.3 sign-out guard remains outside the staged snapshot.
- No Git commit or push has occurred yet.

## Isolated staged snapshot check

- Recreated the exact Git index snapshot in a detached temporary worktree from HEAD; the 60-path patch applied cleanly. Backend and frontend `tsc --noEmit -p tsconfig.json` each exited 0 against that staged snapshot. `git diff --cached --check` passed.
- The temporary worktree and patch file were removed after the checks. The existing backend and frontend dependency directories still resolve in the main workspace.
- The 60 staged paths comprise 49 source/test paths from exact-source-manifest.txt, 10 task-local documents/artifacts, and the complete global tracker snapshot. The canonical and app tracker SHA256 hashes match.

## Tooling / evidence notes

- Context7 and Chrome DevTools evidence were unavailable/not used. Playwright screenshots and test output provide the recorded browser evidence.
- No live external provider calls were made. This feature reports admission/availability status and does not assert that a model provider is configured or ready.