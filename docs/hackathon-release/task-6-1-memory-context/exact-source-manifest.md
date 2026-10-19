# Task 6.1 exact source manifest

## Session documentation and artifacts

- `.codex/docs/hackathon-release/task-6-1-memory-context/contract.md` — developer contract updated before the Home runtime slice.
- `.codex/docs/hackathon-release/task-6-1-memory-context/source-map.md` — current repository ownership and existing source map.
- `.codex/docs/hackathon-release/task-6-1-memory-context/dev-summary.md` — implementation, review, and test handoff.
- `.codex/docs/hackathon-release/task-6-1-memory-context/exact-source-manifest.md` — this manifest.
- `.codex/docs/hackathon-release/task-6-1-memory-context/artifacts/verification.md` — sanitized verification record and evidence limits.
- `.codex/docs/hackathon-release/task-6-1-memory-context/artifacts/task-6-1-planning-memory-mobile.png` — synthetic mobile Memory view.
- `.codex/docs/hackathon-release/task-6-1-memory-context/artifacts/task-6-1-fresh-planning-chat-selected-memory.png` — synthetic fresh workspace chat view.

## Frontend source and tests

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

## Backend source and tests

- `Personal-AI-Workspace/backend/src/modules/ai-runs/use-cases/project-chat-context-use-cases.ts`
- `Personal-AI-Workspace/backend/src/modules/ai-runs/use-cases/project-chat-context-use-cases.spec.ts`
- `Personal-AI-Workspace/backend/src/modules/home-assistant/repositories/home-project-memory-context-reader.ts`
- `Personal-AI-Workspace/backend/src/modules/home-assistant/domain/home-planning-context.ts`
- `Personal-AI-Workspace/backend/src/modules/home-assistant/domain/home-planning-context.spec.ts`
- `Personal-AI-Workspace/backend/src/modules/home-assistant/use-cases/submit-home-turn.ts`
- `Personal-AI-Workspace/backend/src/modules/home-assistant/use-cases/submit-home-turn.spec.ts`
- `Personal-AI-Workspace/backend/test/integration/project-fact-storage-quota.integration.spec.ts`
- `Personal-AI-Workspace/backend/src/composition-root.ts` — only the `readSelectedFacts` callback argument added at the `SubmitHomeTurnUseCase` constructor call; no reader import or other composition-root change is included in this ownership.

## Scope notes

No migration, OpenAPI, route, app configuration, file-capability, Home chat UI, or global-settings file was changed by Task 6.1. The shared `frontend/tsconfig.node.tsbuildinfo` and unrelated changes in the same worktree are excluded. The temporary Playwright config was removed after the focused run; generated preview/test output remains under the app's ignored local test-results directory and is not part of this manifest.
