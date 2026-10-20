# Contract: Task 7.2 — Produce and persist useful daily briefings

## Change History

- 2026-10-20: Contract prepared from the approved architecture preflight, Tasks 6.2, 6.3, and 7.1 contracts, the Task 7.3 UI spec, and a source audit. No Task 7.2 application changes or runtime evidence are claimed.
- 2026-10-20: Reconciled after Task 7.1 delivery at `dba6d049688173b6ac1ff71f5e23eddc6401baad`. The implementation extends the delivered `automation_occurrences` row and leased Home polling path. Migration `1710000039000` / `0039` is reserved to Task 7.2; Task 6.4 owns `0040`.
- 2026-10-20: Implementation contract update: the existing Hermes runner must receive the same effective output-token cap used by Credits admission, and every sync provider request must prove its explicit `max_tokens` or `max_completion_tokens` does not exceed that cap before send. A missing or oversized cap denies egress. Interrupted Home turns with outstanding reservations must retain them as unknown so historical usage cannot remain pending forever.
- 2026-10-20: Task 7.2 implementation completed against this contract. The effective provider output cap is shared by runtime and Credits and enforced at the send boundary; interrupted-turn reservations are retained as unknown; the owner-scoped source and usage projections are validated by focused Jest, Python, and three guarded PostgreSQL cases. See `dev-summary.md` and `artifacts/validation.md`.

## Ownership

- Task 7.2 owns the bounded occurrence source projection, the provider usage read projection, daily briefing execution details, and the narrow Home/bridge integration required to make those projections truthful.
- Task 7.1 owns durable schedules, occurrence claims, worker execution, Home-turn fences, and cleanup barriers. It is delivered at `dba6d049688173b6ac1ff71f5e23eddc6401baad`; Task 7.2 extends those contracts without weakening them.
- Task 6.3 owns the separate optional `skillRun` projection on Home turns. Task 7.2 does not add task-source or billing fields to that DTO and does not change `skill_invocations.context_revisions`.
- Task 7.3 owns schedule and history UI. Task 6.4 owns workspace export and coordinates the next migration slot. Task 8.2 owns live Nemotron/provider deployment evidence.
- Use the existing Home conversation/message store, Home task-read handler, skill invocation path, runtime, credits module, and demo/workspace cleanup. Do not create a second narrative store, credit ledger, scheduler, or provider path.

## Scope

- A Daily briefing runs in its schedule's one owned, active workspace and existing durable Home conversation. It uses the saved skill revision, existing permitted Home context and read policies, and the existing `InvokeSkillUseCase` → `SubmitHomeTurnUseCase` → `GetHomeTurnUseCase` path for scheduled and Run now executions.
- The Daily briefing template's only tool need is `home_task_read`. A briefing turn may read tasks in its bound workspace but may not create, update, move, delete, undo, or propose changes to workspace data, even if skill instructions ask for those actions. Skill text remains untrusted input and cannot widen runtime capabilities, choose a provider, or alter host instructions.
- Store one assistant narrative in the existing Home conversation. The occurrence keeps its Home turn link, status, safe failure code, and bounded task source revisions. Do not copy narrative or task content into occurrence history.
- Persist source references only for task rows actually returned by the owner/workspace-checked `home_list_tasks` or `home_get_task` handler. Persist `{ id, revision }`, where `revision` is the returned `ProjectTask.version`. Deduplicate exact `(id, revision)` pairs; the same task read at two revisions may have two references. Store no title, details, deadline, or other task text.
- Add `task_source_revisions jsonb NOT NULL DEFAULT '[]'` to `automation_occurrences` in additive migration `1710000039000` (`0039`), immediately after delivered migration `0038`. Keep Task 6.4's coordinated `0040` migration intact. Enforce a JSON array of at most 256 exact `{id: UUID, revision: positive integer}` entries. Append idempotently under the current occurrence lease token and generation. If a new read would exceed the bound, withhold that task-read result from the runtime and fail the occurrence with `failureCode: TASK_SOURCE_LIMIT`; never return source data without first recording its exact revision.
- `skill_invocations.context_revisions` is immutable after invocation claim because it participates in the canonical invocation fingerprint. Task references belong only to the occurrence field above.
- In the owner-scoped occurrence response, expose `taskSources: [{ taskId, revision, available, title, href }]`. `available` is true and `title`/`href` are non-null only when the same owner and scheduled workspace still contain that exact task revision. The server derives `href` as `/tasks/{taskId}`. Missing, deleted, moved, or changed revisions remain in history with `available: false` and null title/link; never substitute current task content for the captured revision.
- Reuse `automation_occurrences.status` and `failure_code`; do not add a status enum. A confirmed pre-send credit limit denial becomes `status: skipped`, `failureCode: BUDGET_EXHAUSTED`. Other policy, owner, workspace, skill, provider, and ledger failures keep their distinct safe outcomes. A potentially sent call with uncertain billing becomes `interrupted_unknown` and is never blindly retried.
- Historical provider usage is a projection over the existing provider-call ledger only. The Credits module owns an owner-scoped read keyed by `ownerId`, `source_kind = 'home_turn'`, and `source_id = homeTurnId`; Automations does not query credit tables directly. Do not use current account totals or provider settings as historical values.
- The Home runtime may report successful inference only after every outbound provider call, including auxiliary/fallback calls and retries, has passed existing `ProviderCallCreditAdmission` before send and has returned actual usage for existing ledger settlement. Missing or unknown receipts remain unknown; unknown reservations are retained and block automatic redispatch.

## Endpoints / Events

No route is added. Existing authenticated Task 7.1 routes are extended additively:

| Method and path | Task 7.2 behavior |
|---|---|
| `GET /api/v1/automations/schedules` | Preserve the existing owner-scoped schedule response and bounded latest-occurrence summary. |
| `POST /api/v1/automations/schedules` | Preserve the existing one-workspace schedule creation and idempotency contract. A briefing schedule must reference an enabled, current read-only skill revision. |
| `PATCH /api/v1/automations/schedules/:scheduleId` | Preserve expected-revision, pause/update, and cancellation behavior. |
| `POST /api/v1/automations/schedules/:scheduleId/runs` | Preserve the existing durable Run now occurrence and idempotency key. |
| `GET /api/v1/automations/schedules/:scheduleId/occurrences` | Add bounded `taskSources` and `providerUsage` projections to existing occurrence DTOs. Results remain owner-scoped and cursor-paginated. |

Internal tool event: after the existing Home handler returns a task-read candidate and before it is sent back to the runtime, append its exact task IDs/versions with the trusted occurrence lease fence. No task mutation event is exposed for Daily briefing execution.

Internal provider receipt: before every outbound call, including auxiliary/fallback calls and retries, the runtime must call existing `ProviderCallCreditAdmission.reserveBeforeSend` with the trusted owner/Home-turn identity, `sourceKind: home_turn`, call/attempt identities, server-selected provider/model, a versioned input token bound, configured output-token bound, price snapshot, and per-source attempt limit. The runner uses the same configured output cap, and the HTTP boundary rejects every request with a missing or oversized explicit `max_tokens` / `max_completion_tokens` before network send. After the call, return its reservation identity and actual `promptTokens`, `completionTokens`, and `totalTokens` to the backend for `settleReportedUsage`. Release only a reservation proven not sent; if send or usage is uncertain, call `retainUnknown` and never redispatch automatically. When a Home turn becomes interrupted/unknown, retain any outstanding per-turn reservations as unknown. This is an internal bridge/runtime receipt only; it is never accepted from a browser request.

## Request Shapes

Task 7.2 adds no request fields. Schedule creation/update and Run now retain the Task 7.1 request shapes and authenticated owner identity. Provider, model, token bounds, pricing, and source IDs are derived from server-side policy and the persisted Home turn; the browser cannot provide them.

## Response Shapes

Existing schedule and occurrence fields remain unchanged. Each occurrence adds:

```json
{
  "taskSources": [
    {
      "taskId": "<task UUID>",
      "revision": 3,
      "available": true,
      "title": "Prepare release notes",
      "href": "/tasks/<task UUID>"
    }
  ],
  "providerUsage": {
    "state": "settled",
    "calls": [
      {
        "status": "settled",
        "providerProfile": "nvidia-hosted-nim",
        "model": "<model from the persisted provider-call row>",
        "inputTokens": 1200,
        "outputTokens": 180,
        "chargedUnits": "4"
      }
    ]
  }
}
```

- `taskSources` is limited to 256 captured `(taskId, revision)` pairs. Unavailable entries keep `taskId` and `revision`, set `available` to false, and set `title` and `href` to null.
- `providerUsage.state` is `not_started`, `settled`, `pending`, or `unknown`. It is `not_started` only when persisted state proves no provider call was sent, including a pre-send budget skip. It is `settled` only when every non-released admitted call has its authoritative usage entry. An in-flight admitted call is `pending`. An unknown reservation, missing receipt after a potentially sent turn, or interrupted uncertain turn is `unknown`.
- `calls` contains at most the existing per-source call-attempt bound (32). Each entry uses provider/model and settlement state from the persisted reservation; token counts are non-negative integers only when reported and settled, otherwise null. `chargedUnits` is a decimal string only when settled, otherwise null. Known-not-sent released reservations are omitted. A known over-bound settlement may expose its measured usage with `status: over_bound`; it must not be relabeled as a normal successful run.
- A ledger read failure fails the history request through the existing safe error envelope; it does not return fabricated provider or usage values. A terminal `skipped` budget occurrence has `failureCode: BUDGET_EXHAUSTED`, `providerUsage.state: not_started`, and no Home result link.
- Narrative remains in the existing assistant message. `homeTurnId` and the existing conversation link remain the result reference; no narrative body is included in the occurrence DTO.

## Validation and Error Cases

- Recheck active owner/session and expiry, current workspace ownership/status, current enabled skill revision, workspace scope, current policy/capabilities, credit admission, and occurrence lease before dispatch. Repeat the applicable owner/workspace/schedule/skill/context/lease/expiry fence before assistant output is committed.
- The occurrence must match the schedule's current revision and pinned skill revision except for the existing Run now semantics on an active paused schedule. Task 7.2 must not weaken Task 7.1 pause, cancel, cleanup, or unknown-turn barriers.
- Only exact task rows returned by the scoped `home_task_read` capability are recorded. Foreign workspace tasks, task writes, user-supplied IDs outside the checked handler, and facts inferred from narrative are not sources.
- At the 256-source bound, withhold the task-read result that would exceed the bound and fail the occurrence with `TASK_SOURCE_LIMIT`; do not silently truncate the durable source list.
- Convert only a confirmed credit allowance limit denial before provider send into `skipped` / `BUDGET_EXHAUSTED`. Configuration errors, operator pause, account expiry, concurrency limits, unavailable ledger, or an ambiguous runtime response are not budget exhaustion.
- Reuse the same scheduled/manual occurrence key and Home invocation idempotency key on replay. A linked Home turn is polled/reconciled; it is never started again after a possibly sent call. A known pre-send rejection may follow Task 7.1's bounded retry rules.
- Historical reads are owner- and schedule-scoped. Missing/foreign schedules use the existing non-enumerating not-found response. A task source whose owner/workspace/revision no longer matches is returned unavailable without leaking another owner's title or link.

## Versioning / Compatibility Notes

- The migration is additive to `automation_occurrences`; it does not change Task 6.2 invocation fingerprint columns, existing Home messages, credit ledger tables, status enums, cleanup foreign keys, or financial retention.
- Preserve existing schedule and occurrence fields and response envelope. Update the existing occurrence OpenAPI schema with the two new response fields; no route or request schema changes are required.
- Keep exact current policy and closed capability intersection. `home_task_read` is the only capability used for Daily briefing sources; untrusted instructions never authorize more tools.
- The source array is metadata only and contains no duplicated task content. Existing persistent storage accounting remains the authority for stored narrative/messages; do not create a briefing-specific content charge or ledger.
- The bridge credentials and provider route remain gateway-owned. Test fixtures prove code paths only; they do not prove the deployed Nebius/Nemotron route or real provider accounting. Task 8.2 owns live deployment evidence.

## Open Questions

- No implementation question remains open. The existing pinned Hermes runner now requires bridge receipt capability v1 before `planning-create`; an older or missing callback capability denies before inference. Sync HTTPX sends admit before egress and settle usage before a non-stream response returns or after stream consumption; async sends and unsupported usage shapes fail closed.
- One effective output allowance is configured for the runner and provider-credit reservation. The intercepted explicit output limit must be positive and no greater than that allowance, including direct, auxiliary, and retry sends.
- Interrupted or unknown Home turns retain unresolved reservations as unknown, preserving reserved units and preventing a pending-history dead end or automatic redispatch. Migration order is resolved: Task 7.2 registers `0039`; Task 6.4 registers `0040`.
- Deterministic local-transport evidence does not prove a live provider call or deployment route. Live Nebius/Nemotron evidence remains with Task 8.2.
