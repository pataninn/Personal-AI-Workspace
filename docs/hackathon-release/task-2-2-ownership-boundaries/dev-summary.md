# Dev Summary: Ownership Boundaries

## Change History

- 2026-10-19: Implemented account-scoped project, file, tool, run-event and late-output boundaries; added managed project storage and migration guards; completed frontend capability updates and final validation.

## What Was Implemented

- Added optional managed storage at fixed `/account-workspaces`, with server-generated account/project subdirectories, mount identity checks and no fallback to `/workspace`. New file-backed projects use managed storage for all accounts. Existing bootstrap-owner roots remain mapped beneath `/workspace`.
- Added `compose.managed-storage.yaml` as explicit optional wiring for the fixed mount and identity marker, with host-source creation disabled. The README documents the marker and host-root preflight; base Compose remains usable without the overlay.
- Updated project creation and legacy root attachment to allocate roots on the server. `POST /api/v1/projects` accepts project data and `workspaceMode`; the public project DTO exposes `workspaceMode` and `capabilities`, never a root path or storage namespace. A missing/unverified managed mount returns generic retryable `503 WORKSPACE_STORAGE_UNAVAILABLE`; planning-only projects remain available.
- Added a guarded migration for fresh empty databases and populated legacy mapping. It binds reserved legacy storage to immutable local account identity, blocks reassignment, tracks project/run storage kind and adds composite owner/project relationship constraints. Populated ambiguous non-owner roots fail closed; existing files and authenticated sessions are preserved.
- Added reusable persisted-principal checks for long-running work and short durable side-effect windows. TypeORM expiry checks use database time. Runtime output, proposals, events, messages and task suggestions are suppressed after an inactive principal is observed; private SSE delivery is closed on either account invalidation or connected-session revocation/expiry. Existing cancellation, cleanup and reconciliation state can still be written.
- Hardened project-scoped access across routes, repositories, task/memory contexts, Home planning tools, Hermes project tools and workspace file operations. File operations retain containment, canonical path and symlink/reparse checks; mutation promotion rechecks authorization in its transaction and runs bounded recovery/reconciliation when interrupted.
- Updated the project creation and workspace UI to remove caller-visible root selection, show the managed storage mode and gate file features with `capabilities.fileAccess`, while retaining planning/task/memory assistance for planning-only workspaces.

## Files Changed

- Backend: project and auth use cases, repository interfaces and TypeORM adapters, workspace and staging gateways, AI-run dispatch/output/event handling, Home and Hermes tool handling, composition/configuration, migration, OpenAPI schema, and integration/unit tests. The complete path list is in [`artifacts/source-manifest.txt`](artifacts/source-manifest.txt).
- Frontend: project API/types, creation form and validation, capability-gated project navigation/pages, preview fixtures/API, and related tests/E2E journeys. The complete path list is in [`artifacts/source-manifest.txt`](artifacts/source-manifest.txt); the UI ownership manifest and command details are in [`ui-dev-notes.md`](ui-dev-notes.md).
- Compose/docs: `compose.managed-storage.yaml`, `README.md`, and the focused boundary test in `scripts/compose-boundary-check.test.mjs`.
- Shared task docs/evidence: `contract.md`, `ui-spec.md`, `ui-dev-notes.md`, `ownership-test-notes.md`, and artifacts listed in the Evidence Collected section.
- Preserved unrelated work: the original six AI-run/ponytail files are excluded from the task source manifest and were not included in this implementation summary.

## Contract Notes

- Project creation: `POST /api/v1/projects` accepts `{ name, objective?, workspaceMode? }`; `workspaceMode` is `file_backed` (default) or `planning`. Caller-supplied `relativeRoot` and other path fields are rejected.
- Root attachment: `PATCH /api/v1/projects/:projectId/root-attachment` has no path field; allocation is server-managed.
- Project responses include `workspaceMode` and `capabilities: { planning, fileAccess }`. They omit `relativeRoot`, host path, storage kind, and namespace.
- Foreign and missing resources keep indistinguishable not-found behavior. Managed-storage unavailability uses a generic retryable `WORKSPACE_STORAGE_UNAVAILABLE` response.
- Dispatch ordering: the persisted active-principal check using the database clock is the admission boundary. If disablement/expiry commits before that check, the next direct-provider fetch or Hermes bridge creation is suppressed. If the guard succeeds first, that particular external send is considered in flight; the implementation does not claim atomic check-to-send serialization. Later dispatches and durable outputs recheck. Account locks are not held across provider inference.

## Architecture Alignment Notes

- Backend authorization remains in use cases/repository policies with TypeORM and filesystem behavior behind repository/gateway interfaces.
- `/workspace` stays reserved for the immutable legacy owner identity; new projects for every account resolve beneath `/account-workspaces/<account-uuid>/projects/<project-uuid>`. No public DTO or UI exposes those paths.
- The managed mount is optional deployment wiring. Missing configuration disables managed file capability without affecting planning-only work or valid legacy-owner projects. There is no path fallback or implicit root creation.
- `compose.managed-storage.yaml` requires an explicit existing host directory and marker identity and mounts them only at `/account-workspaces`; the README preflight checks that the host roots are ordinary disjoint directories. Compose parsing confirms the overlay is structurally valid, but it does not attest the physical host source.
- Short account locks are used only at bounded durable mutation boundaries and reuse their transaction context; locks are not held during inference. If promotion is revoked midway, trusted bounded restoration/reconciliation may complete, but the interrupted change is not reported as successful or promoted further.
- A live SSE stream is tied to the exact opening session and account. Revoking a browser session closes that stream; it does not by itself cancel a persisted background job whose authority is the stored run/account, which rechecks account status at its own boundaries.

## Evidence Collected

- [`artifacts/test-results-backend-final.txt`](artifacts/test-results-backend-final.txt): backend/frontend test counts, commands, and evidence limits.
- [`artifacts/config-contract-final.txt`](artifacts/config-contract-final.txt): final OpenAPI/config, Compose overlay, typecheck, and diff validation.
- [`artifacts/qa-postgres-focused-rerun.txt`](artifacts/qa-postgres-focused-rerun.txt): independent isolated expiry and composite ownership rerun, 2 suites / 5 tests PASS.
- [`artifacts/test-ownership-http-run.md`](artifacts/test-ownership-http-run.md): real-router HTTP ownership checks, 1 suite / 3 tests PASS.
- [`artifacts/qa-ui-independent-review.md`](artifacts/qa-ui-independent-review.md): independent UI/browser preview check and screenshot review.
- [`ui-dev-notes.md`](ui-dev-notes.md): frontend test commands, preview journey and screenshots.
- [`artifacts/source-manifest.txt`](artifacts/source-manifest.txt): complete app source file list for this task.
- The isolated PostgreSQL fixture URL and credentials are omitted; the fixture is restricted to local test use. No owner database was used.

## MCP Notes

- Context7 was not needed: this change uses the repository's existing TypeScript, Express, TypeORM, Jest, Vitest and Playwright patterns without new dependencies or external framework behavior.
- Chrome DevTools MCP and Playwright MCP were unavailable. The repository's Playwright CLI preview journey and screenshots were used and independently reviewed. They prove frontend behavior only.
- No provider calls were made. The provider-dependent direct-chat E2E was updated to the path-free API contract but not run.

## Code Review Findings (and resolutions)

- Corrected the managed-root attachment SQL parameter numbering so the storage kind, owner ID, project ID and version bind to their intended placeholders; the owner-scoped repository test covers the resulting layout.
- Changed persisted expiry authorization to use PostgreSQL `now()` rather than application/DB clock comparison. The real-PostgreSQL expiry-before-runtime-release test now verifies the tool proposal and subsequent private output are suppressed.
- Reviewed lock composition: the account transaction is reused by its activity predicate and bounded callback; nested repositories do not acquire another connection while the lock is held. No account lock spans inference.
- `git diff --check` is clean. No linting tools or new infrastructure were added.

## Test Coverage Summary

- Backend typecheck passed.
- Backend Jest unit suite: 117 suites / 709 tests passed.
- Backend PostgreSQL integration suite: 22 suites / 88 tests passed using the guarded disposable fixture.
- QA focused PostgreSQL rerun: populated migration/expiry and composite ownership, 2 suites / 5 tests passed.
- Backend Supertest real-router HTTP ownership: 1 suite / 3 tests passed with temporary filesystem gateway.
- Final OpenAPI/config Jest checks: 3 suites / 19 tests passed; final backend typecheck and `git diff --check` passed. The managed-storage Compose boundary subtest passed 1/1, and QA confirmed `docker compose ... config --quiet` accepts the overlay.
- Frontend typecheck passed; focused Vitest 15 files / 79 tests passed; preview API 26 / 26; preview build passed; Playwright preview 1 / 1 passed. Independent QA also passed 2 Vitest files / 17 tests and Playwright preview 1 / 1.
- Runners: Jest for backend unit/integration, Vitest for frontend unit tests, Node test runner for preview API tests, Playwright CLI for browser preview.

## Known Limitations / Tech Debt

- This checkout does not prove Docker's actual managed host bind source, mount disjointness, or deployment persistence/read-only settings. The deployment verification task must inspect the configured Compose mount and host paths.
- The full Compose boundary test file still has one pre-existing NVIDIA environment assertion failure against the current Hermes default. The new managed-storage boundary test and Compose parser check pass; the unrelated assertion is documented and unchanged.
- The frontend preview API and intercepted 503 are synthetic; they do not prove backend allocation or mount behavior.
- The workspace tool adapter currently has no production HTTP call site; no security claim depends on that unused adapter. Current Home/Hermes tool paths and file/run boundaries are covered by backend tests.
- Direct-chat with a live provider was not run, and no provider call was made.

## Ready for QA: YES
