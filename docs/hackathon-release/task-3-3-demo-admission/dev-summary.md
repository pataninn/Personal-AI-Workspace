# Dev Summary: Private demo admission

## Change History

- 2026-10-19: Implemented anonymous idempotent demo admission, private storage-ready provisioning, abuse counters, session resume/conflict behavior, and the required demo run-start gate. Updated the run-start contract after source precheck to count only after a successful atomic ready-to-queued transition.

## What Was Implemented

- Added `POST /api/v1/demo/session` with strict empty-body validation, exact same-origin checking, existing CSRF handling for authenticated POSTs, and the established opaque session cookie.
- Added persistent globally unique idempotency digests, database-clock session expiry, fixed-window global/network admission counters, bounded provisioning attempts, and per-owner demo run-start admission.
- New accounts are created as pending with `account_limits`, then checked and reconciled as a genuinely empty account before a single session and ready state are committed. Valid demo sessions resume without extending expiry; regular sessions are preserved and receive a conflict.
- Replays without a valid demo cookie reveal only generic status. Pending work is never resumed by replay, and neither pending nor failed status can mint a cookie.
- The required run-start gate runs after permission checks and the repository's atomic `ready -> queued` transition, but before publication or runtime dispatch. A denied admission conditionally aborts only its matching queued transition. Cancellation or a competing state transition that wins first is not charged.
- Added operator configuration and setup documentation for the dedicated network HMAC secret, admission windows, session lifetime, and trusted proxy CIDRs. No production secret or numeric abuse defaults are supplied.

## Files Changed

### Frontend

- None for this task. Existing unrelated AI-run changes are preserved and excluded.

### Backend

- `.env.example`
- `README.md`
- `backend/openapi.json`
- `backend/src/app.ts`
- `backend/src/composition-root.ts`
- `backend/src/infrastructure/ai-runs/in-memory-ai-run-repository.ts`
- `backend/src/infrastructure/config/app-config.spec.ts`
- `backend/src/infrastructure/config/app-config.ts`
- `backend/src/infrastructure/database/data-source.ts`
- `backend/src/infrastructure/database/migrations/1710000031000-create-demo-admission.ts`
- `backend/src/infrastructure/database/repositories/typeorm-ai-run-repository.ts`
- `backend/src/infrastructure/database/repositories/typeorm-demo-admission-repository.ts`
- `backend/src/infrastructure/database/typeorm-demo-storage-bootstrap.ts`
- `backend/src/modules/ai-runs/repositories/ai-run-repository.ts`
- `backend/src/modules/ai-runs/use-cases/ai-run-use-cases.spec.ts`
- `backend/src/modules/ai-runs/use-cases/change-set-use-cases.spec.ts`
- `backend/src/modules/ai-runs/use-cases/sandbox-command-use-cases.spec.ts`
- `backend/src/modules/ai-runs/use-cases/start-ai-run-use-case.spec.ts`
- `backend/src/modules/ai-runs/use-cases/start-ai-run-use-case.ts`
- `backend/src/modules/demo/controllers/demo-admission-router.ts`
- `backend/src/modules/demo/domain/demo-admission-errors.ts`
- `backend/src/modules/demo/domain/demo-admission-types.ts`
- `backend/src/modules/demo/index.ts`
- `backend/src/modules/demo/use-cases/create-demo-session.spec.ts`
- `backend/src/modules/demo/use-cases/create-demo-session.ts`
- `backend/src/openapi/demo-admission-openapi.spec.ts`
- `backend/test/integration/ai-runs.integration.spec.ts`
- `backend/test/integration/demo-admission-http.integration.spec.ts`
- `backend/test/integration/demo-admission.integration.spec.ts`
- `backend/test/integration/ownership-boundaries-http.integration.spec.ts`
- `backend/test/integration/r1-populated-migration.integration.spec.ts`
- `backend/test/integration/sandbox-commands.integration.spec.ts`

### Docs

- `.codex/docs/hackathon-release/task-3-3-demo-admission/architecture-preflight.md` (aligned pending replay wording with the architecture decision)
- `.codex/docs/hackathon-release/task-3-3-demo-admission/contract.md`
- `.codex/docs/hackathon-release/task-3-3-demo-admission/dev-summary.md`
- `.codex/docs/hackathon-release/task-3-3-demo-admission/artifacts/final-verification.md`

Operational setup changes are listed above: `.env.example`, `README.md`, and `backend/openapi.json`. The environment example contains placeholders only.

## Contract Notes

- `POST /api/v1/demo/session` accepts `{}` and a 43-character base64url idempotency key only for anonymous admission. It returns a cookie only to the original request that successfully finishes provisioning, or reuses the current valid demo cookie.
- The request-key digest is globally unique and independent of network identity. Cookie-less replay returns generic pending/ready status; a failed replay returns generic failure. The key never grants session recovery.
- The seven abuse settings are all-or-none. If any are missing or invalid, new anonymous admission and demo AI starts both fail closed. Valid existing demo sessions can still resume and use non-AI routes; same-key replay remains status-only. Regular accounts bypass the demo run-start counter.
- Task 3.4 owns showcase publication/copying; Task 3.5 owns durable cleanup of expired pending/failed admissions. Neither is claimed implemented here.

## Architecture Alignment Notes

- The route and use case depend on domain ports; TypeORM owns counter/idempotency transactions and account/session persistence.
- Account creation commits pending state before storage reconciliation; no database lock spans storage I/O. The final pending-to-ready transition and session insertion are atomic.
- A committed run transition precedes per-owner rate counting. Permission denial, cancellation-before-transition, and competing starts cannot consume a run-start slot. A quota refusal uses a conditional `abortStart` keyed to the same owner/run/idempotency fingerprint; a concurrent cancellation remains intact.
- Proxy identity comes only from Express `request.ip` with validated explicit CIDR trust. The application does not parse forwarded headers or store/log raw IP, raw idempotency key, or secret.
- Credit/provider authorization remains separate. No provider call or spend is part of demo admission.

## Evidence Collected

- `artifacts/final-verification.md`: final TypeScript, Jest unit, Jest integration, guarded PostgreSQL, database disposal, and diff-check results.
- `artifacts/architecture-implementation-precheck.md`: independent source-only precheck; its run-start finding is resolved by the required gate and guarded cancellation race test.
- The integration and PostgreSQL runs use fake runtimes; they make no live provider call and expose no fixture URL or credentials.

## MCP Notes

- No Context7 or browser MCP was needed: this is a backend-only flow with no new UI rendering behavior. No live external/provider behavior was requested or exercised.

## Code Review Findings (and resolutions)

- The source precheck found run-start counters were charged before provider permission checks and the state transition. Admission now runs only after permission validation and the atomic transition; conditional abort restores ready state if the gate denies. The gate and repository transition are required dependencies, so production composition cannot silently omit either.
- Same-key admission replay is status-only and never reissues a cookie or resumes bootstrap, matching the architecture decision. The contract and preflight wording were aligned.
- Review confirmed raw request keys, IP addresses, secrets, network hashes, and storage paths are not exposed in the response contract or added to logs.

## Test Coverage Summary

- Backend TypeScript: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` — passed.
- Backend unit: Jest `jest.config.cjs` full suite — 140 suites / 838 tests passed. Final focused run-start/auth suite — 4 suites / 81 tests passed.
- Backend integration: Jest `jest.integration.config.cjs` full suite — 31 suites / 114 tests passed. The demo HTTP suite is included and also previously passed focused at 1 suite / 6 tests.
- Guarded PostgreSQL demo admission suite — 1 suite / 3 tests passed. This verifies same-key cross-network creation/status-only replay, persistent caps and rotation behavior, ready storage initialization, and a cancellation committed before `beginStart` producing no run-start event or runtime dispatch.
- The first broad integration attempt exposed an incomplete R1 test fixture: its demo admission repository omitted test limits and correctly failed closed. The fixture now supplies explicit bounded test-only limits; the final full integration run passed without relaxing production behavior.
- `git diff --check` — exit 0. Git reported the existing `backend/openapi.json` CRLF normalization warning; no whitespace error was reported.

## Known Limitations / Tech Debt

- No real network/proxy topology or operator-provided HMAC secret/configuration was available; the app defaults to no trusted forwarded headers and new admission stays fail-closed until configured.
- No browser flow or public deployment was exercised. No provider credentials, paid runtime calls, or guessed production rate values were used.
- Showcase content readiness and expired pending/failed-account cleanup remain explicit later-task work.

## Ready for QA: YES
