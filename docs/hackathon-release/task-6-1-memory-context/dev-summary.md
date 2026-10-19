# Dev Summary: Task 6.1 — Make memory and selected context visibly control future runs

## Change History

- 2026-10-19: Implemented project-scoped memory selection for planning-only and file-backed workspaces, reused the existing Home workspace conversation scope for fresh-turn context, and completed focused verification.

## What Was Implemented

- Enabled rootless project chat-context reads and fact-only updates while preserving file-root denial for path selection.
- Added a selected active-fact reader keyed by authenticated owner and persisted workspace ID. Fresh workspace-scoped Home turns use current selected facts only when the stored workspace policy includes the existing `project_facts` category. Global Home remains memory-free.
- Added redaction, per-fact bounds, and pre-dispatch fact ID/version/value revalidation. Home consent categories and request/response DTOs remain unchanged.
- Reconciled uncertain context PATCH results through the existing GET and retained unsaved selection drafts truthfully.
- Reused the existing policy/provider/storage disclosure on the project Memory page so planning-only workspaces can view the disclosure and manage fact selection.
- Added a synthetic preview browser journey covering planning-only disclosure, fact create/select/edit, a fresh workspace-scoped Home conversation, exclusion, and deletion.

## Files Changed

### Frontend

- `Personal-AI-Workspace/frontend/src/entities/project/model/use-project-chat-context.ts`
- `Personal-AI-Workspace/frontend/src/features/project-context/ui/ProjectContextSettings.tsx`
- `Personal-AI-Workspace/frontend/src/features/project-context/ui/ProjectContextSettings.spec.tsx`
- `Personal-AI-Workspace/frontend/src/features/project-memory/ui/ProjectMemoryManager.tsx`
- `Personal-AI-Workspace/frontend/src/features/project-memory/ui/ProjectMemoryManager.spec.tsx`
- `Personal-AI-Workspace/frontend/src/features/project-memory/ui/MemoryFactItem.tsx`
- `Personal-AI-Workspace/frontend/src/features/project-memory/ui/ProjectFactEditorDialog.tsx`
- `Personal-AI-Workspace/frontend/src/features/project-memory/ui/ProjectFactDeleteDialog.tsx`
- `Personal-AI-Workspace/frontend/src/features/assistant-policy-status/index.ts`
- `Personal-AI-Workspace/frontend/src/features/assistant-policy-status/model/use-assistant-execution-policy.ts`
- `Personal-AI-Workspace/frontend/e2e/memory-context.preview.spec.ts`

### Backend

- `Personal-AI-Workspace/backend/src/modules/ai-runs/use-cases/project-chat-context-use-cases.ts`
- `Personal-AI-Workspace/backend/src/modules/ai-runs/use-cases/project-chat-context-use-cases.spec.ts`
- `Personal-AI-Workspace/backend/src/modules/home-assistant/repositories/home-project-memory-context-reader.ts`
- `Personal-AI-Workspace/backend/src/modules/home-assistant/domain/home-planning-context.ts`
- `Personal-AI-Workspace/backend/src/modules/home-assistant/domain/home-planning-context.spec.ts`
- `Personal-AI-Workspace/backend/src/modules/home-assistant/use-cases/submit-home-turn.ts`
- `Personal-AI-Workspace/backend/src/modules/home-assistant/use-cases/submit-home-turn.spec.ts`
- `Personal-AI-Workspace/backend/test/integration/project-fact-storage-quota.integration.spec.ts`
- `Personal-AI-Workspace/backend/src/composition-root.ts` — only the `readSelectedFacts` callback argument at `SubmitHomeTurnUseCase` construction; there is no reader import or separate composition change in this task.

### Shared and documentation

- `.codex/docs/hackathon-release/task-6-1-memory-context/contract.md`
- `.codex/docs/hackathon-release/task-6-1-memory-context/source-map.md`
- `.codex/docs/hackathon-release/task-6-1-memory-context/dev-summary.md`
- `.codex/docs/hackathon-release/task-6-1-memory-context/exact-source-manifest.md`
- `.codex/docs/hackathon-release/task-6-1-memory-context/artifacts/verification.md`
- `.codex/docs/hackathon-release/task-6-1-memory-context/artifacts/task-6-1-planning-memory-mobile.png`
- `.codex/docs/hackathon-release/task-6-1-memory-context/artifacts/task-6-1-fresh-planning-chat-selected-memory.png`

## Contract Notes

No HTTP endpoint, request/response field, database schema, migration, or policy/consent category was added. Existing project facts and `project_chat_context.fact_ids` remain the saved sources. Home memory is internal to the server and is bound to the persisted conversation scope.

## Architecture Alignment Notes

The project-context use case owns context selection and remains the only layer that reads active fact IDs. The Home use case depends on a narrow reader port and does not access repositories or files directly. File capability checks still guard path operations; planning-only memory remains available independently. The only composition-root change adds the `readSelectedFacts` callback argument to `SubmitHomeTurnUseCase` construction.

## Evidence Collected

- `.codex/docs/hackathon-release/task-6-1-memory-context/artifacts/verification.md`
- `.codex/docs/hackathon-release/task-6-1-memory-context/artifacts/task-6-1-planning-memory-mobile.png`
- `.codex/docs/hackathon-release/task-6-1-memory-context/artifacts/task-6-1-fresh-planning-chat-selected-memory.png`

## MCP Notes

No Context7 or separate Chrome DevTools MCP session was available or needed for these repository-local patterns. Chromium browser behavior was exercised through the focused Playwright preview journey, with screenshots and a 390px horizontal-overflow assertion.

## Code Review Findings (and resolutions)

- Confirmed Home facts are read only for a persisted workspace conversation and only when the stored workspace policy contains `project_facts`; policy denial skips the reader and sends no fact.
- Confirmed the fact reader uses owner/project-scoped active fact lookup and does not inspect file inventory.
- Confirmed Home/global consent categories and per-turn authorization metadata remain unchanged.
- Confirmed path selection still requires an attached root and uncertain context saves remain drafts until GET reconciliation.
- Task 6.1 owns one isolated `readSelectedFacts` callback-argument change in the composition-root constructor call.

## Test Coverage Summary

- Backend Jest: 3 focused suites, 26 tests passed.
- Backend TypeScript check: passed.
- Guarded PostgreSQL integration: the selected planning-only context persistence case passed against the approved isolated fixture; pre-test base identity/zero-target guard and a fresh-process post-test identity/zero-target guard passed.
- Frontend Vitest: 2 focused suites, 15 tests passed.
- Frontend app TypeScript check: passed.
- Playwright: 1 synthetic preview journey passed. It used fixture APIs and a synthetic runtime, blocked provider/bridge traffic, and made no live-provider claim.
- Vite preview build: passed. It reported existing Radix `use client` directive notices and a large-bundle warning; neither blocked output.
- Strict standalone E2E TypeScript check was inconclusive because two readonly mutation errors occur in the imported existing preview fixture helper; the new spec itself had no diagnostics, and Playwright executed it successfully.

## Known Limitations / Tech Debt

- The browser fixture verifies the user flow, persisted selection state, and workspace scoping; server prompt inclusion is verified by focused backend tests and persisted selection by the guarded PostgreSQL case. The fixture did not contact a live AI provider.
- Home does not persist a durable context manifest. The selected fact snapshot is revalidated immediately before runtime start and is not added to Home history.
- The context PATCH remains last-write-wins because the existing API has no version or ETag; the UI reloads and reconciles uncertain outcomes.

## Ready for QA: YES
