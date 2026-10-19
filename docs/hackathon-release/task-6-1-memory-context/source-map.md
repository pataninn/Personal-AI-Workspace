# Task 6.1 source map

## Change History

- 2026-10-19: Mapped current fact/context/run-snapshot ownership before implementation; amended after the architect preflight to include fresh workspace-scoped Home turns. The app-source work is separately listed in the Task 6.1 contract and developer summary.

## Existing behavior and source of truth

| Concern | Existing source | Contract consequence |
|---|---|---|
| Project facts API | `Personal-AI-Workspace/backend/src/modules/memory/controllers/project-fact-router.ts`; `modules/memory/use-cases/*project-fact*`; `infrastructure/database/repositories/typeorm-project-fact-repository.ts` | Owner/project scoped CRUD, review, current-version update/delete, and active fact reads already exist. No new persistence route is needed. |
| Fact UI and attribution | `frontend/src/features/project-memory/ui/ProjectMemoryManager.tsx`, `MemoryFactItem.tsx`, `ProjectFactEditorDialog.tsx`, `ProjectFactDeleteDialog.tsx`; `entities/project-fact/ui/ProjectFactAttribution.tsx` | Reuse the list, edit/delete flows, source, review status, and saved fact versions; update future-context copy and selection behavior in the owning feature. |
| Selected context DTO | `frontend/src/entities/project/api/project-chat-context-api.ts`; `entities/project/model/use-project-chat-context.ts`; `backend/src/modules/ai-runs/controllers/ai-run-router.ts` | Existing `GET/PATCH /api/v1/projects/:projectId/chat-context`; fields are `relativePaths`, `excludedPaths`, `factIds`, `includeProjectConversations`. No context version field exists. |
| Selected context application logic | `backend/src/modules/ai-runs/use-cases/project-chat-context-use-cases.ts`; `modules/ai-runs/repositories/project-chat-context-repository.ts`; `infrastructure/database/repositories/typeorm-project-chat-context-repository.ts` | The persisted row stores fact IDs independently. The current Task 6.1 diff allows context reads and fact-only updates on planning-only projects, returns no paths for those projects, and keeps path-selection operations behind `requireProjectFileScope`. A new selected-fact read method avoids file inventory for Home turns. |
| Fresh workspace run snapshot | `backend/src/modules/ai-runs/use-cases/send-chat-message-use-case.ts`; `ai-run-use-cases.ts`; `manifest-builder.ts`; `infrastructure/ai-provider/direct-provider-agent-runtime.ts` | Fresh workspace chats read current saved context, filter to active same-owner/project facts, snapshot fact values in the per-run manifest, and revalidate before provider use. Existing run messages/provider calls are not rewritten. |
| Policy and disclosure | `backend/src/modules/assistant-policy/use-cases/get-assistant-execution-policy.ts`; `frontend/src/features/assistant-policy-status/ui/AssistantPolicySummary.tsx`; `frontend/src/features/assistant-policy-status/model/use-assistant-execution-policy.ts`; `frontend/src/features/ai-run/model/use-workspace-assistant-policy.ts`; `frontend/src/entities/assistant-policy/` | Reuse the current provider/model/readiness, included context categories, and operator-managed storage disclosure in both file-backed Context settings and the reachable project Memory page. The Memory page keeps disclosure and fact selection available to planning-only workspaces. Do not add provider settings or a new policy DTO. |
| Project Context and Memory pages | `frontend/src/pages/project-context/ProjectContextPage.tsx`; `frontend/src/features/project-context/ui/ProjectContextSettings.tsx`; `frontend/src/pages/project-memory/ProjectMemoryPage.tsx`; `frontend/src/features/project-memory/ui/ProjectMemoryManager.tsx` | Context settings is currently gated by fileAccess; its file controls and denial behavior remain. The existing project Memory page is reachable without fileAccess, so it hosts the same policy summary and memory selection for planning-only workspaces. Memory fact selection is independent of file capability. |
| Planning-only chat runtime | `backend/src/modules/home-assistant/use-cases/submit-home-turn.ts`; `domain/home-planning-context.ts`; `repositories/home-project-memory-context-reader.ts`; `backend/src/composition-root.ts` | A fresh workspace-scoped Home turn resolves current selected active facts using the authenticated owner and the persisted conversation's `workspaceId` only when that stored workspace policy includes the existing `project_facts` category; otherwise it never calls the reader. A Home-scope conversation remains memory-free. Facts are redacted and bounded in the prompt, and the exact existing Home/workspace policy revision checks remain in force. The only composition-root ownership is the reader import/constructor/callsite wiring. |

## Intended Task 6.1 ownership

Frontend work is limited to:

- `Personal-AI-Workspace/frontend/src/features/project-memory/**`
- `Personal-AI-Workspace/frontend/src/features/project-context/**`
- `Personal-AI-Workspace/frontend/src/entities/project/model/use-project-chat-context.ts` only if the existing hook must reconcile a failed PATCH
- `Personal-AI-Workspace/frontend/src/features/assistant-policy-status/**` only if required to reuse the existing presentation without changing its DTO

Backend work is limited to:

- `Personal-AI-Workspace/backend/src/modules/ai-runs/use-cases/project-chat-context-use-cases.ts` and its focused spec
- `Personal-AI-Workspace/backend/src/modules/ai-runs/use-cases/send-chat-message-use-case.spec.ts` if needed to verify current-context snapshot behavior
- `Personal-AI-Workspace/backend/src/modules/memory/**` only if an existing CRUD behavior gap is found
- `Personal-AI-Workspace/backend/src/modules/home-assistant/repositories/home-project-memory-context-reader.ts`
- `Personal-AI-Workspace/backend/src/modules/home-assistant/domain/home-planning-context.ts` and its focused spec
- `Personal-AI-Workspace/backend/src/modules/home-assistant/use-cases/submit-home-turn.ts` and its focused spec
- Only the narrow `SubmitHomeTurnUseCase` reader import/constructor/callsite wiring hunk in `Personal-AI-Workspace/backend/src/composition-root.ts`; all unrelated existing/shared hunks remain outside this ownership

No database/schema migration is expected. The existing context table is already owner/project scoped and has a `fact_ids` array. No new HTTP endpoint, OpenAPI DTO, app route, provider integration, or account settings route is assigned.

## Explicitly excluded shared/protected paths

- `Personal-AI-Workspace/backend/src/app.ts`
- All unrelated edits in `Personal-AI-Workspace/backend/src/composition-root.ts`; Task 6.1 owns only the explicit reader wiring described above
- `Personal-AI-Workspace/backend/src/infrastructure/database/data-source.ts`
- `Personal-AI-Workspace/backend/openapi.json`
- `Personal-AI-Workspace/backend/src/infrastructure/database/migrations/1710000033000-create-showcase-and-demo-copies.ts`
- Frontend app shell, Home Ask/Home Chat, Dashboard, dialogs outside project memory, sign-in, demo/showcase, and route files
- Original protected AI-run working-tree changes, root `ponytail-review.md`, `frontend/tsconfig.node.tsbuildinfo`, and app-local `.codex` scratch artifacts

## Contract cross-check

- Existing facts/context routes and DTOs are specified in `contract.md`.
- Existing project chat consumer is `POST /api/v1/projects/:projectId/chat-runs`, which reads persisted selected context server-side; it does not accept a client fact override.
- Planning-only saved fact selection is available via the existing context row without file access. For Home, the reader loads selected facts without invoking context file inventory and keys the read from the persisted workspace conversation scope. The architect preflight authorizes this narrow integration and the contract defines its proof requirements.
