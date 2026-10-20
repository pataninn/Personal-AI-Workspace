# UI Spec: Task 6.3 — Visible skills and Plan my day

## Design Inputs

- Task 6.3 requires a private skill library, editing and enable/disable/delete actions, template copies, a usable Plan my day run, saved output in existing Home conversation history, and read-only public showcase skills with administrator selection.
- Follow architecture sections 4.3 and 8, plus Task 1.1 spec sections A, C, and I. Task 6.2's contract is the source for ownership, revisions, template copies, declared tools, invocation, and sanitized showcase data.
- Existing navigation is `ProjectHeader` and `AppShell`; existing UI includes `Card`, `Button`, `Label`, `Input`, `Textarea`, `Alert`, `Dialog`, `AlertDialog`, `DropdownMenu`, `Skeleton`, `Spinner`, `EmptyState`, `ErrorState`, and `MarkdownContent`. Reuse native labeled selects and checkboxes in the app's existing form style. Do not add a component library or editor framework.
- The current Home assistant uses `HomeChat` and `useHomeChat`; workspace conversations are selected by the `?conversation=` query parameter. `WorkspacePlanningChatPage` mounts the workspace-scoped Home chat only for planning-only workspaces. File-backed workspaces use the separate project-conversation UI.

## User Goal

Inspect or edit a private reusable skill, copy Plan my day into an owned skill, run it for one chosen workspace, and open the saved answer in that workspace's existing conversation history.

## User Flow

1. User opens **Skills** from the existing project-section navigation. The library shows skills bound to this workspace, account-wide skills, and the server-owned templates.
2. User inspects a template and selects **Copy**. The editable draft starts with the template's title, instructions, and declared tool needs. Saving creates a private skill from those fields; templates themselves remain read-only. Templates cannot be invoked until copied because invocation requires a persisted owned skill ID.
3. User saves or edits the private skill. A successful edit advances its version. A validation, storage, network, or version-conflict error keeps every field in the draft. Reloading a conflicted version requires an explicit choice.
4. User selects **Run** on an enabled personal skill. A workspace-bound skill is fixed to its workspace. For an account-wide skill, a dialog requires one active compatible owned workspace. It previews the target, declared tool needs, and available task/memory context. One click starts the run; no second consent step appears.
5. The app creates one persisted workspace-scoped Home conversation for this run, invokes the skill with that conversation ID and the selected workspace scope, then opens `/projects/{workspaceId}/planning-chat?conversation={conversationId}`. The existing Home chat displays the queued/running state and saved Markdown result, with normal conversation history and source-task links.
6. Run failure, interruption, unknown status, a stale skill version, unavailable policy/runtime, exhausted credits, or an expired demo is shown with the server's actual state and a safe recovery action. An uncertain submission is checked or retried with the same idempotency key; the UI does not silently create another conversation or invocation.
7. Suggested task edits remain explanatory text unless the user explicitly requests an edit or the selected skill declares the relevant write capability. Skill instructions never widen the current workspace policy.
8. The public showcase displays sanitized skill cards without actions. In the existing administrator publisher, an explicit checkbox allowlist selects eligible skills and the existing preview shows exactly what will be published. A private demo copy receives independently owned, editable skills.

## Screens / Views

### Private skills library and detail

- Add a **Skills** destination to the existing project-section navigation and keep the current Home, Usage, and protected Admin portal destinations intact. The list includes account-wide skills and skills for the selected workspace. Show title, a short instructions preview, scope, enabled state, version, and human-readable declared tool needs.
- Personal skills offer **Inspect**, **Run**, **Copy**, **Edit**, **Enable/Disable**, and **Delete** as applicable. Use `DropdownMenu` for secondary actions only if the neighboring project pattern uses it; keep Run visible. A disabled skill explains “Enable this skill to run it.” A skill bound to a file-backed workspace shows a disabled Run explanation until the Home-scope presentation gap below is resolved.
- Templates are read-only and offer **Inspect** and **Copy** only. Copy produces a private draft; it never exposes or edits the shared template. Provide a **New skill** action for a blank draft.
- Loading: existing `Skeleton` rows. Empty: “No personal skills yet” with **Create skill** and the Plan my day / Daily briefing template cards. An empty template response has its own clear message. Error: `Alert` and **Try again**, preserving any locally held editor draft. Success: loaded cards.
- Detail shows full instructions, scope, enabled state, current version, and declared tool needs. Delete uses one titled `AlertDialog`, with explicit **Delete skill** / **Cancel**; deleting a skill does not remove prior conversation results.

### Skill editor

- Use the existing page/form layout. Fields: **Title** (1–120 characters), **Instructions** (maximum 16,000 UTF-8 bytes, with a byte count), **Workspace** (account-wide or an owned workspace), **Enabled**, and **Tools this skill may request**. Tool choices are only the five contract capabilities: read/write tasks, read/write workspace details, and undo an assistant action. Explain that current account/workspace policy still decides what can run.
- Use visible `Label`s, existing `Input`/`Textarea`, native select and labeled checkboxes, and existing primary/secondary buttons. Copy and blank-create forms begin as unsaved drafts. Save creates a private record or a new immutable version; editing a skill does not relabel a previous run.
- Loading: show the form skeleton only when an existing skill is being fetched. Empty/new: editable blank or copied fields. Validation errors stay beside their fields and focus the first invalid field. Save success announces “Skill saved” and shows the resulting version. A version conflict preserves the draft and presents the current saved version with **Keep my draft** and **Reload latest**; never overwrite automatically. Storage/accounting or network failure preserves the full draft and offers retry plus **View usage** where relevant.
- Editing and copying stay available when AI credits are exhausted. Storage limits may prevent a revision from being saved; report the storage error separately and retain the draft. Disabled or expired accounts cannot save/run; use the existing session/expiry state and do not imply recovery for an expired demo.

### Run dialog and saved Home conversation

- `Dialog` title: **Run {skill title}**. Show the single target workspace. For a workspace-bound skill the target is fixed; for an account-wide skill offer a labeled select containing active, owned planning-only workspaces supported by the current Home chat UI. Show a short source preview such as open tasks, deadlines, and saved workspace facts. An optional note may be provided without requiring extra input for Plan my day.
- Before enabling Run, resolve skill enabled/version state, workspace ownership/status, assistant policy/runtime readiness, and account AI availability independently. Unknown readiness stays unknown; available credits do not imply provider readiness. If credits are exhausted, show the returned reason and **View usage**, but leave library/editor actions available. If the policy blocks a declared capability, say so plainly and do not offer a repeated approval prompt. If the optional note is blank, send a short non-empty default request such as “Create today's plan.”
- On click, create a new workspace-scoped Home conversation, then invoke the skill against that exact conversation and workspace. Show queued/running feedback, then link to **Open saved plan** at the supported planning-chat URL. The existing `HomeChat`/`MarkdownContent` renders the narrative and links; its current stop, status-check, history, and retry patterns remain authoritative. Do not create a separate document editor or cross-workspace result page.
- Success includes a compact **Run details / Sources used** disclosure beside the saved result: skill version, workspace, source type/title and captured revision where the invocation contract can resolve them, plus provider/usage only when the run contract supplies them. If a source can no longer be resolved, say **Source unavailable**; do not substitute current content for the captured revision. If no saved assistant result exists, show the actual failed/interrupted status rather than an empty successful document.
- Loading shows the current run phase. Empty history remains the existing Home chat empty state. Error states distinguish skill disabled/deleted, workspace archived/removed, provider/runtime unavailable, policy denied, exhausted/unknown AI availability, storage failure while creating the conversation, stale version, expired session, and transport uncertainty. Offer refresh/check status or retry the same idempotent request as appropriate; never auto-retry an unknown charged outcome.

### Public showcase skills and administrator publisher

- On the existing `/showcase` view, add a **Skills** section with read-only cards using only the sanitized public skill projection: reviewed title, instructions, and declared tool needs. Do not render source IDs, owner IDs, provider secrets, runtime files, or Edit/Run/Copy actions. When demo provisioning completes, the demo's private copied skills appear in its normal editable Skills library.
- Preserve current showcase loading skeleton, unpublished/empty, and retryable error states. A published snapshot with no skills says “No skills were included in this snapshot.” Never render a stale card as live or editable.
- In the existing protected `/admin/showcase` publisher, add a **Skills** fieldset beside tasks/facts/files. Show only enabled, non-deleted skills the administrator owns and that are account-wide or associated with the chosen source workspace. Selection submits IDs only through the existing `skillIds` allowlist. No selection is automatic. Empty and source-load error states match adjacent fieldsets. The exact preview includes the selected skill title, instructions, and declared tool needs; changing selection invalidates the preview, and publishing uses the existing confirmation dialog.
- The publisher remains protected by existing admin navigation and server ownership validation. Preview/publication errors remain visible and retryable; no client-submitted skill text or capability set is treated as authority.

## Component Inventory

| Component | New or Existing | Notes |
|---|---|---|
| Project-section Skills navigation and route | New composition; existing nav style | Preserve Home, Usage, and Admin routes; reuse `ProjectHeader` and `ProjectNavigation` patterns. |
| Skill list, detail, and editor | New feature views | Compose existing `Card`, form controls, alerts, and buttons; no new visual primitive/editor framework. |
| Copy, Run, and delete overlays | Existing patterns | `Dialog` for run/copy context where needed; `AlertDialog` for delete; no nested dialogs. |
| Home run status and result | Existing Home chat | Reuse `HomeChat`, `useHomeChat`, history query selection, `MarkdownContent`, and existing status/stop patterns. |
| Run details / source disclosure | New content in existing Home message | Show only metadata the run contract can return; no parallel result/history store. |
| Public skill card | New content block in existing page | Consume only normalized sanitized showcase DTO; read-only. |
| Publisher skill selection/preview | Existing publisher extended | Reuse native checkbox fieldsets, preview invalidation, and publish confirmation. |
| Loading/error/empty feedback | Existing shared UI | `Skeleton`, `Spinner`, `Alert`, `EmptyState`, and `ErrorState`. |

## Responsive Behaviour

Use the current project page width and spacing tokens. Cards and form fields stack on narrow screens; action buttons wrap without clipping; instructions and long titles wrap. Keep the editor full-width and the tool list vertically labeled. Run/copy dialogs fit the mobile viewport and virtual keyboard using current dialog styles. On desktop, keep the skill content readable and avoid a new dashboard or dense side panel. Preserve the existing mobile navigation drawer and horizontal project-section behavior.

## Theming / Dark Mode

Support the app's existing light and dark themes through current surface, text, border, focus, and semantic status tokens. Add no one-off color overrides. Status labels and tool needs remain understandable without color.

## i18n / Localisation

No translation runtime is established. Keep copy in existing conventions and format dates with the current locale. N/A for translation integration.

## Accessibility Notes

Target WCAG 2.1 AA. Keep page landmarks and heading order; use actual links for navigation and buttons for actions. Every field has a visible label; group tool needs and publisher selection with `fieldset`/`legend`; associate inline errors and use `role="alert"`. Use existing Radix focus handling for dialogs and destructive confirmation, restore focus to the trigger, and keep visible focus rings. Announce save/run/status changes politely without moving focus during streamed output. Keyboard users can inspect, copy, edit, resolve a conflict, run, and open the saved conversation; checkbox and menu keyboard behavior follows native/Radix patterns. Maintain required text/UI contrast in both themes and at 200% zoom.

## Design References

- `.codex/docs/hackathon-release/tasks.md` — Task 6.3.
- `.codex/docs/hackathon-release/architecture.md` — sections 4.3 and 8.
- `.codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/ui-spec.md` — sections A, C, and I.
- `.codex/docs/hackathon-release/task-6-2-skill-definitions/contract.md` — skill APIs, invocation, ownership, revisions, and showcase projection.
- `Personal-AI-Workspace/frontend/src/widgets/project-navigation/ProjectHeader.tsx`, `widgets/home-chat/HomeChatWidget.tsx`, `pages/workspace-planning-chat/WorkspacePlanningChatPage.tsx`, `features/home-chat/ui/HomeChat.tsx`, `features/home-chat/model/use-home-chat.ts`, `pages/showcase/ShowcasePage.tsx`, and `features/showcase-publishing/ui/ShowcasePublisher.tsx`.
- No external mockups or browser captures were provided for this handoff.

## Open Questions / Decisions Needed

- **Workspace presentation gap:** Task 6.2 invocation accepts one persisted workspace-scoped Home conversation. The current Home conversation renderer is exposed at `/projects/:id/planning-chat` only for planning-only workspaces; file-backed projects redirect to the separate project-chat UI, while the shell Ask panel is Home-scoped. This spec limits the first working run to one active owned planning-only workspace and links to its real `?conversation=` URL. Supporting file-backed workspace runs requires adding a Home-scoped conversation presentation there or revising the invocation contract; do not route the result to the unrelated project-chat history.
- **Historical run metadata gap:** The 6.2 invocation response returns skill version, source IDs/revisions, and state, but current Home conversation/turn DTOs do not expose the invocation binding, source labels, provider, or per-run usage on reload. For durable source/run details in Home history, the developer-owned Task 6.3 contract should add a minimal summary projection to the existing turn/result read path. Until then, show only metadata actually returned during the live invocation and link to account Usage; never invent provider readiness or per-run usage from account credits.
- **Publisher preview gap:** The current publisher has a `skillIds` selection field, but its source picker does not yet load skills and its frontend preview shape omits them. Extend the existing preview projection with selected sanitized skill fields so the admin can review exactly what becomes public; keep the publish request as an ID allowlist that the server resolves.
- All other interaction choices are resolved by the current app patterns. No external approval or additional consent step is part of the run flow.
