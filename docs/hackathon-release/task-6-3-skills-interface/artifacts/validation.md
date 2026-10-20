# Task 6.3 Validation Receipt

## Automated Checks

- Backend Jest, passed: 3 suites / 13 tests.
  node backend/node_modules/jest/bin/jest.js --config backend/jest.config.cjs --runInBand src/modules/home-assistant/controllers/home-conversation-router.spec.ts src/modules/skills/use-cases/list-home-skill-run-summaries.spec.ts src/openapi/home-conversation-openapi.spec.ts
- Frontend Vitest baseline, passed: 4 files / 11 tests.
  node node_modules/vitest/vitest.mjs run --config vitest.config.mjs --configLoader runner src/features/skills/ui/SkillsWorkspace.spec.tsx src/features/showcase-publishing/ui/ShowcasePublisher.spec.tsx src/entities/showcase/api/showcase-api.spec.ts src/pages/workspace-planning-chat/WorkspacePlanningChatPage.spec.tsx
- Post-review affected frontend Vitest, passed: 2 files / 8 tests.
  node node_modules/vitest/vitest.mjs run --config vitest.config.mjs --configLoader runner src/features/skills/ui/SkillsWorkspace.spec.tsx src/features/showcase-publishing/ui/ShowcasePublisher.spec.tsx
- Backend typecheck, passed: node backend/node_modules/typescript/bin/tsc --noEmit -p backend/tsconfig.json.
- Backend typecheck rerun after the summary projection change and integration-fixture assertions, passed with the same command.
- Frontend typecheck, passed after the final UI fixes: node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json.
- Frontend production build, passed before the small reviewed UI-state fixes: node node_modules/vite/bin/vite.js build --config vite.config.mjs --configLoader runner. Vite reported its existing large-chunk warning.
- Scoped git diff --check passed after the final UI changes.

## Mocked Browser Smoke

Installed Playwright with local Chrome exercised the built frontend at 127.0.0.1:5193; all API routes were stubbed and no provider was called. The final run passed:

- Keyboard Enter opened a starter template, saved the edited skill, and started Plan my day.
- A stubbed first invocation returned 503; retry used the same idempotency key and body.
- The saved Home result and exact source label were present after reload.
- Ordinary file-backed planning chat still opened the workspace view.
- Publisher preview included the selected skill; public showcase rendered a read-only skill card.

Earlier browser attempts exposed a project DTO fixture-envelope mismatch, closed details section, wrong checkbox selector, and missing Home/file-backed route stubs. The fixtures/selectors/routes were corrected; the final run completed with zero unexpected API routes and zero page errors. Post-review retry, workspace-switch, and preview-race behavior is covered by the 8 focused Vitest tests; browser/build were not rerun for those UI state fixes.

Screenshots are route-stubbed mock data only:
- task-6-3-skills-desktop.png
- task-6-3-skills-mobile.png
- task-6-3-publisher-preview-desktop.png
- task-6-3-showcase-mobile.png

Preview cleanup receipt: owned PID 36340 is no longer running; port 5193 has no listening socket.

## PostgreSQL Integration

One exact filtered case passed against the approved local PostgreSQL fixture after a focused projection fix. No credentials or connection string were printed.

Command, run from backend:
node node_modules/jest/bin/jest.js --config jest.integration.config.cjs --runInBand --runTestsByPath test/integration/skill-definitions.integration.spec.ts --testNamePattern "persists a managed skill run and reloads its Home summary within the owning account"

Result: 1 suite passed; 1 test passed; 2 tests skipped by the name filter; 0 failures. No other suite ran.

Exact case:
- File: backend/test/integration/skill-definitions.integration.spec.ts
- Test: persists a managed skill run and reloads its Home summary within the owning account
- It creates a workspace skill and a project fact through the repository, selects that fact in persisted project chat context, then invokes through InvokeSkillUseCase and SubmitHomeTurnUseCase with a closed-capability fixture policy and a deterministic in-process runtime. The fake runtime accepts the run and returns one completed assistant result; it does not call the configured placeholder endpoint or any provider. GetHomeTurnUseCase commits the assistant message. A fresh owner-scoped summary query reloads state `accepted` and the exact persisted project-fact revision with label `Workspace priority`; the test checks the revision is a JavaScript number. It also verifies that the other owner cannot read the conversation, turns, or summary.

Attempt history:
- An initial guard invocation failed locally because PowerShell stripped JavaScript quotes from the inline preguard command. It did not connect to PostgreSQL or run Jest.
- First actual PG attempt: same-process preguard passed, then the selected test failed on summary reload because the SQL emitted the captured revision as a JSON string while the summary mapper accepts a number. The suite closed clients and removed its exact isolated database; a fresh independent PowerShell postguard passed.
- The query now uses `source.value->'revision'`, preserving the stored JSON number. The exact same guarded case was rerun and passed with 1 selected test and 2 name-filtered skips; a fresh independent PowerShell postguard then passed. After adding explicit owner/workspace/provider checks to the closed fixture policy, the same case passed once more with the same 1/2 result and another fresh independent postguard pass.

Guard and cleanup:
- Fixture container: pai-task2-1-pg, mapped to loopback port 55441.
- Before each actual test attempt, the same PowerShell process verified base database home_history_test, role home_test, create-database permission, and that the exact skill target home_history_task_6_2_skill_test was absent with zero sessions.
- The unrelated Task 7.1 target home_history_task_7_1_scheduler_test was also absent with zero sessions before and after each actual attempt.
- The suite closed its clients/data source and removed only its exact isolated skill test database through its guarded afterAll; no forced cleanup was used.
- After each actual attempt, a fresh separate PowerShell process confirmed the base identity again, the skill target absent with zero sessions, and the Task 7.1 target still absent with zero sessions.

The isolated temporary guard script was removed after the final attempt. No database credentials, URL, provider response, or source content were printed by the test harness.

## Pre-review Finding Repairs

- Medium retry-payload finding: the first invocation payload is retained with its idempotency key; subsequent retry uses that exact payload even if the editable note changes. A focused test edits the note after an uncertain response and asserts that retry body, conversation, version, and key match the original call.
- Workspace-scope regression: after an uncertain run in workspace A, changing to B clears the conversation ID, creation key, invocation key, pinned request, and previous error together. The new run uses B's conversation, current note, and a distinct key. A changed skill ID/version remounts the dialog; selection is disabled while a request is pending, and unmounted callbacks do not continue or navigate.
- Low preview race: project and item-selection controls are frozen during preview/publication. A deferred-preview test proves the selection cannot change while the request is pending.
- Exact source manifest remains 32 source/test paths; all UI fix and test paths were already listed.
