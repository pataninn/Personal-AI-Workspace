# Architecture Preflight: task-6-3-skills-interface

## Change History

- 2026-10-19: Resolved the UI spec's managed-workspace, durable run-summary, and publisher-preview questions against Task 6.2 and the current source.

## Decisions

Task 6.3 extends the existing FSD frontend, Skills module, Home conversation path, and publisher projection. It adds no dependency, persistence table, migration, runtime, or new capability. DDD and Hexagonal Architecture remain excluded. Context7 is not needed because no vendor API or dependency behavior changes.

### Working Plan result for managed workspaces

The task must support active workspaces owned by the session, including managed/file-backed workspaces. The result stays in a workspace-scoped Home conversation. In `WorkspacePlanningChatPage`, render `HomeChatWidget` for a file-backed workspace only when the URL carries a `conversation` id; keep the normal file-backed route redirect to `/projects/{id}`. `useHomeChat` already loads owner-scoped conversation data and rejects a selected conversation whose persisted scope differs from the current workspace. This reuses the existing `?conversation=` result path and preserves the separate project-chat surface and its navigation.

On the backend, relax only the `relativeRoot !== null` rejection in `HomePlanningToolRequestHandler.assertWorkspace`. Retain `workspaces.reuse({ ownerId, projectId })`, exact scope/workspace matching, and `status === 'active'`. The existing skill capability intersection and fixed Home tool registry still govern task, workspace metadata, and undo operations. This does not expose project files, host paths, OpenShell, arbitrary providers, or new tools. Archived, removal-pending, and foreign workspaces remain denied. Task 7.1 uses this same check for scheduled Home work, so the predicate and managed-workspace proof must be shared with that implementation.

### Durable run and source summary

Add an optional skill-run summary to the existing owner-scoped Home turn/history read projection, sourced from the persisted `skill_invocation_id` binding and `ISkillInvocationRepository.findForTurn` data. Minimum useful fields are the immutable skill title/version, invocation state and the recorded `contextRevisions` (`kind`, `id`, `revision`). Expose only source labels that can be resolved at the exact captured revision; otherwise render “Source unavailable.” Do not resolve an old reference to current changed content. Keep source values and assistant output in their existing Home message storage; do not add narrative, snapshot, or analytics tables. The per-turn projection is read-only and owner-scoped.

The turn history does not persist a historical provider/model projection. Although the credit schema permits `source_kind = home_turn`, the current provider admission call site records `ai_run`, and the credit ledger interface exposes no owner-scoped per-turn read. Show run/turn status and link to account Usage for aggregate credits; do not present current provider configuration or account totals as historical per-run usage. If implementation confirms a durable `home_turn` usage writer, reuse its existing rows in the same owner-scoped read projection; no parallel ledger is justified.

### Publisher and public showcase

This is a frontend DTO, source-picker, and preview extension to the existing sanitized server projection. `ShowcaseSelection.skillIds` is already accepted as an explicit allowlist; the server resolves ownership and scope and returns reviewed skill fields in preview/public snapshots. Load eligible owned skills through the existing Skills read API, show the server preview fields, and submit IDs only. Do not create a publish endpoint, send client-authored skill text/capabilities as authority, or expose source IDs, owner IDs, provider settings, or runtime files publicly.

## Boundaries and Data Flow

```text
Skills page / Run
  -> existing Skills API and invocation use case
  -> owner-scoped workspace Home conversation + bounded Home turn
  -> existing HomeChat at /projects/{id}/planning-chat?conversation={id}
  -> owner-scoped turn history + persisted invocation summary

Admin publisher -> existing skillIds allowlist -> server-resolved sanitized preview/public snapshot
```

Frontend stays within FSD: `app/` owns route wiring; a Skills page composes the workspace view; the skill entity owns DTO/API types; the skills feature owns editor, copy, enable/delete, and run interactions. Extend the existing `features/showcase-publishing` source picker/preview and `entities/showcase` projection for public cards. Keep slices' public APIs narrow and use existing shared form, dialog, and Markdown components.

Backend stays within Clean Architecture: controllers serialize the existing Skills/Home/showcase use-case results; use cases own validation, ownership, and invocation orchestration; existing repositories provide persisted skill bindings and account/project-scoped data. Do not read infrastructure directly from React or controllers.

No schema or migration is required for this decision: the invocation already records skill revision and context source revisions, and the Home turn already stores its invocation binding.

## Inspected Source Map

- Workspace rejection and the closed Home tool boundary: `Personal-AI-Workspace/backend/src/modules/home-assistant/use-cases/home-planning-tool-request-handler.ts` (`assertWorkspace`, `skillInvocationAllows`).
- File-backed route redirect and Home scope match: `Personal-AI-Workspace/frontend/src/pages/workspace-planning-chat/WorkspacePlanningChatPage.tsx`; `Personal-AI-Workspace/frontend/src/features/home-chat/model/use-home-chat.ts` (`sameScope` check on selected conversation).
- Turn DTO gap and durable binding: `Personal-AI-Workspace/backend/src/modules/home-assistant/controllers/home-conversation-router.ts` (`serializeTurn`); `Personal-AI-Workspace/backend/src/modules/home-assistant/domain/home-conversation-types.ts`; `Personal-AI-Workspace/backend/src/modules/skills/domain/skill-invocation-types.ts`; `Personal-AI-Workspace/backend/src/infrastructure/database/repositories/typeorm-skill-invocation-repository.ts` (`findForTurn`).
- Usage evidence: `Personal-AI-Workspace/backend/src/modules/credits/repositories/credit-ledger-repository.ts`; `Personal-AI-Workspace/backend/src/infrastructure/ai-provider/nvidia-hosted-nim-provider.ts`; `Personal-AI-Workspace/backend/src/infrastructure/database/migrations/1710000028000-create-credit-ledger.ts`.
- Existing skill publish allowlist/projection: `Personal-AI-Workspace/backend/src/modules/showcases/controllers/showcase-router.ts`; `Personal-AI-Workspace/backend/src/modules/showcases/domain/showcase-types.ts`; `Personal-AI-Workspace/frontend/src/features/showcase-publishing/ui/ShowcasePublisher.tsx`; `Personal-AI-Workspace/frontend/src/entities/showcase/model/types.ts`.

## Focused Proof Required

- PostgreSQL: invoke and reload a skill result in an active managed/file-backed workspace; verify owner/scope matching and preserved context revisions. Verify foreign, archived, and removal-pending scopes fail closed, and that the Home handler still has no file/host tool capability. Coordinate the shared workspace assertion and test with Task 7.1.
- Browser: run and open the saved result in both planning-only and file-backed workspaces; reload the result and its source summary; preserve ordinary file-backed project-chat navigation; exercise edit/copy, disable/delete, quota/runtime errors, and idempotent retry without duplicate runs.
- Publisher/public view: select skills, inspect the exact preview, publish the ID allowlist, and verify public cards are read-only and contain only sanitized title, instructions, and declared tool needs. Capture the desktop/mobile skill edit/run/result/error/quota journeys and read-only showcase state required by `tasks.md`.

## Files Created or Modified

- Created `.codex/docs/hackathon-release/task-6-3-skills-interface/architecture-preflight.md`.
