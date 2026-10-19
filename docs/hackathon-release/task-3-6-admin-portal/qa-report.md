# QA Report: Account, Quota, and Demo Administration (Task 3.6)

## Change History

- 2026-10-19, QA cycle 1: FAIL. A configured campaign ID could be changed or cleared by an ordinary settings edit, switching the active budget to a fresh ledger.
- 2026-10-19, QA cycle 2: Rechecked the locked repository guard, initial-configuration path, same-ID cap edits, regression tests, and new OpenAPI contract. Cycle 1 finding is resolved; no application files changed by QA.

## Test Evidence Reviewed

- [x] Developer backend unit tests - Original focused set: 5 suites / 19 tests passed. After the repair, the admin repository suite passed 5 / 5 tests.
- [x] Developer frontend unit tests - 5 files / 43 tests passed before the configured campaign field became read-only. Frontend TypeScript passed after that UI change.
- [x] Developer backend integration tests - Actual PostgreSQL migration/policy test: 1 suite / 1 test passed before the no-write guard change. The guard did not alter schema, migration, or database write behavior, so the scoped integration proof is reused.
- [x] Developer frontend E2E tests - Playwright CLI fallback: 1 route-stubbed journey passed before the read-only field change. This demonstrates the mock journey only, not live API integration, deployment, or provider readiness.
- [x] Vite production build passed before the small read-only field change; the change has no build-system or shared runtime effect. Existing Radix directive and large-bundle notices were non-blocking.
- [x] Independent focused rerun after the repair: Jest ran `typeorm-admin-portal-repository.spec.ts` and `admin-portal-openapi.spec.ts`; 2 suites / 8 tests passed.
- [x] Backend and frontend TypeScript checks passed after the campaign guard/UI update. Backend check had initially been interrupted by in-progress Task 7.1 errors, which later cleared; no Task 3.6 source was implicated.

## Functional Acceptance Review

- [x] API behavior reviewed: active regular-admin authorization, same-origin and CSRF guards on mutations, session-derived usage owner, strict request validation, and no-store sensitive reads.
- [x] Business rules and edge cases: zero versus unlimited and CAS behavior, fail-closed demo setup, all-account pause, owner-scoped usage, preserved current ledger/counters, immutable configured campaign ID, initial ID configuration from null, and same-ID cap edits verified through source and focused tests.
- [x] Error cases reviewed: unauthorized admin denial, validation errors, stale revisions, unavailable demo policy, and the 409 `DEMO_CAMPAIGN_ID_IMMUTABLE` response.
- [x] Migration and persistence outcomes verified by the prior guarded PostgreSQL integration test. The legacy demo values and usage windows are retained; bootstrap is one-time and does not overwrite an already bootstrapped policy.
- [x] Contract alignment: campaign identity is now read-only after initialization in the UI and immutable at the policy-locked repository boundary. OpenAPI documents the Task 3.6 routes, DTOs, auth/CSRF requirements, CAS/null/zero semantics, and the new 409 error.

## Review Lenses Applied

- [x] Security review: admin-only authorization, CSRF/origin checks, owner scoping, password hashing, secret-free responses/audits, and session revocation reviewed. Chrome DevTools MCP was unavailable; source and focused tests provide the recorded substitute, not runtime network inspection.
- [x] Performance review: focused repository/query paths reviewed; no material issue found. No live load or browser performance profile was run.
- [x] Usability and accessibility review: unavailable/exhausted/paused messaging, manual edit availability, visible labels, focus-managed dialogs, semantic status announcements, and the explained read-only campaign field reviewed. The route-stub browser evidence does not exercise mobile or keyboard-only layouts; those checks remain an evidence limitation.

## Findings Summary

### functional acceptance

- **Resolved from QA cycle 1:** `updateDemoSettings` locks the persisted policy, validates the active admin and expected revision, then returns 409 `DEMO_CAMPAIGN_ID_IMMUTABLE` if an already configured campaign ID would change or clear. This happens before policy update, audit insertion, or counter reads. Initial null-to-configured setup remains allowed. Same-ID cap edits continue to return the existing campaign's settled/reserved usage and do not update/delete counters or reservations. The new focused tests cover changed ID, cleared ID, initial configuration, and unchanged usage. No blocking functional finding remains.

### security

- Admin enforcement is checked at router and transactional repository boundaries. Owner Usage derives its owner from the authenticated principal. Passwords are hashed and neither returned nor written to audit metadata. No unresolved security finding.

### performance

- No material issue found in the focused review. Live load and runtime profiling were outside the recorded evidence scope.

### usability and accessibility

- The route-stub journey demonstrates exhausted Usage, disabled Ask, and usable manual task edits. Mobile and keyboard-only browser checks were not run; no claim is made that those specific checks passed. CUA was unavailable and the approved local Playwright fallback uses route stubs.

## Evidence Index

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| QA cycle 1 finding history | N/A | Original official FAIL and resolved campaign-identity finding | This report, Change History and Findings Summary |
| Developer validation record | Playwright CLI fallback; Jest; Vitest; TypeScript; Vite; guarded PostgreSQL | Original focused tests, browser/build/PG evidence, campaign repair, OpenAPI docs, and their limitations | `artifacts/validation.md` |
| Developer implementation summary | N/A | Campaign guard behavior, no migration/write-path change, evidence totals and scope | `dev-summary.md` |
| Campaign identity contract | N/A | Null-to-initial configuration; stable configured ID; 409 error | `contract.md`, Scope and Validation/Error Cases |
| Campaign UI behavior | N/A | Configured ID becomes read-only and explains same-ledger cap edits | `ui-spec.md`, Admin portal; `Personal-AI-Workspace/frontend/src/pages/admin-portal/AdminPortalPage.tsx:250` |
| Repository guard and regression tests | Jest | Guard ordering, changed/cleared rejection with no writes/audit/counter mutation, initial setup, same-ID ledger retention | `Personal-AI-Workspace/backend/src/infrastructure/database/repositories/typeorm-admin-portal-repository.ts:207`; `.../typeorm-admin-portal-repository.spec.ts:33` |
| Independent targeted rerun | Jest CLI | Repository and OpenAPI suites, 2 suites / 8 tests passed after repair | `Personal-AI-Workspace/backend`: `node node_modules/jest/bin/jest.js --runInBand src/infrastructure/database/repositories/typeorm-admin-portal-repository.spec.ts src/openapi/admin-portal-openapi.spec.ts` |
| OpenAPI contract and focused test | Jest | All usage/admin paths, request/response DTO refs, protected mutations, 409 error and campaign semantics | `Personal-AI-Workspace/backend/openapi.json`; `Personal-AI-Workspace/backend/src/openapi/admin-portal-openapi.spec.ts` |
| Route-stub browser journey and screenshots | Playwright CLI fallback; no MCP | Account create, zero daily limit, secret non-echo, exhausted Usage, disabled Ask, manual task edit; visible states | `Personal-AI-Workspace/frontend/e2e/task-3-6-admin-usage.spec.ts`; `artifacts/admin-portal-mock-smoke.png`; `artifacts/usage-exhausted-mock-smoke.png` |
| MCP/tooling note | N/A | CUA and Chrome DevTools unavailability, mock-route boundary, no provider calls | `artifacts/validation.md`, Tooling / evidence notes and Browser smoke |

## Definition of Done Checklist

- [x] Focused backend/frontend tests and TypeScript checks passed; focused post-fix backend and OpenAPI tests passed.
- [x] Actual focused PostgreSQL integration proof is available with final database identity and cleanup guards documented; no new PG run was needed for the no-write guard.
- [x] Playwright CLI fallback passed and CUA/route-stub limitations are explicit.
- [x] Security, performance, usability, and accessibility lenses applied; runtime DevTools, live API, provider, mobile, and keyboard-only evidence limits are stated.
- [x] New API routes and DTOs are documented in OpenAPI; migration and source artifacts are present; developer self-review and test review are recorded.
- [x] Implementation aligns with the Task 3.6 contract and architecture, including campaign identity stability.
- [x] Tester final verdict: PASS.

## Verdict: PASS