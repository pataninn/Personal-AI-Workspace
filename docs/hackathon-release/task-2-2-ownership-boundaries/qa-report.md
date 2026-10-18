# QA Report: Enforce ownership across APIs, tools, storage, and streams

## Change History

- 2026-10-19: Independent QA review completed. The initial review found missing managed-storage Compose wiring and stale setup/API docs; the developer added the overlay, README preflight, path-free OpenAPI schemas, and focused assertions before this verdict.
- 2026-10-19: An earlier isolated PostgreSQL run exposed a dispatch after expiry had committed. The database-clock active predicate was corrected; the final broad integration run and independent focused rerun passed.

## Test Evidence Reviewed

- [x] Developer frontend unit tests — Vitest, 15 files / 79 tests; preview API 26 / 26; preview build passed.
- [x] Developer backend unit tests — Jest, 117 suites / 709 tests.
- [x] Developer backend integration tests — Jest, isolated PostgreSQL 22 suites / 88 tests; real-router HTTP ownership 1 suite / 3 tests.
- [x] Developer frontend E2E tests — Playwright CLI preview 1 / 1; independent QA rerun 1 / 1. Playwright MCP was unavailable and the CLI equivalent is documented.
- [x] Backend and frontend TypeScript checks passed; final `git diff --check` passed.
- [x] Independent QA focused checks: PostgreSQL 2 suites / 5 tests; principal authorization/auth 2 suites / 20 tests; OpenAPI/config 2 suites / 18 tests; managed-storage Compose boundary 1 / 1.
- [x] Docker Compose parsed the base file plus managed-storage overlay with `config --quiet`; no container was started.

## Functional Acceptance Review

- [x] API behavior verified through the real Express route stack with two synthetic principals. Foreign and missing project, file, task, and run-event IDs have indistinguishable denials; admin role does not widen project/file access.
- [x] Business rules and edge cases verified: immutable legacy-owner mapping, composite owner/project constraints, server-generated managed roots, planning-only behavior without a managed mount, and session/account checks at stream and tool boundaries.
- [x] Error cases verified, including generic unavailable-storage behavior and suppression of proposals/private output when database expiry commits before a gated runtime resumes.
- [x] Migration/persistence verified against guarded disposable PostgreSQL databases. The populated migration preserves the legacy owner mapping/data/session continuity; fresh migration and composite constraints pass.
- [x] Contract alignment verified. Project DTOs and create/root-attachment request schemas omit caller-selected paths; root attachment has an empty object body. OpenAPI contains no `relativeRoot` field.
- Managed storage has an explicit overlay requiring an existing host directory and identity, binding only to `/account-workspaces` with `create_host_path: false`. README documents the marker and host-root preflight. Actual deployment source, physical disjointness, and persistence remain for Task 8.1.

## Review Lenses Applied

- [x] Security review.
- [x] Performance review.
- [x] Usability and accessibility review.

## Findings Summary

### functional acceptance

No blocking finding remains. The frontend journey removes root selection, preserves entered state after the synthetic 503, and gates file views by capability. Backend HTTP and PostgreSQL tests cover ownership, migration, late expiry, tool dispatch, and persistence boundaries.

### security

No Critical or High finding remains. Production Hermes and Home tool paths reload persisted owner/project/run scope and recheck account activity. SSE rechecks the exact opening session and account. The existing Medium Compose boundary-suite issue is tracked in the release Tech Debt Log: its NVIDIA-key assertion disagrees with the Hermes-default topology (7 / 8 tests pass); the new managed-storage test and actual Compose parse pass.

### performance

No blocking concern found. Account-row locks cover bounded durable operations and are not held across provider inference. No throughput benchmark or live-provider run was part of this task.

### usability and accessibility

The tested form has no root-path field, labeled keyboard-selectable workspace modes, focus and error handling, and mobile layouts without horizontal overflow at 375px. Five desktop/mobile screenshots were inspected. Browser evidence uses an in-memory preview API and synthetic 503; it does not prove backend allocation or live storage. Browser console telemetry was not separately collected.

## Evidence Index

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| Final developer test results | Jest / Vitest / Playwright CLI | Typechecks, backend 117/709, PostgreSQL 22/88, HTTP 1/3, frontend tests/build/E2E, evidence limits | `artifacts/test-results-backend-final.txt` |
| QA focused PostgreSQL rerun | Jest CLI with guarded loopback fixture | Expiry-before-release and composite ownership, 2 suites / 5 tests; no app DB or credentials recorded | `artifacts/qa-postgres-focused-rerun.txt` |
| QA auth/use-case run | Jest CLI | Principal authorization and auth cases, 2 suites / 20 tests | `artifacts/qa-auth-focused-rerun.txt` |
| HTTP ownership run | Jest/Supertest | Real Express routes, two principals, temp filesystem, foreign/missing resource behavior | `artifacts/test-ownership-http-run.md` |
| UI evidence and independent review | Playwright CLI and screenshot inspection | Preview journey, keyboard/mobile states, 5 screenshots; mock-only limits | `artifacts/qa-ui-independent-review.md`, `ui-dev-notes.md`, `artifacts/ui-*.png` |
| Final API/config check | Independent Jest CLI, `node --test`, `rg`, `git diff --check`, Docker Compose CLI | Path-free OpenAPI, required overlay variables/bind, config parse; no service started | `artifacts/qa-final-contract-check.txt`, `artifacts/config-contract-final.txt`, `backend/src/openapi/project-planning-openapi.spec.ts`, `scripts/compose-boundary-check.test.mjs` |
| Ownership contract and architecture | Source/document review | Legacy root binding, account/project isolation, dispatch ordering, no atomic check-to-send claim | `contract.md`, `../architecture.md` §5.1 |
| Production ownership paths | Source review and backend tests | Workspace boundary, persisted principal checks, Hermes/Home tools, SSE exact-session checks | `backend/src/infrastructure/workspace/`, `backend/src/infrastructure/hermes/hermes-project-task-tools.ts`, `backend/src/modules/home-assistant/use-cases/home-planning-tool-request-handler.ts`, `backend/src/modules/ai-runs/controllers/ai-run-chat-router.ts` |
| Developer source manifest | Git/worktree review | Task-owned source paths; original six unrelated AI-run/ponytail changes excluded | `artifacts/source-manifest.txt` |

Playwright MCP and Chrome DevTools MCP were unavailable; the CLI browser journey is the documented Playwright equivalent, and Chrome DevTools is marked N/A in `tasks.md`. Context7 was not needed because no new library behavior or dependency was introduced. No provider call or real deployment mount was tested.

## Definition of Done Checklist

- [x] Code review/self-review evidence is present; TypeScript typechecks pass in backend and frontend; final diff check passes.
- [x] Implementation follows the ownership and storage architecture; no blocking layer-boundary issue found.
- [x] Setup and public API documentation updated in README, Compose overlay, and OpenAPI.
- [x] Ownership migration includes `up`/`down` and guarded persistence tests.
- [x] Required backend/frontend unit and integration tests pass; no guarded PostgreSQL tests were skipped.
- [x] Required browser journey passes through Playwright CLI; MCP unavailability is documented and equivalent browser evidence is indexed.
- [x] Security, performance, usability, and accessibility review lenses completed.
- [x] Medium Compose assertion issue is already logged in `tasks.md` Tech Debt Log and does not break managed-storage acceptance.
- [x] Evidence Index included; deployment-host verification is explicitly reserved for Task 8.1.

## Verdict: PASS
