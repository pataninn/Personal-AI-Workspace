# Dev Summary: Task 5.2 Replace Inbox emphasis with Add task and View all

## Change History

- 2026-10-19: Implemented the Home capture and All tasks updates; validated the latest build and saved mock-preview browser evidence.

## What Was Implemented

- Replaced the Home Inbox capture card with an “Up next” panel led by **Add task** and a visible **View all tasks** action. Add task expands a compact inline form for a required title and optional active planning workspace; the default remains Unassigned.
- Added loading, empty-workspace, invalid-title, saving, error/retry, and success states. The title receives focus on open, disclosure state is exposed accessibly, success links to the task detail page, and Home summaries refresh after capture.
- Removed Inbox prominence from Home navigation while retaining the Inbox collection filter and compatible query behavior. Unassigned tasks appear with an explicit “Unassigned” workspace label in All tasks.
- Added optional workspace assignment through the existing frontend task API adapter and extended only the local mock-preview API to exercise assignment validation. No backend or production API contract changed.

## Files Changed

### Frontend source

- Modified `frontend/src/entities/project-task/api/global-task-api.ts`, `frontend/src/entities/project-task/api/global-task-api.spec.ts`, and `frontend/src/entities/project-task/index.ts`.
- Modified `frontend/src/features/task-capture/index.ts`.
- Added `frontend/src/features/task-capture/ui/HomeTaskCapture.tsx` and `frontend/src/features/task-capture/ui/HomeTaskCapture.spec.tsx`.
- Deleted `frontend/src/features/task-capture/ui/HomeInboxCapture.tsx` and `frontend/src/features/task-capture/ui/HomeInboxCapture.spec.tsx`.
- Modified `frontend/src/widgets/home-overview/HomeOverviewWidget.tsx` and `frontend/src/widgets/home-overview/HomeOverviewWidget.spec.tsx`.
- Modified `frontend/src/pages/dashboard/DashboardPage.tsx` and `frontend/src/pages/dashboard/DashboardPage.spec.tsx`.
- Modified `frontend/src/pages/all-tasks/AllTasksPage.tsx` and `frontend/src/pages/all-tasks/AllTasksPage.spec.tsx`.
- Modified `frontend/src/features/global-task-query/ui/GlobalTaskList.tsx`.

### Preview fixture and tests

- Modified `frontend/preview/preview-global-tasks.mjs` and `frontend/preview/preview-api.test.mjs`.

### Browser tests

- Modified `frontend/e2e/task-home.preview.spec.ts`, `frontend/e2e/task-actions.preview.spec.ts`, and `frontend/e2e/home-summaries.preview.spec.ts` to cover the new Home actions and preserve related journey assertions. The first two files contain one Task 2.1 identifier-login line each; those identity-only lines are excluded from the Task 5.2 commit. `home-summaries.preview.spec.ts` uses the shared sign-in helper.

### Task evidence

- Added the six inspected local-preview screenshots listed under Evidence Collected.
- No backend source files, task brief, task list, or UI specification were changed by Task 5.2.

## Contract Notes

- This is a frontend task using the existing global task creation endpoint and request contract. The frontend now passes an optional workspace identifier through the existing task adapter; there is no endpoint, database, or production API schema change.
- The preview fixture verifies an active planning workspace assignment, idempotency, Inbox count compatibility, and rejection of an archived workspace. Preview results simulate the API and do not demonstrate persistence against the real backend.

## Architecture Alignment Notes

- Dashboard composition remains in the dashboard page and Home overview widget; capture behavior stays in the task-capture feature and uses the public task entity API.
- The All tasks page and global task list keep collection filtering separate from the task capture feature. Inbox remains a compatible filter; the Home navigation no longer gives it the primary task-creation emphasis.
- The capture flow stays intentionally small. Additional task metadata remains available through the existing task detail route reached by “View task.”

## Evidence Collected

- `artifacts/home-up-next-desktop-preview.png` — desktop Home with capture expanded.
- `artifacts/home-up-next-mobile-preview.png` — narrow mobile Home with capture expanded.
- `artifacts/all-tasks-unassigned-mobile-preview.png` — All tasks showing an unassigned task.
- `artifacts/capture-retry-error-preview.png` — capture error state and retry action.
- `artifacts/home-summaries-desktop-preview.png` and `artifacts/home-summaries-mobile-320-preview.png` — related Home summary journeys at desktop and 320 px widths.
- Screenshots were produced by Playwright against the local mock preview at `http://127.0.0.1:5173`; the visible preview banner identifies mock data. They contain no real workspace data and provide no persistence proof.
- Latest browser commands, run from `frontend` with process-scoped `pnpm_config_verify_deps_before_run=false`:
  - `pnpm.cmd exec playwright test --config playwright.preview.config.ts task-home.preview.spec.ts` — 2 passed.
  - `pnpm.cmd exec playwright test --config playwright.preview.config.ts task-actions.preview.spec.ts home-summaries.preview.spec.ts` — 5 passed.
- Focused unit tests: `pnpm.cmd exec vitest run --config vitest.config.mjs --configLoader runner src/features/task-capture/ui/HomeTaskCapture.spec.tsx src/widgets/home-overview/HomeOverviewWidget.spec.tsx src/pages/dashboard/DashboardPage.spec.tsx src/pages/all-tasks/AllTasksPage.spec.tsx src/entities/project-task/api/global-task-api.spec.ts` — 5 files, 38 tests passed.
- Preview API tests: `pnpm.cmd run test:preview` — 26 passed.
- Frontend typecheck: `pnpm.cmd run typecheck` — passed after the final UI fix.
- Full frontend Vitest suite: passed after the Task 5.2 UI fixes (57 files, 292 tests, run by the concurrent developer on 2026-10-19 with `pnpm.cmd --dir frontend test`; Vitest took 30.53 seconds). The `frontend/tsconfig.node.tsbuildinfo` side effect was restored to its initially clean state after typecheck.
- `git diff --check` for the Task 5.2 manifest — passed.
- Vite preview build completed. It reported the existing large-chunk warning (>500 KB); the build did not fail.

## MCP Notes

- Context7 was not needed because the implementation uses existing project React/Vitest/Playwright patterns and no new external library behavior.
- Chrome DevTools MCP was not present in the configured tool inventory. Browser behavior and rendering were inspected with the installed Playwright CLI and saved screenshots.

## Code Review Findings (and resolutions)

- Visual review found the capture form could render while its disclosure button reported `aria-expanded=false`: the shared `.grid` display rule overrode the browser’s default `[hidden]` behavior. The closed state now applies the explicit `hidden` class, and a focused component test verifies closed visibility before opening. The latest browser run confirms the expanded layout at desktop and mobile sizes.
- The form keeps keyboard focus on the title after opening and returns focus to the trigger after cancel; the browser journey covers these interactions and checks narrow viewport overflow.
- Reviewed the task-scoped diff for whitespace errors and ownership boundaries. No task-owned backend/API contract changes or unrelated app refactors were found.

## Test Coverage Summary

- Vitest frontend unit/component tests: 38 focused tests passed; the full frontend suite also passed (57 files, 292 tests; peer-run command and elapsed time are recorded above).
- Node preview API tests: 26 passed.
- Playwright browser tests using the local Chromium preview: 7 passed across the Home capture, task actions, and Home summaries journeys.
- TypeScript typecheck and scoped diff whitespace checks passed. No backend Jest tests apply because production backend code and contracts were not changed.

## Known Limitations / Tech Debt

- Browser screenshots and preview tests use in-memory mock data only; they do not verify persistence against a live backend.
- The Home capture intentionally edits only title and optional workspace. Other task fields remain on the existing task detail page.
- Vite reports a large chunk warning during the preview build; this is existing build output and was not addressed in this scoped UI task.

## Ready for QA: YES
