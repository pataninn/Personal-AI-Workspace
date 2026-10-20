# QA Report: Task 6.4 — Add bounded portable workspace export and usage settings

## Change History

- 2026-10-20 — Official QA1: FAIL on three Medium findings.
- 2026-10-20 — Official QA2: independently reviewed the three repairs and refreshed evidence; reran the focused backend Jest command (5 suites / 25 tests, PASS). Final verdict: PASS with Linux runtime limits documented.

## Test Evidence Reviewed

- [x] Frontend unit tests — Vitest: no separate frontend unit suite was required by this task's evidence plan; UI behavior is covered by the required preview browser flow.
- [x] Backend unit tests — Jest: 5 focused suites / 25 tests passed; independently rerun for QA2.
- [x] Backend integration tests — Jest: 1 isolated PostgreSQL suite / 3 cases passed with clean guards and teardown. Reused from QA1; artifact port is in-memory.
- [x] Frontend E2E — Playwright CLI: 2/2 passed against production preview with API routes stubbed. Reused from QA1.
- [x] Direct filesystem boundary: six tests call ProjectFileGateway.captureForExport against a real bounded Windows temporary tree; all nine gateway tests passed in the focused run.
- [x] Backend typecheck passed after repairs. Frontend typecheck and preview build passed in retained prior evidence; neither was rerun for QA2.
- Linux descriptor pinning, /proc process liveness, and production artifact cleanup were not exercised in a Linux container. No live Linux cleanup claim is made.

## Functional Acceptance Review

- [x] API behavior: retained PostgreSQL evidence verifies owner isolation, non-enumerating foreign/expired/missing results, idempotent replay, active-export limits, cleanup fences, and download headers.
- [x] Business rules and edges: owner/workspace locks, database-clock expiry/replay checks, exact export-ID cleanup, and confirmed-terminal-writer fences are consistent with the contract. A timeout alone does not authorize unlink or purge.
- [x] Error cases: recognized file credentials now produce EXPORT_CONTENT_UNSAFE / 422; the create use case preserves that error. Direct gateway regression coverage passes.
- [x] Migration/persistence: additive migration 0040 has reversible up/down behavior by source review; isolated PostgreSQL lifecycle integration passed.
- [x] Contract alignment: all three QA1 gaps are repaired. Windows-supported file checks are direct; Linux descriptor and platform-specific behavior remain explicitly unproven.

## Review Lenses Applied

- [x] Security: secret handling, path boundaries, protected paths, junction rejection, stable reads, owner fences, cleanup, and download headers reviewed. No open security finding remains within the validated task scope.
- [x] Performance: file/count/byte/document bounds and create deadline reviewed. No load or platform benchmark is claimed.
- [x] Usability/accessibility: desktop Usage states, label, semantic controls, keyboard-operable actions, progress/error copy, and credit/storage content reviewed. Browser evidence is route-stubbed; mobile and live-backend journeys are not claimed.

## Findings Summary

### functional acceptance
The corrected file-secret status, application probe injection, and direct capture tests satisfy the three QA1 findings. Retained PostgreSQL and browser evidence covers the unaffected lifecycle/API and UI surfaces.

### security
The capture boundary returns the documented 422 and fails closed for protected paths, traversal, junctions, changed files, and incomplete enumeration in the Windows fixture. Linux descriptor/no-follow runtime behavior is not claimed and remains documented.

### performance
Configured bounds and deadline remain enforced and are covered by focused tests. No throughput or Linux runtime benchmark was performed.

### usability and accessibility
The reviewed desktop flow follows the UI spec and route-stub browser cases pass. No mobile or live-backend browser validation is claimed.

## QA1 Findings and Resolution

1. **Medium — file credential matches returned 500 instead of 422. Resolved.** The capture helper now throws EXPORT_CONTENT_UNSAFE / 422; create-workspace-export preserves that AppError. A direct file fixture asserts code and status.
2. **Medium — reconciliation use case imported infrastructure. Resolved.** The use case requires the application-owned WorkspaceExportBuilderProbe port; composition-root wiring injects the infrastructure probe.
3. **Medium — direct filesystem proof was missing. Resolved for Windows-supported behavior.** Six tests call captureForExport against a real temporary workspace and cover nested text/binary capture, protected-name omission, recognized-secret rejection, traversal/junction rejection, changed-file and incomplete-directory failure, and bounds/deadline. Linux descriptor pinning, /proc/self/fd, race-resistant O_NOFOLLOW, and non-Windows reparse behavior remain untested.

## Evidence Index

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| Refreshed validation evidence | None; local Jest/TypeScript/PostgreSQL/Playwright CLI | QA2 typecheck/Jest, direct fixture, retained integration/browser/build evidence and limits | [artifacts/validation-evidence.md](artifacts/validation-evidence.md) |
| Direct capture tests | None; Jest on Windows | Six direct captureForExport cases, actual temporary files and junction | Personal-AI-Workspace/backend/src/infrastructure/workspace/project-file-gateway.spec.ts |
| Capture implementation | None; source review | Secret helper, path policy, stable-file checks, Windows test seam, Linux pinned production path | Personal-AI-Workspace/backend/src/infrastructure/workspace/project-file-export-capture.ts; Personal-AI-Workspace/backend/src/infrastructure/workspace/project-file-gateway.ts |
| Probe port and composition wiring | None; source review | Application-owned probe, required use-case injection, infrastructure adapter at composition root | Personal-AI-Workspace/backend/src/modules/workspace-exports/repositories/workspace-export-builder-probe.ts; Personal-AI-Workspace/backend/src/modules/workspace-exports/use-cases/reconcile-workspace-exports.ts; Personal-AI-Workspace/backend/src/composition-root.ts |
| Focused backend Jest rerun | None; Jest | 5 suites / 25 tests, independently rerun for QA2 | From backend: node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/openapi/workspace-export-openapi.spec.ts src/infrastructure/workspace/project-file-gateway.spec.ts src/modules/workspace-exports/use-cases/create-workspace-export.spec.ts src/modules/workspace-exports/use-cases/reconcile-workspace-exports.spec.ts src/infrastructure/workspace-export-process-identity.spec.ts |
| PostgreSQL integration | None; Jest/Supertest and isolated PostgreSQL | Owner isolation, replay, expiry, headers, cleanup fences; in-memory artifact adapter | Personal-AI-Workspace/backend/test/integration/workspace-exports.integration.spec.ts; 1 suite / 3 cases |
| Preview browser flow | None; Playwright CLI | Retry, workspace switch, download, 413/422/429/unavailable, usage cards; API routes stubbed | Personal-AI-Workspace/frontend/e2e/workspace-export.preview.spec.ts; [final screenshot](artifacts/browser/security-final/workspace-export.preview-k-ace33-te-response-after-switching.png) |
| Contract, manifest and UI spec | None; source docs | Acceptance rules, proof plan, ownership, UI states | [contract.md](contract.md); [artifacts/task-source-manifest.md](artifacts/task-source-manifest.md); [ui-spec.md](ui-spec.md) |
| Required MCP evidence | MCP inventory and retained notes | Playwright MCP and Chrome DevTools MCP unavailable; local route-stub Playwright linked, Supertest asserts headers, no live DevTools review claimed; Context7 N/A | Task 6.4 in .codex/docs/hackathon-release/tasks.md; artifacts/validation-evidence.md |

## Definition of Done Checklist

- [x] Backend/frontend typechecks passed; focused QA2 backend suite passed.
- [x] Architecture boundary repaired; application probe port is injected from composition.
- [x] API documented in OpenAPI; focused OpenAPI test passed.
- [x] Migration 0040 reversible by source review.
- [x] Backend unit/OpenAPI, isolated PostgreSQL integration, direct file-boundary tests, and required route-stub browser flow passed.
- [x] Contract error mapping and Windows-supported direct file-boundary evidence verified.
- [x] Developer records code review resolutions and marks Ready for QA; tester lenses and verdict recorded here.
- [x] Required MCP unavailability and equivalent evidence documented; no Context7 lookup required.
- [x] Linux runtime cleanup is not claimed; deployment-specific validation remains for later deployment/release tasks.

## Verdict: PASS
