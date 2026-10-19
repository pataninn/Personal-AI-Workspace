# Source Map: Task 5.3 Direct Task Editor

## Ownership and boundaries

This is a frontend-only change. It consumes the canonical task read, versioned update, and delete APIs delivered by Task 4.3; it adds no endpoint, request field, persistence layer, or migration.

- `frontend/src/pages/task-detail/TaskDetailPage.tsx` owns route data, versioned save/delete/move actions, receipt refresh, route blocking, native unload protection, and the AppShell sign-out preflight.
- `frontend/src/pages/task-detail/TaskDetailEditor.tsx` owns the controlled in-memory draft, validation, normalized pristine state, stable retry intent, and explicit conflict choices. The draft lives only for this mounted owner/task route.
- `frontend/src/features/project-tasks/model/project-task-validation.ts` owns task-field validation, normalized dirty comparison, and explicit reviewed rebase behavior.
- `frontend/src/features/project-tasks/ui/TaskMetadataFields.tsx` owns the shared importance/date/checklist controls. Completion checkboxes are enabled only in task-detail checklist mode; existing create/edit dialog behavior remains intact.
- `frontend/src/features/project-tasks/ui/TaskVersionConflict.tsx` presents the user draft and latest saved task side-by-side, including ordered and checked checklist items.
- `frontend/src/features/project-tasks/ui/TaskEditorDialog.tsx` shares the save result type with the route editor without changing existing dialog flows.
- `frontend/src/widgets/app-shell/AppShell.tsx` adds a narrow Outlet-context registration seam. Sign-out waits for the active task route's keep/discard choice before calling the auth API or clearing the session.
- `frontend/src/app/styles/globals.css` adds responsive editor, checklist, and conflict review styles using existing design tokens.
- `frontend/e2e/task-5-3-direct-task-editor.spec.ts` exercises the built UI in Chrome with local API route stubs only.

## Architecture alignment

The route stays in the page layer; task field logic and conflict rendering remain under the project-tasks feature; shared UI primitives and API clients are reused. The sign-out seam carries only an exit-preflight callback and does not introduce a general navigation framework. This follows architecture §4.2 and the Task 5.3 UI spec. React Router 6.28.2 is installed locally; its `useBlocker` and `useBeforeUnload` exports were verified from the package and exercised by route tests.
