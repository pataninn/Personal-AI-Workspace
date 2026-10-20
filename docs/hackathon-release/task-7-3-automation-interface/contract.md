# Contract: Automation schedule interface

## Change History

- 2026-10-20: Refreshed against the delivered Task 7.2 router serialization and domain DTOs before frontend implementation. Confirmed the occurrence-history cursor envelope and actual Home-turn usage projection.

## Ownership

Task 7.3 owns the Automations page, schedule create/edit/pause UI, Run now interaction, occurrence history and ready notice, plus focused frontend tests and browser evidence. Task 7.1 owns authenticated schedule/occurrence APIs, execution, revisions, fencing, and cleanup. Task 7.2 owns the additive source and historical provider-usage projections. Skills and projects remain owned by their existing APIs. This task adds no backend route, database field, or new persistence.

## Scope

Provide one daily schedule for one active owned workspace and one current saved enabled read-only skill revision. The schedule starts enabled; its workspace scope is immutable. Users may update the local time, IANA time zone, skill revision, and enabled state; pause/resume uses the same update route. **Run now** creates one separate manual occurrence, is allowed while the schedule is paused, and requires no approval dialog.

Use the existing authenticated project/workspace and skill APIs to populate choices and display names. A workspace candidate comes from `GET /api/v1/projects` and must have `status: "active"`; the create/update endpoints remain authoritative for mutability, ownership, and demo expiry. For each selected workspace use `GET /api/v1/skills?workspaceId={workspaceId}`; it returns the owner's active account-wide and workspace-bound skills visible to that workspace. Offer only enabled skills whose declared tools are all within the current scheduler read-only set (`home_task_read`, `home_workspace_read`). A skill with write capabilities is never offered, and the server revalidates the current revision at save/dispatch.

The UI consumes Task 7.2's occurrence extensions in the existing history route. It does not add a result API or duplicate narrative: open the saved workspace Home conversation through existing planning-chat navigation. No current provider configuration, account-wide credit total, or inferred task source may be presented as a historical run fact.

## Endpoints / Events

All JSON endpoints use the existing `{ "data": ..., "error": ... }` envelope and session authentication. Mutations retain same-origin and CSRF protection. Owner identity is never sent by the client.

| Method and path | Client use |
| --- | --- |
| `GET /api/v1/projects` | Load owned workspace choices and resolve schedule workspace names. Filter to active choices; server remains authoritative. |
| `GET /api/v1/skills?workspaceId={uuid}` | Load eligible skills for one workspace and resolve schedule skill titles/current versions. |
| `GET /api/v1/automations/schedules` | Load the signed-in owner's schedule list. The delivered route returns schedule DTOs only; history is loaded from each schedule's occurrence route. |
| `POST /api/v1/automations/schedules` | Create one enabled schedule with an `Idempotency-Key`. |
| `PATCH /api/v1/automations/schedules/{scheduleId}` | Edit fields or pause/resume using `expectedRevision`. Workspace is immutable. |
| `POST /api/v1/automations/schedules/{scheduleId}/runs` | Queue one manual occurrence with an `Idempotency-Key` and strict empty object body. |
| `GET /api/v1/automations/schedules/{scheduleId}/occurrences?limit={1..100}&before={cursor}` | Load or refresh bounded schedule history; no new polling/status endpoint is introduced. |

The existing authenticated schedule list and occurrence endpoints are the authoritative source for display and reconciliation. No browser/provider bridge or worker API is called directly.

## Request Shapes

Create sends this strict body and a fresh generated `Idempotency-Key`:

```json
{
  "workspaceId": "<UUID>",
  "skillId": "<UUID>",
  "skillVersion": 1,
  "localTime": "08:30",
  "timeZone": "America/Los_Angeles"
}
```

The key matches the server's `[A-Za-z0-9._~-]{8,128}` rule. Generate one key per logical create and retain the exact body/key for an uncertain transport retry; do not create a second schedule with a new key while the first outcome is unresolved.

Update sends a strict non-empty patch with the current revision and at least one mutable field:

```json
{ "expectedRevision": 3, "enabled": false }
```

Other editable fields are `localTime`, `timeZone`, or the paired `skillId` and `skillVersion`. The client never sends `workspaceId` during update. Pause/resume is `enabled: false/true` with the latest server `revision`; edits to a skill require its currently loaded `version`.

Run now sends `{}` with one generated `Idempotency-Key`. Preserve that same key for a retry after a timeout/network uncertainty. First refresh occurrence history; if no acknowledged matching run is visible, retry only the exact same request/key. A new explicit run gets a new key only after the earlier occurrence has resolved. Do not send a revision, workspace, provider, skill, prompt, task source, or credit value in this request.

## Response Shapes

Schedule create, list, and update use the existing envelope. Schedule DTOs contain exactly the current public fields:

```json
{
  "id": "<UUID>",
  "workspaceId": "<UUID>",
  "conversationId": "<workspace Home conversation UUID>",
  "skillId": "<UUID>",
  "skillVersion": 1,
  "localTime": "08:30",
  "timeZone": "America/Los_Angeles",
  "enabled": true,
  "revision": 3,
  "nextDueAt": "<ISO-8601 UTC or null>",
  "lastRunStatus": "succeeded",
  "createdAt": "<ISO-8601 UTC>",
  "updatedAt": "<ISO-8601 UTC>"
}
```

The schedule list is `{ "data": { "schedules": Schedule[] }, "error": null }`; it does not include a latest-occurrence summary in the delivered router. New create returns `201` with `{schedule}`; exact replay also returns the existing schedule and `Idempotency-Replayed: true`. Update returns `200` with `{schedule}`. `nextDueAt` and `revision` come only from the server. A paused schedule has `nextDueAt: null`; display **No next run**. Do not calculate due times in the browser. Format returned instants with the saved IANA zone and always show that zone name.

The project choice DTO is the existing project summary: `id`, `name`, `slug`, `objective`, `workspaceMode`, `capabilities`, `status`, `version`, `createdAt`, `updatedAt`. The skill choice DTO is `id`, `workspaceId` (`null` for account-wide), `title`, `instructions`, `declaredTools`, `enabled`, `version`, `createdAt`, `updatedAt`. Neither DTO supplies authority; the schedule API checks current owner, active workspace, enabled current skill, exact version, workspace visibility, and read-only capabilities.

Run now returns `{ "data": { "occurrence": Occurrence }, "error": null }`: `202` for a newly queued occurrence and `200` with `Idempotency-Replayed: true` for the same key. Occurrence history returns `{ "data": { "occurrences": Occurrence[], "nextCursor": string | null }, "error": null }`.

The delivered occurrence DTO contains the following public fields (there is no `localDate`, lease, owner, or internal skill revision field in the response); Task 7.2 serializes `taskSources` as an array and `providerUsage` as an object for every occurrence:

```json
{
  "id": "<UUID>",
  "kind": "scheduled",
  "intendedFor": "<ISO-8601 UTC>",
  "status": "succeeded",
  "scheduleRevision": 3,
  "skillVersion": 1,
  "homeTurnId": "<UUID or null>",
  "failureCode": null,
  "attemptCount": 1,
  "createdAt": "<ISO-8601 UTC>",
  "updatedAt": "<ISO-8601 UTC>",
  "taskSources": [
    { "taskId": "<UUID>", "revision": 4, "available": true, "title": "Prepare release notes", "href": "/tasks/<UUID>" }
  ],
  "providerUsage": {
    "state": "settled",
    "calls": [
      { "status": "settled", "providerProfile": "<persisted profile>", "model": "<persisted model>", "inputTokens": 1200, "outputTokens": 180, "chargedUnits": "4" }
    ]
  }
}
```

`kind` is `scheduled | manual`; `status` is `queued | claimed | dispatching | running | succeeded | failed | cancel_requested | cancelled | interrupted_unknown | skipped`. Task 7.2's `taskSources` has at most 256 `{taskId, revision, available, title, href}` entries; unavailable source revisions retain the ID/revision and set `available: false`, `title: null`, and `href: null`. Link only an available source, using the returned same-origin `/tasks/{taskId}` path; never substitute a current task revision for the captured one.

`providerUsage.state` is `not_started | settled | pending | unknown`; `calls` has at most 32 persisted provider-call entries. Each entry carries persisted `status`, `providerProfile`, and `model`; `inputTokens` and `outputTokens` are non-negative integers only when settled (otherwise null), and `chargedUnits` is a decimal string only when settled (otherwise null). Known-not-sent released reservations are omitted. A known over-bound settlement may carry `status: "over_bound"`; show the recorded usage without calling the run a normal success. If an older occurrence lacks the optional Task 7.2 fields, show **Provider unavailable** and **Usage unavailable**; never fill them from current settings or account totals.

## Validation and Error Cases

- Use visible labels and client-side validation for `HH:mm` and a browser-resolved IANA zone. Server validation/canonicalization is authoritative; preserve form values on errors and display the returned canonical `timeZone`. The first invalid field receives focus. DST gaps, repeated times, downtime catch-up, and next due are server rules, not client calculations.
- Only active owned workspace candidates and enabled skills with allowed read-only tools are offered. Save revalidates; if a workspace/skill is unavailable or changed, refresh choices and retain the user's time/zone. A public showcase or expired/disabled demo cannot be scheduled.
- `400 VALIDATION_ERROR`: retain all fields and show field-level validation. `401`/existing session-expiry response: use the existing sign-in/demo-expiry flow. `404 AUTOMATION_NOT_FOUND`, `AUTOMATION_WORKSPACE_NOT_FOUND`, or `AUTOMATION_SKILL_NOT_FOUND`: show a safe unavailable message and reload the affected data.
- `409 SCHEDULE_REVISION_CONFLICT`: refresh the schedule, say it changed, and require the user to explicitly reload/reopen before saving again; do not overwrite newer values. `409 SKILL_VERSION_CONFLICT`: reload eligible skills and require an explicit current version. Preserve unsaved edits until the user chooses to reload.
- `409 IDEMPOTENCY_KEY_REUSED`: keep the exact request identity and reconcile through the schedule/history reads; do not silently mint a new key for the same uncertain action. `409 SCHEDULE_BUSY`: explain that the prior run is still resolving and take the user to history. Do not enqueue a new run while an occurrence is unresolved.
- `422 SCHEDULE_SKILL_NOT_READ_ONLY`: refresh choices and do not retry that skill. `skipped` with `failureCode: BUDGET_EXHAUSTED` is shown as **Skipped — AI budget**; do not infer budget exhaustion from other errors. Never report credits as refunded or promise automatic retry.
- Status labels: `queued` → **Queued**; `claimed`, `dispatching`, `running` → **Running** (or **Starting** for dispatching); `cancel_requested` → **Cancelling**; `succeeded` → **Succeeded**; `failed` → **Failed**; `cancelled` → **Cancelled**; `skipped` with confirmed budget code → **Skipped — AI budget**; `interrupted_unknown` → **Interrupted — outcome/usage pending reconciliation**. Do not display raw `failureCode` values.
- Provider/usage display uses only Task 7.2's historical ledger projection. `settled` shows persisted call provider/model and settled token/charge values; `not_started` says no provider call was sent; `pending`/`unknown` says usage is pending reconciliation and never implies zero cost. If no authoritative per-run projection exists, show **Provider unavailable** / **Usage unavailable**. A ledger/history read error shows the existing safe retry alert, not invented values.
- Load the first bounded occurrence-history page for each listed schedule so a just-finished scheduled run can be discovered while Automations is open; reuse those pages for the selected schedule's history view. Poll only while a first page contains a queued, claimed, dispatching, running, cancel-requested, or unknown occurrence. Use a modest bounded backoff, pause polling while hidden, and refresh when visible again. Stop polling settled pages; keep **Try again** for read failures. `interrupted_unknown` remains unresolved: reconcile it and preserve the same Run now key for any exact retry; never automatically dispatch or offer a fresh-key retry.
- When a persisted occurrence newly reaches `succeeded` while this page is active, show one polite, non-modal **Your daily briefing is ready** notice with **Open briefing**. It must not take focus or navigate automatically. Do not create an unread marker or imply a persistent notification. Other linked turns use **Open conversation**; a skipped-before-dispatch occurrence has no result link. Use the schedule's server-returned `workspaceId` and `conversationId` with existing planning-chat navigation; narrative stays in the Home renderer.

## Versioning / Compatibility Notes

- Task 7.3 consumes the additive Task 7.2 `taskSources` and `providerUsage` projections on the existing occurrence-history response; it does not change their route or request shape. The delivered occurrence serializer supplies an empty `taskSources` array and a `providerUsage` fallback (`not_started` when no Home turn exists, otherwise `unknown`) when a projection has no values.
- Keep the existing authenticated owner scope, same-origin/CSRF mutation controls, response envelope, revision semantics, idempotency, schedule workspace binding, pause/cancel behavior, worker policy, and unknown-turn barriers unchanged.
- Preserve create's default-enabled behavior and absence of a schedule-name field. No schedule-delete endpoint exists; do not add a Delete action. No new backend endpoint, migration, dependency, result store, notification center, workflow builder, or polling service is part of this task.
- OpenAPI remains the backend owners' existing contract. Task 7.3 adds no OpenAPI schema or route; frontend DTOs must match the delivered Task 7.1/7.2 definitions.

## Open Questions

- None. The implementation consumes the delivered Task 7.1/7.2 contracts and serialized DTOs; no backend change is required.
