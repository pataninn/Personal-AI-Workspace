# Dev Summary: Floating Home Ask panel

## Change History

- 2026-10-19: Implemented the persistent Home Ask launcher and panel, added focused coverage, fixed focus restoration found in the first browser run, and completed the final scoped checks.

## What Was Implemented

- Added a fixed Ask launcher to the persistent authenticated AppShell and removed the large inline Home chat block from Dashboard.
- Reused the existing Home assistant feature, policy checks, history APIs, run lifecycle, and planning receipt handling. The launcher always requests explicit Home scope.
- Added a desktop bottom-right dialog and a full-height mobile sheet, with history selection, New conversation, close, Escape, Enter-to-send, Shift+Enter newline, and focus restoration.
- Kept the HomeChat controller mounted while the dialog is closed, so draft, selected conversation, policy, history, and active run state remain in memory across close/reopen and route navigation. Per-conversation drafts are keyed to the selected view.
- Keyed the controller to the authenticated principal so a principal change resets private client state. Existing policy readiness continues to disable AI submission when access is unavailable or unknown while leaving manual workspace controls available.
- Kept Dashboard summary refresh working by registering its callback through the AppShell Outlet context.
- No backend code, API contract, persistence, migration, or dependency changed.

## Files Changed

### Frontend

- frontend/src/widgets/app-shell/AppShell.tsx
- frontend/src/widgets/app-shell/index.ts
- frontend/src/widgets/app-shell/HomeAsk.tsx
- frontend/src/widgets/app-shell/home-ask.css
- frontend/src/features/home-chat/model/use-home-chat.ts
- frontend/src/features/home-chat/ui/HomeChat.tsx
- frontend/src/features/home-chat/ui/HomeChat.spec.tsx
- frontend/src/pages/dashboard/DashboardPage.tsx
- frontend/src/pages/dashboard/DashboardPage.spec.tsx
- frontend/e2e/home-chat-preview-test-utils.ts
- frontend/e2e/home-chat.preview.spec.ts
- frontend/e2e/home-summaries.preview.spec.ts

### Backend

- No backend files changed.

### Shared

- No shared UI or API files changed. The shared Dialog wrapper remains unchanged.

### Docs and Evidence

- docs/hackathon-release/task-5-1-assistant-launcher/source-map.md
- docs/hackathon-release/task-5-1-assistant-launcher/self-review.md
- docs/hackathon-release/task-5-1-assistant-launcher/task-source-manifest.txt
- docs/hackathon-release/task-5-1-assistant-launcher/qa-report.md
- docs/hackathon-release/task-5-1-assistant-launcher/ui-spec.md
- docs/hackathon-release/task-5-1-assistant-launcher/artifacts/first-run-focus-restoration.md
- docs/hackathon-release/task-5-1-assistant-launcher/artifacts/home-ask-desktop-dialog.png
- docs/hackathon-release/task-5-1-assistant-launcher/artifacts/home-ask-mobile-history-navigation.png
- docs/hackathon-release/task-5-1-assistant-launcher/artifacts/home-ask-browser-evidence.json
- docs/hackathon-release/task-5-1-assistant-launcher/artifacts/qa-home-chat-cancellation-confirmed.png
- docs/hackathon-release/task-5-1-assistant-launcher/artifacts/qa-home-chat-cancellation-confirmed-browser-evidence.json

## Contract Notes

This is a frontend-only composition change. It consumes the existing Home conversation, message, turn, event, proposal, and assistant execution-policy APIs. The browser fixture received HTTP 200 for the Home history request. No endpoint, request/response shape, validation, or compatibility behavior changed, so no contract update is required.

## Architecture Alignment Notes

The AppShell widget composes HomeChat through its feature public API. The Home conversation selection behavior stays inside the Home chat feature; Ask mode disables URL synchronization without changing embedded workspace chat defaults. Dashboard registers only the summary refresh callback through the shell Outlet context. Home scope and policy are explicit rather than inferred from the current route.

## Evidence Collected

- docs/hackathon-release/task-5-1-assistant-launcher/artifacts/home-ask-desktop-dialog.png — desktop dialog at 1280×720; measured bounds x=816, y=56, width=440, height=640.
- docs/hackathon-release/task-5-1-assistant-launcher/artifacts/home-ask-mobile-history-navigation.png — mobile Ask sheet at 390×844.
- docs/hackathon-release/task-5-1-assistant-launcher/artifacts/home-ask-browser-evidence.json — synthetic fixture calls, viewport bounds, and browser error/request evidence. The mobile sheet measured 390×844 with document client and scroll widths both 390; Home history used scope=home; no page errors or blocked provider/bridge requests were recorded.
- docs/hackathon-release/task-5-1-assistant-launcher/artifacts/qa-home-chat-cancellation-confirmed.png — independent QA active-run cancellation/status screenshot.
- docs/hackathon-release/task-5-1-assistant-launcher/artifacts/qa-home-chat-cancellation-confirmed-browser-evidence.json — independent QA synthetic Home cancellation/status evidence.
- docs/hackathon-release/task-5-1-assistant-launcher/artifacts/first-run-focus-restoration.md — initial focus failure and resolution. Playwright cleaned its default failure directory during the later successful run, so the raw first-run trace is unavailable; the runner failure details are recorded in this file.

## MCP Notes

No Context7 lookup was needed because no new dependency or external framework behavior was introduced. Chrome DevTools MCP was not available in this session. Browser behavior was validated with the local Playwright preview and synthetic fixtures; it does not claim live provider/runtime coverage.

## Code Review Findings (and resolutions)

- No blocking findings remain.
- The first browser run found that a modal Radix history dropdown left the Ask launcher aria-hidden after Escape. The Home Ask history dropdown now uses nonmodal focus management inside the dialog; the final browser journey confirms Escape dismissal and launcher focus restoration.
- Account-private drafts and controller state are cleared by replacing the keyed HomeChat instance when principal.id changes.
- No API, policy, or backend boundary was bypassed. The Home composer still uses existing policy readiness and execution gates.

## Test Coverage Summary

- Vitest: frontend/src/features/home-chat/ui/HomeChat.spec.tsx and frontend/src/pages/dashboard/DashboardPage.spec.tsx — 27/27 tests passed.
- Frontend build and typecheck: pnpm --filter personal-ai-workspace-frontend build — passed after the final source changes. The build emitted existing Radix module-directive notices and the existing large-chunk warning.
- Playwright: the single synthetic home-chat.preview.spec.ts journey — passed after the final source changes. It verifies desktop dialog bounds, mobile sheet bounds, keyboard open, history switch, per-conversation draft restoration, Escape close/focus restore, route navigation, and reopen.
- Browser fixture: synthetic Home list/history calls returned 200, scope was Home, no external provider/bridge requests were made. The browser evidence includes two 401 resource errors during unauthenticated login bootstrap, no page errors, and no failed requests.

## Known Limitations / Tech Debt

- Browser coverage is synthetic and does not establish production provider availability or live backend behavior.
- On narrow mobile width, the longer dialog title wraps across lines; it remains readable and the panel fits the viewport without horizontal scrolling.
- The existing production bundle-size warning remains outside this task.

## Ready for QA: YES
