# UI Spec: Task 2.1 — Regular account sign-in

## Design Inputs
- Task 2.1 adds regular/admin identities while preserving the existing owner’s password and data. Admins use the regular sign-in path.
- Developer contract: login accepts an identifier and password; identifier matching trims surrounding whitespace and applies ASCII lowercase; the migrated/bootstrap admin identifier is owner.
- Baseline: Task 1.1 UI Spec sections E (sign-in states and safe return) and A (form states, spacing, and feedback). Architecture sections 4.3 and 5.1 cover the login entry and principal model.
- Existing implementation: Personal-AI-Workspace/frontend/src/pages/login/LoginPage.tsx and features/auth/ui/SignInForm.tsx. Reuse shared/ui Card, Label, Input, Button, Alert, and Spinner.

## User Goal
Sign in to the intended regular or admin account, while the migrated owner can continue with the current password.

## User Flow
1. User opens /login, optionally after a session-expired or signed-out notice.
2. User enters Account identifier and Password. The migrated owner signs in as owner with the existing password; later accounts use their own identifiers.
3. User submits with Enter or Sign in. Blank identifier/password is caught inline; identifier matching is case-insensitive and ignores surrounding whitespace.
4. While authenticating, both fields and the submit button are disabled; the button reads Signing in… and shows a spinner.
5. On success, establish the returned session and navigate to the validated returnTo route or /dashboard.
6. On invalid credentials, show one generic identifier-or-password error for unknown, incorrect, disabled, or non-password/demo accounts. Keep the identifier editable; never put the password in copy, URLs, or status.
7. On rate limit, explain when another attempt is allowed if the server supplies a retry time; otherwise use the existing wait-and-retry message. On network/server failure, retain the identifier and show an actionable retry message.

## Screens / Views
### Regular account sign-in
- Layout: preserve the existing sign-in artwork and form composition. The form is a short, single-column stack with identifier first, password second, then the primary Sign in action. Do not add public registration, password recovery, demo entry, or a separate admin login in Task 2.1; later release tasks own those flows.
- Components: existing Card, Label, Input, Button primary variant, Alert, Spinner, and decorative SignInArtwork. No new component is needed.
- Initial/empty: visible heading Sign in; visible Account identifier and Password labels; fields are blank and ready for entry. Keep the identifier input blank so a multi-account user chooses their own identity; the migrated account itself is named owner.
- Validation: inline required-field errors are linked to the relevant input. The first invalid field receives focus.
- Loading: button reads Signing in… with spinner and aria-busy; prevent duplicate submission and disable both fields.
- Error: generic text: “That account identifier or password was not accepted. Check both and try again.” Rate-limit and service-unavailable messages remain distinct and actionable.
- Success: announce “Signed in. Loading your workspace.” politely, then use the safe return route or dashboard.

## Component Inventory
| Component | New or Existing | Notes |
|---|---|---|
| Sign-in page/form | Existing pages/login and features/auth | Add identifier to current form and auth request |
| Label/Input | Existing shared/ui | Visible Account identifier and Password labels; text and password types |
| Button/Spinner | Existing shared/ui | Primary submit; disabled and busy states |
| Alert | Existing shared/ui | Generic authentication, rate-limit, and unavailable feedback |
| SignInArtwork/Card | Existing feature/shared UI | Preserve current responsive composition |

## Responsive Behaviour
- Desktop above 1024px: retain the existing two-column artwork/form layout; keep the form at its current capped width.
- Tablet 640–1024px: keep the form readable and centered in its existing panel.
- Mobile 360–640px: artwork stacks above the form; keep the card within the viewport with 16px side padding and no horizontal scrolling. Ensure the added field does not push the submit action beneath a fixed overlay or virtual keyboard.

## Theming / Dark Mode
Use the existing light and system dark token variants for surfaces, text, fields, borders, focus, and error feedback. Add no task-specific color overrides.

## i18n / Localisation
No translation runtime is established. Keep copy in existing auth-message conventions; avoid embedding account identifiers in translated strings.

## Accessibility Notes
- Use main and a single h1; native form controls and a submit button.
- Visible labels identify both fields. Use autocomplete=username for identifier and autocomplete=current-password for password; do not use email input semantics because identifiers are not necessarily email addresses.
- Mark required and invalid fields, associate inline errors with aria-describedby, and announce server errors with role=alert. Keep loading/success status polite.
- Keyboard order is identifier, password, Sign in; Enter submits. Preserve the visible focus ring, focus the first invalid field, and maintain at least 44px control targets.
- Keep error meaning clear in text and verify normal text contrast against both themes.

## Design References
- .codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/ui-spec.md sections A and E.
- .codex/docs/hackathon-release/architecture.md sections 4.3 and 5.1.
- Personal-AI-Workspace/frontend/src/features/auth/ui/SignInForm.tsx and existing shared/ui wrappers.

## Open Questions / Decisions Needed
- No blocking design decision. The account identifier for the migrated/bootstrap admin is owner; the sign-in input stays blank to support explicit selection among multiple accounts.
