# UI Spec: Task 4.2 — Direct Home actions and truthful receipts

## Design Inputs

- Task 4.2 runs each user-requested Home task or workspace action through its existing canonical handler and shows a persisted receipt per applied action. The current Home Activity surface is `HomePlanningRecords` inside `HomeChat`; it already loads receipt metadata and the current task/workspace target.
- The receipt contract adds persisted `actorKind` (`assistant` or `manual`) and nullable `turnId` to the existing read/undo DTOs. The current implementation uses these stored values as provenance; a Home request remains an assistant action even though the user asked for it. The Home record hook uses the persisted turn ID for card placement and never shows the ID.
- A turn may contain several independent actions. Show only server-confirmed applied, conflicted, partial, or unknown outcomes. Do not suggest a group rollback or infer success from the `action.receipt` event pointer. Exact replay is available in the direct tool response, but is not stored in the receipt metadata; do not claim an exact replay from a reloaded receipt pointer.
- Preserve Task 4.1’s read-only Home/workspace policy summary and retired-decision behavior. Legacy proposal history cannot be accepted or resumed. Task 4.3 owns task deletion and archive removal.
- Reuse the current Home chat layout, `HomePlanningRecords` / `ReceiptCard`, shared `Card`, `Alert`, `Button`, and React Router `Link`, plus the existing token styling. The existing preview browser journey was exercised with synthetic fixtures; evidence is stored at .codex/docs/hackathon-release/task-4-2-direct-home-actions/artifacts/home-receipt-journey.png and the adjacent JSON.

## User Goal

See which Home-requested changes were actually applied, who the saved record attributes them to, and what remains unresolved.

## User Flow

1. The user opens Home chat or a rootless workspace chat. Task 4.1’s current policy/readiness state governs whether a new request can run.
2. The user asks for a supported task or workspace change. It executes directly through the authorized handler; no proposal-acceptance step is inserted.
3. For each `action.receipt` pointer, the existing Activity card loads the owner-scoped receipt and target. It shows the readable action label, source from persisted `actorKind`, and `Applied`; it links to the current target when available.
4. An exact replay is labeled as a confirmed replay only when the server marks it as such. It reuses the original receipt and does not imply another change occurred.
5. If later actions conflict or fail, keep earlier receipts visible and show the known partial result. If an outcome is unknown, keep it unconfirmed and provide only the existing same-request status reconciliation path.
6. Old proposal history remains readable in Task 4.1’s retired, read-only state; it has no Apply, Accept, Resume, or Reject action.

## Screens / Views

### Home chat turn and Activity receipt cards

- **Layout:** Keep each receipt card under its source assistant turn in the existing Home chat. Keep receipts whose turn is not in the displayed history in the existing saved-activity area. Within a card, show a plain-text source label (`Assistant` or `You`), a concise action label, an optional current target link, and the outcome state. Never display receipt IDs, target UUIDs, or turn IDs.
- **Components:** Existing `HomeChat`, `HomePlanningRecords`, `ReceiptCard`, `Card`, `Alert`, `Button`, and `Link`; no new screen, dialog, or shared component.
- **Copy and states:**
  - History loading/error: retain Home chat’s existing loading and retry states.
  - No action receipt: render no empty Activity card; keep the normal conversation empty state.
  - Receipt loading: `Checking receipt…` as a polite status.
  - Applied: show a heading such as `Created task · Assistant` or `Updated task · You`, and the target name as a link when available. Use `Applied` as the state label; existing undo availability/completion copy remains secondary.
  - Exact replay: when the tool result confirms replay, say `Already applied. This retry returned the original action; no duplicate change was made.` Do not show this from a receipt pointer alone.
  - Known conflict/non-applied result: show a warning in the originating turn with a safe explanation such as `This item changed before the action could be completed.` Add `No changes were made` only when the server confirms that fact. Do not create a success receipt for this outcome.
  - Partial result: retain each confirmed applied receipt and show only a server-confirmed per-action summary, for example `Some requested changes were applied; the remaining action was not completed.` Do not imply rollback or count actions the server did not confirm. The runtime now receives a bounded known-version-conflict result. Keep earlier confirmed receipts visible and explain only outcomes confirmed by receipts and tool results; this slice adds no separate batch-status store.
  - Unknown result: say `The result is not confirmed. Check status before trying again.` Use the existing same-request status/reconciliation control only. Do not fabricate an applied receipt or start a fresh action retry.
  - Receipt lookup error: keep any previously loaded receipt metadata, but show `The saved receipt could not be checked.` with the existing `Refresh receipt` button. If no receipt metadata loaded, leave the outcome unconfirmed. A refresh may recover the state; it must not submit another mutation.
  - Target unavailable: keep the saved receipt and source visible, with `The saved target is unavailable.` Do not expose whether a foreign target exists.
  - Undo: show `Undo` only while the receipt says it is available; preserve pending (`Undoing…`), conflict, retry, unavailable, and completed states and existing canonical behavior. Disable the control while undo is pending and expose its busy state. Undo is separate from the direct-action outcome label.
  - Controls: keep existing button variants; provide visible hover and focus-visible states. Disable actions while their own request is pending, and retain a readable state when undo is unavailable.

## Component Inventory

| Component | New or Existing | Notes |
|---|---|---|
| Home chat and turn composition | Existing | `HomeChat` renders records with their assistant turn. Preserve Task 4.1’s policy/readiness summary. |
| Activity receipt card | Existing, adapted | `HomePlanningRecords` / `ReceiptCard`; display persisted actor provenance and truthful action outcome. |
| Receipt metadata and target link | Existing, adapted | `TaskActionReceiptMetadata` and existing receipt/target APIs; accept `actorKind` and nullable `turnId`, keep turn matching internal. |
| Card, Alert, Button, Link | Existing | Reuse shared UI variants and current focus/token styles. |
| Legacy proposal history | Existing, constrained by Task 4.1 | Read-only retired state; no acceptance or resume controls. |

## Responsive Behaviour

Keep the current Home chat layout and let receipt cards fill the available column. On mobile, wrap source/action/target text and actions without horizontal scrolling; keep `Refresh receipt` and existing undo controls reachable at 320px and above. Tablet and desktop retain existing Home chat widths and spacing. Long target names wrap rather than displacing state labels.

## Theming / Dark Mode

Use the existing light and system dark themes and semantic surface, text, border, warning, success, and focus tokens. Outcome meaning must remain in text and must not depend on color. Add no feature-specific token overrides.

## i18n / Localisation

No translation runtime is established. Keep all new source and outcome copy in the project’s existing copy conventions. Never interpolate internal actor or turn IDs into visible strings.

## Accessibility Notes

- Use semantic headings for cards and native links/buttons. Include a readable action and the stored source in the heading; keep the applied state adjacent to it.
- Mark receipt loading and known result updates with a polite live status. Use the existing alert treatment for actionable lookup failures; do not announce every streamed response update.
- Keep a visible focus indicator and logical source order for target links, refresh, and undo actions. Retain text labels on controls; no icon-only receipt actions.
- Pair warning/success styling with explicit outcome text and preserve sufficient contrast in both themes. Wrap long content at 200% zoom.

## Design References

- `.codex/docs/hackathon-release/tasks.md` — Task 4.2 and dependency on Task 4.1.
- `.codex/docs/hackathon-release/architecture.md` — sections 5.2 and 10.
- `.codex/docs/hackathon-release/task-4-2-direct-home-actions/architecture-preflight.md`, `contract.md`, and `source-map.md`.
- `.codex/docs/hackathon-release/task-4-1-stored-tool-policy/ui-spec.md` — policy summary and retired decision behavior.
- `.codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/ui-spec.md` — Home chat, responsive, theme, and accessibility conventions.
- Source inspected: `HomePlanningRecords.tsx`, `use-home-planning-records.ts`, `global-task-api.ts`, `HomeChat.tsx`, and `HomeChatWidget.tsx` under `Personal-AI-Workspace/frontend/src/`.

## Open Questions / Decisions Needed

- None for the implemented receipt provenance and known expected-version conflict slice. The conflict reaches the runtime through a bounded result and creates no receipt. Home Activity continues to display applied state only for committed receipt pointers; it does not fabricate a static conflict or partial card. Exact replay remains response-local and is not inferred from history.
- Documentation updated in this session: .codex/docs/hackathon-release/task-4-2-direct-home-actions/contract.md, source-map.md, ui-spec.md, and dev-summary.md. Source manifest: .codex/docs/hackathon-release/task-4-2-direct-home-actions/exact-source-manifest.txt.