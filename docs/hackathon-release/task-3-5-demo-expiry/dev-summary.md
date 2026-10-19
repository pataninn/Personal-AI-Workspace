# Dev Summary: Expire and clean up demos safely

## Change History

- 2026-10-19: Implemented Task 3.5 against migration 0033 and the refreshed architecture preflight. Ready for independent QA; no staging or commit performed.
- 2026-10-19: QA cycle 1 found that retained settled credit usage rows restricted deletion of normally used demo owners. Applied the architect-approved retention repair in migration 0034 and added a focused PostgreSQL regression; QA cycle 1 history remains in `qa-report.md`.

## What Was Implemented

Added migration 0034 for bounded, restartable demo-expiry jobs and managed-root effect receipts. Expired owners are fenced before cleanup; active/unknown external effects and reservations keep deletion pending. The worker reuses existing cancellation, project recovery, managed-root, and quota paths, removes only exact manifested managed roots, then leaves an expired status-only replay tombstone. The existing periodic maintenance runs a bounded cleanup pass. Settled/released/over-bound credit reservations and usage details are retained with nullable owners; in-flight and unknown reservations block finalization, and detached terminal settlement replays return their stored charge without recharging shared totals. No public API changed.

## Files Changed

### Backend

See the exact source path and shared-file hunk manifest in `artifacts/source-manifest.txt`. Task 3.5 owns the credit-ledger repository replay seam, cleanup finalizer/barriers, nullable owner columns in migration 0034, and a third PostgreSQL regression case. The change also adds cleanup types/use case/repository, quota-fenced purge operations, durable copy-root receipts, strict workspace-boundary removal, maintenance wiring, and focused unit coverage.

### Frontend

None.

### Shared

No public API contract or DTO changed.

### Docs

`contract.md`, `source-map.md`, this summary, and `artifacts/{source-manifest.txt,validation.md,self-review.md}`.

## Contract Notes

No endpoint, event, or public response shape was added. Internal cleanup phases and failure codes remain private. Future export and schedule modules remain responsible for their own expiry and purge receipts.

## Architecture Alignment Notes

The use case delegates to a demo cleanup port. SQL, lease/phase fencing, and persistence remain in the infrastructure repository. Cleanup composes existing cancellation, project-recovery, workspace-boundary, root-mapping, and quota services. No new timer, queue framework, or controller was added.

## Evidence Collected

- `.codex/docs/hackathon-release/task-3-5-demo-expiry/artifacts/validation.md`: focused Jest (3 suites/15 tests) and guarded PostgreSQL integration (1 suite/3 tests; migration 0034 applied; same-process preguard and separate-process postguard passed with no task database left behind).
- `.codex/docs/hackathon-release/task-3-5-demo-expiry/artifacts/self-review.md`: security, persistence, isolation, and scope review.
- No browser or paid-inference evidence applies to this backend-only task.

## MCP Notes

No external framework behavior or browser rendering changed; no Context7 or Chrome DevTools evidence was needed.

## Code Review Findings (and resolutions)

- A cleanup row has no denormalized owner column, so the bounded claim joins the admission row to recover the owner before taking its lease.
- A pending root-create receipt remains a hard cleanup barrier; lease expiry alone cannot authorize deletion.
- Root deletion validates the full tree before removing entries and verifies the exact project child is absent afterward.
- The focused unit-test fake was updated to model the persisted owner join and current claim return shape. All focused unit suites pass.

## Test Coverage Summary

- Backend unit tests: Jest, 3 focused suites and 15 tests passed.
- Backend integration tests: Jest, 1 guarded PostgreSQL suite and 3 tests passed; migration 0034 applied and the isolated test database was removed. The new regression proves settled ledger detail retention, in-flight/unknown barriers, unchanged daily/campaign totals and regular/admin/showcase state, and idempotent terminal replay after owner detachment.
- Backend type check: the shared working tree's `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` reports concurrent Task 4.3 task-mutation diagnostics in `src/composition-root.ts`, `src/infrastructure/database/repositories/typeorm-project-task-repository.ts`, `src/modules/home-assistant/use-cases/{home-change-proposal-use-cases,home-planning-tool-request-handler}.ts`, `src/modules/tasks/**`, and related task tests. No diagnostic points to a Task 3.5-owned file. The exact staged commit candidate was checked in a detached HEAD worktree with the staged index overlaid and existing dependencies linked; the same TypeScript command passed there.
- No broad suite or browser test was run.

## Known Limitations / Tech Debt

An unresolved root receipt intentionally keeps cleanup pending until its operation can provide a safe terminal acknowledgment. The integration case explicitly advances the receipt to verified; it does not simulate a real late filesystem call finishing after a process crash. Export and schedule cleanup remain future contributor work. The full shared worktree type check remains non-passing because of the in-progress Task 4.3 task-mutation changes described above; the isolated staged Task 3.5 snapshot passes.

## Ready for QA: YES
