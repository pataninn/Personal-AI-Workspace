# Self-review: Floating Home Ask panel

## Summary

The change keeps Home assistant state at the persistent authenticated shell boundary and reuses the existing Home chat feature. FSD boundaries remain intact: AppShell composes the feature public API, the feature owns Home conversation state, and Dashboard communicates through a narrow shell Outlet callback.

## Findings

**[BLOCKING] None.**

**[SUGGESTION]** The first browser run found stale aria-hidden state on the Ask launcher after Escape closed a nested modal history menu. The history menu now uses nonmodal focus management within the Ask dialog. The final Playwright journey passes and confirms focus returns to the launcher.

**[SUGGESTION]** The mobile title wraps across lines at narrow width. The sheet bounds and no-horizontal-scroll assertions pass; the remaining wrap is low visual debt.

## Architecture, policy, and data review

- Home scope is explicit and the current assistant execution policy remains the authority for enabling AI submission.
- Existing runtime-unavailable behavior disables the composer and preserves its draft. Manual task/workspace controls remain available.
- Principal-keyed HomeChat remount clears draft, history selection, and in-flight client state when account identity changes. Session data is not persisted to browser storage.
- Closing the dialog unmounts its view DOM but not the HomeChat controller or its effects, preserving selected conversation and active run state.
- No backend, API, migration, permission, policy, dependency, or shared Dialog changes were made.
- No console.log or debug statements remain in source.

## Validation reviewed

- Focused Vitest: 27/27 tests passed.
- Frontend build with both TypeScript checks: passed after the final source changes.
- Synthetic Playwright desktop/mobile journey: passed after the final source changes.
- git diff --check: clean for Task 5.1 source files.
- No Chrome DevTools MCP was exposed. Playwright artifacts are retained and do not claim live provider coverage.

## Verdict: APPROVED FOR INDEPENDENT QA
