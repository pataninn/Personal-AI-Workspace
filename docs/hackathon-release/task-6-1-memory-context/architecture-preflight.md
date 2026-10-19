# Task 6.1 architecture preflight: memory in fresh planning-only chats

## Decision

Task 6.1 must make saved project memory affect fresh chats on both existing paths: file-backed `/projects/:projectId/chat-runs` and planning-only Home conversations whose persisted scope is a workspace. The current workspace chat already reads selected `factIds`, resolves active owner/project facts, and snapshots their current values into its run manifest. The Home path currently sends only the bounded Home transcript, so planning-only memory can be edited but cannot influence those turns.

Add a small server-side memory reader to the existing Home prompt assembly. Use it only when the owner-scoped, persisted `HomeConversation.scope` is `{ kind: 'workspace', workspaceId }`. Load that exact active project’s current `project_chat_context.fact_ids`, then resolve the selected active fact records for the authenticated owner and that project. Use each fact’s current value and version in an immutable, per-turn prompt snapshot. Existing Home turns remain idempotent: a replay returns the saved turn and does not re-read memory or restart the provider call.

Global Home conversations remain Home-scoped even when opened while the browser is on a workspace route. They receive no project facts unless the persisted Home conversation itself has workspace scope. There is no separate notes resource in the current contract; treat selected project facts as the saved memory notes. Do not read project files for this planning-only path.

No release-wide architecture rewrite is needed: architecture section 8 already requires fresh permitted facts, and section 5 plus the Task 4.1 contract already defines stored scope policy, project-fact categories, and separate file capability. This preflight resolves the Task 6.1 runtime ownership gap.

## Existing boundaries and current checkout

- `SubmitHomeTurnUseCase` loads the Home conversation by authenticated owner, persists a turn bound to current Home and optional workspace policy revisions, and calls `buildHomePlanningContext` with transcript messages. Its current prompt contains no project memory.
- `AssertAssistantExecutionPolicyUseCase.assertHome` checks the current Home policy and, for a workspace-scoped Home conversation, the exact same-owner project policy. The stored turn carries those policy revisions. Preserve these guards before runtime start and keep the project ID derived from persisted conversation scope.
- `workspace_in_scope_v1` already declares `project_facts`; its `fileAccess` value is separately derived from project capability. Loading facts must not enable file reads, commands, or file-backed chat routes.
- The current in-progress Task 6.1 working diff makes `ProjectChatContextUseCases.get` and fact-selection updates work for rootless planning projects, while path selection and excluded-path changes still require a project file root. The source-map statement that all context reads require a root describes the pre-change baseline and must be corrected. No schema migration is needed for fact selection; `project_chat_context.fact_ids` already stores it.
- The Home runtime is currently configured with `providerEgressAdmissionEnforced: false`. Task 6.1 must leave runtime readiness and credit/quota admission fail-closed; adding memory cannot make an unsupported or unverified runtime ready.

## Backend boundary and ownership

Keep Clean Architecture. `SubmitHomeTurnUseCase` depends on a narrow Home-owned reader port, for example `IHomeProjectMemoryContextReader.readSelectedFacts(ownerId, projectId)`, returning only selected active fact values plus their current IDs/versions. Implement that reader by reusing the existing `ProjectChatContextUseCases` selection and `IProjectFactRepository.findActiveByIds` behavior; do not duplicate selection rules or add a context service/framework. Expose selected facts through a narrow method that avoids `ProjectChatContextUseCases.get`, since that method inventories files for file-backed projects. Keep `HomeConsentCategory` and consent disclosure/event taxonomies unchanged; project facts are already a stored `project_facts` workspace-policy source, not a new consent category.

`home-planning-context.ts` adds an optional selected-facts section only for workspace-scoped turns. Reuse `redactEgressText`, the existing Home prompt byte limit, and bounded Home history. Count the complete rendered prompt in UTF-8 bytes after redaction. If memory cannot be read, is stale/foreign, or the assembled prompt exceeds its bound, fail closed before `runtime.start` and record the existing known-no-send/unsupported result. Never log or append fact content to the Home transcript, event payloads, or error copy.

At the final Home runtime-start boundary, retain the existing active-principal and current Home/project policy checks against the revisions captured for this turn. Resolve facts from the exact owner/project selection, keep their versions with the immutable prompt snapshot, and revalidate the selected fact snapshot at the send boundary using the existing source-validation pattern where available. If the context changed, rebuild once from the latest permitted selection or fail closed; never send a stale value as current. Do not add a client-selected fact list, owner, project, provider, policy revision, path, or destination to the Home request.

Ownership handoff approved by root:

- `developer_memory_luna` owns the Home memory-reader port, Home prompt builder and `SubmitHomeTurnUseCase` integration, their focused specs, and only the import/constructor/callsite wiring for `SubmitHomeTurnUseCase` in `Personal-AI-Workspace/backend/src/composition-root.ts`.
- The same developer retains its existing Task 6.1 ownership of `ProjectChatContextUseCases` and focused tests, project-memory/context UI, and the Task 6.1 contract/source-map updates.
- The root keeps all other `composition-root.ts` changes protected. No `app.ts`, data-source, migration, OpenAPI, Home route/UI, or runtime-admission ownership transfers with this handoff.

Frontend FSD scope remains the existing `features/project-memory`, `features/project-context`, and project-context entity API. Fact inclusion is independent of file access; the file controls remain unavailable without a root. No Home UI, route, API, DTO, OpenAPI, provider setting, or account-wide settings change is required.

## Data flow

```text
Authenticated Home submit
  -> owner-scoped persisted HomeConversation
  -> scope=home: current transcript only
  -> scope=workspace: exact workspace policy + current selected active facts
  -> bounded/redacted Home prompt snapshot
  -> current policy/runtime/quota guards
  -> existing IHomePlanningRuntime.start
```

The file-backed path stays on its existing flow: `SendChatMessageUseCase` -> current saved context -> active facts/files -> immutable AI-run manifest -> existing staging and runtime checks. Both paths read current selection for a new run. Editing an included fact changes later prompt values; excluding or deleting it prevents later inclusion. Old messages and provider calls are not rewritten or recalled.

## Contract and targeted evidence

The public Home request remains `{ message }` with its existing idempotency key. Project context keeps its existing GET/PATCH DTO, and file-backed project chat keeps its existing request and manifest. Do not add tables, migrations, endpoints, or provider/runtime capabilities. DDD and Hexagonal Architecture are excluded.

Required focused evidence should show:

- A new planning-only, workspace-scoped Home turn receives the currently selected active fact value; an edit changes the next fresh turn, and exclusion/deletion removes it.
- A global Home turn does not inherit facts from the current route; a foreign owner/project fact cannot enter the prompt; no workspace file gateway is called when `fileAccess` is false.
- File-backed project chat still snapshots the same current selected facts through its existing manifest path.
- Idempotent replay does not read new context or restart runtime; policy change, context read failure, runtime/quota unavailability, and byte-limit failure result in no provider start.
- Prompt construction redacts secret-like text and enforces the existing total UTF-8 byte bound without exposing content in logs, events, or client errors.

`tasks.md` requires Playwright evidence for the memory edit/delete/exclusion and fresh-chat journey, plus Chrome DevTools evidence inspecting bounded selected-context request behavior without logging secrets. If the current runtime stays unverified, document that the application correctly made no provider request and use focused deterministic runtime evidence for assembly/guard behavior. Context7 is not needed; this change adds no external library or vendor API use.

## Risks and limits

The project-context PATCH remains last-write-wins and has no selection version/ETag. Each fresh turn must therefore snapshot the server’s current selected active facts and their current fact versions at its run boundary; an in-flight provider call cannot be recalled after dispatch. The Home turn schema currently stores policy revisions but no durable context manifest. This preflight keeps the context snapshot in the existing one-shot Home runtime submission and does not introduce a new persisted prompt/manifest. If a durable audit hash for Home memory is required beyond the Task 4.1 policy binding, that needs a separate persistence contract and migration decision.

No application code or tests were changed by this preflight.
