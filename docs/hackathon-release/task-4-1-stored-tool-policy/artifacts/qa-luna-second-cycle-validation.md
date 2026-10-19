# Independent QA: Task 4.1 second official cycle

Date: 2026-10-19. Verdict evidence is based on the frozen 152-path intended export at `.qa-worktrees/automatic-tools-sol-1792387594045`; the source manifest/export match and protected-line/index checks were confirmed by the release owner. I changed no application or test source. This cycle updated only `qa-report.md` and this safe QA artifact.

## F1: retired mutation API contract

The eight retired write operations in `backend/openapi.json` now document `409 POLICY_ACTION_RETIRED` with the existing `ErrorEnvelope`, no 2xx responses, and no-effect descriptions. They cover Home consent; proposal item edit/remove, acceptance, and execution; AI-run egress; proposed change-set decision; and sandbox-command decision. Auth, Origin/CSRF, validation, read/history/status, and separate cancellation responses remain documented. The changed OpenAPI specs assert the retired response and absence of success. Independent focused Jest result: 3 suites / 5 tests passed. Backend TypeScript passed.

## F2: active provider/data disclosure

The shared `AssistantPolicySummary` now renders from both Home and workspace chat. Source review confirmed the deployment-storage statement, conditional provider transmission copy, exact terms links for server-named Nebius Token Factory and NVIDIA hosted NIM, and no inferred link for unknown/unconfigured providers. Runtime-unavailable copy says no provider request is sent until runtime availability and policy permit it. The compact workspace disclosure remains visible while context/action detail is collapsed, with no approval control. The previous feature-level `ProviderTerms` file is removed; the component is exported through `entities/assistant-policy` and reused by the legacy dialog. A concise actual usage comment is present.

I reviewed the final Home ready disclosure (320px), Home runtime-unavailable state, workspace compact disclosure (390px), and workspace recovery-control (390px) PNGs under `artifacts/qa-repair-final/`. They show the copy and terms link in the active summary, the no-request-until-ready state, and the focused recovery action. The synthetic screenshots do not evidence a live provider request or deployed runtime.

Independent changed-scope checks recorded in this cycle: frontend TypeScript projects passed; full Vitest passed 58 files / 298 tests with zero skips. The pnpm dependency verifier attempt aborted before mutation because it required a TTY; the checks were completed with direct installed Node CLIs. Previously completed independent checks remain applicable because no backend runtime, migration, Python bridge, or provider code changed: backend unit 151 suites / 902 tests; focused guarded PostgreSQL 3 suites / 6 tests with all isolated targets absent afterward; and Linux bridge 48 / 48 with zero skips. The release handoff also records the full guarded database and bridge suites. No DB or Linux rerun was performed in this cycle.

## Required E2E remains red

I independently ran the exact retained Playwright case once against the final built export through the hidden loopback preview, using the installed Node/Playwright CLI and synthetic fixture:

`e2e/run-recovery.preview.spec.ts -g "reports cancellation only after the saved run confirms it"`

Result: 1 test, 1 failed at line 112. `ai-run-cancel-status` measured viewport ratio `0.9888888597488403`, below the explicit required `1.0` threshold in `toBeInViewport({ ratio: 1 })`. The developer's full relevant run was 10 / 11 with this same failure, and its focused rerun also reproduced it. This QA run is a further independent reproduction. The red check is preserved; no assertion or source was changed and it is not called a pass.

To distinguish a persistent user obstruction from the strict fractional boundary, I used the same synthetic cancellation/recovery fixture with ordinary browser input, not `scrollIntoViewIfNeeded`:

| Target | Viewport | Before End | After keyboard End | After ordinary wheel scroll | Keyboard focus / center hit |
|---|---:|---:|---:|---:|---|
| `Stopping assistant run...` status | 1280 x 720 | 1.000 | 1.000 | 1.000 | visible and center-hit; status is a `role=status` paragraph, not a focus control |
| `Stopping assistant run...` status | 390 x 844 | 1.000 | 1.000 | 1.000 | visible and center-hit; status is a `role=status` paragraph, not a focus control |
| `Try again` recovery button | 1280 x 720 | 0.130 | 0.993 | 1.000 | center-hit; Tab reached and focused it in 1 keypress |
| `Try again` recovery button | 390 x 844 | 0.000 | 0.685 | 1.000 | center-hit; Tab reached and focused it in 19 keypresses |

The cancellation status rendered at 15px / 22.5px line-height, with visible text and no overlay hit-test obstruction. After standard scrolling, the recovery button was fully visible and keyboard-focusable at both viewport sizes. These manual results support a Low-severity test-precision assessment and show no persistent UI obstruction; they do not satisfy or replace the required automated E2E result.

## Preview and cleanup

No rebuild, install, database, or provider access was used for the browser check. The QA-owned local preview process was verified and stopped after evidence capture; no task-owned preview listener remained. Unknown listeners were not reused or stopped.

Playwright MCP and Chrome DevTools MCP were unavailable. Local Playwright CLI / installed Chrome and source review are the disclosed substitutes; no MCP output is claimed. The fixtures intercept external requests and used only synthetic server/profile data. No live provider, production deployment, public HTTPS, or external-network admission is claimed.