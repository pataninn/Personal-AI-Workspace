# Dev Summary: Persist editable user skills with bounded invocation

## Change History

- 2026-10-19: Implemented Task 6.2 backend skill definitions and bounded Home invocation; added narrow showcase DTO compatibility and corrected workspace purge expectations to match delivered migration 0027.

## What Was Implemented

Account-owned skills now support templates, CRUD, immutable revisions, owner-scoped idempotency, and quota accounting. Invocation uses the existing Home turn/runtime path, persists its trusted skill binding before dispatch, fingerprints the immutable revision/context identities, and intersects declared tools with current persisted policy. Showcase publication stores only selected sanitized skill fields; demo provisioning creates private generated IDs and version-1 editable revisions. Ordinary Home turns remain unbound and keep existing behavior. Whole-workspace deletion follows existing 0027 cascade semantics and releases skill content without retaining Home history.

## Files Changed

The exact file inventory and task-owned hunks are in [source-map.md](source-map.md) and [source-hunk-manifest.md](artifacts/source-hunk-manifest.md).

- **Backend:** New `backend/src/modules/skills/**`; migration 0035 and skill/invocation/showcase/home repositories; Home turn binding and capability checks; content accounting and project-removal selection; skill routes/composition/OpenAPI; focused repository, use-case, handler, and integration tests.
- **Frontend compatibility:** Showcase DTO types/exports and normalizer; publisher sends an empty `skillIds` array; focused API-normalizer and publisher tests. Full skill selection and public skill display remain Task 6.3.
- **Docs:** Contract, architecture-aligned source map, shared-hunk manifest, verification receipt, and dev summary. The canonical release tracker snapshot was copied byte-for-byte to `Personal-AI-Workspace/docs/hackathon-release/tasks.md` and left unstaged.

## Contract Notes

The final contract follows the architect's correction: delivered migration 0027 deletes workspace conversations and therefore their turns/invocations on hard workspace deletion. A surviving non-null skill turn with an unavailable invocation/source still fails closed; null-marker ordinary turns preserve their normal policy path. The private copy contains generated private IDs only.

## Architecture Alignment Notes

Skills use the existing module/use-case/repository structure. `SubmitHomeTurn` remains the only dispatch boundary; `GetHomeTurn` and the closed Home tool handler enforce the invocation ceiling and current policy. Invocation metadata stores bounded IDs/revisions/fingerprints, not duplicated skill text, context values, prompts, or assistant output. Migration 0035 retains scalar source identity while source-content deletion remains possible.

## Evidence Collected

- [Verification receipt](artifacts/verification-receipt.md) records exact PostgreSQL filters, guards, resolved failed attempts, migration proof, focused Jest/Vitest checks, TypeScript results, and the non-secret cleanup outcome.
- [Source/hunk manifest](artifacts/source-hunk-manifest.md) records shared-file ownership boundaries.
- No credentials or fixture paths were written into evidence.

## MCP Notes

No Context7 or browser MCP evidence was needed: no external library behavior or new user-facing skill UI was introduced. The existing read-only showcase page accepts the extended DTO; visual skill-card UI is deferred to Task 6.3.

## Code Review Findings (and resolutions)

Self-review checked owner scoping, strict validation, stable version/replay rules, quota history, safe public showcase projection, runtime/policy capability intersection, missing-source fail-closed behavior, and the delivered workspace purge cascade. No unresolved Task 6.2 code finding remains. The two PostgreSQL quota assertion failures and the stale marker-retention expectation were corrected and are documented with the final passing reruns. The temporary frontend typecheck failure came from the separate Task 4.3 archive removal and was resolved by its owner before the final green typecheck.

## Test Coverage Summary

- Guarded PostgreSQL: `skill-definitions.integration.spec.ts` — 2 passed; filtered `demo-admission.integration.spec.ts` — 1 passed, 4 skipped by the exact filter. Every actual run had a passing preguard and separate-process postguard.
- Jest: Home planning tool handler — 11 passed. Backend `tsc --noEmit` passed.
- Vitest: showcase API normalizer and publisher — 2 tests passed. Frontend app and node TypeScript projects both passed.
- OpenAPI JSON parsing passed. The verification receipt retains the failed-attempt history and exact filters.

## Known Limitations / Tech Debt

The skill picker in showcase publishing and skill cards on the public showcase remain Task 6.3 carry-forward. Scheduling remains Task 7.1. No source behavior for those tasks was introduced here.

## Ready for QA: YES
