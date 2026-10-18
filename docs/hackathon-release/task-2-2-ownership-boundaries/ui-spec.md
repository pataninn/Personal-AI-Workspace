# UI Spec: Task 2.2 — Managed workspace ownership boundaries

## Design Inputs
- Task 2.2 requires account-scoped storage, non-overlapping managed roots, preservation of the existing owner’s legacy root mapping, and denial of arbitrary host attachment.
- Developer contract: workspace creation accepts user-facing project data plus workspaceMode (planning or file_backed); the server allocates file-backed roots. Responses expose workspaceMode and capabilities.fileAccess, with no root path or label.
- Architecture sections 3 and 5.1 define private storage boundaries and legacy-root compatibility.
- Existing UI: features/project-management/ui/CreateProjectDialog.tsx accepts a caller-entered relativeRoot; project cards and ProjectHeader render relativeRoot; ProjectWorkspaceLayout treats null as planning-only. No explicit root-attachment form exists.

## User Goal
Create a project with the needed capabilities while the app keeps its files inside the authenticated account’s private storage.

## User Flow
1. User chooses New project and enters a project name.
2. User chooses workspace mode: Files and file tools, or Planning only. Files and file tools is the default to preserve the current file-backed creation flow.
3. For file-backed mode, the app explains that it manages a private folder for this project. The user does not choose or enter a filesystem path.
4. User selects Create project. The client submits project data and mode; the server allocates the root from the authenticated principal and project identity.
5. On success, open the new project. Show file navigation only when capabilities.fileAccess is true; otherwise show the planning-only experience.
6. If project creation or loading fails because storage is unavailable, show a generic retryable error, retain nonsecret form values, and do not expose a path or account identifier.
7. If a project ID is missing or belongs to another account, show the existing Project not found/unavailable state and Back to projects; do not reveal whether another account owns it.

## Screens / Views
### New project dialog
- Layout: retain the existing Radix Dialog and project name field. Replace Root folder with a labeled Workspace features select: Files and file tools, or Planning only.
- Copy: for file-backed mode, “The app manages a private folder for files and file-based runs.” For planning-only mode, “Files and file-based runs are unavailable. Tasks, memory, and planning assistance remain available where enabled.”
- Initial/empty: blank Project name; Files and file tools selected by default. No root/path input or path examples.
- Loading: Create project becomes Creating project… with aria-busy; disable fields and close/cancel while the request is active.
- Validation: retain project-name validation and focus behavior. Remove client root-path validation and root-overlap/protected-path errors because the browser no longer chooses a root.
- Error: preserve the name and mode. For allocation/storage failures show “We could not create this project safely. Try again.” Keep any local setup retry action only when that specific deployment boundary is unavailable. Do not display server paths or internal root details.
- Success: close the dialog and navigate to the project. Use the response’s workspaceMode and capabilities.fileAccess to render the result.

### Project cards and workspace navigation
- Loading: retain existing project skeleton/loading indicators.
- Empty: retain the existing No projects yet/Create your first project state.
- Success: show project name and status plus a text label derived from capability: Files available or Planning only. Use capabilities.fileAccess, not relativeRoot, for file navigation and capability display. Do not render a server root path or account storage namespace.
- Planning-only workspace: keep tasks/planning available and show “This is a planning-only workspace. Files and file-based runs are unavailable here. Tasks, memory, and planning assistance remain available where enabled.” Do not offer an attach-folder action in this task.
- Error: retain the existing project-not-found and retry states. Treat foreign IDs as unavailable and avoid exposing owner, filesystem, or account-boundary details.
- Legacy owner: preserve existing projects and their file capability through the server’s legacy-root mapping. Do not show a migration prompt or ask the owner to reattach a root. If a legacy mapping cannot be used, show the generic Files unavailable/retry state; never request a host path.

## Component Inventory
| Component | New or Existing | Notes |
|---|---|---|
| CreateProjectDialog | Existing features/project-management | Keep Dialog and name field; replace relativeRoot with mode select |
| Label/Input/Button | Existing shared/ui | Name, mode, submit and cancel controls |
| Alert/ErrorState/Skeleton | Existing shared/ui | Storage, not-found, loading and retry states |
| Project cards/header | Existing widgets/project-list and project-navigation | Show capability label instead of root path |
| Project capability model | Existing entities/project | Render from workspaceMode and capabilities.fileAccess |

## Responsive Behaviour
- Desktop: preserve the existing centered dialog and capped form width; stack name and mode fields.
- Tablet: keep the form within the current dialog width and allow helper copy to wrap.
- Mobile: use the existing full-width dialog sizing and 16px page gutters; stack all controls. Keep both mode options understandable without horizontal scrolling or truncated helper text.

## Theming / Dark Mode
Use existing light/system dark surface, text, field, focus, error, and status tokens. Add no root-specific color treatment; labels must communicate capability.

## i18n / Localisation
No translation runtime is established. Keep new project/mode/error copy in existing UI message conventions.

## Accessibility Notes
- Keep the existing DialogTitle and DialogDescription, and use visible Label elements for Project name and Workspace features.
- Use the existing native select pattern for the two modes; preserve keyboard operation and visible focus. The selected mode’s explanatory copy must remain available to assistive technology.
- Link name errors to the name field with aria-describedby and role=alert. Announce create progress politely and errors clearly.
- Use text labels Files available and Planning only; do not rely on color or icons alone. Preserve 44px targets and dialog focus return.
- Permission/unavailable errors use generic text so assistive output does not reveal another account or its files.

## Design References
- .codex/docs/hackathon-release/tasks.md Task 2.2.
- .codex/docs/hackathon-release/architecture.md sections 3 and 5.1.
- Personal-AI-Workspace/frontend/src/features/project-management/ui/CreateProjectDialog.tsx.
- Personal-AI-Workspace/frontend/src/widgets/project-list/ProjectList.tsx, widgets/project-navigation/ProjectHeader.tsx, and widgets/project-workspace/ProjectWorkspaceLayout.tsx.

## Open Questions / Decisions Needed
- No blocking decision. File-backed mode stays the default because the current New project dialog creates file-backed projects; the root is allocated by the server.
- Existing planning-only projects remain planning-only in this task. There is no root-attachment control, so users cannot select or attach a host path from the UI.
- The legacy owner’s data and file access remain continuous through server mapping; the UI presents capability without exposing a filesystem root.
