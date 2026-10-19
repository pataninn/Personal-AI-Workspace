# UI Spec: Protected Showcase and Private Demo Entry

## Design Inputs

- Scope: Task 3.4 in `.codex/docs/hackathon-release/tasks.md`; release architecture sections 4.3, 5.3, 6, and 7.1; baseline UI spec sections A, E, and F. The Task 3.3 contract is the session boundary: a valid demo cookie resumes the same session and fixed expiry; a regular cookie conflicts without being replaced; an anonymous idempotency replay may return only status and never recovers a cookie. Admission/session `ready` does not mean a showcase copy is ready.
- The architect’s Task 3.4 decisions are reflected here: select an explicitly chosen project owned by the active admin; publish only the exact sanitized preview whose manifest is unchanged; keep the canonical showcase as a separate read-only view, not an owned Project; keep demo-copy status (`pending | ready | failed`) separate from admission status and hide partial copies.
- Task 3.4 architecture input: `.codex/docs/hackathon-release/task-3-4-showcase-and-demo-entry/architecture-preflight.md`. It keeps the snapshot independent from the admin source project, includes only explicitly selected tasks/facts/regular files, and defers persisted skill content to Task 6.2.
- Existing UI sources: `frontend/src/features/auth/ui/SignInForm.tsx`, `frontend/src/app/routes.tsx`, `frontend/src/widgets/app-shell/AppShell.tsx`, `frontend/src/widgets/project-workspace/ProjectWorkspaceLayout.tsx`, and `frontend/src/shared/ui/index.ts`. Login currently has sign-in only; project routes render editable chat/task/file tools and must not be reused for the public showcase.
- Reuse the current Geist/Bricolage typography, lime/neutral tokens, Button, Card, Alert, Skeleton, and existing Radix AlertDialog wrappers. Keep FSD boundaries; add no shared primitive or broad admin portal.
- No operator-provided showcase content exists in the task inputs. Start in an unpublished empty state. Do not invent a published example. If a development fixture is used, label it “Development fixture — sample content only; not operator-provided or published.”

## User Goal

Start or resume a private, editable demo without changing another account’s session, or inspect the sanitized canonical showcase without access to mutation tools.

## User Flow

1. The login view keeps regular sign-in and presents **Try demo** as an equally clear, one-click option. It reads only the safe publication-availability state. If no version is published, disable entry with **Demo is unavailable right now**; the server also rejects admission before creating a demo owner or admission counter. If availability cannot be checked, keep entry disabled until a retry succeeds and show **Demo availability could not be checked. Try again.**
2. On **Try demo**, show **Preparing your private demo…** and prevent duplicate submissions. A valid demo session resumes with its existing expiry; only a pinned copy can be resumed, and an older Task 3.3 admission with no copy pin cannot be attached to the current showcase retroactively. A regular-session conflict preserves the regular cookie and offers **Back to your workspace**. It never silently signs out or replaces the account.
3. After admission, query copy status with the current cookie; this status is separate from Task 3.3 admission status. A cookie-authenticated GET returns `pending | ready | failed` plus `retryAllowed`, and `202` while pending. Show progress but no project rows/files, Home task data, chat, or tools until ready. For failed, offer **Retry setup** only when the server marks the same-owner, same-version retry as safe; it is a CSRF-protected POST that reuses the same owner/admission, pinned version, target project IDs, and manifest; it never creates a second owner/session/allowance or extends expiry. Status exposes only generic state and `retryAllowed`, never paths or source IDs. Unresolved quota/filesystem state is unavailable and offers no retry until reconciliation. A non-retryable failure (including a session with no pinned copy) opens no workspace; do not offer a copy retry. Starting a new demo from this state requires explicit sign-out through the existing account control, then a new admission when available, subject to normal limits.
4. In the private copy, the banner shows **Private demo**, exact expiry date/time/timezone, remaining AI credits when known, **Usage** when available, and **View showcase**. Explain that this browser session is the only access; there is no account recovery. The private copy remains scoped to its demo cookie. Refresh/resume does not extend expiry. Accepted sessions in separate browser contexts receive independent copies; edits in one never appear in another.
5. **View showcase** opens the separate read-only published view. **Back to my demo** returns to the private copy. Showcase content never becomes the mutation target for chat, tasks, files, skills, jobs, or export.
6. AI credits exhausted, provider/global spending paused, or AI availability unknown changes the banner and disables AI submission with a nearby reason; manual non-AI exploration remains available while the session and storage allow it. When the selected snapshot includes files, over-quota or unavailable managed storage keeps copy content hidden. If a fileless snapshot is ready with `fileAccess=false`, show the existing **Planning only** state: files and file-based runs are unavailable, while tasks, memory, and planning remain available where enabled. Use **This private demo needs more storage than is currently available. No workspace was opened.** for a known quota failure and **Private demo storage is unavailable right now. No workspace was opened.** for unavailable storage. Offer retry only when the server confirms the pinned copy can be retried; unresolved quota/filesystem outcomes remain unavailable until reconciliation. Never display host paths or partial data.
7. On expiry or a lost/cleared cookie, remove access to the private copy and offer **Sign in** or **Try demo** when available. State plainly that the old demo cannot be recovered. A status-only idempotency replay—even if it says `ready`—does not establish a session or open a workspace.
8. An admin opens the minimal publishing view, selects an active project they own, explicitly selects eligible tasks, facts, and regular files, then reviews the exact sanitized projection and exclusions. **Publish showcase** is enabled only for that unchanged preview. Confirm once. Success displays the immutable version and publish time; future demos use it, while existing copies remain unchanged.

## Screens / Views

### Login and demo entry

- Keep the existing sign-in form and add a comparably prominent **Try demo** action beside/below it, not behind a menu. Keep the signed-in return route behavior.
- Availability loading: keep the action disabled and show a short status. Unpublished: disabled with **Demo is unavailable right now.** A `503 DEMO_SHOWCASE_UNAVAILABLE` response uses the same copy. If the availability request fails, show **Demo availability could not be checked.** + **Try again**; keep demo entry disabled until verified.
- Admission states: **Preparing your private demo…** with a polite status; rate-limited/unavailable/failed admission uses a generic actionable alert and preserves the form. A pending status check reuses the same idempotency key; only an explicit new attempt after terminal failure creates a fresh key. Do not show error codes, limits, IP data, IDs, or provider details.
- `DEMO_REGULAR_SESSION_ACTIVE`: preserve the session, display **You’re signed in to a regular account. Your session is unchanged.**, and offer **Back to your workspace**. No automatic logout.
- If a cookie-less replay returns `pending`, show **Your demo request is still being checked.** and **Check status**, which replays the same idempotency key and cannot create a second owner. If it returns status-only `ready`, explain **This browser cannot restore that demo session.** Do not route into a demo or claim the copy is ready. Any new attempt after a terminal failure must be an explicit user action with a fresh key, subject to normal admission limits.

### Private demo status and banner

- Before copy readiness, use a compact centered Card with **Preparing your private demo…**, indeterminate progress, and a brief “Your private workspace will open when setup is complete.” Do not invent a percentage or show a partial project.
- Retryable failure: **Your private demo isn’t ready yet.** + **Retry setup**. Non-retryable failure, including an older admission with no pinned copy: **This demo session cannot be opened. No workspace was opened.** Do not offer copy retry. To try a new demo, the visitor must explicitly use the existing **Sign out** control first, then start a new admission when available. The retry button is absent when the server does not authorize retry, including unresolved quota/filesystem outcomes awaiting reconciliation. Storage/managed-mount details remain generic.
- In the ready copy, place a compact persistent banner above the workspace: **Private demo**, **Expires {date/time/timezone}**, **AI credits: {remaining}**, **View usage**, **View showcase**. Keep values server-derived. If the balance cannot be read, show **AI availability unavailable** rather than a guessed balance. When the server marks the ready copy `fileAccess=false`, reuse the existing **Planning only** presentation and omit file navigation/tools.
- Exhausted: **No AI credits remain. You can keep exploring and editing until this demo expires.** Global pause: **AI is paused right now. You can keep exploring and editing until this demo expires.** Unknown AI state: **AI availability could not be checked.** In all cases keep permitted non-AI areas usable; do not imply AI requests can run.
- Expired/lost-session state contains no private project data: **This demo session has ended. It can’t be recovered.** Actions: **Sign in** and **Try demo** when available. Do not promise cleanup timing or account recovery.

### Canonical showcase (read-only)

- Use a standalone route/surface with a persistent **Published showcase · Read only** badge and **Back to my demo** link/button while an active demo exists; otherwise provide **Try demo** and **Sign in**. Show the active immutable version’s sanitized tasks, explicitly selected facts, and regular files explicitly included in its public projection. Task 3.4 does not publish or copy skills; show no skills section.
- Do not render a project action menu, Ask/chat composer, task editor/save/delete, file upload/delete/history, skill run/edit, job/schedule controls, or export. Read-only task/fact/file detail is plain content, not an owned Project or tool context. Server-side denial remains authoritative for direct requests.
- Loading: labeled skeletons. Empty/unpublished: **No showcase is available right now.** A missing published version returns `404 SHOWCASE_NOT_PUBLISHED`; show the same safe empty state, with no project IDs or source details. Error: **Showcase could not be loaded.** + **Try again** and **Back to my demo** for an active demo; otherwise offer **Try demo** and **Sign in**. Success identifies this as public read-only content without implying it is the visitor’s private copy.

### Admin preview and publish

- Add only a focused admin-only publishing view. Link it only for admins. Its source selector contains active projects owned by the current admin; never add account search, cross-account browsing, quota controls, or general policy settings here.
- Loading projects/preview uses a skeleton; no eligible source shows **No active projects are available to preview.** After project selection, require explicit selection of eligible tasks, facts, and regular files (none preselected); do not show skill selection because Task 3.4 has no persisted skill source. Preview shows the exact sanitized public content and a plain-language inclusion/exclusion summary. Keep source project editing outside this view. Never display raw paths, manifest digest, owner IDs, secrets, private histories, or audit data.
- Before preview: **No showcase published. Choose one of your active projects to preview.** If a published version exists, show its version/time separately from the new preview.
- **Publish showcase** becomes available only after a successful preview. If source changes, show **This project changed after the preview. Refresh the preview before publishing.** Retain the current published version.
- Publish uses one titled AlertDialog: **Publish this showcase?** / **The previewed content will be visible to demo visitors. Existing demos will not change.** Buttons **Cancel** and **Publish showcase**. While publishing, disable repeat actions and announce status. Error retains the preview/current publication and offers retry; success announces the new version/time and **Future demos will use this version.**

## Component Inventory

| Component | New or Existing | Notes |
|---|---|---|
| Sign-in form | Existing | Extend with equally visible Try demo and server publication availability |
| Demo entry/status card | New feature UI | Pending, retryable failure, terminal failure; no partial content |
| Demo session banner | New feature UI | Fixed expiry, credits/AI availability, usage and showcase links |
| Read-only showcase page | New page/feature composition | Separate resource; no owned-project or mutation UI |
| Showcase preview/publish view | New focused admin page/feature | Own-project selector and immutable preview/publish only |
| Button, Card, Alert, Skeleton, AlertDialog | Existing | Reuse shared wrappers/tokens; no new shared primitive |

## Responsive Behaviour

- Mobile 320–639px: one column, 16px page/card gutters, full-width actions that wrap, no sticky footer over the virtual keyboard. Keep banner details readable and let links wrap; showcase content stacks.
- Tablet 640–1024px: 24px gutters; preview and exclusions stack when content is narrow.
- Desktop above 1024px: 32px gutters; readable max-width for preview text, with source selector and publication state above content. At 200% zoom, reflow by CSS width without page-wide horizontal scrolling.
- Long project, file, task, and fact names wrap. Admin version metadata may wrap; it must not push Publish offscreen.

## Theming / Dark Mode

Use existing light/system-dark surface, text, border, info, warning, success, and focus tokens. Pair status color with a text label/icon; add no feature-specific hex colors or theme switch.

## i18n / Localisation

No translation runtime is established. Keep user-facing copy in existing conventions and format expiry with locale-aware date/time plus an explicit timezone.

## Accessibility Notes

- Use semantic headings, main/nav landmarks, visible labels, native links/buttons, and a labeled project selector. Disabled entry/publish controls need adjacent explanatory text.
- Use a polite live region for preparation/publish status; use an alert for actionable errors. Do not announce every status poll or steal focus when progress changes.
- The publish confirmation uses the existing Radix AlertDialog wrapper with a title/description, safe Cancel focus, Escape handling, and focus return. Do not hand-roll a dialog.
- Keyboard order: sign-in fields and Try demo; status/Retry; demo banner links; read-only showcase navigation; admin project selection, preview, publish, confirm/cancel. Preserve visible focus, 44px targets, 4.5:1 text contrast, reduced motion, and forced-color focus.
- On expiry/session loss, move focus to the state heading after the route transition; never place focus in hidden/partial project content.

## Design References

Task 1.1 baseline UI spec sections A/E/F; Task 3.3 `contract.md`; release architecture sections 4.3/5.3/6/7.1; actual source files listed in Design Inputs. This is source-based design handoff, not browser/runtime evidence. Browser isolation, network redaction, and mobile screenshots remain developer/tester evidence requirements.
