# Task 3.6 Source and Hunk Map

## Backend owned by Task 3.6

- New admin portal and owner usage module: backend/src/modules/admin-portal/ (routes, validation, use cases, ports, and focused specs).
- TypeORM admin adapter and policy/usage integration: backend/src/infrastructure/database/repositories/typeorm-admin-portal-repository.ts and its spec. The spec covers changed/cleared campaign ID rejection, null-to-configured setup, and same-ID cap edits. The owned demo-admission and credit-ledger hunks remain in their TypeORM repositories and specs.
- Migration backend/src/infrastructure/database/migrations/1710000037000-admin-demo-policy.ts adds persisted settings, account-limit revision/configuration markers, and secret-free audit metadata. Its registry entry follows 0036 in the shared working tree.
- Exact Task 3.6 hunks only in backend/src/app.ts, backend/src/composition-root.ts, and backend/src/infrastructure/database/data-source.ts add admin/usage dependencies, router mount, and 0037 registry entry. backend/openapi.json documents the Task 3.6 owner-usage/admin routes, request/response DTOs, protected writes, CAS and nullable-limit semantics, and campaign immutability 409. Its generic ApiError.code string needs no enum change. The focused check is backend/src/openapi/admin-portal-openapi.spec.ts. Shared files also contain parallel feature hunks.
- backend/test/integration/admin-demo-policy.integration.spec.ts is the single approved Task 3.6 PostgreSQL integration scope. Existing demo fixtures now explicitly bootstrap persisted settings.

## Frontend owned by Task 3.6

- New owner usage and admin portal entities/pages: frontend/src/entities/account-usage/, frontend/src/entities/admin-portal/, frontend/src/pages/usage/, and frontend/src/pages/admin-portal/.
- Route/navigation hunk: frontend/src/app/routes.tsx and frontend/src/widgets/app-shell/AppShell.tsx. The admin settings form makes a configured campaign ID read-only while keeping cap edits available.
- Shared private-demo status and AI submission gates: frontend/src/widgets/demo-session-route/DemoContentGate.tsx, frontend/src/pages/home-chat/HomeChat.tsx, frontend/src/features/ai-run/ui/ChatComposer.tsx, and frontend/src/features/ai-run/ui/AiRunEntry.tsx, with adjacent owned tests.
- The focused route-stub browser journey is frontend/e2e/task-3-6-admin-usage.spec.ts.

## Shared-file ownership and evidence boundary

Task 6.2 owns its skill router/use-case, composition, migration 0035, OpenAPI skill, and copy hunks. Task 4.3 owns task deletion/archive and migration 0036 hunks. Task 3.6 changed only its separately agreed hunks in shared files. The staged snapshot contains the Task 3.6 hunks only: AppShell admin/Usage navigation is staged while the Task 5.3 pre-sign-out dirty-exit guard remains unstaged; app.ts, composition-root.ts, data-source.ts, and openapi.json exclude parallel feature hunks. The exact-source-manifest.txt lists the 49 staged backend/frontend source and test paths, one path per line. No files were committed yet.

PostgreSQL evidence covers the one focused 0037 policy integration test and guarded test database checks. Browser evidence uses Playwright with route stubs and a locally built Vite bundle; it does not prove live provider readiness or production integration. See validation.md and the two screenshots beside this file.