# Task 6.4 Pre-review: Bounded workspace export

## Status and scope

Pre-review only; implementation and browser evidence are still in progress. The existing `dev-summary.md` is stale contract-preparation material and is not treated as an implementation handoff. This is not the official QA report and has no PASS/FAIL verdict.

Reviewed current source for owner/session/workspace/expiry fences, structured and file export boundaries, process identity, and exact-ID project-removal/demo-expiry cleanup. No tests, build, browser, database, or provider calls were run for this review.

## Findings

1. **Medium — structured export can include recognizable credentials.** The file exporter applies `containsPotentialSecret` to file contents in `Personal-AI-Workspace/backend/src/infrastructure/workspace/project-file-gateway.ts:242`, but `Personal-AI-Workspace/backend/src/infrastructure/database/repositories/typeorm-workspace-export-repository.ts` projects persisted task, fact, context, project/Home conversation, and skill text directly in its snapshot readers (`:239`, `:255`, `:268`, `:276`, `:288`, `:300`). Recognized credential material in those fields can therefore enter the download despite the contract/UI disclosure that known credentials and secrets are excluded. Apply the existing bounded secret helper to exported structured text and add a focused omission fixture; retain the documented limit that arbitrary user-authored secrets cannot be detected.

2. **Medium — expiry relies on API process time while TTL is created using database time.** Publication and active-count decisions use PostgreSQL `clock_timestamp()` (`Personal-AI-Workspace/backend/src/infrastructure/database/repositories/typeorm-workspace-export-repository.ts:85`, `:127`), while replay uses `Date.now()` (`Personal-AI-Workspace/backend/src/infrastructure/database/repositories/typeorm-workspace-export-repository.ts:347`) and download binds an API-generated `Date` (`Personal-AI-Workspace/backend/src/modules/workspace-exports/use-cases/download-workspace-export.ts:13`, repository `:151-158`). With API/DB clock skew, an export may remain downloadable past database expiry or an expired artifact may be returned as a stale replay descriptor. Use one authoritative database-clock comparison for replay and download expiry.

## Bounded lifecycle review

- Create registration is scoped to `(ownerId, workspaceId)`, locks the active workspace and owner, rejects a removal/demo-cleanup barrier, and counts only that owner’s building or unexpired-ready rows (`Personal-AI-Workspace/backend/src/infrastructure/database/repositories/typeorm-workspace-export-repository.ts:57-89`). The read-only repeatable-read snapshot rechecks active owner/workspace state and scopes each projection by owner/workspace (`:92-115`, `:239-318`). Publication and download repeat the active-account, active-workspace, expiry, removal, and demo-cleanup checks (`:127-160`).
- File enumeration is rooted through the existing owned-project boundary; it rejects symlinks/reparse points, uses no-follow descriptors, validates stable file identity, applies path protections, and enforces the file/count/aggregate/deadline bounds (`Personal-AI-Workspace/backend/src/infrastructure/workspace/project-file-gateway.ts:52-64`, `:175-260`). Protected path names are omitted. The structured-content secret gap is the finding above.
- Project removal captures export IDs under its existing project/removal transaction and persists them on that project’s job (`Personal-AI-Workspace/backend/src/infrastructure/database/repositories/typeorm-project-removal-repository.ts:296-308`); both retry and normal completion wait for those exact IDs before purge (`:379-399`, `:450-453`). Demo expiry captures owner export IDs while locking the owner and stores them in `manifest.exportIds` (`Personal-AI-Workspace/backend/src/infrastructure/database/repositories/typeorm-demo-expiry-cleanup-repository.ts:105-184`), then waits before owner purge (`:293-296`). The cleanup helper only marks a builder terminal when its process is absent or its PID is proven reused; unknown or active writers stay pending, and wait timeout does not unlink or purge (`Personal-AI-Workspace/backend/src/modules/workspace-exports/use-cases/reconcile-workspace-exports.ts:31-60`). No exact-ID or timeout-as-proof defect was found in this bounded review.

## Evidence and limits

The current task brief reports three PostgreSQL lifecycle/authentication/idempotency/cache/fence cases passing with a process-memory artifact port on Windows, and separate unit coverage of the production Linux artifact/process probe. Those are reported results, not runs performed by this reviewer. They do not establish live Linux cleanup behavior. The developer still owns refreshing implementation evidence and completing the required browser/runtime evidence before official QA.

## Handoff

The two findings above were sent directly to `developer_export_luna` and `/root` on 2026-10-20. The developer acknowledged both and is adding focused fixes and regression cases. Re-review the changed lines and refreshed proof before the official QA cycle.
