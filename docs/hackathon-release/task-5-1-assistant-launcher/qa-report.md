# QA Report: Task 5.1 — Move Home assistant into a floating Ask panel

## Change History

- 2026-10-19: Independent QA completed. Reviewed Task 5.1 requirements, architecture and UI spec; reran the focused frontend unit tests (27/27) and one synthetic active-run browser case (1/1). No application code changed during QA.

## Test Evidence Reviewed

- [x] Developer frontend unit tests — Vitest: 27/27 passed across `HomeChat.spec.tsx` and `DashboardPage.spec.tsx`. Independently rerun with `pnpm.cmd --filter personal-ai-workspace-frontend exec vitest run --config vitest.config.mjs --configLoader runner src/features/home-chat/ui/HomeChat.spec.tsx src/pages/dashboard/DashboardPage.spec.tsx --maxWorkers=1`: 2 files, 27/27 passed.
- [x] Developer backend unit tests — N/A; frontend-only change, no backend files changed.
- [x] Developer backend integration tests — N/A; no persistence, API, or backend boundary changed.
- [x] Developer frontend E2E tests — Playwright CLI: developer's desktop/mobile keyboard/history/draft/navigation journey passed. Independent focused run-status case passed 1/1 with `pnpm.cmd --filter personal-ai-workspace-frontend exec playwright test --config playwright.preview.config.ts e2e/home-chat.preview.spec.ts --grep "shows stopping until a status read confirms cancellation"`. The dedicated synthetic preview config was used because the strict `playwright.config.ts` correctly rejects plain HTTP loopback.
- [x] Frontend typecheck/build — developer evidence reports `pnpm --filter personal-ai-workspace-frontend build` passed after final source changes; this command runs both frontend TypeScript checks. I did not rerun build/typecheck while the separate Task 6.1 source work was active.
- [x] Developer self-review and scoped diff check — `self-review.md` reports approval and clean `git diff --check` for the Task 5.1 source paths.

Playwright MCP was unavailable for this run. The repository's synthetic Playwright CLI preview supplied the equivalent browser journey and saved screenshots/evidence. The browser results are fixture-backed and do not establish live provider or production backend behavior.

## Functional Acceptance Review

- [x] API behavior verified (applicable): synthetic Home history and conversation reads use explicit Home scope and return 200; the focused active-run case records the existing cancellation/status calls returning 200. No endpoint, request shape, or server contract was added or changed.
- [x] Business rules and edge cases verified: Home remains explicit regardless of route; dashboard tests confirm work surfaces remain primary and inline chat is removed. Existing close/reopen/navigation checks retain per-conversation drafts and selection. Principal change remounts the controller and clears the previous draft. History selection, policy-unavailable fail-closed behavior, uncertain-send same-key retry, and active-turn cancellation/status handling are covered by the reviewed unit/browser evidence.
- [x] Error cases verified: unavailable or unconfirmed policy disables AI submission and preserves the draft; existing retry/status actions remain available for recoverable send/run states. These cases use synthetic fixtures.
- [x] Migration or persistence outcomes verified (if applicable): N/A; no database or persisted data changed.
- [x] `contract.md` alignment verified (if applicable): N/A; UI-only composition over existing Home conversation/policy APIs.

The HomeChat controller is mounted in the authenticated shell. Its hooks run before the closed-panel return, so hiding the dialog view preserves local controller state and active-run polling. The independent browser case exercised the visible running/stop/status/cancel lifecycle; it did not toggle the panel while the run was active. Close/reopen with drafts and selection is directly exercised, while active-run retention across that same visibility toggle is supported by the persistent component structure and existing active-run lifecycle tests.

## Review Lenses Applied

- [x] Security review.
- [x] Performance review.
- [x] Usability and accessibility review.

## Findings Summary

### functional acceptance

PASS. The Ask panel is mounted once beside the authenticated route outlet, uses explicit `{ kind: 'home' }` scope, and leaves the dashboard work surfaces primary. Developer browser evidence measures the desktop panel at 440×640 within a 1280×720 viewport and the mobile sheet at 390×844 with no horizontal document overflow. History, draft retention, route navigation, keyboard open/close, and focus return pass. The independent browser run confirms the synthetic active-turn stop and status path.

### security

PASS for this frontend scope. No endpoint or authorization path changed. The launcher is hidden without an authenticated principal and on admin/login routes; Home scope is not inferred from the current workspace route; the existing server-owned execution policy continues to gate submission. Principal-keyed remount clears the prior user's client state. Synthetic evidence reports no blocked provider/bridge requests. No live cross-account, response-header, or provider-egress claim is made.

### performance

PASS by focused source/runtime review. The feature keeps one shell-mounted controller rather than creating duplicate Home chat instances. Active-turn polling is bounded to the active turn and its timeout is cleared when the effect changes or unmounts. The dialog and transcript have viewport bounds; no dependency or unbounded client list was added. Chrome DevTools MCP was marked N/A in the task, so no performance trace or Core Web Vitals measurement was collected.

### usability and accessibility

PASS. The existing Radix dialog provides modal focus handling; the panel has a title and description, the composer has a visible label, and buttons expose accessible names. The keyboard journey opens Ask, uses history, dismisses the menu before the dialog, and restores focus to the launcher. Loading, empty, error, policy-unavailable, running, stopping, and terminal status UI are present in the reused feature. Browser evidence records no page errors or failed requests; it does include two expected HTTP 401 resource messages during unauthenticated session bootstrap before synthetic sign-in. No automated axe scan, screen-reader run, or numeric contrast measurement was performed; the panel uses existing theme tokens. The mobile conversation title wraps at narrow width but remains readable and within the sheet. This accepted Low cosmetic item is recorded in the Tech Debt Log in `../tasks.md` for later refinement.

## Evidence Index

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| Task brief and acceptance criteria | Repository docs | Scope, required browser evidence, DoD, debt status | [`../tasks.md`](../tasks.md), Task 5.1 and Tech Debt Log |
| Architecture and FSD guidance | Repository docs | Persistent shell composition and layer boundaries | [`../architecture.md`](../architecture.md) §4.1; `.codex/skills/feature-sliced-design/SKILL.md` |
| UI specification | Repository docs | Desktop/mobile layouts, Home scope, keyboard and state requirements | [`ui-spec.md`](ui-spec.md) |
| Developer evidence | Repository docs | Changed paths, test/build evidence, limitations and initial focus fix | [`dev-summary.md`](dev-summary.md), [`self-review.md`](self-review.md), [`source-map.md`](source-map.md), [`task-source-manifest.txt`](task-source-manifest.txt), [`artifacts/first-run-focus-restoration.md`](artifacts/first-run-focus-restoration.md) |
| Focused frontend unit checks | Vitest CLI | Draft/history/navigation, principal reset, policy and run behavior; Home dashboard priority | `Personal-AI-Workspace/frontend/src/features/home-chat/ui/HomeChat.spec.tsx`; `Personal-AI-Workspace/frontend/src/pages/dashboard/DashboardPage.spec.tsx`; 27/27 passed independently |
| Desktop Ask panel screenshot | Playwright CLI (developer) | Bounded open desktop dialog at 1280×720 | [`artifacts/home-ask-desktop-dialog.png`](artifacts/home-ask-desktop-dialog.png) |
| Mobile history/navigation screenshot | Playwright CLI (developer) | 390×844 sheet, title wrap and no horizontal overflow | [`artifacts/home-ask-mobile-history-navigation.png`](artifacts/home-ask-mobile-history-navigation.png) |
| Developer browser evidence | Playwright CLI (developer) | Synthetic Home API status/scope, viewport bounds, external-request and console/page-error observations | [`artifacts/home-ask-browser-evidence.json`](artifacts/home-ask-browser-evidence.json) |
| Active-run cancellation screenshot | Playwright CLI (independent QA) | Visible Home panel and terminal status after stop/status reconciliation | [`artifacts/qa-home-chat-cancellation-confirmed.png`](artifacts/qa-home-chat-cancellation-confirmed.png) |
| Active-run browser evidence | Playwright CLI (independent QA) | Home-scoped synthetic GET/POST flow; one cancellation and two status reads returned 200; no failed requests or blocked external requests | [`artifacts/qa-home-chat-cancellation-confirmed-browser-evidence.json`](artifacts/qa-home-chat-cancellation-confirmed-browser-evidence.json) |

## Definition of Done Checklist

- [x] Code quality and scoped review: developer self-review approved; scoped changed-file scan found no `any` type, `console.log`/`console.debug`, TODO, or FIXME additions.
- [x] TypeScript check passes in the touched frontend package; developer build evidence includes both frontend `tsc` checks.
- [x] Architecture and FSD boundaries respected: AppShell composes the Home chat feature through its public API; dashboard uses the shell Outlet callback; no backend or shared-dialog changes.
- [x] API documentation, README, and migration requirements: N/A; no public API, setup command, architecture boundary, or schema changed.
- [x] New component usage documentation: `HomeAsk` is an internal AppShell composition. Its placement and use are documented in `ui-spec.md` and `source-map.md`, and its call site is explicit in `AppShell.tsx`; no separate Storybook story or inline usage comment was added. This is the documented internal-composition exception, not a claim that an inline comment exists.
- [x] Relevant frontend unit tests pass (27/27); the focused Playwright browser check passes (1/1); no relevant test is skipped.
- [x] UI states and responsive behavior match the Task 5.1 spec; task-specific interactive controls expose test IDs; keyboard focus and close/reopen behavior are covered.
- [x] Browser runtime review found no page errors or failed requests. The two 401 resource messages from pre-auth session bootstrap are recorded above and are not presented as a clean-console claim.
- [x] Required browser evidence is linked. Playwright MCP was unavailable, so equivalent Playwright CLI evidence is used; Chrome DevTools MCP is N/A per Task 5.1.
- [x] Developer self-review and required test review are recorded.
- [x] The accepted Low mobile title-wrap debt is recorded in the Tech Debt Log in `../tasks.md`.
- [x] Tester security, performance, usability/accessibility review and final verdict are recorded here.

## Verdict: PASS

## Failure Details (if FAIL)

N/A.
