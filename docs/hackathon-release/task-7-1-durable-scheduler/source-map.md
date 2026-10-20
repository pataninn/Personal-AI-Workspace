# Task 7.1 source map

Contract: `contract.md`  
Architecture decision: `architecture-preflight.md`

## New scheduler boundary

- `backend/src/modules/automations/domain/automation-types.ts`: schedule, occurrence, lease fence, and read-only capability types.
- `backend/src/modules/automations/domain/schedule-time.ts`: local calendar date, next occurrence, catch-up, IANA validation, and DST gap/fold resolution using existing Node `Intl` behavior.
- `backend/src/modules/automations/repositories/automation-repository.ts`: owner-scoped schedule commands, bounded claims/heartbeats, dispatch/completion fences, and cleanup/workspace cancellation ports.
- `backend/src/modules/automations/use-cases/`: create/list/update/Run now, due claim, dispatch/replay, poll/reconcile, and cancellation coordination.
- `backend/src/modules/automations/controllers/automation-router.ts`: authenticated Task 7.1 schedule and occurrence routes.
- `backend/src/infrastructure/database/repositories/typeorm-automation-repository.ts`: PostgreSQL transactions, owner/schedule/occurrence lock order, database-clock leases, and `SKIP LOCKED` claims.
- `backend/src/infrastructure/database/migrations/1710000038000-create-automations.ts`: additive schedule/occurrence schema and the minimal Home/skill binding columns needed for final fences. The `data-source.ts` import and registry entry are added after the delivered 0037 migration.
- `backend/src/automations-worker.ts`: standalone signal-aware worker entrypoint using the same application composition/runtime; it never creates an HTTP listener and drains the active pass before closing PostgreSQL.
- `backend/src/infrastructure/startup/application-lifecycle.ts`: selects API-only maintenance or scheduler-only worker startup. Its unit spec proves the modes never start both loops in one process.
- `backend/src/automations-worker.spec.ts`: proves worker-mode composition selection, graceful drain-before-database-close, and cleanup when signal waiting fails.

## Existing integration seams

- `backend/src/modules/skills/use-cases/invoke-skill.ts`: accept only an internal scheduler context, keep the occurrence request key stable, and pass its trusted fence into `SubmitHomeTurnUseCase`.
- `backend/src/modules/home-assistant/use-cases/submit-home-turn.ts`: add a trusted pre-send check and persist the occurrence binding on the Home turn; preserve existing Home policy, context, runtime, skill, credit, and storage gates.
- `backend/src/modules/home-assistant/domain/home-conversation-types.ts`, `repositories/home-conversation-repository.ts`, and `use-cases/get-home-turn.ts`: carry a trusted worker fence for scheduled polling and assistant result commit; ordinary turns remain unchanged.
- `backend/src/modules/home-assistant/use-cases/home-planning-tool-request-handler.ts` and its spec: retain owner-scoped, active, workspace-ID checks while allowing a file-backed workspace to use the same closed Home task/workspace read tools.
- `backend/src/infrastructure/database/repositories/typeorm-home-conversation-repository.ts`: atomically reject scheduled result writes unless the schedule revision, owner/workspace/skill state, occurrence generation/token/lease, and cleanup/expiry state are current.
- `backend/src/infrastructure/database/repositories/typeorm-demo-expiry-cleanup-repository.ts`, `modules/demo/domain/demo-expiry-cleanup-types.ts`, `modules/demo/use-cases/cleanup-expired-demos.ts`: capture exact scheduler IDs in the existing cleanup manifest, cancel linked Home turns outside locks, and block owner purge until all linked work is terminal. Preserve the existing admission → owner → copy order and all settled/unknown ledger rules.
- `backend/src/infrastructure/database/repositories/typeorm-project-removal-repository.ts` and `modules/projects/use-cases/delete-project.ts`: pause/fence workspace schedules before deletion, cancel linked turns outside locks, and reject removal while scheduled Home work remains unresolved.
- `backend/src/composition-root.ts`: add isolated Task 7.1 repository/use-case/router wiring and choose API versus worker maintenance. Preserve active Task 6.3 Home summary wiring.
- `backend/src/server.ts`: start the shared composition explicitly in API mode.
- `backend/src/app.ts`, `backend/openapi.json`: add isolated Task 7.1 router and API contract hunks. Preserve active Task 3.6, Task 4.3, and Task 6.3 hunks.
- `backend/package.json` and `README.md`: expose and document `start:worker`/`dev:worker`; a separate worker process must run with the API's database and application environment.
- `backend/src/infrastructure/database/data-source.ts`: contains only the additive 0038 import and migration-list entry after the existing 0037 entry for Task 7.1.
- Existing `skills`, `home-assistant`, `demo-expiry-cleanup`, `project-removal`, and `periodic-maintenance` Jest specs plus new schedule-time, repository, worker, and integration specs: prove focused domain, fencing, restart, and two-repository-connection behavior. The new scheduler PostgreSQL suite includes a separate Node child-process worker reconciliation case.
- `backend/test/integration/demo-expiry-cleanup.integration.spec.ts`: the one Task 7.1 filtered case covers unknown then confirmed cancellation and settled-credit preservation. Failure-only stage tracing now records workspace inspection, root mapping, project retirement, and storage reconciliation outcomes with safe error metadata only; it excludes SQL parameters and error messages.

## Intended verification

- Focused Jest unit tests: local time/DST/catch-up, schedule validation, request-key replay, lease takeover, stale pre-send/completion rejection, pause/expiry cancellation, and ordinary Home-turn compatibility.
- Focused PostgreSQL integration tests, only after booking the test window: unique occurrence claim under two workers, restart/replay with no second runtime start, cleanup barriers, and known quota/credit/accounting behavior.
- Backend TypeScript typecheck and production build/alias pass include `dist/automations-worker.js`. Focused lifecycle Jest specs verify process-mode selection and graceful cleanup. Current evidence and the exact cleanup filter/skips are in `artifacts/verification-receipt.md`; the top-level receipt retains full attempt history. No frontend, browser, lint, or broad suite was required for this backend-only task.

## Coordination boundaries

- Tasks 3.6 and 4.3 are delivered. Preserve their account-administration and canonical-task-delete behavior in shared app, composition, migration, and OpenAPI files.
- The Task 6.3 owner is adding an owner-scoped persisted skill-run summary projection in Home response/repository/router and frontend files. Preserve that additive work and the Task 7.1 `automationFence`, `automationGuard`, and occurrence-binding hunks.
- Do not stage Task 7.1 changes until independent QA and root grant. The focused PostgreSQL window has been released; do not rerun accepted cases without a new concrete concern.
