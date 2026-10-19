# QA Report: Private one-click demo admission

## Change History

- 2026-10-19: Independent final QA completed. Focused unit, HTTP, TypeScript, and guarded PostgreSQL checks passed. No application files were changed by QA.
- The initial broad integration run recorded in the developer handoff exposed a stale R1 test fixture that lacked demo limits; the fixture was corrected, and the final broad run passed without relaxing production fail-closed behavior.

## Test Evidence Reviewed

- [x] Developer backend unit tests — Jest: 140 suites / 838 tests passed (reviewed handoff).
- [x] Independent focused backend unit tests — Jest: 4 suites / 55 tests passed.
- [x] Developer backend integration tests — Jest: 31 suites / 114 tests passed (reviewed handoff).
- [x] Independent demo HTTP integration tests — Jest: 1 suite / 6 tests passed.
- [x] Independent guarded PostgreSQL demo admission tests — Jest: 1 suite / 3 tests passed.
- [x] Backend TypeScript type check — developer and independent runs passed.
- [ ] Frontend unit tests — N/A; Task 3.3 has no frontend changes.
- [ ] Frontend E2E tests — N/A; Task 3.3 declares Playwright N/A.

## Functional Acceptance Review

- [x] API behavior verified for anonymous creation, valid demo resume, regular-session preservation, invalid-cookie replacement, status-only replay, origin/body/key validation, and proxy identity handling.
- [x] Business rules and edge cases verified: globally unique key digest; same-key concurrent requests create one owner; fixed-window global/network/owner counters; key-rotation fail-closed behavior; bounded provisioning; unchanged expiry on resume; and regular-account run-start bypass.
- [x] Error cases verified: invalid or incomplete admission configuration fails closed; rate limits do not dispatch; failed provisioning yields no credential; and cancellation that wins before the atomic ready-to-queued transition creates no run-start event or runtime call.
- [x] Persistence outcomes verified with isolated PostgreSQL: a newly provisioned owner is storage-ready and receives one session with matching persisted expiry; concurrent key replay exposes status only; raw idempotency key is not persisted; and cancellation-before-start leaves no run-start event.
- [x] `contract.md` alignment verified, including the required post-transition run-start gate, status-only replay, all-or-none abuse configuration, and later-task ownership for showcase and expired-admission cleanup.

## Review Lenses Applied

- [x] Security review.
- [x] Performance review (source-level bounds and transaction scope; no load-test claim).
- [ ] Usability and accessibility review — N/A; backend-only change with no UI.
- [ ] Browser/Chrome DevTools MCP — N/A per Task 3.3. Context7 is also declared N/A in `tasks.md`.

## Findings Summary

### functional acceptance

PASS. The original request receives a cookie only after successful provisioning. A repeat without a valid demo cookie gets status only and cannot resume bootstrap or recover a credential. Existing valid demo sessions resume without expiry extension; valid regular sessions remain intact and receive a conflict. The run-start gate is required in production composition and runs after permission validation and the repository's successful atomic ready-to-queued transition, before publication or runtime dispatch. A refused slot conditionally aborts only the matching start.

Known `DemoAdmissionUnavailableError` cases map to 503. An unexpected repository/programming exception remains a generic 500 under the contract's explicit unknown-error rule. In either case the gate has not accepted the run, and runtime dispatch does not begin. I did not treat a blanket conversion of unknown defects into 503 as a requirement.

### security

PASS. Origin, empty-body, CSRF, cookie, idempotency-key, and trusted-proxy checks match the contract. The key is digested before persistence, network identity is HMAC-derived, and reviewed responses/schema/logging paths do not expose the raw key, raw client IP, secret, or storage path. The guarded PostgreSQL run used a dedicated loopback test fixture and a unique disposable database; its target database was absent before and after the run.

### performance

PASS for this task's acceptance scope. Admission counters and retained rows are bounded by configured windows and cleanup; global admission serialization is scoped to the counter transaction and does not span storage bootstrap I/O. No performance benchmark or public traffic behavior is claimed.

### usability and accessibility

N/A; no user-facing UI was changed.

## Evidence Index

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| Independent QA command/results record | Local CLI | Exact independent commands, exits, suite counts, and sanitized PostgreSQL fixture pre/post checks | [qa-independent-results.txt](artifacts/qa-independent-results.txt) |
| Developer final verification | Local CLI (developer handoff) | Full typecheck, backend unit/integration suites, guarded PostgreSQL suite, diff check, cleanup | [final-verification.md](artifacts/final-verification.md) |
| Developer summary and self-review | Source review | Scope, changed-file manifest, limitations, final handoff, self-review | [dev-summary.md](dev-summary.md) |
| Task contract and MCP declarations | Source review | Acceptance criteria and explicit browser/Chrome DevTools/Context7 N/A declarations | [contract.md](contract.md); [tasks.md](../tasks.md#task-33--provision-private-one-click-demo-identities) |
| Demo endpoint and cookie behavior | Source review + Jest HTTP | Origin, CSRF, body/key validation, session resume/conflict, cookie clearing/issuance, status-only replay | [demo-admission-router.ts](../../../../Personal-AI-Workspace/backend/src/modules/demo/controllers/demo-admission-router.ts:53); `demo-admission-http.integration.spec.ts` |
| Admission transactions and run-start limits | Source review + Jest PostgreSQL | Digest/counter transactions, expiry, rotation, owner/run dedupe and bounded admission | [typeorm-demo-admission-repository.ts](../../../../Personal-AI-Workspace/backend/src/infrastructure/database/repositories/typeorm-demo-admission-repository.ts:84); `demo-admission.integration.spec.ts` |
| Atomic run-start gate and conditional abort | Source review + Jest unit/PostgreSQL | Gate ordering, replay behavior, cancellation race, no dispatch on refusal | [start-ai-run-use-case.ts](../../../../Personal-AI-Workspace/backend/src/modules/ai-runs/use-cases/start-ai-run-use-case.ts:66); [typeorm-ai-run-repository.ts](../../../../Personal-AI-Workspace/backend/src/infrastructure/database/repositories/typeorm-ai-run-repository.ts:281) |
| Proxy trust and error mapping | Source review + Jest HTTP | Explicit CIDR trust, known typed unavailable response, generic unknown error envelope | [app.ts](../../../../Personal-AI-Workspace/backend/src/app.ts:92); `demo-admission-http.integration.spec.ts` |
| Task MCP evidence requirements | Source review | Playwright, Chrome DevTools, and Context7 applicability | [tasks.md](../tasks.md#task-33--provision-private-one-click-demo-identities) |

## Definition of Done Checklist

### Universal and backend

- [x] TypeScript check passes in the touched backend package; independently rerun.
- [x] Architecture and layer boundaries align with the release contract and the developer self-review.
- [x] Public endpoint is documented in OpenAPI; setup/configuration changes are listed in the handoff.
- [x] Additive migration is present; rollback refuses while dependent demo data exists.
- [x] Backend unit and required integration tests pass; independent critical-path tests pass.
- [x] Input validation and generic error mapping are present; secrets and credentials are not included in code or QA evidence.
- [x] Developer self-review and required test review are recorded as PASS in the handoff.

### QA gate and MCP evidence

- [x] Security review: PASS.
- [x] Performance review: PASS for scoped source-level review.
- [ ] Usability/accessibility: N/A; no frontend changes.
- [x] Required MCPs are declared N/A by Task 3.3; no MCP run is claimed.
- [x] Evidence Index links the developer and independent evidence.

## Verdict: PASS

This verdict covers Task 3.3 demo identity admission and the specified run-start gate. It does not claim public deployment, real proxy topology, operator-secret configuration, browser behavior, provider calls, showcase publication, or expired pending/failed cleanup. Showcase publication belongs to Task 3.4; durable cleanup belongs to Task 3.5.
