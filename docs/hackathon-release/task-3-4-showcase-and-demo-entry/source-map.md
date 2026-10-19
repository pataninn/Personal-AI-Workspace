# Task 3.4 source map and ownership gate

**Status:** Contract/source-map was doc-only before the post-Task 4.1 handoff. Ownership transferred after commit `4f9ad9bddf227f53b7c55db237cc4a9a8d716846`. Contract is stable enough for implementation; no claims extend beyond inspected repository types.

## Actual integration points

| Responsibility | Existing source boundary | Task 3.4 change |
| --- | --- | --- |
| Feature module | `Personal-AI-Workspace/backend/src/modules/` Clean Architecture modules; `backend/src/app.ts` route factory registration | Add focused showcase domain/DTO/use-case/controller code; keep copy/admission orchestration under `modules/demo/`. Controllers validate/map DTOs; TypeORM/workspace adapters stay in infrastructure. |
| Admin sources | `modules/projects/repositories/project-repository.ts`: `findByIdForOwner` / `listByOwner`; `modules/tasks/repositories/project-task-repository.ts`: `listTasks`; `modules/memory/repositories/project-fact-repository.ts`: `findActiveByIds` / `listActiveByProject` | Preview requires active project owned by current admin. Reuse these query boundaries; add only narrow projection ports where current use cases lack required output. |
| Source files | `modules/files/domain/workspace-types.ts` uses path/type, not UUID; `modules/files/repositories/workspace-gateway.ts` lists safe entries; `modules/files/repositories/project-file-access.ts` and `IProjectFileGateway.download` read owner/project scoped bytes+hash; `WorkspaceRelativePath` rejects traversal/absolute/drive/protected/alias input. | Preview takes `selection.filePaths` from existing safe workspace listing, verifies regular files, re-reads through trusted project scope, then stores exact bytes. Public file IDs are snapshot-generated. Never accept/persist host/root paths. |
| Admission identity | `modules/demo/controllers/demo-admission-router.ts`, `modules/demo/use-cases/create-demo-session.ts`, `modules/demo/domain/demo-admission-types.ts`, `infrastructure/database/repositories/typeorm-demo-admission-repository.ts`, `infrastructure/database/typeorm-demo-storage-bootstrap.ts` | Extend the existing begin-admission transaction with pointer lock/pin, reserved target project UUID, and copy row before owner/counter commit. Preserve Task 3.3 session/cookie/status-only replay and empty-account bootstrap before clone. |
| Copy readiness gate | `modules/auth/controllers/request-auth.ts` authenticates principal; `app.ts` mounts all v1 routers; copy-status adapter scopes target lookup to the authenticated owner | The app-wide demo-copy gate exempts exact safe session/logout, admission resume, availability, copy status/retry, and public showcase GET routes only. Other v1 routes remain default-denied for an unready demo, including streams. Copy status returns projectId: null until ready, then only the owner-scoped private target UUID. |
| Quota/roots | `modules/storage-quotas/repositories/storage-quota-repository.ts`: `runDatabaseMutation`, `reserveFileOperation`, `settleFileOperation`, `markFileOperationUnknown`, `reconcileReferences`; `infrastructure/workspace/workspace-boundary.ts`; `workspace-mutation-gateway.ts`; `typeorm-storage-root-mapping-repository.ts` | Clone after empty bootstrap, with Task 3.2 account/counter/reference/resource order. Reserve before filesystem IO; use trusted owner/project mapping, verify bytes/hash, settle after IO. No DB locks over IO. |
| Clone source shapes | `modules/tasks/domain/project-task.ts` has task provenance/version/subtask IDs; `modules/memory/domain/project-fact.ts` has owner/project IDs/key/verification metadata | Copy only contract fields. Generate fresh project/task/checklist/fact IDs. Exclude source, run, conversation, fact key, owner/project, and verification metadata. No assistant suggestion/acceptance path. |
| Default policy | Delivered `1710000032000-create-assistant-scope-policies.ts` installs same-transaction user/project triggers from trusted configuration | Project insert in clone transaction creates one default row. Verify it before readiness; never copy source policies/context/provider permissions or infer provider readiness from a null/non-null pair. |
| Migrations and wiring | `backend/src/infrastructure/database/data-source.ts` and `backend/src/composition-root.ts` | Add only migration `1710000033000-create-showcase-and-demo-copies.ts` and wire routes, gate, repositories, and bounded copy recovery through existing maintenance. Migrations 0029-0032 remain unchanged. |
| OpenAPI | `backend/openapi.json`, `backend/src/openapi/openapi.spec.ts` and feature-specific specs | Add strict schemas/operations for all eight routes, binary file content, envelopes, authentication/CSRF/Origin and errors. |
| Frontend | `frontend/src/app/routes.tsx`; demo session route and copy-status entity; existing auth, app shell, and project workspace boundaries | Try demo follows admission status through bounded copy polling and navigates once to the private owner project only after projectId is ready. Public showcase remains read-only; admin preview/publish stays separate. |
| FSD | Existing `features/auth`, `entities/project`, `entities/project-task`, `entities/project-fact`, `entities/workspace`, `pages/*`, `shared/api` | Keep demo/showcase API and local state in focused features/entities, page composition in pages, route wiring in app, generic envelope/fetch code in shared. |
| Verification | Backend Jest, frontend Vitest/RTL, existing Playwright setup | Cover allowlist/digests/state logic, PostgreSQL pin/quota/readiness races, API denials, and one core public showcase + Try demo browser flow. Do not claim provider, physical mount, or public deployment proof from fixtures. |

## Ownership after Task 4.1 transfer

The release owner confirms commit 4f9ad9bddf227f53b7c55db237cc4a9a8d716846 is delivered and accepts the 152-path source manifest. Task 3.4 may now edit its feature integration paths. Preserve these unrelated original protected paths exactly:

- `frontend/src/features/ai-run/model/use-ai-run-timeline.ts`
- `frontend/src/features/ai-run/model/use-direct-chat-consent.ts`
- `frontend/src/features/ai-run/model/use-direct-chat.ts`
- `frontend/src/features/ai-run/model/use-direct-chat.spec.tsx`
- `frontend/src/features/ai-run/ui/AiRunTimeline.spec.tsx`
- `Personal-AI-Workspace/ponytail-review.md`

Also preserve generated frontend `tsconfig.node.tsbuildinfo`, app-local codex scratch, delivered Task 3.2 source, and unrelated in-progress work. Do not stage, commit, or push until independent Task 3.4 QA passes and the release owner authorizes it.

## Implementation ownership

**Backend additions:** showcase allowlist DTO/domain, ports, preview/publish/current/file read use cases and router; demo copy states, admission pin, safe retry, readiness gate, durable copy worker, TypeORM adapters, migration 0033, composition/data-source/app wiring, strict OpenAPI specs, and Jest unit/PostgreSQL integration coverage.

**Backend integrations:** demo admission types/use case/repository and specs; app.ts, composition-root.ts, data-source.ts, periodic maintenance; Task 3.2 quota adapter only as required for atomic clone rows. No migrations 0029-0032 changes.

**Frontend additions:** demo entry/status/banner and showcase API/hooks, separate public showcase page, focused admin preview/publish page with existing AlertDialog, and one E2E flow. **Frontend integrations:** sign-in, app routes, app shell/workspace layout only as needed for private banner/admin link. No unrelated chat timeline refactor.

## Sequence and checks

1. Stable contract: real owner-scoped task/fact APIs, relative paths, DTOs and digests fixed above.
2. Backend first: additive persistence, preview/publication/OpenAPI, atomic admission pin, empty bootstrap, hidden copy provisioning, owner-wide gate and safe retry.
3. Run focused Jest and isolated PostgreSQL checks for pointer pin, stale preview, idempotency, quota reservations, crash/retry, and ready/expiry serialization.
4. Frontend consumes only the DTOs above and supplied UI states; use existing components and prioritize a working flow over visual polish.
5. Validate core browser flow and direct API denials. Physical mount identity/persistence belongs to Task 8.1; expiry purge remains Task 3.5.

## Explicit non-claims

No publication/sample content exists. No external provider, physical host mount, expiry cleanup implementation, TLS topology, public deployment, or browser session is claimed.
