# UI Spec: Task 6.4 — Bounded portable workspace export and Usage settings

## Design Inputs

- Task 6.4 adds a bounded export for one owned, active, mutable workspace and completes the existing Usage/settings surface. Its acceptance criteria and Task 1.1 settings guidance define the required states and disclosure.
- Follow release architecture sections 4.3, 7.2, 11, and 12 and the source-only decisions in `architecture-preflight.md`. The export is one versioned JSON download, available for 15 minutes, with a maximum of two active exports per account. It contains workspace files, tasks, memory, conversations, workspace-bound skills, and schedule definitions. It has no import flow.
- Keep the current `/usage` page and its credit/storage cards. Reuse `Card`, `Button`, `Label`, `Alert`, `Skeleton`, `Spinner`, and `EmptyState` from `shared/ui`; use a native labeled select for the owned-workspace picker, matching existing forms. No new shared component or layout framework is needed.
- The developer owns the API contract after Task 7.1 completes. This spec describes visible behavior without assigning endpoint names or inventing response fields.

## User Goal

See current account credit and persistent-storage usage, then prepare and download a portable JSON copy of one active workspace they own.

## User Flow

1. The user opens `/usage`. Existing credit, storage, and AI-availability sections load using their current states.
2. The Export section independently loads eligible active, mutable workspaces owned by the current account. The user selects one and chooses **Prepare export**.
3. While preparing, the selection and submit action are disabled and the section announces progress. A second request is not started by repeated activation.
4. On success, the section shows the selected workspace, JSON size if returned, and the server-provided absolute expiry in the user's locale/time zone. The user chooses **Download JSON**.
5. The download is owner- and session-authorized at download time. If the artifact has expired or become unavailable, the user sees a generic unavailable message and can prepare a new export.
6. An oversized workspace, reached active-export limit, unavailable workspace, or expired/disabled session shows its specific recovery state below. The page never presents a partial export as complete.

## Screens / Views

### Usage page with Export section

- **Layout:** Keep the existing `/usage` header and three-column credit/storage cards. Add one full-width **Export a workspace** card below usage and availability. Keep its scope, privacy, and expiry explanations visible without a new dashboard, wizard, or modal.
- **Export content:** A labeled **Workspace to export** select lists only active, mutable workspaces owned by this account. Explain that the JSON includes workspace files, tasks, saved memory/facts/context, project and Home conversations, workspace-bound skills, and schedule definitions. Schedule run history remains in its existing Home transcript. State that credentials/secrets, other workspaces, account-wide skills, internal recovery data, and security/audit records are excluded. Explain that this is a download only; there is no import or restore action.
- **Usage distinction:** Keep the existing credit cards authoritative for configured AI budget. Keep storage labeled as logical persistent data with exact bytes; it is not physical disk usage. State that transient export files have a separate size/expiry limit and do not count toward persistent account storage.
- **Provider and retention disclosure:** State that workspace data is stored on the operator-controlled deployment and that selected AI context is sent to the configured inference provider. Show a provider name only when supplied by current server configuration; otherwise say **Provider information unavailable**. Explain that export expiry covers this temporary application artifact only: deployment backups and provider-side data follow their own retention policies, and exporting, editing, or deleting workspace data does not promise erasure of copies already held by a provider or backup.
- **Loading:** Preserve the current Usage skeletons. Independently show a small `Skeleton`/`Spinner` in the export card while eligible workspaces load; disable the select and action and mark the region busy.
- **Ready:** Show the select, concise include/exclude and retention copy, and **Prepare export**. Disable the action until a workspace is selected. While preparing, show **Preparing export…**, set `aria-busy`, and prevent duplicate activation.
- **Export ready:** Show **Export ready**, the workspace name, the returned file size when available, and the absolute expiry. Provide **Download JSON** as a normal keyboard-operable download action. The 15-minute TTL begins when preparation succeeds; do not imply that clicking the link guarantees a file was saved. Do not add an artifact history or deletion control.
- **No eligible workspace:** Show **No active workspaces available to export.** Only an owned active workspace can be selected. The canonical public showcase has no export action; a private demo may export only its own editable copy.
- **Workspace-list error:** Show an `Alert` and **Try again**. Preserve a still-valid selection only if it remains in the refreshed owned list; otherwise clear it.
- **413 / size limit:** Explain that the workspace exceeds the supported export size, nothing downloadable was created, and the user must reduce workspace content before retrying. Never offer a partial file or imply that the workspace can be split into exports.
- **429 / active-export limit:** Explain that at most two exports can be active per account and each expires within 15 minutes. Ask the user to wait for one to expire before trying again. Do not invent an active-count display or an artifact-management action.
- **Expired or unavailable artifact:** For expired, missing, foreign, or removed artifacts, use the same non-enumerating message: **This export is unavailable. Prepare a new export.** Do not reveal whether another user's artifact exists.
- **Disabled/expired session or demo:** Use the existing session/expiry surface and actions. Revoke access to the download; never imply that an expired demo can be recovered or that a new session retains its prior workspace.
- **Other preparation/download error:** Keep the selected workspace when still eligible, show an `Alert` with **Try again**, and leave the export action available when the server permits. Do not report success until the server returns a ready artifact.
- **Existing Usage error/empty states:** Retain the current usage error and **Try again** behavior, including its rule that AI controls stay disabled until allowance is confirmed. Preserve **No AI usage yet** and existing storage-unavailable copy. Keep export status separate from credit/storage status; do not label an export failure as a quota or credit failure.

## Component Inventory

| Component | New or Existing | Notes |
|---|---|---|
| `/usage` page and credit/storage sections | Existing | Preserve `UsagePage`, account-usage entity, cards, and current loading/error/empty/success behavior. |
| Export card and selection/action state | New feature composition | Add a focused workspace-export feature to the existing page; reuse the existing owned-workspace list/API. No new settings framework. |
| Workspace picker | Existing native form pattern | Native `<select>` with visible `Label`; include only server-listed owned active mutable workspaces. |
| Card, Button, Alert, Skeleton, Spinner, EmptyState | Existing shared UI | Reuse project primitives and semantic alert tones. |
| Provider and retention notice | Existing page copy pattern | Plain text within the Export card; provider name must come from actual server configuration. |

## Responsive Behaviour

Use the existing Usage page width and spacing. Stack the picker, preparation/download actions, and information copy on narrow screens; buttons may fill the available width and must wrap safely. Keep names, file sizes, and localized expiry dates readable without horizontal scrolling. On desktop, retain the current card grid and place Export as one readable full-width section. Do not add a new navigation surface.

## Theming / Dark Mode

Use existing light/dark surface, text, border, focus, and semantic alert tokens. Status and privacy meaning must remain clear without color; no one-off token overrides are needed.

## i18n / Localisation

No translation runtime is established. Format file sizes and expiry dates using existing locale conventions. Keep all user-facing copy in the project's current convention.

## Accessibility Notes

Target WCAG 2.1 AA. Use the page's existing landmarks and heading order. Give the workspace select a visible associated label; keep actions as buttons or normal download links. Ensure all controls are reachable in visual order with a visible focus ring. Mark preparation as busy and announce progress/ready updates politely; announce errors with the existing alert pattern. Do not convey status by color alone. Keep copy readable at 200% zoom and maintain text/UI contrast in both themes. No modal or custom focus behavior is required.

## Design References

- `.codex/docs/hackathon-release/tasks.md` — Task 6.4 and Task 1.1 settings states.
- `.codex/docs/hackathon-release/architecture.md` — sections 4.3, 7.2, 11, and 12.
- `.codex/docs/hackathon-release/task-6-4-workspace-export/architecture-preflight.md` — scope, JSON content, ownership, limits, and expiry.
- `Personal-AI-Workspace/frontend/src/pages/usage/UsagePage.tsx` and `Personal-AI-Workspace/frontend/src/shared/ui/` — current page and reusable UI.
- No mockups or screenshots are required for this handoff.

## Open Questions / Decisions Needed

No design decision blocks handoff. The developer-owned contract must map server outcomes to the 413, 429, session, unavailable-artifact, and retry states above and supply actual artifact size/expiry and configured-provider information where available. Implementation remains sequenced after Task 7.1's schema and cleanup work.
