# Dev Summary: Canonical task deletion and archive removal

## Change History
- 2026-10-19: Implemented canonical deletion, archive removal, migration 0036, and effect-free replay fixes.

## What Was Implemented
Inbox/workspace tasks share one authenticated, versioned global delete with a minimal non-reversible receipt. Task archive routes, tools, state, filters, and proposal variants are removed. Migration 0036 converts legacy archived rows without dropping content and fails closed on rollback after deletion or later row changes. Task-create undo physically removes the task; workspace undo retains its owner/version/content guards. Exact Home delete/undo replay runs current principal, bound-skill/capability, and Home policy checks first, then returns only the existing receipt without target read, mutation, new event, or workspace effect.

## Files Changed
The complete per-file and shared-hunk boundary is in [source-hunk-manifest.md](source-hunk-manifest.md), including exclusions for active 6.2/3.6/3.5 work and original protected files.

## Contract Notes
`DELETE /api/v1/tasks/{taskId}` is canonical for Inbox and workspace tasks; Home uses `home_delete_task`. There is no archive fallback or restoration path. See [contract.md](contract.md).

## Architecture Alignment Notes
Task use cases and the existing transactional action ledger own mutation and replay. The Home handler preserves principal, skill, policy, and scope gates. Frontend changes stay in existing task/Home feature slices. Workspace undo keeps all prior owner, version, metadata, root/folder, file mapping, provider/run, quota, recovery, and content guards.

## Evidence Collected
- [Verification receipt](artifacts/verification-receipt.md) records exact test commands/results, guarded PostgreSQL checks, failed attempts, and the OpenAPI HEAD comparison.
- [Self-review](artifacts/code-review.md) completed; no Task 4.3 blocker.
- Earlier focused checks recorded in the execution handoff: frontend Vitest 40/40 and both frontend TypeScript project checks passed.

## MCP Notes
Context7, Chrome DevTools, and Playwright MCP were not used; this task has no browser behavior needing visual validation and adds no library dependency.

## Code Review Findings (and resolutions)
No Task 4.3 blocker remains. Exact replay is owner/key/fingerprint checked in ledger use cases and returns a cached receipt only after current gates. Migration rollback cannot recreate deleted task content. The seven unrelated OpenAPI 413 omissions are absent at both recorded HEAD and current JSON; see receipt.

## Test Coverage Summary
- Jest: Home handler, undo use case, and task mutation: 3 suites / 24 tests passed.
- Jest: workspace repository undo guards: 1 suite / 15 tests passed.
- PostgreSQL/Jest: migration 1 suite / 1 test and Home command parity 1 suite / 5 tests passed with clean pre/postguards.
- Backend TypeScript check passed, including the final isolated staged-index snapshot. Both frontend TypeScript projects passed against staged frontend blobs; earlier focused Task 4.3 evidence also includes 8 backend suites / 83 tests and frontend Vitest 40/40.
- The storage-quota OpenAPI suite is not claimed as passing; its seven missing 413 references are pre-existing at HEAD.

## Known Limitations / Tech Debt
Seven unrelated Home/AI-run OpenAPI 413 response references remain missing at the recorded baseline; release validation should address them separately.

## Ready for QA: YES