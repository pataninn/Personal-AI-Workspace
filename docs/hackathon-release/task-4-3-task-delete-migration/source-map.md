# Source Map: Task 4.3 canonical task delete

## Baseline

- Task 4.2 is delivered at 00e40200ad40ddda73605295b151f42e90466690.
- Task 4.2 already uses the action ledger for owner-scoped idempotency, atomic receipts, expected-version checks, and Home provenance.
- The former project-scoped DELETE adapter called archive in production and had a physical-delete fallback. The global task router now owns canonical DELETE for assigned and unassigned tasks.
- Legacy archived task rows share the task table with live tasks. Migration 1710000036000 converts them before replacing task status storage and ordering indexes.

## Backend ownership

- Task/query domain: backend/src/modules/tasks/domain/project-task.ts, global-task-query.ts, global-task-query-errors.ts, global-task-query-cursor.ts, backend/src/modules/tasks/use-cases/global-task-query-use-cases.ts, and backend/src/modules/tasks/repositories/global-task-query-repository.ts. Remove task archived status, archivedAt, and archived task-status filters while preserving includeArchived for archived workspace visibility.
- Canonical mutation contract: backend/src/modules/tasks/use-cases/task-mutation-use-cases.ts and backend/src/modules/tasks/repositories/task-mutation-participant.ts. Add delete input/result/fingerprint and route all callers through the ledger participant.
- TypeORM mutation: backend/src/infrastructure/database/repositories/typeorm-project-task-repository.ts and backend/src/infrastructure/database/repositories/typeorm-task-mutation-participant.ts. Lock owner/collection/task, validate expected version, delete the row, compact surviving positions, bump collection order version, scrub prior task reversible fields, and return a minimal non-reversible receipt result. Remove archive-only participant and undo branches.
- HTTP: backend/src/modules/tasks/controllers/global-task-router.ts adds versioned DELETE /tasks/:taskId. backend/src/modules/tasks/controllers/project-task-router.ts and backend/src/modules/tasks/use-cases/project-task-use-cases.ts remove the scoped DELETE adapter and its physical-delete fallback. Remove its composition wiring from backend/src/composition-root.ts as one coordinated isolated hunk.
- Ledger/undo: backend/src/modules/action-ledger/domain/action-ledger-types.ts, backend/src/modules/action-ledger/repositories/action-ledger-undo-repository.ts, backend/src/modules/home-assistant/use-cases/action-undo-use-cases.ts, and backend/src/infrastructure/database/repositories/action-ledger-persistence-mappers.ts. Keep historical task.archive receipt parsing/read access; prevent archive undo, parse task.delete, and resolve exact delete/undo receipts without reading or changing their targets.
- Home: backend/src/modules/home-assistant/use-cases/home-planning-command-validation.ts and its spec, plus backend/src/modules/home-assistant/use-cases/home-planning-tool-request-handler.ts. Add home_delete_task and remove home_archive_task. Preserve the concurrent Task 6.2 invocation binding/capability gate and run it, the current policy check, and principal checks before exact receipt replay.
- OpenAPI/bridge: backend/openapi.json and deploy/hermes-bridge/runtime/home_tool_schemas.py. Remove task archive operations/status/filter inputs and document canonical DELETE/Home delete, preserving Task 6.2 skill endpoint/schema hunks.
- Migration: add backend/src/infrastructure/database/migrations/1710000036000-canonical-task-delete.ts and focused migration/repository coverage. The Task 3.6 `bootstrapSettings` refactor in `backend/test/integration/r1-populated-migration.integration.spec.ts` is excluded; that test has no Task 4.3 hunk. It rebuilds the task-status and action-kind enum dependent indexes/constraint, converts archive rows without content loss, and retains its metadata-only rollback map after task deletion; a later rollback fails if any mapped task was deleted or changed. The registry insertion in backend/src/infrastructure/database/data-source.ts follows 0035. Never modify migrations 0034 or 0035.

## Frontend ownership (Feature-Sliced Design)

- Entity: frontend/src/entities/project-task/model/types.ts, model exports, frontend/src/entities/project-task/api/global-task-api.ts, project-task-api.ts, and their focused specs. Use canonical global DELETE for both project and Inbox task actions; remove task archive shapes and includeArchived query fields.
- All tasks: frontend/src/features/global-task-query/model, ui/GlobalTaskFilters.tsx, ui/GlobalTaskList.tsx, and pages/all-tasks/AllTasksPage.tsx remove archived task status/filter support.
- Task detail: frontend/src/pages/task-detail/TaskDetailPage.tsx replaces archive with delete, retains a stable idempotency key for an uncertain retry, shows one accessible AlertDialog confirmation, handles conflict/not-found/uncertain results, and returns to the originating list after a known success. Keep task edit/save/dirty-navigation changes for Task 5.3.
- Project task lists: frontend/src/features/project-tasks/ui/ProjectTaskFilters.tsx, ProjectTaskItem.tsx and focused tests, and model/use-project-task-actions.ts remove archived task filters/fields while retaining delete confirmation and archived-workspace read-only state.
- Do not change project, conversation, or workspace archived status behavior.

## Focused verification

- Backend unit coverage: delete command fingerprint/idempotent result, stale version, ledger scrub/no undo, collection compaction, and exact retry.
- Guarded PostgreSQL regression: legacy archived-row conversion and rollback mapping; rootless plus workspace deletion, checklist/event cleanup, suggestion history, owner isolation, race, same-key replay, stale conflict, and no task resurrection. Requires root approval and the established same-process preflight/separate-process postguard.
- Frontend Vitest coverage: archived filter/status removal, delete action/API path and confirmation cancel/failure/success states, including a detail-page smoke test. No Task 5.3 editor behavior is included.
- OpenAPI/task/tool checks: no task archive endpoint/tool/schema remains; workspace archive remains unchanged.
- Context7, Chrome DevTools MCP, and Playwright MCP are N/A for this task. Browser verification is not required by the task brief.
