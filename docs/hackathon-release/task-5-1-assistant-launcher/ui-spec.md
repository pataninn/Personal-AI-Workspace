# UI Spec: Task 5.1 — Move Home assistant into a floating Ask panel

## Design Inputs

- Task 5.1 and Architecture section 4.1; apply Task 1.1 UI spec sections A (overlays), B (Home), and C (Ask/history).
- Read-only source review: `AppShell.tsx`, `DashboardPage.tsx`, `HomeChatWidget.tsx`, `HomeChat.tsx`, `use-home-chat.ts`, and the existing shared UI wrappers. Today Home mounts the full chat inline; the authenticated `AppShell` remains mounted around its route outlet.
- Reuse the Home chat feature and its server-owned policy summary, history, transcript, run status, retries, stop action, and planning records. Keep the Home feature mounted in the authenticated shell so closing the panel and changing routes do not discard its draft or active run. Key/reset its private client state when the principal changes.
- Keep the existing lime/neutral tokens, Geist/Bricolage typography, and Radix wrappers. No external mockup or new design-system primitive is needed. This is a source-based handoff, not browser/runtime evidence.

## User Goal

Open Ask from any authenticated workspace page, continue a Home conversation without losing work, and return to tasks or workspaces when finished.

## User Flow

1. The user sees a small bottom-right Ask launcher while in the authenticated workspace shell. Home workspaces and tasks remain the primary page content.
2. Activating Ask opens a bounded desktop dialog or a mobile drawer. Focus moves into the panel.
3. The header shows the current conversation title. The user opens history and selects a conversation in two clicks from the open panel, or starts a new conversation.
4. The user reads the transcript, enters a message, and sends it. Existing policy, streaming, status, stop, retry, and result behavior remains in the Home chat feature.
5. Closing Ask hides the panel without cancelling a run or clearing the draft. Reopening, or navigating to another authenticated route and back, resumes the same Home state.
6. On sign-out, expiry, or a change of principal, remove the launcher and clear the previous principal’s private Ask state and selected conversation.

## Screens / Views

### Closed launcher

- Use a chat icon and visible `Ask` label, fixed bottom/right 24px on desktop and 16px on mobile plus the safe-area inset. Reserve enough shell content space that the launcher does not cover task or pagination controls.
- Success: the launcher is available in the authenticated user workspace shell. Keep it hidden on login/admin routes and unavailable while another modal owns focus.
- Focus and hover use existing Button variants and focus tokens; the icon is decorative beside the visible label. The accessible name is `Open assistant`.

### Ask panel

- Desktop: Radix `Dialog` at bottom-right, width `min(440px, viewport minus 48px)`, max height `min(640px, viewport minus 48px)`. Opening is modal; close it to return to page interaction.
- Mobile: Radix `Drawer`/dialog sheet fills the available height above safe areas and the virtual keyboard. Keep the header and composer reachable; only the transcript scrolls.
- Header: `Ask`, the current conversation title as the history trigger, `New conversation`, and `Close assistant`. Truncate long titles visually while retaining the full accessible name.
- Show the current `Home` scope and the existing server policy/context summary. Only show selected target/context names the current feature already provides; do not infer scope from the route or add a selector, endpoint, or policy.
- Transcript reuses existing Markdown messages, action/result links, and planning records. Keep its scroll independent from the fixed header and composer.
- Empty transcript: `What would you like to work on?` with example `Plan my day from my tasks and saved working hours.`
- Composer has visible label `Message`, placeholder `Ask about your work`, a 20,000-character limit, and send feedback. Enter sends; Shift+Enter adds a line; do not send during IME composition.
- Loading: retain the existing conversation/list loading skeleton and polite status.
- Empty: show the empty transcript prompt and, in history, `No conversations yet` plus `New conversation`.
- Error: preserve the draft; show the existing history/runtime/policy or send error and its matching retry/status action. Do not treat an observed preview fixture response as a product-wide failure.
- Success/running: show the selected transcript and result links. Announce state changes such as `Assistant is responding` and `Stopping`, provide `Stop response`, and do not announce each streamed token. Closing does not stop the run.
- Unknown/interrupted result: retain the existing status-check/reconnect actions and do not silently resend. Disable sending when blank, policy/runtime unavailable, read-only, or the existing controller reports submission blocked.

### Conversation history menu

- A single history trigger opens a Radix `DropdownMenu` with conversation title/date rows, current selection, and `Load more` when available. Selecting a row returns to the transcript; no nested history screen.
- Loading: `Loading conversations` and a compact skeleton. Empty: `No conversations yet` with the header’s New conversation action available. Error: `Conversations could not be loaded` and `Try again`. Success: visible conversation rows with full accessible titles and dates.
- Arrow keys move between menu items. Escape closes the menu first; a second Escape closes the panel and restores focus to the launcher. Menu selection must not cancel an active run or erase a preserved draft.

## Component Inventory

| Component | New or Existing | Notes |
| --- | --- | --- |
| AppShell Ask launcher/panel composition | Existing shell, adapted | Keep one Home assistant mounted beside the route outlet; import the lower `features/home-chat` feature directly. Do not add a sibling `widgets/home-chat` import. |
| HomeChat / useHomeChat | Existing feature, adapted | Reuse Home scope, history and transcript state, draft, reconnect, retries, cancellation, policy, and result behavior; change only panel presentation and required preservation behavior. |
| HomePlanningRecords / AssistantPolicySummary | Existing | Keep real action links and server-owned scope/policy disclosure. |
| Dialog, Drawer, DropdownMenu | Existing `shared/ui` | Use current Radix wrappers for focus, dismissal, and menu keyboard behavior. |
| Button, Icon, Label, Textarea, Alert, Skeleton, Spinner, MarkdownContent | Existing `shared/ui` | Reuse current variants and tokens; no new shared primitive. |

## Responsive Behaviour

- Below 640px use the full-height sheet with safe-area and virtual-keyboard insets; transcript scrolls independently and composer stays reachable.
- At 640px and above use the bounded panel. Keep it within the viewport and preserve the shell’s existing responsive navigation.
- At narrow widths, wrap header controls as needed and keep all composer actions visible without horizontal page scrolling.

## Theming / Dark Mode

Support the existing light and dark themes using current background, surface, text, border, primary, scrim, and focus tokens. Do not add feature-specific colors. Verify muted text, borders, focus, and status labels in both themes.

## i18n / Localisation

Use the English strings listed here and existing Home chat copy. No new localization framework or locale-specific behavior is part of this task.

## Accessibility Notes

- Use the existing Radix Dialog/Drawer focus trap and trigger restoration. Give each panel a title and description; keep visible `Ask` text on the launcher and a visible label on the message field.
- The history trigger exposes its expanded state and accessible current title. Use Radix menu arrow-key navigation; Escape closes history before the panel.
- Keep visible focus rings and at least 4.5:1 contrast for normal text; never use color alone for run/error status.
- Announce loading and run-state changes politely, not each token. Do not steal focus or force-scroll while a user reads older messages; expose `Jump to latest` when new output arrives offscreen.
- On principal change, discard in-memory messages, history, draft, and run UI state and clear the selected Ask conversation so another account cannot inherit private state.
- Core keyboard path for implementation evidence: open Ask, open history, select a conversation, close menu, close panel, reopen and confirm selection/draft/run status are retained.

## Design References

- `.codex/docs/hackathon-release/architecture.md` section 4.1.
- `.codex/docs/hackathon-release/tasks.md` Task 5.1 and Technical Debt Log entry for Task 5.2.
- `.codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/ui-spec.md` sections A, B, and C.
- Source references listed in Design Inputs. No external mockups, screenshots, or runtime evidence were used.

## Open Questions / Decisions Needed

- The Ask launcher uses `{ kind: 'home' }` and the existing server policy/context behavior. The workspace planning chat remains its existing full-page surface; do not make the launcher inherit the current route’s workspace scope.
- Task 5.2’s preview-only smoke recorded a 404 for the existing Home conversation-list request `GET /api/v1/home/conversations?scope=home&limit=50`; its cause is unverified. Task 5.1 implementation evidence must reproduce and resolve the history fixture/path using the existing API contract, or document why it is unavailable. Do not invent a route or infer a live service failure.
- The current feature stores its draft in component state and selects conversations through the URL. Keep it mounted across close/navigation, reset private state on principal change, and verify that the Ask selection cannot carry across accounts. No `app/routes.tsx` edit is needed: the existing AppShell is the persistent authenticated route parent.
