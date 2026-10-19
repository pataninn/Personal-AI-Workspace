# UI Spec: Task 6.1 — Make memory and selected context visibly control future runs

## Design Inputs

- Reuse the existing project-scoped facts and context surfaces at `/projects/:projectId/memory` and `/projects/:projectId/context`. The current source of truth is `project_chat_contexts` for selected facts, files, exclusions, and recent project conversations; Task 4.1 revalidates and snapshots permitted context when a run starts.
- New chats and scheduled runs use the latest permitted saved facts/context for their scope. Editing, deleting, or excluding a fact changes future context only; it does not rewrite old conversation text or erase context already sent to a provider.
- Existing implementation references under `Personal-AI-Workspace/frontend/src/`: `features/project-memory/ui/ProjectMemoryManager.tsx`, `MemoryFactItem.tsx`, `ProjectFactEditorDialog.tsx`, `ProjectFactDeleteDialog.tsx`, `features/project-context/ui/ProjectContextSettings.tsx`, `entities/project-fact/ui/ProjectFactAttribution.tsx`, `entities/project/api/project-chat-context-api.ts`, and `features/assistant-policy-status/ui/AssistantPolicySummary.tsx`.
- Reuse `AssistantPolicySummary` for the actual server-provided provider/model, readiness, context categories, and operator-managed storage disclosure. It already appears in chat entry surfaces and handles unknown/unavailable provider states. Add it to the existing workspace Context settings view; do not add a provider selector or policy editor.
- Reuse the existing shared `Card`, `Button`, `Label`, `Input`, `Textarea`, `Alert`, `Skeleton`, `EmptyState`, `ErrorState`, `Dialog`, and `AlertDialog` wrappers, plus native labeled checkboxes and existing spacing/color tokens. No external mockup or new route is assumed.
- Display only facts returned for the current owned project. Do not expose another account's facts, raw prompts, credentials, or secret values in status or error copy. Source inspection only; this design task makes no runtime or browser-evidence claim.

## User Goal

See which project facts and other context will be eligible for future AI runs, change that selection safely, and understand what those changes mean for past messages and provider transmission.

## User Flow

1. From a project, open **Memory** to review saved facts and their source, or **Context** to review recent-message and file selection.
2. Wait for the owned project's facts, saved selection, and policy summary to load. Loading, unknown selection, and load failure remain distinct.
3. Add or edit a fact, delete it with an explicit confirmation, or include/exclude it with its existing per-fact checkbox. File and conversation-history settings retain their current draft-and-Apply flow.
4. On success, show the server-saved selection and announce that it applies to future eligible runs. On failure, keep the user's edit visible and clearly distinguish it from the last saved selection. Resolve stale-version conflicts before retrying.
5. A fresh chat or scheduled run reads the current permitted persisted selection for that project. The existing assistant summary identifies the active scope/provider and context categories at chat entry; the Memory list shows the exact selected fact titles and source.
6. Keep the effect disclosure visible: changes affect future runs; they do not edit past messages or recall provider requests already sent. Show operator storage and the actual configured cloud provider in workspace context settings.

## Screens / Views

### Project Memory (`/projects/:projectId/memory`)

- Keep the existing page header, **Add a fact** action, fact cards, and dialogs. Add concise helper copy above the list: “Included facts can be used in future chats and scheduled runs for this project. Changes affect future AI context only; they do not change past messages or erase context already sent to a provider.”
- Each card keeps its fact title/content and existing source, review status, and updated date from `ProjectFactAttribution`. Keep the include checkbox beside the fact; clarify its visible label as **Include in future AI context** with helper text **Used by future chats and scheduled runs in this project when permitted.** Checked means included; unchecked means excluded. Use text/checkbox state as well as color.
- Inclusion keeps the current immediate-save behavior. Show a row or section pending state, disable repeated toggles while saving, announce success through the existing live status, and restore the last server-saved value after failure. A context-load failure means selection is **unknown**; do not present it as an unchecked saved value.
- Add/edit continues to use the existing dialog and required title/content fields. Keep source attribution read-only. Clarify the description: “Saving changes this workspace fact. It does not send a request; if included, the saved value is available to future runs.” A new fact starts excluded until the user includes it. Editing an included fact keeps its current selection.
- Keep the existing version-conflict comparison and explicit **Reload latest** / **Keep editing** choices. Keep the draft on save failure. Delete remains an `AlertDialog` showing the fact title and explaining that it will be unavailable to future context; while pending, prevent duplicate deletion. Conflict/error leaves the latest fact visible and requires the user to review it before confirming again.
- **Loading:** retain the fact skeleton and announce “Loading project memory…”; show a separate “Loading context selection…” status while saved inclusion is unknown.
- **Empty:** retain “No saved facts yet” and **Add a fact**. When facts exist but none are selected, show “No facts selected for AI context” with a link/instruction to include a fact; keep all fact cards available.
- **Error:** retain “Project memory could not be loaded” and **Try again**. If only context selection fails, keep facts readable, show “Selection could not be loaded. Current inclusion is unknown.” and **Reload context**; inclusion controls remain disabled until loaded.
- **Success:** display current server values and checked states, with polite announcements for saved, included/excluded, reviewed, and deleted actions. Archived workspaces remain visibly read-only. Do not infer fact-selection permission from file-access state; follow the developer contract for planning-only workspaces.

### Project Context settings (`/projects/:projectId/context`)

- Keep the existing **Conversation history** and **Files for every chat** cards, file filter, selection checkboxes/count, `Apply to all chats`, and **Memory** link. Keep selected paths and exclusions visibly distinct, and preserve the existing explanation that supported new files may be selected automatically and that context limits can omit items.
- Place the existing `AssistantPolicySummary` in this workspace settings view, using the current project-scope policy snapshot. It shows the operator-managed storage statement, actual server-provided provider/model and readiness, included context categories, and safe unavailable/unconfigured copy. Keep the summary read-only; its status is descriptive and never a promise that a later run will succeed.
- Continue to show fact inclusion controls and exact fact source on the Memory page; do not duplicate toggles here. The existing link should remain easy to find beside the context controls.
- **Loading:** distinguish project, policy, saved context, and file-list loading. Keep skeleton/status feedback and disable Apply until persisted context is available.
- **Empty:** show “No matching files” separately from an empty project file list. Keep “No facts selected” guidance on the Memory page; do not interpret an empty or failed fact response as a confirmed empty selection.
- **Error:** keep file refresh and context reload errors separate. Preserve the local file/history draft when saving fails, and identify the prior saved selection as still active only when the server confirms that outcome. Policy-summary loading/error states use the existing safe copy.
- **Conflict:** if the context contract reports a stale selection, retain the user's local draft and show the latest saved selection with explicit **Reload latest** and **Keep editing** choices. Do not silently overwrite either side or label a draft as saved.
- **Success:** show the server-returned context and announce **Context applied to all chats in this project.** Archived projects remain read-only. The policy summary and storage/provider statement remain visible without an extra consent step.

### Future chat/run entry (existing surfaces)

- Keep `AssistantPolicySummary` visible in the existing Home/workspace composer, including its compact disclosure. It reports the active scope, provider/readiness, selected context categories, and storage/transmission copy from the existing policy read model.
- **Loading:** show the existing “Checking assistant availability…” status. **Empty context:** show “No additional context is selected.” **Error/unavailable:** retain the safe unavailable/provider-unknown copy and do not imply that a request was sent. **Ready:** show the exact configured provider/model and current included context before submission.
- Do not promise that every selected item reaches a provider: the server may omit context that is excluded, no longer available, or over the run's limits. Do not claim that editing/deleting a fact erases past messages or a provider request already issued.
- A provider request uses the current permitted saved selection for that fresh run; it must never depend only on an earlier transcript or include foreign facts. Unknown provider/readiness stays unknown/unavailable and must not be guessed.

## Component Inventory

| Component | New or Existing | Notes |
|---|---|---|
| `ProjectMemoryManager`, `MemoryFactItem` | Existing | Reuse fact list, include checkbox, save/review/delete feedback, and loading/empty/error states. |
| `ProjectFactEditorDialog`, `ProjectFactDeleteDialog` | Existing | Keep dirty guard, version conflict, source read-only display, and destructive confirmation; clarify future-context copy. |
| `ProjectFactAttribution` | Existing | Keep server-owned source, review status, and updated date visible for each fact. |
| `ProjectContextSettings` | Existing | Preserve file/history controls and link to Memory; add the read-only policy summary placement. |
| `AssistantPolicySummary` | Existing | Reuse in workspace Context settings and existing chat entry; no new policy DTO or provider integration. |
| Shared Card/Button/Label/Input/Textarea/Alert/Skeleton/Dialog/AlertDialog | Existing | Use existing wrappers, variants, tokens, and focus behavior. |
| Native checkbox and live status | Existing pattern | Keep a visible text label and polite action announcements; no custom switch is needed. |

## Responsive Behaviour

- Keep the existing single-column workspace settings and fact cards on narrow screens. Let attribution fields and actions wrap; preserve full-width readable content and avoid horizontal scrolling.
- Keep checkbox labels and actions tappable at mobile sizes. Dialogs fit the viewport with a scrollable body and reachable footer; focus stays visible at 200% zoom.
- At tablet/desktop widths, retain the current fact-card and settings-card hierarchy; do not introduce a second navigation surface or dense comparison table.

## Theming / Dark Mode

Use the existing semantic CSS variables and shared component variants. Add no task-specific color or spacing overrides; selected, excluded, warning, and error states must remain legible in every theme the app supports.

## i18n / Localisation

No localization framework was found in the inspected frontend. Keep the copy consistent with the existing English interface.

## Accessibility Notes

- Use a visible label for each checkbox and associate it with the fact title; do not rely on color or an icon alone for included/excluded state.
- Preserve the existing Radix `Dialog`/`AlertDialog` title, description, focus trap/restore, Escape behavior, and focus ring. Deletion is destructive and must not dismiss by clicking outside.
- Announce load/save/delete and selection changes with `role="status"`/`aria-live="polite"`; announce validation, load, and mutation errors with the existing alert patterns. Set `aria-busy` and disable duplicate actions while pending.
- Keep logical tab order and WCAG 2.1 AA contrast: at least 4.5:1 for normal text and 3:1 for large text and controls. Support keyboard-only use and 200% zoom without clipped controls.

## Design References

- `.codex/docs/hackathon-release/tasks.md` — Task 6.1.
- `.codex/docs/hackathon-release/architecture.md` — sections 8, 11, 12, and Frontend Architecture boundaries.
- `.codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/ui-spec.md` — Visible memory and settings disclosure states.
- `.codex/docs/hackathon-release/task-4-1-stored-tool-policy/contract.md` — persisted context ownership, per-run snapshot, policy summary, provider/storage disclosure.
- `Personal-AI-Workspace/frontend/src/features/project-memory/`, `features/project-context/`, `entities/project-fact/`, and `features/assistant-policy-status/`.

## Open Questions / Decisions Needed

1. **Planning-only workspaces:** `ProjectMemoryManager` currently enables its fact-selection context hook only when `fileAccess` is true, and the Context page is unavailable without file access. Does the Task 6.1 contract permit selecting project facts independently of file access? If yes, the developer should decouple fact inclusion from file access using the existing context resource; do not display a working-looking checkbox before the server contract confirms this.
2. **Context mutation conflicts:** define the existing PATCH conflict and uncertain-outcome behavior in the developer-owned contract. The UI needs a way to keep the local draft distinct from the last persisted selection and safely reload/reconcile it; this spec does not propose new fields or routes.
3. **Disclosure scope:** the current policy read model is per Home or per workspace, and the app has no account-level settings route. This spec places the storage/provider disclosure in the existing workspace Context settings view. If Task 6.1 requires a global account-settings surface, the developer/PM must identify its owner and scope before adding one.
