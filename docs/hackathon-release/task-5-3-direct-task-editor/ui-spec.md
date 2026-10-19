# UI Spec: Task 5.3 — Open task details editable with Save and dirty-exit protection

## Design Inputs
- Task 5.3 replaces the Edit toggle with a controlled editor on `/tasks/:taskId`, an explicit Save/Cancel flow, and protection for unsaved changes. It depends on Task 4.3 and Task 5.2.
- Architecture: `.codex/docs/hackathon-release/architecture.md` §4.2. Baseline form and exit behavior: `.codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/ui-spec.md` §D; shared layout and feedback: §A; task routes: §B. Baseline §D explicitly requires a `Your draft` / `Latest saved` review including checklist order, and says only deliberate reviewed reconciliation may adopt the latest baseline/version. Architecture §4.2 requires conflict review without silent overwrite.
- Current UI inspected read-only: `Personal-AI-Workspace/frontend/src/pages/task-detail/TaskDetailPage.tsx`, `features/project-tasks/ui/TaskEditorDialog.tsx`, `features/project-tasks/ui/TaskMetadataFields.tsx`, `features/project-tasks/model/project-task-validation.ts`, and `entities/project-task/model/types.ts`.
- Existing shared UI: `shared/ui/Button.tsx`, `Input.tsx`, `Textarea.tsx`, `Label.tsx`, `Alert.tsx`, `ErrorState.tsx`, `Skeleton.tsx`, `Dialog.tsx`, and `AlertDialog.tsx`. The current metadata editor uses a native importance `<select>` and native checkbox styling; no shared Select or Checkbox wrapper exists.
- Styling references: `app/styles/globals.css` tokens and existing `.task-detail-*` / `.project-task-editor-*` rules. Reuse these tokens and patterns; do not add a shared primitive or dependency for this task.
- Task 4.3’s contract is planned but not yet available. The target UI consumes its canonical delete result and conflict/retry semantics once delivered; this spec defines no endpoint, payload, status code, or idempotency contract.

## User Goal
Open a task and edit its fields immediately, save deliberately, and keep a clear path back if the task or its version changes while editing.

## User Flow
1. User opens `/tasks/:taskId`. Show a loading status and skeleton while the canonical task loads. Focus the route heading, not the first input, so opening on mobile does not summon the keyboard; Tab reaches Task title next.
2. On success, show the task as an inline controlled form. No Edit button or autosave. Load the canonical values and version as the comparison baseline.
3. User edits title, details, importance, deadline, or checklist rows. Save stays disabled while normalized values match the baseline. Returning every field to its baseline also returns the form to pristine.
4. Save validates once and submits one versioned mutation. During submission, disable form fields and actions, show `Saving…`, and block navigation until the outcome is known.
5. On success, adopt the canonical returned values/version, clear dirty state, announce `Task saved.`, and leave Save disabled. If a separate list refresh fails, retain the saved task and show the existing refresh warning pattern.
6. On validation or network failure, retain every field and checklist value. Show field errors or a safe retry message; focus the first invalid field. An uncertain result keeps the same save intent for retry and continues to protect the draft.
7. On a version conflict, keep the draft visible and show the required `Your draft` / `Latest saved` comparison, including checklist order and checked state. Reuse the existing conflict actions: `Reload latest` confirms draft discard when dirty; `Keep editing my draft` is available after review and preserves local edits while adopting the latest baseline/version locally. Save remains a separate action. Do not add a field-level merge interface, send an automatic retry, or add an API rebase operation.
8. Cancel, close, Back to tasks, task switch, route/query navigation, browser Back/Forward, or sign-out/session switch proceeds directly when pristine. When dirty, keep the intended destination pending and ask once whether to keep editing or discard. Discard completes that destination once.
9. Refresh, tab close, or external navigation uses the native `beforeunload` warning only while dirty or the save result remains unresolved. Do not persist drafts across account identities or promise mobile browsers will show the warning.
10. Delete is a separate destructive action using one AlertDialog. If the form is dirty, that same confirmation explains that the unsaved draft will also be discarded. A confirmed delete returns to the originating task list; cancellation or failure leaves the form intact. A stale delete follows Task 4.3’s delivered conflict semantics. No archive, restore, or undo-archive action is shown.

## Screens / Views
### Task detail route — inline editor
- **Layout:** Keep `/tasks/:taskId`, its workspace/Inbox context, and Back to tasks. Replace the read-only detail body plus Edit control with a form on initial load. Use the current task title as the page heading and place the labeled Task title input first. Group order: title, details, importance/deadline, checklist, read-only source metadata, then actions. Keep the Save/Cancel row distinct from the destructive Delete action. Keep the existing Move action separate from the Save form; disable it while the form is dirty and explain `Save or cancel edits before moving this task` to avoid competing versioned mutations.
- **Fields:** Required Task title; optional Details; Importance; optional date-only Deadline; optional ordered checklist. Each checklist row has a native completion checkbox, editable title, and Remove action. Add checklist item appends a row; retain the existing 50-item limit and make the limit visible when reached. Preserve current row order; do not add drag-and-drop or reordering controls in this task. Explain existing checklist completion behavior: `Completing all checklist items completes the task. Unchecking an item reopens it.` Do not add a separate status field unless the delivered task update contract requires it.
- **Normalization:** Compare trimmed title, trimmed details as `null` when empty, blank deadline as `null`, importance, and checklist sequence by stable item ID, trimmed title, and checked state. Sequence/order is part of the comparison. A draft that normalizes to the loaded values is pristine. Workspace movement remains the separate existing action, not a hidden editor field.
- **Source metadata:** Show the existing source label/kind read-only after the checklist; show accepted time when available. Do not expose raw IDs or invent missing provenance.
- **Loading:** `Loading task…` status plus skeleton; controls are not exposed until a matching route response arrives.
- **Empty/unavailable:** `Task is unavailable` with Back to tasks. Use the same generic copy for missing, deleted, or inaccessible tasks; do not disclose ownership. If the task disappears while dirty, retain visible draft text, disable Save/Delete, state `This task was deleted. Your unsaved text is still shown.`, and require the normal dirty-exit choice before leaving. Do not recreate it automatically.
- **Load error:** Reuse ErrorState with `Task could not be loaded`, Try again, and Back to tasks.
- **Success:** Active/unassigned task shows enabled editor and Save. An archived workspace remains readable but clearly read-only with a reason and disabled mutations. Follow post-Task-4.3 task data behavior; do not render an archived-task or archive-action path.
- **Validation/network error:** Keep the entire draft. Associate inline errors with the affected controls. Retry labels and copy must distinguish a known failure from an uncertain result; uncertain retry must use the existing update contract’s same intent.
- **Conflict:** Extend the existing `TaskVersionConflict` only enough to show the required `Your draft` and `Latest saved` values, including checklist order/state. Reuse its `Reload latest` and `Keep editing my draft` actions; do not add per-field merge controls or another reconciliation step. `Reload latest` replaces a dirty draft only after explicit confirmation. `Keep editing my draft` is the deliberate reviewed choice that retains local edits and adopts the latest baseline/version locally; clearly say that a separate Save will use the latest task version. Never perform this on Save or submit a rebase request.
- **Save state:** Save is disabled while pristine, invalid after validation, submitting, or while an unresolved conflict blocks submission. While saving, show `Saving…`, `aria-busy`, and disable all competing mutations. On successful save, show `Task saved.` in a polite status region.
- **Dirty exit:** Use one AlertDialog for Cancel and guarded exits: `Discard unsaved changes?` / `Your changes to this task have not been saved.` Initially focus Keep editing; Discard changes is destructive. Escape/Keep editing cancels the pending transition and returns focus to the last edited control. Overlay click never discards. Reuse the same pending destination for link, programmatic, and browser-history SPA navigation.
- **Delete confirmation:** Use one AlertDialog: `Delete task?` with the actual task title and `This task and its checklist will be deleted. This cannot be undone.` If dirty, add `Your unsaved edits will also be discarded.` Initially focus Cancel. Pending shows `Deleting…` and prevents duplicate actions/navigation. A confirmed success announces `Task deleted.` and returns to the originating list, focusing its heading or next row. A known failure or stale conflict preserves the draft and follows Task 4.3’s contract; an uncertain result is never presented as success and follows that contract’s retry guidance. No Undo that could resurrect a deleted task.
- **Move action:** Preserve its existing dialog only if it remains supported by the post-4.3 contract. Do not run it with a dirty form; Save or Cancel first.

## Component Inventory
| Component | New or Existing | Notes |
|---|---|---|
| Task detail route | Existing `pages/task-detail/TaskDetailPage.tsx` | Adapt route body to inline editing; preserve route and current loading/error/back patterns. |
| Controlled task fields | Existing `features/project-tasks/ui/TaskEditorDialog.tsx` composition | Reuse field composition and validation; keep suggestion/project-dialog behavior intact for other callers. Do not mount the dialog on the detail route. |
| Metadata/checklist fields | Existing `TaskMetadataFields.tsx`, adapted | Add controlled completion checkbox for each checklist row; preserve importance/date fields, add/remove, and limit. No new reorder affordance. |
| Task version conflict | Existing `TaskVersionConflict`, adapted | Add only the §D-required draft/latest comparison (including checklist order); reuse existing reload/keep-draft actions. No field-level merge UI or extra action. |
| Save/Cancel/Delete actions | Existing shared Button | Primary Save, secondary Cancel, destructive Delete separated from the form footer. |
| Inputs and labels | Existing shared Input, Textarea, Label; native select/checkbox | Use visible labels and token styling. No new Select/Checkbox shared component. |
| Status/error feedback | Existing Alert, ErrorState, Skeleton plus native live region | Reuse for load, save, conflict, unavailable, and refresh states. |
| Discard/delete confirmation | Existing AlertDialog wrappers | Title and description required; blocking confirmation with safe focus and no outside dismissal. |
| Navigation protection | Existing React Router route plus platform `beforeunload` | Developer must validate the installed React Router 6 API and supported browser behavior via the task’s Context7 requirement; do not add a new navigation framework. |

## Responsive Behaviour
- Mobile below 640px: single column; title/details full width; Importance and Deadline stack; checklist text may wrap while checkbox and Remove remain visible; action buttons wrap/stack and meet the existing 44px target. No horizontal page scroll. Do not use a fixed footer that can cover fields or the virtual keyboard.
- Tablet 640–1024px: use two columns for Importance/Deadline only when labels and values fit; keep title, details, checklist, and source full width. Actions wrap naturally.
- Desktop above 1024px: keep the route form at a readable width (about 800px), with two-column metadata and 16px field-group spacing. Keep destructive Delete visually separate.
- At 200% zoom and the project’s 320px minimum viewport, reflow controls, preserve focus visibility, and keep form errors/actions reachable without overlapping sticky shell UI.

## Theming / Dark Mode
Support current light and system dark token sets. Use existing `--color-background`, `--color-surface`, `--color-text`, `--color-text-muted`, `--color-border`, `--color-primary`, `--color-error`, and `--color-ring` tokens. Do not add feature-specific hex values. Verify normal text at 4.5:1 and controls/focus indicators at 3:1 in both themes; labels and status text must make meaning clear without color alone.

## i18n / Localisation
No translation runtime is established. Keep UI copy in the project’s existing copy conventions. Format dates as date-only values using the current task formatter; do not shift a deadline by timezone.

## Accessibility Notes
- Use the existing page landmarks and a clear H1. Focus the heading on route arrival with programmatic focus; Tab proceeds to Task title and does not open the mobile keyboard on load.
- Use a native form, visible labels, required indication for title, and `aria-invalid`/`aria-describedby` for inline errors. Associate checklist controls with stable, understandable names such as `Mark {item title} complete` and `Remove checklist item {item title}`; use a numbered fallback for a blank title.
- Group the checklist with `fieldset`/`legend`. Native checkbox keyboard behavior and visible checked state must remain clear in both themes. Preserve logical DOM/tab order and visible focus rings.
- Save status uses `role="status"`/polite live feedback; actionable errors use an alert. Do not move focus after ordinary save success. Focus the first invalid field after validation.
- AlertDialogs include title and description. Keep editing returns focus to the last edited field; after confirmed deletion, focus the task-list heading or next row. Restore focus safely when the original task-row trigger no longer exists.
- Dirty protection covers close/Cancel, Back, breadcrumb/sidebar/workspace navigation, task switch, route/query transitions, browser Back/Forward, and sign-out/session change. Native hard-exit warning is conditional and browser-controlled; do not claim it is guaranteed on mobile.
- Verify keyboard-only editing, checkbox/add/remove operations, conflict review, all guarded exits, both themes, 200% zoom, long checklist text, and screen-reader announcements during later implementation/QA. This document reports no runtime accessibility validation.

## Design References
- `.codex/docs/hackathon-release/architecture.md` §4.2.
- `.codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/ui-spec.md` §A, §B, and §D.
- `Personal-AI-Workspace/frontend/src/pages/task-detail/TaskDetailPage.tsx`.
- `Personal-AI-Workspace/frontend/src/features/project-tasks/ui/TaskEditorDialog.tsx` and `TaskMetadataFields.tsx`.
- `Personal-AI-Workspace/frontend/src/app/styles/globals.css` (task detail/editor rules and theme tokens).
- No external mockup or browser screenshot was used or captured.

## Open Questions / Decisions Needed
- **Readiness:** UI design is prepared for developer planning. Implementation remains held until Task 4.3’s delete contract/migration and Task 5.2 are delivered and revalidated. The developer must consult Context7 for the installed React Router 6 navigation blocker and `beforeunload` behavior as required by `tasks.md`.
- The spec keeps the existing Move action as an independent mutation, gated until Save or Cancel. Reconfirm that it remains supported after Task 4.3; if removed by its delivered contract, omit it without changing the editor form.
- The conflict comparison and deliberate latest-baseline adoption are required by Task 1.1 §D. Keep them within the existing conflict component/actions; do not add a custom merge/rebase interface or API operation.
- Task 4.3’s delete conflict, retry, and success shapes are not available yet. Consume that contract directly; this spec makes no API or persistence claims.
- No tests, server, Playwright, or browser validation were run as part of this UI-only design handoff.
