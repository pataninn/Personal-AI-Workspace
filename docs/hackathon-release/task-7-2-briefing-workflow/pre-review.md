# Task 7.2 Source Pre-Review

## Change History

- 2026-10-20: Bounded source pre-review of provider send/receipt and historical usage owner binding. No official QA verdict.

## Scope and review boundary

Reviewed the actual Hermes Home runner/ACP receipt path and the `home_turn` usage projection against the Task 7.2 contract. This review does not cover task-source persistence or the broader workflow. No tests, builds, database, browser, runtime, or provider calls were run; this is not the Task 7.2 QA cycle.

## Findings

### High — provider output can exceed the amount admitted

The Home runner fixes `AIAgent.max_tokens` at 512 (`deploy/hermes-bridge/runtime/planning_acp_runner.py`), while the receipt handler reserves the configured `NIM_MAX_OUTPUT_TOKENS` (`backend/src/modules/credits/use-cases/handle-home-provider-credit-receipt.ts`). Configuration allows values below 512, and the `httpx.Client.send` boundary checks the route, model, body size, and streaming usage flag but does not cap the outgoing `max_tokens`/`max_completion_tokens` to the amount reserved. In that configuration, provider usage can exceed the reservation; the ledger records `over_bound` and pauses inference only after the call has incurred cost.

**Action:** Pass the server-selected output limit into the runtime and reject or clamp every actual request at the HTTP boundary before `original_send`; cover direct auxiliary calls and retries too. If the runner cannot prove the bound, keep provider capability unavailable.

### Medium — an interrupted receipt can remain `pending` indefinitely

If polling fails after a call was admitted, `GetHomeTurnUseCase.readRuntime` marks the turn `unknown` and clears process-local state. The receipt handler keeps its reservation map only in memory; that path does not call `retainUnknown`. The historical projector maps a persisted `in_flight` reservation to `pending`, and `GetHomeTurnUseCase.execute` returns early for an `unknown` turn with `pending` usage. It therefore neither changes the reservation to `unknown` nor polls for a late receipt. This disagrees with the contract for a missing receipt after a potentially sent/interrupted turn and can leave history and reserved allowance stuck as pending.

**Action:** On terminal uncertain turn state, retain outstanding reservations as `unknown` without releasing them, or add bounded reconciliation that can settle them and cannot return an interrupted call to `pending` forever.

## Reviewed controls

- **Reserve before send:** The bridge wraps synchronous `httpx.Client.send`; it obtains a reservation before invoking the original sender. Non-matching routes/models, malformed or oversized bodies, and async sends fail before provider egress. Streaming calls require usage inclusion; missing usage or uncertain transport outcomes block the runner and report unknown. The output-cap finding above remains open.
- **Pinned runner path:** Local `docker/hermes.Dockerfile` pins the Hermes sandbox base by digest, and the bridge checks Hermes version `0.20.6`. I compared the current runner path with the official Hermes `v0.20.6` source at commit `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`: the chat-completions helper uses the OpenAI client and requests streaming usage; direct summary calls use that client too. The runner disables fallback models and credential-pool rotation. This is source evidence only, not live-provider evidence.
- **Old bridge fail-closed:** `supportsPolicyExecution` requires the receipt capability handshake, and planning creation requires receipt version 1; a bridge without the capability cannot start a Home run.
- **Owner binding:** The authenticated owner ID is taken from the owner-scoped schedule/history call and passed to the Credits projection. The query filters both reservations and usage entries by owner and `source_kind/source_id = home_turn/{homeTurnId}`. I found no cross-owner usage disclosure in this path.

## Evidence Index

| Artifact / reference | Source | Covers | Location / identifier |
|---|---|---|---|
| Task 7.2 contract and architecture preflight | Workspace docs | Required receipt, unknown-state, and owner-binding behavior | `.codex/docs/hackathon-release/task-7-2-briefing-workflow/contract.md`; `architecture-preflight.md` |
| Home runner and HTTP boundary | Workspace source | Fixed output cap; reserve/send/settle/unknown path | `deploy/hermes-bridge/runtime/planning_acp_runner.py`; `runtime/provider_credit.py`; `planning_lifecycle.py` |
| Receipt handling and turn polling | Workspace source | Configured reservation bound; interrupted in-flight lifecycle | `backend/src/modules/credits/use-cases/handle-home-provider-credit-receipt.ts`; `modules/home-assistant/use-cases/get-home-turn.ts`; `modules/credits/use-cases/get-home-turn-provider-usage.ts` |
| Historical usage read | Workspace source | Owner and Home-turn source filters | `backend/src/infrastructure/database/repositories/typeorm-credit-ledger-repository.ts`; `modules/automations/use-cases/automation-use-cases.ts` |
| Hermes chat-completions helper at pinned release commit | Official upstream source | Direct OpenAI-client send path and streaming usage flag | [chat_completion_helpers.py at 5fc308a](https://github.com/NousResearch/hermes-agent/blob/5fc308a70719a83cccdbba4c0e39c23f5a8239d5/agent/chat_completion_helpers.py) |

## Review status

**PRE-REVIEW ONLY.** The output-cap finding is a release blocker. The interrupted-receipt projection also needs resolution against the contract. This file does not issue PASS/FAIL and must not consume the independent QA cycle.
