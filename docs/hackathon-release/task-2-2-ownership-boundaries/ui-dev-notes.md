# Frontend implementation notes: managed workspace capabilities

## Implemented

- Project DTOs and create requests no longer expose or send relativeRoot. Creation now sends name, optional objective, and workspaceMode; the UI defaults to Files and file tools and offers Planning only.
- The create dialog explains that the app manages private storage, has no path input, retains name and mode after a generic storage allocation failure, and leaves the planning option available.
- Project cards, headers, workspace navigation and page capability states use capabilities.fileAccess. Planning-only workspaces retain Tasks, Memory and planning assistance; file-only navigation is hidden. Public surfaces do not show a root path or storage namespace.
- Preview project fixtures and the local preview API follow the path-free DTO. The affected direct-chat E2E fixtures now seed, inspect and clean files through authenticated project-file APIs rather than creating a caller-selected host folder.

## Validation

- Frontend typecheck: from frontend/, ran $env:pnpm_config_verify_deps_before_run='false'; pnpm.cmd run typecheck — passed (exit 0).
- Focused Vitest: from frontend/, ran $env:pnpm_config_verify_deps_before_run='false'; pnpm.cmd exec vitest run --configLoader runner src/pages/dashboard/DashboardPage.spec.tsx src/widgets/project-navigation/ProjectHeader.spec.tsx src/widgets/project-workspace/ProjectWorkspaceLayout.spec.tsx src/widgets/home-overview/HomeOverviewWidget.spec.tsx src/pages/project-workspace/ProjectWorkspacePage.spec.tsx src/pages/RootlessProjectCapabilityPages.spec.tsx src/pages/workspace-planning-chat/WorkspacePlanningChatPage.spec.tsx src/pages/project-tasks/ProjectTasksPage.spec.tsx src/pages/task-detail/TaskDetailPage.spec.tsx src/pages/all-tasks/AllTasksPage.spec.tsx src/features/task-capture/ui/HomeTaskCapture.spec.tsx src/widgets/chat-workspace/ChatWorkspace.spec.tsx src/features/project-management/ui/RemoveProjectDialog.spec.tsx src/features/home-chat/model/use-home-planning-records.spec.tsx src/entities/project-task/api/global-task-api.spec.ts — 15 files, 79 tests passed. The explicit runner config loader avoids this workspace's esbuild config-bundle directory-access failure.
- Preview API: node --test preview/preview-api.test.mjs from frontend/ — 26/26 passed.
- Preview build: pnpm.cmd --dir frontend exec vite build --mode preview --config vite.config.mjs --configLoader runner — passed. Vite reported existing ignored Radix use client directives and a large-chunk advisory.
- Browser preview: from frontend/, ran $env:pnpm_config_verify_deps_before_run='false'; $env:PAI_PREVIEW_BASE_URL='http://127.0.0.1:5174'; $env:PAI_E2E_OUTPUT_DIR='test-results/task-2-2-workspace'; pnpm.cmd exec playwright test --config playwright.preview.config.ts --grep 'creates managed workspace modes' — 1/1 passed. This journey checks default mode, no path input, simulated generic 503 redaction, retained name/mode, keyboard mode selection, planning navigation, file navigation, and desktop/mobile horizontal overflow.
- Browser screenshots in this folder are from the in-memory preview API; the storage-unavailable response was a synthetic intercepted response containing a fake private-path string. They prove frontend behavior only, not persistent storage allocation, physical mount configuration, backend identity isolation, or provider execution.
- The live/provider-dependent frontend/e2e/direct-chat.spec.ts was updated for the new API contract but was not run; that journey depends on a live provider and real file-backed workspace. No provider calls or owner files were used for these checks.
- TypeScript updated the tracked frontend/tsconfig.node.tsbuildinfo during validation; after all checks and coordination with the identity developer, restored that generated file to HEAD so no build-info diff remains.

## Visual evidence reviewed

- artifacts/ui-create-desktop.png: focused project name field, default file-backed mode, and no path field.
- artifacts/ui-storage-fallback-desktop.png: generic retryable error with name and mode preserved; no synthetic path is rendered.
- artifacts/ui-planning-mobile.png: Planning only status, planning-only copy, and available planning/task navigation at 375px.
- artifacts/ui-files-desktop.png and artifacts/ui-files-mobile.png: Files available capability label and file navigation at desktop and mobile sizes.
- The browser test measured document scroll width at both 375px views and found no horizontal overflow.

## Task-scoped source manifest

### Project model and creation
- frontend/src/entities/project/api/project-api.ts
- frontend/src/entities/project/index.ts
- frontend/src/entities/project/model/types.ts
- frontend/src/features/project-management/model/project-validation.ts
- frontend/src/features/project-management/ui/CreateProjectDialog.tsx
- frontend/src/features/project-management/ui/RemoveProjectDialog.spec.tsx
- frontend/src/pages/dashboard/DashboardPage.tsx
- frontend/src/pages/dashboard/DashboardPage.spec.tsx
- frontend/src/app/styles/reference-design.css

### Capability rendering and typed fixtures/tests
- frontend/src/widgets/project-list/ProjectList.tsx
- frontend/src/widgets/home-overview/HomeOverviewWidget.tsx
- frontend/src/widgets/home-overview/HomeOverviewWidget.spec.tsx
- frontend/src/widgets/project-navigation/ProjectHeader.tsx
- frontend/src/widgets/project-navigation/ProjectHeader.spec.tsx
- frontend/src/widgets/project-workspace/ProjectWorkspaceLayout.tsx
- frontend/src/widgets/project-workspace/ProjectWorkspaceLayout.spec.tsx
- frontend/src/widgets/chat-workspace/ChatWorkspace.spec.tsx
- frontend/src/pages/RootlessProjectCapabilityPages.spec.tsx
- frontend/src/pages/project-activity/ProjectActivityPage.tsx
- frontend/src/pages/project-context/ProjectContextPage.tsx
- frontend/src/pages/project-file-history/ProjectFileHistoryPage.tsx
- frontend/src/pages/project-memory/ProjectMemoryPage.tsx
- frontend/src/pages/project-workspace/ProjectWorkspacePage.tsx
- frontend/src/pages/project-workspace/ProjectWorkspacePage.spec.tsx
- frontend/src/pages/workspace-planning-chat/WorkspacePlanningChatPage.tsx
- frontend/src/pages/workspace-planning-chat/WorkspacePlanningChatPage.spec.tsx
- frontend/src/features/task-actions/ui/TaskMoveDialog.tsx
- frontend/src/features/task-capture/ui/HomeTaskCapture.spec.tsx
- frontend/src/features/home-chat/model/use-home-planning-records.spec.tsx
- frontend/src/entities/project-task/api/global-task-api.spec.ts
- frontend/src/pages/project-tasks/ProjectTasksPage.spec.tsx
- frontend/src/pages/task-detail/TaskDetailPage.spec.tsx
- frontend/src/pages/all-tasks/AllTasksPage.spec.tsx

### Preview fixtures and browser journeys
- frontend/preview/preview-api.mjs
- frontend/preview/preview-api.test.mjs
- frontend/preview/preview-overview.mjs
- frontend/playwright.preview.config.ts
- frontend/e2e/task-2-2-workspace.preview.spec.ts
- frontend/e2e/direct-chat.spec.ts
- frontend/e2e/home-chat-preview-test-utils.ts
- frontend/e2e/home-summaries-preview-fixtures.ts
- frontend/e2e/project-chat-security-preview-fixture.ts

The unrelated AI-run hook/spec work, the peer-owned frontend/src/features/ai-run/model/use-direct-chat.spec.tsx, and generated build output are excluded from this manifest.