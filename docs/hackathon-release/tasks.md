# tasks.md — Personal AI Workspace hackathon release

**Goal:** Deliver all requested UX, automatic tools, task editing/deletion, HTTPS, private demo and account controls, plus visible memory, reusable skills, data export, and always-on briefings.
**Created:** 2026-10-19
**Last Updated:** 2026-10-19
**Architecture:** [architecture.md](architecture.md)
**Application root:** `Personal-AI-Workspace/`
**Status:** Execution active. Task 1.1 tester PASS; required task-scoped documentation commit in progress.

## Plan Summary

- **Outcome:** A complete hackathon release with a one-click private demo and verified NVIDIA model workflow.
- **Sequencing:** Baseline/UI specification -> identity and isolation -> budgets/demo/admin -> automatic tools and task mutations -> UX and memory/skills -> schedules -> deployment -> integrated acceptance.
- **Key dependencies / risks:** Existing local-user assumptions, old approval/archive paths, multi-call Hermes metering, filesystem namespaces, quota races, demo cleanup, and a continuously running HTTPS deployment.
- **Agreed demo decision:** Private session and automatic editable showcase copy; protected canonical showcase; configurable 24-hour expiry; server credit tracking, network admission limits, and shared daily/campaign spending caps. No shared password or global hourly workspace wipe.
- **Delivery boundary:** This task list plans implementation. It does not assert live inference, tests, migrations, deployment, or completed UI work.
- **Ownership:** Project manager coordinates actual architect, designer-ui-ux, developer, and tester subagents during execution. The developer owns each API/full-stack contract before implementation. Design requirements live in the release `ui-spec.md` created by Task 1.1.
- **Existing plans:** Previous home-assistant/MVP artifacts are baseline references. This release plan supersedes conflicting routine approval/archive/demo behavior, without marking previous unfinished work complete.

## Commit convention

After tester PASS, developer stages only the task-owned implementation, tests, and documentation, then commits. Commit subjects omit task numbers and bracketed task tags, per user instruction. Record task IDs and commit hashes in this tracker. Preserve unrelated baseline changes; no push is authorized.

## Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete
- `[!]` Blocked

## Common completion and evidence rules

Apply [definition-of-done](../../skills/definition-of-done/SKILL.md) using this repository's actual package names and existing Zod validation, not unrelated package names/framework assumptions in the generic checklist. Follow FSD/Clean Architecture, existing coding standards, accessibility, and appropriate security/testing reviews. Do not introduce linting.

Each task must record developer self-review, relevant tests and final QA outcome. Use unit tests for non-trivial logic, PostgreSQL integration tests for transaction/auth/persistence behavior, and browser tests for user journeys. Do not add tests that simply mirror static styling. Run `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:boundaries`, and `pnpm --filter personal-ai-workspace-frontend test:e2e` as relevant, with required environments and safe fixtures. Baseline failures stay visible.

Every task below declares required MCP evidence and an artifact directory. Current collection status is Pending. Playwright MCP, Chrome DevTools MCP, and Context7 are not confirmed available in this session; when unavailable, record the reason and use Playwright CLI, available browser tooling, or official documentation as appropriate. Never claim a missing tool ran. An unavailable tool does not waive a required security/live-runtime acceptance criterion.

Each API/full-stack contract file listed below is a **planned deliverable**, not an existing file. It must specify exact DTOs, runtime validation, ownership, errors, CSRF, optimistic versioning, idempotency, storage/credit behavior, and OpenAPI coverage where relevant. The developer owns this gate before code. UI-only tasks consume existing contracts and must not silently change them.

## Epic 1. Design and implementation baseline

### Task 1.1 — Confirm baseline and define screen states

**Status:** `[~]`
**Agents:** designer-ui-ux, developer, tester
**Depends on:** none
**Risk:** Medium: existing work and migration assumptions
**Contract:** N/A (consume existing API contracts where applicable)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Desktop/mobile baseline screenshots and keyboard/task-detail observations
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/artifacts/`
- `Current status:` Developer baseline and release ui-spec.md complete. Live unauthenticated desktop/mobile screenshots plus isolated preview Home/task/editor screenshots and seven keyboard assertions collected; simulated API evidence is labeled. Focused filesystem suite rerun PASS 16/16. Original full-run timeout, stale Compose assertion, and 16 skipped PostgreSQL tests retained. Independent tester PASS recorded in qa-report.md; required commit pending (task not fully delivered until commit exists).

**Description:** Inspect current branch, existing Home task statuses/contracts, API conventions, auth ownership, runtime metering, and deployment assumptions. Capture baseline failures separately from new regressions. Write the release ui-spec.md before user-facing implementation.

**Subtasks:**

- [ ] Map every changed flow to existing slices/modules and identify all archive/approval callers.
- [ ] Specify Home/Ask/history, task forms, demo, admin, memory/skills, automations, and usage screens with loading/empty/error/disabled states.
- [ ] Document desktop/mobile spacing, keyboard/focus behavior, route transitions, and accessible labels.

**Definition of Done:**

- [ ] Baseline report identifies existing failures; ui-spec.md covers every requested screen and dirty-form exit path; no migration or runtime readiness is inferred from old reports.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.

**Upstream Outputs Needed:** Architecture sections 1–4; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs (none required to start).

---

## Epic 2. Accounts and workspace boundaries

### Task 2.1 — Migrate local identity to regular, admin, and demo accounts

**Status:** `[ ]`
**Agents:** developer, tester
**Depends on:** 1.1
**Risk:** High: authentication and existing owner data
**Contract:** `.codex/docs/hackathon-release/task-2-1-account-identity/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` N/A
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-2-1-account-identity/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Extend user/session persistence and sign-in lookup for multiple regular accounts and passwordless demo principals. Preserve the current owner's password and data; assign initial admin role once.

**Subtasks:**

- [ ] Add unique regular-account identifiers, kind/role/status/expiry fields and compatible migrations.
- [ ] Keep secure session/CSRF/origin handling; implement session revocation and disabled/expired checks.
- [ ] Test bootstrap reruns, regular login, foreign session IDs, and protection of the last active admin.

**Definition of Done:**

- [ ] Existing owner can still sign in; two users remain distinct; demo identities cannot use regular password login; disabled/expired sessions fail.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 5.1, 7.3, 11; completed dependency outputs.

---

### Task 2.2 — Enforce ownership across APIs, tools, storage, and streams

**Status:** `[ ]`
**Agents:** developer, tester
**Depends on:** 2.1
**Risk:** Critical: cross-account data exposure
**Contract:** `.codex/docs/hackathon-release/task-2-2-ownership-boundaries/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` N/A
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-2-2-ownership-boundaries/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Audit and close owner-scoping gaps across existing modules. Introduce a reusable application authorization contract without weakening current path and runtime checks.

**Subtasks:**

- [ ] Constrain projects/tasks/conversations/facts/runs/history/events and nested relationships by trusted principal.
- [ ] Allocate non-overlapping server-managed roots; preserve and reserve the legacy owner root; block traversal, links, and arbitrary host attachment.
- [ ] Apply the same policy to tool dispatch and output promotion, including late output after disablement.

**Definition of Done:**

- [ ] Integration tests deny cross-user reads/writes/event replay and file access; own resources continue working; unauthorized IDs do not reveal foreign data.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 3, 5.1, 5.2, 10; completed dependency outputs.

---

## Epic 3. Usage, demo lifecycle, and administration

### Task 3.1 — Implement atomic credit reservations and runtime metering

**Status:** `[ ]`
**Agents:** developer, tester
**Depends on:** 2.2
**Risk:** Critical: overspending and unknown provider outcomes
**Contract:** `.codex/docs/hackathon-release/task-3-1-credit-ledger/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` N/A
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-3-1-credit-ledger/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Implement integer credit accounting, account daily/lifetime limits, demo daily/campaign caps, and an operator inference pause using PostgreSQL transactions.

**Subtasks:**

- [ ] Specify credit conversion, pricing versions, timezone boundaries, null/zero semantics, unique settlement, and counter migrations.
- [ ] Reserve maximum bounded cost before each billable call; extend Hermes bridge metering/caps if needed; cover direct fallback and multi-step runs.
- [ ] Reconcile cancellation/unknown usage conservatively and enforce call/iteration/concurrency caps.

**Definition of Done:**

- [ ] Concurrent requests cannot overspend reserved limits; retries settle once; missing pricing/usage cannot grant free unbounded calls; changing timezone or session does not reset lifetime use.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 7.1, 10; completed dependency outputs.

---

### Task 3.2 — Enforce account storage limits on every persistent write

**Status:** `[ ]`
**Agents:** developer, tester
**Depends on:** 2.2
**Risk:** High: concurrent growth and data loss
**Contract:** `.codex/docs/hackathon-release/task-3-2-storage-quotas/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` N/A
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-3-2-storage-quotas/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Implement documented logical-byte accounting for files and DB content, recovery versions, and template copies; keep separate transient export/sandbox bounds.

**Subtasks:**

- [ ] Reserve positive growth atomically across manual edits, chat/tool results, upload, file promotion, and background jobs.
- [ ] Add reconciliation, physical disk monitoring hooks, size limits, and safe counter updates on deletion.
- [ ] Define over-quota behavior and expose current/limit bytes without deleting data when limits shrink.

**Definition of Done:**

- [ ] Parallel writes cannot exceed allowance; failed writes release only safe reservations; over-limit accounts can delete/shrink; 5 GB is represented as 5,000,000,000 bytes.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 7.2, 10, 11; completed dependency outputs.

---

### Task 3.3 — Provision private one-click demo identities

**Status:** `[ ]`
**Agents:** developer, tester
**Depends on:** 3.1, 3.2
**Risk:** High: anonymous abuse and session isolation
**Contract:** `.codex/docs/hackathon-release/task-3-3-demo-admission/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` N/A
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-3-3-demo-admission/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Add demo session create/resume with fixed configurable 24-hour expiry and persistent admission/rate limits. A token reset must not reset an existing server ledger.

**Subtasks:**

- [ ] Resume valid demo sessions; protect signed-in regular accounts from replacement; establish secure opaque cookies.
- [ ] Persist bounded network/session rate counters and trust only configured proxy forwarding.
- [ ] Provision idempotently with recoverable pending/ready/failed states; exhausted global AI budget still permits bounded non-AI exploration.

**Definition of Done:**

- [ ] Repeated requests do not duplicate sessions/allowances; cookie clearing remains subject to network admission; spoofed forwarded IPs fail; shared-network behavior is documented honestly.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 6, 7.1; completed dependency outputs.

---

### Task 3.4 — Publish a protected showcase and open editable demo copies

**Status:** `[ ]`
**Agents:** designer-ui-ux, developer, tester
**Depends on:** 3.3
**Risk:** Critical: public template disclosure and mutation
**Contract:** `.codex/docs/hackathon-release/task-3-4-showcase-and-demo-entry/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Two isolated browser contexts, one-click entry, mobile banner, exhausted-credit state, and read-only showcase attempts
- `Chrome DevTools MCP:` Network inspection: no credential or private template content exposure
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-3-4-showcase-and-demo-entry/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Implement admin preview/publish of a sanitized versioned example and a single-click Try demo flow that enters its private editable copy.

**Subtasks:**

- [ ] Snapshot only approved public files/tasks/facts/skills; omit private histories, identifiers, secrets, and audit data.
- [ ] Clone with new owner/resource IDs and staged bounded file copying; recover interrupted provisioning without duplicate credits/copies.
- [ ] Add Try demo, expiry/credit banner, View showcase, and backend denials for showcase edits/chat/skills/jobs/tool mutations.

**Definition of Done:**

- [ ] Two browser sessions have independent copies; protected showcase rejects direct API/tool mutation; existing demos do not change when the operator publishes a new version.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 4.3, 5.3, 6; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs.

---

### Task 3.5 — Expire and clean up demos safely

**Status:** `[ ]`
**Agents:** developer, tester
**Depends on:** 3.4
**Risk:** Critical: deletion scope and late writes
**Contract:** `.codex/docs/hackathon-release/task-3-5-demo-expiry/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` N/A
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-3-5-demo-expiry/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Use a durable PostgreSQL-backed cleanup worker with ownership manifests and retryable phases. Expiry denies access immediately, independently of deletion lag.

**Subtasks:**

- [ ] Cancel demo jobs/runs and recheck expiry before every promotion/download; handle late callbacks.
- [ ] Purge owned DB content, roots, recovery copies, exports, sessions, and sandbox resources with resolved-path checks.
- [ ] Retry partial failures; record cleanup lag and backup/provider retention limitations; exclude published showcases and all regular users.

**Definition of Done:**

- [ ] Expiry/run races cannot write after expiry; worker restart completes partial cleanup; fixture tests prove regular and showcase data are untouched.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 6, 11; completed dependency outputs.

---

### Task 3.6 — Build account, quota, and demo administration UI

**Status:** `[ ]`
**Agents:** designer-ui-ux, developer, tester
**Depends on:** 3.4, 3.5
**Risk:** High: privileged actions and secrets
**Contract:** `.codex/docs/hackathon-release/task-3-6-admin-portal/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Admin create/edit/disable/usage journeys, non-admin rejection, validation/errors, keyboard/mobile layout
- `Chrome DevTools MCP:` Network inspection for secret leakage and privilege enforcement
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-3-6-admin-portal/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Provide protected admin account management and usage views backed by admin-only APIs. Include configurable demo budgets and publishing controls.

**Subtasks:**

- [ ] Create/list/search accounts, disable/revoke, reset initial credentials securely, and protect last-admin availability.
- [ ] Edit daily/lifetime/storage limits; show totals, reservations, exhaustion, and limit-below-usage outcomes.
- [ ] Configure demo limits/expiry/global pause; record sensitive-action audit metadata without secrets.

**Definition of Done:**

- [ ] Non-admin direct API access is denied; no existing password/key is exposed; limit changes affect new admissions and active runs at defined boundaries.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 4.3, 7.3; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs.

---

## Epic 4. Automatic execution and canonical task mutations

### Task 4.1 — Replace per-turn consent with workspace-scoped automatic execution

**Status:** `[ ]`
**Agents:** designer-ui-ux, developer, tester
**Depends on:** 2.2, 3.1, 3.2
**Risk:** Critical: policy bypass or unintended tool scope
**Contract:** `.codex/docs/hackathon-release/task-4-1-stored-tool-policy/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Home and workspace chat automatic execution, blocked-scope and provider-unavailable states
- `Chrome DevTools MCP:` Network review of context egress and exposed credentials
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-4-1-stored-tool-policy/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Implement stored provider/context/tool policy and remove routine approval gates in both Home and workspace execution paths while retaining containment.

**Subtasks:**

- [ ] Map every provider-consent/proposal/command gate; replace automatic-path transitions consistently in runtime, API, events, and UI.
- [ ] Keep selected-context exclusions, protected paths, egress restrictions, sandbox command bounds, and promotion/hash/backup checks.
- [ ] Show active provider and included scope; block unsupported/out-of-policy actions clearly rather than granting broad fallback access.

**Definition of Done:**

- [ ] Authorized chat reads/writes run without approval clicks; excluded files, foreign workspaces, host paths, admin actions, and forbidden destinations remain blocked.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 5.2, 12; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs.

---

### Task 4.2 — Execute Home task and workspace actions through canonical use cases

**Status:** `[ ]`
**Agents:** developer, tester
**Depends on:** 4.1
**Risk:** High: duplicate mutations and misleading provenance
**Contract:** `.codex/docs/hackathon-release/task-4-2-direct-home-actions/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` N/A
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-4-2-direct-home-actions/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Replace routine proposal acceptance with direct typed tool execution for user-requested in-scope actions, preserving receipts and version checks.

**Subtasks:**

- [ ] Reuse task/workspace mutation handlers; derive principal on the server and require clear targets.
- [ ] Add idempotent operation keys, actual assistant actor/source labels, conflict handling, and partial-failure receipts.
- [ ] Keep Activity useful and require clarification only for ambiguous targets; deny showcase/admin policy changes.

**Definition of Done:**

- [ ] Repeated tool delivery cannot duplicate mutations; automatic actions are not labeled accepted by user; every applied change has an accurate receipt.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 5.2, 10; completed dependency outputs.

---

### Task 4.3 — Unify task deletion and remove archive behavior

**Status:** `[ ]`
**Agents:** developer, tester
**Depends on:** 4.2
**Risk:** High: deletion, provenance, and historical data
**Contract:** `.codex/docs/hackathon-release/task-4-3-task-delete-migration/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` N/A
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-4-3-task-delete-migration/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Unify assigned/unassigned task deletion and remove archive across public schemas, tool commands, filters, and domain transitions.

**Subtasks:**

- [ ] Preserve legacy archived tasks through documented done/todo conversion with rollback mapping.
- [ ] Reconcile ordering, subtasks, suggestion references, action-ledger replay/undo, versions, and idempotent deletion.
- [ ] Remove stale archive callers/fixtures/contracts and ensure undo cannot resurrect deleted tasks.

**Definition of Done:**

- [ ] Existing archived task content survives migration; rootless/project tasks delete correctly; stale deletes conflict; no supported API/tool can archive or resurrect a deleted task.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 4.2, 11; completed dependency outputs.

---

## Epic 5. Workspace-first UI and task editing

### Task 5.1 — Move Home assistant into a floating Ask panel

**Status:** `[ ]`
**Agents:** designer-ui-ux, developer, tester
**Depends on:** 1.1, 4.1
**Risk:** Medium: drafts, streaming, and focus
**Contract:** N/A (consume existing API contracts where applicable)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Desktop/mobile closed/open/history/streaming screenshots and keyboard focus/close/reopen journey
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-5-1-assistant-launcher/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Recompose existing home-chat/history features into a shell-mounted widget and remove the dominant Home chat block.

**Subtasks:**

- [ ] Add bottom-right icon/Ask launcher, panel header history dropdown and New conversation.
- [ ] Preserve drafts/active runs across close/reopen and navigation; show target workspace scope.
- [ ] Implement desktop panel/mobile sheet, keyboard focus restoration, overflow and streaming states.

**Definition of Done:**

- [ ] Workspaces/tasks remain primary; any conversation is reachable within two clicks from an open panel; closed helper does not obstruct controls.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.

**Upstream Outputs Needed:** Architecture sections 4.1; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs.

---

### Task 5.2 — Replace Inbox emphasis with Add task and View all

**Status:** `[ ]`
**Agents:** designer-ui-ux, developer, tester
**Depends on:** 1.1
**Risk:** Low: discoverability and unassigned task retention
**Contract:** N/A (consume existing API contracts where applicable)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Home capture and All tasks journeys at desktop/mobile sizes
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-5-2-up-next-capture/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Move compact task capture into Up next and make All tasks the destination for browsing/filtering, retaining unassigned tasks.

**Subtasks:**

- [ ] Reuse task-capture/global-task-query slices and optional workspace selection.
- [ ] Remove prominent Inbox block/navigation emphasis without deleting task records.
- [ ] Cover empty, loading, error, and long-list states.

**Definition of Done:**

- [ ] User can add assigned or unassigned tasks from Home and find existing Inbox tasks in All tasks.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.

**Upstream Outputs Needed:** Architecture sections 4.2; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs.

---

### Task 5.3 — Open task details editable with Save and dirty-exit protection

**Status:** `[ ]`
**Agents:** designer-ui-ux, developer, tester
**Depends on:** 4.3, 5.2
**Risk:** High: lost drafts and stale updates
**Contract:** N/A (consume existing API contracts where applicable)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Save/cancel/pristine/dirty navigation/conflict/delete journeys; detailed field and checklist screenshots
- `Chrome DevTools MCP:` N/A
- `Context7:` React Router 6 installed version: navigation blocking and beforeunload behavior

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-5-3-direct-task-editor/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Replace view/edit toggling with a controlled editable task form and delete-only action.

**Subtasks:**

- [ ] Track normalized dirty state and disable no-op Save; save once with expected version.
- [ ] Warn only on dirty close/task switch/route exit; wire native hard-exit handling; Cancel discards.
- [ ] Preserve drafts on validation/network/conflict errors and handle externally deleted tasks.

**Definition of Done:**

- [ ] Pristine navigation never warns; changed forms warn; successful save clears dirty state; stale data is not overwritten; no archive control remains.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.

**Upstream Outputs Needed:** Architecture sections 4.2; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs.

---

### Task 5.4 — Audit spacing, responsiveness, and accessibility across release screens

**Status:** `[ ]`
**Agents:** designer-ui-ux, developer, tester
**Depends on:** 5.1, 5.3, 3.6, 6.3, 6.4, 7.3
**Risk:** Medium: overlays and dense forms
**Contract:** N/A (consume existing API contracts where applicable)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Screen matrix with desktop/mobile/zoom/keyboard evidence and before/after spacing captures
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-5-4-spacing-accessibility/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Apply consistent existing spacing/type tokens and repair observed layout defects across all changed screens.

**Subtasks:**

- [ ] Inspect each task-detail block, line height, checklist, button group, dialog, banner, and panel.
- [ ] Test long content, 200% zoom, keyboard-only navigation, narrow viewport, and virtual-keyboard constraints.
- [ ] Fix focus/label/contrast/scroll issues and capture before/after evidence.

**Definition of Done:**

- [ ] No touching/overlapping controls or unreadable task sections; primary actions remain reachable; meaningful WCAG 2.1 AA checks pass.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.

**Upstream Outputs Needed:** Architecture sections 4; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs.

---

## Epic 6. Memory, reusable skills, and data control

### Task 6.1 — Make memory and selected context visibly control future runs

**Status:** `[ ]`
**Agents:** designer-ui-ux, developer, tester
**Depends on:** 4.1
**Risk:** High: privacy and stale context
**Contract:** `.codex/docs/hackathon-release/task-6-1-memory-context/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Memory edit/delete/exclusion and fresh-chat journey with provider disclosure
- `Chrome DevTools MCP:` Inspect bounded selected-context request evidence without logging secrets
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-6-1-memory-context/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Reuse project facts and context selection to expose remembered preferences, their source, and inclusion in future runs.

**Subtasks:**

- [ ] Ensure new chats load permitted persisted facts and selected notes rather than relying on old transcript state.
- [ ] Provide add/edit/delete/include controls and explain effects on future versus past/provider context.
- [ ] Add concise storage/cloud-provider disclosure in account/workspace settings.

**Definition of Done:**

- [ ] An edited preference changes a fresh chat's permitted context; deletion/exclusion prevents later inclusion; foreign facts never enter prompts.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 8, 11, 12; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs.

---

### Task 6.2 — Persist editable user skills with bounded invocation

**Status:** `[ ]`
**Agents:** developer, tester
**Depends on:** 4.1, 6.1
**Risk:** High: prompt-driven privilege escalation
**Contract:** `.codex/docs/hackathon-release/task-6-2-skill-definitions/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` N/A
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-6-2-skill-definitions/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Add account/workspace skill definitions and versioned invocation while reusing bundled runtime skills and existing AI orchestration.

**Subtasks:**

- [ ] Implement owned skill CRUD/enable/version semantics and seed Plan my day/Daily briefing templates.
- [ ] Snapshot selected skill version/context; intersect declared tools with existing capabilities.
- [ ] Account for instructions/results in storage and all model calls in usage.

**Definition of Done:**

- [ ] Edited skills persist and run with recorded versions; malicious instructions cannot widen scope; disabling/deleting a referenced skill has defined scheduler behavior.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 8, 10; completed dependency outputs.

---

### Task 6.3 — Expose editable skills and a working Plan my day flow

**Status:** `[ ]`
**Agents:** designer-ui-ux, developer, tester
**Depends on:** 6.2
**Risk:** Medium: usable output and permissions
**Contract:** `.codex/docs/hackathon-release/task-6-3-skills-interface/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Skill edit/run/result/error/quota journeys on desktop/mobile; read-only showcase state
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-6-3-skills-interface/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Build skill list/detail/editor and invocation states with a useful saved plan based on tasks, deadlines, and memory.

**Subtasks:**

- [ ] Allow inspect/copy/edit/enable/disable/delete personal skills; preserve read-only showcase behavior.
- [ ] Run Plan my day against chosen workspaces and save/link the result through existing conversation rendering.
- [ ] Show usage/errors/source context and distinguish suggested changes from requested edits.

**Definition of Done:**

- [ ] A visitor edits and runs their own skill; saved output uses remembered working hours and task priorities; unsupported actions fail safely.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 4.3, 8; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs.

---

### Task 6.4 — Add bounded portable workspace export and usage settings

**Status:** `[ ]`
**Agents:** designer-ui-ux, developer, tester
**Depends on:** 3.2, 6.2, 7.1
**Risk:** High: cross-owner downloads and retention
**Contract:** `.codex/docs/hackathon-release/task-6-4-workspace-export/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Export create/download/error/expiry and credit/storage settings journeys
- `Chrome DevTools MCP:` Network/download authorization and cache behavior review
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-6-4-workspace-export/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Export an owned mutable workspace's permitted files and structured data, and show credit/storage usage in settings.

**Subtasks:**

- [ ] Define portable JSON/file format covering tasks, memory, conversations, skills, and schedules; add manifest/version.
- [ ] Build bounded expiring export creation/download with ownership recheck, path checks, and temporary cleanup.
- [ ] Exclude secrets/internal recovery/audit/foreign data; display quota, expiry, and retention explanations.

**Definition of Done:**

- [ ] Export fixture content round-trips through a parser; oversized exports fail predictably; expiry/disable/foreign download attempts are denied; exported secrets fixture is absent.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 4.3, 7.2, 11; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs.

---

## Epic 7. Always-on schedules and daily briefings

### Task 7.1 — Implement durable daily schedules and job claiming

**Status:** `[ ]`
**Agents:** developer, tester
**Depends on:** 3.1, 3.5, 6.2
**Risk:** High: duplicate work, timezones, and restart behavior
**Contract:** `.codex/docs/hackathon-release/task-7-1-durable-scheduler/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` N/A
- `Chrome DevTools MCP:` N/A
- `Context7:` Installed timezone/date API behavior if a new helper is needed; verify primary documentation before dependency choice

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-7-1-durable-scheduler/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Add PostgreSQL schedule/occurrence/lease persistence and independent worker execution using the shared runtime authorization path.

**Subtasks:**

- [ ] Implement daily local-time/IANA scheduling, pause/update, next due UTC, unique occurrence keys, and Run now keys.
- [ ] Implement leases/heartbeats/fenced commits, catch-up coalescing, bounded retry, and unknown-inference reconciliation.
- [ ] Recheck owner/expiry/skill/context permissions and credit/storage limits at execution.

**Definition of Done:**

- [ ] Two workers cannot commit duplicate occurrence results; DST/downtime fixtures pass; pause/disable/expiry blocks late work; process restart preserves schedules.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 9.1; completed dependency outputs.

---

### Task 7.2 — Produce and persist useful daily briefings

**Status:** `[ ]`
**Agents:** developer, tester
**Depends on:** 7.1
**Risk:** High: context accuracy and billed failures
**Contract:** `.codex/docs/hackathon-release/task-7-2-briefing-workflow/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` N/A
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-7-2-briefing-workflow/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Invoke the Daily briefing skill with current tasks/deadlines/notes/memory and save a dated result via existing conversations.

**Subtasks:**

- [ ] Persist status, source revisions, skill version, model/provider, usage, and result link.
- [ ] Implement queued/running/success/failure/skipped-budget/cancelled/interrupted results with actionable reasons.
- [ ] Use the same workflow for schedules and manual Run now; avoid duplicate output or unrequested task changes.

**Definition of Done:**

- [ ] Fixture briefing references the correct owner tasks/facts; budget exhaustion saves a skipped status without a provider call; retries do not duplicate saved output.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 9.2; completed dependency outputs.

---

### Task 7.3 — Add schedule controls, Run now, and run history

**Status:** `[ ]`
**Agents:** designer-ui-ux, developer, tester
**Depends on:** 7.2
**Risk:** Medium: misleading schedule state
**Contract:** `.codex/docs/hackathon-release/task-7-3-automation-interface/contract.md` (planned; developer owns the contract gate)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Schedule/create/edit/pause/run-now/history journeys; mobile/keyboard and budget/error states
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-7-3-automation-interface/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Expose daily time/timezone/workspace selection, pause, Run now, and history/results using existing workspace navigation.

**Subtasks:**

- [ ] Display next run in the chosen timezone plus last outcome; validate selected mutable workspaces.
- [ ] Handle disabled skills, expired demos, exhausted credits, active runs, and failed jobs.
- [ ] Add unobtrusive in-app new-briefing notice; make a judge-triggered run discoverable.

**Definition of Done:**

- [ ] UI reflects server schedule state and result history; Run now needs no approval dialog; demo cannot schedule beyond access expiry or target showcase.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [ ] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 4.3, 9; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs.

---

## Epic 8. Deployment and runtime verification

### Task 8.1 — Prepare persistent host, proxy, worker, and migration deployment

**Status:** `[ ]`
**Agents:** developer, tester
**Depends on:** 2.2, 3.5, 7.1
**Risk:** High: installed WSL assumptions and recovery
**Contract:** N/A (consume existing API contracts where applicable)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` N/A
- `Chrome DevTools MCP:` N/A
- `Context7:` Deployment platform and proxy primary documentation after host selection

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-8-1-production-topology/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Document and configure a persistent compatible deployment with private runtime services and a separate durable worker; avoid publishing a development laptop accidentally.

**Subtasks:**

- [ ] Resolve actual host/domain/runtime prerequisites; port or provision existing bridge with pinned versions and mTLS.
- [ ] Add deployment ordering for migrations/API/worker, persistent volumes, health/heartbeat checks, backup/restore, and rollback steps.
- [ ] Add quota/cleanup/disk/certificate monitoring and demo spending stop runbook.

**Definition of Done:**

- [ ] Staging restart retains users/data/schedules; database/bridge are private; migration and restore rehearsal have recorded outcomes.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.

**Upstream Outputs Needed:** Architecture sections 3, 11, 12; completed dependency outputs.

---

### Task 8.2 — Verify trusted HTTPS and real NVIDIA inference on public topology

**Status:** `[ ]`
**Agents:** developer, tester
**Depends on:** 8.1, 4.1
**Risk:** High: certificates, secrets, and public routing
**Contract:** N/A (consume existing API contracts where applicable)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Public entry/login/demo/chat and browser certificate-state evidence
- `Chrome DevTools MCP:` Certificate, security headers, redirects, mixed content, streaming and secure-cookie inspection
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-8-2-https-and-provider/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Configure controlled domain/DNS and trusted certificates, public origin, proxy streaming, cookies, and renewal; verify configured model/provider integration.

**Subtasks:**

- [ ] Redirect HTTP, remove mixed content, validate CSRF/CORS/CSP/proxy trust and session behavior; test renewal path.
- [ ] Verify current provider model/license/pricing documentation and record a bounded real Nemotron run.
- [ ] Show correct provider disclosure and runtime/model metadata; test unavailable-provider and stop behavior.

**Definition of Done:**

- [ ] Browser shows trusted HTTPS without bypasses; cookie/event streams work; no private service/key is exposed; a successful real Nemotron result is recorded.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.

**Upstream Outputs Needed:** Architecture sections 12, 13; completed dependency outputs.

---

## Epic 9. Integrated acceptance and handoff

### Task 9.1 — Validate security, concurrency, restart, and complete user journeys

**Status:** `[ ]`
**Agents:** tester, developer (fixes)
**Depends on:** 5.4, 6.4, 7.3, 8.2
**Risk:** Critical: public release readiness
**Contract:** N/A (consume existing API contracts where applicable)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Full two-session release journey, browser-closed scheduled run/result, mobile/keyboard and restart evidence
- `Chrome DevTools MCP:` Public security/network and material performance inspection
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-9-1-release-regressions/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Run the integrated acceptance matrix on the deployment candidate and fix failures through their owning tasks before signing off.

**Subtasks:**

- [ ] Exercise cross-account HTTP/tools/files/events/exports/jobs, showcase protection, concurrent quotas, demo reset/expiry/cleanup races.
- [ ] Run full task dirty/save/conflict/delete, memory/skill, admin, and one-click demo journeys with browser evidence.
- [ ] Prove a real scheduled occurrence runs with browser closed, recover after restart, and inspect bounded runtime usage.

**Definition of Done:**

- [ ] Relevant typecheck/unit/integration/boundary/E2E checks pass; no unresolved critical/high issues; required live/browser evidence is present, not substituted by unit tests.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.

**Upstream Outputs Needed:** Architecture sections 13; completed dependency outputs.

---

### Task 9.2 — Package showcase, operator runbook, and judge walkthrough

**Status:** `[ ]`
**Agents:** developer, tester
**Depends on:** 9.1
**Risk:** Medium: misleading claims or unbounded demo cost
**Contract:** N/A (consume existing API contracts where applicable)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Final credential-free judge walkthrough recording/screenshots
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-9-2-hackathon-handoff/artifacts/`
- `Current status:` Pending; no implementation or live validation performed.

**Description:** Prepare the final curated public example and concise demonstration of workspace tasks, memory, skills, and background assistance.

**Subtasks:**

- [ ] Set explicit budgets/expiry/storage/retention and verify sanitized showcase; document recovery and kill switch.
- [ ] Write judge flow: Try demo, change memory, fresh chat/Plan my day, Run now, inspect output/activity.
- [ ] Document model/runtime/provider roles, cloud data flow, deployment/setup steps, remaining limitations, and evidence links.

**Definition of Done:**

- [ ] All requirements map to passed tasks; judge flow works without credentials; public claims match measured behavior; launch checklist identifies no unresolved release gate.
- [ ] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [ ] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.

**Upstream Outputs Needed:** Architecture sections 1, 12–14; completed dependency outputs.

---

## Progress Summary

| Task | Status | QA verdict |
| --- | --- | --- |
| 1.1 — Confirm baseline and define screen states | `[~]` | PASS; commit pending |
| 2.1 — Migrate local identity to regular, admin, and demo accounts | `[ ]` | Pending |
| 2.2 — Enforce ownership across APIs, tools, storage, and streams | `[ ]` | Pending |
| 3.1 — Implement atomic credit reservations and runtime metering | `[ ]` | Pending |
| 3.2 — Enforce account storage limits on every persistent write | `[ ]` | Pending |
| 3.3 — Provision private one-click demo identities | `[ ]` | Pending |
| 3.4 — Publish a protected showcase and open editable demo copies | `[ ]` | Pending |
| 3.5 — Expire and clean up demos safely | `[ ]` | Pending |
| 3.6 — Build account, quota, and demo administration UI | `[ ]` | Pending |
| 4.1 — Replace per-turn consent with workspace-scoped automatic execution | `[ ]` | Pending |
| 4.2 — Execute Home task and workspace actions through canonical use cases | `[ ]` | Pending |
| 4.3 — Unify task deletion and remove archive behavior | `[ ]` | Pending |
| 5.1 — Move Home assistant into a floating Ask panel | `[ ]` | Pending |
| 5.2 — Replace Inbox emphasis with Add task and View all | `[ ]` | Pending |
| 5.3 — Open task details editable with Save and dirty-exit protection | `[ ]` | Pending |
| 5.4 — Audit spacing, responsiveness, and accessibility across release screens | `[ ]` | Pending |
| 6.1 — Make memory and selected context visibly control future runs | `[ ]` | Pending |
| 6.2 — Persist editable user skills with bounded invocation | `[ ]` | Pending |
| 6.3 — Expose editable skills and a working Plan my day flow | `[ ]` | Pending |
| 6.4 — Add bounded portable workspace export and usage settings | `[ ]` | Pending |
| 7.1 — Implement durable daily schedules and job claiming | `[ ]` | Pending |
| 7.2 — Produce and persist useful daily briefings | `[ ]` | Pending |
| 7.3 — Add schedule controls, Run now, and run history | `[ ]` | Pending |
| 8.1 — Prepare persistent host, proxy, worker, and migration deployment | `[ ]` | Pending |
| 8.2 — Verify trusted HTTPS and real NVIDIA inference on public topology | `[ ]` | Pending |
| 9.1 — Validate security, concurrency, restart, and complete user journeys | `[ ]` | Pending |
| 9.2 — Package showcase, operator runbook, and judge walkthrough | `[ ]` | Pending |

## Blocked Items and implementation-time inputs

Task 1.1 execution is active. Architecture validation and developer baseline are complete; designer specification and tester gate are pending. Dependency ordering above applies.

- Task 8.1/8.2 needs the real deployment host/domain and DNS/certificate access. Do not claim the local self-signed setup fixes public browser trust.
- Credit enforcement requires actual provider pricing and a way to bound/meter all Hermes calls. Public AI access stays disabled if that cannot be established.
- Operator must choose demo allowance, global daily/campaign budgets, regular-account defaults, and retention periods before launch. Implement configurable fields without silently selecting production spending.
- Showcase publication requires the operator's intended example content; build the sanitization/preview flow first and keep any development example clearly identified.
- Browser/provider validation needs working runtime and available test credentials; record missing evidence precisely, and do not mark acceptance tasks complete on source inspection.
- Existing repository Git status was unavailable under sandbox ownership checks during planning. No global Git configuration was changed; implementation should establish the current working-tree baseline using an appropriately scoped read.

## Tech Debt Log

Accepted baseline observations for Task 1.1 only; these do not waive any release acceptance gate:

| Severity | Baseline finding | Required resolution / owner |
| --- | --- | --- |
| Medium | Workspace mutation filesystem test exceeded 5000ms during concurrent baseline run | Tester focused serial rerun PASS (1 suite/16 tests, 4.84s) without edits; original full-run timeout retained as host-contention/flaky observation. Recheck in integrated acceptance. |
| Medium | Six guarded PostgreSQL suites / 16 tests skipped without isolated database URL | Developer provision guarded disposable PostgreSQL fixtures and run genuinely before identity/persistence acceptance; skips are unverified. |
| Medium | Default Compose boundary test expects NVIDIA key despite Hermes-default topology | Developer reconcile supported default/direct topologies and retain secret isolation in deployment tasks; resolve before release. |
| Medium | Task action rows touch metadata cards and mobile Back/action controls; editor title crowded by preview banner | Designer/developer address spacing under Tasks 5.3/5.4, verify desktop/mobile/keyboard. |

Do not defer account isolation, quota enforcement, expiry containment, trusted HTTPS, requested task/UX changes, or actual scheduled execution to meet a cosmetic launch date.

## Planning Deliverables

- [x] Architecture and requirement traceability written.
- [x] Dependency-ordered task list with ownership, contracts, evidence requirements, and acceptance checks written.
- [x] Task 1.1 implementation baseline and detailed UI specification (tester PASS; delivery commit pending).
- [ ] All implementation and release verification tasks.
