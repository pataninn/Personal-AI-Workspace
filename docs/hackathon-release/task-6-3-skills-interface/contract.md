# Contract: Task 6.3 — Expose editable skills and a working Plan my day flow

## Change History

- 2026-10-19: Initial full-stack contract based on the Task 6.3 UI spec, architecture preflight, and delivered Task 6.2 API.

## Ownership

- The authenticated session is the only source of owner identity. Skills, Home conversations, workspace access, policy, and quota remain enforced by their existing backend modules.
- Task 6.3 owns the private Skills library/editor/run UI, the Home turn summary read projection, and the publisher/public skill-card UI. Existing Task 6.2 owns skill CRUD/invocation and the server-resolved showcase allowlist. Task 7.1 owns automation fences/scheduler work; its Home submission, turn-read, and managed-workspace predicate hunks remain intact.
- No new persistence table, migration, dependency, provider path, Home capability, or credit accounting is introduced.

## Scope

- Add a project-section Skills page for workspace-visible and account-wide owned skills, server templates, skill detail, blank/template copy, edit, enable/disable, and delete.
- Run an enabled saved skill by creating one owner-scoped workspace Home conversation and invoking the existing skill endpoint with the returned conversation id. Open the saved result through `/projects/{workspaceId}/planning-chat?conversation={conversationId}`. Managed/file-backed workspaces use this route only when it has a conversation query; their ordinary project-chat route remains unchanged.
- Add an optional read-only `skillRun` summary to the existing owner-scoped Home turn list and single-turn responses. Include immutable skill title/version, invocation state, and captured source kind/revision. A source label is returned only when its exact captured revision still resolves; otherwise its label is null and the UI says “Source unavailable.” Never substitute current content for an old source revision.
- Extend the existing publisher skill allowlist UI and sanitized preview display. Public showcase skill cards contain only generated public id, title, instructions, and declared tool needs, with no actions or source identity.
- Keep CRUD/editor available when AI availability is exhausted. Run fails closed for unknown/unavailable execution policy/runtime or unknown/exhausted account AI availability. Existing policy, quota, and invocation checks are authoritative.

## Endpoints / Events

All routes use the existing `/api/v1` session authentication, response envelope, same-origin, and CSRF conventions. Existing Task 6.2 skill endpoints are reused:

| Method and path | Use |
|---|---|
| `GET /skills?workspaceId={id}` | Load caller-owned active skills visible to the selected workspace, including account-wide skills. |
| `GET /skills/templates` | Read server-owned templates. |
| `POST /skills` | Create a custom skill or copy a template using `Idempotency-Key`. |
| `GET /skills/{skillId}` | Read one caller-owned skill. |
| `PATCH /skills/{skillId}` | Save a partial edit with required `expectedVersion`. |
| `DELETE /skills/{skillId}` | Soft-delete with `If-Match: "{version}"`. |
| `POST /skills/{skillId}/invocations` | Start/replay an invocation against an existing workspace Home conversation using `Idempotency-Key`. |
| `POST /home/conversations` | Create one workspace-scoped Home conversation before invoking. |
| `GET /home/conversations/{conversationId}/turns` | Existing owner-scoped turn list, extended with optional `skillRun`. |
| `GET /home/conversations/{conversationId}/turns/{turnId}` | Existing owner-scoped turn read, extended with optional `skillRun`. |
| Existing showcase preview/public read | Return the already server-resolved sanitized skill projection selected by `skillIds`; frontend DTOs and views expose it. |

No new run-result endpoint or per-run usage endpoint is added. Aggregate credit details link to the existing Account Usage view.

## Request Shapes

Create a custom skill:

```json
{ "title": "My checklist", "instructions": "...", "workspaceId": null, "declaredTools": ["home_task_read"] }
```

Copy a template:

```json
{ "templateId": "plan-my-day", "workspaceId": "<owned workspace UUID>" }
```

Edit a skill with a strict non-empty partial object and optimistic concurrency:

```json
{ "expectedVersion": 2, "enabled": true }
```

Invoke a skill:

```json
{ "conversationId": "<owned workspace Home conversation UUID>", "expectedVersion": 2, "request": "Create today's plan." }
```

The client sends only the existing server-defined fields and selected IDs. It does not send owner identity, policy, provider, capability authority, public skill text, or context revisions. Invocation retries reuse the original idempotency key and request; uncertain outcomes are checked/retried through the existing invocation/Home state, never silently submitted as a new run.

The publisher submits the explicit `skillIds` allowlist with its existing selection. Skill text and declared tools are resolved by the server and are not accepted as publication authority.

## Response Shapes

Existing skill response:

```json
{
  "id": "<skill UUID>", "workspaceId": null, "title": "My checklist",
  "instructions": "...", "declaredTools": ["home_task_read"], "enabled": true,
  "version": 2, "createdAt": "<ISO-8601 UTC>", "updatedAt": "<ISO-8601 UTC>"
}
```

Existing invocation response includes invocation id, skill id/version, conversation id, turn id, captured `contextRevisions`, and persisted state. Home message/turn reads remain the authority for the saved assistant result and status.

An ordinary Home turn omits `skillRun`. A skill-bound turn may include:

```json
{
  "skillRun": {
    "title": "Plan my day",
    "skillVersion": 1,
    "state": "accepted",
    "sources": [
      { "kind": "home_message", "revision": 3, "label": "Home conversation context" },
      { "kind": "project_fact", "revision": 5, "label": null }
    ]
  }
}
```

`skillRun` contains no source ids, source content, owner ids, provider/model data, or per-run credit claims. Only an exact source revision may receive a label. Null or missing labels render as “Source unavailable.” Public showcase projections contain only generated public IDs, reviewed titles/instructions, and declared tool needs.

## Validation and Error Cases

- Existing Task 6.2 validation remains authoritative: title 1–120 characters; instructions non-empty and at most 16,000 UTF-8 bytes; declared tools are unique members of the closed five-tool set; unknown request fields are rejected.
- Use the server's existing non-disclosing `404 SKILL_NOT_FOUND` and workspace-unavailable responses for missing, foreign, deleted, inactive, or mismatched resources. Workspace targets must be active and owned by the caller.
- `400 VALIDATION_ERROR` covers malformed inputs; `409 SKILL_VERSION_CONFLICT` preserves the user's editor draft; `409 SKILL_IDEMPOTENCY_KEY_REUSED` means the key was reused with different input; delete requires a valid version and uses the existing missing/stale-version behavior.
- Storage, network, and conflict errors preserve all draft fields. A conflict requires an explicit “Keep my draft” or “Reload latest” choice.
- Disabled skills, stale versions, policy-denied declared tools, unknown/unavailable provider/runtime status, unknown/exhausted AI availability, and expired sessions remain blocked by existing server checks. UI state never substitutes guessed readiness or balances.
- Invocation source labels resolve only the persisted captured revision under the same owner and conversation/workspace. Changed, deleted, or inaccessible sources have no label; current content is never presented as historical context.
- Showcase selection is an explicit allowlist of enabled, non-deleted caller-owned skills within the source workspace or account-wide. Server validation and immutable sanitized publication remain unchanged.

## Versioning / Compatibility Notes

- No database migration or schema change is required. The invocation already persists immutable skill title/version and context source IDs/revisions, and the Home turn already binds its invocation id.
- The Home response extension is optional and additive. Existing Home turns omit `skillRun`; existing consumers continue to read the same turn fields.
- Existing skill endpoints, Home runtime/capability boundary, policy checks, credit accounting, showcase publication endpoint, and ordinary project chat remain compatible.
- Public showcase cards are read-only. The frontend preview DTO adds the server's existing sanitized skill values without changing the `skillIds` request contract.

## Open Questions

- None. Managed workspace support, immutable source-label behavior, publisher preview source, and Home response projection are resolved by `architecture-preflight.md`.
