# Contract: Persist editable user skills with bounded invocation

## Change History

- 2026-10-19: Initial backend contract and source map from release Task 6.2, architecture sections 8 and 10, Task 3.4's approved-skill carry-forward, and delivered Task 6.1 memory/context contract.

## Ownership

- The authenticated principal supplies `ownerId`; clients never submit an owner or policy. A skill may be account-wide or associated with one active workspace owned by that principal.
- The skills module owns user skill definitions, immutable revisions, template copies, and invocation metadata. Existing Home runtime, policy, provider, principal, quota, and conversation paths remain the authorities for execution.
- Showcase publication accepts an explicit administrator-selected allowlist of enabled, non-deleted skills owned by that administrator and either account-wide or associated with the selected source project. Its immutable public projection contains only generated public IDs and reviewed title, instructions, and declared tool fields. Demo copies create new owner-scoped skill IDs and bind them to the copied workspace; they never copy source owner IDs, policies, or runtime `SKILL.md` resources.
- The Task 6.3 interface owns skill browsing/editing and the full publisher skill picker/public skill display. Task 6.2 adds backend behavior plus narrow showcase DTO normalization so existing publisher and read-only pages remain compatible; it does not add skill-selection or skill-card UI.

## Scope

- Persist account-owned skills with stable UUID, optional workspace association, title, instructions, enabled state, positive monotonically increasing version, and declared Home tool capabilities. Preserve immutable revisions so an invocation can reference the exact skill version it used.
- Provide the Plan my day and Daily briefing starter templates as server-owned, read-only templates. Copying a template creates an independent editable user skill; editing it never changes the shared template.
- `home_task_read`, `home_task_write`, `home_workspace_read`, `home_workspace_write`, and `home_action_undo` are the only declared tool needs. Invocation authority is the intersection of the skill's declared needs and current persisted execution policy/capability checks. Skill instructions are untrusted content and cannot choose a provider, change system instructions, or widen the tool set.
- Invocation records snapshot the immutable skill revision, idempotency fingerprint, persisted Home conversation/turn link, and only the IDs and revisions of permitted context sources. Task/fact values and assistant output remain in existing Home conversation storage; no extra copy of that sensitive content is stored in invocation metadata.
- A future scheduler must recheck the current skill before dispatch. Disabled or deleted skills leave referenced schedules intact but cause the occurrence to be skipped with a safe `skill_unavailable` reason. Immediate invocations also recheck the current enabled/version state before provider dispatch.
- Invocation is an adapter into the existing Home turn path. The trusted `skillInvocationId` is stored on the Home turn in the same transaction that saves its message and turn, before runtime start; ordinary Home turns keep this field null.
- Workspace hard deletion uses the delivered ownership cascade to remove workspace conversations, turns, invocation metadata, skills, and revision text. No turn marker survives a whole-workspace purge. If a non-null bound turn does survive while its invocation or skill source cannot be resolved, its tools are denied; it is never reinterpreted as ordinary unbound chat. Owner or conversation purge removes turns and invocation metadata as before.

## Implementation Source Map

- `Personal-AI-Workspace/backend/src/modules/home-assistant/use-cases/home-planning-tool-request-handler.ts` maps registered Home tools to the existing closed `AssistantToolCapability` set; skill needs use that set and cannot add tool names.
- `Personal-AI-Workspace/backend/src/modules/home-assistant/use-cases/submit-home-turn.ts` remains the sole dispatch path and includes the immutable invocation binding in the existing Home request fingerprint. It rechecks current skill version/enabled state, context revisions, principal/workspace status, policy, and provider readiness immediately before runtime start.
- `Personal-AI-Workspace/backend/src/modules/home-assistant/use-cases/get-home-turn.ts` resolves the durable turn binding and supplies its immutable revision/capability ceiling to the existing closed tool handler. Normal unbound Home turns retain their existing policy behavior; a claimed skill invocation with a missing or mismatched binding fails closed.
- `Personal-AI-Workspace/backend/src/modules/home-assistant/use-cases/home-planning-tool-request-handler.ts` permits each registered tool only when its capability is declared by the invocation revision and allowed by current persisted policy. It rechecks that the skill remains enabled at the invoked version.
- `Personal-AI-Workspace/backend/src/infrastructure/database/storage-content-accounting.ts` and `storage-content-projections.ts` own logical-byte accounting for retained database content; new skill revision text is added through these existing projections.
- `Personal-AI-Workspace/backend/src/modules/showcases` owns selected-source preview, publication, and public DTO projection. `TypeOrmSkillRepository.findActiveEnabledForShowcase` resolves only the explicit allowlist within the administrator's account-wide or selected-project scope; `showcase_versions.skills` stores the sanitized snapshot. Task 3.5 owns the copy manager and cleanup path; Task 6.2 adds the narrow skill clone projection and storage references there.
- `Personal-AI-Workspace/backend/src/app.ts` owns the authenticated router mount. `Personal-AI-Workspace/backend/openapi.json` owns the skill routes and sanitized showcase skill schemas; the Task 4.3 owner edits only the separate task/archive schema hunk.
- Migration `1710000035000` owns the additive skills, immutable revision, and invocation tables. It follows Task 3.5's reserved `0034` migration.

## Endpoints / Events

All routes are mounted under `/api/v1`, use the existing `{ data, error }` envelope and session principal, and retain the current same-origin/CSRF middleware rules. Mutation requests require same-origin, session, CSRF, and an `Idempotency-Key` where creation or invocation can be retried.

| Method and path | Purpose |
|---|---|
| `GET /skills` | List the caller's active skills, optionally filtered by an owned workspace. |
| `GET /skills/templates` | Read the fixed Plan my day and Daily briefing templates. |
| `POST /skills` | Create a custom skill or copy a named template. |
| `GET /skills/{skillId}` | Read one active caller-owned skill. |
| `PATCH /skills/{skillId}` | Edit title, instructions, workspace association, declared tools, or enabled state using `expectedVersion`. |
| `DELETE /skills/{skillId}` | Soft-delete using `If-Match: "{version}"`; referenced invocation history remains intact. |
| `POST /skills/{skillId}/invocations` | Start an idempotent invocation in an existing owner-scoped Home conversation, binding its immutable revision and capability ceiling to the persisted Home turn before runtime start. |

Showcase publication extends its existing preview/publish operations with an explicit `skillIds` selection. Public showcase reads include only the generated-ID sanitized skill projection. Copy status remains unchanged; the ready private copy receives generated account-owned skill records bound to the cloned workspace.

## Request Shapes

`POST /skills` accepts exactly one of:

```json
{ "title": "My checklist", "instructions": "...", "workspaceId": null, "declaredTools": ["home_task_read"] }
```

or

```json
{ "templateId": "plan-my-day", "workspaceId": "<owned workspace UUID>" }
```

`PATCH /skills/{skillId}` is a non-empty strict partial object containing any of `title`, `instructions`, `workspaceId`, `declaredTools`, and `enabled`, plus required positive integer `expectedVersion`. Every accepted change creates a new immutable revision and increments the version exactly once. Same-value updates return the current revision without incrementing it. Delete uses the quoted `If-Match` current version.

`GET /skills?workspaceId=<uuid>` is owner-scoped; omission lists account-wide and workspace-bound skills. Public template IDs are fixed strings `plan-my-day` and `daily-briefing`.

The invocation request is `{ "conversationId": "<uuid>", "expectedVersion": 4, "request": "..." }`. `conversationId` must resolve to a persisted conversation owned by the session, and a workspace-bound skill must match its persisted workspace scope. The model/runtime never supplies the owner, workspace, policy, provider, or capability set. Invocation idempotency uses the existing `Idempotency-Key` header; exact retry reuses the same invocation and Home turn. The canonical fingerprint covers the normalized request, server skill/revision identity, and context source IDs/revisions. A request key reused with different input returns 409. A bound replay reads the existing Home turn and never starts the runtime a second time.

Showcase source selection may add `skillIds: string[]` alongside existing task/fact/file IDs; omission is treated as an empty allowlist for compatibility. The administrator cannot submit skill content or declared tools in a publication request; the server resolves each selected enabled, non-deleted ID through the persisted skill repository, validates its owner/workspace scope, and snapshots the reviewed immutable revision.

## Response Shapes

Skill response:

```json
{
  "id": "<skill UUID>",
  "workspaceId": null,
  "title": "My checklist",
  "instructions": "...",
  "declaredTools": ["home_task_read"],
  "enabled": true,
  "version": 1,
  "createdAt": "<ISO-8601 UTC>",
  "updatedAt": "<ISO-8601 UTC>"
}
```

Template response is `{ "templates": [{ "id", "title", "instructions", "declaredTools" }] }`. Delete returns `204 No Content`.

An invocation returns `{ "invocation": { "id", "skillId", "skillVersion", "conversationId", "turnId", "contextRevisions", "state" } }`, where `contextRevisions` contains only permitted source IDs and positive revisions; `state` reflects the existing Home turn status. Assistant text is read through existing Home conversation/message APIs.

Public showcase skills contain generated UUID, title, instructions, and declared tool needs only. They omit source owner/skill/workspace IDs, source version IDs, source enabled state, provider configuration, and runtime implementation files. Demo copies receive a new user skill UUID and version-1 editable revision from the reviewed allowlisted fields, associated with the new private target workspace.

## Validation and Error Cases

- Titles are 1–120 Unicode characters; instructions are non-empty and at most 16,000 UTF-8 bytes. Declared tools are unique, drawn only from the five closed Home capability values, and limited to five items. Request schemas reject unknown fields.
- Unknown, foreign-owner, soft-deleted, or unavailable skill/workspace IDs use non-disclosing 404 behavior. Workspace-bound skills require an active workspace owned by the same principal. Archived/removal-pending workspaces cannot be newly bound or invoked.
- Missing or malformed versions return `400 VALIDATION_ERROR`; stale versions return `409 SKILL_VERSION_CONFLICT`. A reused idempotency key with a different normalized request returns `409 IDEMPOTENCY_KEY_REUSED`.
- Skill-creation idempotency keys remain reserved after soft deletion; an exact replay after that skill is deleted returns safe `404 SKILL_NOT_FOUND` and never creates a replacement.
- Disabled/deleted skills cannot be invoked. A disable/delete/edit race before runtime dispatch stops the call before provider transmission. Existing current-principal, provider readiness, policy/capability, credit/quota, and runtime checks remain authoritative.
- Untrusted instructions cannot create or alter policy, provider selection, authenticated owner, workspace scope, or runtime capability. Unsupported declared needs fail closed. No skill can run against another account's context.
- Skill revisions and any retained invocation prompt/result content use the existing account storage accounting boundary. Invocation metadata stores source IDs/revisions only; user request and assistant response use existing Home message storage.
- Showcase IDs must resolve to active skills owned by the publishing administrator and either account-wide or associated with the selected source project. Publication stores an immutable reviewed projection. Public and private-copy DTOs never disclose source identity or policy. A private copy's tools are re-intersected with the demo owner's current policy at run time.
- Downstream scheduled occurrences that reference a disabled/deleted skill are skipped with safe `skill_unavailable`; schedule/history records are retained. No stale snapshot is used as an authorization fallback.

## Versioning / Compatibility Notes

- Migration `1710000035000` is additive. It owns the `skills`, immutable `skill_revisions`, `skill_invocations`, and published showcase skill snapshot column needed for Task 3.4 carry-forward. Its `down` refuses to drop persisted user skills, invocation records, or published skill snapshots.
- Existing Task 3.4 project/task/fact/file publication and copy semantics remain unchanged. Skill publication is opt-in; old showcase versions and demo copies remain valid with an empty skills projection.
- Existing Home request/turn DTOs, provider/runtime APIs, account policy, and usage accounting remain unchanged except for a narrow approved per-turn capability intersection seam. Existing technical `SKILL.md` files remain runtime implementation resources and are never treated as user skill definitions.
- Daily schedule persistence/execution and the user-facing editor remain Task 7.1 and Task 6.3 responsibilities.

## Open Questions

- Architect-approved migration 0035 rule: `skill_invocations` keeps scalar `skill_id`, `skill_revision_id`, and `skill_version`, drops only its two cascading source FKs, and adds a direct `owner_id -> users.id ON DELETE CASCADE` FK while retaining conversation cascade. The Home-turn invocation FK remains nullable/unique with `ON DELETE SET NULL`. Whole-workspace deletion follows the delivered 0027 cascade and removes the workspace conversation, turns, invocation metadata, skills, and revision text together; it does not preserve Home history. Soft deletion and edits retain immutable, storage-accounted revision history, while current-state validation denies further use. If a non-null bound turn survives but its source lookup fails, the tool gate denies it; ordinary turns with a null marker keep existing behavior. Same-key replay after source deletion returns safe unavailable/denied and never creates a replacement claim or redispatches. Invocation metadata remains bounded, content-free operational metadata and is not counted as content bytes; revision text and Home messages/results remain under existing storage accounting.
- Task 3.5 delivered the copy manager and cleanup boundary; Task 6.2 adds the isolated skill projection there. The shared snapshot and private copy include no source owner IDs, source skill IDs, policies, or runtime files.
