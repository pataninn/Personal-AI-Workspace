# Dev Summary: Confirm baseline and define screen states

## Change History

- 2026-10-19: Developer established a read-only application baseline and recorded existing failures. No application implementation or commit performed.

## What Was Implemented

Baseline documentation and live unauthenticated screenshots only. The actual planned folder is `task-1-1-baseline-and-ui-spec`. UI specification belongs to designer-ui-ux; this report does not claim release screens have been implemented.

## Files Changed

Docs/evidence created by developer:

- `.codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/dev-summary.md`
- `.codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/artifacts/git-status-before.txt`
- `.codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/artifacts/baseline-check-results.txt`
- `.codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/artifacts/live-login-desktop.png`
- `.codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/artifacts/live-login-mobile.png`

No application source/config changes. Typecheck generated `frontend/tsconfig.node.tsbuildinfo`; developer restored ONLY that previously clean generated file from HEAD. Original six dirty/untracked application files remain preserved. No new endpoints.

### Git and preserved work

Workspace root and `.codex/` are not Git repositories. Application Git root is `C:/Users/patan/OneDrive/Me/new/AI asssistance/Personal-AI-Workspace`, branch `feature/home-assistant-chat`, HEAD `e31322f44b9b39ad2542334ea9408393a69361ae`. Only command-scoped safe.directory exceptions were used; no global Git setting changed.

Existing work, ownership unknown and presumed user-owned:

- Modified: `frontend/src/features/ai-run/model/use-ai-run-timeline.ts`
- Modified: `frontend/src/features/ai-run/model/use-direct-chat-consent.ts`
- Modified: `frontend/src/features/ai-run/model/use-direct-chat.ts`
- Modified: `frontend/src/features/ai-run/ui/AiRunTimeline.spec.tsx`
- Untracked: `frontend/src/features/ai-run/model/use-direct-chat.spec.tsx`
- Untracked: `ponytail-review.md`

Tracked baseline diff: 47 insertions / 19 deletions across four files, excluding untracked contents. Future automatic-tool/chat changes overlap these files; preserve and isolate existing hunks. Commit application work in the inner repository only, after tester PASS and PM instruction. Follow the architecture document's durable sanitized snapshot approach for canonical docs outside Git; do not initialize an outer repository. Commit messages omit task numbers/bracket tags; task/hash mapping stays in docs.

## Contract Notes

Task 1.1 has no new contract. Existing API prefix is `/api/v1`, Express controllers validate with Zod; writes require server session, Origin and CSRF checks. Global task mutation routes support create/patch/move/archive, while project-scoped task routes also expose DELETE. The project DeleteProjectTaskUseCase delegates to mutations.archive when the shared command dependency is wired (repository delete fallback otherwise); therefore the DELETE route does not by itself prove permanent deletion. Global mutation handlers use version/idempotency checks. Task archive removal must reconcile both command surfaces and historical ledger/undo behavior.

Auth currently exposes `findActiveLocalUser`, `findActiveLocalUserById`, `createLocalUser`; login and bootstrap select the single active local user. This cannot supply regular/demo/admin identities without persistence and contract changes. Existing secure session behavior should be extended, not replaced by browser-owned identity.

## Architecture Alignment Notes

Release architecture sections 2-10 were reviewed. Source remains React/Vite FSD frontend and Express/TypeORM modular backend with PostgreSQL. Current source baseline:

| Release flow | Existing owner / callers | Required follow-on |
| --- | --- | --- |
| Home/Ask/history | pages/dashboard, widgets/home-chat, features/home-chat, entities/home-conversation; backend home-assistant | Move inline Home assistant to launcher, preserve draft/history; replace consent states |
| Task forms/actions | pages/task-detail, pages/all-tasks, features/task-actions, features/task-capture, features/project-tasks; modules/tasks | Immediately editable details, dirty exit, canonical delete |
| Archive | global-task-router, project-task-router, global-task-query-use-cases, task mutation commands; Home planning validation/handler/proposals/action undo; frontend task-actions/project-tasks and entity APIs | Migrate/remove task archive across routes, tools, ledger, filters and tests; workspace archive is separate behavior |
| Approvals | Home conversation consent routes, decide-home-consent, home-tool-result-consent-gate, home-change-proposal-use-cases; frontend home-chat and ai-run consent/change review | Stored authorized scope with automatic canonical mutations; preserve containment/redaction |
| Identity/demo/admin | modules/auth single-local-user lookup and bootstrap; session middleware; no release demo/admin workflow | Owner-preserving migration, account namespace, session/expiry controls before demo exposure |
| Memory/context | features/project-memory, features/project-context, modules/project-facts and AI context composition | Visible current facts and permitted context shared by future runs |
| Skills/automations/usage/export | Existing runtime skill assets, provider usage migration and AI runs | User skill definitions, bounded per-call reservations, durable worker/schedules/export are release additions |

Migration source files range through `1710000025000-create-home-change-proposals.ts`. Their existence and passing migration unit tests do not establish live database applied state. No migrations executed during baseline.

## Evidence Collected

All paths are relative to workspace root under `.codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/artifacts/`:

- `git-status-before.txt`: original six-file application worktree inventory.
- `baseline-check-results.txt`: commands, totals, runtime observations and unavailable evidence.
- `live-login-desktop.png`: real local app login, 1440x1000, Playwright CLI dependency and installed Chrome.
- `live-login-mobile.png`: same real login at 375x812.

Browser reached `https://127.0.0.1:8443/login`, title Personal AI Workspace, one labelled password input. Local screenshots used `ignoreHTTPSErrors: true`; this is NOT trusted public HTTPS evidence. No login credentials or provider secrets emitted, no owner data modified, and no inference requested. Authenticated desktop/mobile Home, keyboard/task-detail and dirty-exit screenshots are not claimed here; they require designer/tester evidence using safe fixtures or private authentication. Existing preview tests are simulated APIs, not live provider proof.

## MCP Notes

Playwright MCP, Chrome DevTools MCP and Context7 are not exposed in this agent's callable tool inventory. Context7 and DevTools are N/A for Task 1.1. Installed Playwright 1.63.0 and Chrome provided the limited live login fallback. No MCP session was fabricated.

Default sandbox Docker/WSL reads were denied; scoped read-only escalation succeeded: app and PostgreSQL containers healthy, Ubuntu and docker-desktop WSL distributions present, Chrome installed. Loopback listeners at 8443 (app), 17871 (bridge), 5432 (database); isolated test port 55441 absent. Runtime observations do not prove bridge authentication, provider connectivity, full migration state or scheduled execution.

## Code Review Findings (and resolutions)

Documentation-only self-review completed using coding-standards, ponytail and code-review skills. No source change proposed or hidden baseline repair performed.

- Existing boundary check failure: test assumes NVIDIA secret in default compose, while current default uses Hermes bridge. Reconcile actual supported default/direct topologies in deployment work; do not weaken secret isolation checks simply to pass.
- Existing filesystem unit test exceeded its 5000ms timeout during concurrent baseline checks. Exact failing test recorded below; distinguish possible host contention from a product regression. Focused serial rerun can diagnose it during QA without silently changing timeout.
- PostgreSQL integration skips remain unverified, not successes. Provision isolated guarded test database/port before identity/transaction implementation and run these suites genuinely.
- Plain pnpm commands triggered dependency verification auto-install, registry fetch failure and non-TTY purge abort. Process-only `pnpm_config_verify_deps_before_run=false` used installed dependencies without deleting/reinstalling node_modules or changing config.

## Test Coverage Summary

Runtime: Node v22.20.0 (matches engine >=22.20 <23), pnpm.cmd 11.8.0 (matches package pin). PowerShell pnpm.ps1 is blocked by execution policy, so use pnpm.cmd. No linting used.

| Command / runner | Baseline outcome |
| --- | --- |
| `pnpm.cmd typecheck` with process-only dependency verification disabled | PASS frontend/backend |
| `pnpm.cmd test` frontend Vitest 3.2.7 | PASS 57 files, 286 tests |
| frontend additional Node preview suite | PASS 25 tests |
| `pnpm.cmd test` backend Jest | FAIL 1 suite / 1 test; PASS 110 suites / 666 tests; 111 suites / 667 tests total |
| `pnpm.cmd test:integration` Jest | PASS 13 suites / 63 tests; SKIP 6 suites / 16 tests (79 total), no isolated PostgreSQL URL |
| `node --test scripts/compose-boundary-check.test.mjs` (exact package script body) | FAIL 1, PASS 6, total 7 |
| Browser CLI read-only capture | PASS live login desktop/mobile; full E2E suite not executed |

Backend failing test: `src/infrastructure/workspace/workspace-mutation-gateway.spec.ts:41`, `WorkspaceMutationGatewayAdapter > applies create, edit, overwrite, rename, and delete with exact hashes and recovery backups`, exceeded 5000ms. Test run: 81.69s. Integration run: 82.946s. Frontend Vitest run: 70.87s. React Router future-flag warnings appeared; no frontend failure.

PostgreSQL suites skipped: home-consent, home-conversation-events, home-planning-command-parity, home-planning-proposal-execution, r1-populated-migration, r1-release-http-postgres. Guarded `HOME_CONVERSATION_TEST_DATABASE_URL` must target isolated `home_test`/`home_history_test` loopback database; populated migration/release suites require port 55441. Never point them at owner application DB.

## Known Limitations / Tech Debt

Baseline app is running but deployed build freshness against this dirty checkout is unverified. Default Compose exposes only loopback HTTPS, app+Postgres services, read-only app root, recovery storage and private bridge mTLS mounts; no durable release scheduler/worker or public trusted certificate is proven. Provider profile/model defaults in source are not a bounded real inference result. No host/domain, pricing/budgets or showcase contents were invented.

Next steps: combine designer ui-spec and authenticated/fixture screen evidence; tester reviews Task 1.1 with known failures retained. Then developer writes Task 2.1 contract before implementation, migrates existing identity/password/data to admin exactly once, adds account states/kinds/roles with explicit isolation contracts, and provisions safe PostgreSQL integration fixtures. Later tasks resolve baseline deployment expectation and automatic approval/archive paths through their owning changes.

## Ready for QA: YES (baseline documentation review only)

Baseline documentation is ready for independent Task 1.1 QA. Application release readiness remains NO: baseline tests fail and PostgreSQL/live authenticated evidence is incomplete. Tester must distinguish accepted baseline findings from release readiness. Designer/tester fixture browser evidence is separate from this developer live login baseline. No implementation/commit may be inferred from this report.
