# Task 3.4 Backend Source and Setup Documentation Manifest

Paths are relative to Personal-AI-Workspace. The list separates backend source/tests from Task 3.4 setup documentation.

- backend/openapi.json
- backend/src/app.ts
- backend/src/composition-root.ts — Task 3.4 route, gate, and copy-worker wiring only. This shared file also contains a separate Task 6.1 selected-project-memory reader/DI change; preserve that separately owned hunk.
- backend/src/infrastructure/config/app-config.ts
- backend/src/infrastructure/database/data-source.ts
- backend/src/infrastructure/database/migrations/1710000033000-create-showcase-and-demo-copies.ts
- backend/src/infrastructure/database/repositories/typeorm-demo-admission-repository.ts
- backend/src/infrastructure/database/repositories/typeorm-demo-showcase-copy-manager.ts
- backend/src/infrastructure/database/repositories/typeorm-demo-showcase-copy-manager.spec.ts
- backend/src/infrastructure/database/repositories/typeorm-showcase-repository.ts
- backend/src/infrastructure/workspace/project-file-gateway.ts
- backend/src/modules/demo/controllers/demo-admission-router.ts
- backend/src/modules/demo/domain/demo-admission-errors.ts
- backend/src/modules/demo/domain/demo-showcase-copy-types.ts
- backend/src/modules/demo/use-cases/create-demo-session.ts
- backend/src/modules/demo/use-cases/create-demo-session.spec.ts
- backend/src/modules/demo/use-cases/demo-showcase-copy-use-cases.ts
- backend/src/modules/showcases/controllers/showcase-router.ts
- backend/src/modules/showcases/domain/showcase-types.ts
- backend/src/modules/showcases/use-cases/showcase-use-cases.ts
- backend/src/modules/showcases/use-cases/showcase-use-cases.spec.ts
- backend/src/openapi/showcase-openapi.spec.ts
- backend/test/integration/demo-admission.integration.spec.ts
- backend/test/integration/demo-copy-gate-http.integration.spec.ts

## Setup documentation

- README.md — required showcase and copy configuration names, finite-value constraints, unpublished-by-default behavior, and explicit admin publication.

Task 3.4 adds migration 0033 only. Migrations 0029-0032 remain unchanged. Do not include the Task 6.1 home-assistant changes or the Task 5.1 tracker update in a Task 3.4 source selection.