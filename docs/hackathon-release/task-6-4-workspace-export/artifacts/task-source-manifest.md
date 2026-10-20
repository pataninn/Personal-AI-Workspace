# Task 6.4 source and shared-hunk manifest

Source inventory: 35 paths (31 task-owned, 4 shared).

## Task-owned backend files

- `backend/src/modules/workspace-exports/index.ts`
- `backend/src/modules/workspace-exports/controllers/workspace-export-router.ts`
- `backend/src/modules/workspace-exports/domain/workspace-export.ts`
- `backend/src/modules/workspace-exports/repositories/workspace-export-repository.ts`
- `backend/src/modules/workspace-exports/use-cases/create-workspace-export.ts`
- `backend/src/modules/workspace-exports/use-cases/create-workspace-export.spec.ts`
- `backend/src/modules/workspace-exports/use-cases/download-workspace-export.ts`
- `backend/src/modules/workspace-exports/use-cases/reconcile-workspace-exports.ts`
- `backend/src/modules/workspace-exports/use-cases/reconcile-workspace-exports.spec.ts`
- `backend/src/modules/workspace-exports/repositories/workspace-export-builder-probe.ts`
- `backend/src/infrastructure/database/migrations/1710000040000-create-workspace-exports.ts`
- `backend/src/infrastructure/database/repositories/typeorm-workspace-export-repository.ts`
- `backend/src/infrastructure/database/repositories/typeorm-workspace-export-repository.spec.ts`
- `backend/src/infrastructure/workspace-export-artifact-store.ts`
- `backend/src/infrastructure/workspace-export-process-identity.ts`
- `backend/src/infrastructure/workspace-export-process-identity.spec.ts`
- `backend/src/infrastructure/workspace/project-file-gateway.ts`
- `backend/src/infrastructure/workspace/project-file-gateway.spec.ts`
- `backend/src/infrastructure/workspace/project-file-export-capture.ts`
- `backend/src/modules/files/repositories/project-file-access.ts`
- `backend/src/infrastructure/database/repositories/typeorm-project-removal-repository.ts`
- `backend/src/infrastructure/database/repositories/typeorm-demo-expiry-cleanup-repository.ts`
- `backend/test/integration/workspace-exports.integration.spec.ts`
- `backend/test/integration/project-file-actions-review.integration.spec.ts` - updates the existing gateway fixture for export capture.
- `backend/src/openapi/workspace-export-openapi.spec.ts`

## Task-owned frontend files

- `frontend/src/features/workspace-export/api/workspace-export-api.ts`
- `frontend/src/features/workspace-export/ui/WorkspaceExportPanel.tsx`
- `frontend/src/features/workspace-export/index.ts` - FSD public export consumed by UsagePage.
- `frontend/src/pages/usage/UsagePage.tsx`
- `frontend/e2e/workspace-export.preview.spec.ts`
- `frontend/playwright.preview.config.ts`

## Shared files and exact ownership boundaries

- `backend/src/composition-root.ts`: Task 6.4 export repository/artifact/use-case wiring, startup reconciliation, route dependency binding, existing cleanup adapter binding, and the explicit infrastructure liveness-probe injection. Preserve sibling Task 7.2 credit-ledger, Home receipt/history, automation-history, and provider-admission hunks.
- `backend/src/infrastructure/database/data-source.ts`: Task 7.2 import/registration for migration 0039 remains; Task 6.4 adds migration 0040 import and the final ordered registry entry only.
- `backend/openapi.json`: Task 6.4 adds workspace-export paths/schemas and the 422 unsafe-content response; Task 7.2 automation occurrence schema/endpoint hunks remain intact.
- `backend/src/app.ts`: Task 6.4 export route dependency and mount.
- `docs/hackathon-release/tasks.md`: full canonical tracker byte-copied into the app docs tree; no tracker-row edits.

QA1 repair keeps production file capture on its Linux descriptor-pinned path; the optional `exportCaptureFileSystemForTests` seam exercises `captureForExport` against a bounded real temporary directory on Windows. The focused tests cover the actual gateway method and fail-closed portable checks; they do not claim Linux `/proc`/`O_NOFOLLOW` runtime proof.

No broad file-gateway refactor was made. The 0039 migration and unrelated Task 7.2 files are not owned by Task 6.4.
