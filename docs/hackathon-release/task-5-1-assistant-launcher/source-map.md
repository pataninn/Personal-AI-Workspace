# Task 5.1 source map

| Source | Responsibility and review notes |
| --- | --- |
| frontend/src/widgets/app-shell/AppShell.tsx | Mounts HomeAsk beside the route outlet for persistent controller lifetime; reserves space for the fixed launcher; registers a stable summary refresh callback in Outlet context. |
| frontend/src/widgets/app-shell/index.ts | Exposes the AppShellOutletContext type through the widget public API. |
| frontend/src/widgets/app-shell/HomeAsk.tsx | Explicit Home-scope launcher, authentication/admin visibility gate, controlled dialog state, principal-keyed HomeChat instance. |
| frontend/src/widgets/app-shell/home-ask.css | Scoped fixed launcher, desktop dialog, mobile full-height sheet, and bounded transcript/composer styling. |
| frontend/src/features/home-chat/model/use-home-chat.ts | Adds optional URL-independent conversation selection and per-view drafts while preserving URL-backed behavior by default for existing embedded chat. |
| frontend/src/features/home-chat/ui/HomeChat.tsx | Reuses history, policy, run, event, receipt, and composer behavior in Ask presentation; keeps hooks mounted when the dialog is closed; nonmodal history dropdown avoids nested modal focus isolation. |
| frontend/src/features/home-chat/ui/HomeChat.spec.tsx | Covers close/navigation/reopen draft preservation and principal-change reset alongside existing Home chat cases. |
| frontend/src/pages/dashboard/DashboardPage.tsx | Removes inline Home conversation and registers summary refresh for assistant receipts through shell Outlet context. |
| frontend/src/pages/dashboard/DashboardPage.spec.tsx | Verifies Home work surfaces no longer contain inline chat and summary refresh registration remains active. |
| frontend/e2e/home-chat-preview-test-utils.ts | Adds a small openHomeAsk helper for existing synthetic Home chat flows. |
| frontend/e2e/home-chat.preview.spec.ts | Includes one desktop/mobile core journey and verifies policy-ready/unavailable and existing run lifecycle paths through the new launcher. |
| frontend/e2e/home-summaries.preview.spec.ts | Routes existing receipt/summary browser journeys through the Ask launcher. |

No backend/OpenAPI/migration or shared Dialog wrapper changes were made. The shared frontend preview config remains owned by Task 3.4 and is excluded from this source map.

## API and policy boundary

Task 5.1 adds no API. The Home assistant reads the existing Home conversation/history resources and the existing Home execution policy. The scope is passed explicitly as { kind: 'home' }; no selected workspace or scope is guessed from the current route.
