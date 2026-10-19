# Dev Summary: Task 3.6 Account, Quota, and Demo Administration

## Change History

- 2026-10-19: Implemented the admin portal, owner-scoped Usage, persisted demo policy, and fail-closed AI availability gates. After QA cycle 1 identified campaign rotation, added an atomic server rejection and read-only configured campaign field with focused regression tests.
- 2026-10-19: Added the Task 3.6 OpenAPI paths and DTO schemas plus a focused route/reference contract check for QA cycle 2.

## What Was Implemented

Admins can search and create regular accounts, update daily/lifetime credit and storage limits with CAS revisions, enable/disable users, revoke sessions, reset credentials, edit persisted demo defaults/admission settings, review aggregate demo usage, and see bounded secret-free audit metadata. Server authorization remains authoritative and last-active-admin protection is preserved. Password reset accepts only a new password and does not return it.

The owner Usage page and private-demo banner read the same owner-scoped snapshot. Unknown, paused, or exhausted status disables AI submissions while existing manual task editing remains available. The emergency pause uses the existing global policy and is labeled as applying to all accounts.

Demo TTL and admission thresholds now use persisted policy values after one-time validated bootstrap. Existing demo account limits and existing counters/windows are preserved; unconfigured defaults fail closed for new demo AI allowance. A campaign ID can be initialized once; the policy-locked update rejects later changes or clearing with 409 DEMO_CAMPAIGN_ID_IMMUTABLE, while cap edits continue using the existing ledger. No provider readiness or live model response is claimed.

## Files Changed

### Frontend

- New feature/page/entity code under frontend/src/entities/account-usage/, frontend/src/entities/admin-portal/, frontend/src/pages/usage/, and frontend/src/pages/admin-portal/.
- Owned route and navigation hunks in frontend/src/app/routes.tsx and frontend/src/widgets/app-shell/AppShell.tsx.
- Availability/banner and submission control hunks in frontend/src/widgets/demo-session-route/DemoContentGate.tsx, frontend/src/features/home-chat/ui/HomeChat.tsx, frontend/src/features/ai-run/ui/ChatComposer.tsx, and frontend/src/features/ai-run/ui/AiRunEntry.tsx, plus adjacent focused specs.
- frontend/e2e/task-3-6-admin-usage.spec.ts adds the route-stubbed user journey.

### Backend

- New admin and usage module under backend/src/modules/admin-portal/.
- backend/src/infrastructure/database/repositories/typeorm-admin-portal-repository.ts and its spec; owned persisted-policy and marker hunks in typeorm-demo-admission-repository.ts and typeorm-credit-ledger-repository.ts, with focused specs.
- backend/src/infrastructure/database/migrations/1710000037000-admin-demo-policy.ts adds persisted demo policy, account limit revision/configuration markers, and safe audit metadata.
- backend/test/integration/admin-demo-policy.integration.spec.ts tests actual migration and persisted policy behavior. Existing demo test fixtures explicitly bootstrap persisted settings.
- Task 3.6 hunks only in shared backend/src/app.ts, backend/src/composition-root.ts, and backend/src/infrastructure/database/data-source.ts add admin/usage wiring and migration registration after 0036. backend/openapi.json now documents the Task 3.6 usage/admin routes and DTOs. Its generic ApiError.code string represents DEMO_CAMPAIGN_ID_IMMUTABLE without an enum change. These shared files also contain parallel feature hunks.

### Docs and evidence

- contract.md, ui-spec.md, dev-summary.md, artifacts/validation.md, artifacts/source-map.md, and exact-source-manifest.txt under the canonical Task 3.6 docs folder. backend/src/openapi/admin-portal-openapi.spec.ts validates the added OpenAPI contract.
- artifacts/admin-portal-mock-smoke.png and artifacts/usage-exhausted-mock-smoke.png.

### New API endpoints

- GET /api/v1/admin/accounts and POST /api/v1/admin/accounts
- PATCH /api/v1/admin/accounts/{accountId}/limits and PATCH /api/v1/admin/accounts/{accountId}/status
- POST /api/v1/admin/accounts/{accountId}/password-resets and POST /api/v1/admin/accounts/{accountId}/session-revocations
- GET and PUT /api/v1/admin/demo-settings
- GET /api/v1/admin/audit
- GET /api/v1/account/usage

## Contract Notes

Request/response shapes, validation, CAS revisions, zero versus unlimited behavior, error cases, all-account emergency pause scope, and owner boundaries are in contract.md. Missing accounting or missing demo allowance configuration is unknown/unavailable and fails closed for AI submission. The client never supplies an owner ID for usage.

## Architecture Alignment Notes

Backend code follows the existing auth, credit, storage, and demo repositories/use cases. The module uses authenticated session identity, the existing password hasher and session revoker, policy-first serialization, account-limit CAS, and existing accounting rows. No second settings authority, process-local runtime cache, counter reset, campaign rotation, account role promotion, or new dependency was introduced.

Frontend code uses the existing route shell, shared UI primitives, and one owner Usage entity for both the page and banner. Gates are placed at AI submission controls, leaving manual edits governed by existing storage behavior.

Shared file edits were limited to agreed Task 3.6 hunks. Skills/0035/7.1 and task-delete/0036 hunks remain separately owned. The local staged snapshot contains exactly 49 backend/frontend source and test paths plus the listed docs; no commit or push has occurred.

## Evidence Collected

- artifacts/validation.md records focused Jest, Vitest, TypeScript, Vite, guarded PostgreSQL, and Playwright results, including failed attempts and cleanup.
- artifacts/source-map.md records the owned source areas and exact shared-file ownership boundary.
- Browser screenshots: artifacts/admin-portal-mock-smoke.png and artifacts/usage-exhausted-mock-smoke.png.

## MCP Notes

CUA and Chrome DevTools evidence were unavailable; the authorized Playwright fallback was used with route stubs. Context7 was not used. No external provider calls were made. See validation.md for mock-only limitations and unrelated stubbed 404s.

## Code Review Findings (and resolutions)

- Nullable SQL update parameters were ambiguous to PostgreSQL: added explicit parameter casts and confirmed with the focused integration run.
- OpenAPI now documents the actual owner/admin routes, protected mutation headers, DTO references, CAS/null/zero semantics, and the campaign immutability 409; ApiError.code remains a generic string.
- QA cycle 1 found that ordinary demo-settings edits could switch campaign ledgers. The policy-locked transaction rejects changing or clearing a non-null campaign ID before any mutation; initial null-to-configured setup and same-ID cap edits remain allowed. Read-only UI state mirrors the server rule.
- Usage availability needed to remain authoritative under missing configuration and global pause: unknown fails closed, and the pause UI says it affects every account.
- Settings writes require expectedRevision and account limits require per-account CAS; the UI DTO now includes the expected revision.
- Credential material is never returned or included in audit metadata. Cross-account results are bounded aggregates and omit content/secrets.
- Shared-file overlap with 6.2 and 4.3 was limited to separately owned hunks; see artifacts/source-map.md.

## Test Coverage Summary

Backend Jest: the original 5 focused unit suites/19 tests passed; the post-fix admin repository suite passed 5/5, adding 3 tests for a focused total of 22. The original 1 focused PostgreSQL integration suite/test passed before this no-write guard change. Backend TypeScript passed both before and after the campaign guard change; after the first check was temporarily blocked by in-progress Task 7.1 errors, it passed once those shared edits stabilized. Frontend Vitest: 5 files/43 tests passed before the read-only campaign field edit; frontend TypeScript passed after it. Vite production build passed before the small read-only field change. Playwright route-stub E2E: 1 test passed. The added OpenAPI contract test passed 1 suite / 3 tests, and a direct JSON.parse check passed. The broader suite was not run.

## Known Limitations / Tech Debt

- Browser validation uses route stubs, not a live API; the local journey does not prove production deployment or provider readiness.
- The existing emergency pause intentionally applies to all AI accounts.
- Focused checks cover the owned feature scope; unrelated application startup endpoints returned stubbed 404s during browser smoke.
- Shared files include parallel feature hunks; QA/staging must preserve the ownership map.

## Ready for QA: YES — official cycle 2 PASS; scoped local commit pending.