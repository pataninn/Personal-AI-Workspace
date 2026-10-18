# Task 2.2 UI review notes (prep only)

No overall QA verdict is issued here; backend implementation and integration evidence are still pending.

## Evidence reviewed

- Task contract and UI spec: `.codex/docs/hackathon-release/task-2-2-ownership-boundaries/{contract.md,ui-spec.md}`.
- Developer handoff and visual evidence: `ui-dev-notes.md` and `artifacts/ui-create-desktop.png`, `ui-storage-fallback-desktop.png`, `ui-planning-mobile.png`, `ui-files-desktop.png`, `ui-files-mobile.png`. All five screenshots were inspected.
- Source: `frontend/src/features/project-management/ui/CreateProjectDialog.tsx`, `frontend/src/entities/project/{api/project-api.ts,model/types.ts}`, `frontend/src/widgets/{project-list/ProjectList.tsx,project-navigation/ProjectHeader.tsx,project-workspace/ProjectWorkspaceLayout.tsx}`, and the capability-gated context/activity/history pages.
- Required Playwright MCP was not available in the enabled tools; the repo's Playwright CLI preview journey was used as the documented browser equivalent.

## Independent checks

- Playwright preview journey: `task-2-2-workspace.preview.spec.ts`, 1/1 passed. It covered default file-backed creation, absence of a root-path field, generic synthetic storage failure with retained name/mode, keyboard selection of Planning only, capability navigation, and mobile width checks.
- Focused Vitest: `DashboardPage.spec.tsx` and `RootlessProjectCapabilityPages.spec.tsx`, 2 files / 17 tests passed.
- The Playwright preview server was stopped after the run.

## Review

The form submits project name and workspace mode without a client-selected root. Copy explains private managed storage, preserves the draft on failure, and keeps the failure text generic. Project cards, headers, and workspace layout use `capabilities.fileAccess`; direct visits to context/activity/history are gated before their panels mount for planning-only projects. The native mode select is labeled and keyboard-tested; the name field receives focus on open, validation/storage errors are announced, and visual evidence shows no horizontal overflow at 375px.

No blocking UI finding was identified in this scoped review.

## Limits

The journey uses the in-memory preview API. Its storage-unavailable case is an intercepted synthetic 503 containing a fake path. These results verify frontend behavior only; they do not prove real PostgreSQL ownership, mount configuration, filesystem isolation, provider behavior, or backend allocation.
