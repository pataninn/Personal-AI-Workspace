# QA Report: Expire and clean up demos safely

## Change History

- 2026-10-19: Independent QA cycle 1 issued FAIL for a High persisted-data blocker: the restrictive credit usage owner FK prevented deletion of a demo owner with settled provider usage.
- 2026-10-19: Independent QA cycle 2 reviewed the architect-approved retention repair and guarded PostgreSQL regression. The cycle 1 finding is resolved; final verdict is PASS.

## Test Evidence Reviewed

- [x] Developer frontend unit tests — N/A; this is a backend-only task.
- [x] Developer backend unit tests — Jest: 3 suites / 15 tests passed in the developer receipt. I independently reran the focused command; 3 suites / 15 tests passed.
- [x] Developer backend integration tests — Jest: reviewed the guarded PostgreSQL receipt for 1 suite / 3 tests passing with migration 0034 applied and fresh-process postguard. The regression exercises settled credit retention, in-flight/unknown barriers, detached replay and isolation. I did not rerun PostgreSQL in this cycle.
- [x] Developer frontend E2E tests — N/A; no UI or browser flow changed.

The latest shared backend typecheck exits nonzero only for concurrent Task 4.3 task-mutation diagnostics; the reported diagnostics do not reference Task 3.5-owned files. This is recorded as a shared-worktree limitation, not as a Task 3.5 typecheck pass. The earlier clean receipt predates the repair; the repair's current compiler evidence is the absence of diagnostics in its owned files in the latest full check.

## Functional Acceptance Review

- [x] API behavior verified as N/A; Task 3.5 adds no endpoint or public response field.
- [x] Business rules and edge cases verified. Finalization locks the demo owner and its reservations, blocks in-flight/unknown states, and detaches ownership only for terminal reservations and usage rows.
- [x] Error cases verified. Unresolved credit and root-effect receipts remain barriers; unsafe managed roots fail closed. Terminal settlement replay returns its stored charge after detachment.
- [x] Migration and persistence outcomes verified. Migration 0034 makes only the two ledger owner columns nullable, preserves FK actions and reservation links, and refuses rollback while detached rows exist. The guarded PostgreSQL receipt records migration application and the end-to-end retention regression.
- [x] Contract alignment verified. Retained financial detail and shared daily/campaign totals follow the architect-approved preflight decision and updated contract.

## Review Lenses Applied

- [x] Security review applied.
- [x] Performance review applied.
- [x] Usability and accessibility review — N/A; no user-facing UI changed.

## Findings Summary

### functional acceptance

The cycle 1 High finding is resolved. Finalization holds the owner fence while it locks reservations; in-flight and unknown reservations keep cleanup pending. Once all reservations are terminal, the transaction nulls reservation and usage owner IDs before deleting the demo user, preserving pricing, token, charge, source, call/attempt, status and reservation-link detail. The PostgreSQL regression proves settled usage survives, unresolved states block detachment, replay does not charge again, shared daily/campaign totals stay unchanged, and regular/admin/showcase data and admission counters survive.

### security

No open Critical or High security finding. The implementation retains terminal credit history without exposing new public API state, and unresolved provider or filesystem effects continue to block purge.

### performance

No blocking performance issue found in the reviewed change. Cleanup remains bounded by the existing maintenance batch; no browser performance evidence applies.

### usability and accessibility

Not applicable to this backend-only task.

## Evidence Index

| Artifact / Reference | Source MCP | Covers | Location / Identifier |
|---|---|---|---|
| Task 3.5 declaration | N/A; task marks MCP inputs N/A | Scope, evidence requirements and acceptance criteria | .codex/docs/hackathon-release/tasks.md → Task 3.5 |
| Architecture decision and contract | N/A | Preserve terminal ledger rows; FK actions; owner/reservation lock and barrier policy; replay behavior | .codex/docs/hackathon-release/task-3-5-demo-expiry/architecture-preflight.md → QA cycle 1 decision; contract.md → credit-retention change |
| Developer validation receipt | Local Jest / PostgreSQL / TypeScript; no MCP | Unit 3/15; guarded PG 1/3 with migration 0034, preguard/postguard and known shared typecheck failure | .codex/docs/hackathon-release/task-3-5-demo-expiry/artifacts/validation.md |
| Developer summary, self-review and source manifest | N/A | Repair readiness, limitations, exact ownership and excluded concurrent work | dev-summary.md; artifacts/self-review.md; artifacts/source-manifest.txt |
| Independent focused unit rerun | Local Jest | 3 suites passed, 15 tests passed | Personal-AI-Workspace/backend; cleanup repository, copy manager and workspace boundary suites |
| Guarded PostgreSQL test source | Local Jest / PostgreSQL; no MCP | Real settled demo reservations, busy/unknown barriers, preserved ledger/totals, replay and account isolation | Personal-AI-Workspace/backend/test/integration/demo-expiry-cleanup.integration.spec.ts:217-318 |
| Migration and cleanup finalizer source | Source review | Nullable owner columns; rollback guard; atomic detach before owner deletion | Personal-AI-Workspace/backend/src/infrastructure/database/migrations/1710000034000-create-demo-expiry-cleanup.ts:11-12, 58-77; typeorm-demo-expiry-cleanup-repository.ts:332-378 |
| Credit ledger replay and locking source | Source review | Ownerless terminal replay short-circuit; unresolved detached rows rejected; policy is not acquired late by cleanup | Personal-AI-Workspace/backend/src/infrastructure/database/repositories/typeorm-credit-ledger-repository.ts:180-201, 261-320 |
| Current shared backend typecheck receipt | Local TypeScript compiler | Nonzero due only to concurrent Task 4.3 diagnostics; no diagnostic in Task 3.5-owned files | artifacts/validation.md; diagnostics listed in dev-summary.md |
| QA review standards | N/A | Definition of Done, security and performance lenses | .codex/skills/definition-of-done/SKILL.md; security-review/SKILL.md; performance-review/SKILL.md |

No Playwright, Chrome DevTools or Context7 evidence was required: Task 3.5 declares all MCP inputs N/A. The PostgreSQL receipt was reviewed, not independently rerun. No live provider, deployment, or unresolved external-effect completion claim is made.

## Definition of Done Checklist

- [x] Developer self-review and focused backend unit coverage are present; independent focused Jest rerun passes.
- [x] Required guarded PostgreSQL persistence evidence is present and reviewed; the new regression covers the prior settled-usage gap.
- [x] Migration 0034 has a guarded rollback that refuses to discard detached ledger history.
- [x] No public API or UI change; API/OpenAPI and browser E2E checks are not applicable.
- [x] Security and performance review lenses applied; usability/accessibility is not applicable.
- [x] Required MCP evidence is accounted for; task marks MCP inputs N/A.
- [x] Expired-owner cleanup preserves terminal credit history, blocks unresolved reservations, and leaves shared spending totals unchanged.
- [x] Current compiler output has no Task 3.5-owned diagnostics. The full shared backend check remains non-passing due to concurrent Task 4.3 WIP and is not represented as a clean package check.
- [x] Tester final verdict: PASS.

## Verdict: PASS

## Cycle 1 Finding Resolution

**Resolved — High:** The prior finalization failure occurred because credit usage owner references restricted deletion. Migration 0034 now permits nullable owner IDs while retaining FK actions and the usage-to-reservation restriction. Finalization locks the owner and reservations, blocks in-flight/unknown rows, detaches only terminal ledger ownership in the same transaction before user deletion, and keeps all immutable financial details and shared totals. The guarded PostgreSQL regression proves the previously missing normal settled-usage case and replay behavior.

The shared backend typecheck failure belongs to concurrent Task 4.3 WIP and remains visible in the developer receipt; it is not claimed as a Task 3.5 check pass. Future Task 6.4 export and Task 7.1 schedule modules still need their own cleanup hooks and purge receipts, as documented in the contract.
