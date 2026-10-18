# UI Spec: Confirm baseline and define screen states

## Design Inputs

- Source of truth: `.codex/docs/hackathon-release/architecture.md` sections 1–9, 11–14 and `tasks.md` Task 1.1. Preserve all task IDs and release scope.
- Read `.codex/AGENTS.md`, `.codex/WORKFLOW.md`, `.codex/agents/designer-ui-ux.toml`, `.codex/docs/AGENTS.md`, and required ui-design, design-system, accessibility skills. No root WORKFLOW.md exists; the canonical file is under .codex.
- Actual source references under `Personal-AI-Workspace/frontend/src/`: `app/routes.tsx`, `app/styles/globals.css`, `widgets/home-overview/HomeOverviewWidget.tsx`, `widgets/app-shell/AppShell.tsx`, `widgets/project-workspace/ProjectWorkspaceLayout.tsx`, `pages/task-detail/TaskDetailPage.tsx`, `features/project-tasks/ui/TaskEditorDialog.tsx`, `features/project-memory/ui/ProjectMemoryManager.tsx`, and `shared/ui`.
- Preserve lime primary, neutral canvas, rounded surfaces, Geist body/Bricolage headings/Geist Mono technical metadata. No new visual system or external design file is assumed.
- Baseline source has a route detail Edit button/archive and editor version/dirty mechanics. Tester independently confirmed the existing editor already guards dirty Escape with a Discard task changes? alert; Keep editing preserves draft, Discard restores trigger focus, pristine Escape is silent. Preserve that working guard and extend it to immediate route editing and all exits below. Tester also observed action rows touching metadata cards and mobile Back to tasks touching the action row: section A gaps and Task 5.4 explicitly resolve these. Source inspection alone is not runtime proof; tester/developer own the fixture evidence.

## User Goal

Manage personal work and ask an assistant to act in owned workspaces, with clear data use, limits and persistent results.

## User Flow

1. Sign in, or choose Try demo once to provision/resume a private session and enter its editable showcase copy.
2. Home emphasizes Up next and Workspaces. Add task captures assigned/unassigned work; View all tasks opens `/tasks`; Ask is a small closed launcher.
3. Opening an editable task immediately shows active fields. Save persists one validated mutation; failed save retains draft. Dirty exits warn consistently.
4. Ask exposes history in the header, selected scope and cloud disclosure. Authorized tools execute directly and report outcomes; ambiguous targets need clarification.
5. Memory, Skills and Automations provide visible context, reusable Plan my day and durable daily briefings with Run now/history.
6. Settings provides usage/storage/privacy/export. Admin additionally manages accounts, demo budgets and sanitized showcase publishing.
7. Expiry/disablement stops protected access; exhausted AI credits preserve manual editing where storage permits. Read-only showcase never becomes a mutation target.

## Screens / Views

### A. Shared layout and states

- Main padding 32px desktop, 24px tablet, 16px mobile; section gaps 32px; card/form padding 24px desktop/16px mobile; field groups 16px; label/control 8px; hint/error 4px; related controls 8px. Use existing `--space-*` tokens.
- Retain current typography/token system. Prose/inputs 16px/1.5; metadata 14px; readable narrative width 60–80 characters. Long names/checklist labels wrap; technical content scrolls inside its container.
- Minimum control target 44px square; list rows at least 48px and expand with text. Footer actions wrap with 8px gaps, 16px separation from body. No controls overlapping text.
- Existing primary/secondary/ghost/destructive Button variants; hover uses existing hover/surface tokens, focus uses visible 2px ring and 2px surface offset with `--color-ring`. Disabled stays visible with adjacent reason. Pending submit uses spinner/text and aria-busy; prevent duplicates.
- Every collection: first loading skeleton + status; refresh keeps existing data; empty is separate from load failure and filtered no matches; failed refresh shows stale-data warning/Try again; success shows server values. Every form: default/focus/filled/invalid/disabled/submitting/success/error. Field errors link to labels/hints and preserve input.
- Existing Radix Dialog/Drawer/AlertDialog/DropdownMenu portal wrappers own keyboard/focus. Header z-index token below overlay, menus within overlay above it. One active modal: dirty/delete alert replaces editor content or suspends underlying modal while retaining draft. Keep editing restores same input. No custom focus traps.
- Dialog editors max 640px and available viewport minus 32px; scrollable body with footer reachable. Existing motion at most 150–200ms, honor reduced motion. No new toast infrastructure required; inline status is adequate.

### B. Home / Up next / All tasks / capture

- Existing `/dashboard`: retain Up next then Workspaces reading order/current cards; remove dominant inline Home chat and prominent Inbox block. Up next header has Add task primary and View all tasks secondary/link; wrap below heading on mobile.
- View all tasks goes to existing `/tasks`, available even with zero tasks. Existing unassigned task data remains intact and discoverable. Labels use Unassigned where needed; optional workspace at capture, current workspace default when captured there.
- Tasks show title, workspace, deadline/overdue, importance and status as text. Row opens directly editable detail. Preserve existing search/filter/pagination; no task archive action/filter/status in target UI. Existing workspace archive/read-only behavior stays distinct.
- Loading: independent section skeletons. Empty tasks: `No open tasks yet. Add a task to plan your next step.` Empty workspaces: `No workspaces yet` with existing creation action. All tasks empty: `No tasks yet`; filtered empty: `No tasks match these filters` + Clear filters.
- Error: section-local Try again; preserve stale rows on refresh failure. Success: latest summaries/rows; task creation refreshes lists and announces `Task added` with View task link.
- Add form: Task title required; Details; optional Workspace/Unassigned; supported Status, Importance, Deadline, Checklist. Use existing contract/validation, no invented new metadata. Loading workspace choices does not clear entered text; failure allows unassigned capture where contract supports it.
- New task button `Add task`, disabled blank title/submitting/session invalid/read-only/storage growth blocked. AI-credit exhaustion alone must not disable manual capture. Add failure keeps fields and shows validation/retry. Cancel dirty handling follows section D.

### C. Ask launcher / panel / history / automatic tools

- Mount once in authenticated AppShell; adapt existing home-chat widget/features/conversation logic. Suppress on login/admin and while another modal owns focus. Closing hides without cancelling runs or losing drafts.
- Closed: chat icon + visible Ask, bottom/right 24px desktop or 16px mobile plus safe inset. Reserve bottom content space so it does not cover task/pagination actions.
- Desktop bounded Dialog at bottom-right: width min(440px, available viewport minus 48px), max height min(640px, viewport minus 48px). Explicit modal behavior: close to resume page interaction. Mobile full-height Drawer above safe areas/keyboard; composer fixed within panel, transcript independently scrolls.
- Header: Ask, current conversation title/history trigger, New conversation, Close assistant. Open history in one click; select visible conversation in second. Pagination Load more stays in menu, no nested history screen. Arrow navigation/selected indication; Escape closes menu first then panel, restoring launcher focus.
- History states: Loading conversations; No conversations yet + New conversation; Conversations could not be loaded + Try again; loaded titles/dates/current selection. Long titles truncate visually but retain accessible full text.
- Body scope: `Home · Your workspaces` or selected workspace names. Selected context exclusions remain visible. First-use/info copy: `Selected context is sent to the configured cloud AI provider.` Link settings; no per-turn provider/approval dialog.
- Empty transcript: `What would you like to work on?` example `Plan my day from my tasks and saved working hours.` Composer labeled Message; placeholder Ask about your work. Enter sends/Shift+Enter newline, do not send during IME composition.
- Running: Working + Stop; no repeated permission/Accept proposal on automatic path. Preserve per-conversation drafts on history/New conversation/route changes. If runtime allows only one run, disable another submission with reason while allowing history reading. No dirty warning where chat draft is preserved.
- Success: response and actual Created/Updated/Deleted links; Activity actor Assistant/Skill/Automation, not Accepted by you. Reading an informational preview never becomes a required approval step.
- Errors: retain draft/history; distinguish provider unavailable, out-of-scope, rate limit with retry time, interrupted/unknown outcome, exhausted credits. Reconnect existing run instead of silent resend. Stop explains usage may still be reconciled.
- Send disabled for blank/loading/submitting/read-only/expired/blocked budget; manual task edits remain available for AI-only exhaustion. Ambiguous delete asks `Which Draft proposal task?` with workspace choices; explicit scoped chat delete executes with no second confirm. Unsupported external actions explain scope without an Allow button.

### D. Immediately editable details / Save / dirty exits / Delete

- Preserve `/tasks/:taskId` route and workspace task editor Dialog. Share form field composition; route detail is inline editable on load, no Edit button. Dialog focuses title; route arrival focuses heading to avoid unwanted mobile keyboard, then Tab reaches title.
- Field order title, details, metadata, checklist, source metadata. Metadata two columns only if space permits, otherwise one. Groups 16px; checklist rows 12px gap/8px internals, wrapping labels with nonshrinking remove controls.
- Existing task footer Save primary, Cancel secondary, separated Delete task destructive. Save disabled pristine/submitting/known invalid. No autosave. Normalize editable title/details/null dates/workspace, metadata and checklist IDs/text/order/checked values against loaded baseline. Reverting all changes clears dirty state.
- Save success: route stays, applies canonical returned version/values and announces Task saved; dialog closes/restores row focus. Failed validation focuses first invalid field and retains every draft field. Unknown outcome: `The save result is uncertain. Retry to check the same save.` Same intent, no duplicate mutation. Successful save with failed list refresh says Task saved; some lists could not refresh + Refresh views.
- Loading task: skeleton/Loading task. Error: Task could not be loaded + Try again/Back to tasks. Missing/foreign/deleted: Task is unavailable without owner disclosure. Showcase/archived workspace: readable values, explicit read-only reason, no enabled mutations.
- Conflict: `This task changed elsewhere. Your draft is still here.` Offer Review latest comparison of Your draft/Latest saved, including checklist/order. Keep editing retains draft. Load latest explicitly confirms local discard if dirty. Only deliberate reviewed reconciliation adopts latest baseline/version; never silently overwrite remote edits or submit a rebase.
- Deleted elsewhere: retain visible draft, disable Save, say This task was deleted. Your unsaved text is still shown. Back uses dirty guard; do not automatically recreate.

| Exit attempt | Pristine | Dirty | Save in flight / unknown outcome |
| --- | --- | --- | --- |
| Close icon, Escape, overlay | Close/restore focus | Discard alert | Prevent dismiss in flight; unknown returns retained draft |
| Cancel | Leave/reset | Discard alert | Disabled while saving |
| Back to tasks, breadcrumb, sidebar, workspace/tab navigation | Navigate | Router blocker before unmount, remember destination | Wait for known outcome |
| Task switch/next item/entity ID change | Load target | Guard before replacing draft | Preserve submitted task/request |
| Browser Back/Forward or resetting route/query transition | Navigate | Router blocker | Wait while in flight |
| Account menu Sign out/session switch | Proceed | Guard before sign-out request | Wait, never duplicate request |
| Refresh, tab/window close, external/address-bar navigation | No warning | Conditional native beforeunload | Native warning while draft/outcome remains unresolved |
| Expiry, account disable, revocation | Auth takes precedence | Explain session ended, cannot promise save | Stop new writes, do not transfer draft to new identity |
| Background/assistant canonical refresh | Update values | Preserve draft and show conflict | Do not replace submitted baseline |

- AlertDialog: Discard unsaved changes? / Your changes to this task have not been saved. Keep editing initially focused; Discard changes destructive. Escape/Keep editing cancels pending transition and returns last field. Overlay never discards. Discard completes original destination once. This covers programmatic navigation as well as links. No custom beforeunload wording/guaranteed mobile interception; do not persist private drafts across account identities.
- Delete uses one AlertDialog: Delete task? / “Draft proposal” and its checklist will be deleted. This cannot be undone. Dirty form adds Your unsaved edits will also be discarded. This replaces a second discard prompt. Cancel initially focused. Delete pending Deleting; failure keeps draft/task; conflict requires review; unknown outcome checks same intent. Success Task deleted returns originating list with heading/next row focus. No Undo resurrection. Explicit scoped chat deletion has no routine confirmation.

### E. Sign-in / private demo / protected showcase

- Existing LoginPage: identifier + Password + Sign in, plus equally discoverable Try demo / Start a private temporary workspace. No sign-in required. No shared password/public signup promise.
- Login states: empty fields; Signing in; generic invalid credentials; rate-limited with server retry time; success safe return route. Never echo password.
- Try demo: one click creates/resumes same operation; Preparing your private workspace until server-ready; no second Copy & try step. Disable repeat submit; reconnect resumes provisioning. Error Demo could not be prepared + Try again; admission unavailable with server retry time/Sign in. Refresh never promises new credits.
- Ready enters editable copy. Banner Private demo, absolute expiry date/time/timezone plus relative time, remaining credits, Usage, View showcase. Copy: Keep this browser session to retain access. There is no demo account recovery. A valid demo resumes; signed-in regular account is never silently replaced.
- Canonical showcase: Read only badge/Back to my demo; permit published reading only. No mutation/chat-run/skill-run/automation/export. Ask cannot target showcase. Empty unpublished state explains demo unavailability; load/error/success handled explicitly.
- AI exhaustion/pause: clear reason and manual exploration/edit remains until expiry/storage limit. Expiry immediately replaces protected data with Your demo has expired + Try a new demo/Sign in, subject to admission. Countdown does not extend on refresh/daily reset.
- Retention: Expired demo data is scheduled for deletion from this deployment. Backup and AI-provider retention follow their own policies. Cleanup lag does not imply access extension or total cloud erasure.

### F. Usage / storage / privacy / permissions / export

- Account settings via existing account menu; suggested `/settings` route is proposed, not currently implemented. Sections Usage, AI & data, Export; no new large Home dashboard.
- Daily/lifetime credits independently show allowance, consumed, available and pending reservations/reconciliation. Integers; explicit Unlimited vs zero; no fixed message count promise. Show configured conversion and reset instant/timezone; lifetime never resets. Unknown usage is Usage unavailable, never unlimited.
- Storage: Workspace data storage; used/limit human-readable plus exact bytes. 5 GB = 5,000,000,000 bytes. Explain logical persistent data, not RAM/context/physical disk. Over limit blocks growth, permits deletions/size-reducing edits; lowering quota never deletes data.
- Loading independent section skeletons; empty No AI usage yet; error stale-marked values + Refresh usage; success server figures/time. Server admission failure overrides stale available figures.
- Settings show actual configured model/provider, allowed sources/tools/destinations/workspace scope and exclusions. No arbitrary host root or unbounded internet field. Quotas admin-editable only. Unknown provider is Provider information unavailable, not guessed model success.
- Privacy: Workspace data is stored on this operator-controlled deployment. Selected context is sent to {active provider} for AI inference. Link retention/export and disclose fact edits do not retroactively erase provider context/past messages. No local-only inference toggle.
- Export: choose owned mutable workspace; describe files/tasks/memory/conversations/skills/schedules included, secrets/other owners/internal logs excluded. Showcase not exportable by visitors.
- Export states: loading options; No workspaces available to export; load error/Try again; ready Export workspace; Preparing export; Export ready + Download export/absolute expiry; failed/oversize specific reason and safe Retry; expired link Prepare new export. Demo expiry/disable revokes download even before artifact TTL. Never claim file saved to device merely from a click or export is partial silently. No account wipe flow added.

### G. Admin accounts / demo settings / publishing

- Protected `/admin` route family, link only for admin, Ask suppressed; generic access unavailable/Home for unauthorized. No admin shortcut to other users' file data.
- Search/paginated accounts: identifier/kind/status, daily/lifetime credits and storage use/limit; no password/provider keys. States skeleton, No matching accounts/Clear search, error/Try again, loaded rows. Account detail usage read-only.
- Create/edit: identifier, initial password on create, daily/lifetime limited-or-unlimited selectors with nonnegative integer (zero valid), storage explicitly labeled units/exact bytes. Save/Cancel; field validation, submitting, success/failure without losing nonsecret input. Password is not displayed later, logged, toasted or added to URL. Reset credentials separate explicit form.
- Disable/revoke uses one AlertDialog explaining sessions/active-run impact; safe Cancel focus. Last active admin disable unavailable with reason. Audit shows actor/time/old/new limits without secrets/full content; No administrative changes yet, loading/error/list states.
- Demo settings groups allowance/lifetime; admission/concurrency; global daily/campaign budgets; spending pause. Show configured units/timezone/pending usage, explicit Save. Pause AI still permits manual exploration. No UI action implies usage reset.
- Publish showcase: operator-owned source -> sanitized preview enumerating included data and exclusions -> explicit Publish showcase. Empty No showcase published; loading/validation/error keeps prior published version; success version/time. Explain Future demo sessions use this version. Existing demos are unchanged. No tool/chat publishing. Quota/policy edits do not belong to agent tool capabilities.

### H. Visible memory

- Existing `/projects/:projectId/memory`, facts manager/editor/context controls. Show title/content, source, updated/reviewed state and Included in AI context checkbox with excluded state. Reuse project facts, not a parallel memory system.
- Loading skeleton; No saved facts yet/Add a fact; Memory could not be loaded/Try again; successful rows. Context failure leaves facts readable, inclusion disabled/Reload context. Read-only showcase/archived workspace clearly blocks mutations.
- Add/Edit title/content/source follows Save/Cancel, dirty preservation and version conflicts. Delete fact one AlertDialog. Inclusion pending saves once; failure restores prior selection with inline error.
- Copy: Facts included here can be used in new chats and scheduled runs. Changes affect future AI context. They do not erase past conversation text or context already sent to an AI provider. Run details link permitted fact/source revisions used. Avoid stale planning-workspace copy contradicting release runtime capability.

### I. Skills library / edit / run

- New Skills workspace destination reuses project nav style; account-level definitions accessible from settings. Cards show title/purpose, enabled, scope, version, declared tool needs. Seed Plan my day/Daily briefing; actions Inspect/Run/Copy/Edit/Disable. No server-file editing requirement.
- States skeleton; No personal skills yet/Create skill or seed template; no-match distinct; error/Try again; loaded cards. Disabled skill explains Enable to run. Showcase Inspect only. Credit shortage blocks run, not editable instructions when storage allows.
- Editor Title, Instructions, optional Workspace, Enabled, constrained tool needs. Example: Plan today using my open tasks, deadlines and saved working hours. Save the plan in this workspace. Copy opens unsaved Copy of Plan my day. Save/version/dirty/error consistent with D; editing creates a new version without relabeling current run snapshot.
- Explain Instructions cannot grant access beyond your allowed tools. Run asks only for missing target/input, then executes directly. Plan my day saves narrative via existing conversation/result UI with task links. Suggested edits remain informational unless user requests applying them or selected skill declares those edits. No generic second approval.
- Queued/running/Stop/succeeded/failed/interrupted/budget states mirror Ask. Result shows skill/version/provider/context/usage, links saved plan. No result says This run produced no saved result with honest status, not completed empty document.

### J. Automations / daily briefings / history

- New Automations workspace destination; Create daily briefing. Form Name, enabled skill, owned mutable workspace selection, local time, IANA timezone, Enabled. Account timezone default (operator Asia/Shanghai), explicit next-run preview. No workflow builder/email/calendar integration.
- Explain Runs on the server even when your browser is closed; report delayed/offline service honestly if health unavailable. No pretend browser-dependent success.
- List name, Enabled/Paused, next due/timezone, last result; Edit, Run now, Pause/Resume, History. States loading, No daily briefings scheduled/Create, error/Try again, loaded durable rows. Paused: No next run, retains history.
- Form invalid/missing workspace/timezone/skill blocks Save with inline errors; loading/recalculating next due shown. Failure keeps input; success reflects server revision/time. Help explains missing DST time uses next valid instant, repeated time runs once at earlier instant; downtime at most one recent catch-up.
- Run now uses server-acknowledged Queued, disables duplicate intent and links history; may run manually while schedule paused if policy permits. Budget/disabled skill/session/showcase blocks with reason. Demo form says Runs stop when this demo expires; do not promise a due occurrence after expiry.
- History: Queued/Running/Succeeded/Failed/Skipped: AI budget/Cancelled/Interrupted, timestamps/timezone, version, usage, Open result. Unknown billing Usage pending reconciliation. Never auto-retry an unknown charged outcome on UI refresh.
- History/detail loading; No runs yet; Run could not be loaded/Try again; success status/narrative. Result reuses conversation/Markdown store, dated priorities and source task links. Missing source says Source unavailable. Notification Your daily briefing is ready links result without stealing focus. Failed run with no output remains visibly failed.

## Component Inventory

Paths relative to `Personal-AI-Workspace/frontend/src/`. New slice names are proposed ownership boundaries; contracts govern exact implementation.

| Component | New or Existing | Notes |
| --- | --- | --- |
| Button/Input/Textarea/Label/Card/Icon | Existing shared/ui | Token variants; Button asChild for links |
| Dialog/Drawer/AlertDialog/DropdownMenu | Existing shared/ui | Radix portals/focus; bounded Ask layout, menu history |
| Alert/EmptyState/ErrorState/Skeleton/Spinner/MarkdownContent | Existing shared/ui | Inline status and narrative results |
| Up next/workspace cards | Existing widgets/home-overview | Header actions/independent sections |
| Assistant | Adapt widgets/home-chat/features/home-chat | Shell mounted; full widgets/chat-workspace retained |
| Task capture/form/actions | Existing features/task-capture/project-tasks/task-actions | Share editable fields/version/dirty intent; entities/project-task canonical state |
| Memory/context | Existing features/project-memory/project-context/entities/project-fact | Reuse persisted facts/selection |
| Login/session | Existing pages/login/entities/user-session | Multi-account/demo identity from server |
| Usage/demo/export | New focused features/entities, settings page | Quota/error data below pages; shell composes banner |
| Skills | New pages/project-skills, skill-management/skill-run features, entities/skill | Reuse conversations/run presentation |
| Automations | New pages/project-automations, automation-management feature, entities/automation | Reuse run/result store |
| Admin | New route pages/focused administration features | Capability gate/no other-owner data browser |
| Meter/progress/fieldsets | Native semantics/token styling | Visible numbers, no chart dependency |

FSD app -> pages -> widgets -> features -> entities -> shared. App owns routing/providers/store; slices expose public APIs, no sibling deep imports. No new shared primitive is required. If needed, document wrapper/states/stories per design-system skill; no existing Storybook instance is claimed.

## Responsive Behaviour

- Mobile 360–639px; also verify current 320px minimum: single column, 16px padding, wrapping actions, full-height Ask Drawer, safe areas/virtual keyboard. No page-wide horizontal scroll.
- Tablet 640–1024px: 24px padding, existing collapsed navigation, two-column metadata only where labels fit. Ask bounded panel from 640px, sheet below.
- Desktop above 1024px: 32px padding, preserve Home/workspace split, 440px Ask; editor max 640px, readable route form around 800px.
- At 200% zoom reflow by available CSS width; no focused control hidden by sticky footer/launcher. Admin tables scroll in named region or use labeled stacked rows. Workspace destinations may scroll within nav; focused/current item comes into view. Preserve existing Chat/Tasks/Files panel picker rather than adding many concurrent panels.

## Theming / Dark Mode

Both existing light/system dark apply. Reuse existing --color background/surface/text/border/primary/error/warning/success/info/ring/scrim and spacing/radius/shadow tokens; no feature hex overrides/new switch. Measure muted text/borders/focus contrast in both themes. Text labels accompany colors. Preserve forced-color focus and reduced motion.

## i18n / Localisation

No translation runtime established by inspection; adding one is out of scope. Keep user copy in existing copy conventions. Locale-aware dates/numbers; explicit named timezone for expiry/resets/schedules. Date-only task deadlines do not shift timezone. API IDs/enum keys remain stable.

## Accessibility Notes

- Target WCAG 2.1 AA; measure 4.5:1 normal text, 3:1 large text/meaningful UI. Lime action uses dark text. Do not claim compliance from source reading.
- Preserve skip/main/nav landmarks/logical headings/current page. Native buttons/links/forms; no clickable divs or positive tabindex. Visible labels/hints/errors and aria-invalid; required fields marked; first invalid field receives focus.
- Radix owns keyboard/focus/roles. All overlays have title/description. Keep editing restores input; delete safe focus first; missing trigger restores list heading. Route heading focus only after allowed transition.
- Names: Close assistant/Open conversation history/Stop response/Remove checklist item {title}; icon tooltip is supplementary, decorative icons aria-hidden.
- Polite status for loading/saved/deleted/briefing/run phases; actionable errors role=alert. Do not announce each streamed token, steal focus or force scroll while reading old messages; offer Jump to latest.
- Keyboard acceptance: Home -> Add -> edit -> close/Keep editing -> Save; all dirty exits in D; Ask -> history -> selection -> composer -> close/focus return; delete, skill editing/run, schedule Run now/history, admin account/settings. Also verify both themes, 200% zoom, long text/checklists, mobile keyboard, reduced motion and screen-reader output. Screenshot alone does not prove keyboard behavior.

## Design References

Actual code/token references are Design Inputs, not assumed external mockups. Runtime artifacts belong in `.codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/artifacts/`; developer/tester index their results. Designer did not capture or verify browser screenshots. Later task-scoped ui-spec files cite sections below and add contract/task deltas before implementation.

| Task | Exact sections required |
| --- | --- |
| 3.3/3.4/3.5 | E demo/provisioning/showcase/expiry, F usage, A states |
| 3.6 | G administration/publish, F quota semantics, A focus/forms |
| 5.1 | C Ask/history/automatic tools, B Home, A overlays |
| 5.2 | B Up next/Add task/View all/unassigned continuity |
| 5.3 | D immediate editing/dirty matrix/conflict/delete, B forms |
| 5.4 | A spacing/states plus Responsive/Theming/Accessibility across B–J |
| 6.1 | H memory and F selected context/privacy |
| 6.3 | I skills edit/run plus C run outcomes |
| 6.4 | F export/storage/privacy/download expiry |
| 7.3 | J schedules/Run now/pause/history/results, I skills, F quotas |
| 8.2/9.1/9.2 | E/F provider/privacy/demo and integrated B–J behavior |

## Open Questions / Decisions Needed

- No routine UX choice blocks this handoff. Desktop Ask uses modal Radix Dialog: trade-off is closing it before page interaction, chosen for consistent existing focus handling. Do not build a pseudo-nonmodal focus trap.
- New workspace links follow existing navigation, trading a small mobile nav scroll for preserving task/chat room. No extra Home dashboard.
- Dirty Cancel warns; delete while dirty uses one combined confirmation. Explicit scoped chat tools do not prompt again. No Save-and-leave variant required; Keep editing then Save is sufficient.
- Credit conversion/budgets/storage defaults, configured lifetime, showcase contents, provider naming and retention remain server/operator configuration, not invented promises. Exact API errors/new route names remain developer contract decisions; existing routes persist.
- Browser/runtime/contrast measurements remain evidence limitations until independent developer/tester artifacts. Any resulting design adjustment must be evidence-backed and scope-preserving.
- Documentation modified by designer-ui-ux: `.codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/ui-spec.md` only. No application/tracker/contracts/artifacts edited.
