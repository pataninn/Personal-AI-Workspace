# Contract: Durable daily schedules and occurrence worker

## Change History

- 2026-10-19: Initial Task 7.1 contract, based on `architecture-preflight.md` and delivered Task 3.1, 3.5, and 6.2 behavior.
- 2026-10-20: Added explicit API-versus-worker process ownership, standalone worker commands, and graceful worker shutdown per the lifecycle ruling.

## Ownership

Task 7.1 owns the backend schedules/occurrences module, additive migration 0038, its independent worker entrypoint, and narrow scheduler fences in the existing skill/Home and cleanup paths. Migration 0038 is registered after the delivered 0037 migration. Task 7.3 owns schedule UI. Task 7.2 owns richer briefing workflow/output behavior.

## Scope

- One schedule targets exactly one owned, active, mutable workspace (including a file-backed workspace) and one enabled skill revision. Home tool access remains limited to the existing closed capability set. Multiple selected workspaces require separate schedules and conversations.
- A schedule owns one persisted workspace-scoped Home conversation. The scheduled briefing skill is read-only; write capabilities are rejected.
- PostgreSQL owns schedule revision, due time, one occurrence per resolved scheduled instant, idempotency key, claim lease/fence, skill revision, and linked skill invocation/Home turn.
- A separate worker claims bounded due work using database time and `FOR UPDATE SKIP LOCKED`. Worker timers only trigger a claim pass; workers may safely overlap.
- API lifecycle runs only existing storage/project/demo maintenance; automation-worker lifecycle runs only the scheduler loop. The API server starts in API mode, while `start:worker`/`dev:worker` start the separate worker without an HTTP listener.
- Worker SIGINT/SIGTERM stops the periodic timer, drains the active bounded pass, and closes the initialized database. Startup failures stop any started periodic handle and destroy an initialized database.
- Dispatch uses the existing `InvokeSkillUseCase` → `SubmitHomeTurnUseCase` path. Polling and output use `GetHomeTurnUseCase` and the existing Home transcript. Credit, storage, provider, policy, context, and capability checks remain authoritative.
- DST gaps resolve to the first valid local instant after the requested time; repeated local times resolve to the earlier instant. Downtime coalesces missed dates to at most one recent catch-up and advances to the next future due instant.
- Pause/update increments schedule revision, cancels queued work, and fences in-flight dispatch and output. Run now creates its own durable occurrence and may run for an active paused schedule. A potentially sent turn is never automatically restarted; persisted uncertain work remains `interrupted_unknown` until safe reconciliation.
- Demo expiry and workspace removal cancel linked active Home work outside database locks and block purge while an occurrence/turn is nonterminal or unknown. Exact schedule/occurrence IDs are included in cleanup receipts. Settled credit details and shared counters follow Task 3.5 retention unchanged.

## Endpoints / Events

All routes require an authenticated owner session; mutations require same-origin, CSRF protection, and an `Idempotency-Key` where indicated.

| Method and path | Behavior |
| --- | --- |
| `GET /api/v1/automations/schedules` | List the owner's schedules and bounded latest occurrence summaries. |
| `POST /api/v1/automations/schedules` | Create one workspace-scoped schedule; requires `Idempotency-Key`. Idempotently provisions its accounted Home conversation before the schedule becomes executable. |
| `PATCH /api/v1/automations/schedules/:scheduleId` | Update `localTime`, `timeZone`, `skillId`/`skillVersion`, or `enabled`; requires `expectedRevision`. Workspace scope is immutable. |
| `POST /api/v1/automations/schedules/:scheduleId/runs` | Queue Run now; requires `Idempotency-Key`. The same key replays the same occurrence. |
| `GET /api/v1/automations/schedules/:scheduleId/occurrences` | Return a bounded, owner-scoped occurrence history page. |

Internal worker event: claim due occurrence, recheck its current trusted fence, invoke/replay the existing Home skill request, then poll/reconcile the linked turn. No external queue or provider-specific scheduler endpoint is introduced.

## Request Shapes

Create body:

```json
{
  "workspaceId": "uuid",
  "skillId": "uuid",
  "skillVersion": 1,
  "localTime": "08:30",
  "timeZone": "America/Los_Angeles"
}
```

Update body contains `expectedRevision` and at least one of `skillId` + `skillVersion`, `localTime`, `timeZone`, or `enabled`. Run now has an empty strict JSON object body.

Scheduled occurrence invocation keys are deterministic per schedule and intended local date/instant. Run now keys are generated from the durable occurrence ID and the caller's idempotency digest. Retry keys advance only for an attempt proven not sent by the existing Home/runtime path; potentially sent attempts are never retried.

## Response Shapes

Schedule responses contain `id`, `workspaceId`, `skillId`, current `skillVersion`, `conversationId`, `localTime`, canonical `timeZone`, `enabled`, `revision`, `nextDueAt`, `lastRunStatus`, and timestamps. They contain no skill instructions, prompts, context content, or provider secrets.

Occurrence responses contain `id`, `kind` (`scheduled` or `manual`), `intendedFor`, `status`, `scheduleRevision`, `skillVersion`, `homeTurnId`, safe `failureCode`, attempt count, and lifecycle timestamps. Narrative remains in Home messages; occurrence records do not duplicate it.

## Validation and Error Cases

- Require a valid UUID workspace/skill, positive current skill version, `HH:mm` local time, and a valid canonical IANA zone accepted by native `Intl`.
- Workspace must be owned, active, and mutable; skill must be owned, enabled, current at the requested version, account-wide or bound to the same workspace, and declare only read capabilities.
- Update requires an exact positive `expectedRevision`; a stale revision returns `409 SCHEDULE_REVISION_CONFLICT`.
- Idempotency key reuse with a different request returns `409 IDEMPOTENCY_KEY_REUSED`.
- Foreign/missing workspace, schedule, or skill returns a non-enumerating not-found response. Expired/inactive owner, disabled/changed skill, stale context, paused automatic schedule, lost lease, or invalid cleanup generation blocks dispatch/output.
- An expired lease cannot clear an already linked Home turn. Provider/runtime uncertainty yields `interrupted_unknown`; it does not release unknown credit or start another inference.
- Unsupported write-capability skills return `422 SCHEDULE_SKILL_NOT_READ_ONLY`; invalid IANA time zone or local-time syntax returns `400 VALIDATION_ERROR`.

## Versioning / Compatibility Notes

- Migration 0038 is additive and follows the delivered 0037 migration; 0038 registration must preserve other active owners' registry hunks.
- Do not change migrations 0027, 0034, 0035, 0036, or 0037. Use the existing `skill_invocations`, Home turn, storage accounting, credit admission, and demo cleanup contracts.
- Home turn APIs and ordinary non-scheduled skill/chat calls retain current behavior; scheduler guards are trusted internal inputs and cannot be supplied by HTTP.
- No frontend changes are in Task 7.1. API/OpenAPI changes are additive and must be coordinated with active owners.
- Starting `server.js` alone no longer runs schedules. Deployments must keep at least one `start:worker` process running with the same environment and database as the API.
- No new package is planned. The installed Node `Intl` APIs are used for IANA validation and local-date/DST resolution; Context7 was unavailable during preflight.

## Open Questions

- None at contract gate. The architecture preflight fixes one workspace per schedule, invocation fencing, cleanup barriers, and unknown-turn handling.
