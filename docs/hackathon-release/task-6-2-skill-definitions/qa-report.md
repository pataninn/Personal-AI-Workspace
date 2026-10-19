# QA Report: Task 6.2 — Persist editable user skills with bounded invocation

## Change History

- 2026-10-19: Completed focused QA and created this report. Tester-authored file: `.codex/docs/hackathon-release/task-6-2-skill-definitions/qa-report.md`.

## Test Evidence Reviewed

- [x] Developer frontend unit tests — Vitest: independently reran the showcase API normalizer and publisher compatibility specs; 2 files, 2 tests passed.
- [x] Developer backend unit tests — Jest: independently ran 16 relevant skill, repository, Home, accounting, showcase, and OpenAPI suites. The first run passed 15 suites (87 tests) and exposed one stale Home turn SQL-parameter expectation. After the developer updated that test expectation to include the new nullable invocation marker, the affected suite passed 15/15. The implementation was unchanged by that repair; every selected suite has a passing run.
- [x] Developer backend integration tests — Jest: reviewed the guarded PostgreSQL receipt. The skills integration suite passed 2 tests; the specifically filtered pinned-skill copy case passed 1 test, with 4 unrelated cases intentionally skipped by the exact name filter. The receipt records clean preguards and separate-process postguards for all five actual attempts.
- [x] Developer frontend E2E tests — Playwright: not applicable. Task 6.2 declares Playwright N/A and leaves the skill editor, picker, and public skill cards to Task 6.3.
- Backend TypeScript check: independently ran `node node_modules/typescript/bin/tsc --noEmit` from `Personal-AI-Workspace/backend`; passed.
- Frontend TypeScript checks: independently ran both app and node projects from `Personal-AI-Workspace/frontend`; passed after the concurrent Task 3.6 DTO correction.

## Functional Acceptance Review

- [x] API behavior verified: the skill router tests and source review cover authenticated ownership, strict request parsing, templates, CRUD, status/error mapping, and invocation requests.
- [x] Business rules and edge cases verified: selected unit and integration evidence covers owner isolation, immutable version history, compare-and-swap updates, no-op updates, idempotency and tombstones, current skill checks, replay without a second runtime start, workspace scope, capability intersection, and retained revision quota accounting.
- [x] Error cases verified: malformed/unknown fields, missing or foreign resources, stale versions, reused idempotency keys, deleted or disabled sources, and missing invocation bindings are handled in the focused suites or guarded integration evidence.
- [x] Migration or persistence outcomes verified: the guarded PostgreSQL receipt confirms migration 0035 was applied and its registered migration count matched. Workspace deletion follows delivered 0027 cascade semantics and releases skill revision content. The pinned showcase copy creates private generated skill IDs and version-1 revisions from the sanitized snapshot.
- [x] `contract.md` alignment verified, with one accepted Low edge case listed in the task Tech Debt Log: title validation counts UTF-16 code units, so astral characters reach the 120-character cap earlier than the contract/database code-point count.

## Review Lenses Applied

- [x] Security review: applicable; reviewed authenticated routes, owner-scoped data access, validation, invocation binding, and tool gates.
- [x] Performance review: applicable to the added persistence queries and bounded content; reviewed relevant query paths, indexes, request/context limits, and focused tests. No runtime profile was required by the task.
- [x] Usability and accessibility review: no new user-facing skill UI is in scope. The existing publisher sends an empty skill selection for compatibility; visible skill editing and selection belong to Task 6.3.

## Findings Summary

### functional acceptance

PASS for the Task 6.2 contract. Skill definitions retain immutable revisions, invocation requests bind the trusted revision and permitted context before Home runtime start, retries do not start a second turn, current policy remains authoritative, and workspace removal preserves existing purge behavior. The initial focused Jest failure was a test expectation missing the new nullable `skill_invocation_id`; the corrected test passed on rerun.

Accepted Low finding: JavaScript string length counts UTF-16 code units while the documented title limit counts Unicode code points. The user-priority exception is recorded in `.codex/docs/hackathon-release/tasks.md` under Tech Debt Log; strict bounds and authorization checks remain in place.

### security

PASS. The router derives the owner from the authenticated session, validates strict request shapes, and applies same-origin/CSRF checks to mutations. Repository reads and writes carry owner scope. Skill text cannot supply a provider, owner, workspace, or capability set; only the closed Home capability list is accepted. Invocation binding is trusted server-side, checked before runtime start, and rechecked with current persisted skill and policy state at tool dispatch. Missing or mismatched bound sources fail closed. No Critical or High findings remain.

### performance

PASS for this scope. Revision text, request size, declared tools, and context revision count are bounded; lookup paths are owner-scoped and use the migration's unique/search indexes. No rendering path or large client dataset changed. Runtime load and query-plan profiling were outside the task's declared evidence requirements.

### usability and accessibility

Not applicable to new UI: Task 6.2 adds no skill editor, picker, or public skill card. Focused publisher compatibility tests pass, and Task 6.3 owns browser validation for the visible skill flow.

## Evidence Index

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| Task plan and architecture | N/A — task declares no MCP inputs | Acceptance scope; Playwright, Chrome DevTools, and Context7 are explicitly N/A | [tasks.md](../tasks.md), Task 6.2; [architecture.md](../architecture.md), section 8 |
| Contract | N/A — source review | API shapes, validation, ownership, invocation, deletion, and compatibility requirements | [contract.md](contract.md) |
| Verification receipt | N/A — guarded PostgreSQL/Jest evidence, not an MCP | Migration application, skill CRUD/quota/purge, sanitized pinned clone, preguards and postguards | [verification-receipt.md](artifacts/verification-receipt.md) |
| Source/hunk manifest and source map | N/A — source references | Task-owned implementation seams and shared-file ownership boundaries | [source-hunk-manifest.md](artifacts/source-hunk-manifest.md), [source-map.md](source-map.md) |
| Backend focused Jest suites | N/A — Jest | Router, validation, use cases, TypeORM skill/invocation/showcase repositories, storage accounting, project removal, Home turn binding/tool gates, showcase use cases, and OpenAPI | `Personal-AI-Workspace/backend/src/modules/skills/{controllers/skill-router,domain/skill-validation,use-cases/skill-use-cases,use-cases/invoke-skill}.spec.ts`; `backend/src/infrastructure/database/repositories/{typeorm-skill-repository,typeorm-skill-invocation-repository,typeorm-home-conversation-repository,home-conversation-persistence-mappers,typeorm-project-removal-repository,typeorm-showcase-repository,typeorm-demo-showcase-copy-manager}.spec.ts`; `backend/src/infrastructure/database/storage-content-accounting.spec.ts`; `backend/src/modules/home-assistant/use-cases/{submit-home-turn,home-planning-tool-request-handler}.spec.ts`; `backend/src/modules/showcases/use-cases/showcase-use-cases.spec.ts`; `backend/src/openapi/showcase-openapi.spec.ts` |
| Corrected Home persistence suite | N/A — Jest | Nullable invocation marker is included for ordinary Home turn inserts | `Personal-AI-Workspace/backend/src/infrastructure/database/repositories/typeorm-home-conversation-repository.spec.ts`; 1 suite, 15 tests passed on rerun |
| Frontend compatibility suites | N/A — Vitest | Older showcase DTO normalization and empty `skillIds` publisher request | `Personal-AI-Workspace/frontend/src/entities/showcase/api/showcase-api.spec.ts`; `frontend/src/features/showcase-publishing/ui/ShowcasePublisher.spec.tsx`; 2 files, 2 tests passed |
| TypeScript checks | N/A — local TypeScript compiler | Both touched packages type-check | Backend `tsc --noEmit`; frontend `tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.node.json --noEmit` |

## Definition of Done Checklist

- [x] Code follows project standards; developer self-review reports no unresolved Task 6.2 code finding.
- [x] TypeScript checks pass in both touched packages.
- [x] No task-level type-safety, debug logging, or architecture blocker was found in the reviewed implementation.
- [x] Implementation follows release architecture and preserves module/layer boundaries.
- [x] Skill endpoints and showcase skill DTO fields are documented in OpenAPI; parsing and focused OpenAPI checks passed.
- [x] README/setup updates are not needed; no setup or architecture instructions changed.
- [x] No new frontend components were added; usage comment/Storybook and UI-state requirements are not applicable.
- [x] Schema change includes migration 0035 with `up` and a data-preserving `down` that refuses to drop persisted skill data.
- [x] Relevant non-trivial backend and frontend behavior has focused unit coverage; the selected focused suites pass after the one-line test expectation correction.
- [x] Guarded PostgreSQL integration evidence passes for the skill CRUD/purge and pinned-copy cases.
- [x] Frontend E2E is not applicable to this backend/DTO compatibility task; Task 6.2 declares Playwright N/A.
- [x] Filtered integration skips are explained in the receipt; no unexplained skipped tests were found in the reviewed evidence.
- [x] Developer code self-review and test evidence are recorded in [dev-summary.md](dev-summary.md).
- [x] MCP inputs/evidence match `tasks.md`; all three MCPs are declared N/A for this task, and this report indexes the local evidence.
- [x] Browser console, responsive, keyboard, and interactive-element checks are not applicable because no user-facing skill UI changed.
- [x] Security and performance lenses passed; usability/accessibility UI lens is not applicable for this task.

## Verdict: PASS
