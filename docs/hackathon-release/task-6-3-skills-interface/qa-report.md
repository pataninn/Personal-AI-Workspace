# QA Report: Task 6.3 — Expose editable skills and a working Plan my day flow

## Change History

- 2026-10-20: The initial source/evidence pre-review findings were resolved with focused tests: immutable retry payload, workspace-attempt reset, and frozen publisher selection.
- 2026-10-20: Official QA cycle 1 reviewed delivered evidence and connected source. One Medium acceptance-evidence gap remains; this is the first official cycle.

## Test Evidence Reviewed — QA Cycle 1 (historical)

- [x] Developer backend unit tests — 3 focused Jest suites, 13 tests passed.
- [x] Developer frontend unit tests — baseline 4 Vitest files, 11 tests passed; post-repair affected 2 files, 8 tests passed. These runs overlap and are not summed.
- [x] Developer backend integration test — the exact filtered PostgreSQL case passed: 1 passed, 2 skipped by name filter. Its persisted invocation state is denied, as expected without a runtime; it is not evidence of a successful assistant result.
- [x] Developer browser smoke — installed Playwright with local Chrome passed against route-stubbed APIs. It covered keyboard template/edit/run, same-key retry, saved Home result and source label after reload, ordinary file-backed planning-chat route, publisher preview, and read-only public cards. This does not establish live provider or persisted accepted-run behavior.
- [x] Backend and frontend TypeScript checks passed. Frontend production build passed before the final small UI-state repairs; it was not rerun for those repairs. Scoped diff check passed.
- [x] PostgreSQL guard evidence reviewed: the run had same-process preguard and a fresh-process postguard; the target database was absent afterward.
- [x] Required Playwright MCP was unavailable. The developer documented the installed-Playwright route-stub fallback and its limits. Chrome DevTools MCP was N/A; no new external library behavior required Context7.

## Functional Acceptance Review — QA Cycle 1 (historical)

The private library, editor, copy, enable/disable/delete controls, run dialog, Home summary projection, publisher selector, and read-only public cards follow the Task 6.3 contract. The retry uses its original request with its idempotency key. Changing target workspace resets the conversation and pinned request together. Publisher selection is frozen while an exact preview is pending.

The Home summary is requested only for turns returned by the owner-scoped conversation read. The persisted query binds owner, conversation, and turn; the response exposes skill title/version/state and source kind/revision/label without source IDs or content. The reviewed source resolves labels only at the captured revision and returns an unavailable label when the source no longer resolves.

The required database case proves a managed invocation attempt, persisted Home turn/summary reload, and foreign-owner isolation, but only in the fail-closed denied path. It constructs SubmitHomeTurnUseCase without runtime or policy configuration, so the actual persisted invocation has no captured context revisions and the reloaded summary has state denied and sources empty. The mocked browser route returns a saved result and source label, but does not prove that an accepted or runtime-dispatched invocation with source revisions survives the database read path. Task 6.3’s preflight explicitly calls for preserved context revisions, and its Definition of Done requires a visitor to run a skill and see saved output using workspace context.

**Medium finding — successful managed-run persistence and exact source-revision evidence is missing.** This is an evidence/acceptance gap; the reviewed source does not establish a production runtime defect. Close it with one deterministic, local fake-runtime extension to the already approved PostgreSQL integration case. No paid or live provider is needed. Persist a runtime-enabled invocation using one known workspace fact or prior Home message revision, reload its Home summary, and assert the captured revision resolves to that exact label while a foreign owner still receives no summary. If the fixture starts rather than completes the runtime, assert the persisted running/dispatch state and source projection; use the existing Home completion seam only if needed to verify a deterministic saved assistant message. Keep this within the existing guarded integration scope.

## Review Lenses Applied

- **Security — PASS by source review and focused evidence.** Session owner is authoritative; invocation and Home summary reads bind owner/conversation/turn; private workspace scope is checked; current policy remains the tool gate. Public skill cards are read-only and use the server-sanitized allowlist projection. No source IDs, provider details, or captured content are serialized. No new authentication or mutation endpoint was added.
- **Performance — PASS by source review.** Summary projection accepts a deduplicated, bounded turn set and batches its lookup rather than querying per turn. No new dependency or expensive client-side processing was added. No performance trace was collected; the task adds no high-volume path.
- **Usability and accessibility — PASS for reviewed flows, with evidence limits.** UI follows the spec’s labeled forms, visible loading/error/success feedback, keyboard flow, retry recovery, and explicit selection/preview behavior. The browser smoke is route-stubbed; mobile evidence is representative rather than a full device matrix. No blocking usability or accessibility finding was observed in the reviewed source/evidence.

## Findings Summary — QA Cycle 1 (historical)

### Functional acceptance

One Medium evidence gap remains: no deterministic runtime-enabled PostgreSQL case persists and reloads a managed skill invocation with a non-empty exact source revision. See Failure Details.

### Security

No open finding. Existing owner, workspace, policy, and sanitized-public-projection boundaries remain in force.

### Performance

No blocking performance finding. The summary lookup is bounded and batched.

### Usability and accessibility

The repaired UI paths pass the reviewed source and focused evidence. Route-stubbed browser coverage and representative mobile evidence are documented with their limits.

## Evidence Index — QA Cycle 1 (historical)

| Artifact / Reference | Source | Covers | Location / Identifier |
|---|---|---|---|
| Task acceptance | Canonical task tracker | Task 6.3 description, required MCP evidence, Definition of Done | .codex/docs/hackathon-release/tasks.md, Task 6.3 |
| UI requirements | Canonical design artifact | Editor/run/result/public showcase flows, keyboard/mobile and accessible states | task-6-3-skills-interface/ui-spec.md |
| API and data contract | Canonical contract | Owner/scope, invocation, immutable source revisions, summary fields, public allowlist | task-6-3-skills-interface/contract.md |
| Architecture decisions | Canonical preflight | Managed workspace route and focused PostgreSQL proof expectations | task-6-3-skills-interface/architecture-preflight.md |
| Developer implementation summary | Developer evidence | Scope, source ownership, repair summary, readiness | task-6-3-skills-interface/dev-summary.md |
| Developer test receipt | Developer evidence | Jest, Vitest, type checks, build, mocked browser, PostgreSQL result and guards | task-6-3-skills-interface/artifacts/validation.md |
| Exact changed paths | Developer source manifest | Task-owned source/test scope; shared Task 7.1 hunks are separately owned | task-6-3-skills-interface/exact-source-manifest.txt |
| PostgreSQL managed-run case | Source under review | Current denied invocation, empty source set, reload, foreign-owner denial | Personal-AI-Workspace/backend/test/integration/skill-definitions.integration.spec.ts, test “persists a managed skill run and reloads its Home summary within the owning account” |
| Retry/workspace reset repairs | Source and focused tests | Pinned request/key, note edit retry, workspace A-to-B reset and route | Personal-AI-Workspace/frontend/src/features/skills/ui/SkillsWorkspace.tsx and SkillsWorkspace.spec.tsx |
| Preview repair | Source and focused test | Project and item selection disabled until preview resolves | Personal-AI-Workspace/frontend/src/features/showcase-publishing/ui/ShowcasePublisher.tsx and ShowcasePublisher.spec.tsx |
| Summary projection | Source and backend tests | Owner-scoped turn serialization, source labels, no source ID exposure | Personal-AI-Workspace/backend/src/modules/home-assistant/controllers/home-conversation-router.ts; list-home-skill-run-summaries.ts; home-conversation-router.spec.ts |
| QA standards | Project skills | DoD, security, performance, usability, design, accessibility review criteria | .codex/skills/definition-of-done/SKILL.md; security-review/SKILL.md; performance-review/SKILL.md; usability-review/SKILL.md; ui-design/SKILL.md; accessibility/SKILL.md |

## Definition of Done Checklist — QA Cycle 1 (historical)

- [x] Backend and frontend type checks pass for the reviewed changes.
- [x] Required focused backend and frontend unit tests pass; overlapping runs are reported separately.
- [x] UI states and repaired retry/workspace/preview interactions have focused coverage.
- [x] Public API projection is documented in the OpenAPI contract; no new persistence schema or migration is introduced.
- [x] Developer self-review and source manifest are present.
- [x] Required browser evidence is documented; Playwright MCP unavailability and the route-stubbed equivalent are explicit.
- [x] Security, performance, usability, and accessibility lenses were applied.
- [ ] Task 6.3’s managed skill invocation evidence includes a runtime-enabled persisted run with captured context revision(s) reloaded from PostgreSQL.
- [ ] The core acceptance criterion “a visitor edits and runs their own skill” is demonstrated beyond a denied database invocation and route-stubbed saved result.
- [ ] Final QA gate passes.

## QA Cycle 1 Verdict: FAIL (historical; gap closed in cycle 2)

## QA Cycle 1 Failure Details (resolved in cycle 2)

- **Medium — functional acceptance / test coverage gap.** Developer: add one deterministic fake-runtime variant to the existing approved PostgreSQL case, without calling a live or paid provider. Verify a runtime-enabled persisted skill invocation and Home summary reload with at least one captured context revision resolving to the exact same label, while retaining the foreign-owner denial assertions. The current PostgreSQL case persists only a denied invocation with no context revisions; the successful result path is only route-stubbed in browser evidence. This finding does not assert a production code defect.

**Shared-tree attribution:** Managed-workspace Home handler eligibility is a separate Task 7.1-owned hunk in the shared working tree, outside the Task 6.3 source manifest. This report does not attribute that hunk to Task 6.3 or claim it is independently committed with this task.


## QA Cycle 2 Evidence Reviewed

- [x] The exact filtered PostgreSQL case passed twice after the projection fix: 1 selected test passed, 2 tests skipped by the name filter each time. No broader suite was selected.
- [x] Each actual PostgreSQL attempt had a same-process preguard and a separate fresh-process postguard. Final postguards confirmed the base identity, no skill target database or sessions, and no Task 7.1 target database or sessions.
- [x] Backend TypeScript check passed after the summary query fix. Developer reports the scoped diff check and exact 32-path manifest check passed.
- [x] Prior backend Jest 3 suites / 13 tests, frontend Vitest baseline 4 files / 11 tests, and post-repair affected 2 files / 8 tests remain reviewed evidence. The overlapping frontend runs are not summed.
- [x] Prior route-stubbed Playwright smoke, representative desktop/mobile screenshots, and production build are reused with their QA1 limits. They were not rerun for the backend-only projection correction or repeated UI fixes.
- [x] No live or paid provider call was made. The deterministic integration runtime exercises the existing Home runtime boundary locally.

The first actual PG attempt with the accepted-run fixture exposed a JSON type mismatch: the summary query returned the captured revision as a string, while its validated projection requires a number. The query now returns the stored JSON number, and the exact filtered case passed twice afterward. The failed attempt cleaned its isolated database and had a fresh-process postguard pass.

## QA Cycle 2 Functional and Source Review

The same guarded case now exercises a completed run through InvokeSkillUseCase, SubmitHomeTurnUseCase, and GetHomeTurnUseCase using a deterministic in-process runtime and a closed-capability policy. The fixture persists an active workspace skill, selected project fact, Home turn, and assistant message; it verifies the prompt includes the saved fact. Reloaded Home summary state is accepted, its project-fact revision remains a JavaScript number, and its label resolves to the exact persisted fact title, Workspace priority. Foreign-owner conversation, turn, and summary reads remain denied. The fixture does not contact its placeholder endpoint or any provider, so this evidence does not make a live-provider readiness claim.

The SQL projection uses source.value->revision to preserve the numeric JSON value. Its joins continue to bind owner, conversation, and captured fact identity/version, and ignore deleted facts. The summary remains bounded to owner-scoped turn IDs and emits no source IDs or content.

The initial Medium QA1 gap is closed. The three earlier source findings remain resolved: retry keeps the first request with its key; switching workspace resets the complete invocation attempt; and publisher selection cannot change while preview/publication is pending. No further source finding was identified in this closure review.

The managed-workspace eligibility predicate remains a separate Task 7.1-owned hunk in the shared tree and outside the Task 6.3 source manifest. The test and report do not attribute that hunk to Task 6.3.

## QA Cycle 2 Evidence Index

| Artifact / Reference | Covers | Location / Identifier |
|---|---|---|
| Updated developer summary | Accepted local runtime proof, source-number correction, ownership boundaries, no live provider | task-6-3-skills-interface/dev-summary.md |
| Updated validation receipt | Exact PostgreSQL command/result, initial mismatch and repair, repeated guards, test/typecheck scope | task-6-3-skills-interface/artifacts/validation.md |
| PostgreSQL fixture source | Deterministic runtime, closed owner/workspace policy, persisted assistant result, numeric exact-revision assertion, foreign-owner denial | Personal-AI-Workspace/backend/test/integration/skill-definitions.integration.spec.ts, test “persists a managed skill run and reloads its Home summary within the owning account” |
| Numeric summary projection | JSON numeric revision, owner-scoped fact/message joins, deleted-source handling | Personal-AI-Workspace/backend/src/infrastructure/database/repositories/typeorm-skill-invocation-repository.ts, listTurnSummaries |
| Retry/workspace lifecycle | Request/key preservation, workspace reset, post-unmount guard | Personal-AI-Workspace/frontend/src/features/skills/ui/SkillsWorkspace.tsx and SkillsWorkspace.spec.tsx |
| Preview consistency | Frozen selection during preview/publication | Personal-AI-Workspace/frontend/src/features/showcase-publishing/ui/ShowcasePublisher.tsx and ShowcasePublisher.spec.tsx |
| Prior browser evidence and screenshots | Mocked desktop/mobile user flow and read-only publisher/showcase; no live API claim | task-6-3-skills-interface/artifacts/validation.md and artifacts/task-6-3-skills-desktop.png, task-6-3-skills-mobile.png |
| Initial QA history | QA1 gap, remediation request, and preserved cycle history | task-6-3-skills-interface/qa-report.md, QA Cycle 1 sections |

## QA Cycle 2 Definition of Done Checklist

- [x] Backend and frontend type checks are passing for the delivered scope; backend check was repeated after the SQL correction.
- [x] Focused backend and frontend unit evidence is present and passing; overlapping test runs are reported separately.
- [x] The exact managed-run PostgreSQL integration proof now persists and reloads a completed assistant result, numeric source revision, and exact historical label.
- [x] Foreign-owner reads fail closed in the same real-database case.
- [x] Retry, workspace-switch, and publisher-preview repairs retain focused frontend regression coverage.
- [x] Desktop/mobile browser evidence and Playwright MCP unavailability are documented honestly; no live provider behavior is claimed.
- [x] Security, performance, usability, and accessibility reviews remain clear with previously documented route-stub and representative-mobile limits.
- [x] No migration, dependency, or unapproved source path was introduced for this correction; the 32-path manifest and shared Task 7.1 ownership boundary are documented.
- [x] Task 6.3 core acceptance evidence is complete without a live or paid provider call.

## Verdict: PASS

QA Cycle 1 remains recorded above as historical. Its Medium persistence/source-revision evidence gap is closed by the deterministic accepted-run PostgreSQL fixture and two passing post-fix runs. The known limitations remain: no live provider call, route-stubbed browser evidence, and no full mobile/device matrix.
