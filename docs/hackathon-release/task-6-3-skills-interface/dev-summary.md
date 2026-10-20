# Dev Summary: Task 6.3 — Expose editable skills and a working Plan my day flow

## Change History

- 2026-10-19: Full-stack contract completed before implementation.
- 2026-10-20: Skills workspace, managed Plan my day flow, durable Home run summary, publisher selection, and public skill cards implemented.
- 2026-10-20: Resolved all three independent source/evidence pre-review findings and completed the original mocked browser and PostgreSQL evidence before official QA cycle 1.
- 2026-10-20: Official QA cycle 1 found a Medium evidence gap in successful managed-run persistence. The existing filtered PostgreSQL case now uses a deterministic local runtime, persists a completed assistant result and selected project fact, and reloads the exact source label/revision. The summary query now preserves numeric JSON revisions.

## What Was Implemented

- Added an authenticated workspace Skills page for listing, creating, editing, copying starter templates, enabling/disabling, deleting with version checks, and running saved skills.
- Plan my day uses the existing invocation/Home conversation flow, preserves the original request with its idempotency key for uncertain retries, and opens its persisted result at the selected Home conversation route. File-backed planning-chat without a selected conversation continues to open the ordinary workspace view.
- Added an owner-scoped read projection on existing Home turn list/get responses. It returns only skill title/version/state and source kind/revision/label; labels resolve against the captured source revision and otherwise remain unavailable. The Home UI reloads these details and links to aggregate Usage.
- Preserved project-fact source revisions as JSON numbers in the repository summary projection, matching the validated response DTO and the numeric persisted invocation revisions.
- Added skill selection to the existing publisher preview and read-only skill cards to the public showcase. The existing sanitized skillIds allowlist remains the publication boundary.
- No migration, new dependency, provider integration, credit-ledger change, or fabricated historical usage was added.

## Files Changed

The exact 32 application and test paths are listed in exact-source-manifest.txt. The shared backend/openapi.json and backend/src/composition-root.ts files also contain separate concurrent Task 7.1 hunks; the manifest records each path once and only the Task 6.3 ownership is described here. The integration test addition is a single new case in the existing skill-definition fixture.

New response projection: optional skillRun on GET /api/v1/home/conversations/{conversationId}/turns and GET /api/v1/home/conversations/{conversationId}/turns/{turnId}. New UI route: /projects/{projectId}/skills.

## Contract Notes

- The turn summary contains title, skillVersion, state, and sources[{kind, revision, label}]. It exposes no skill/source identifiers or captured content.
- Summary reads require the authenticated owner, conversation, and turn to match. Unresolved/deleted historical sources keep a null label.
- Skills CRUD, invocation, Home conversation persistence, quota policy, and showcase publication continue through existing APIs and use cases.

## Architecture Alignment Notes

- Frontend API/types remain in entities; the workspace editor/run flow is in features/skills; page composition and routes remain in pages/app.
- Summary construction is a read-only skills use case over the invocation repository and is serialized by the existing Home router. No scheduler fence, cleanup barrier, or managed-workspace ownership predicate was changed by this task.
- Public showcase cards are display-only. Editing and running stay in the authenticated workspace.

## Evidence Collected

- Focused backend and frontend unit tests, typechecks, production build, mocked browser smoke, and the single guarded PostgreSQL integration case passed; exact commands and counts are in artifacts/validation.md.
- Mocked Playwright smoke covered keyboard template creation/edit/run, same-key retry after a stubbed 503, persisted Home result reload, ordinary managed chat, publisher preview, and read-only public cards.
- Screenshots: artifacts/task-6-3-skills-desktop.png, artifacts/task-6-3-skills-mobile.png, artifacts/task-6-3-publisher-preview-desktop.png, artifacts/task-6-3-showcase-mobile.png.
- All browser API calls were route-stubbed; no live provider behavior is claimed.
- PostgreSQL test passed with a guarded local fixture. A closed-capability test policy and injected deterministic runtime accepted the Home turn and completed it with a saved assistant message; the fixture runtime makes no provider call. The persisted invocation records the selected project fact revision, and the reloaded summary resolves that exact database revision to “Workspace priority.” Foreign-owner conversation, turn, and summary reads remain denied.
- Preview cleanup: owned preview PID 36340 is absent and port 5193 has no listener.

## MCP Notes

- Chrome DevTools MCP/CUA was unavailable. Installed Playwright with local Chrome was used instead.
- No Context7 lookup was needed; no external library behavior or dependency changed.

## Code Review Findings (and resolutions)

- Owner filtering is applied in the repository query and again at the conversation/turn use-case boundary. The router only serializes summaries keyed to turns returned by that owner-scoped page.
- Source labels resolve only to the exact persisted revision; unavailable sources do not fall back to current content. The DTO contains no source IDs or content.
- The initial successful-run proof exposed that the summary SQL emitted source revisions as JSON strings while its mapper expected numbers. The one-token query change preserves the persisted JSON numeric value; the same filtered PostgreSQL case now checks a numeric revision and its exact source label.
- Medium retry finding: the first invocation payload stays pinned to its idempotency key. Editing the note after an uncertain reply cannot change the retry body. Changing workspace resets the conversation ID, creation key, invocation key, pinned payload, and prior error together. A changed skill ID/version remounts the dialog; workspace selection is disabled during an active request; unmounted callbacks cannot start later work or navigate.
- Low preview finding: project and item-selection controls are disabled while preview or publication is in flight, keeping the exact preview selection stable.
- Public cards use the already-sanitized published snapshot and expose no edit/run actions.
- The shared working tree contains Task 7.1, Task 5.3, and other task edits. Those hunks are excluded from the Task 6.3 source manifest and remain untouched.

## Test Coverage Summary

- Backend Jest unit/API checks: 3 focused suites, 13 tests passed; covers Home turn serialization, summary projection/use case, and OpenAPI contract.
- Frontend Vitest baseline: 4 focused files, 11 tests passed. Post-review focused rerun: SkillsWorkspace and ShowcasePublisher, 2 files / 8 tests passed, including the pinned retry, workspace A-to-B lifecycle, and frozen-preview regressions.
- Backend and frontend TypeScript checks passed. Frontend Vite production build passed with the existing large-chunk warning.
- Filtered PostgreSQL integration after the evidence repair: the exact case passed twice, each run selecting 1 test and skipping 2 by testNamePattern. The earlier accepted-run attempt failed at the summary projection because of the string/number mismatch; its separate fresh-process postguard passed. Every actual run had an independent clean postguard. No other suite was selected.
- Mocked Playwright smoke passed after correcting fixture envelope, selectors, and routes in earlier attempts; the failures and final scope are recorded in artifacts/validation.md.
- Scoped git diff --check passed after the reviewed UI changes.

## Known Limitations / Tech Debt

- No live provider was called. The PostgreSQL case runs the actual skill, SubmitHomeTurn, GetHomeTurn, Home persistence, and summary projection with a deterministic local runtime and a persisted selected fact; this verifies the successful local path without making a provider-readiness claim.
- Browser evidence uses mocked API routes and proves client behavior only; it does not prove live provider execution.
- Minor mobile/keyboard evidence is limited to the representative mocked browser journey; the specific screenshots and scope are recorded in the validation artifact.

## Ready for QA: YES
