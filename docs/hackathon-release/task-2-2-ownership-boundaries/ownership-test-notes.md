# Task 2.2 ownership integration test notes

## Status

The PostgreSQL ownership integration spec and populated-legacy/expiry migration spec have passed against the guarded disposable PostgreSQL fixture. The final serialized backend integration run passed 22 suites / 88 tests. This includes fresh-schema migration-before-bootstrap, populated legacy mapping/continuity and expiry-before-late-output checks, plus the dedicated composite ownership integration spec. QA independently reran the two focused specs and passed 2 suites / 5 tests; see `artifacts/qa-postgres-focused-rerun.txt`.

## Coverage and guards

- The spec uses createDataSource with synchronize disabled and runs the complete configured migration set on a disposable database named home_history_task_2_2_ownership_test.
- Before creation it validates the configured test URL uses PostgreSQL on loopback port 55441, base database home_history_test, role home_test, has CREATE DATABASE privilege, and that the exact target database does not already exist.
- Cleanup is limited to the database created by this spec. Before dropping, it revalidates the base database and role and verifies the target database owner is home_test.
- Valid parent fixtures include a local admin, a second regular account, two projects owned by the first account, and one project owned by the second.
- Positive controls create a conversation under its matching owner/project and an AI run linked to its own same-project conversation.
- Negative cases require PostgreSQL SQLSTATE 23503 and the named composite constraints FK_conversations_project_owner and FK_ai_runs_conversation_scope. The AI-run mismatch uses two different projects owned by the same user so owner-only validity cannot make the fixture fail.

## Intended guarded command

Load HOME_CONVERSATION_TEST_DATABASE_URL into the test process from the restricted local test environment without echoing the environment file or its values. From backend/, run:

$env:pnpm_config_verify_deps_before_run='false'; pnpm.cmd exec jest --config jest.integration.config.cjs --runInBand --runTestsByPath test/integration/ownership-boundaries.integration.spec.ts

This command was run against the isolated fixture after migration readiness and the serialized database window were confirmed. The ownership spec passed as part of the final full integration run (22 suites / 88 tests). No database URL or credential is recorded here.

## Fixture-shape alignment

The shared-worktree fixture update is complete. Project fixtures now carry `storageKind` consistent with their root, AI-run creation fixtures provide `storageKind`, project repository creation provides its required `id`, session principals include `accountKind` and `role`, and user repository fixtures implement `findBootstrapOwnerId`. TypeORM project repository expectations include the storage-kind insert value and the six-value managed-root attachment parameter layout while retaining the owner-scoped assertion.

Focused validation passed:

- Backend unit Jest: 9 suites / 103 tests passed. Command: `pnpm.cmd --dir backend exec jest --runInBand --runTestsByPath src/modules/ai-runs/use-cases/activity-use-cases.spec.ts src/modules/ai-runs/use-cases/ai-run-use-cases.spec.ts src/modules/ai-runs/use-cases/change-set-use-cases.spec.ts src/modules/ai-runs/use-cases/direct-egress-use-case.spec.ts src/modules/ai-runs/use-cases/send-chat-message-use-case.spec.ts src/modules/ai-runs/use-cases/start-ai-run-use-case.spec.ts src/modules/auth/use-cases/auth-use-cases.spec.ts src/modules/memory/use-cases/project-fact-use-cases.spec.ts src/infrastructure/database/repositories/typeorm-project-repository.spec.ts`.
- Backend in-memory integration Jest: 4 suites / 20 tests passed, including the conversation fixture consumer. Command: `pnpm.cmd --dir backend exec jest --config jest.integration.config.cjs --runInBand --runTestsByPath test/integration/conversations.integration.spec.ts test/integration/project-facts.integration.spec.ts test/integration/sandbox-commands.integration.spec.ts test/integration/task-4-1-change-set.integration.spec.ts`.

Final backend validation completed: TypeScript typecheck passed; all 117 backend unit suites / 709 tests passed; the isolated PostgreSQL integration suite passed 22 suites / 88 tests. The historical focused fixture-shape run above remains useful for its narrow result, but its pending statements were superseded by these final checks.

## HTTP ownership boundary coverage

`backend/test/integration/ownership-boundaries-http.integration.spec.ts` exercises the real `createApp` route stack through Supertest with actual project, workspace inspection, project-task, and AI-run event route/use-case composition. It uses two pre-seeded synthetic sessions (an admin and a regular user), owner-scoped in-memory project/task/run/session repositories, and the real workspace gateway over two project trees in a unique temporary directory. Both principals have own-resource positive controls. Valid foreign and missing UUIDs are compared for project, file, task, and run-event denials; responses are checked for the same generic error and absence of foreign markers. The admin principal is also explicitly denied access to the other owner's project and file.

Focused validation passed: 1 Jest integration suite / 3 tests. Command from the workspace root: `$env:pnpm_config_verify_deps_before_run='false'; pnpm.cmd --dir backend exec jest --config jest.integration.config.cjs --runInBand --runTestsByPath test/integration/ownership-boundaries-http.integration.spec.ts`. The runner used Supertest against the in-process Express app; it did not connect to PostgreSQL or an external service. Workspace files were written only beneath `fs.mkdtemp(...)` and `afterAll` recursively removed that unique temporary root; a post-run check found zero `task-2-2-ownership-http-*` directories remaining. Run output and scope details are in `artifacts/test-ownership-http-run.md`.

The test covers the persisted run's owner-scoped HTTP events endpoint. It does not cover the workspace-tool adapter: that adapter currently has no production HTTP call site, and its persisted-run input seam is being changed separately. No claim is made about PostgreSQL composite constraints, managed mount readiness, or provider behavior by this in-memory HTTP suite; the PostgreSQL integration remains a separate, serialized test.
