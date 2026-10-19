# Dev Summary: Task 4.2 Direct Home Actions

## Change History

- 2026-10-19: Implemented persisted receipt provenance in existing GET/undo summaries and Home Activity.
- 2026-10-19: Added a bounded known-version-conflict result across the Home handler, runtime, Hermes transport, and bridge. Exact version conflicts create no receipt; unrelated failure classes retain existing handling.
- 2026-10-19: Completed focused browser verification and refreshed the contract, source map, UI spec, source manifest, and self-review.

## What Was Implemented

Existing action receipts now expose the ledger's persisted actorKind and nullable turnId through GET and undo DTOs and OpenAPI. Frontend validation requires consistent provenance, Home Activity places receipts by persisted turn, and cards show readable action and source labels. Manual receipt construction uses actorKind=manual and turnId=null.

Exact ProjectTaskVersionConflictError and ProjectVersionConflictError failures from direct expected-version mutations now return the bounded outcome=conflict, code=VERSION_CONFLICT tool result. The failed mutation has no receipt. The result envelope is allowlisted exactly across the Hermes runtime and bridge. Arbitrary 409 errors, idempotency reuse, policy/auth/scope failures, and transport uncertainty are not mapped to this result.

## Files Changed

### Backend

See exact-source-manifest.txt. The HTTP contract extends existing GET /api/v1/actions/{actionId} and POST /api/v1/actions/{actionId}/undo receipt summaries; no endpoint was added. The OpenAPI file is shared with Task 6.2, whose separate skills routes/schema hunk is owned by the skills developer.

### Bridge

Exact result validation and safe forwarding in the Hermes bridge, with focused Python unit coverage.

### Frontend

Receipt API normalization, Home Activity source/action/status display, manual receipt provenance, and focused component, hook, entity, and browser fixture coverage.

### Docs

- .codex/docs/hackathon-release/task-4-2-direct-home-actions/contract.md
- .codex/docs/hackathon-release/task-4-2-direct-home-actions/source-map.md
- .codex/docs/hackathon-release/task-4-2-direct-home-actions/ui-spec.md
- .codex/docs/hackathon-release/task-4-2-direct-home-actions/dev-summary.md
- .codex/docs/hackathon-release/task-4-2-direct-home-actions/self-review.md
- .codex/docs/hackathon-release/task-4-2-direct-home-actions/exact-source-manifest.txt
- .codex/docs/hackathon-release/task-4-2-direct-home-actions/artifacts/home-receipt-journey.png
- .codex/docs/hackathon-release/task-4-2-direct-home-actions/artifacts/home-receipt-journey-browser-evidence.json

The architect-owned architecture-preflight.md remains decision evidence. The PM-owned release tracker snapshot is Personal-AI-Workspace/docs/hackathon-release/tasks.md; no canonical tracker status was changed by this developer.

## Contract Notes

Receipt provenance is read from persisted action-ledger fields. Manual receipts carry a null turn; assistant receipts carry the persisted Home turn. Known expected-version conflicts use only the bounded result code VERSION_CONFLICT and never create a success receipt. No migration is needed.

## Architecture Alignment Notes

Home actions continue through the existing typed Home handler and canonical task/workspace mutations. Owner, scope, policy, storage, version, transaction, and stable operation-key boundaries remain in the existing layers. No proposal acceptance path or batch persistence was added.

## Evidence Collected

- .codex/docs/hackathon-release/task-4-2-direct-home-actions/artifacts/home-receipt-journey.png
- .codex/docs/hackathon-release/task-4-2-direct-home-actions/artifacts/home-receipt-journey-browser-evidence.json
- The browser evidence is synthetic preview data only. The JSON records blocked external requests and browser errors; no real provider/workspace interaction occurred.

## MCP Notes

Context7 and Chrome DevTools MCP evidence were unavailable/not used. The existing local Playwright preview with Chrome was used for the browser check.

## Code Review Findings (and resolutions)

- Conflict mapping is limited to the two exact canonical expected-version exception classes; no arbitrary status, message, or 409 mapping is used.
- The conflict result has an exact field set and fixed safe code in both Hermes and bridge validators. No raw exception text is forwarded.
- A known failed mutation creates no action receipt; successful earlier actions and their receipts remain intact.
- The first browser run exposed that reloading returns to Dashboard and closes the transient Home drawer. The preview test now reopens the same Home conversation before asserting its saved receipt/proposal content. The successful rerun passed all three preview tests.
- OpenAPI is a shared file; the Task 6.2 skills developer owns the separate skill paths and schema addition.

## Test Coverage Summary

- Backend Jest: 5 focused suites, 31 tests passed, including receipt/OpenAPI, handler, GetHomeTurn, and Hermes runtime coverage.
- Hermes bridge Python: 23 focused tests passed.
- Frontend Vitest: 4 files, 24 tests passed.
- Playwright: existing home-summaries preview, 3 tests passed. The initial run had 2 passes and 1 test-assumption failure; after reopening Home Ask following reload, the rerun passed all 3.
- TypeScript: backend type check passed; both frontend app and node type-check projects passed.
- Preview build: Vite preview build passed.

## Known Limitations / Tech Debt

The design remains per-action atomic. There is no durable per-turn batch or partial-result store, and no static conflict card is fabricated in Home Activity. The bounded runtime result communicates the known non-applied conflict; Activity only labels persisted receipts as applied.

## Ready for QA: YES