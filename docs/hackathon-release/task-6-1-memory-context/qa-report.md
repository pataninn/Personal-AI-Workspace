# QA Report: Task 6.1 — Make memory and selected context visibly control future runs

## Change History

- 2026-10-19: Independent focused QA of the Task 6.1 contract, source, tests, guarded PostgreSQL evidence, and synthetic browser artifacts. Issued PASS with two accepted Low items in the task Tech Debt Log.
- File created in this QA work: `.codex/docs/hackathon-release/task-6-1-memory-context/qa-report.md`.

## Test Evidence Reviewed

- [x] Developer frontend unit tests — Vitest: independently reran the two focused files; 15/15 tests passed.
- [x] Developer backend unit tests — Jest: independently reran the three focused suites; 26/26 tests passed.
- [x] Developer backend integration tests — Jest: reviewed the guarded PostgreSQL planning-only selection case and its pre-test and fresh-process post-test base-identity/zero-target guards. The isolated case passed; it was not repeated in QA because the recorded guarded run covers the required persistence boundary.
- [x] Developer frontend E2E tests — Playwright: reviewed the passing one-test synthetic preview journey, screenshots, and browser evidence record. No live provider is claimed.

Independent commands and results:

- `node node_modules/jest/bin/jest.js --config jest.config.cjs --runInBand src/modules/ai-runs/use-cases/project-chat-context-use-cases.spec.ts src/modules/home-assistant/domain/home-planning-context.spec.ts src/modules/home-assistant/use-cases/submit-home-turn.spec.ts` — 3 suites, 26 tests passed.
- `node node_modules/jest/bin/jest.js --config jest.config.cjs --runInBand src/modules/ai-runs/use-cases/send-chat-message-use-case.spec.ts` — 1 existing file-backed chat suite, 4 tests passed; this confirms current persisted fact filtering remains intact.
- `node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit` from `Personal-AI-Workspace/backend` — passed.
- `pnpm.cmd exec vitest run --config vitest.config.mjs --configLoader runner src/features/project-memory/ui/ProjectMemoryManager.spec.tsx src/features/project-context/ui/ProjectContextSettings.spec.tsx` from `Personal-AI-Workspace/frontend` — 2 files, 15 tests passed.
- `pnpm.cmd typecheck` from `Personal-AI-Workspace/frontend` — passed.

The developer also recorded a passing Vite preview build and the selected-case PostgreSQL result in `artifacts/verification.md`. The optional standalone strict TypeScript check for the E2E spec reports two existing TS2540 errors in the imported `home-chat-preview-fixtures.ts` helper; the new spec had no diagnostics and the Playwright journey ran successfully. This optional check is not reported as passing.

## Functional Acceptance Review

- [x] API behavior verified: existing fact and project chat-context APIs are reused; no endpoint or DTO was added. Focused use-case tests verify owner/project scoping, planning-only reads, and file-root denials.
- [x] Business rules and edge cases verified: fresh workspace-scoped Home turns read selected active facts using the persisted conversation scope; global Home does not inherit route facts; current stored workspace policy must include `project_facts`; file access stays separate. The guarded PostgreSQL case verifies current fact values after edit, exclusion and deletion, foreign-owner denial, and that no file gateway is used.
- [x] Error cases verified: unavailable or changed memory fails closed before runtime start; policy revisions are rechecked; idempotent replay does not reread memory or restart runtime. UI tests cover selection reconciliation, edit conflicts, draft retention, and confirmed deletion.
- [x] Migration or persistence outcomes verified: no migration was introduced. The existing `project_chat_context.fact_ids` persistence was verified by the guarded PostgreSQL case.
- [x] `contract.md` alignment verified: Home context is a bounded, redacted one-turn prompt snapshot revalidated at the send boundary. It is intentionally not a durable Home manifest. Existing routes, request/response shapes, policy categories, and file-backed run manifests remain unchanged.

## Review Lenses Applied

- [x] Security review
- [x] Performance review
- [x] Usability and accessibility review

## Findings Summary

### functional acceptance

PASS. Production source binds Home memory to the owner and workspace ID from the persisted conversation, and the reader uses current selected active facts. Tests cover memory inclusion, category denial, changed-snapshot no-send, read failure, replay, bounded/redacted prompt construction, and planning-only file denial. Fresh Home memory stays in the immediate prompt snapshot and is not persisted as a manifest, as the approved preflight specifies.

### security

PASS. Foreign facts cannot be selected through owner/project-scoped reads. A workspace policy that omits `project_facts` skips the reader. The planning-only reader avoids file inventory and file operations. Selected values are redacted and bounded, are absent from transcript/event/error copy, and stale values fail closed before runtime start. No new client owner, fact, provider, or policy fields were added.

Playwright MCP and Chrome DevTools MCP were not available in this session. The permitted CLI/browser equivalent is documented: the synthetic Playwright run records the persisted workspace scope and no provider/bridge requests; focused backend tests inspect the bounded prompt passed to a synthetic runtime, including redaction and policy-denial behavior. No live-provider network claim is made. Browser evidence records two pre-login 401 session-check messages and one request-failed event for the synthetic DELETE; the awaited DELETE returned 204 and the fact was absent after reload. There were no uncaught page errors.

### performance

PASS. Fact count is capped at 25, fact content at 4,096 UTF-8 bytes, and the complete rendered Home prompt at 256 KiB. The Home reader performs a bounded selected-fact read and a final current-value recheck without file inventory or per-fact query fan-out. No new dependency or large client payload was added. The preview build warning about an existing large chunk is recorded by the developer and is unrelated to this change.

### usability and accessibility

PASS with accepted Low test-selector debt. The Memory screen reuses the existing policy disclosure and fact attribution, shows future-versus-past effects, and keeps selection state and uncertain saves explicit. The inspected controls use visible labels, native checkbox semantics, live status/error feedback, duplicate-action disabling, and existing Radix Dialog/AlertDialog wrappers. The 390px screenshot has no horizontal overflow. Two task-owned controls/reconciliation paths do not have `data-testid` attributes; accessible labels/roles and focused unit/browser journeys verify the flows. This Low checklist exception is recorded in the task Tech Debt Log; it does not waive a functional or accessibility requirement. A separate screen-reader or 200% zoom matrix was not run in this focused review.

## Evidence Index

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| Task brief and required evidence | N/A — repository documentation | Acceptance criteria and required browser evidence | `.codex/docs/hackathon-release/tasks.md` → Task 6.1 |
| UI, contract, architecture preflight, and source map | N/A — repository documentation | UI states, existing API contract, Home scope/policy rules, ownership boundaries | `.codex/docs/hackathon-release/task-6-1-memory-context/ui-spec.md`; `contract.md`; `architecture-preflight.md`; `source-map.md` |
| Source manifest and developer review | N/A — repository documentation | Changed source/test inventory and developer-authored test review | `.codex/docs/hackathon-release/task-6-1-memory-context/exact-source-manifest.md`; `dev-summary.md` |
| Focused backend Jest runs | N/A — local Jest CLI | Planning-only Home path, prompt bounds/redaction, policy gating/revalidation/replay, existing file-backed fact filtering | `project-chat-context-use-cases.spec.ts`; `home-planning-context.spec.ts`; `submit-home-turn.spec.ts` — 3 suites/26 tests; `send-chat-message-use-case.spec.ts` — 1 suite/4 tests |
| Backend typecheck | N/A — local TypeScript CLI | Backend compile/type safety | `Personal-AI-Workspace/backend/tsconfig.json` — passed |
| Focused frontend Vitest and typecheck | N/A — local Vitest/TypeScript CLI | Memory/context UI behavior and app type safety | `ProjectMemoryManager.spec.tsx`; `ProjectContextSettings.spec.tsx` — 15 tests; frontend `pnpm.cmd typecheck` passed |
| Guarded PostgreSQL selection case | N/A — local Jest/PostgreSQL harness | Persisted planning-only selected facts, edit/exclude/delete, owner isolation, file gateway denial | `Personal-AI-Workspace/backend/test/integration/project-fact-storage-quota.integration.spec.ts` → “persists planning-only selection…”; guard evidence in `artifacts/verification.md` |
| Synthetic Playwright preview journey | Playwright CLI equivalent; Playwright MCP unavailable | Planning-only disclosure, fact create/select/edit, fresh workspace conversation, exclusion/deletion, blocked external requests | `Personal-AI-Workspace/frontend/e2e/memory-context.preview.spec.ts`; run details in `artifacts/verification.md` |
| Mobile Memory screenshot | Playwright CLI equivalent; Playwright MCP unavailable | 390px planning-only disclosure, memory controls, source attribution, no horizontal overflow | `.codex/docs/hackathon-release/task-6-1-memory-context/artifacts/task-6-1-planning-memory-mobile.png` |
| Fresh planning chat screenshot | Playwright CLI equivalent; Playwright MCP unavailable | Workspace-scoped Home chat and provider/storage disclosure in synthetic preview | `.codex/docs/hackathon-release/task-6-1-memory-context/artifacts/task-6-1-fresh-planning-chat-selected-memory.png` |
| QA verification and test limits | N/A — sanitized local artifact | Guarded PG result, browser telemetry caveats, no live-provider claim, MCP availability | `.codex/docs/hackathon-release/task-6-1-memory-context/artifacts/verification.md` |
| Accepted Low follow-up items | N/A — repository documentation | Selector exception and manifest wording | `.codex/docs/hackathon-release/tasks.md` → Tech Debt Log |

## Definition of Done Checklist

- [x] Code follows project standards; focused source review found no `any`, `console.log`, or untracked TODO in the reviewed task-owned changes; developer self-review is PASS.
- [x] TypeScript checks pass in the touched frontend and backend packages.
- [x] No commented-out code or unresolved layer-boundary issue was found in the reviewed changes.
- [x] Implementation aligns with the release architecture and Task 6.1 preflight; no circular dependency was found in the reviewed Home reader boundary.
- [x] Public API/OpenAPI documentation unchanged because no public endpoint or DTO was added; README setup instructions unchanged.
- [x] No schema change; migration is not applicable.
- [x] Required focused frontend/backend unit tests pass; selected PostgreSQL integration evidence passes; synthetic Playwright journey passes.
- [x] Developer code self-review and required test review are recorded as PASS.
- [x] Required MCP evidence is either supplied as the documented Playwright CLI/browser equivalent or explicitly explained as unavailable. No Context7 lookup was needed.
- [x] UI matches the reviewed spec for core screens/states, storage/provider disclosure, future-versus-past copy, and planning-only file boundaries. Loading, empty, error, success, and uncertain-save states are implemented.
- [x] Responsive behavior is supported by the 390px screenshot and no-horizontal-overflow assertion. Semantic labels, keyboard-operable native controls, live feedback, and Radix dialog wrappers were verified by source and focused tests.
- [x] No uncaught browser page errors were recorded. The pre-login 401 and synthetic DELETE telemetry caveats are documented above.
- [ ] All interactive elements have `data-testid` attributes. Accepted Low exception: reused fact inclusion and selection reconciliation controls lack selectors; accessible labels/roles and focused browser/unit journeys verify them. This item is recorded in the Tech Debt Log and does not block this PASS.
- [x] Existing API validation/error handling and no-secret handling are preserved; backend acceptance covers fail-closed errors.
- [x] Security, performance, usability/accessibility, and final tester verdict are recorded.

## Verdict: PASS

## Failure Details (if FAIL)

N/A. The accepted Low test-selector and source-manifest wording items are recorded in the task Tech Debt Log. No Critical, High, or Medium finding remains open.
