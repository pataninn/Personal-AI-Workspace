# Dev Summary: Bounded workspace export

## Change History

- 2026-10-20: Implemented bounded portable JSON workspace export, private expiring artifact lifecycle, Usage controls, cleanup fencing, and focused validation.
- 2026-10-20: Addressed pre-review findings by rejecting recognized credential-like text across the complete structured projection and using PostgreSQL `clock_timestamp()` for replay, download, and startup unlink expiry decisions.
- 2026-10-20: Resolved all three QA1 findings: file credential matches now return `422 EXPORT_CONTENT_UNSAFE`, reconciliation uses an injected application probe port, and direct temporary-directory tests exercise `captureForExport` on Windows-supported filesystem paths.
- 2026-10-21: Official QA2 PASS; independent Jest rerun passed 5 suites / 25 tests, and the final staged 48-path backend/frontend TypeScript checks passed.
- 2026-10-21: Added the FSD public export barrel and aligned the existing project-file integration fixture with the required capture port.

## What Was Implemented

Added owner-authorized `POST /api/v1/workspace-exports` and `GET /api/v1/workspace-exports/{exportId}`. Create captures explicit bounded workspace projections plus complete safe file bytes into a private local JSON artifact; download rechecks the active owner/workspace and expiry and sends `no-store`/`nosniff` headers. Exact export IDs join existing project-removal and demo-expiry cleanup barriers. Startup recovery uses PID plus Linux `/proc` start ticks and leaves uncertain writers pending. The Usage page now selects a workspace, prepares, retries, and downloads an export with coherent workspace/body/idempotency state.

The existing secret helper now returns its contract `422 EXPORT_CONTENT_UNSAFE` for both structured data and permitted file bytes. `ReconcileWorkspaceExports` depends on the application-owned builder-probe function type, with the infrastructure probe passed from the composition root. Focused tests call the gateway method against real temporary directories and cover complete text/binary capture, protected paths, secret rejection, traversal, junctions, changed files, incomplete enumeration, and bounds.

## Files Changed

### Backend

- `backend/src/modules/workspace-exports/` — domain contract, repository/artifact ports, create/download/reconcile use cases, router, and focused use-case specs.
- `backend/src/infrastructure/database/migrations/1710000040000-create-workspace-exports.ts` — migration 0040 for metadata and exact cleanup references.
- `backend/src/infrastructure/database/repositories/typeorm-workspace-export-repository.ts` and `.spec.ts` — owner-scoped projection, bounds, lifecycle, idempotency, and DB-clock expiry.
- `backend/src/infrastructure/workspace-export-artifact-store.ts` — private Linux-container artifact adapter.
- `backend/src/infrastructure/workspace-export-process-identity.ts` and `.spec.ts` — conservative PID/start-tick probe.
- `backend/src/modules/workspace-exports/repositories/workspace-export-builder-probe.ts` — application boundary for the narrow process-liveness probe.
- `backend/src/infrastructure/workspace/project-file-gateway.ts`, `project-file-export-capture.ts`, and `project-file-gateway.spec.ts` — complete protected file capture, Linux pinned-reader path, and direct temporary-tree regressions at the existing boundary.
- `backend/src/infrastructure/database/repositories/typeorm-project-removal-repository.ts` and `typeorm-demo-expiry-cleanup-repository.ts` — exact export-ID capture and terminal-writer cleanup fences.
- `backend/src/app.ts`, `backend/src/composition-root.ts`, `backend/src/infrastructure/database/data-source.ts`, `backend/openapi.json`, `backend/src/openapi/workspace-export-openapi.spec.ts`, and `backend/test/integration/workspace-exports.integration.spec.ts` — routes, wiring/startup reconciliation, migration registration, API contract, and integration proof. Shared hunks are itemized in `artifacts/task-source-manifest.md`.

- ackend/test/integration/project-file-actions-review.integration.spec.ts - keeps the existing project-file fixture aligned with the required export-capture port.

### Frontend

- `frontend/src/features/workspace-export/api/workspace-export-api.ts` and `ui/WorkspaceExportPanel.tsx` — typed calls and Usage export flow.
- `frontend/src/pages/usage/UsagePage.tsx` — Usage composition.
- `frontend/e2e/workspace-export.preview.spec.ts` and `frontend/playwright.preview.config.ts` — two route-stubbed production-preview cases.

- rontend/src/features/workspace-export/index.ts - FSD public export consumed by UsagePage.

### Docs and task snapshot

- `contract.md`, `dev-summary.md`, `artifacts/validation-evidence.md`, and `artifacts/task-source-manifest.md` in this task folder.
- `docs/hackathon-release/tasks.md` is a byte-for-byte copy of the canonical tracker; SHA-256 was verified.
- The task-specific snapshot under `docs/hackathon-release/task-6-4-workspace-export/` contains the contract/preflight/UI/pre-review docs and browser evidence artifacts.

## Contract Notes

The JSON v1 projection includes all current task rows (legacy archived records were normalized by migration 0036), active facts/context, workspace-scoped project and Home transcripts, workspace skills/schedule definitions, and permitted files. Structured or permitted file content matching the existing bounded `containsPotentialSecret` helper fails the whole create with `422 EXPORT_CONTENT_UNSAFE`; content is not rewritten or partially dropped. The helper does not identify arbitrary user-entered secrets. PostgreSQL time decides replay, active-ready counts, publication expiry, download expiry, and whether startup cleanup may unlink an expired artifact.

## Architecture Alignment Notes

The feature stays in a focused FSD slice and `/usage` entry. Backend responsibilities remain in the `workspace-exports` Clean Architecture module, TypeORM repository, private artifact adapter, and existing workspace file gateway. The reconciliation use case depends on an application-owned probe port; the composition root injects its infrastructure implementation. It adds no import/archive flow, generic job framework, settings framework, or ledger/storage accounting changes. Migration 0040 follows sibling Task 7.2 migration 0039. Shared `composition-root.ts`, `data-source.ts`, and `openapi.json` hunks preserve Task 7.2 work; see the manifest.

## Evidence Collected

- `artifacts/browser/security-final/workspace-export.preview-k-ace33-te-response-after-switching.png` — final ready/download Usage state after workspace switch.
- `artifacts/browser/test-results/task-6-4-workspace-export/` — retained initial browser assertion failure context, screenshot, and trace; the assertion was corrected and the exact two-case spec passed afterward.
- `artifacts/validation-evidence.md` — exact commands, counts, successful guards/teardown, and sanitized earlier failed-attempt history.
- Backend TypeScript check passed; frontend TypeScript check passed.
- Final staged-index TypeScript checks passed: from backend, `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --pretty false`; from frontend, the same app command and `node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit --pretty false`. Snapshot was generated from the Git index; Task 7.3 working-only automation files were absent.
- Final index scope: 48 paths (35 source, 12 task docs/evidence, 1 full tracker). All 12 canonical/app task files matched SHA-256; tracker SHA-256: 14021B31F73FEBBC11CF6867C19EAF0043242CBA42235AF6B580118367BD0E19.
- QA1 repair check: backend TypeScript passed; focused Jest passed 5 suites / 25 tests, including all 9 tests in `project-file-gateway.spec.ts` (6 directly exercise `captureForExport`). The fixture exercised the actual capture method on Windows with a real temporary workspace and a Windows junction.
- Earlier focused Jest: 5 suites / 19 tests passed before QA1 repair, including process liveness, safe cleanup, structured-secret rejection, DB-clock replay/download/unlink decisions, and OpenAPI contract assertions.
- Isolated PostgreSQL integration: 1 suite / 3 tests passed against only `home_history_task_6_4_workspace_exports_test`; same-process preguard, normal owned-database teardown, and fresh separate-process postguard passed.
- Production-preview Playwright: 2 / 2 route-stubbed cases passed, including uncertain retry/workspace switch/late response, 413, 422 key rotation, 429, and unavailable download.
- Preview build passed with existing Radix directive and large-chunk warnings.

## MCP Notes

No Context7 or Chrome DevTools MCP evidence was needed or available. The browser evidence came from the installed Playwright CLI against a local production preview with all API routes stubbed. PostgreSQL ran only through the approved isolated local fixture; artifact bytes used an in-memory test adapter.

## Code Review Findings (and resolutions)

The bounded pre-review found structured secrets bypassing the file-only helper and expiry decisions using the API host clock. QA1 found a file-secret status mismatch, an inward dependency violation, and missing direct gateway tests. Structured and file content now fail closed with the same `422`; reconciliation receives its process probe from composition; direct gateway tests cover portable enumeration and failure paths. Replay/download use PostgreSQL time, and startup unlink requires a successful DB-clock conditional expiry update. Exact-ID cleanup remains behind existing owner/project barriers and terminal-builder checks; a timeout never proves a writer stopped.

## Test Coverage Summary

Runner evidence: Jest (backend unit/OpenAPI and isolated integration), TypeScript direct compiler binaries, Vite production preview build, and Playwright CLI (E2E). Exact commands and limits are in `artifacts/validation-evidence.md`. The full repository suite was not run; tests stayed within the approved Task 6.4 scope.

## Known Limitations / Tech Debt

The Windows temporary-tree fixture exercises the gateway's portable test filesystem seam, including a real junction, but does not prove Linux descriptor pinning, `/proc/self/fd`, or race-resistant `O_NOFOLLOW`. The production artifact/process boundary remains Linux `/proc` plus a local private temp directory and was not exercised on Linux. PostgreSQL integration used an in-memory artifact port, and browser APIs were route-stubbed. Recognized-secret detection is limited to the existing helper's known patterns. Database and filesystem capture are separately timestamped, not an atomic cross-resource snapshot.

## Ready for QA: YES
