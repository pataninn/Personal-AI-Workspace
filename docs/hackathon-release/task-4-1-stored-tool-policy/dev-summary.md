# Dev Summary: Stored tool policy and workspace-scoped automatic execution

## Change History

- 2026-10-19: Completed stored policy, automatic Home/workspace integration, legacy retirement and bounded-command path across earlier workers and GPT-6.1 Sol takeover. Combined source, browser, full-package checks and self-review are complete; independent QA is next.

## What Was Implemented

- QA repair: retired writes are described only as 409 POLICY_ACTION_RETIRED with no 2xx response; the active Home/workspace summary visibly discloses operator-managed storage and conditional provider transmission with allowlisted terms links.

- Durable fixed owner/Home/workspace policy profiles; migration backfill, transactional provisioning triggers, null-only configured provider fill and sticky revocation/revisions.
- Authenticated read-only GET /api/v1/assistant/execution-policy with separate policy/readiness/context summary. Current policy and independent account, ownership, selected-context, runtime, provider, storage and quota gates are rechecked at execution boundaries.
- Automatic policy-bound Home turns and workspace runs, verified change-set claims and bounded commands, with distinct policy_authorized audit provenance. Legacy consent/proposal/egress/change/command decisions uniformly return 409 POLICY_ACTION_RETIRED; reads/history and separate cancellation remain.
- Real private Hermes bounded-command protocol, pre-effect interception, selected snapshot binding, Linux local executor enforcement, asynchronous claim/result handling, held output and post-persistence policy acknowledgment. Unsupported deployed runtime/provider readiness remains closed.
- Read-only Home/workspace policy/history UI; compact workspace summary and accessible expandable details preserve composer access. Synthetic preview fixtures cover automatic submits, unavailable/legacy states, read-only receipts, cancellation and recovery.

## Files Changed

All task source paths are listed below and in artifacts/task-source-manifest.txt. The protected hook and timeline test paths contain only their approved one-line and two-line task patches in the intended commit; all original changes are excluded.

### Backend

- `backend/openapi.json`
- `backend/src/app.ts`
- `backend/src/composition-root.ts`
- `backend/src/infrastructure/ai-provider/direct-provider-agent-runtime.ts`
- `backend/src/infrastructure/ai-provider/nvidia-hosted-nim-provider.spec.ts`
- `backend/src/infrastructure/ai-provider/nvidia-hosted-nim-provider.ts`
- `backend/src/infrastructure/ai-runs/in-memory-ai-run-repository.ts`
- `backend/src/infrastructure/ai-runs/in-memory-change-set-repository.ts`
- `backend/src/infrastructure/ai-runs/in-memory-sandbox-command-repository.ts`
- `backend/src/infrastructure/assistant-policy/runtime-capability-adapter.spec.ts`
- `backend/src/infrastructure/assistant-policy/runtime-capability-adapter.ts`
- `backend/src/infrastructure/database/data-source.ts`
- `backend/src/infrastructure/database/migrations/1710000032000-create-assistant-scope-policies.spec.ts`
- `backend/src/infrastructure/database/migrations/1710000032000-create-assistant-scope-policies.ts`
- `backend/src/infrastructure/database/repositories/home-conversation-persistence-mappers.spec.ts`
- `backend/src/infrastructure/database/repositories/home-conversation-persistence-mappers.ts`
- `backend/src/infrastructure/database/repositories/typeorm-ai-run-repository.spec.ts`
- `backend/src/infrastructure/database/repositories/typeorm-ai-run-repository.ts`
- `backend/src/infrastructure/database/repositories/typeorm-assistant-scope-policy-repository.spec.ts`
- `backend/src/infrastructure/database/repositories/typeorm-assistant-scope-policy-repository.ts`
- `backend/src/infrastructure/database/repositories/typeorm-change-set-repository.ts`
- `backend/src/infrastructure/database/repositories/typeorm-home-conversation-repository.spec.ts`
- `backend/src/infrastructure/database/repositories/typeorm-home-conversation-repository.ts`
- `backend/src/infrastructure/database/repositories/typeorm-sandbox-command-repository.ts`
- `backend/src/infrastructure/hermes/hermes-agent-runtime.ts`
- `backend/src/infrastructure/hermes/hermes-home-planning-runtime.ts`
- `backend/src/infrastructure/hermes/hermes-policy-command.spec.ts`
- `backend/src/infrastructure/hermes/hermes-policy-command.ts`
- `backend/src/infrastructure/sandbox/fake-agent-runtime.ts`
- `backend/src/modules/ai-runs/controllers/ai-run-router.ts`
- `backend/src/modules/ai-runs/controllers/sandbox-command-router.ts`
- `backend/src/modules/ai-runs/domain/ai-run-types.ts`
- `backend/src/modules/ai-runs/domain/change-types.ts`
- `backend/src/modules/ai-runs/domain/command-policy.spec.ts`
- `backend/src/modules/ai-runs/domain/command-policy.ts`
- `backend/src/modules/ai-runs/domain/command-types.ts`
- `backend/src/modules/ai-runs/repositories/agent-runtime.ts`
- `backend/src/modules/ai-runs/repositories/change-set-repository.ts`
- `backend/src/modules/ai-runs/repositories/model-provider.ts`
- `backend/src/modules/ai-runs/repositories/sandbox-command-repository.ts`
- `backend/src/modules/ai-runs/use-cases/ai-run-use-cases.ts`
- `backend/src/modules/ai-runs/use-cases/change-set-use-cases.spec.ts`
- `backend/src/modules/ai-runs/use-cases/change-set-use-cases.ts`
- `backend/src/modules/ai-runs/use-cases/sandbox-command-use-cases.spec.ts`
- `backend/src/modules/ai-runs/use-cases/sandbox-command-use-cases.ts`
- `backend/src/modules/ai-runs/use-cases/send-chat-message-use-case.spec.ts`
- `backend/src/modules/ai-runs/use-cases/send-chat-message-use-case.ts`
- `backend/src/modules/ai-runs/use-cases/start-ai-run-use-case.spec.ts`
- `backend/src/modules/ai-runs/use-cases/start-ai-run-use-case.ts`
- `backend/src/modules/assistant-policy/controllers/assistant-execution-policy-router.spec.ts`
- `backend/src/modules/assistant-policy/controllers/assistant-execution-policy-router.ts`
- `backend/src/modules/assistant-policy/domain/assistant-execution-errors.ts`
- `backend/src/modules/assistant-policy/domain/assistant-scope-policy.ts`
- `backend/src/modules/assistant-policy/domain/policy-action-retired-error.ts`
- `backend/src/modules/assistant-policy/repositories/assistant-runtime-capability.ts`
- `backend/src/modules/assistant-policy/repositories/assistant-scope-policy-repository.ts`
- `backend/src/modules/assistant-policy/use-cases/assert-assistant-execution-policy.spec.ts`
- `backend/src/modules/assistant-policy/use-cases/assert-assistant-execution-policy.ts`
- `backend/src/modules/assistant-policy/use-cases/get-assistant-execution-policy.spec.ts`
- `backend/src/modules/assistant-policy/use-cases/get-assistant-execution-policy.ts`
- `backend/src/modules/home-assistant/controllers/home-conversation-router.spec.ts`
- `backend/src/modules/home-assistant/controllers/home-conversation-router.ts`
- `backend/src/modules/home-assistant/controllers/home-proposal-router.spec.ts`
- `backend/src/modules/home-assistant/controllers/home-proposal-router.ts`
- `backend/src/modules/home-assistant/domain/home-conversation-types.ts`
- `backend/src/modules/home-assistant/repositories/home-conversation-repository.ts`
- `backend/src/modules/home-assistant/repositories/home-planning-runtime.ts`
- `backend/src/modules/home-assistant/repositories/home-planning-tool-request-handler.ts`
- `backend/src/modules/home-assistant/use-cases/cancel-home-turn.spec.ts`
- `backend/src/modules/home-assistant/use-cases/decide-home-consent.spec.ts`
- `backend/src/modules/home-assistant/use-cases/get-home-turn.spec.ts`
- `backend/src/modules/home-assistant/use-cases/get-home-turn.ts`
- `backend/src/modules/home-assistant/use-cases/home-planning-tool-request-handler.spec.ts`
- `backend/src/modules/home-assistant/use-cases/home-planning-tool-request-handler.ts`
- `backend/src/modules/home-assistant/use-cases/home-tool-result-consent-gate.spec.ts`
- `backend/src/modules/home-assistant/use-cases/submit-home-turn.spec.ts`
- `backend/src/modules/home-assistant/use-cases/submit-home-turn.ts`
- `backend/src/openapi/ai-run-openapi.spec.ts`
- `backend/src/openapi/assistant-scope-policy-openapi.spec.ts`
- `backend/test/integration/ai-runs.integration.spec.ts`
- `backend/test/integration/assistant-scope-policy.integration.spec.ts`
- `backend/test/integration/home-planning-command-parity.integration.spec.ts`
- `backend/test/integration/home-planning-proposal-execution.integration.spec.ts`
- `backend/test/integration/policy-command-run-cancellation.integration.spec.ts`
- `backend/test/integration/r1-release-http-postgres.integration.spec.ts`
- `backend/test/integration/sandbox-commands.integration.spec.ts`
- `backend/test/integration/task-4-1-change-set.integration.spec.ts`
- `backend/test/integration/task-4-1-policy-authorized-change-set.integration.spec.ts`

### Frontend

- `frontend/e2e/home-chat-preview-data.ts`
- `frontend/e2e/home-chat-preview-fixtures.ts`
- `frontend/e2e/home-chat.preview.spec.ts`
- `frontend/e2e/home-summaries-preview-fixtures.ts`
- `frontend/e2e/home-summaries.preview.spec.ts`
- `frontend/e2e/project-activity.preview.spec.ts`
- `frontend/e2e/project-chat-security-preview-data.ts`
- `frontend/e2e/project-chat-security-preview-fixture.ts`
- `frontend/e2e/project-file-history.preview.spec.ts`
- `frontend/e2e/provider-permissions.preview.spec.ts`
- `frontend/e2e/run-recovery.preview.spec.ts`
- `frontend/src/entities/ai-run/api/activity-api.spec.ts`
- `frontend/src/entities/ai-run/api/activity-api.ts`
- `frontend/src/entities/ai-run/api/ai-run-api.spec.ts`
- `frontend/src/entities/ai-run/api/ai-run-api.ts`
- `frontend/src/entities/ai-run/api/change-set-api.spec.ts`
- `frontend/src/entities/ai-run/api/change-set-api.ts`
- `frontend/src/entities/ai-run/api/run-event.spec.ts`
- `frontend/src/entities/ai-run/api/run-event.ts`
- `frontend/src/entities/ai-run/api/sandbox-command-api.spec.ts`
- `frontend/src/entities/ai-run/api/sandbox-command-api.ts`
- `frontend/src/entities/ai-run/model/activity-types.ts`
- `frontend/src/entities/ai-run/model/types.ts`
- `frontend/src/entities/assistant-policy/api.ts`
- `frontend/src/entities/assistant-policy/index.ts`
- `frontend/src/entities/assistant-policy/model/types.ts`
- `frontend/src/features/ai-run/index.ts`
- `frontend/src/features/ai-run/model/command-copy.ts`
- `frontend/src/features/ai-run/model/use-direct-chat.ts` (task-only one-line patch; original reliability changes excluded)
- `frontend/src/features/ai-run/model/use-sandbox-commands.ts`
- `frontend/src/features/ai-run/model/use-workspace-assistant-policy.spec.tsx`
- `frontend/src/features/ai-run/model/use-workspace-assistant-policy.ts`
- `frontend/src/features/ai-run/ui/AiRunEntry.spec.tsx`
- `frontend/src/features/ai-run/ui/AiRunTimeline.spec.tsx` (task-only two-line patch; original reliability changes excluded)
- `frontend/src/features/ai-run/ui/AiRunTimeline.tsx`
- `frontend/src/features/ai-run/ui/ChatComposer.spec.tsx`
- `frontend/src/features/ai-run/ui/ChatComposer.tsx`
- `frontend/src/features/ai-run/ui/CommandExecutionSurface.spec.tsx`
- `frontend/src/features/ai-run/ui/CommandExecutionSurface.tsx`
- `frontend/src/features/ai-run/ui/CommandProposalCard.tsx`
- `frontend/src/features/ai-run/ui/ProposedChangeReview.spec.tsx`
- `frontend/src/features/ai-run/ui/ProposedChangeReview.tsx`
- `frontend/src/features/ai-run/ui/RunStatusCard.tsx`
- `frontend/src/features/assistant-policy-status/index.ts`
- `frontend/src/features/assistant-policy-status/ui/AssistantPolicySummary.spec.tsx`
- `frontend/src/features/assistant-policy-status/ui/AssistantPolicySummary.tsx`
- `frontend/src/features/home-chat/model/use-home-chat.ts`
- `frontend/src/features/home-chat/model/use-home-planning-records.spec.tsx`
- `frontend/src/features/home-chat/model/use-home-planning-records.ts`
- `frontend/src/features/home-chat/ui/HomeChat.spec.tsx`
- `frontend/src/features/home-chat/ui/HomeChat.tsx`
- `frontend/src/features/home-chat/ui/HomePlanningRecords.spec.tsx`
- `frontend/src/features/home-chat/ui/HomePlanningRecords.tsx`
- `frontend/src/features/project-activity/ui/ProjectActivityPanel.tsx`

### Runtime

- `deploy/hermes-bridge/acp.py`
- `deploy/hermes-bridge/lifecycle.py`
- `deploy/hermes-bridge/runtime/acp_runner.py`
- `deploy/hermes-bridge/server.py`
- `deploy/hermes-bridge/tests/test_policy_command_runtime.py`

### Docs

- contract.md; dev-summary.md; artifacts/source-map.md; artifacts/task-source-manifest.txt; artifacts/sol-backend-validation.txt.
- Existing task UI/architecture, helper notes, focused evidence and curated Home/workspace artifacts remain canonical. New bridge-command-contract.md, bridge-command-dev-notes.md and artifacts/bridge-command-validation.md document the returned bridge slice.

### QA repair additions

- Backend: backend/src/openapi/home-conversation-openapi.spec.ts; backend/src/openapi/home-proposal-openapi.spec.ts.
- Frontend: frontend/src/entities/assistant-policy/ui/ProviderTerms.tsx; frontend/src/features/ai-run/ui/ProviderConsentDialog.tsx; deleted frontend/src/features/ai-run/ui/ProviderTerms.tsx. The shared entity public export was already present in the original source manifest.
- These five paths were added to the source manifest alongside the existing repaired OpenAPI document and related specs.

## Contract Notes

See contract.md and bridge-command-contract.md. Migration 0032 owns all three policy_authorized provenance enums and immutable run/turn revision binding; rollback refuses retained policy history. No synthetic human approval or legacy continuation is introduced.

## Architecture Alignment Notes

Frontend follows existing FSD entities/features; backend guards/use cases depend on inward repository contracts. Existing runtime/bridge/TypeORM wiring is reused. No service, dependency, general policy engine/editor, provider bypass or vendor/image change.

## Evidence Collected

- artifacts/task-source-manifest.txt; backend result summaries are in artifacts/qa-luna-independent-validation.md and artifacts/qa-final-functional-validation.md.
- Guarded PostgreSQL outcomes are summarized in artifacts/qa-luna-independent-validation.md; raw database transcripts are excluded from this release snapshot.
- artifacts/home-ui-focused-validation.md; frontend-policy-summary-focused-checks.md; home-preview-e2e-validation.md and curated home-preview-e2e images.
- artifacts/workspace-preview-e2e/validation.md preserves the initially automated-green but visually clipped state. artifacts/workspace-home-preview-final/validation.md records the 18-test combined rerun.
- artifacts/recovery-reachability-final/validation.md records targeted 4-test recovery rerun and desktop/mobile keyboard/focus checks. artifacts/recovery-viewport-clarification/validation.md, geometry JSON and settled viewport images establish final desktop control reachability before/after capture. Initial fractional clipping remains recorded; no exact full-page capture mechanism is claimed.
- artifacts/code-review.md and artifacts/protected-task-only.patch document self-review and safe later staging.
- artifacts/bridge-command-validation.md: Windows control flow and actual isolated existing-image Linux 48/48 tests, zero skips, exit 0, 15.765s, with separate container cleanup. This proves local Linux executor limits, not deployment/provider availability.

## MCP Notes

Context7, Chrome DevTools and Playwright MCP are unavailable; direct existing TypeScript/Jest/Vitest/Playwright CLI and official primary documentation were used. Python bridge evidence links official kernel/Python sources. Browser fixtures are explicitly synthetic.

## Code Review Findings (and resolutions)

- Fixed real Home undo scope-intersection defect.
- Fixed PostgreSQL returning tuple mapping, migration same-transaction enum comparisons and rollback history guards.
- Serialized automatic command claim/result with project and current running parent run before command; verified real cancellation race.
- Prevented same-iterator deadlock, raw legacy terminal result bypass, result sharing before current policy recheck, acknowledgment replay and false successful enclosing runs after uncertain continuation.
- Fixed snapshot/hash/probe bindings and independently asserted Python/TypeScript deterministic hash vectors.
- Browser review found oversized policy UI despite green tests; compact disclosure, legitimate synthetic Home response, and a bounded keyboard-scrollable composer corrected it. Recovery reachability and settled viewport checks pass; primary reviewed the settled desktop safe-retry and separate-run images.
- Full frontend package validation exposed three stale legacy-approval expectations. Corrected only fixture/assertion tests without weakening production guards; preserved original protected StrictMode work through exact task-only hunks.

## Test Coverage Summary

- Jest backend full unit: 151 suites / 902 tests PASS. Intended-commit export independently repeats 151/902 PASS.
- Jest guarded backend full integration: 34 suites / 119 tests PASS; separate cleanup verified. Includes fresh full migrations, policy provisioning/revocation, automatic change claims and real command cancellation locking. Earlier failures remain recorded in artifacts/sol-backend-validation.txt.
- Intended-source backend/frontend and frontend-node typechecks PASS. Full frontend Vitest: 58 files / 298 tests PASS, zero skips, exit 0, approximately 31.592s. Earlier full run: 56 files / 294 tests PASS with 2 files / 3 stale-approval assertion failures, retained distinctly. Touched frontend 13 files / 75 tests and final focused summary/composer 2 files / 15 tests also PASS. Existing node:test preview API suite 26/26 PASS.
- Existing bridge Python unittest: Windows 45 pass / 3 explicit Linux skips; actual isolated Linux image 48/48 PASS with no skips.
- Playwright synthetic Home earlier 12 unique tests and workspace earlier 6 tests PASS with initial visual defect recorded. Earlier release-slice Playwright runs passed 18/18 combined and 4/4 affected recovery scenarios before the QA repair. On the repaired source, Home/workspace Playwright passed 10/11; the cancellation-status viewport assertion failed at 0.98888886 and reproduced once. A separate focused disclosure/recovery harness passed 4/4; see artifacts/qa-repair-validation.md. Separate read-only geometry/focus/keyboard checks and settled viewport 3/3 scenarios pass. Browser worker reviewed images and stopped its exact owned server; the owned preview listener was confirmed stopped. These are overlapping synthetic scenarios, not provider/deployment proof.

## QA Repair Evidence

- artifacts/qa-repair-validation.md records the exact retired routes, visible disclosure copy, official terms URLs, test results, the 10/11 browser run and reproduced fractional failure, final-source geometry, server cleanup, and 152-path manifest.
- artifacts/qa-repair-final/ contains the five reviewed final-source screenshots and two geometry records. The focused browser states are explicitly synthetic.
- OpenAPI repair tests: three Jest suites / five tests PASS; backend TypeScript check PASS. Full frontend Vitest is 58 files / 298 tests PASS; both frontend typechecks PASS. Preview build PASS with existing Vite warnings.
- The remaining Playwright result is reported as 10/11, not green: ai-run-cancel-status measured 0.9888888597488403 against the unchanged ratio-1 assertion. Final-source geometry independently recorded 1.0 before/after End; it does not erase the test failure.

## Known Limitations / Tech Debt

No paid/live inference, deployed OpenShell command enforcement, public HTTPS, hosted provider admission or browser-closed scheduling is established. Production provider admission and global command capability intentionally remain unavailable. Actual local Linux executor proof does not waive these independent gates. No task staging, commit or push before independent tester PASS.

## Ready for QA: YES

Implementation, API/type/unit checks, guarded PostgreSQL and cleanup, local Linux bridge validation, source isolation and developer self-review are complete. Independent QA remains required before staging or commit. Intended-source export is synchronized at 152 task paths; the exact three-line protected patch remains isolated, six original protected baselines are preserved, cached patch check is green, and the actual index is empty. The post-repair browser result remains 10/11 because one viewport assertion reproducibly measured 0.98888886; it is documented for independent QA. The focused disclosure/recovery harness passed 4/4. The owned preview process was stopped and its listener was absent afterward.

## Final F3 helper and release handoff (2026-10-19)

The final E2E helper repair changes only the two target-scroll calls in frontend/e2e/run-recovery.preview.spec.ts to standard DOM scrollIntoView with block center and inline nearest. The assertion ratio, cancellation order, idempotency, focus sequence, and viewport sequence are unchanged. No product CSS, runtime, backend, or Python code changed for this follow-up.

Final preview validation: the exact saved-run cancellation case passed 1/1; the complete run-recovery.preview.spec.ts passed 2/2; the six-spec Home/workspace preview set finished 17/18. The one failure remains explicit: provider-permissions.preview.spec.ts:19 expects the disabled Send button in the initial 1280×720 viewport before interaction. It is below the viewport, while the message field partly intersects. This is accepted as low visual/test debt under the user's faster-delivery priority, and is not reported as an all-green E2E result.

Read-only synthetic ready-fixture evidence shows normal fill plus native Tab focuses Send and scrolls the composer to make it fully visible on desktop and a synthetic 390×844 viewport; Ctrl+Enter submits the draft exactly once without a consent dialog or approval/decision request. These interaction checks do not claim live provider behavior or an OS-keyboard test. No authentication, authorization, provider-admission, credit, quota, or data-loss requirement was waived. See artifacts/f3-native-center-validation.md and artifacts/provider-submit-diagnosis/.

Source freeze: the mirrored actual test file matches the export at SHA-256 59C573C95120CFC944D8EC79DBB920AEDE661B0256A82604CD96CF8FF338F12B. Export and app CSS hashes match at ADAECE73A6573B724E6BC7D68CBA7249B9C563340F29ECA656F02B4E8B0D095A. The exact source manifest remains 152 paths and includes the helper file. The three-line protected patch is unchanged and the actual Git index is empty.

Ready for QA: YES. Developer self-review is complete for this bounded test-helper repair; independent QA must assess the documented 17/18 result before any stage or commit. The owned preview process was stopped and postflight confirmed its listener was absent.
