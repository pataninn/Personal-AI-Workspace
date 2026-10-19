# Contract: Direct Home task and workspace actions

**Status:** Refreshed against Task 4.1 and the implemented Task 4.2 source. Receipt provenance and the bounded VERSION_CONFLICT continuation are implemented; focused backend, bridge, frontend, browser, and type checks passed. No persistence migration was needed.

## Change History

- 2026-10-19: Defined the direct single-action path, canonical receipt/provenance, idempotency, conflict and partial-outcome requirements from architecture and the Task 4.2 preflight.
- 2026-10-19: Refreshed after Task 4.1 delivery (`4f9ad9b`) and source inspection at `Personal-AI-Workspace` HEAD `ae188ba9d39264ff4b981dc745b7a1daafd70c20`. Confirmed direct canonical handlers, stable keys, persisted `actor_kind`/`turn_id`, and the atomic event pointer already exist. Receipt/undo HTTP DTOs, OpenAPI, and Home Activity omit the persisted source. A second gap is that `GetHomeTurnUseCase` treats a known canonical conflict as a blocked runtime event and marks the turn unknown/cancelled; it has no bounded known-conflict tool result. No migration or new operation store is needed.
- 2026-10-19: Implemented receipt provenance (actorKind, nullable turnId) in GET and undo summaries, OpenAPI, frontend normalization, and Home Activity. Activity uses the persisted turn for placement and shows a readable action, source, and Applied state. Focused backend, frontend, and browser checks pass.
- 2026-10-19: Implemented the architect-approved bounded VERSION_CONFLICT continuation for exact ProjectTaskVersionConflictError and ProjectVersionConflictError failures. The failed action creates no receipt; unrelated idempotency, policy, authorization, scope, and transport failures keep their existing handling. Backend, bridge, frontend, browser, and type checks pass.

## Ownership

- The authenticated session supplies the owner. The persisted Home conversation supplies its scope and turn. Model arguments, event text, and browser data never supply an owner or authorization decision.
- Task 4.1 owns stored policy, current-revision checks, Home/workspace capability intersection, provider readiness, and removal of consent as execution authority. Task 4.2 consumes those guards and cannot broaden them.
- Canonical task, workspace, and action-ledger use cases own mutations, optimistic versions, idempotency, quota accounting, and receipts. Task 4.2 must call those use cases rather than adding a parallel mutation repository or controller-side writes.
- Task 4.3 owns task deletion and removal of archive behavior. Task 4.2 adds neither.
- Task 4.1 is delivered. The existing handler and command validation already provide direct typed actions and are consumed as-is unless focused tests expose a concrete gap. Task 4.2 updates receipt serialization/OpenAPI and the existing Home Activity surface plus focused tests. It represents only exact canonical expected-version conflicts as a bounded result, without creating a success receipt or changing unrelated failure handling. No migration is needed for single-action identity or provenance.

## Scope

One typed Home tool request performs at most one canonical mutation. Existing direct handlers cover task create/update/move/archive, planning-workspace create/objective update, and action undo. A multi-action request is a sequence of individually authorized operations, each with its own stable operation key and receipt; the sequence is not atomic. Preserve all existing owner, active-principal, current-policy, provider/credit, storage, optimistic-version, and workspace-scope checks.

Keep bounded task/workspace reads available to resolve clear targets. If the user's intent does not identify one target, ask a clarification and do not mutate. Never fuzzy-select by name. Home task creation with no workspace target uses Inbox (`null`); in a workspace conversation, an omitted workspace means that conversation's workspace, and a different explicit workspace is rejected. Home-scope explicit workspace targets must resolve to an active workspace owned by the same principal.

Keep the existing `home_archive_task` behavior only as a transitional compatibility action until Task 4.3 removes it. Do not add delete, reinterpret archive as delete, invoke or resume a persisted proposal, or make `home_propose_bulk_changes` executable. `workspaceRef` is proposal-only and is not a direct-action target.

Every committed Home mutation is attributed as `actorKind: "assistant"` with its persisted `turnId`, even though the user requested it. It is never labelled accepted by the user. Manual UI/API operations remain `actorKind: "manual"` with a null turn. The existing action ledger and `action.receipt` event remain the durable record; the event carries only a receipt pointer and bounded target/action metadata.

## Endpoints / Events

No new mutation endpoint is introduced. A user continues to submit natural-language Home input through:

- `POST /api/v1/home/conversations/{conversationId}/turns` with `{ "message": string }`, authenticated session, same-origin check, CSRF token, and `Idempotency-Key`.
- The server-selected runtime issues internal typed tool requests. The server derives owner and scope from authenticated/persisted state and applies the fixed Home/workspace policy before each tool dispatch and canonical effect.

The existing owner-scoped read response `GET /api/v1/actions/{actionId}` and original/undo receipt summaries returned by `POST /api/v1/actions/{actionId}/undo` include persisted `actorKind` (`assistant` or `manual`) and nullable `turnId`. Manual records require null; assistant records carry the persisted turn UUID. Undo's same-origin, session, CSRF, and idempotency requirements remain unchanged. Keep reversible before/after values and request fingerprints out of the read metadata. The assistant tool result already includes `replayed`; the persisted receipt lookup does not. Home Activity therefore labels confirmed persisted receipts as applied and must not infer an exact replay from the event pointer.

The existing `action.receipt` Home event remains a safe pointer. The Home Activity card reads the owner-scoped receipt and labels its actual source (`Assistant` for assistant actions, `You` for manual actions); it does not infer actor from event text. Existing consent/proposal/change/command decision endpoints remain retired under Task 4.1 and cannot be used as an alternate execution path.

## Request Shapes

The public Home turn request does not accept action, owner, provider, policy, target-scope, or actor fields. The internal tool request remains bounded and server-owned: persisted `ownerId`, `conversationId`, `turnId`, runtime `requestId`, registered tool name, JSON arguments, and persisted conversation scope.

Direct mutation arguments use strict action-specific schemas. UUIDs are canonical IDs; positive versions are integers from 1 through 2,147,483,647.

| Tool | Request fields and constraints |
| --- | --- |
| `home_create_task` | `title` (1–120 chars); optional `details` (nullable, at most 4,096 chars), `workspaceId` (UUID or null), `importance` (`low\|medium\|high\|urgent`), `deadline` (null, calendar date, or 0–365 days from today), up to 50 subtasks (title 1–120 chars), and optional positive `expectedOrderVersion`. |
| `home_update_task` | `taskId`, positive `expectedVersion`, and either a status-only update (`todo\|in_progress\|blocked\|done`) or a non-empty patch of title/details/importance/deadline/subtasks. Status cannot be combined with another patch field. Existing subtask IDs must belong to the task. |
| `home_move_task` | `taskId`, positive `expectedVersion`, `workspaceId` (UUID or null), and optional positive source/destination order versions. |
| `home_archive_task` | `taskId`, positive `expectedVersion`, and optional positive order version; transitional until Task 4.3. |
| `home_create_workspace` | `name` (1–120 chars) and optional nullable `objective` (at most 2,000 chars). Creates a rootless planning workspace. |
| `home_update_workspace_objective` | `workspaceId`, positive `expectedVersion`, and nullable `objective` (at most 2,000 chars). |
| `home_undo_action` | Owner-scoped `actionId` UUID; uses the canonical undo use case and a stable operation key. |

Direct commands do not accept fuzzy names, proposal indices, `workspaceRef`, caller-generated operation keys, or client-provided actor/source labels. The server derives the stable operation identity from owner, turn, runtime request ID, and tool name. The canonical request fingerprint includes normalized arguments and expected versions.

## Response Shapes

An applied or exact replay returns a bounded Home tool result with the persisted action receipt ID, action kind, target kind/ID, resulting target version, and replay flag. It contains no raw tool arguments or reversible before/after content. The action ledger record, target mutation, and `action.receipt` event pointer commit or roll back together.

The receipt read metadata is:

```json
{
  "id": "<action UUID>",
  "actionKind": "task.update",
  "actorKind": "assistant",
  "turnId": "<source turn UUID>",
  "targetKind": "task",
  "targetId": "<owner-scoped target UUID>",
  "postVersion": 3,
  "undoStatus": "available",
  "undoActionId": null
}
```

`actorKind` is `assistant` or `manual`; `turnId` is a UUID for assistant actions and null for manual actions. The Activity UI derives a short source label (`Assistant` or `You`) from these stored fields, uses the persisted turn ID for turn placement, and never displays the ID. It must not describe an assistant action as user-accepted. A receipt event is only a lookup pointer; it is not itself evidence that the action is applied until the owner-scoped receipt read succeeds.

A known non-applied action may return only a bounded safe outcome code, never a success receipt. Policy/ownership denial does not send a `denied` runtime continuation; it stops the current execution safely. An exact expected-version conflict returns only outcome=conflict and code=VERSION_CONFLICT through the existing tool-result continuation so the runtime can report it without a false receipt. Earlier persisted action receipts remain valid; the turn must not claim group rollback. If a send or durable outcome is uncertain, preserve the existing `unknown` turn state, resolve with the same operation key where possible, and do not invent success or retry with a fresh key. Home Activity cards are created only for committed `action.receipt` pointers; turn-level known conflict/partial/unknown status or copy must not be fabricated from receipt absence.

Earlier committed actions remain committed if a later separate request conflicts or fails. The turn must report a truthful partial result based only on persisted receipts and known outcomes; it never claims a group rollback. If the latest operation outcome is unknown, the turn remains unknown rather than presenting an unverified partial/success result.

## Validation and Error Cases

- Invalid tool names or malformed/over-limit arguments produce no mutation and no success receipt.
- Missing, foreign, archived, or wrong-scope targets use existing non-disclosing not-found/conflict behavior; they do not reveal another owner's resource.
- Exact stale expected-version errors from ProjectTaskVersionConflictError and ProjectVersionConflictError return VERSION_CONFLICT with no receipt. Idempotency-key reuse with different normalized arguments remains its existing non-applied error path and is not relabeled as a version conflict.
- Exact operation replay returns the original receipt and `replayed: true` in that tool response without another version advance or event. A distinct runtime request ID is a distinct operation, not a content-similarity dedupe. Replay state is not stored in the receipt metadata, so the reloaded Activity card does not claim that it was a replay.
- Disabled/expired principals, changed or revoked policy, missing capability, unavailable provider/runtime/credit admission, storage readiness failure, quota denial, or removal barriers stop new effects. A denied effect creates no success receipt. Existing independent Task 3.1 and Task 3.2 admission semantics remain authoritative.
- Any uncertain commit/handoff remains unknown and is reconciled by the same owner-scoped operation identity; do not issue a new identity to make the UI look successful.
- `GET /api/v1/actions/{actionId}` remains session-authenticated and owner-scoped: invalid UUID returns 400, absent/foreign receipt returns the existing generic 404, and success returns only safe metadata.
- Undo remains the existing canonical compensation operation. Stale/unavailable/already-undone/key-reuse conflicts retain existing 409 behavior; quota/storage errors retain their existing 413/503 behavior. A workspace/file result does not disclose host paths.

## Versioning / Compatibility Notes

- The action ledger already persists actor, turn, target, expected/pre/post versions, fingerprint, and outcome. No new idempotency or provenance table is needed. Keep `action.receipt` as a pointer and add only the minimal receipt metadata fields to existing API/entity/OpenAPI shapes.
- Preserve historical proposal/consent records for read-only history. They do not authorize new execution. Task 4.2 does not auto-accept, resume, relabel, or backfill them.
- Preserve archive compatibility only until Task 4.3 removes archive behavior. No Task 4.2 delete action or schema migration.
- Tool delivery idempotency is not exactly-once provider inference. Stable ledger keys prevent duplicate mutations, while Task 3.1 separately governs provider-call reservations.
- Preserve Task 3.2 quota accounting for action records, Home events, and any new persisted Home result content.

## Open Questions

- None for this bounded Task 4.2 slice. Exact expected-version conflict mapping, the no-receipt result, result validation in the Hermes runtime/bridge, and preservation of unrelated failure handling are implemented and covered by focused tests.
- Per-turn batch persistence remains out of scope. Each action remains independently atomic; prior receipts remain visible, and runtime results carry only the known non-applied conflict code. Unknown send or commit outcomes remain unknown.