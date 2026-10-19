# Contract: Make memory and selected context visibly control future runs

## Change History

- 2026-10-19: Drafted from the Task 6.1 brief/UI spec, release architecture sections 8, 11, 12, frontend/backend source inspection, and delivered Task 4.1 contract `4f9ad9bddf227f53b7c55db237cc4a9a8d716846`. Amended before Home runtime edits to apply the architect's decision that fresh workspace-scoped Home turns also consume current saved facts. This contract records existing API shapes and intended behavior; it is not runtime evidence.

## Ownership

- The Task 6.1 developer owns the project memory and project context UI slices, the existing project chat-context entity hook if needed, `ProjectChatContextUseCases` plus focused tests, and the Home planning-context builder/turn use case plus focused tests and a Home-consumed selected-fact reader port.
- The only permitted shared composition edit is the narrow import/constructor wiring needed to inject that reader into `SubmitHomeTurnUseCase`. Other edits to `backend/src/composition-root.ts`, `backend/src/app.ts`, `backend/src/infrastructure/database/data-source.ts`, `backend/openapi.json`, admission, or migration `1710000033000` remain excluded. Frontend app shell/Home Ask/Home Chat/Dashboard/dialog/sign-in/showcase/demo/routes are excluded.
- No new route, schema, dependency, global settings framework, or provider/policy control is planned. Reuse the persisted project facts and chat context, the existing policy summary, and existing API/error envelopes.

## Scope

- Keep saved facts project-owned. Create, edit, review, and delete use the existing versioned facts API. Show the current source attribution and the current server-selected inclusion state.
- Reuse `project_chat_context.fact_ids` for inclusion. A saved selection applies to later permitted runs for the project; a fresh workspace chat reads the current persisted selection, validates it against active facts owned by the same owner and project, and builds an immutable per-run manifest from the current fact values. Editing, deletion, or exclusion does not rewrite prior conversation text or recall a provider request already issued.
- Allow the facts portion of project context to be read and updated for an active planning-only project because its existing project context row already stores `fact_ids` independently of paths. Planning-only reads return no file paths; file selection and file operations remain unavailable and any path-selection mutation still fails with the existing `PROJECT_ROOT_NOT_ATTACHED` behavior.
- For a fresh Home turn whose persisted `HomeConversation.scope` is `{ kind: "workspace", workspaceId }`, resolve the saved context and selected active facts by the authenticated owner and that persisted workspace/project ID only when the current stored workspace policy includes the existing `project_facts` category. Add only bounded, redacted fact title/content to that turn's prompt. Home-scope conversations remain memory-free, and browser route/current workspace state is never used to resolve context. The Home reader returns fact data only and performs no file reads or file/command operations. Keep the existing Home and exact workspace policy-revision checks and fail-closed runtime behavior before provider dispatch.
- Show the existing read-only assistant policy/provider/storage summary in both Project Context settings and the reachable project Memory page. The Memory page is available to planning-only workspaces without file access, so those users can see the same disclosure and control saved fact selection. It remains descriptive; it does not grant authorization or promise a later run will succeed. Do not add account-wide settings; Task 6.4 owns account usage/settings scope.
- Reconcile a failed/uncertain context PATCH by reloading the existing GET resource. Keep an unsaved local draft distinct from the confirmed saved selection. The current context API has no version/ETag or optimistic conflict response; do not invent one or claim a prior selection remains active unless GET confirms it.
- The architect approved a narrow Home runtime integration: fresh workspace-scoped Home turns read selected facts through an internal port and include them in the existing prompt. Home-scope turns remain memory-free. No durable Home context manifest or request/response field is added.

## Endpoints / Events

All paths below are mounted under `/api/v1`. No API is added.

| Method and path | Existing purpose and Task 6.1 use |
|---|---|
| `GET /projects/:projectId/facts` | Read active facts for the authenticated owner and project. |
| `POST /projects/:projectId/facts` | Create a fact; same-origin, authenticated session, and CSRF required. |
| `PATCH /projects/:projectId/facts/:factId` | Edit fact title/content using required `expectedVersion`; same-origin, session, CSRF required. |
| `POST /projects/:projectId/facts/:factId/verification` | Mark a fact reviewed using required `expectedVersion`; same-origin, session, CSRF required. |
| `DELETE /projects/:projectId/facts/:factId` | Delete with required quoted `If-Match` version; same-origin, session, CSRF required; returns 204. |
| `GET /projects/:projectId/chat-context` | Read saved project context. Authenticated session required; GET has no CSRF requirement. |
| `PATCH /projects/:projectId/chat-context` | Partially update saved context. Same-origin, authenticated session, and CSRF required. |
| `POST /projects/:projectId/chat-runs` | Existing fresh workspace-chat submission. Requires the existing idempotency key and body; `SendChatMessageUseCase` reads current persisted context and passes only currently active same-owner/project facts into the run snapshot. |
| `GET /assistant/execution-policy?scope=workspace&projectId=<uuid>` | Existing read-only policy/readiness and operator storage/provider disclosure used by Context settings. No CSRF required. |

## Request Shapes

Project facts keep their existing strict request shapes:

```json
{ "title": "Preferred language", "content": "Use English." }
```

`PATCH /projects/:projectId/facts/:factId` additionally requires `expectedVersion: number` as a positive safe integer. Review uses `{ "expectedVersion": number }`. Fact deletion requires `If-Match: "<positive-version>"` and an empty body.

`PATCH /projects/:projectId/chat-context` accepts only the existing optional fields; omitted fields remain unchanged:

```json
{
  "relativePaths": ["docs/plan.md"],
  "excludedPaths": [".env"],
  "factIds": ["<uuid>"],
  "includeProjectConversations": true
}
```

The context endpoint has no version, ETag, merge token, or idempotency key. The existing workspace chat body is `{ "conversationId": "<uuid>", "request": "..." }` with its required `Idempotency-Key`; clients do not submit an alternate fact list for that chat path. The policy read query is exactly `scope=workspace&projectId=<uuid>`. Home turn requests keep their existing DTO. The Home runtime's internal selected-fact reader receives the authenticated `ownerId` and `workspaceId` from the persisted conversation scope, and returns current selected active facts as `{ id, version, title, content }` for that exact owner/project. The prompt receives only bounded, redacted title/content; IDs and versions remain in the in-memory pre-dispatch validation snapshot.

## Response Shapes

The API uses the existing `{ data, error }` envelope. Fact list data is `{ "facts": ProjectFact[] }`; fact mutation data is `{ "fact": ProjectFact }`; delete returns 204. A project fact has `id`, `projectId`, `title`, `content`, `source: { kind, label, reference }`, `version`, `verifiedAt`, `verificationStatus`, `createdAt`, and `updatedAt`.

Chat-context data uses the existing `ProjectChatContext` shape:

```json
{
  "relativePaths": ["docs/plan.md"],
  "factIds": ["<uuid>"],
  "includeProjectConversations": true,
  "excludedPaths": [],
  "availablePaths": ["docs/plan.md"],
  "fileSelectionLimited": false
}
```

For a planning-only project, `relativePaths`, `availablePaths`, and `excludedPaths` are empty and `fileSelectionLimited` is false; `factIds` contains only current active facts owned by that project, and `includeProjectConversations` retains its persisted value. No host/file path is revealed. The policy read result keeps the exact existing `AssistantExecutionPolicyStatus` DTO from Task 4.1; this task adds no fact-title items or policy fields.

Fresh workspace chat continues to return the existing `{ data: { run, manifest }, error: null }` response. The persisted run manifest snapshots provider/model, selected fact snapshots, selected files, bounded recent messages, and hashes before runtime dispatch. Provider egress rechecks fact snapshots; a changed/deleted fact prevents stale source use. Home turn responses and persistence shapes do not change; the Home prompt includes only current selected fact title/content when the persisted conversation is workspace-scoped. The existing read-only policy summary is available from both Context settings and the project Memory page, including planning-only workspaces.

## Validation and Error Cases

- The trusted session determines `ownerId`; project/fact queries remain owner-and-project scoped. Missing or foreign facts/projects use existing non-disclosing not-found errors.
- Fact title is 1–120 characters, content is 1–4096 UTF-8 bytes, and both reject credential-like text. Fact selection accepts at most 25 distinct valid UUIDs through existing domain validation. Selected facts must still be active and belong to the same owner/project.
- File selection retains current relative-path allowlists, project-root checks, automatic exclusions, limits, and storage boundary checks. A planning-only project can update `factIds` and `includeProjectConversations`; explicit `relativePaths` or `excludedPaths` still requires a file root and returns the existing `409 PROJECT_ROOT_NOT_ATTACHED` error.
- Fact update/review/delete stale versions return existing `409 PROJECT_FACT_VERSION_CONFLICT`. Missing/deleted selected fact IDs return existing `404 PROJECT_FACT_NOT_FOUND`; GET filters deleted facts out so new runs cannot include them.
- Invalid DTOs return the existing `400 VALIDATION_ERROR`; unauthenticated requests return `401 SESSION_UNAUTHENTICATED`; mutations keep same-origin and CSRF checks; archived projects remain read-only under existing fact/context behavior.
- The context PATCH has no stale-version `409`. After any failed/unknown PATCH response, the UI attempts GET reconciliation. It distinguishes confirmed saved state, a returned latest selection plus retained draft, and an unconfirmed outcome when GET also fails. It never labels the draft saved or claims the old state remains active without a successful GET.
- Planning-context fact loading uses the persisted Home conversation scope, existing project context selection, and active fact lookup constrained by the same owner/project. The stored workspace policy must include `project_facts`; otherwise the reader is not called and no selected facts enter the prompt. No browser-provided workspace ID is added to the request. Global Home turns do not call the reader. If context/fact loading fails or the selected fact IDs, versions, or values change before runtime dispatch, the existing fail-closed Home context-unavailable result is retained and the provider is not started.
- Selected fact values are constrained by existing CRUD limits (at most 25 selected facts, title at most 120 characters, content at most 4096 UTF-8 bytes) and are redacted before prompt inclusion. The existing overall Home prompt byte ceiling remains in force; oversized or invalid memory context fails closed without truncating selected facts.
- The Home fact ID/version/value snapshot is kept with the one-shot prompt during the turn and revalidated immediately before runtime start. Home does not persist a durable context manifest; this task adds no turn fields or audit-history schema.
- No past message or already-issued provider request is rewritten or described as erased. No foreign fact, prompt body, provider credential, or host path is exposed in status/error copy.

## Versioning / Compatibility Notes

- Keep all current API paths, request/response fields, status codes, response envelopes, CSRF behavior, source attribution, and migrations. `project_chat_context` already stores `fact_ids`; no schema migration is required.
- The current context PATCH is partial and last-write-wins, without optimistic versioning. This task does not add a version field or merge behavior. UI reconciliation uses the existing GET endpoint after uncertain outcomes.
- Current workspace chat uses persisted server context at submission, so changing a saved selection affects later runs only. A run already created retains its immutable manifest. Fresh workspace-scoped Home turns read the current selection when building their prompt; an already issued provider request is not rewritten.
- OpenAPI fields, Home request/response DTOs, and database schema do not change. The Home selected-fact reader is an internal port and the only composition change is its narrow injection into `SubmitHomeTurnUseCase`.

## Open Questions

1. None. Verification must demonstrate that a fresh workspace-scoped Home turn receives permitted selected facts and that Home-scope turns remain memory-free.
