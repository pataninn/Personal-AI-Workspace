# Task 6.3 Source Map

## Flow

- Authenticated navigation exposes /projects/:projectId/skills. The Skills feature uses the existing skill list/detail/create/update/delete/invoke APIs and keeps workspace ownership in the server boundary.
- Template copy creates an editable private skill. Skill create/edit requests retain the current version precondition; delete and invoke use the existing version/idempotency contracts.
- Plan my day creates or reuses one workspace-scoped Home conversation, invokes through the existing skill use case, and routes to /projects/:projectId/planning-chat?conversation={id}. Without the selected conversation query, a file-backed workspace keeps the ordinary workspace route.
- Home turn list and single-turn reads optionally serialize skillRun. The router requests summaries only for turns already returned by the owner-scoped Home read. The summary use case delegates to the invocation repository, which constrains owner, conversation, and turn IDs.
- Source labels are resolved only when captured source identity and revision still match persisted records. JSON source revisions retain their numeric type; otherwise the label is null and the UI displays Source unavailable. The response contains no source ID or source content.
- The existing publisher picker selects enabled skills and passes only selected IDs through the existing sanitized showcase snapshot. Public showcase renders read-only cards.

## API Extension

GET /api/v1/home/conversations/{conversationId}/turns and GET /api/v1/home/conversations/{conversationId}/turns/{turnId} gain an optional skillRun field:

{ title, skillVersion, state, sources: [{ kind, revision, label }] }

No database schema or new public endpoint was added.

## Ownership Boundaries

- Task 6.3-owned application and test paths: ../exact-source-manifest.txt.
- backend/openapi.json also contains Task 7.1 automation additions; only its HomeSkillRunSummary schema/turn field belongs to Task 6.3.
- backend/src/composition-root.ts also contains Task 7.1 composition and other concurrent hunks; only ListHomeSkillRunSummariesUseCase registration and its Home router dependency belong to Task 6.3.
- backend/test/integration/skill-definitions.integration.spec.ts is an existing Task 6.2 PostgreSQL suite; Task 6.3 adds only the single managed-run summary/reload case identified in dev-summary.md.
- Scheduler fences, Task 5.3 sign-out/editor guards, other task cleanup work, and protected AI-run originals are outside this source map.

## Retry and Preview Consistency

- Once a skill invocation starts, the dialog pins the submitted conversation ID, skill version, and request text together with its idempotency key. An uncertain retry reuses that exact request; edited note text is not silently sent with the old key.
- While an exact showcase preview or publication is in flight, project and item selection controls are disabled so the visible selection cannot drift from the preview request.

## Run Scope Lifecycle

- An uncertain retry retains its original request payload, conversation, and idempotency key.
- Changing the target workspace resets the Home conversation ID, conversation-creation key, invocation key, pinned request, and prior error together; the next run uses the new workspace and current note.
- Changing skill identity/version remounts the run dialog. The target selector is disabled while a request is active, and callbacks from a dialog that unmounts do not invoke further work or navigate after completion.
