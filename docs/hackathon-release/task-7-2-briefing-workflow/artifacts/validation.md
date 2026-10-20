# Task 7.2 validation receipt

Validation date: 2026-10-20. All application checks were local and deterministic; no paid or live provider call was made.

## TypeScript and unit tests

- Backend typecheck: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --pretty false` — passed with exit code 0.
- Focused Jest: 8 suites, 57 tests passed. Suites: `hermes-home-planning-runtime.spec.ts`, `get-home-turn.spec.ts`, `home-planning-tool-request-handler.spec.ts`, `get-home-turn-provider-usage.spec.ts`, `provider-call-credit-admission.spec.ts`, `list-automation-occurrences.spec.ts`, `automation-router.spec.ts`, and `automations-openapi.spec.ts`.
- Hermes bridge: `python -m unittest discover -s tests -p "test_*.py"` — 61 tests run, 58 passed, 3 skipped. The skips are existing Linux-only enforcement tests, not Task 7.2 coverage: `test_actual_linux_child_has_network_fork_memory_and_cpu_limits`, `test_actual_linux_output_is_bounded_before_decoding`, and `test_actual_linux_idle_and_wall_deadlines_reap_child`.

## Guarded PostgreSQL cases

Each accepted test ran alone with its existing isolated-database harness. The preguard confirmed `home_history_test` / `home_test`, role database-creation permission, and zero target databases/sessions. Normal test teardown removed only the test-owned database. A separate fresh-process postguard after each run confirmed both targets absent and zero target sessions. The private connection string stayed in process memory and was never printed or written to this artifact.

| Isolated target | Exact test filter | Result |
| --- | --- | --- |
| `home_history_task_3_1_credit_test` | `lists Home turn provider usage only for matching owner and turn reservations` | 1 passed; 7 skipped |
| `home_history_task_7_1_scheduler_test` | `records bounded task source revisions only under the current occurrence lease` | 1 passed; 5 skipped |
| `home_history_task_7_1_scheduler_test` | `projects task sources only when owner, workspace and exact version still match` | 1 passed; 5 skipped |

The credit case verifies owner/turn scope, actual settled usage, and an interrupted in-flight reservation becoming `unknown` while its reserved units remain held. The scheduler recording case exercises dispatch-to-running, exact bounded revisions, idempotent de-duplication, a real expired-lease reclaim with a new generation/token, and rejection of the stale fence. The projection case verifies foreign owner/workspace isolation and exact-revision invalidation.

## Provider bridge evidence

- `deploy/hermes-bridge/tests/test_provider_credit.py::PlanningRunnerProviderPathTests.test_runner_installs_the_receipt_hook_and_sync_hermes_path_uses_local_transport` executed the existing runner hook against a deterministic local HTTPX transport. It observed `receipt-reserve → local-provider-send → receipt-settle`; it made no network call.
- The same suite verifies that a request of 512 output tokens is rejected before egress when the admitted cap is 64, a `max_completion_tokens: 64` request is accepted, missing explicit output bounds and missing callback capability fail closed, missing usage is retained as unknown, and async sends are rejected before egress.
- `hermes-home-planning-runtime.spec.ts` verifies an older bridge response without the output-cap receipt capability remains unsupported and cannot reach `planning-create`.
- Source review used the pinned Hermes 0.20.6 helper at commit `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`, `agent/chat_completion_helpers.py`: the configured Chat Completions path uses the OpenAI client and requests streamed usage; auxiliary summary requests use the same client. This is pinned-source evidence only. See the tester's [pre-review](../pre-review.md) for its source link. It is not live-provider or deployment evidence.

## Failed attempts retained

All actual failed Jest attempts below completed normal teardown and had a separate fresh-process postguard confirming both isolated targets absent and no target sessions. No failure was hidden by rerunning.

- One initial normal-sandbox fixture read was denied before opening a PostgreSQL connection; the same approved test scope was later run after reading the private fixture into process memory through the authorized local access path. No credential value was exposed.
- An initial preguard parsed PostgreSQL's `name[]` result as the literal string `{}` and stopped before Jest. No test or database write occurred; a separate fresh-process postguard confirmed the base identity and zero targets/sessions. The guard was changed to use numeric `count(*)` queries.
- Initial credit-ledger attempt exposed a pre-existing fixture bound mismatch: it settled 11 prompt tokens against a 4-token reservation, producing the expected `over_bound` pause. The fixture now reserves 11 input tokens / 14 units for that usage and 5 input tokens / 8 units for the other-owner usage.
- The next credit attempt exposed TypeORM's PostgreSQL `UPDATE ... RETURNING` wrapper shape: the new method counted the `[rows, rowCount]` tuple as two rows. The method now unwraps that result before returning its affected-row count.
- The diagnostic credit attempt then exposed a fixture expectation typo: the persisted source ID is the Home turn ID, not the earlier reservation helper's source argument. The assertion now matches the persisted Home turn ID; the final filtered case passed.
- The first scheduler attempt called source recording while its occurrence was still `dispatching`; production links the Home turn and advances it to `running` first. The two filtered fixtures now exercise that same state transition. The recording case also verifies actual lease reclaim/generation change. Both final scheduler filters passed.

No browser-facing changes or MCP evidence apply to Task 7.2. Task 7.3 owns UI coverage; live Nemotron deployment evidence remains assigned to Task 8.2.
