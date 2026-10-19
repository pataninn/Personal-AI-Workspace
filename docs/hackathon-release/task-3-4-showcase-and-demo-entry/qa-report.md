# QA Report: Task 3.4 — Protected showcase and one-click private demo copies

## Change History

- 2026-10-19: Independent QA cycle 1. Reviewed the task contract, source manifests, implementation handoff, test receipts, browser artifacts, and the owner-wide HTTP gate. Verdict: FAIL because the new server-side pending-copy denial has no HTTP-level regression test.
- 2026-10-19: Independent QA cycle 2. Reviewed the focused `createApp` HTTP regression and reran it independently: 1 suite / 3 tests passed. The cycle 1 verification gap is resolved; final verdict: PASS.

## Test Evidence Reviewed

- [x] Developer backend unit tests — Jest: 4 suites / 15 tests passed, per the backend verification receipt.
- [x] Developer backend integration tests — Jest: guarded PostgreSQL suite 1 / 4 tests passed, with the recorded pre-run and separate-process post-run guards.
- [x] Developer frontend unit tests — Vitest: 5 files / 17 tests passed.
- [x] Developer frontend typecheck and production build passed.
- [x] Developer frontend E2E — local Playwright: 1 / 1 passed against a rebuilt static app with intercepted fixture APIs. It covers two browser contexts, pending-to-ready one-click entry, cookie omission on public reads, manual edits, and desktop/mobile screenshots.
- [x] Backend HTTP integration coverage for `createDemoCopyGate`: independently rerun with `node backend/node_modules/jest/bin/jest.js --config backend/jest.integration.config.cjs --runInBand test/integration/demo-copy-gate-http.integration.spec.ts` from `Personal-AI-Workspace`; exit 0, 1 suite / 3 tests passed. It verifies denial before the private handler, positive ready-demo and regular-session controls, and safe status/public-read exceptions while unready.

The existing backend/frontend, PostgreSQL, and browser results remain reviewed from the handoff and receipts. Cycle 2 independently reran only the new HTTP suite; the initial command from the workspace root stopped before test discovery because that directory does not contain the app’s Jest installation. The successful invocation ran from `Personal-AI-Workspace`. No database or browser window was used.

## Functional Acceptance Review

- [x] Publication and copy business rules reviewed: selected owner-scoped source data is projected into synthetic public IDs; preview and publish recompute digests; immutable versions and admission pins serialize on the publication pointer; quota-denied file writes remain hidden and known-safe retry reuses the same pinned version and target IDs.
- [x] API behavior verified for pending-copy denial: the new HTTP suite proves an authenticated unready demo receives 409 `DEMO_COPY_NOT_READY` and the attached private project handler is not called. Ready demos and regular sessions reach the handler; copy status and public snapshot reads remain available while unready.
- [x] Copy error cases reviewed: the guarded PostgreSQL receipt records quota denial with no physical target-file write, followed by a bounded retry that completes with the pinned version, fresh target IDs, verified bytes/hash, settled quota, and default policy row.
- [x] Migration and persistence evidence reviewed: additive migration 0033, immutable-version triggers, pin foreign key, and guarded PostgreSQL receipt.
- [x] `contract.md` alignment reviewed for the implemented publication, copy status, retry, and public DTO behavior. The known-credit and Usage view is an explicit Task 3.6 integration follow-up; Task 3.4 correctly reports AI availability as unknown and does not invent balances or link to an unavailable screen.

## Review Lenses Applied

- [x] Security review: source-level review and direct HTTP boundary test applied. Chrome DevTools MCP was unavailable in this session, so live response/header/network inspection was not performed; no live endpoint or deployment claim is made.
- [x] Performance review: reviewed bounded snapshot limits, bounded 20-request / 500 ms copy-status polling, parameterized database queries, and bounded file-copy processing. No blocking performance issue was found by source review. No runtime trace was collected.
- [x] Usability and accessibility review: compared the flow with `ui-spec.md`, reviewed the one-click and bounded-polling tests, and inspected the supplied desktop/mobile screenshots. The banner wraps on mobile and private content remains gated until ready. Keyboard-only and axe checks were not present in the handoff evidence.

## Findings Summary

### functional acceptance

The developer evidence supports immutable publication, version pinning, fresh private copies, quota-aware file provisioning, bounded retry, and automatic entry into the ready private project. The independently rerun Express-boundary test closes the pending-copy denial gap by asserting the private handler is not called for an unready authenticated demo.

### security

Source review found `createDemoCopyGate` mounted before feature routers. It permits only the documented status/session/public-read exceptions, then checks demo-session readiness for other `/api/v1/` requests. The focused HTTP test confirms an unready request receives 409 before the private project handler runs and verifies the expected positive and safe-exception paths. Public snapshot fields use generated identifiers, and file downloads use an allowlisted server MIME type, attachment disposition, and `nosniff`. Live DevTools network evidence is unavailable.

### performance

Source review found configured finite snapshot/file/item limits and a bounded status poll. The reviewed receipts show the focused suites passing. No performance trace or query plan was collected; this task does not add an unbounded list or background fan-out.

### usability and accessibility

The local Playwright evidence supports the one-click pending-to-ready route and two isolated editable copies. Supplied screenshots show the public read-only view and private banner on desktop and mobile. Keyboard navigation, screen-reader behavior, contrast tooling, and browser console output were not independently captured.

## Evidence Index

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| Task 3.4 requirements and required evidence | Repository docs | Acceptance criteria and required browser/network evidence | `.codex/docs/hackathon-release/tasks.md` — Task 3.4 |
| Task 3.4 API and lifecycle contract | Repository docs | DTOs, authorization, immutable publication, copy/pin/quota invariants | `.codex/docs/hackathon-release/task-3-4-showcase-and-demo-entry/contract.md` |
| Developer backend handoff | Repository docs | Backend implementation summary, commands, limitations | `.codex/docs/hackathon-release/task-3-4-showcase-and-demo-entry/dev-summary.md` |
| Guarded PostgreSQL verification receipt | Local Jest / PostgreSQL | 4 integration tests, fixture identity guards, quota failure/retry and persistence results | `.codex/docs/hackathon-release/task-3-4-showcase-and-demo-entry/artifacts/task-3-4-backend-verification.md` |
| Developer frontend handoff | Repository docs | Vitest, typecheck, build, local Playwright result and MCP limitations | `.codex/docs/hackathon-release/task-3-4-showcase-and-demo-entry/frontend-dev-summary.md` |
| Public showcase and pending-copy HTTP gate | Source review | Public route behavior and global pre-router gate; direct HTTP boundary regression is listed below | `Personal-AI-Workspace/backend/src/modules/showcases/controllers/showcase-router.ts`; `Personal-AI-Workspace/backend/src/app.ts:273` |
| Existing copy integration evidence | Local Jest / PostgreSQL | Manager-level readiness and copy persistence assertions; does not exercise Express middleware | `Personal-AI-Workspace/backend/test/integration/demo-admission.integration.spec.ts:432` |
| Pending-copy HTTP gate regression | Local Jest / Supertest | `createApp` request-level denial before private handler, ready/regular positive controls, status and public-read safe exceptions | `Personal-AI-Workspace/backend/test/integration/demo-copy-gate-http.integration.spec.ts` — independently rerun, 1 suite / 3 tests passed |
| One-click and two-context browser flow | Local Playwright | Fixture-backed public read-only flow, pending-to-ready navigation, private edits and isolation | `Personal-AI-Workspace/frontend/e2e/task-3-4-showcase-demo.spec.ts` |
| Visual browser artifacts | Local Playwright | Public desktop and private desktop/mobile states | `.codex/docs/hackathon-release/task-3-4-showcase-and-demo-entry/artifacts/task-3-4-public-showcase-desktop.png`; `.../task-3-4-private-demo-desktop.png`; `.../task-3-4-private-demo-mobile.png` |
| Runtime browser network evidence | MCP unavailable | Chrome DevTools MCP was not present in this session’s callable tool inventory; the local Playwright fixture does not contact the backend | Unavailable; no live endpoint or deployment claim made |

## Definition of Done Checklist

### Universal DoD

- [x] Code quality and developer self-review are reported complete; backend and frontend TypeScript checks passed.
- [x] No `any`, commented-out code, unlinked TODO, or debug logging was reported in the developer handoff; no such issue was found in the reviewed critical paths.
- [x] Architecture boundaries are consistent with the approved Task 3.4 preflight; migration 0033 is additive and guarded on rollback.
- [x] Showcase and demo-copy APIs are documented in OpenAPI; README documents the required all-or-none finite settings and unpublished-by-default behavior.
- [x] Database migration is included and its rollback refuses while showcase versions or copies remain.
- [x] Focused backend/frontend unit tests, PostgreSQL integration, typechecks, build, and the local Playwright flow passed as reported.
- [x] Direct HTTP denial coverage for the pending-copy gate is present and independently passed in QA cycle 2.
- [x] Developer self-review and test review are recorded in the handoff.

### Frontend DoD

- [x] UI follows the supplied spec for one-click entry, pending/failed states, the read-only showcase, and private-copy navigation.
- [x] Loading, empty, error, and success states are present in the reviewed entry/showcase/copy routes.
- [x] Responsive behavior has desktop and mobile Playwright screenshots; visible controls use semantic links/buttons and accessible labels where needed.
- [x] Keyboard-only, axe, and browser-console evidence was not supplied or independently collected; these additional checks are recorded as a limitation and were not required by the Task 3.4 acceptance criteria.
- [x] Interactive controls in the owned surfaces expose `data-testid` attributes in the reviewed source.

### Backend DoD

- [x] New endpoint status and DTO behavior is documented and validated at request boundaries with strict schemas and owner/admin checks.
- [x] Errors are mapped to safe HTTP responses; no new credential is committed in the reviewed Task 3.4 paths.
- [x] Additive migration 0033 is included; migrations 0029–0032 remain outside Task 3.4 ownership.
- [x] The app-wide copy-readiness authorization boundary has an HTTP integration test proving denial before private handler execution.

### QA Gate and MCP Evidence

- [x] Developer frontend unit, backend unit, backend integration, typecheck/build, and E2E evidence reviewed as passing.
- [x] Tester security review passed after the focused HTTP gate regression; live DevTools network evidence is unavailable and explicitly documented.
- [x] Performance and usability/accessibility source and artifact reviews were applied; runtime performance and keyboard/axe testing remain uncollected.
- [x] Evidence Index is present and links the implementation and test artifacts.
- [x] Final verdict: PASS.

## Verdict: PASS
