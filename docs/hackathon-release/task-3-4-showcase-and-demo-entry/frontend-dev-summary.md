# Frontend Dev Summary: Task 3.4

## Change History

- Completed the Task 3.4 frontend implementation and one-click private-copy entry flow.
- Added strict owner-private target validation and bounded polling; a ready copy now opens its project after the original Try demo action.
- Preserved the status-only admission key reset: a new deliberate attempt uses a fresh key, while ambiguous network failures reuse the existing key.

## What Was Implemented

- Added demo admission, availability, copy readiness/retry, and public showcase API models and clients.
- Added fail-closed Try demo entry. A full demo session marks only the immediate dashboard navigation as an initial admission entry.
- Added a route-level copy gate before `AppShell` mounts. It polls pending copy status up to 20 times at 500 ms intervals, keeps owner content hidden until ready, and uses the private `projectId` only after strict UUID/state validation.
- On the initial admission route only, a ready copy replaces the temporary dashboard route with `/projects/{encoded projectId}`. The redirect consumes the navigation marker; later manual visits to `/dashboard` are not redirected.
- Retry remains server-authorized through `retryAllowed`. Public showcase DTOs remain unchanged and never receive the private target ID.
- Added a public read-only snapshot page and an admin preview/publish page with explicit selection, exact preview bytes/exclusions, stale-preview handling, confirmation, and idempotent publication.
- Added focused client-state tests and a two-context Playwright fixture. Its first demo status is pending and then ready, proving the one-click path alongside public cookie omission, read-only access, independent demo cookies, manual edits, and desktop/mobile rendering.

## Files Changed

See `frontend-source-manifest.md` for the exact owned source, test, route, and preview-config paths. The synchronized application tracker snapshot is listed there separately. The combined backend/frontend `dev-summary.md` remains owned by the backend lead.

## Contract Notes

- Copy status and retry return `{ state, projectId, retryAllowed, workspaceMode, capabilities }`. `projectId` must be null for pending/failed and an RFC 4122 UUID only when ready; the frontend rejects missing, malformed, or state-inconsistent IDs.
- Public snapshot: `GET /api/v1/showcases/current`; file attachments: `GET /api/v1/showcases/current/files/{fileId}`.
- Demo admission remains `POST /api/v1/demo/session` with existing request, cookie, expiry, and replay behavior. Availability is `GET /api/v1/demo/availability`; copy status and retry are `GET /api/v1/demo/showcase-copy` and `POST /api/v1/demo/showcase-copy/retries`.
- Admin preview/publication use `POST /api/v1/admin/showcases/previews` and `POST /api/v1/admin/showcases/versions`. Preview files have no generated public IDs; publication sends the digest and source revision and uses `Idempotency-Key`.
- Public reads omit cookies, the public page contains no mutation controls, and backend authorization/copy-gating remain authoritative.

## Architecture Alignment Notes

- Kept API/types in entities, user actions in features, public/admin surfaces in pages, and the pre-shell copy gate in a new widget. Route composition wraps `AppShell` without editing it or Home surfaces.
- The initial-entry marker is consumed by a replace navigation, so ordinary later workspace navigation is unaffected.

## Evidence Collected

- Focused Vitest: 5 files, 17 tests passed, including strict target-ID parsing, pending-to-ready auto-entry, no redirect for a later dashboard visit, and status-only versus ambiguous-key behavior.
- `pnpm.cmd run typecheck`: passed.
- `pnpm.cmd run build`: passed. Vite reported existing Radix `use client` directive notices and the existing >500 KB bundle warning.
- Playwright preview: 1/1 passed against the newly built static app on loopback port 5193 with intercepted fixture APIs. The first demo returned pending then ready and reached its private project after one Try demo click without a refresh/retry click. Two contexts stayed isolated and public requests omitted cookies.
- Preview PID 68648 was stopped and port 5193 was confirmed without a listener afterward.
- Fixture-labeled screenshots: `artifacts/task-3-4-public-showcase-desktop.png`, `artifacts/task-3-4-private-demo-desktop.png`, and `artifacts/task-3-4-private-demo-mobile.png`.
- Earlier browser harness attempts timed out on a hidden task-row menu selector and had an incorrect post-edit fixture assertion. Both test-only issues were corrected before the earlier baseline pass; the current one-click run passes.

## MCP Notes

- No Context7 or Chrome DevTools MCP evidence was used. Playwright tested the static built app with route-intercepted fixtures only; this does not demonstrate live backend/database integration, TLS, host keyboard behavior, or provider availability.

## Code Review Findings and Resolutions

- A status-only admission replay no longer leaves the same key attached to the retry button; an explicit new attempt gets a new key, while uncertain network failures retain the key. Both behaviors are tested.
- Pending copy is now polled with a bounded request count. Only a ready DTO with a valid private project UUID can trigger the one-time initial-entry navigation. Failed, pending, missing, or malformed IDs keep all private content closed.
- Verified that a valid ready demo visited later at `/dashboard` remains there unless the navigation carries the original admission marker. No unresolved core frontend issue remains.

## Test Coverage Summary

- Vitest: 17/17 focused tests passed.
- Playwright: 1/1 two-context public/demo fixture passed with the pending-to-ready one-click flow.
- Typecheck and production build passed after the final source changes.

## Known Limitations / Tech Debt

- Browser evidence uses fixture data and a static local build. Backend integration, database, TLS, OS keyboard navigation, and live provider behavior were not exercised.
- The banner reports AI availability as unavailable because the copy status contract does not expose provider or credit readiness. Existing Home policy remains responsible for AI enablement; manual editing remains available.
- Visual treatment is intentionally minimal; remaining cosmetic refinement is low priority.

## Ready for QA: YES

Frontend handoff is complete. The backend lead owns the combined task summary and final integrated verification.
