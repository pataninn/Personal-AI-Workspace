# Dev Summary: Atomic credit reservations and runtime metering

## Change History

- 2026-10-19: Implementation and final backend validation completed; ready for independent QA.

## What Was Implemented

- Added integer-only, versioned per-call credit calculation and IANA local-day window logic, including daylight-saving transitions and queued timezone changes.
- Added an additive PostgreSQL credit ledger with account/daily/demo counters, immutable price/token-bound snapshots, run attempt budgets, idempotent usage entries, and a global inference pause.
- Added a transactional admission/settlement use case and repository. Admission locks policy and account counters in a deterministic order, reserves the maximum amount before transmission, and never holds database locks across inference.
- Added fail-safe settlement for a valid usage report whose computed charge exceeds PostgreSQL bigint: exact token counts are retained on an unknown reservation, the maximum reservation remains held, and inference is paused atomically without writing an invalid charge.
- Added independent-account concurrent tests for deployment-wide demo daily and campaign caps.
- Wired the direct provider to require explicit price/cap configuration, a verified request-specific input bounder, and successful admission before POST. It enforces an output cap and retains unknown charges after a request may have been sent.
- Kept project Hermes and Home-planning Hermes fail-closed before bridge creation because current egress cannot guarantee that every actual model attempt/retry passes admission. Production composition does not enable the internal bridge-admission flag. Unsupported OpenShell remains unavailable.
- No user/API DTO or public OpenAPI contract changed. No live provider calls or production prices were used.

## Files Changed

### Backend

- New `backend/src/modules/credits/**` domain, repository interfaces, admission use case, and focused Jest specs.
- New `backend/src/infrastructure/database/migrations/1710000028000-create-credit-ledger.ts` and migration rollback spec; new TypeORM credit repository.
- Updated provider configuration, composition root, direct provider request model, NVIDIA provider, and Hermes project/Home runtime gates with focused specs.
- New PostgreSQL coverage in `backend/test/integration/credit-ledger.integration.spec.ts`.
- Updated the R1 populated-migration integration fixture to locate the ownership-boundary migration and unwind later additive migrations while preserving its existing owner/session/data and rollback assertions.
- Shared `backend/src/infrastructure/database/data-source.ts`: Task 3.1 adds the 0028 migration. The current worktree also includes Task 3.2's 0029 import/registration; it is outside this task and must remain excluded from Task 3.1's exact staged diff.

### Frontend

- No Task 3.1 frontend changes.

### Docs

- Updated repository `README.md` with the six-field all-or-none credit configuration, fixed integer units, paused/unconfigured defaults, and the current paid-inference fail-closed limits.
- `contract.md`, this summary, and implementation/validation/review/manifest evidence under this task's `artifacts/` directory.
- Reviewed historical snapshots under `docs/hackathon-release/`: architecture, task tracker, the relevant runtime-metering preflight, and this task's contract, QA report, summary, and safe evidence.

## Contract Notes

- Credit unit is one-millionth of one displayed credit. Each token-side charge is rounded up independently using `BigInt` and integer rates per million tokens.
- Null daily/lifetime limits mean unlimited; zero denies. Demo usage uses deployment-wide UTC daily and campaign limits. Missing demo configuration denies demo inference.
- Timezone changes take effect at the next midnight in the old zone; reservations settle into the window captured at admission.
- After a POST may have begun, missing, malformed, partial, or unverified usage keeps the maximum reserved as unknown. Known-not-sent calls can release it. Representable over-bound usage is charged as reported and pauses subsequent admission. A charge above PostgreSQL bigint retains the reported token counts and reservation as unknown, pauses subsequent admission, and awaits trusted reconciliation; it is never truncated or written as a valid charge.
- This implementation does not enable production inference by guessing rates, endpoint context limits, or tokenizer behavior.

## Architecture Alignment Notes

- Domain/application layers own integer calculations, time windows, and admission intent; TypeORM implements the repository and migration.
- Provider adapters receive only the admission port. Database ownership comes from the trusted persisted run request.
- The global policy lock provides deterministic account-budget admission and settlement; no transaction crosses model inference or bridge work.
- The singleton policy row starts paused. Direct requests fail closed without a verified bounder; Hermes project/Home fail closed before create because alternate network egress is not blocked by an admission token.
- Task 3.2 extends the same `account_limits` row with storage policy in migration 0029; its source and registration remain separately owned.

## Evidence Collected

- `artifacts/developer-focused-checks.txt`: focused and broad Jest totals, final backend typecheck, credit-ledger (1/7), R1 migration fixture (1/3), and full isolated PostgreSQL (24/98) evidence through migration 0029.
- `artifacts/developer-source-manifest.txt`: task-owned source paths and shared-file/exclusion boundary.
- `artifacts/developer-self-review.md`: review findings and open verification.
- `artifacts/runtime-hook-feasibility.md`: pinned Hermes runtime/source feasibility research by `developer_home_luna`.
- `artifacts/qa-early-review.md`: tester read-only preflight notes.
- `artifacts/qa-postgres-focused-rerun.txt` and `qa-report.md`: independent guarded PostgreSQL rerun and final QA PASS report.
- `artifacts/isolated-staged-tree-validation.txt`: typecheck and guarded PostgreSQL checks against the exact staged Task 3.1 source tree, with storage migration 0029 absent.
- No paid provider call or live endpoint evidence. No Context7/Chrome evidence was needed because there is no browser-facing Task 3.1 UI or new third-party behavior.

## MCP Notes

- No MCP-based browser or provider session was available or needed for this backend-only task. The pinned runtime feasibility research is a local source/documentation review.

## Code Review Findings (and resolutions)

- Direct paid provider work is blocked without explicit pricing, an output cap, a request-specific verified input bound, and database admission. Hermes and Home-planning remain disabled until the actual all-egress call boundary enforces admission and usage capture.
- Unknown post-send usage retains the full reservation. Representable over-bound usage is recorded at its actual charge and pauses further calls; an unrepresentable bigint overflow is recorded as unknown with exact token counts and pauses admission atomically.
- Database locks are short-lived and deterministic; no account lock spans inference.
- The populated-migration regression retains its original ownership, identity, session, and legacy-data checks while adapting the rollback portion to migrations added after the ownership boundary.
- See `artifacts/developer-self-review.md` for the full self-review.

## Test Coverage Summary

- Jest unit: the focused credit suites passed 9 suites / 81 tests; the complete backend unit suite passed 129 suites / 770 tests.
- Jest integration: the credit-ledger PostgreSQL suite passed 1 suite / 7 tests; the populated migration fixture passed 1 suite / 3 tests; the complete guarded isolated-PG suite passed 24 suites / 98 tests with migrations 0028 + 0029.
- Backend TypeScript typecheck passed after the final source and fixture edits.
- `git diff --check` passed after final source and evidence updates.
- Broad Jest totals were collected from the shared worktree, which also contained the uncommitted Task 3.2 storage foundation. Those storage files and the 0029 registration are excluded from the Task 3.1 source manifest and commit boundary.

## Known Limitations / Tech Debt

- No verified tokenizer/input-token upper bound is implemented for the hosted direct model; therefore direct provider POST remains fail-closed in composition.
- The Hermes bridge does not provide a non-bypassable single egress boundary with per-attempt admission/usage. Project and Home Hermes remain unavailable until this enforcement exists.
- Prices, account limits, campaigns, and usage reconciliation are operator-managed; there are no real production price values, admin UI, historic backbilling, or billing reconciliation input in this task.
- Unknown charges remain reserved pending a trusted operator/reconciliation process.
- Task 3.2 is active in this shared worktree. Its migration 0029 source and data-source registration must be excluded from Task 3.1 commit staging while preserving the worktree edits.

## Ready for QA: YES

All required backend checks have passed. Task 3.2 migration source and its registration remain separate worktree changes and are excluded from the Task 3.1 implementation manifest except that final integration evidence was run against the currently registered full chain.
