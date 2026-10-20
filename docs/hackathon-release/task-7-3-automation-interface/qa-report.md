# QA Report: Task 7.3 - Add schedule controls, Run now, and run history

## Change History

- 2026-10-21: Official QA cycle 1. Reviewed the delivered source, current contract, developer checks, route-stubbed production-preview evidence, and independently reran the two changed existing route/navigation test files.

## Test Evidence Reviewed

- [x] Developer frontend unit tests - Vitest: 3 files, 8 tests passed.
- [x] Independent focused Vitest rerun: routes.spec.tsx and ProjectHeader.spec.tsx, 2 files and 4 tests passed. React Router future-flag notices were the only stderr output.
- [x] Developer frontend typecheck and production build passed.
- [x] Developer frontend E2E - Playwright CLI: 6 of 6 route-stubbed production-preview cases passed in installed Chromium. The required Playwright MCP was unavailable; the task-specific CLI run and retained browser artifacts provide equivalent browser evidence. Fixtures stubbed all API calls, so this does not establish live backend, database, worker, or provider behavior.
- [x] Browser checks reported no uncaught page errors or unexpected console/resource errors. Only the intentionally injected 409 conflict, 422 budget response, and aborted POST used for uncertainty simulation were allowed. The preview process was stopped and the follow-up request was refused.
- [x] Backend unit/integration tests: not applicable; this task changes no backend or database code.

## Functional Acceptance Review

- [x] API behavior verified where applicable: request shapes and client DTO use align with the Task 7.1/7.2 contract and delivered serializers; browser routes are stubbed, so no live API behavior is claimed.
- [x] Business rules and edge cases verified: create/edit, server-backed schedule state, pause/resume, revision conflict with draft preserved, paused Run now without approval, uncertain-request retry using the same payload and idempotency key, unresolved-run blocking/reconciliation, bounded history, result navigation, budget error, and mobile keyboard flow were covered by focused tests and the six browser cases. Workspace scope is immutable on edits, and server ownership, skill eligibility, and expiry checks remain authoritative.
- [x] Error cases verified: invalid time zone focus, load/retry behavior, revision conflict, budget response, and uncertain POST outcome were reviewed in tests and browser evidence. The UI does not treat a queued run as a completed result.
- [x] Migration or persistence outcomes: not applicable to this frontend-only task. Persistence remains owned by Tasks 7.1/7.2 and was not exercised against a live database here.
- [x] contract.md alignment verified: create sends the required schedule fields; update uses the current revision and excludes workspaceId; Run now sends the empty object and preserves its idempotency key across uncertain retries; displayed source and historical usage come from the occurrence projection.

## Review Lenses Applied

- [x] Security review: passed for the changed client flow and API contract. The protected route uses the existing session boundary; the client does not send owner identity or privileged execution data; mutation requests use the existing authenticated/CSRF-protected client; server authorization and validation remain authoritative. No new endpoint, persistence, or external request path was added. Runtime response-header and CORS inspection was unavailable and was not required by this task.
- [x] Performance review: passed. History refresh is limited to schedules with unresolved occurrences, uses bounded occurrence pages, pauses on hidden pages, refreshes on visibility changes, and backs off. No new dependency or unbounded list query was introduced. The build reported a 1.31 MB bundle-size advisory; no baseline or task-specific regression was established, so it is informational rather than a finding.
- [x] Usability and accessibility review: passed for the exercised flows. Labels and semantic controls, visible focus, field-level invalid-zone feedback and focus, keyboard flow, polite non-modal ready notice, and the 390px no-horizontal-overflow screenshot align with the UI spec. This review does not claim a separate screen-reader, 200% zoom, or automated contrast audit.

## Findings Summary

### functional acceptance

No blocking functional findings. The changed UI uses the delivered schedule and occurrence DTOs, preserves user drafts on conflict, and prevents a fresh run while an earlier outcome remains unresolved. Browser evidence is route-stubbed and is not live service proof.

### security

No Critical, High, or Medium findings. The client flow does not weaken the server-owned session, ownership, expiry, skill eligibility, or execution controls. Runtime security headers and CORS were not inspected because no Chrome DevTools MCP was available and the task adds no server surface.

### performance

No blocking finding. The pre-review polling concern is resolved in the current source: only schedules with unresolved history are refreshed on the capped backoff, and hidden pages pause the timer. The build's bundle advisory is recorded above without a demonstrated task regression.

### usability and accessibility

No blocking usability or accessibility finding. The mobile and keyboard evidence covers the requested core flow. Accepted Low checklist debt is recorded in the Task 7.3 Tech Debt Log row at tasks.md:1162: some controls lack data-testid attributes, and new components lack separate usage comments or Storybook stories. Accessible labels/roles and focused interaction tests cover those controls, the feature/page call sites are present, and no functional or accessibility requirement is waived.

## Evidence Index

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| Developer summary | Developer run record | Typecheck, 3-file/8-test Vitest run, build, six browser cases, expected injected errors, preview shutdown, scope and limitations | .codex/docs/hackathon-release/task-7-3-automation-interface/dev-summary.md |
| Contract and UI specification | Repository source | API DTOs, idempotency and revision rules, screen states, keyboard/responsive/accessibility expectations | .codex/docs/hackathon-release/task-7-3-automation-interface/contract.md and ui-spec.md |
| Source manifest and current implementation | Repository source | Changed-file/hunk inventory; polling, mutation payloads, stale-request guards, history and route behavior | .codex/docs/hackathon-release/task-7-3-automation-interface/artifacts/source-manifest.md; Personal-AI-Workspace/frontend/src/features/automation-management/ and entities/automation/ |
| Developer focused frontend specs | Vitest CLI | API, presentation, and management-hook tests; 3 files, 8 tests passed | Personal-AI-Workspace/frontend/src/entities/automation/api/automation-api.spec.ts; src/features/automation-management/model/automation-presentation.spec.ts; src/features/automation-management/model/use-automation-management.spec.tsx |
| Independent focused rerun | Vitest CLI | Changed route and workspace-navigation tests; 2 files, 4 tests passed | .codex/docs/hackathon-release/task-7-3-automation-interface/artifacts/qa-focused-existing-tests.md |
| Browser scenario record and final result | Playwright CLI with installed Chromium; MCP unavailable | Scenario coverage, earlier retained harness attempts, final 6/6 run, expected fixture errors and no unexpected browser errors | .codex/docs/hackathon-release/task-7-3-automation-interface/artifacts/browser/attempt-history.md; artifacts/browser/final/.last-run.json; artifacts/browser/final/vite-preview.stdout.log and vite-preview.stderr.log |
| Browser screenshots | Playwright CLI with installed Chromium; MCP unavailable | Desktop created schedule and mobile keyboard/invalid-zone focus at 390px without horizontal overflow | .codex/docs/hackathon-release/task-7-3-automation-interface/artifacts/browser/final/automation-interface.previ-6e2f3-ocused-IANA-zone-validation/automation-desktop-created.png; artifacts/browser/final/automation-interface.previ-146cd-without-horizontal-overflow/automation-mobile-keyboard-validation.png |
| Task DoD and accepted debt | Repository source | Task 7.3 acceptance, evidence availability and accepted Low checklist debt | .codex/docs/hackathon-release/tasks.md:903-941 and :1162; .codex/skills/definition-of-done/SKILL.md |

## Definition of Done Checklist

- [x] Code quality reviewed: frontend TypeScript checks and production build pass; focused source scan found no unjustified any, TODO/FIXME, console logging, unsafe HTML injection, or eval usage in the changed files.
- [x] Architecture and layer boundaries align with the task contract and frontend structure.
- [x] No new API endpoint or database schema change; README and migration changes are not applicable.
- [~] New public component usage comments or Storybook stories are absent. Accepted as Low checklist debt at tasks.md:1162; the components have actual feature/page callers.
- [x] Non-trivial frontend logic has focused unit coverage; all 5 focused files and 12 tests passed across the developer run and independent rerun. Backend tests and database migration checks are not applicable.
- [x] Required frontend browser flow: six route-stubbed Playwright CLI cases passed; no tests were skipped in the task-specific run. No claim of a live backend/provider run.
- [x] Developer self-review and handoff are recorded; tester functional, security, performance, usability/accessibility reviews are complete.
- [x] Required Playwright MCP was unavailable and the equivalent installed Chromium CLI evidence is linked. Chrome DevTools MCP and Context7 were N/A for this task.
- [~] Not every interactive element exposes data-testid. Accepted as Low checklist debt at tasks.md:1162; accessible labels/roles and focused tests cover interaction.
- [x] UI-spec states and responsive behavior are covered by source review, focused tests, and the six browser scenarios; loading, empty, error, success, conflict, budget, and uncertain transport paths are handled.
- [x] No unexpected browser console/resource errors were reported in the final route-stubbed run.

## Verdict: PASS

No Critical, High, or Medium findings remain. The two accepted Low checklist gaps are logged in the canonical Task 7.3 Tech Debt Log and do not block the requested working flows. This verdict covers the frontend interface against route-stubbed APIs and the delivered contracts; it does not claim live backend, database, worker, or provider verification.

## Failure Details (if FAIL)

Not applicable - PASS.
