# QA Report: Confirm baseline and define screen states

## Change History

- 2026-10-19: Independent tester reviewed developer baseline and final designer specification, inspected source callers, captured current-checkout simulated-preview browser evidence and diagnosed the baseline filesystem timeout. No application source edits or commits.

## Scope and evidence limits

This verdict covers Task 1.1 baseline documentation and release screen specification only. It does not certify the implemented release, public HTTPS, live inference, database migration state, account isolation, quotas, or background execution. Task 1.1 expressly requires identifying existing failures; recorded baseline failures do not become newly implemented behavior or waived release gates.

Playwright MCP is absent from callable tool inventory. Equivalent browser evidence uses installed @playwright/test 1.63.0 with installed Chrome. Chrome DevTools and Context7 are N/A for this task. Developer live evidence is unauthenticated local HTTPS login with certificate errors ignored; authenticated owner credentials were unavailable and not guessed. Tester built current checkout with `node node_modules/vite/bin/vite.js build --mode preview --config vite.config.mjs --configLoader runner`, then ran existing Vite preview mode at http://127.0.0.1:5173. Preview APIs are in-memory simulations, prominently labeled in screenshots; they do not verify live persistence/provider behavior. No live owner data was changed, no model was called.

## Test Evidence Reviewed

- [x] Developer typecheck: frontend/backend PASS on Node 22.20.0, pnpm.cmd 11.8.0.
- [x] Developer frontend unit tests: Vitest 57 files / 286 PASS; Node preview API tests 25 PASS.
- [x] Developer backend unit tests: 110 suites / 666 PASS; 1 suite / 1 filesystem test timed out at 5000ms, fully recorded.
- [x] Developer backend integration tests: 13 suites / 63 PASS; 6 suites / 16 guarded PostgreSQL tests SKIP because isolated test database URL unavailable. Skips are unverified, explicitly justified and retained for follow-on identity/persistence tasks.
- [x] Developer boundary checks: 6 PASS / 1 FAIL; NVIDIA-secret expectation mismatches current Hermes-default Compose topology, recorded rather than suppressed.
- [x] Developer frontend E2E evidence: limited real local login desktop/mobile capture. Full journey suite not executed; task baseline equivalent completed independently below. No release E2E PASS is claimed.
- [x] Independent focused serial rerun: `pnpm.cmd exec jest --runInBand --runTestsByPath src/infrastructure/workspace/workspace-mutation-gateway.spec.ts` in backend, process-only pnpm dependency verification disabled, exit 0; 1 suite / 16 tests PASS in 4.84s. No code or timeout edits. Initial full-run failure remains a contention/flakiness observation; full suite not rerun.

Developer self-review and test review are present in dev-summary.md. Its final Ready for QA: YES is explicitly limited to baseline documentation review; application release readiness remains NO. Tester does not override the failed/skipped release checks.

## Functional Acceptance Review

- [x] Existing API conventions/source mapping reviewed: /api/v1, Zod, session/Origin/CSRF, version/idempotency surfaces; no changed API to exercise.
- [x] Every requested release flow maps to existing slices/modules or a clearly proposed new owner in developer map and designer component inventory.
- [x] Archive map spot-checked: global archive POST, project DELETE delegating archive, domain/status/filter shapes, mutation ledger, planning/proposal and undo callers. Workspace archive remains distinct.
- [x] Approval map spot-checked: Home proposal acceptance/execution router, planning handler review_required state, consent gate/use case, Home/AI-run UI. Automatic-path target is explicit and preserves server policy boundaries.
- [x] Release specification covers Home/Ask/history, capture/All tasks, direct task editing/conflicts/delete, login/demo/showcase/expiry, usage/privacy/export, administration/publishing, memory, skills/Plan my day and automations/Run now/history.
- [x] Loading/empty/error/success/disabled states specified globally and per screen; distinguish stale refresh/no matches/unknown outcomes/read-only/quota/session failures.
- [x] All dirty exits in section D: close/Escape/overlay, Cancel, list/breadcrumb/sidebar/workspace navigation, task switch/ID change, Back/Forward/query, signout/session change, hard refresh/tab close/external navigation, forced expiry and background refresh. Native beforeunload limitations are honest. No-op/reverted state, pending save, failed save, conflict and deleted-elsewhere drafts covered.
- [x] Independent seven browser checks PASS: view-first details expose Archive; editor initially focuses title; Tab stays in editor; dirty Escape shows discard AlertDialog; Keep editing retains draft; Discard returns focus to Edit; pristine Escape closes silently.
- [x] No pageerror observed; mobile task detail document/viewport both 375px, no page-wide horizontal overflow in checked fixture.
- [x] Migration/persistence outcomes N/A: no schema/data mutation in baseline; existing migration files and old reports are explicitly not proof of applied state.
- [x] contract.md N/A: no new API/full-stack implementation. Proposed routes/components are not claimed to exist.

## Review Lenses Applied

- [x] Security: no changed endpoint/auth/data behavior; full implementation security review N/A. Confirmed evidence avoids owner credentials/data/provider calls and makes no public trust claims.
- [x] Performance: no changed rendering/query implementation; runtime profiling N/A. Preview build warning is not a performance acceptance measurement.
- [x] Usability and accessibility: applied usability-review, ui-design and accessibility skills; reviewed final spec and desktop/mobile evidence with real keyboard assertions. Contrast/screen reader/zoom measurements remain required implementation evidence, not inferred from source or screenshots.

## Findings Summary

### functional acceptance

No blocking Task 1.1 finding. Baseline filesystem timeout, skipped PostgreSQL suites and Compose boundary mismatch are Medium findings with explicit triage in tasks.md Tech Debt Log. Serial rerun narrows timeout diagnosis without declaring complete suite green. Guarded PostgreSQL evidence must exist before identity/persistence acceptance; deployment boundary mismatch must resolve before release.

### security

No new security behavior implemented. Public certificate trust, live runtime, private namespace isolation, metering, expiry and worker behavior remain downstream acceptance gates. Source inspection is not runtime evidence.

### performance

No changed runtime implementation to gate. Vite production-size warning (~1.18 MB main JS, ~347 KB gzip) is contextual output only; no measured regression or extra optimization task inferred from this baseline.

### usability and accessibility

Medium baseline spacing finding: action row touches task metadata cards; mobile Back to tasks touches Edit/Move/Archive row; preview banner crowds editor title. Logged in tasks.md, with explicit spacing/form corrections in spec sections A/D and follow-on Tasks 5.3/5.4. This is preserved baseline debt, not acceptance of final release layout.

Existing dialog dirty Escape guard works and must be preserved when extending to immediately editable route forms. First exploratory script expected immediate close, failed because actual AlertDialog correctly appeared; corrected independent run verified actual behavior. This was an incorrect exploratory expectation, not a product failure; observation JSON discloses it.

Spec coverage review passes: desktop/modal Ask focus model, two-click visible history, preserved drafts, unassigned task continuity, scope/unknown outcome controls, 24-hour configurable demo expiry semantics via server values, accurate data disclosure, immutable showcase, explicit Save, delete-only tasks, admin zero/unlimited quotas, skill versions and durable schedule/DST/status behavior are specified. Implementation must follow architecture app-level widget composition without creating a new sibling-widget dependency.

## Evidence Index

All task artifact paths below are relative to `.codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/` in the canonical workspace. No MCP execution is claimed.

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| Developer summary | None; source/CLI review | Git, test totals, auth/runtime/deployment limits, archive/approval map | dev-summary.md |
| Baseline command results | None; developer CLI summary, not raw transcript | Checks, exact failures/skips, environment | artifacts/baseline-check-results.txt |
| Original Git status | None; Git CLI | Preserved six dirty/untracked files | artifacts/git-status-before.txt |
| Live login desktop/mobile | None; developer Playwright CLI substitute | Real local unauthenticated responsive baseline | artifacts/live-login-desktop.png; artifacts/live-login-mobile.png |
| Current-checkout fixture Home | None; tester Playwright CLI substitute | Existing Home/capture layout, explicit mock banner | artifacts/qa-fixture-home-desktop.png |
| Fixture detail desktop/mobile | None; tester Playwright CLI substitute | View-first actions, metadata, baseline spacing | artifacts/qa-fixture-task-desktop.png; artifacts/qa-fixture-task-mobile.png |
| Fixture editor keyboard/mobile | None; tester Playwright CLI substitute | Labels, focus ring, editor/viewport layout | artifacts/qa-fixture-edit-keyboard-desktop.png; artifacts/qa-fixture-edit-mobile.png |
| Fixture dirty-exit alert | None; tester Playwright CLI substitute | Alert title/copy, safe initial focus, preserved underlying draft | artifacts/qa-fixture-dirty-exit-mobile.png |
| Browser observations | None; tester Playwright CLI substitute | Seven assertions, errors, mobile width, exploratory correction | artifacts/qa-browser-observations.json |
| Independent command verification | None; tester CLI | Serial Jest result, build, original Git worktree preserved | artifacts/qa-verification.txt |
| Final UI specification | None; designer source/design review | Sections A-J, dirty matrix, responsive/themes/a11y/task mapping | ui-spec.md |
| Source caller spot-checks | None; tester rg/source | Archive/approval/current dirty dialog baseline | Personal-AI-Workspace/backend/src/modules/tasks/{controllers,domain,use-cases}; backend/src/modules/home-assistant/{controllers,use-cases}; frontend/src/features/project-tasks/ui/TaskEditorDialog.tsx |
| Architecture and accepted baseline triage | None; PM/architect documentation | Required scope, code/doc boundaries, downstream owners | .codex/docs/hackathon-release/architecture.md; tasks.md Tech Debt Log |

## Definition of Done Checklist

Applied `.codex/skills/definition-of-done/SKILL.md` with actual package/Zod conventions and Task 1.1's explicit baseline scope.

- [x] Baseline report identifies failures/skips separately; no readiness inferred from old reports.
- [x] UI spec covers every requested screen and dirty exit; layout/focus/labels/responsiveness specified before implementation.
- [x] Architecture and FSD/Clean Architecture ownership respected; source untouched, no new types/debug/TODO/API/schema changes.
- [x] Typecheck passes; applicable existing test evidence reviewed and accurately categorized. No new non-trivial logic requiring new tests. Existing failures remain visible with follow-on triage.
- [x] Developer documentation self-review and required test review recorded; release check failures are not recast as green.
- [x] Required baseline desktop/mobile/keyboard/task-detail evidence supplied with exact unavailable-MCP/authenticated-live limits and equivalent safe fixtures.
- [x] Evidence Index provided; non-blocking Medium baseline findings appear in tasks.md Tech Debt Log with resolution owners/conditions.
- [x] UI implementation/security/performance/migration/provider/deployment DoD are N/A to this documentation baseline and remain mandatory in their owning tasks.
- [x] Original six dirty/untracked app files preserved; tracked stat remains 47 insertions / 19 deletions across four files. Preview build changed ignored dist only. Tester changed no app source, tasks.md, or commits.

## Verdict: PASS

PASS for Task 1.1 baseline and screen specification. Project manager may close its QA gate and coordinate the required reviewed documentation snapshot commit; local commit remains developer responsibility. All requested release implementation and verified runtime gates remain outstanding in their owning tasks.
