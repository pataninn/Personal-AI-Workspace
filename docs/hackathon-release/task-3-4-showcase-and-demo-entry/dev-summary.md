# Dev Summary: Protected showcase and private demo copies

## What Was Implemented

- Added unpublished-by-default sanitized showcase preview/publication, immutable admission pinning, quota-aware private copy provisioning/retry, and owner-wide readiness gating.
- Copy status returns projectId only after the copy is fully ready; public DTOs never include the private target ID.
- One Try demo action now follows bounded pending polling and opens the ready private project. Later manual dashboard visits stay put.

## Files Changed

Exact lists: [backend-source-manifest.md](backend-source-manifest.md) and [frontend-source-manifest.md](frontend-source-manifest.md). The shared composition-root.ts includes a separately owned Task 6.1 hunk; preserve it. Contract: [contract.md](contract.md). Frontend details: [frontend-dev-summary.md](frontend-dev-summary.md).

## Evidence and Tests

- Backend typecheck passed.
- Focused backend Jest passed 4 suites / 15 tests.
- Guarded PostgreSQL passed 4/4 with clean preguard and separate-process postguard: [backend receipt](artifacts/task-3-4-backend-verification.md).
- New Express-boundary suite passed 1 suite / 3 tests. It proves an unready demo receives 409 DEMO_COPY_NOT_READY before an attached private project handler runs; a ready demo and regular session reach the handler; copy status and public snapshot reads remain available while unready.
- Frontend Vitest passed 5 files / 17 tests; final typecheck/build passed; Playwright passed 1/1 against rebuilt static fixture APIs, including pending-to-ready one-click navigation. Screenshots: [public desktop](artifacts/task-3-4-public-showcase-desktop.png), [private desktop](artifacts/task-3-4-private-demo-desktop.png), [private mobile](artifacts/task-3-4-private-demo-mobile.png).

## QA and Self-Review

Independent QA cycle 1 reported one medium gap: no HTTP-level proof of the global pending-copy gate. The focused createApp regression test closes it, and independent QA cycle 2 passed. History remains in [qa-report.md](qa-report.md). No product-source fix was required.

No Context7 or Chrome DevTools evidence was used. Browser evidence is fixture-backed and does not prove live deployment, TLS, physical mount, or provider availability. Visual treatment is intentionally minimal.

## Ready for QA: YES

Independent QA cycle 2 passed. The release owner authorized the Task 3.4 commit separately.