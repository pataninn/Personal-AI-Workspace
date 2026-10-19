# Task 4.1 QA repair verification

Date: 2026-10-19. This record covers the API-documentation and active-chat disclosure repairs. Browser fixtures and provider labels below are synthetic/server-provided test data; they do not prove live provider admission or deployed runtime readiness.

## Retired decision API documentation

`backend/openapi.json` now documents only `409 POLICY_ACTION_RETIRED` for these retired writes. Every listed operation has no 2xx response. The 409 uses the existing `ErrorEnvelope`; descriptions state that the request causes no decision, acceptance, execution, provider send, command, or state-change effect:

- `POST /api/v1/home/conversations/{conversationId}/turns/{turnId}/consent-decisions`
- `PATCH /api/v1/home/conversations/{conversationId}/proposals/{proposalId}/items/{itemId}`
- `DELETE /api/v1/home/conversations/{conversationId}/proposals/{proposalId}/items/{itemId}`
- `POST /api/v1/home/conversations/{conversationId}/proposals/{proposalId}/acceptance`
- `POST /api/v1/home/conversations/{conversationId}/proposals/{proposalId}/execution`
- `POST /api/v1/ai-runs/{runId}/egress-decision`
- `POST /api/v1/ai-runs/{runId}/proposed-change-set/decision`
- `POST /api/v1/ai-runs/{runId}/commands/{commandId}/decision`

Existing auth, origin, CSRF and validation responses remain documented. Read/history/status operations and their successful responses remain; Home proposal cancellation and AI-run/command cancellation are separate routes and retain their success responses. The three OpenAPI suites (`ai-run-openapi.spec.ts`, `home-conversation-openapi.spec.ts`, `home-proposal-openapi.spec.ts`) assert 409, the error schema, and no 2xx for each retired operation; proposal assertions also check session security, Origin/CSRF parameters, and 400/401/403. Result: 3 suites, 5 tests passed.

## Active Home and workspace disclosure

The shared `AssistantPolicySummary` displays the disclosure in both active chat surfaces. It is nonblocking and has no accept/approve control. Its visible operator-storage line is:

> Workspace data is stored on the operator-managed deployment.

For a configured, ready provider, the visible transmission text is:

> When you submit an assistant request, selected context is sent to <provider> for processing.

When the runtime reports unavailable, the copy is conditional and precise:

> The configured assistant runtime is unavailable, so no request is sent to the provider. If it becomes available and policy permits execution, selected context will be sent to <provider> for processing.

This does not claim that the application server stores nothing or makes no other requests. With no configured provider, the summary says selected context is not sent to an AI provider and shows no terms link. Unknown provider labels also receive no inferred link.

Verified server-owned provider labels link to their official terms destinations:

- `Nebius Token Factory`: [Nebius Token Factory terms](https://docs.nebius.com/legal/token-factory)
- `NVIDIA hosted NIM`: [NVIDIA API Catalog trial terms](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf). The existing note says the trial terms prohibit confidential or sensitive data and other NVIDIA subscriptions may differ.

Focused component/Home/workspace tests cover the visible copy, normal and compact summaries, exact configured-provider links, no approval controls, no misleading terms when provider is absent, and safe server-provided provider label/model data. The component's single concise usage comment shows full and compact use.

## Validation results

- Focused OpenAPI Jest: 3 suites / 5 tests passed. Backend TypeScript check passed.
- Frontend TypeScript checks passed for both configured projects. Full Vitest: 58 files / 298 tests passed, zero skips. Preview build passed with existing Vite dependency-directive and large-chunk warnings.
- The post-repair Home/workspace Playwright run passed 10 of 11 tests. `reports cancellation only after the saved run confirms it` failed at `frontend/e2e/run-recovery.preview.spec.ts:112` because the `ai-run-cancel-status` full-viewport assertion measured `0.9888888597488403` instead of `1.0` (about 0.2 px for the 18 px status). One focused rerun reproduced the same ratio. The assertion was not weakened; this remains a known validation failure for independent QA to assess.
- A separate focused synthetic browser harness passed 4/4 disclosure/recovery scenarios. It showed the Home ready disclosure at 320 px, the conditional unavailable copy, and the compact workspace disclosure/link at 390 px with details collapsed and no approval controls. Final-source screenshots are `home-ready-disclosure-320.png`, `home-runtime-unavailable.png`, and `workspace-ready-compact-390.png`.
- Final-source geometry records are `workspace-cancel-status-geometry.json` and `workspace-recovery-geometry.json`. On both 1280x720 and 390x844, cancellation status was fully intersecting and hit-testable before and after End (ratio 1.0); on mobile its top moved from y=728.75 to y=673.75. The focused run's later `scrollIntoViewIfNeeded` measurement also remained 1.0. The separately recorded 0.98888886 Playwright assertion is preserved above; the geometry run does not replace or erase it. For the recovery action, End alone left it offscreen; a normal composer scroll brought it fully into view, enabled, focused and center-hit-testable on both viewports. See `workspace-cancel-status-390.png` and `workspace-recovery-control-390.png`. A disclosure-hidden geometry entry is diagnostic only and is not the final UI proof.

## Source freeze and cleanup

The task source manifest now has 152 unique task paths. The five added paths are the two Home OpenAPI specs, the new shared ProviderTerms component, its old feature-path deletion, and the legacy consent-dialog import update. The public entity export was already present in the original 147-path manifest. The three approved protected task lines and six original protected-file baselines remain unchanged; only the cached three-line patch is eligible for later staging. No runtime/controller/Python source changed in this repair. The owned preview process was stopped and postflight confirmed no task-owned preview listener remained. The actual app index remains empty. No staging, commit or push occurred.