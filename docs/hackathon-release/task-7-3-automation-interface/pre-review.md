# Task 7.3 Automation UI Pre-review

## Scope

Source-only review of the in-progress frontend against the canonical Task 7.3 brief, `ui-spec.md`, `contract.md`, delivered Task 7.1 and 7.2 contracts, and the current backend automation DTO serialization/types. Reviewed the automation form, management hook, schedule card, run history, page composition, and relevant session/workspace loading behavior.

This is a pre-review, not the official QA report or a PASS/FAIL verdict. The developer still owns implementation, tests, and the authorized preview/build work.

## Findings

No confirmed functional, security, or data-loss blocker was found in the reviewed paths.

The current source matches the core mutation contracts: create retries retain the exact request and idempotency key after uncertain outcomes; Run now sends an empty body, retains its key on uncertain transport outcomes, and blocks a new run while history shows unresolved work; updates use the server revision and omit workspace changes. The form and page guard late skill-option responses when the selected workspace or page data changes. Sign-out or session expiry clears auth and leaves the protected route; no in-place account-switch flow was found. Schedule/history DTO usage matches the delivered fields and cursor envelope, and result/source links use the server-returned conversation and available task-source references.

### Low performance follow-up

At the reviewed snapshot, the backoff poll refreshes every schedule's first history page whenever any schedule has an unresolved occurrence. This can poll settled schedules while another schedule is running. I reported this to the developer; they confirmed they are narrowing the timed poll to unresolved schedule IDs. That follow-up has not yet been re-reviewed and does not block functional acceptance.

## Not covered

No tests, build, browser/runtime, database, or provider checks were run. Those remain with the developer and formal QA handoff. No claim is made about runtime or live provider behavior.
