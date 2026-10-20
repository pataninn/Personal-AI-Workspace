# UI Spec: Task 7.3 — Daily briefing schedules, Run now, and history

## Design Inputs

- Task 7.3 requires schedule create/edit/pause, local-time and IANA-time-zone handling, workspace validation, Run now without an approval dialog, durable history/results, and an in-app ready notice. Task 1.1 section J defines the expected states and copy.
- Follow release architecture sections 4.3 and 9 and the current Task 7.1 contract. One schedule is bound to exactly one owned, active, mutable workspace and one enabled, saved read-only skill revision. A schedule cannot be moved to another workspace; multiple workspaces require separate schedules. Run now is allowed for a paused schedule. The server's `nextDueAt`, schedule revision, and occurrence status are authoritative.
- Reuse the existing workspace navigation, form patterns, and shared `Card`, `Button`, `Input`, `Label`, `Alert`, `Skeleton`, `Spinner`, and `EmptyState`. Use native time/text/select controls; no workflow builder, calendar/email integration, new component library, or separate result editor.
- Task 7.1's schedule/occurrence API currently supplies schedule time/zone, enabled state, revision, next due, last status, occurrence status/time/version, safe failure code, and Home-turn link. Provider/model and per-run usage are not persisted in the current Home history. Display those historical fields only if Task 7.2's developer-owned contract adds real persisted values.

## User Goal

Set a daily briefing for one workspace and one read-only skill, run it now when useful, and find the saved result and honest run status later.

## User Flow

1. User opens **Automations** from the existing workspace navigation. The list shows schedules for the signed-in owner; every row names its single workspace and skill.
2. User chooses **Create daily briefing**, selects one active owned workspace and one eligible enabled read-only skill, and sets a local time and IANA time zone. The form explains that a new schedule starts enabled and can be paused after creation.
3. Save creates the schedule. On success, show the server-returned local time, canonical zone, enabled state, revision-backed row, and next due instant formatted in that zone.
4. User can edit time, zone, or skill; the workspace remains read-only and fixed to the original workspace. Pause/Resume updates server state and keeps history. Edits and pause/resume refresh the next due time from the server.
5. **Run now** queues a separate manual occurrence with one click and no permission dialog. Show the acknowledged state and a link to **Run history**. If the result is unknown, reconcile history before offering another run.
6. User opens a run's saved Home conversation from history. Narrative stays in the existing Home renderer. A successful result observed while the Automations page is open produces a non-blocking **Your daily briefing is ready** notice with **Open briefing**; it does not move focus.

## Screens / Views

### Automations list

- Add **Automations** to the existing project/workspace navigation and follow the current project-page layout. Keep one owner-scoped schedule list; each row clearly names its bound workspace so the list never implies that one schedule covers several workspaces. The canonical public showcase has no Automations action. A private demo can schedule only workspaces in its own editable copy.
- A row is titled **Daily briefing** with the workspace name and resolved skill title/version. Do not add a schedule name field: the current create contract has none. Show **Enabled** or **Paused**, the saved local time plus IANA zone, **Next run** using server `nextDueAt` in that zone (or **No next run** when paused), and **Last outcome** using the server status. If a saved workspace/skill can no longer be resolved, show **Workspace unavailable** or **Skill unavailable**, never a raw ID.
- Row actions: **Run now**, **Run history**, **Edit**, and **Pause**/**Resume**. Run now remains available while paused if the schedule is otherwise valid. Pausing prevents future scheduled occurrences, requests cancellation of active work, and preserves history; show **Cancelling** or **Interrupted** until cancellation/usage is actually resolved. Do not offer Delete because the current contract has no schedule-delete action.
- **Loading:** show schedule row skeletons and mark the list busy. Workspace and skill options may load independently with their own small loading feedback.
- **Empty:** say **No daily briefings scheduled.** and provide **Create daily briefing**.
- **Load error:** show an `Alert` and **Try again**; do not show stale schedules as current without marking them stale.
- **Loaded:** show server-backed rows and a **Run history** action. Paused rows explicitly say **No next run**; do not imply that pause deletes existing results.
- **Run now:** disable repeat activation while the request is in flight. On server acknowledgment show **Queued** and link to history; do not imply the briefing has finished. If a run is already unresolved (`SCHEDULE_BUSY`), explain that it is still resolving and direct the user to history. For uncertain network outcome, refresh/reconcile the same schedule history before enabling another submission.
- **Budget exhausted:** show a blocked reason when the server returns one. If the worker records the occurrence as skipped for budget, keep the schedule state distinct and show **Skipped — AI budget** in history; leave editing, pause, and history available. Do not promise an automatic retry or imply credits are restored.
- **Disabled/changed skill:** explain that this schedule needs an enabled, current read-only skill. Keep history available and offer **Edit** to choose an eligible skill; do not show a generic successful run.
- **Expired/disabled owner or demo:** use the existing session/demo-expiry surface. Do not allow Run now or imply a schedule can run beyond demo access expiry. The normal demo banner remains the source for its absolute expiry.

### Create / edit daily briefing

- Use the existing page form style with visible labels and **Save**/**Cancel**. Fields: **Workspace** (one active mutable workspace owned by the current account), **Skill** (owned, enabled, current saved skill declaring read-only capabilities and either account-wide or bound to the selected workspace), **Time** (`HH:mm` local time), and **Time zone** (editable IANA zone; default to the browser's valid resolved zone and show the exact zone string). On edit, the original workspace is shown read-only because schedule scope is immutable. New schedules start enabled under the current create contract; show that fact and let users pause after saving.
- Show a short help line: **Runs on the server even when this page is closed.** Explain that a missing local time during a DST change uses the next valid instant, a repeated time runs once at the earlier instant, and downtime may coalesce missed dates into at most one recent catch-up. Do not locally calculate an authoritative due time; display it after the server confirms the save.
- **Loading:** skeleton the option/form area until workspace and skill choices are available. **No workspace:** say **No active workspaces available.** and leave save disabled. **No eligible skill:** explain that an enabled saved read-only skill is required and link to the existing Skills destination when available. **Option-load error:** show **Try again** and keep user-entered time/zone.
- **Validation:** show field-level errors for invalid local time or IANA zone; focus the first invalid field on submit. If the selected workspace or skill became unavailable, show a safe message and refresh eligible choices. A skill with write capabilities cannot be scheduled. A disabled/expired demo follows the existing expiry flow.
- **Saving success:** close the form or return to the list with the refreshed schedule and server-computed next due. **Save failure:** keep all entered values. On revision conflict, say the schedule changed, refresh the saved state, and require an explicit reload/edit; never overwrite a newer revision silently.
- **Edit scope:** workspace cannot be changed. User may update local time, IANA zone, skill revision, or enabled state. A skill version change must use the current enabled read-only version returned by the existing Skills data.

### Run history and briefing result

- History is per schedule and uses the bounded occurrence pages. Show run kind (**Scheduled** or **Run now**), intended local date/time in the schedule's named zone, skill version, and status. Use **Queued**, **Running**, **Cancelling**, **Succeeded**, **Failed**, **Skipped — AI budget** when confirmed by a safe server reason, **Cancelled**, and **Interrupted — outcome/usage pending reconciliation** as applicable. Map internal `claimed`/`dispatching` states to a clear running/starting label; never expose raw failure codes.
- **Loading:** skeleton rows. **Empty:** **No runs yet.** and **Run now**. **Error:** **Run history could not be loaded** with **Try again**; keep the schedule summary available. **Loaded:** show persisted occurrence rows and a **Load more** action when another page exists.
- Link a run with a persisted Home turn to its schedule-owned workspace Home conversation using the existing planning-chat navigation and renderer. Use **Open briefing** for a saved successful result; use **Open conversation** for other linked turns. A skipped-before-dispatch occurrence has no result link. Do not copy narrative into Automation history or create a parallel result/editor view.
- The occurrence record does not currently contain provider/model or per-run usage. Show **Provider unavailable** and **Usage unavailable** unless Task 7.2 persists an authoritative per-run receipt; for `interrupted_unknown`, show **Usage pending reconciliation**. Never substitute the current provider setting or aggregate account credits for historical run data. Show source/task links only when the saved Home result actually supplies them.
- When a persisted run becomes successful while the Automations view is active, show a polite, non-modal **Your daily briefing is ready** notice with **Open briefing**. Keep a successful run discoverable in history if the user is elsewhere; do not claim a persistent unread notification without a server-backed unread marker.

## Component Inventory

| Component | New or Existing | Notes |
|---|---|---|
| Automations destination/page | New page composition | Follow existing project/workspace navigation and page layout; one owner-scoped list. |
| Schedule cards and form | New feature UI | Compose existing `Card`, native form controls, and buttons; one workspace per schedule. |
| Loading/error/empty feedback | Existing shared UI | Reuse `Skeleton`, `Spinner`, `Alert`, and `EmptyState`. |
| Run notice and status announcements | Existing shared UI pattern | Inline `Alert`/polite status; no new notification center or modal. |
| Briefing narrative/result | Existing Home conversation | Reuse planning-chat/Home renderer and saved assistant message; no duplicate editor. |

## Responsive Behaviour

Use the current workspace-page width and spacing. Stack form fields and actions on narrow screens; keep the time and zone labels readable, and let long workspace/skill names and local dates wrap. On desktop, use a simple single-column form and compact schedule rows. History remains a readable vertical list with no horizontal table requirement. Keep all actions visible without a pixel-specific layout or new navigation framework.

## Theming / Dark Mode

Use current light/dark surface, text, border, focus, and semantic status tokens. Pair status text with any color/icon treatment; do not rely on color alone.

## i18n / Localisation

No translation runtime is established. Format due and occurrence times with the current locale while always displaying the saved IANA zone name so the selected schedule time remains unambiguous.

## Accessibility Notes

Target WCAG 2.1 AA. Keep existing landmarks and heading order; use links for navigation and buttons for actions. Every field has a visible label; associate inline validation text with its field and focus the first invalid control after submit. Preserve visible focus and logical Tab order. Announce queue/status changes politely and actionable errors with the existing alert pattern. The ready notice must not steal focus or move the page. No approval dialog or custom focus trap is used. Preserve readability at 200% zoom and required text/UI contrast in both themes.

## Design References

- `.codex/docs/hackathon-release/tasks.md` — Task 7.3 and Task 1.1 section J.
- `.codex/docs/hackathon-release/architecture.md` — sections 4.3 and 9.
- `.codex/docs/hackathon-release/task-7-1-durable-scheduler/contract.md` and `architecture-preflight.md` — scope, schedule/occurrence fields, time rules, pause, Run now, and history.
- `Personal-AI-Workspace/backend/src/modules/automations/controllers/automation-router.ts` and `domain/automation-types.ts` — current DTO serialization and statuses.
- `Personal-AI-Workspace/frontend/src/widgets/project-navigation/ProjectHeader.tsx`, `pages/workspace-planning-chat/WorkspacePlanningChatPage.tsx`, and `widgets/home-chat/` — existing navigation and Home result presentation.
- No mockups or screenshots are required for this handoff.

## Open Questions / Decisions Needed

- No design choice blocks handoff. The current Task 7.1 create contract starts schedules enabled and has no schedule-name field; the UI follows that contract. Workspace scope stays fixed after creation.
- Task 7.2 owns any added persisted result/provider/usage projection. Until its developer contract supplies those values, history must show provider/usage as unavailable and unknown billing as pending reconciliation; no current settings or account totals may be presented as historical facts.
