# Contract: Stored tool policy and workspace-scoped automatic execution

**Status:** Contract decision closed; implementation authorized by root after Task 3.3 delivery at `3f4adabbe22a8303406cea9e4441b3e987f605d3`.

## Change History

- 2026-10-19: GPT-6.1 Sol primary took over existing work; all earlier application slices are returned. Added the agreed private bounded-command bridge and held-result acknowledgment contract.

- 2026-10-19: Drafted from release architecture sections 5.1, 5.2, 7.1, 7.2, 10, and 12; Task 4.1 brief; completed UI spec; and Task 3.1/3.2 contracts. This gate contains source inspection only; it does not claim runtime, browser, provider, database, or implementation evidence.
- 2026-10-19: Updated with architect's fixed `assistant_scope_policies` row, provider fill-only-null lifecycle, current-revision rechecks, and `409 POLICY_ACTION_RETIRED` legacy transition. No application code or tests were changed.
- 2026-10-19: Aligned the read-route DTO with the implemented `AssistantExecutionPolicyStatus` response. The primary developer owns integration into existing chat surfaces; `developer_luna` owns the new read-only frontend entity API and summary component/spec only.
- 2026-10-19: Implementation is underway. The primary developer owns the full backend policy/runtime transition, shared wiring, workspace chat UI, and integration; `developer_luna` returned the Home backend and Home UI source slices after focused checks, and is completing only the five Home preview E2E callers/fixtures. The read-only policy entity/summary slice is also back with the primary for chat mounts and integration.

- 2026-10-19: QA repair completed. The OpenAPI document and three focused specs now expose 409 POLICY_ACTION_RETIRED with no 2xx decision response for every retired consent, proposal mutation/acceptance/execution, egress, change-set, and command write. The active shared policy summary also documents operator-managed storage, conditional selected-context transmission, and verified provider terms without adding an approval step.

## Ownership

- The owner is always the active principal from the authenticated session. No route accepts an owner/account ID as authority. Every resource and capability is checked against the persisted owner, current account status/expiry, and current workspace state at the use-case boundary.
- A Home policy is account-scoped. A workspace policy is scoped to the active project/workspace and owner. An admin role does not grant access to another owner's workspace or files.
- Existing `project_chat_contexts` remains the authority for project-selected and excluded context. Its selected files/facts/messages are revalidated and snapshotted into the run manifest at execution time. A status response is descriptive and is never a bearer capability or authorization token.
- Task 3.1 remains the authority for paid provider admission. Every actual provider attempt/retry requires its own durable pre-send reservation and configured hard input/output bounds. An unsupported or uninstrumented provider runtime remains unavailable even when policy permits that provider.
- Task 3.2 remains the authority for logical storage quota, accounting readiness, trusted roots, file promotion, recovery copies, and database content writes. Positive content growth must be admitted at the persistence boundary; verified nonpositive changes keep the Task 3.2 over-limit behavior.
- Task 2.2 remains the authority for managed/legacy file roots and `fileAccess`. A planning-only workspace can keep planning capabilities without file capabilities. No caller-supplied path, arbitrary host root, or fallback root is introduced.
- Task 4.2 owns direct typed Home task/workspace action execution through canonical use cases. Task 4.1 must not implement a second mutation path or label automatic work as user-accepted. Task 4.1 may remove the routine proposal-acceptance branch only when the action is already executable through an authorized canonical path; otherwise it must remain safely blocked until Task 4.2.
- The primary developer owns the complete Task 4.1 application scope, migration 1710000032000, shared wiring, Home/workspace integration, frontend, tests and source-isolation evidence. Earlier helper application slices have all returned. The separate bridge developer completed and returned its four Python files plus new policy tests. The browser evidence collector owns only build/server and artifacts during explicitly assigned windows, with no source writes. Protected original work remains excluded except the exact approved hook line below.
- Task 4.1 implementation files include migration `1710000032000` and registration; policy domain/port/use-case/controller/repository code and specs; `backend/openapi.json`; Home/workspace runtime and route integration; workspace/Home chat surfaces; task-scoped browser fixtures/specs; and evidence/docs. The primary's source manifest is recorded in `dev-summary.md` after the browser handoff and self-review.
- Scope creation is part of this implementation: migration backfills eligible existing account Home and owned project scopes; same-transaction database insert triggers create the matching fixed profile for new accounts and projects, including demo and future clone paths. Missing rows on established scopes remain unavailable; neither GET nor dispatch lazily creates one. Retries must not replace provider/model values or re-enable revoked rows.
- A trusted startup configuration synchronizer updates the singleton deployment provider setting and may fill only a null provider/model pair on an enabled, unrevoked policy, incrementing its revision. New scope triggers copy only that exact deployment setting. It never overwrites a non-null pair or re-enables a revoked row; later changes to an established policy require a separate trusted policy revision. No public chat, model tool, or client request can edit policy. Revocation is sticky: set `enabled=false`, record `revoked_at`, and increment the revision. No user-facing revocation route/editor is introduced here; its UI owner remains unassigned. Existing project-context controls and persisted account disable/expiry remain effective immediately.
- The six original protected working-tree changes remain preserved and excluded. Root authorized exactly three Task 4.1 lines across two protected files: use-direct-chat.ts clears the unchanged draft for policy_authorized alongside approved; AiRunTimeline.spec.tsx changes its ready fixture to policy_authorized and the matching starting copy. Both full originals were privately snapshotted as applicable; all original reliability and StrictMode hunks remain byte-preserved. Intended-source and later cached staging apply these three lines to HEAD, never the full working-tree files. Other protected paths and ponytail-review.md remain unrelated and unstaged.

## Scope

Task 4.1 removes repeated approval as the authorization mechanism for already in-scope Home and workspace work. A single user submit may progress through multiple authenticated server calls/events, but it must not require an approval click between provider inference, a permitted bounded tool, and a verified result. The server evaluates the effective stored policy and all live security/accounting gates; hiding a control in the client is not authorization.

The effective-policy model separates two concepts:

1. **Stored policy:** scope, configured provider/model, permitted information sources, fixed tool capabilities and destinations, plus the selected/excluded project context from the existing context resource. The user cannot change provider/tool policy through a chat message or a model tool call. Task 4.1 adds no policy editor or admin route.
2. **Runtime readiness:** current provider configuration and instrumentation, credit admission, principal/workspace availability, storage-accounting readiness, file access, sandbox readiness, and verified egress. Readiness is evaluated separately and may be unavailable while stored policy remains valid. A policy grant can never make a runtime ready.

The durable table is `assistant_scope_policies`, with exactly one row per `(owner_id, scope_kind, project_id)` and scope constraints: Home rows use `scope_kind='home'` and null `project_id`; workspace rows use `scope_kind='project'` and a project owned by that same owner. The bounded row contains a UUID, owner UUID, scope kind, nullable project UUID, a fixed versioned policy profile (`home_in_scope_v1` or `workspace_in_scope_v1`), nullable configured `provider_profile` and `model` as a pair (both null or both non-null), `enabled`, nullable `revoked_at`, positive monotonic `revision`, and timestamps. The fixed policy profile maps in code to closed context-category and tool-capability enums. These categories/capabilities are not caller-editable or persisted as a free-form list. The row contains no JSON policy DSL, wildcard, endpoint, path, network destination URL, prompt, secret, or caller-controlled value.

Backfill creates a row for each eligible existing account Home scope and owned project scope. `AFTER INSERT` triggers create `home_in_scope_v1` and `workspace_in_scope_v1` rows inside trusted user/project creation transactions. The migration-owned singleton deployment provider setting starts as a null pair; trusted startup configuration may set that exact pair and fill only enabled, unrevoked rows whose pair remains null, incrementing the revision. Later project/account triggers copy the current singleton pair. A missing policy row on an established scope is `policy_unavailable` and cannot self-seed at a GET or dispatch boundary. Missing provider configuration remains null and readiness `unavailable`; it is never filled with an inferred model. A trusted sync must not overwrite a non-null pair or re-enable a revoked row. A provider/model change for an existing policy later requires an explicit trusted policy revision. Task 3.1 independently decides whether that configured runtime may send.

The fixed `home_in_scope_v1` and `workspace_in_scope_v1` profiles map in code to closed context categories (`current_message`, `bounded_home_history`, `task_metadata`, `workspace_metadata`, `request`, `recent_conversation`, `project_files`, `project_facts`) and closed tool capabilities (`home_task_read`, `home_task_write`, `home_workspace_read`, `home_workspace_write`, `home_action_undo`, `workspace_file_read`, `workspace_file_write`, `bounded_sandbox_command`). Each profile defines its own allowed subset; incompatible scope/category/capability combinations fail closed. These capabilities represent only fixed server handlers; static runtime/command allowlists remain an independent intersection. The existing workspace file-change pipeline may apply a supported proposal only under a current `workspace_file_write` policy, preserving hash/version, quota, backup and recovery checks; it persists `change_set_decision='policy_authorized'` and never creates a synthetic user approval. Bulk Home proposal execution has no capability and remains blocked until a canonical automatic handler exists.

The effective policy is bounded to the current Home/account or owned workspace. It cannot grant access to another account/workspace, excluded/protected paths, host paths, application secrets, admin actions, policy/identity/limit management, arbitrary internet destinations, publishing, or remote side effects. Destinations are fixed by the server: selected context may go to the exact configured provider, and approved file operations may target only the currently owned trusted project root. Task 4.1 introduces no destination configuration. For Home conversation scope `home`, use the owner's Home row. A Home turn targeting a workspace must satisfy both that account's Home policy and the exact owned project policy, intersecting their allowed capabilities; derive the target project from an owner-scoped persisted resource and recheck it at each tool dispatch. A direct workspace turn uses its exact owned project row. A missing/mismatched scope row never widens access.

Workspace content inputs are the exact current request, bounded conversation history, current saved selected relative files/facts, and any additional categories explicitly declared by the server. Exclusions win over every inclusion source. Selected files are resolved only within the trusted owner/project root and are hash-bound in the run manifest. Home input categories are similarly bounded and server-declared. Never infer inclusion from UI selection alone.

Automatic mutation preserves current canonical safeguards: active-principal and owner/workspace checks before dispatch and durable output; Task 3.1 reservation before every provider attempt; Task 3.2 accounting before persistent writes; bounded/redacted tool inputs and outputs; fixed command allowlist and sandbox limits; no network expansion; current file/message/fact hashes and optimistic versions; backup/recovery creation and verification before promotion; stable idempotency keys; safe cancellation/reconciliation; and truthful partial/unknown states. A stale hash/version, denied quota, unready accounting, unsupported command, forbidden destination, missing backup, or unknown prior outcome must not fall back to manual approval as a way around policy.

## Endpoints / Events

### Proposed read-only effective-policy/readiness route

Add `GET /api/v1/assistant/execution-policy` for the current authenticated principal. This read endpoint supplies the Home/workspace entry summary; it is not a grant, reservation, or durable authorization. It uses the existing `{ data, error }` envelope and session authentication. As a GET, it does not require CSRF. The Task 4.1 developer owns the thin route and its `app.ts`/composition-root DI integration.

The strict query selects exactly one scope:

- `?scope=home` with no `projectId`; the returned scope is the authenticated account's Home.
- `?scope=workspace&projectId=<uuid>`; the project must exist, be visible to the authenticated owner, and not be archived. Missing and foreign projects use the existing non-disclosing not-found response.

No owner, provider, model, path, tool, destination, readiness override, or account-kind query parameter is accepted. Invalid scope combinations or malformed UUIDs return the existing `400 VALIDATION_ERROR` envelope.

### Existing execution routes transition to automatic policy evaluation

No caller-supplied policy DTO is added to an execution request. The server obtains the current policy and persisted context, builds the exact per-execution snapshot, and re-evaluates current gates at each dispatch and write. Existing write requests retain same-origin + authenticated-session + CSRF requirements and existing idempotency/version/hash protections.

- Home submission remains `POST /api/v1/home/conversations/:conversationId/turns`, with `{ "message": string }` and required `Idempotency-Key`. A new turn evaluates current Home/workspace scope and policy, persists an execution snapshot/status, and starts automatically only when all necessary capabilities/readiness gates pass. Replaying the key returns the same turn/run state and never creates a second provider attempt or mutation. It does not create a per-turn consent decision.
- Workspace chat remains `POST /api/v1/projects/:projectId/chat-runs`, with `{ "conversationId": uuid, "request": string }` and required `Idempotency-Key`. It reads saved project context and returns the canonical run/manifest snapshot. The normal automatic path must no longer depend on a remembered-permission UI decision; it must preserve a server-side manifest/hash, staging checks, credit admission and idempotent start. The client makes one user submission and then observes/reconciles that same run.
- Existing `GET /projects/:projectId/chat-context` and CSRF-protected `PATCH` remain the project context selection surface. Strict PATCH fields remain `relativePaths`, `excludedPaths`, `factIds`, and `includeProjectConversations`; owner/project validation, path/fact validation, excluded-path precedence, and per-run re-resolution remain mandatory.
- Existing run status/activity, Home turn/events, cancellation, and result/history reads remain owner-scoped. Existing change/command status endpoints remain read-only views. Existing file/task/workspace mutation routes continue to use their canonical use cases and Task 3.2 accounting.
- Every legacy mutating consent, proposal, workspace egress, change-set, and sandbox-command decision/acceptance endpoint returns `409 POLICY_ACTION_RETIRED` for every decision value, including deny/reject. This includes `POST /home/conversations/:conversationId/turns/:turnId/consent-decisions`, proposal `PATCH|DELETE .../items/:itemId` and `POST .../acceptance|execution`, `POST /ai-runs/:runId/egress-decision`, `POST /ai-runs/:runId/proposed-change-set/decision`, and `POST /ai-runs/:runId/commands/:commandId/decision` (all under `/api/v1`). This response makes no database transition and causes no provider send, runtime/tool continuation, or canonical mutation. Keep authenticated cancellation routes and owner-scoped GET/history/status reads; do not auto-resume a pending or previously approved legacy record. Proposal GET and explicit cancellation remain.
- No endpoint in chat accepts policy updates or a request to broaden provider, context, tool, network, or destination access.

### Event transition rules

- New automatic Home executions do not emit `consent.requested` or `consent.decided`. They use the existing turn lifecycle, safe progress, and `action.receipt` events. If an additive blocked event is needed, its public payload is restricted to a safe reason enum, an opaque resource ID where already authorized, and `noChangeConfirmed`; it never carries prompt/tool arguments, paths, credentials, or foreign-resource existence.
- Workspace runtime status and result events remain server-projected from the current persisted run. `approval.required` must not be treated as proof of authorization. An out-of-policy or unsupported command yields a blocked safe result without an approval continuation. `tool.proposed`/change preview may remain informational only where the existing automatic pipeline can safely complete or the capability is explicitly blocked.
- Existing consent/proposal/command events and rows remain readable for compatibility and audit. They do not authorize new dispatches merely because an old record says approved or accepted.

### Response DTO for the proposed read route

The route returns no database owner ID, host path, mount name, provider endpoint, secret, token, raw prompt, full transcript, protected-path list, or foreign resource information.

```json
{
  "data": {
    "scope": { "kind": "workspace", "label": "Roadmap" },
    "policy": {
      "enabled": true,
      "revision": "<positive decimal revision>",
      "provider": { "name": "NVIDIA hosted NIM", "model": "<exact configured model>" },
      "included": { "categories": ["request", "project_files"], "items": [{ "kind": "file", "name": "docs/plan.md" }] },
      "exclusionsEnforced": true,
      "capabilities": ["workspace_file_read", "workspace_file_write"]
    },
    "fileAccess": true,
    "readiness": { "state": "unavailable", "reasonCode": "runtime_unverified" }
  },
  "error": null
}
```

The data object matches `AssistantExecutionPolicyStatus`: `scope.kind` is `home|workspace`; Home has no workspace ID and uses the generic label `Home`. When present, `policy.revision` is a positive decimal string so database integer precision is exact. The provider shows only its server display name and exact configured model; provider profile and endpoint are omitted. If the provider pair is unconfigured or uses an unrecognized profile, `provider` is `null`. If no policy row exists, `policy` is `null` and readiness is unavailable with `policy_unavailable`; it is never created by this GET. `included.categories` is the versioned profile's closed set for that scope. `included.items` contains only server-confirmed selected project-relative file names and may be empty. `capabilities` is a closed enum set, not an authorization claim; `fileAccess` is a separate top-level boolean reflecting Task 2.2. Destinations are fixed by server implementation and are not returned as caller-selectable values. Readiness uses only the implemented safe statuses:

```json
{ "state": "unavailable", "reasonCode": "runtime_unverified" }
```

The exact response union is `ready`, `blocked` with `policy_revoked`, or `unavailable` with `policy_unavailable`, `provider_unconfigured`, or `runtime_unverified`. The server never returns an exception, host path, endpoint, credential, or account detail. An unavailable runtime is an HTTP 200 effective-state response for this read route, not a fabricated server error or a ready state. Specifically, the current direct provider has no proven input bound, and paid Home Hermes remains disabled while `providerEgressAdmissionEnforced` is false; neither can be advertised paid-ready. Dispatch still runs current checks after this response.

## Request Shapes

### `GET /api/v1/assistant/execution-policy`

No body. Query is exactly one of:

```text
scope=home
scope=workspace&projectId=<canonical UUID>
```

Unexpected, repeated, or conflicting query parameters are rejected. The owner always comes from the trusted session.

### Existing execution writes

Home turn body remains `{ "message": "..." }`; workspace chat body remains `{ "conversationId": "<uuid>", "request": "..." }`. Both require bounded input validation and a stable `Idempotency-Key`. No browser/model-supplied `ownerId`, policy revision grant, provider/model override, selected context override that exceeds persisted selection, command approval, shell, root, path, or destination is accepted by the automatic chat path. Explicit context APIs retain their existing project-relative allowlist and validation contract.

Any policy/readiness revision returned by the GET route is a display snapshot only. The client does not POST it as authority. The server binds the policy/context revision and manifest hash to the persisted run/turn and checks it again before each provider/tool dispatch and before mutation. An in-flight external call admitted before revocation cannot be recalled; revocation committed before the next guard suppresses later provider/tool dispatch and durable output/promotion. No account-row lock is held over provider inference. Every later provider attempt, tool, or durable write rechecks current policy and principal state.

## Response Shapes

- Successful policy reads use `{ "data": { "scope": ..., "policy": ..., "fileAccess": ..., "readiness": ... }, "error": null }` with HTTP 200, including when readiness is unavailable.
- New automatic Home submissions retain the current `{ data: { turn, message, execution?, disclosure?, replayed }, error: null }` envelope but use `running`, `unsupported`, or `unknown` with a safe reason code instead of `consent_required`. No new turn includes a pending consent disclosure. Any known-not-sent/provider-unavailable state distinguishes saved transcript from provider delivery.
- Workspace submissions retain `{ data: { run, manifest }, error: null }` and existing 202/200 idempotent replay semantics. The authoritative run status communicates blocked, queued/running, succeeded, failed, cancelled, or review-required/unknown. No client-reported approval is included in the run result.
- Any additive public event carries only safe status/reason/receipt data. Actual actor/source is `assistant` (or the trusted runtime source), never `accepted_by_user` for an automatic action.

- The active Home and workspace policy summaries keep a nonblocking disclosure visible: “Workspace data is stored on the operator-managed deployment.” For a configured provider they state that selected context is sent to that named provider for processing when submitted; runtime-unavailable copy says no provider request is sent now and describes transmission conditionally. Only the exact server-owned labels Nebius Token Factory and NVIDIA hosted NIM link to verified terms. Missing or unknown providers receive no inferred terms link. No claim is made that the application stores nothing or sends no other request.

## Validation and Error Cases

| HTTP / code | Contract behavior |
| --- | --- |
| `400 VALIDATION_ERROR` | Invalid scope/query, malformed UUID, extra body property, invalid key, message, context, or resource version. Strict schemas reject unknown fields. |
| `401 SESSION_UNAUTHENTICATED` | Missing/invalid session. No policy or resource details returned. |
| `403 ORIGIN_FORBIDDEN` / `CSRF_INVALID` | Existing same-origin and CSRF protection remains on every state-changing POST/PATCH/DELETE; read-only policy GET uses authentication only. |
| `404` existing non-disclosing not-found | Missing, foreign, archived, or otherwise unavailable owner-scoped project/conversation/run/resource. Do not reveal foreign existence. |
| `409` existing run/resource/idempotency conflict; additive `EXECUTION_POLICY_CHANGED` only if needed | Stale run manifest, file/fact/message hashes, versions, reused idempotency key with a different fingerprint, or policy snapshot conflict. Refresh/reconcile the same execution; do not silently create a replacement. |
| `409 POLICY_ACTION_RETIRED` | Any legacy decision or acceptance request on a consent, proposal, run egress, change-set, or sandbox-command endpoint, for every decision value including `allow`, `deny`, `approve`, `reject`, `accept`, and `execute`. The handler returns this stable code with no database transition, provider send, runtime/tool continuation, or mutation side effect. |
| `413 STORAGE_QUOTA_EXCEEDED` | Task 3.2 rejects positive persistent growth. Preserve Task 3.2 safe decimal-byte details only; no paths/content. |
| `503` safe provider/runtime/accounting failure | Missing actual-send metering/bound, paused/unconfigured credit admission, unsupported provider runtime, unavailable storage accounting, missing sandbox/egress verification, or unavailable policy storage blocks before the next unadmitted dispatch. Use existing Task 3.1/3.2 mappings where available. Never fall back to per-turn consent/command approval. |

The standard error envelope is `{ "data": null, "error": { "code": "...", "message": "...", "details": [{ "field": "...", "message": "..." }] } }`; details are omitted when empty and contain only safe field/reason text. The policy GET must never present readiness as proof that a later send/write will succeed. A safe reason may be more general than the internal cause. `noChangeConfirmed` is true only after the persistence/runtime boundary confirms no mutation; partial or unknown outcomes do not claim no change. Unknown provider/run outcomes retain Task 3.1 reservations as required and are reconciled by run/turn ID rather than blindly resent.

## Versioning / Compatibility Notes

- The policy-status route is additive under `/api/v1`; existing execution routes and response envelopes remain. OpenAPI must include the new GET DTO, strict query variants, safe errors, and `409 POLICY_ACTION_RETIRED` on every retired decision/acceptance route, as well as any event fields that change.
- A current policy revision and a run's immutable manifest/policy snapshot are distinct from Task 3.1's immutable credit reservation/rate/bound snapshot and Task 3.2's storage accounting state. Policy revision does not reset credits, waive quota, or freeze a provider key/configuration that is no longer valid.
- New submissions never use legacy consent/approval records as standing authority. Existing completed events, audit records and result history remain readable. Existing pending consent, egress, proposal, change-set, and command records are never automatically resumed. Read/status views render a safe legacy-blocked/unsupported state; a fresh request is required.
- Existing `provider_permissions` records only represent remembered provider egress for the exact project/provider/model. They remain readable/revocable for historical compatibility and may be migrated only as that narrow exact provider permission. They never imply a tool capability and do not authorize a new automatic run by themselves.
- All legacy consent, proposal-acceptance/execution, workspace egress, change-set, and sandbox-command decision endpoints remain routable for version compatibility but return `409 POLICY_ACTION_RETIRED` for every decision value, without a state change or external side effect. This includes deny/reject values because some legacy paths notify or continue a runtime. Keep only authenticated cancellation routes and owner-scoped GET/history/status reads; proposal edit/remove is retired with other proposal mutations. Old pending or previously approved records are never resumed under the new policy.
- Existing public request shapes stay unchanged unless OpenAPI/version review approves a strictly additive optional field. Provider, model, path, command, and destination stay server-derived/validated. No setting/editor API is added in this task.
- The additive durable schema is `assistant_scope_policies` plus its deployment provider-configuration singleton. Migration `1710000032000` is registered after Task 3.3 migration `1710000031000`. Down migration refuses rollback while policy rows or policy-bound execution history exist; database provisioning triggers preserve fresh-install migration-before-bootstrap behavior.

## Open Questions

1. User-facing policy revocation has no assigned UI/settings task. The policy row's sticky revocation semantics are defined here, but no user-facing revocation control or new settings route is included in Task 4.1.
2. Task 4.2 owns future direct Home task/workspace action handlers. Capabilities not backed by an already safe fixed handler remain blocked; no mutation implementation is included in this gate.


## Private bounded-command bridge implementation

The exact cross-language wire contract is [bridge-command-contract.md](bridge-command-contract.md). The private existing bridge binds the immutable application manifestHash separately from the selected upload snapshotHash, fixed bounded-read-v1 profile/hash, one-shot request and persisted command ID. Policy runs reject generic permission. The real runner intercepts terminal calls before upstream routine dispatch, verifies selected snapshot files, and enforces fixed read-only argv and Linux resource/network limits. Missing deployed-runtime evidence keeps command capability false; provider admission remains independently closed.

The application asynchronously consumes policy-command-proposed and policy-command-result from the same iterator. It claims policy_authorized provenance under project/run/command locks. executePolicyCommand returns bounded held output; only completePolicyCommand sends policy-command-result-permission after successful result persistence and a fresh policy/cancellation fence. An uncertain acknowledgment is consumed without replay and forces enclosing-run review/cancellation. The fixed wall limit is 10000 ms; bounded result transport permits duration up to 12000 ms for cleanup.
