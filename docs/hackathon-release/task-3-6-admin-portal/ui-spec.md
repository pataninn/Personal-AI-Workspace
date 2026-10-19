# UI Spec: Account, Quota, and Demo Administration (Task 3.6)

## Design Inputs

- Requirements: Task 3.6; release architecture sections 4.3 and 7.3; baseline UI spec sections A, F, and G; Task 3.4 demo banner/showcase flows.
- Existing surfaces: `frontend/src/widgets/app-shell/AppShell.tsx` (account menu/navigation), `frontend/src/widgets/demo-session-route/DemoContentGate.tsx` (private-demo banner), `frontend/src/pages/admin-showcase/AdminShowcasePage.tsx` and `frontend/src/features/showcase-publishing/ui/ShowcasePublisher.tsx` (admin publishing).
- Reuse shared Button, Card, Alert, Input, Label, Skeleton, EmptyState, ErrorState, Dialog, AlertDialog, and DropdownMenu wrappers from `frontend/src/shared/ui`. Keep existing typography, lime/neutral tokens, spacing, and page layout.
- API contract: Task 3.6 adds authenticated account administration, owner usage, demo settings, and safe audit endpoints described in contract.md. UI uses those responses and keeps loading/unavailable states instead of sample totals.

## User Goal

Admins can safely manage accounts and demo limits, while each user or demo can see their own authoritative usage and AI availability.

## User Flow

1. An admin opens Admin portal from the account menu; regular users are redirected to the workspace and the server independently denies admin API access.
2. The admin searches accounts, creates an account, adjusts limits, resets credentials, revokes sessions, or disables an account. The last active admin cannot be disabled.
3. The admin reviews or updates demo budgets, expiry/admission limits, and the existing emergency AI pause, clearly labeled as applying to all accounts; the existing Showcase publishing link opens `/admin/showcase`.
4. A user or demo follows Usage from the account menu or private-demo banner. The page and banner use the same owner-scoped usage/availability source. Unknown, paused, or exhausted AI stays disabled while permitted manual edits remain available.

## Screens / Views

### Admin portal — `/admin`

- Keep a compact header with **Admin portal**, **Back to workspace**, and **Showcase publishing**. Sections on one page: Accounts, Demo settings, and Recent admin changes. Do not add cross-account project/file browsing.
- Accounts: search by sign-in identifier or display name. Show identifier, account kind/status, daily and lifetime credits (used, reserved, remaining/limit), and storage used/limit. Row actions: **Edit limits**, **Reset credentials**, **Revoke sessions**, and **Disable account** (or **Enable account** when disabled).
- Create account uses a Dialog with display name, sign-in identifier, and initial password/confirmation. Reset credentials uses a separate form. Clear password fields after success; never display an existing password, provider key, or secret in a toast, URL, list, or audit record.
- Edit limits distinguishes **Unlimited** from numeric zero. Credit zero means no AI spending. Show exact storage bytes alongside human-readable units. Permit a lower limit with a clear warning: existing data/usage remains; further growth or AI use is blocked as applicable.
- Revoke/disable uses one AlertDialog that explains session and in-flight work impact. Disable is unavailable for the last active admin, with the reason shown beside the control; the server remains authoritative.
- Demo settings edit per-demo daily/lifetime allowance, expiry, admission/concurrency limits, global demo daily/campaign budgets, and **Emergency pause for all AI inference (all accounts)**. Display consumed/reserved budget and reset timezone from the server. A campaign ID can be initialized once; after it is set the field is read-only, while its cap remains editable against the same ledger. Saving never implies usage was reset.
- Recent admin changes show actor, time, action, and old/new limits only. Never include credentials, provider keys, full user content, or secret request data.
- Collection states: skeleton while loading; **No accounts yet** or **No accounts match this search** with Clear search; **Accounts could not be loaded** with Try again; success shows server values. Audit uses matching loading/empty/error/success states. Unconfigured demo settings are labeled as such with blank required fields, never invented defaults. Forms preserve non-secret inputs on error and show submitting/saved/error feedback.

### Usage — `/usage`

- One focused page with Daily credits, Lifetime credits, and Workspace data storage cards. Show allowance, consumed, pending reservations, remaining, daily reset time/timezone, and storage used/limit in bytes plus readable units. Explain that storage is logical persistent data, not physical disk use.
- Loading uses skeletons; zero use says **No AI usage yet**; read failure says **Usage unavailable** with Try again; success shows the server snapshot and its as-of time. Mark stale values if retained for display, and do not use them to enable AI.
- The private-demo banner links to this page and renders the same current state: known remaining credits, exhausted, globally paused, or **AI availability could not be checked**. Unknown/paused/exhausted disables AI submission with a nearby reason. Keep manual task and memory edits usable while account/storage rules permit. Never show administrator totals on this page.

## Component Inventory

| Component | New or Existing | Notes |
|---|---|---|
| Admin portal and Usage pages | New route compositions | Reuse current page/card layout and routes |
| Account list and audit list | New feature UI | Compact account cards and a bounded recent audit list |
| Account/limit forms | New feature UI | Existing Dialog, AlertDialog, Input, Label, Button |
| Demo settings form | New feature UI | Existing controls; native labeled checkbox for pause if no shared Switch wrapper exists |
| Usage cards and demo banner state | Extend existing UI | One authoritative owner-scoped read model |
| Showcase publishing | Existing | Link to `/admin/showcase`; do not rebuild |

## Responsive Behaviour

Desktop uses the existing readable content width and account cards. At mobile/tablet widths, stack cards and form fields and wrap header links. Avoid page-wide horizontal scrolling; dialogs keep actions reachable above the mobile keyboard.

## Theming / Dark Mode

Use existing light/dark surface, border, text, status, and focus tokens. Pair status color with text; add no feature-specific colors.

## i18n / Localisation

No translation runtime is established. Keep copy in existing conventions; format dates and reset times with locale-aware values and an explicit timezone.

## Accessibility Notes

Use semantic headings, navigation, tables, and forms with visible labels. Preserve visible focus and keyboard operation. Use Radix Dialog for editable forms and AlertDialog for revoke/disable; retain focus return and safe Cancel focus. Announce save/error status, associate field errors with inputs, and do not rely on color alone. Disabled last-admin actions need adjacent explanatory text.

## Design References

Task 1.1 baseline sections A/F/G; Task 3.4 UI spec; release architecture sections 4.3/7.3; existing AppShell, DemoContentGate, AdminShowcasePage, ShowcasePublisher, and shared UI wrappers listed above. No external mockups.

## Decisions

- API shapes, validation, role enforcement, zero/unlimited semantics, last-admin protection, and limit-below-use behavior are defined in contract.md.
- The pause control writes the existing global emergency pause and states its all-account effect.
- Campaign identity can be set during initial configuration and is read-only after that; changing a cap retains the active ledger.
- Password create/reset accepts only a new password, clears it after success, and never reads or displays an existing secret.