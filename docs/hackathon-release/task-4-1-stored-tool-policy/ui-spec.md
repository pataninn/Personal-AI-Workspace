# UI Spec: Task 4.1 — Stored tool policy and workspace-scoped automatic execution

## Design Inputs

- Task 4.1 replaces routine per-turn provider consent and proposal acceptance in Home and workspace execution with server-stored policy. In-scope actions run automatically; excluded context, foreign workspaces, protected paths, host paths, admin actions, unsupported commands, and forbidden destinations remain blocked.
- Apply Architecture sections 5.2 and 12, plus Task 1.1 sections A (states and accessibility), C (assistant and automatic tools), and F (provider disclosure and selected context). This task does not introduce the floating Ask launcher from 5.1 or task editing from 5.3.
- Inspected current source under `Personal-AI-Workspace/frontend/src/`: `features/home-chat/ui/HomeChat.tsx`, `widgets/home-chat/HomeChatWidget.tsx`, `pages/workspace-planning-chat/WorkspacePlanningChatPage.tsx`, `features/ai-run/ui/ChatComposer.tsx`, `features/ai-run/ui/AiRunEntry.tsx`, `features/ai-run/ui/AiRunTimeline.tsx`, `ProviderConsentDialog.tsx`, `ProviderPermissionManager.tsx`, `ProposedChangeReview.tsx`, `CommandProposalCard.tsx`, `CommandExecutionSurface.tsx`, `ContextScopePicker.tsx`, and `MemoryContextPicker.tsx`.
- Reuse the existing lime/neutral token system, typography, Radix wrappers and shared UI. The inspected repository had six pre-existing working-tree files; they were preserved. This is a source-based design handoff, not browser or runtime evidence.

## User Goal

Ask the assistant to work inside the selected workspace without routine approval clicks, while knowing which provider and context are active and seeing when policy blocks an action.

## User Flow

1. Home or a workspace chat loads the authenticated scope, stored policy, safe capability summary, and provider/runtime status from the server.
2. When enabled, the user sees the current provider and model, the workspace scope, and a concise account of the context categories and selected items that can be sent. A non-blocking cloud disclosure remains available at entry and in settings.
3. The user sends a request. The client makes one submission; the server checks account/workspace authorization, quotas, selected-context exclusions, provider readiness, sandbox bounds, and egress policy before admitting paid inference or tools.
4. Authorized in-scope work runs without a provider-consent dialog, proposal acceptance, or command-approval step. The transcript shows progress and then the actual result and action receipts.
5. A blocked action explains that workspace policy stopped it and whether the server confirmed that no change was made. It does not offer an approval button or a route to widen access from chat.
6. If provider/runtime readiness is absent, or an outcome is uncertain, preserve the draft and use the appropriate retry or status-reconciliation path. Never silently resend an uncertain request.

## Screens / Views

### A. Shared provider, scope, and included-context summary

Use a compact read-only summary at the top of each existing Home/workspace assistant surface, before the transcript or composer. Keep the current Home/workspace label and add server-provided values:

- **Provider:** the configured provider and model, for example `Nebius Token Factory · Nemotron 3 Super 120B`, only when those exact values are returned by the server. Show availability separately. A dev/fake runtime must never appear as a live provider.
- **Scope:** `Home` or the named current workspace. Do not show account IDs, container names, host paths, or secrets.
- **Included with this request:** server-confirmed categories and selected user-visible items, such as this message, bounded recent conversation, selected facts, or selected project-relative files. Do not imply unselected context is included.
- **Not included:** explicitly selected exclusions and a concise statement that protected locations, other accounts/workspaces, and unselected facts/files remain outside the assistant's access. Never enumerate protected or foreign paths.

Treat this as the fixed, read-only Home or workspace scope profile, not an editable policy. Home uses the server-reported Home label; direct workspace chat uses the server-reported workspace label. Read the contract-defined `AssistantExecutionPolicyStatus` paths: `scope.kind` and `scope.label`; `policy.enabled`, `policy.revision`, `policy.provider.name` / `policy.provider.model` (or null provider), `policy.included.categories` / `policy.included.items`, `policy.exclusionsEnforced`, and `policy.capabilities`; top-level `fileAccess`; and `readiness.state` / `readiness.reasonCode`. Map closed capability enums to plain labels; do not display raw profile/capability keys, owner/project IDs, revision digests, destination lists, or protected-path inventories. For a Home action targeting a workspace, show both server-resolved scopes and only their effective capability intersection when the run/status response supplies it; do not infer authority from a picker or model message. A null or disabled/revoked policy, null provider, or unavailable readiness blocks provider/tool execution. This read-only snapshot does not authorize later dispatches. Keep this summary visible without a dialog. A small native disclosure may expand details on narrow screens. Reuse existing `ContextScopePicker` and `MemoryContextPicker` where the current surface provides them; persisted project context remains the sole source for selected/excluded files, facts, and messages. Exclusions take precedence over every inclusion. Choosing context remains separate from provider/tool authorization. Do not add a second scope picker or automatically select excluded items.

Use this entry/settings disclosure copy, populated with server values: **“Workspace data is stored on the operator-managed deployment. Selected context is sent to {provider} for AI responses. Review provider terms and data settings.”** Link to provider terms and the existing settings destination when available. It is informational and non-modal; it does not ask the user to accept each turn. Do not invent a settings route or build a policy editor in Task 4.1.

If only file access is unavailable, say **“Files and file tools are unavailable in this workspace. Task and planning assistance remain available where enabled.”** Do not infer that all AI assistance is disabled from a file-access capability.

### B. Home and workspace conversation execution

Keep the current Home and workspace planning layouts and project conversation layout. Keep history, selected conversation, context selection, and composer behavior. Task 4.1 changes authorization feedback and execution states, not the future Ask entry point or task editor.

- Empty: retain the existing welcome prompt and saved-conversation empty state.
- Loading: show a concise status such as **“Checking assistant availability…”** while policy/runtime status loads. Do not submit until the server confirms the necessary capability.
- Ready: enable the composer and show the provider/scope/context summary above it. Preserve the existing Ctrl+Enter/Cmd+Enter send shortcut and message draft.
- Submitting/running: show **“Sending…”** then **“Working in {workspace}…”** as server states permit. Prevent duplicate submission. Keep **Stop response** reachable while running. Tool progress may name the safe action category (for example, “Reading selected project files”), but must not reveal internal paths or credentials.
- Success: render only server-confirmed status and receipts from already-authorized handlers. Link to a resource only when it is owner-accessible. Identify the actor/source as Assistant or the actual skill/automation in Activity; never say the user accepted a proposal. Show partial results honestly.
- Informational preview: a useful bounded preview may remain as optional details, but it is never an approval gate. Do not treat a legacy proposal or change set as an authorized mutation. Bulk proposal/change-set application and Home task/workspace mutations without an existing safe canonical handler remain blocked until their owning task implements that handler.
- Archived/read-only workspace: preserve the existing explanation and disable mutation controls with an associated reason. Do not treat this as a provider-consent state.
- Disabled or expired account: preserve the existing session/account state and disable dispatch; do not recast it as provider unavailability or offer a consent fallback.

Remove all legacy mutating decision controls from both automatic and legacy paths: Home's `ConsentDialog` (“Allow this turn” / “Share and continue”), `ProviderConsentDialog`, the remembered-permission manager as an authorization gate, proposal Accept/Reject controls and apply-confirm dialog, and command Approve/Reject controls. Replace them with the read-only policy summary, direct run status, actual receipts, and policy-blocked state below. Keep context selection, safe previews, status refresh, cancellation, and result history where their contracts still apply. Chat cannot alter provider policy, grant new destinations, or perform admin changes. Every legacy consent, provider-egress, proposal, change-set, and sandbox-command decision endpoint returns 409 POLICY_ACTION_RETIRED for every decision value, including deny/reject; no safe reject/deny variant remains. It makes no state change and cannot continue a runtime or mutation. Never call or retry one of these endpoints from a stale UI. Existing pending or previously approved records are not resumed: show a safe blocked legacy state, keep owner-scoped GET/status/history readable, and require a fresh request only if the action is supported by the current policy and an existing safe handler. A separate authenticated Cancel action may appear only when the server reports cancellable work; cancellation is not a reject/deny decision. Existing project-context exclusions and account disable/expiry controls remain effective. Do not add policy edit or general revoke controls. Existing provider_permissions are exact project/provider/model history, not current scope policy; if a historical permission view is retained, do not present it as effective policy or claim its revocation disables the new scope policy.

### C. Provider unavailable, blocked scope, and no-egress states

These are inline states on the existing chat surface, not confirmation dialogs:

| Condition | User-facing state | Interaction |
| --- | --- | --- |
| Policy/capability still loading | “Checking assistant availability…” | Composer remains disabled; retain draft and current conversation. |
| Provider unavailable or configured runtime not ready | “The configured AI provider is unavailable. The request was not delivered to the provider.” | Keep draft; offer **Try again** only after a server status refresh or an explicit retryable response. |
| Bounds, quota metering, sandbox, or egress verification missing | “AI execution is unavailable for this workspace. No AI request was sent.” Add a short safe reason only when the server provides one. | Fail closed. No fake-ready indicator, provider switch, repeated consent, or command-approval fallback. |
| External inference disabled / no permitted egress | “External AI requests are disabled for this workspace. No external AI request was sent.” | Preserve local draft and history. No alternate external destination. |
| Excluded, protected, foreign, or out-of-scope action | “This action is outside the workspace policy.” If confirmed by the server, add “No changes were made.” | No **Allow**, **Approve**, or “run anyway” control. Do not reveal whether a foreign/protected path exists. |
| Legacy pending or previously approved consent/egress/proposal/change-set/command record | “This saved action cannot be resumed. Start a new request if the action is supported for this workspace.” | Use GET/status/history only. If the server reports cancellable work, expose a distinct Cancel action. For 409 POLICY_ACTION_RETIRED, show “This approval action is no longer available.” Refresh status/history; never retry any decision value. No safe reject/deny variant remains. |
| Ambiguous target | Ask a direct clarifying question, such as “Which workspace task do you mean?” | Offer only valid in-scope targets; clarification is not a permission request. |
| Stale version or unsafe promotion/backup check | “The workspace changed before this action could be completed.” Add “No changes were made” only when the server confirms no change. | Read status and show confirmed outcomes. Do not retry an uncertain or partial result; a fresh request is available only when the current policy and handler allow it. |
| Provider or run outcome uncertain | “The result is not confirmed. Check run status before starting this request again.” | Refresh/reconcile the same run; do not automatically repeat inference or mutations. |

The application may save a message before provider admission. Keep a saved transcript item distinct from an unsent composer draft; copy must describe provider delivery accurately. Do not claim “no changes were made” for a partial or unknown result. Do not display command working directories or provider credentials. Command cards should show a safe summary, workspace-relative scope, bounded status/output, and **Stop** where supported. If a command or destination is outside policy, show a blocked result without approval controls. Network access is described as restricted only when the server reports the verified policy; never imply arbitrary internet access.

### D. UI transition map

```text
Load scope and policy
  -> Ready + capability confirmed
       -> Submit once
            -> Server admits request -> Running -> Completed / Partial / Failed / Stopped
            -> Scope/tool denied -> Blocked (no approval branch)
            -> Provider unavailable -> Retryable unavailable (draft kept)
            -> Unknown outcome -> Reconcile same run (no blind resend)
  -> Legacy pending/previously approved record
       -> Blocked history state; separate cancel only if supported
  -> Capability/runtime unavailable or unverified
       -> Fail closed; composer/action disabled with reason
       -> Refresh when status can be rechecked
```

A file-access denial does not by itself disable task or planning features; each capability follows its own server authorization. If the server cannot confirm the full bounds and egress policy for a paid runtime, no request or tool dispatch is admitted. Client visibility is not authority.

## Component Inventory

| Component | New or Existing | Notes |
| --- | --- | --- |
| Home/workspace chat layout and composer | Existing: `HomeChat`, `HomeChatWidget`, `ChatComposer` | Preserve history, draft, scope, and current keyboard shortcut. |
| Provider/scope/context status | Local composition of existing shared markup | Add a compact read-only summary in each relevant chat surface; do not create a new shared primitive or policy editor. |
| Context selectors | Existing: `ContextScopePicker`, `MemoryContextPicker` | Preserve user-selected include/exclude state; protected/foreign data never becomes selectable. |
| Provider disclosure/terms | Adapt existing provider copy and `ProviderTerms` | Move disclosure to entry/settings/run details; no per-turn dialog. |
| Run progress and receipt | Existing: `AiRunTimeline`, Home chat status, `RunStatusCard` | Server-confirmed status, safe tool progress, partial outcomes, cancellation and reconciliation. |
| Change/command result | Adapt `ProposedChangeReview`, `CommandProposalCard`, `CommandExecutionSurface` | Keep previews informational; legacy decision cards are blocked/read-only with no approve/reject/deny action. GET/status/history remain, and cancellation is a separate authenticated action only when supported. |
| Status, alert, button, link, spinner, skeleton | Existing: `shared/ui` | Reuse established variants, focus rings, pending and error patterns. |

## Responsive Behaviour

- Mobile (360–639px): keep the existing single-column chat; wrap provider/scope details; put optional context detail in a keyboard-operable disclosure; keep composer and Stop reachable above the virtual keyboard. Long project-relative names wrap within the result card. No page-wide horizontal scrolling.
- Tablet (640–1024px): preserve the current workspace navigation/chat relationship; status summary may use two rows.
- Desktop (>1024px): use existing content width and workspace panes; keep the summary visually secondary to the conversation.
- Preserve existing spacing, 44px minimum control targets, and focus-ring tokens. Do not add a floating Ask button or overlay to this task.

## Theming / Dark Mode

Support existing light and system dark themes using current surface, text, border, status, and focus tokens. Keep status meaning in text as well as color. No new theme or feature-specific color tokens.

## i18n / Localisation

No translation runtime is established in the inspected project. Keep new strings in the existing copy conventions and avoid embedding provider names or capability decisions in translated string keys; populate them from server values.

## Accessibility Notes

- Use a visible label for the composer and native links/buttons/disclosures. Preserve the current Ctrl+Enter/Cmd+Enter shortcut and do not send on plain Enter or during IME composition.
- Announce queued/running/completed/blocked states through a polite live region; use an alert for actionable failures. Do not announce every streamed token or move focus as output arrives.
- Keep keyboard focus in the composer after submission; Stop, status refresh, and retry controls remain reachable in source order. If a state change removes a focused control, move focus to its status heading and provide a visible focus ring.
- Expandable policy/context details expose their expanded state and remain keyboard-operable. Keep included-context labels associated with their values; use text for status instead of color alone.
- Do not open a modal for routine provider/tool decisions. Any future settings dialog remains outside this task and must use the existing Radix focus/escape behavior.

## Design References

- Canonical requirements: `.codex/docs/hackathon-release/architecture.md` sections 5.2 and 12; `.codex/docs/hackathon-release/tasks.md` Task 4.1.
- Task 4.1 decision references: architecture-preflight.md and contract.md in this task folder.
- Baseline UI and tokens: `.codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/ui-spec.md` sections A, C, F, Responsive Behaviour, Theming / Dark Mode, and Accessibility Notes.
- Implementation references listed in Design Inputs. No external mockups or browser screenshots were used; browser layout, keyboard behavior, and runtime policy states remain to be verified by implementation/test evidence.

## Open Questions / Decisions Needed

- The finalized developer contract fixes the read-only status fields and uniform retired-decision behavior: every legacy decision returns 409 POLICY_ACTION_RETIRED, including deny/reject. Render only safe status DTO values; the snapshot is not authorization. A 409 shows the blocked legacy state and offers status/history refresh, never a decision retry.
- Confirm an existing provider-disclosure/settings destination before wiring a link. Task 4.1 adds no policy editor, general revoke control, or account/admin policy UI. Existing provider_permissions remain narrow project/provider/model history, not the scope policy.
- Task 4.1 does not implement the floating Ask launcher (5.1), task editor (5.3), policy administration, browser evidence, or provider/network verification.
- Designer modified only `.codex/docs/hackathon-release/task-4-1-stored-tool-policy/ui-spec.md`. No application files, tests, contracts, or task tracking files were edited.
