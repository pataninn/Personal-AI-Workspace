# Task 7.2 source manifest

This manifest lists Task 7.2-owned implementation and test files in the shared `Personal-AI-Workspace` checkout. It excludes frontend, Task 6.3, Task 6.4, and Task 7.1-owned changes except for explicitly noted shared-file hunks.

## Backend

- `backend/src/infrastructure/database/migrations/1710000039000-add-automation-task-sources.ts` — additive 0039 occurrence source metadata and 256-row shape constraint.
- `backend/src/infrastructure/database/repositories/typeorm-automation-repository.ts` — source persistence under the lease fence, bounded normalization, and owner/workspace/exact-revision projection.
- `backend/src/infrastructure/database/repositories/typeorm-credit-ledger-repository.ts` — Home-turn usage projection and atomic in-flight-to-unknown retention; normalizes the PostgreSQL `UPDATE ... RETURNING` result before counting rows.
- `backend/src/infrastructure/hermes/hermes-home-planning-runtime.ts` and `backend/src/infrastructure/hermes/hermes-home-planning-runtime.spec.ts` — required receipt-capability probe, shared output cap, and fail-closed old-bridge behavior.
- `backend/src/modules/automations/controllers/automation-router.ts` and `backend/src/modules/automations/controllers/automation-router.spec.ts` — additive occurrence response serialization.
- `backend/src/modules/automations/domain/automation-types.ts`, `backend/src/modules/automations/repositories/automation-repository.ts`, and `backend/src/modules/automations/use-cases/automation-use-cases.ts` — occurrence DTO and owner-scoped usage projection contract.
- `backend/src/modules/automations/use-cases/list-automation-occurrences.spec.ts` — historical usage projection coverage.
- `backend/src/modules/credits/repositories/credit-ledger-repository.ts` and new `backend/src/modules/credits/repositories/provider-call-usage-history.ts` — Credits-owned ledger/read interface.
- New `backend/src/modules/credits/use-cases/get-home-turn-provider-usage.ts` and `backend/src/modules/credits/use-cases/get-home-turn-provider-usage.spec.ts` — settled, pending, unknown, and not-started projection states.
- New `backend/src/modules/credits/use-cases/handle-home-provider-credit-receipt.ts` — existing admission/settlement integration and interruption retention port.
- `backend/src/modules/credits/use-cases/provider-call-credit-admission.spec.ts` — updates the existing ledger fixture with the new Home usage-history and unknown-retention methods.
- New `backend/src/modules/home-assistant/repositories/home-automation-source-recorder.ts` and `backend/src/modules/home-assistant/repositories/home-provider-credit-receipt-handler.ts` — application ports.
- `backend/src/modules/home-assistant/repositories/home-planning-runtime.ts`, `backend/src/modules/home-assistant/repositories/home-planning-tool-request-handler.ts`, and `backend/src/modules/home-assistant/use-cases/home-planning-tool-request-handler.ts` — trusted bridge events and actual task-source capture.
- `backend/src/modules/home-assistant/use-cases/home-planning-tool-request-handler.spec.ts` — task-read source capture coverage.
- `backend/src/modules/home-assistant/use-cases/get-home-turn.ts` and `backend/src/modules/home-assistant/use-cases/get-home-turn.spec.ts` — bridge receipt handling, interrupted reservation retention, and historical state behavior.
- `backend/src/openapi/automations-openapi.spec.ts` — occurrence response schema coverage.
- `backend/test/integration/automation-scheduler.integration.spec.ts` and `backend/test/integration/credit-ledger.integration.spec.ts` — the three guarded PostgreSQL cases listed in `validation.md`, including fixture corrections documented there.

## Hermes bridge

- `deploy/hermes-bridge/acp.py` — bounded receipt callback events/results.
- `deploy/hermes-bridge/planning_lifecycle.py` and `deploy/hermes-bridge/server.py` — required capability/create payloads and propagation of the selected output limit.
- `deploy/hermes-bridge/runtime/planning_acp_runner.py` — pins the existing runner's output limit to the server-selected value and installs the receipt boundary before importing the runner.
- New `deploy/hermes-bridge/runtime/provider_credit.py` — sync per-send admission and usage settlement; async, unsupported, missing-usage, and over-cap requests fail closed.
- `deploy/hermes-bridge/tests/test_planning_runtime.py` and new `deploy/hermes-bridge/tests/test_provider_credit.py` — capability, cap, actual-runner local transport, streaming, unknown, and fail-closed coverage.

## Shared localized hunks

- `backend/src/composition-root.ts`: Task 7.2 Home runtime, source recorder, provider receipt, capped provider-credit configuration, and usage-history dependency wiring. The Workspace Export provider/startup-cleanup wiring is owned by Task 6.4; preserve its hunk.
- `backend/src/infrastructure/database/data-source.ts`: Task 7.2 registers migration `0039`; Task 6.4 registers `0040` immediately after it.
- `backend/openapi.json`: Task 7.2 adds occurrence source/usage response fields; Task 6.4 owns Workspace Export paths/schemas.

No Task 7.2 frontend files changed. No Git index or commit was changed by this implementation.
