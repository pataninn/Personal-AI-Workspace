# Task 3.5 source map and ownership gate

**Status:** Implementation complete and ready for QA. Task 3.4 delivery is verified at `ae188ba9d39264ff4b981dc745b7a1daafd70c20`; migration 1710000033000 is present. Task 3.5 uses only additive migration 1710000034000.

## Source boundaries

| Responsibility | Existing source | Task 3.5 seam |
| --- | --- | --- |
| Expiry and admission replay | `backend/src/modules/auth/`, `backend/src/modules/demo/use-cases/create-demo-session.ts`, `backend/src/infrastructure/database/repositories/typeorm-demo-admission-repository.ts` | Keep authentication expiry authoritative; add durable expiry claim/fence/finalize operations without changing public admission DTOs or counters. |
| Copy lock, claim, and readiness | `backend/src/infrastructure/database/repositories/typeorm-demo-showcase-copy-manager.ts`; `backend/src/infrastructure/database/migrations/1710000033000-create-showcase-and-demo-copies.ts` | Add an operation receipt around managed-root creation; stale workers can finish their own receipt but cannot pass the existing claim-token readiness check. |
| Cleanup contract and orchestration | `backend/src/modules/demo/domain/demo-admission-types.ts`, `backend/src/modules/demo/use-cases/`, `backend/src/modules/demo/repositories/` | Add a narrow expiry-cleanup use case and repository port. Keep phase policy in the use case; keep SQL and transaction ordering in infrastructure. |
| Durable state | `backend/src/infrastructure/database/data-source.ts` | Register only migration `1710000034000`; add an indexed cleanup-job record and the minimal root-operation receipt state needed for unknown barriers. Never edit prior migrations. |
| Managed roots and accounting | `backend/src/infrastructure/database/repositories/typeorm-storage-root-mapping-repository.ts`, `typeorm-storage-quota-repository.ts`, `backend/src/infrastructure/database/storage-content-accounting.ts`, `backend/src/infrastructure/workspace/workspace-boundary.ts`, `backend/src/infrastructure/workspace/storage-quota-file-mutation.ts` | Reuse trusted mapping resolution, reservation reconciliation, and verified retained-root deletion. Do not use ordinary interactive project removal as the full owner purge. |
| Cancellation and project recovery | `backend/src/modules/ai-runs/`, `backend/src/infrastructure/database/repositories/typeorm-project-removal-repository.ts`, `backend/src/infrastructure/workspace/project-recovery-cleaner.ts` | Request cancellation through existing use cases; wait for terminal persisted outcomes; complete existing project-removal/recovery phases before owner deletion. |
| Maintenance and composition | `backend/src/infrastructure/startup/periodic-maintenance.ts`, `backend/src/composition-root.ts` | Add one bounded demo-expiry pass to the existing maintenance task; no new process, timer, queue, controller, or route. |
| API documentation | `backend/openapi.json`, `backend/src/openapi/` | No API change; do not alter public DTO/OpenAPI contracts. |

## Shared-file ownership and coordination

- Task 3.5 owns the migration registration in `backend/src/infrastructure/database/data-source.ts` and the demo-cleanup import/wiring plus existing maintenance task additions in `backend/src/composition-root.ts`.
- The current `composition-root.ts` contains an in-progress Task 6.1 `readSelectedFacts` dependency in `SubmitHomeTurnUseCase` wiring. Preserve that exact hunk; only edit the independently owned imports and maintenance construction area. Do not modify Home prompt/submit behavior.
- Coordinate overlapping composition-root or data-source edits with the release owner and Task 4.2 developer before touching their hunks. Do not overwrite concurrent changes.
- No frontend files, Home submit/prompt files, task/action modules, or app-local `.codex` scratch files are owned by this task.

## Implementation boundary and handoff

The exact Task 3.5 source paths and the owned hunks in shared files are listed in `artifacts/source-manifest.txt`. The Task 3.5 change is limited to expiry cleanup, the managed-root effect receipt/barrier, strict manifested-root purge, quota reconciliation, maintenance wiring, migration 0034, and focused tests. Skills CRUD/migration 0035, storage-content skill accounting, frontend, and OpenAPI edits belong to parallel work and are excluded.

The QA cycle 1 credit-retention repair is limited to migration 0034, `typeorm-credit-ledger-repository.ts`, the cleanup finalizer/barriers, and the integration fixture. Finalization locks the owner and each reservation, blocks `in_flight`/`unknown`, and detaches owner IDs only for terminal reservations and usage entries. The repository returns a terminal settlement replay before owner-specific locks when detached; global daily/campaign totals and immutable financial detail remain unchanged. Migration rollback refuses when detached rows exist.

Focused Jest evidence covers the unknown-receipt barrier and exact managed-child deletion/reparse rejection. PostgreSQL evidence covers migration 0034, status-only replay tombstones without counter/account/showcase changes, an unresolved root receipt retaining its owner/root, resumed purge after a verified receipt, and the settled-ledger retention/barrier/replay regression. A fresh repository instance resumes from persisted state; this does not claim a real provider or filesystem operation stopped merely because its lease expired. Evidence and limits are recorded in `artifacts/validation.md`; reviewer notes are in `artifacts/self-review.md`.

Full application/browser tests and paid inference are outside this backend-only task. Exports and schedules remain future cleanup contributors and were not implemented here.
