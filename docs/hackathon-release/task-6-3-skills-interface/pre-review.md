# Task 6.3 Source/Evidence Pre-review

**Status:** Source/evidence pre-review only. This is not an official QA cycle and carries no final PASS/FAIL verdict.

## Ranked findings

1. **Medium — retry can reuse an invocation key with edited request content.** In SkillsWorkspace, an uncertain invocation failure leaves the note field editable while retaining the same invocation key and conversation. The retry submits the current note. The backend fingerprints the request and correctly rejects a changed payload under the same key with SKILL_IDEMPOTENCY_KEY_REUSED; this prevents a second or altered dispatch, but leaves the retry action unable to recover the original result and gives the user no clear resolution path. Capture and retry the exact submitted request with the same key, or require resolving the uncertain attempt before starting a new request. Add a focused regression: simulate an uncertain response, edit the note, then retry; verify the original immutable request is retried or that the user is blocked from reusing the key with changed arguments.

   Evidence: frontend/src/features/skills/ui/SkillsWorkspace.tsx lines 297-317, 338, 344; backend/src/modules/skills/use-cases/invoke-skill.ts lines 55-76. The current mocked retry evidence covers an unchanged request, so it does not exercise edit-after-uncertain-response.

2. **Low — an in-flight publisher preview can repopulate a preview after selection changes.** Selection changes clear the preview, but an older asynchronous preview response can arrive afterward and restore the preview for the previous selection. The selection controls remain active during the request. Publishing then uses the current selection, and the server rejects the stale digest, so the reviewed path does not publish the wrong skills. Disable selection while previewing or discard responses whose captured selection/project no longer matches current state.

   Evidence: frontend/src/features/showcase-publishing/ui/ShowcasePublisher.tsx lines 117-145, 227-249. Server-side preview validation and rejection are covered by backend/src/modules/showcases/use-cases/showcase-use-cases.ts lines 28-108, 157-168.

## Other reviewed boundaries

No additional concrete source issue was found in the reviewed invocation authorization, managed-conversation scope, historical source labeling, or public showcase sanitization paths. Invocation checks bind the authenticated owner to the active skill/version and conversation; workspace planning reuses the owner’s active workspace and checks scope. Historical summaries use exact stored revisions and owner-scoped records, while source labels omit unresolved/deleted sources and do not expose source IDs. Public showcase preview resolves selected skills from the server-side enabled allowlist and publishes only the declared public card fields.

## Evidence index

| Artifact / reference | Covers | Location |
|---|---|---|
| Task card and UI contract | Acceptance scope, user flows, and public skill-card behavior | .codex/docs/hackathon-release/tasks.md Task 6.3; task-6-3-skills-interface/ui-spec.md; contract.md; architecture-preflight.md |
| Developer change and source inventory | Delivered scope and connected source paths | task-6-3-skills-interface/dev-summary.md; artifacts/source-map.md; exact-source-manifest.txt |
| Developer validation | Jest 13 tests, Vitest 11 tests, type checks, Vite build, and route-stubbed browser journeys | task-6-3-skills-interface/artifacts/validation.md |
| Invocation retry and server idempotency | Mutable retry note versus request fingerprint enforcement | frontend/src/features/skills/ui/SkillsWorkspace.tsx lines 297-317, 338, 344; backend/src/modules/skills/use-cases/invoke-skill.ts lines 55-76 |
| Managed Home scope and owner binding | Owner-scoped conversation, turn, workspace, and summary access | backend/src/modules/home-assistant/use-cases/home-planning-tool-request-handler.ts; backend/src/infrastructure/database/repositories/typeorm-skill-invocation-repository.ts lines 195-223; frontend/src/features/home-chat/model/use-home-chat.ts lines 416-419 |
| Historical source labels | Exact revision and source visibility behavior | backend/src/infrastructure/database/repositories/typeorm-skill-invocation-repository.ts lines 195-223; source-label query paths documented in artifacts/source-map.md |
| Showcase preview and publication | Allowlisted server-side selection, digest validation, and stale-preview race | frontend/src/features/showcase-publishing/ui/ShowcasePublisher.tsx lines 117-145, 227-249; backend/src/modules/showcases/use-cases/showcase-use-cases.ts lines 28-108, 157-168; backend/src/infrastructure/database/repositories/typeorm-skill-repository.ts lines 130-139 |

## Validation boundary

The developer-authored validation artifact reports backend Jest 13 tests, frontend Vitest 11 tests, frontend/backend type checks, a production build, and route-stubbed browser coverage. I reviewed those results but did not rerun them. The route-stubbed browser evidence does not establish live provider behavior or managed persistence.

One required real-PostgreSQL integration case remains outstanding: backend/test/integration/skill-definitions.integration.spec.ts, which persists a managed skill run, reloads its Home summary, and checks foreign-owner isolation. Its absence is an environment/evidence limitation already recorded by the team, not a new source finding. Final QA acceptance remains pending that proof.

## Source closure update (2026-10-20)

This update preserves the initial findings above and records their current source status. It is still a source/evidence pre-review, not an official QA cycle.

- **Initial Medium retry finding — resolved in source.** The dialog captures the first invocation request, including its conversation, skill version, and note, and reuses that request with the same invocation key on retry. The focused regression edits the note after an uncertain reply and asserts the retry request, CSRF token, and key match the first call. Evidence: frontend/src/features/skills/ui/SkillsWorkspace.tsx lines 307-315, 342; frontend/src/features/skills/ui/SkillsWorkspace.spec.tsx lines 106-130.
- **Initial Low preview race — resolved in source.** Project and item selection controls are disabled while previewing. The deferred-preview regression asserts the selected task and project controls remain disabled and the selection stays unchanged until the preview resolves. Evidence: frontend/src/features/showcase-publishing/ui/ShowcasePublisher.tsx lines 195-201; frontend/src/features/showcase-publishing/ui/ShowcasePublisher.spec.tsx lines 132-160.

**New Medium follow-up — workspace change does not clear the pinned invocation request.** After an uncertain invocation in workspace A, the workspace selector remains available. Changing to workspace B resets conversationId, createKey, and invokeKey, but leaves invokeRequest.current referencing the request for conversation A. A later run creates a new conversation in B, then invokes using the retained request for A; on success, it opens the B conversation. Reset the pinned request coherently with the conversation and idempotency state when workspace changes. Add a focused regression that makes invocation in A uncertain, switches to B, retries/starts the run, and verifies the invocation and opened route both use B's new conversation.

Evidence: frontend/src/features/skills/ui/SkillsWorkspace.tsx lines 280, 303-315, 339. The workspace change handler clears conversationId/createKey/invokeKey but not invokeRequest. No workspace-switch-after-uncertain case is present in the reviewed focused spec.

The developer reports the two focused spec files at 7 passing tests, frontend type checks, and scoped diff checks passing; those checks were not rerun during this read-only closure review. The historical “no additional concrete source issue” statement above applies to the initial review and is superseded by this newly found follow-up. The required real-PostgreSQL managed invocation/reload/foreign-owner proof remains pending. No official QA verdict is issued.
