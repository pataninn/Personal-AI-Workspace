# Task 6.1 verification record

## Backend

- Focused Jest: project chat-context use cases, Home planning-context builder, and Home turn submission — 3 suites, 26 tests passed.
- Backend TypeScript check: `tsc --project tsconfig.json --noEmit` passed.
- Guarded PostgreSQL integration: existing `project-fact-storage-quota.integration.spec.ts` selected case for planning-only selection persistence passed. The approved private environment input was read by the guard without printing its value; the preflight verified the expected base identity and zero task databases. A separate new process verified the same base identity and zero task databases after the test. The test harness owned its disposable database lifecycle.

## Frontend

- Focused Vitest: `ProjectMemoryManager.spec.tsx` and `ProjectContextSettings.spec.tsx` — 2 files, 15 tests passed.
- Frontend app TypeScript check: passed.
- Vite preview build: passed. Vite emitted dependency notices about Radix `use client` directives and a large-chunk warning.
- Playwright preview: the single `memory-context.preview.spec.ts` journey passed against Chromium at `http://127.0.0.1:5193`. It covered a planning-only workspace, provider/storage disclosure, selected/editable facts, fresh workspace conversation scope, exclusion and deletion. The API and runtime were synthetic; provider and bridge requests were blocked. No live-provider result is claimed.
- A strict standalone TypeScript check on the E2E spec reported no errors in the new spec, but traversed the imported existing `home-chat-preview-fixtures.ts` and reported two TS2540 errors for mutating readonly `policyNetworkFailures` and `retiredDecisionRequests`. The standard frontend app typecheck passes; Playwright transpiled and ran the new spec successfully.
- The 390px mobile document measured 390px client width and 390px scroll width. The exact preview process was stopped after the run; port 5193 was confirmed closed.

## Browser evidence limits

- The browser fixture verifies the visible UI flow, project selection state, and persisted Home workspace scope. Focused backend tests verify Home prompt assembly and policy gating; the guarded PostgreSQL case verifies the project fact/context persistence boundary.
- The Playwright instrumentation recorded two 401 console messages during preview session checks before sign-in. It recorded one request-failed event for the synthetic fact DELETE, although the test separately awaited the DELETE response with status 204 and then confirmed the fact was absent after reload. There were no uncaught page errors and no provider/bridge requests.
- No separate Chrome DevTools MCP session was available; screenshots and responsive assertions came from the Playwright Chromium run.
