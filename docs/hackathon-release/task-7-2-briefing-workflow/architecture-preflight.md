# Architecture preflight: task-7-2-briefing-workflow

## Change History

- 2026-10-20: Source-only decision against the Task 6.2/6.3 contracts and current Task 7.1/Home/credit paths. No application code, database, runtime, or test evidence was produced.

## Decisions

Task 7.2 is a backend extension of the existing `automations`, `skills`, `home-assistant`, and `credits` paths. Task 7.3 owns the schedule/history UI, so this task does not change frontend FSD slices. Backend workflow stays in automations use cases; controllers remain transport-only, skill/task/provider rules stay in their existing owners, and TypeORM remains in infrastructure. DDD and Hexagonal Architecture are excluded.

Each schedule and Run now occurrence continues to target one owned, active, mutable workspace and uses the same occurrence worker, `InvokeSkillUseCase`, `SubmitHomeTurnUseCase`, Home policy, context, and credit admission path. The scheduled Daily briefing revision must declare only `home_task_read`; writes stay denied even if a user-edited skill asks for them. Do not create or update tasks as a side effect.

The assistant narrative remains one dated Home message. `automation_occurrences.home_turn_id` and its conversation identify the saved result; the existing Home conversation route is the result link. Use the assistant message `createdAt` as its date. Do not copy the narrative into occurrence history or create another document store.

## Smallest durable projection

The current 7.1 schema already persists occurrence status, safe `failure_code`, lifecycle timestamps, schedule/skill revisions, invocation ID, and Home turn ID. Reuse these fields. Project `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `interrupted_unknown` directly. Represent budget exhaustion as `status: skipped` plus a stable `failure_code: BUDGET_EXHAUSTED`; the UI can say “Skipped: budget exhausted.” Keep cancellation intent distinct as `cancel_requested`. No occurrence status migration is needed.

`skill_invocations.context_revisions` is part of the invocation fingerprint and must stay immutable after claim. Do not append task refs there: exact retries recompute the fingerprint from that field. Add a bounded `task_source_revisions` JSONB field to the existing `automation_occurrences` row. The Home task-read handler may supply `{ id, revision }` only for tasks it actually returned after owner/workspace checks; `ProjectTask.version` is the revision. Append those refs idempotently under the current occurrence lease fence and store no task text. Resolve a label/link only when the same owner/workspace task still has that exact version; otherwise show the source as unavailable. Do not infer source use from generated narrative. This needs one additive migration after 0038; coordinate its next registry slot with delivered dependencies and Task 6.4 rather than assuming a migration number.

Provider, model, and usage must be read from the per-call credit ledger, never from current configuration or account totals. The existing reservation and usage tables support `source_kind = home_turn` and already store the admitted provider profile/model and settled token counts. Bind each real Home provider call to `source_kind: home_turn` and `source_id: home_turn.id`, then add a narrowly owner-scoped read through the existing credits repository for the Home turn projection. A settled row gives historical model and usage; a missing or unknown settlement gives unknown usage. Do not introduce a briefing ledger.

There is a concrete producer gap: `HermesHomePlanningRuntime.start` sends provider settings through the existing `planning-create` bridge call, but the local `poll` adapter currently accepts only assistant text and tool requests, with no provider-usage receipt. The current NIM admission call site writes `source_kind: ai_run`, and `HermesHomePlanningRuntime.supportsPolicyExecution` currently returns false because the bridge cannot prove admission for every send. The actual existing bridge provider-send path must use the existing provider-call admission/settlement contract and return its usage receipt for this projection to be truthful. Until then, expose historical provider/usage as unavailable or unknown and keep inference blocked; do not copy the present provider settings or account balances into run history. This is a source finding, not runtime proof.

## Boundaries and data flow

```text
scheduled or Run now occurrence
  -> existing worker and occurrence fence
  -> InvokeSkillUseCase -> SubmitHomeTurnUseCase
  -> existing Home runtime and read-only task tool
       -> append exact returned task ID/version to occurrence.task_source_revisions
       -> actual provider calls use credit ledger source home_turn
  -> assistant message in existing Home conversation
  -> occurrence keeps the Home turn link and terminal status/reason
```

Keep occurrence history and result reads owner-scoped. Use the existing `/api/v1/automations/schedules` and occurrence-history contracts for status, source/version summary, historical ledger projection, and Home result link; extend their DTO/OpenAPI definitions rather than adding a second run API. Combine the existing immutable skill context refs with occurrence task refs in the summary; the credits module owns the owner-scoped usage read, and automations must not query its tables directly.

## Focused proof required after Task 7.1 is delivered

- A single-workspace fixture includes owned tasks with deadlines, selected project facts, prior Home notes, and a foreign-workspace sentinel. A briefing records only the owner/workspace sources actually read and their exact current versions; a changed/deleted source resolves as unavailable. Assert task-mutation use cases were never called.
- An exhausted-budget fixture records `skipped` with the budget reason and proves the provider sender was not called.
- Retrying scheduled and Run now requests with the same idempotency key returns the existing occurrence/turn and leaves one saved assistant message. Restart recovery reuses the persisted Home turn and never starts a second inference.
- The owner-scoped projection uses `home_turn` reservation/usage rows for provider/model/tokens; missing or unknown rows remain unknown, and changing current provider settings or account totals does not change old run history.
- Keep these fixture and focused PostgreSQL checks separate from actual Nemotron provider/deployment evidence, which remains Task 8.2. No live inference or deployed usage proof is claimed here.

## Dependency and risk

Task 7.1 is not ready for QA: its scheduler PostgreSQL suite passed 4/4, including fresh-child polling with zero reinvocation, but the filtered demo-expiry cleanup still ends in `failure_code=storage`; the current local PostgreSQL fixture is unavailable. Task 7.2 implementation waits for Task 7.1 delivery. The Home bridge’s missing per-call admission/usage receipt is an additional release risk that must be resolved on the existing runtime path before historical usage or successful scheduled inference can be claimed.
