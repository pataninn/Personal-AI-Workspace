# Dev Summary: Migrate local identity to regular, admin, and demo accounts

## Change History

- 2026-10-19: Implemented identifier-based regular sign-in, legacy owner identity migration, account/session authorization metadata, and account-disable protection.
- 2026-10-19: Closed independent review findings for required frontend principal metadata, OpenAPI whitespace credential documentation, and behavioral validation of a signed legacy session after migration; updated affected fixtures and reran focused checks.

## What Was Implemented

- Added account identifier normalization/validation and account-kind/role/expiry fields to the auth domain. Login requires an identifier and password, normalizes identifier case and whitespace, keeps credential feedback generic, and rejects disabled, demo, passwordless, or wrong-password credentials.
- Added migration `AddAccountIdentity1710000026000`: it preserves existing UUIDs, names, password hashes, user-owned rows, and session rows; maps the legacy `scope_key = local` account to `owner` / `admin`; assigns deterministic identifiers to other legacy rows; and adds constraints for regular versus demo account shapes. Rollback refuses while managed or passwordless accounts exist.
- Made bootstrap idempotent without replacing or reactivating an existing owner. Session lookup returns account role/kind and rejects expired principals as well as expired/revoked sessions. Regular account storage uses a distinct `account:<uuid>` scope key.
- Added atomic account disable persistence with an advisory transaction lock, active-admin actor verification, last-active-admin protection, and session revocation in the same transaction.
- Updated the existing auth routes and OpenAPI schema without changing route, cookie, Origin, CSRF, rate-limit, or response-envelope behavior. The login request is `{ identifier, password }`; unknown fields are rejected. OpenAPI accepts the same whitespace/case variants as the route and documents that passwords must contain a non-whitespace character without trimming password contents.
- Updated the login form and preview auth fixture, added focused login browser coverage, and migrated existing E2E login helpers to submit `owner`.
- Made frontend `LocalPrincipal.accountKind` and `.role` required to match the server/OpenAPI response. Updated affected test fixtures so every authenticated principal has explicit metadata.
- Added post-migration repository and `GetSessionUseCase` assertions proving an existing signed legacy session still restores the same owner principal.

## Files Changed

### Backend

- `backend/openapi.json`
- `backend/src/infrastructure/database/data-source.ts`
- `backend/src/infrastructure/database/migrations/1710000026000-add-account-identity.ts` and `.spec.ts`
- `backend/src/infrastructure/database/repositories/typeorm-auth-repositories.ts`
- `backend/src/modules/auth/controllers/auth-router.ts`
- `backend/src/modules/auth/domain/account-identifier.ts` and `.spec.ts`; `auth-types.ts`
- `backend/src/modules/auth/repositories/user-repository.ts`
- `backend/src/modules/auth/use-cases/auth-use-cases.spec.ts`, `bootstrap-local-user.ts`, `get-session.ts`, and `login.ts`
- `backend/src/openapi/auth-openapi.spec.ts`
- `backend/test/integration/account-identity.integration.spec.ts` and `auth.integration.spec.ts`
- Updated identity-compatible integration fixtures in `backend/test/integration/conversation-fixtures.ts`, `home-consent.integration.spec.ts`, `home-conversation-events.integration.spec.ts`, `home-planning-command-parity.integration.spec.ts`, `home-planning-proposal-execution.integration.spec.ts`, `projects.integration.spec.ts`, `r1-populated-migration.integration.spec.ts`, `r1-release-http-postgres.integration.spec.ts`, and `workspace.integration.spec.ts`.

### Frontend

- `frontend/src/entities/user-session/model/types.ts` and `slice.spec.ts`; `frontend/src/app/providers/AuthProvider.spec.tsx`
- `frontend/src/features/auth/api/auth-api.ts`, `model/messages.ts`, `ui/SignInForm.tsx`, and `ui/SignInForm.spec.tsx`
- `frontend/preview/preview-api.mjs` and `preview-api.test.mjs`; `frontend/playwright.preview.config.ts`
- New `frontend/e2e/login.preview.spec.ts` and `frontend/e2e/pages/login-page.ts`
- Updated login helpers in `frontend/e2e/direct-chat.spec.ts`, `home-chat-preview-test-utils.ts`, `home-summaries-preview-fixtures.ts`, `project-activity.preview.spec.ts`, `project-activity.spec.ts`, `project-chat-security-preview-fixture.ts`, `project-file-history.preview.spec.ts`, `project-memory.spec.ts`, and `project-tasks.spec.ts`.
- The identifier-only helper hunks in `frontend/e2e/task-home.preview.spec.ts`, `frontend/e2e/task-actions.preview.spec.ts`, and `frontend/preview/preview-api.test.mjs` are Task 2.1 dependencies in files that also contain the already-committed Task 5.2 work.
- Required principal metadata fixture updates in `frontend/src/features/conversation-management/ui/CreateConversationDialog.spec.tsx`; `frontend/src/features/ai-run/ui/AiRunEntry.spec.tsx`, `ChatComposer.spec.tsx`, `CommandExecutionSurface.spec.tsx`, and `ProposedChangeReview.spec.tsx`; `frontend/src/features/home-chat/model/use-home-planning-records.spec.tsx` and `ui/HomeChat.spec.tsx`; `frontend/src/features/message-persistence/ui/MessageComposer.spec.tsx`; `frontend/src/features/project-context/ui/ProjectContextSettings.spec.tsx`; `frontend/src/features/project-management/ui/RemoveProjectDialog.spec.tsx`; `frontend/src/features/project-memory/ui/ProjectMemoryManager.spec.tsx`; and `frontend/src/pages/RootlessProjectCapabilityPages.spec.tsx`, `all-tasks/AllTasksPage.spec.tsx`, `dashboard/DashboardPage.spec.tsx`, `project-tasks/ProjectTasksPage.spec.tsx`, `project-workspace/ProjectWorkspacePage.spec.tsx`, `task-detail/TaskDetailPage.spec.tsx`, `workspace-planning-chat/WorkspacePlanningChatPage.spec.tsx`, `frontend/src/widgets/app-shell/AppShell.spec.tsx`, and `frontend/src/widgets/chat-workspace/ChatWorkspace.spec.tsx`.
- Required principal metadata in frontend E2E fixtures: `frontend/e2e/home-summaries-preview-fixtures.ts` and `frontend/e2e/project-chat-security-preview-fixture.ts`.
- The six unrelated files present before implementation remain outside this change manifest and were preserved; no required principal fields were added to those protected AI-run files.

### Shared

- None.

### Docs and evidence

- `.codex/docs/hackathon-release/task-2-1-account-identity/contract.md`
- `.codex/docs/hackathon-release/task-2-1-account-identity/ui-spec.md`
- `.codex/docs/hackathon-release/task-2-1-account-identity/dev-summary.md`
- `.codex/docs/hackathon-release/task-2-1-account-identity/artifacts/git-status-before.txt`
- `.codex/docs/hackathon-release/task-2-1-account-identity/artifacts/qa-postgres-fixture.txt`
- `.codex/docs/hackathon-release/task-2-1-account-identity/artifacts/task-2-1-test-results.txt`
- `.codex/docs/hackathon-release/task-2-1-account-identity/artifacts/login-identifier-success.png`
- `.codex/docs/hackathon-release/task-2-1-account-identity/artifacts/login-generic-credential-error.png`

## Contract Notes

- Login requires an identifier normalized by trim + ASCII lowercase, matching `^[a-z0-9][a-z0-9._-]{2,63}$` after normalization, and a password containing at least one non-whitespace character. Existing owner credentials remain valid with identifier `owner`.
- Successful principal/session envelopes expose required `accountKind` and `role`; the session token remains only in the existing secure HttpOnly cookie.
- Demo-session creation, account-management HTTP endpoints, signup/password reset, and admin UI remain outside Task 2.1.

## Architecture Alignment Notes

- Auth policy and identifier normalization remain in the auth domain/use cases; persistence and concurrency rules remain in TypeORM repositories/migrations; the Express router owns request validation and cookie/header behavior.
- The frontend keeps API interaction in the auth feature and session metadata in the user-session entity. No backend persistence logic was moved into the UI.
- PostgreSQL migration/integration tests use a separate guarded test-only database fixture, never the owner's database.

## Evidence Collected

- `artifacts/task-2-1-test-results.txt`: exact final focused checks and earlier broad regression-run scope, with full versus post-review results distinguished.
- `artifacts/qa-postgres-fixture.txt`: sanitized isolated fixture provisioning/readiness evidence; no URL or password is included.
- `artifacts/login-identifier-success.png` and `artifacts/login-generic-credential-error.png`: preview login success and generic credential-error states with fake credentials only.
- `artifacts/git-status-before.txt`: pre-task shared-worktree baseline used to protect unrelated changes.

## MCP Notes

- Context7 and Chrome DevTools MCP were not available in this environment. The browser flow was run with the repository's Playwright CLI preview configuration and local preview server; screenshots were reviewed directly. No external provider calls were made.

## Code Review Findings (and resolutions)

- Confirmed login uses a strict request schema and generic credential errors, preserving Origin, CSRF, rate-limit, cookie, and session-envelope behavior.
- Fixed the OpenAPI identifier schema to accept the same trimmed/uppercase wire values as the auth route, and added a schema assertion for `  OWNER  `. Documented and tested the route's whitespace-only password rejection.
- Confirmed the migration preserves owner identity/data and blocks unsafe rollback; unit tests cover both managed and passwordless rollback guards. Repository disable is serialized, and the PostgreSQL test covers concurrent cross-disable with exactly two active admins.
- Confirmed session validation accounts for revoked/expired sessions, disabled users, and expired principals. The populated migration test now verifies a preserved signed session through both repository lookup and `GetSessionUseCase`. Frontend principal metadata is required and focused fixture coverage passes.
- No unresolved Task 2.1 self-review findings remain.

## Test Coverage Summary

- Backend full unit run before the final rollback-guard addition: Jest 114 suites / 685 tests passed. Final post-review focused rerun: `pnpm.cmd --dir backend test -- src/openapi/auth-openapi.spec.ts src/modules/auth/use-cases/auth-use-cases.spec.ts src/infrastructure/database/migrations/1710000026000-add-account-identity.spec.ts` passed 3 suites / 20 tests.
- Backend full integration run earlier: Jest 20 suites / 81 tests passed against the isolated PostgreSQL fixture. Final post-review focused rerun `pnpm.cmd --dir backend test:integration -- account-identity.integration.spec.ts r1-populated-migration.integration.spec.ts` passed 2 suites / 3 tests; the focused auth HTTP suite also passed 1 suite / 4 tests in the earlier final rerun.
- Frontend independent `pnpm.cmd --dir frontend run typecheck` passed both tsconfigs after required principal metadata updates.
- Frontend focused Vitest for principal fixtures passed 24 files / 160 tests. The final auth/session target also passed 2 files / 8 tests; only existing React Router v7 future-flag warnings appeared.
- Earlier full frontend regression: Vitest 57 files / 292 tests plus Node preview API 26 tests passed before the final principal type tightening. The separate Node preview API suite passed 26 tests; focused Playwright preview login passed 2 tests covering the required identifier/success payload and generic credential failure.
- `git diff --check`: PASS after final changes.

## Known Limitations / Tech Debt

- Account creation, demo-session issuance, account-management HTTP APIs, and admin UI are intentionally deferred to later tasks. The disable operation is internal persistence capability only.
- Playwright MCP and Chrome DevTools MCP were unavailable; focused browser coverage used Playwright CLI. The full preview E2E suite was not rerun as part of this task.

## Ready for QA: YES
