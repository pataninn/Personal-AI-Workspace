# tasks.md â€” Personal AI Workspace hackathon release

**Goal:** Deliver all requested UX, automatic tools, task editing/deletion, HTTPS, private demo and account controls, plus visible memory, reusable skills, data export, and always-on briefings.
**Created:** 2026-10-19
**Last Updated:** 2026-10-19
**Architecture:** [architecture.md](architecture.md)
**Application root:** `Personal-AI-Workspace/`
**Status:** Execution active. Sixteen tasks delivered: 1.1, 2.1, 2.2, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 5.1, 5.2, 6.1, 6.2. Latest verified delivery `84b983b145eb2b9b9968e292360862d16f14c50d`. Task5.3 QA1 found a pending-delete exit gap; targeted repair active. Task7.1 scheduler guarded PostgreSQL proof is active. Task6.3 UI spec and architecture decisions are complete; developer contract and implementation active.

**Current execution boundary (user update):** User requested stopping after the current task. Finish Task5.3 editor QA and scoped local commit, then stop. Tasks6.3/7.1 are checkpointed with unfinished work preserved; no further tasks, deployment8.x or acceptance9.x begin. Earlier through7.3 scope remains queued for a later resume.

## Plan Summary

- **Outcome:** A complete hackathon release with a one-click private demo and verified NVIDIA model workflow.
- **Sequencing:** Baseline/UI specification -> identity and isolation -> budgets/demo/admin -> automatic tools and task mutations -> UX and memory/skills -> schedules -> deployment -> integrated acceptance.
- **Key dependencies / risks:** Existing local-user assumptions, old approval/archive paths, multi-call Hermes metering, filesystem namespaces, quota races, demo cleanup, and a continuously running HTTPS deployment.
- **Agreed demo decision:** Private session and automatic editable showcase copy; protected canonical showcase; configurable 24-hour expiry; server credit tracking, network admission limits, and shared daily/campaign spending caps. No shared password or global hourly workspace wipe.
- **Delivery boundary:** This task list plans implementation. It does not assert live inference, tests, migrations, deployment, or completed UI work.
- **Ownership:** Project manager coordinates actual architect, designer-ui-ux, developer, and tester subagents during execution. The developer owns each API/full-stack contract before implementation. Design requirements live in the release `ui-spec.md` created by Task 1.1.
- **Existing plans:** Previous home-assistant/MVP artifacts are baseline references. This release plan supersedes conflicting routine approval/archive/demo behavior, without marking previous unfinished work complete.

## Commit convention

After tester PASS, developer stages only the task-owned implementation, tests, and documentation, then commits. Commit subjects omit task numbers and bracketed task tags, per user instruction. Record task IDs and commit hashes in this tracker. Preserve unrelated baseline changes; no push is authorized. Future release commits use `feature/automatic-assistant-tools`, created from `3f4adabbe22a8303406cea9e4441b3e987f605d3` on user request; earlier commits remain on the original branch.

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


**User priority update (2026-10-19):** Prioritize working end-to-end release flows and defer minor visual or test-precision issues for later fixes. QA may accept explicitly recorded Low visual debt when normal interaction is proven; failed checks remain labeled failed. This does not waive functional failures, missing requested features, authentication/isolation, credits/storage enforcement, data-loss safeguards, or safe cleanup. Avoid duplicate checks and cosmetic polishing that delay independent release work. The user reiterated speed over perfection: finish the complete functional scope with focused checks, record minor refinements for later, and do not expand the test matrix without a concrete unresolved risk.

## Epic 1. Design and implementation baseline

### Task 1.1 â€” Confirm baseline and define screen states

**Status:** `[x]`
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
- `Current status:` Developer baseline and release ui-spec.md complete. Live unauthenticated desktop/mobile screenshots plus isolated preview Home/task/editor screenshots and seven keyboard assertions collected; simulated API evidence is labeled. Focused filesystem suite rerun PASS 16/16. Original full-run timeout, stale Compose assertion, and 16 skipped PostgreSQL tests retained. Independent tester PASS recorded in qa-report.md; commit `721f0f26011147437f9d24c4749431169b309ad1` delivered.

**Description:** Inspect current branch, existing Home task statuses/contracts, API conventions, auth ownership, runtime metering, and deployment assumptions. Capture baseline failures separately from new regressions. Write the release ui-spec.md before user-facing implementation.

**Subtasks:**

- [x] Map every changed flow to existing slices/modules and identify all archive/approval callers.
- [x] Specify Home/Ask/history, task forms, demo, admin, memory/skills, automations, and usage screens with loading/empty/error/disabled states.
- [x] Document desktop/mobile spacing, keyboard/focus behavior, route transitions, and accessible labels.

**Definition of Done:**

- [x] Baseline report identifies existing failures; ui-spec.md covers every requested screen and dirty-form exit path; no migration or runtime readiness is inferred from old reports.
- [x] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [x] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.

**Upstream Outputs Needed:** Architecture sections 1â€“4; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs (none required to start).

---

## Epic 2. Accounts and workspace boundaries

### Task 2.1 â€” Migrate local identity to regular, admin, and demo accounts

**Status:** `[x]`
**Agents:** developer, tester
**Depends on:** 1.1
**Risk:** High: authentication and existing owner data
**Contract:** `.codex/docs/hackathon-release/task-2-1-account-identity/contract.md` (implemented and independently verified; developer owns the contract)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` N/A
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-2-1-account-identity/artifacts/`
- `Current status:` Independent tester PASS in qa-report.md. Broad backend114/685 and PostgreSQL20/81 runs recorded; final independent backend3suites/20tests, PostgreSQL2suites/3tests (including session continuity/race), frontendtypecheck and24files/160tests PASS. Contract/UI/dev-summary/evidence complete. Delivered commit `d696550acddceac3a641584c1fe5f3fb52ad42bd`; worktree afterward exactly original six preserved paths.

**Description:** Extend user/session persistence and sign-in lookup for multiple regular accounts and passwordless demo principals. Preserve the current owner's password and data; assign initial admin role once.

**Subtasks:**

- [x] Add unique regular-account identifiers, kind/role/status/expiry fields and compatible migrations.
- [x] Keep secure session/CSRF/origin handling; implement session revocation and disabled/expired checks.
- [x] Test bootstrap reruns, regular login, foreign session IDs, and protection of the last active admin.

**Definition of Done:**

- [x] Existing owner can still sign in; two users remain distinct; demo identities cannot use regular password login; disabled/expired sessions fail.
- [x] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [x] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [x] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 5.1, 7.3, 11; completed dependency outputs.

---

### Task 2.2 â€” Enforce ownership across APIs, tools, storage, and streams

**Status:** `[x]`
**Agents:** developer, tester
**Depends on:** 2.1
**Risk:** Critical: cross-account data exposure
**Contract:** `.codex/docs/hackathon-release/task-2-2-ownership-boundaries/contract.md` (implemented and independently verified; developer owns the contract)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Managed workspace creation form (no arbitrary host root), desktop/mobile focus and ownership-error states; preserve legacy rootless workspace notice. CLI/browser equivalent if MCP unavailable.
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-2-2-ownership-boundaries/artifacts/`
- `Current status:` Independent tester PASS in qa-report.md with Evidence Index. Backend117 suites/709 tests; isolated PostgreSQL22 suites/88 tests; independent PG2/5, auth2/20 and OpenAPI/config2/18 PASS. Frontend typecheck,79 focused tests,26 previewAPI and browser journey PASS with independent UI review. Optional managed-storage overlay/setup/OpenAPI corrected; actual Compose parser and focused boundary check PASS. Existing unrelated NVIDIA/Hermes Compose assertion remains logged for deployment. Delivered commit `6fb7278bc680a0df11e3f6e6cb8bd03a0090cb7c`; post-commit worktree exactly original six preserved paths. No push.

**Description:** Audit and close owner-scoping gaps across existing modules. Introduce a reusable application authorization contract without weakening current path and runtime checks.

**Subtasks:**

- [x] Constrain projects/tasks/conversations/facts/runs/history/events and nested relationships by trusted principal.
- [x] Allocate non-overlapping server-managed roots; preserve and reserve the legacy owner root; block traversal, links, and arbitrary host attachment.
- [x] Apply the same policy to tool dispatch and output promotion, including late output after disablement.

**Definition of Done:**

- [x] Integration tests deny cross-user reads/writes/event replay and file access; own resources continue working; unauthorized IDs do not reveal foreign data.
- [x] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [x] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [x] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 3, 5.1, 5.2, 10; completed dependency outputs.

---

## Epic 3. Usage, demo lifecycle, and administration

### Task 3.1 â€” Implement atomic credit reservations and runtime metering

**Status:** `[x]`
**Agents:** developer, tester
**Depends on:** 2.2
**Risk:** Critical: overspending and unknown provider outcomes
**Contract:** `.codex/docs/hackathon-release/task-3-1-credit-ledger/contract.md` (implemented and independently verified; developer owns the contract)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` N/A
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-3-1-credit-ledger/artifacts/`
- `Current status:` Independent tester PASS in qa-report.md with Evidence Index. Credit focused9 suites81tests/PG1suite7tests PASS; broad backend129suites770tests, typecheck and full PG24suites98tests PASS in shared worktree. Independent runtime4suites43tests and PostgreSQL2suites10tests PASS. Integer limits/reservations/settlement, demo races, timezone and overflow pause verified. Contract/README six-field configuration aligned. PASS covers offline ledger and closed runtime gates; paid inference enablement remains unresolved. Delivered commit `9b65d3c5b5906cb63033fed7bc2053e587d925b9`. Isolated staged source without storage0029 passed typecheck and PostgreSQL2suites10tests through0028 only; exact evidence recorded. Storage WIP and original six paths remain uncommitted; no push.

**Description:** Implement integer credit accounting, account daily/lifetime limits, demo daily/campaign caps, and an operator inference pause using PostgreSQL transactions.

**Subtasks:**

- [x] Specify credit conversion, pricing versions, timezone boundaries, null/zero semantics, unique settlement, and counter migrations.
- [x] Reserve maximum bounded cost before each billable call; extend Hermes bridge metering/caps if needed; cover direct fallback and multi-step runs.
- [x] Reconcile cancellation/unknown usage conservatively and enforce call/iteration/concurrency caps.

**Definition of Done:**

- [x] Concurrent requests cannot overspend reserved limits; retries settle once; missing pricing/usage cannot grant free unbounded calls; changing timezone or session does not reset lifetime use.
- [x] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [x] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [x] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 7.1, 10; completed dependency outputs.

---

### Task 3.2 â€” Enforce account storage limits on every persistent write

**Status:** `[x]`
**Agents:** developer, tester
**Depends on:** 2.2
**Risk:** High: concurrent growth and data loss
**Contract:** `.codex/docs/hackathon-release/task-3-2-storage-quotas/contract.md` (implemented and independently verified; developer-owned contract)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` N/A
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-3-2-storage-quotas/artifacts/`
- `Current status:` Independent tester PASS in qa-report.md with Evidence Index. Developer backend unit138suites825tests, typecheck and isolated PostgreSQL29suites105tests PASS; independent unit24suites167tests, typecheck and PostgreSQL6suites10tests PASS (generic rerun overlaps). No Critical/High findings. Known Compose baseline7/8 tracked separately; managed overlay check PASS. Delivered local commit `b5d40315680b73afac3e04c1a52b8ceaba83a1bf` (`feat(storage): enforce account storage quotas`); only the six protected baseline files remain, nothing staged and no push.

**Description:** Implement documented logical-byte accounting for files and DB content, recovery versions, and template copies; keep separate transient export/sandbox bounds.

**Subtasks:**

- [x] Reserve positive growth atomically across manual edits, chat/tool results, upload, file promotion, and background jobs.
- [x] Add reconciliation, physical disk monitoring hooks, size limits, and safe counter updates on deletion.
- [x] Define over-quota behavior and expose current/limit bytes without deleting data when limits shrink.

**Definition of Done:**

- [x] Parallel writes cannot exceed allowance; failed writes release only safe reservations; over-limit accounts can delete/shrink; 5 GB is represented as 5,000,000,000 bytes.
- [x] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [x] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [x] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 7.2, 10, 11; completed dependency outputs.

---

### Task 3.3 â€” Provision private one-click demo identities

**Status:** `[x]`
**Agents:** developer, tester
**Depends on:** 3.1, 3.2
**Risk:** High: anonymous abuse and session isolation
**Contract:** `.codex/docs/hackathon-release/task-3-3-demo-admission/contract.md` (implemented and independently verified; developer-owned contract)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` N/A
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-3-3-demo-admission/artifacts/`
- `Current status:` Independent tester PASS in qa-report.md with Evidence Index. Developer unit140suites838tests, integration31suites114tests and typecheck PASS; independent unit4/55, HTTP1/6, guarded PostgreSQL1/3 and typecheck PASS. No blocking findings. Delivered local commit `3f4adabbe22a8303406cea9e4441b3e987f605d3` (`feat(demo): provision private demo sessions`),40 reviewed paths. Only the six protected baseline files remain; index clean and no push.

**Description:** Add demo session create/resume with fixed configurable 24-hour expiry and persistent admission/rate limits. A token reset must not reset an existing server ledger.

**Subtasks:**

- [x] Resume valid demo sessions; protect signed-in regular accounts from replacement; establish secure opaque cookies.
- [x] Persist bounded network/session rate counters and trust only configured proxy forwarding.
- [x] Provision idempotently with recoverable pending/ready/failed states; exhausted global AI budget still permits bounded non-AI exploration.

**Definition of Done:**

- [x] Repeated requests do not duplicate sessions/allowances; cookie clearing remains subject to network admission; spoofed forwarded IPs fail; shared-network behavior is documented honestly.
- [x] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [x] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [x] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 6, 7.1; completed dependency outputs.

---

### Task 3.4 â€” Publish a protected showcase and open editable demo copies

**Status:** `[x]`
**Agents:** designer-ui-ux, developer, tester
**Depends on:** 3.3
**Risk:** Critical: public template disclosure and mutation
**Contract:** `.codex/docs/hackathon-release/task-3-4-showcase-and-demo-entry/contract.md` (developer contract finalized; implementation and verification active)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Two isolated browser contexts, one-click entry, mobile banner, exhausted-credit state, and read-only showcase attempts
- `Chrome DevTools MCP:` Network inspection: no credential or private template content exposure
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-3-4-showcase-and-demo-entry/artifacts/`
- `Current status:` Developer backend typecheck and focused3suites14tests PASS; guarded PostgreSQL1suite4tests PASS with fresh base/zero-target postguard. Frontend focused14tests plus final affected4tests PASS, production typecheck/build PASS, static-fixture Playwright1/1 desktop/mobile PASS. Required one-click pending-to-ready automatic workspace entry is complete: final frontend17/17 tests, typecheck/build and rebuilt two-context fixture1/1 PASS. Combined developer Ready for QA:YES; Independent QA cycle2 PASS: new direct Express HTTP suite3/3 proves pending-copy409 before private handler, ready/regular access and safe exceptions. Prior cycle1 verification gap resolved and history retained. Existing PG/browser checks remain valid. Delivered local commit `ae188ba9d39264ff4b981dc745b7a1daafd70c20`; root verified exactly53 source plus14 reviewed documentation paths, correct feature branch, empty index, preserved original work and isolated memory DI hunk. No push. Known credit/Usage integration assigned explicitly to Task3.6. No live provider/deployment claim.

**Current handoff:** Task3.4 delivered at `ae188ba9d39264ff4b981dc745b7a1daafd70c20`; cleanup implementation now owns the demo boundary. Task3.6 retains the explicit known-credit/Usage follow-up; Task6.2/6.3 retain approved persisted-skill snapshot/clone integration.

**Description:** Implement admin preview/publish of a sanitized versioned example and a single-click Try demo flow that enters its private editable copy.

**Subtasks:**

- [x] Snapshot only approved public files/tasks/facts/skills; omit private histories, identifiers, secrets, and audit data.
- [x] Clone with new owner/resource IDs and staged bounded file copying; recover interrupted provisioning without duplicate credits/copies.
- [x] Add Try demo, expiry/credit banner, View showcase, and backend denials for showcase edits/chat/skills/jobs/tool mutations.

**Definition of Done:**

- [x] Two browser sessions have independent copies; protected showcase rejects direct API/tool mutation; existing demos do not change when the operator publishes a new version.
- [x] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [x] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [x] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 4.3, 5.3, 6; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs.

---

### Task 3.5 â€” Expire and clean up demos safely

**Status:** `[x]`
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
- `Current status:` Cleanup implementation and migration0034 exercised by guarded PostgreSQL1suite2tests PASS: expired-owner finalization, status-only replay, preserved regular/admin/showcase/counters, pending root-effect barrier, persisted restart/resume and exact managed child removal. Same-process preguard and fresh-process postguard verified base identity and zero target DBs. Developer Ready: focused3suites15tests and backend typecheck PASS, exact manifest/self-review/validation receipt complete. Independent QA cycle1 found a High blocker: settled credit usage owner FK prevents final demo-user deletion; current PG fixture omits this normal usage case. Official QA cycle1 FAIL recorded; architect approved terminal ledger retention via nullable owner columns and explicit locked detach, preserved FK actions, no late policy-lock inversion, null-owner terminal replay handling. Developer repair Ready for QA2: retained terminal ledger rows with detached owners, inflight/unknown barriers, null-owner replay handling. Focused15unit tests and guarded PostgreSQL3/3 PASS with migration0034 and fresh separate identity/zero-target postguard. Current shared backend typecheck fails only on concurrent4.3 WIP; not claimed PASS. Independent QA cycle2 PASS: focused15tests rerun, guarded PG3 reviewed and credit retention/lock/replay repair verified; cycle1 history retained. Delivered local commit `57a477f060e3c4a2ffb11fd01f3d6d4a983c4db1`; root verified exactly14 source plus9 safe docs=23paths, isolated cleanup-only composition and0034 registry hunks, empty index and preserved foreign/protected work. Exact staged-snapshot backend typecheck PASS resolves the task-owned compile gate; shared4.3 worktree failure remains explicit. No push.

**Description:** Use a durable PostgreSQL-backed cleanup worker with ownership manifests and retryable phases. Expiry denies access immediately, independently of deletion lag. Include expired pending and failed admission owners from Task3.3: key replay never resumes bootstrap or recovers a session; durable restartable cleanup is their recovery path.

**Subtasks:**

- [x] Cancel demo jobs/runs and recheck expiry before every promotion/download; handle late callbacks.
- [x] Purge owned DB content, roots, recovery copies, exports, sessions, and sandbox resources with resolved-path checks.
- [x] Retry partial failures; record cleanup lag and backup/provider retention limitations; exclude published showcases and all regular users.

**Definition of Done:**

- [x] Expiry/run races cannot write after expiry; worker restart completes partial cleanup; fixture tests prove regular and showcase data are untouched.
- [x] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [x] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [x] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 6, 11; completed dependency outputs.

---

### Task 3.6 â€” Build account, quota, and demo administration UI

**Status:** `[x]`
**Agents:** designer-ui-ux, developer, tester
**Depends on:** 3.4, 3.5
**Risk:** High: privileged actions and secrets
**Contract:** `.codex/docs/hackathon-release/task-3-6-admin-portal/contract.md` (implemented; developer-owned)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Admin create/edit/disable/usage journeys, non-admin rejection, validation/errors, keyboard/mobile layout
- `Chrome DevTools MCP:` Network inspection for secret leakage and privilege enforcement
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-3-6-admin-portal/artifacts/`
- `Current status:` Delivered at `84b983b145eb2b9b9968e292360862d16f14c50d` after independent QA cycle2 PASS. QA1 High campaign identity bug repaired; targeted independent repository/OpenAPI8/8 PASS. Prior guarded0037PG1/1, focused units, build and mock-browser proof retained with scope limits. Isolated staged backend/frontend app TypeScript PASS; Node config inputs are unchanged from prior node-project checks. Root verified exact60paths(49source+11docs), branch, empty index, correct artifacts layout and task-only shared hunks. Local unpublished location-only amend preserved source content. Mobile/keyboard-only proof remains accepted Low; no live provider claim.

**Delivered commit:** `84b983b145eb2b9b9968e292360862d16f14c50d` (independent QA2 PASS; root verified60paths; source checks PASS).

**Description:** Provide protected admin account management and usage views backed by admin-only APIs. Include configurable demo budgets and publishing controls.

**Subtasks:**

- [x] Create/list/search accounts, disable/revoke, reset initial credentials securely, and protect last-admin availability.
- [x] Edit daily/lifetime/storage limits; show totals, reservations, exhaustion, and limit-below-usage outcomes.
- [x] Configure demo limits/expiry/global pause; record sensitive-action audit metadata without secrets.
- [x] Connect the existing private-demo banner to the owner-scoped credit/availability read model and real Usage view: known remaining credits, exhausted/global-paused/unknown reasons, and disabled AI with manual editing preserved. Do not expose admin totals or link to an unavailable view.

**Definition of Done:**

- [x] Non-admin direct API access is denied; no existing password/key is exposed; limit changes affect new admissions and active runs at defined boundaries.
- [x] Private-demo credit/Usage banner and AI controls reflect authoritative known/exhausted/paused/unknown state; unknown/paused/exhausted AI is disabled while permitted manual edits remain usable. This completes the explicit Task3.4 unknown-state integration follow-up before user review.
- [x] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [x] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [x] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 4.3, 7.3; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs.

---

## Epic 4. Automatic execution and canonical task mutations

### Task 4.1 â€” Replace per-turn consent with workspace-scoped automatic execution

**Status:** `[x]`
**Agents:** designer-ui-ux, developer, tester
**Depends on:** 2.2, 3.1, 3.2
**Risk:** Critical: policy bypass or unintended tool scope
**Contract:** `.codex/docs/hackathon-release/task-4-1-stored-tool-policy/contract.md` (implemented, independently verified, and committed)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` Home and workspace chat automatic execution, blocked-scope and provider-unavailable states
- `Chrome DevTools MCP:` Network review of context egress and exposed credentials
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-4-1-stored-tool-policy/artifacts/`
- `Current status:` Final independent tester PASS in qa-report.md with the user-accepted Low viewport/test debt recorded in Tech Debt Log. Implementation, contract, self-review, 152-path source mirror and protected three-line isolation verified. Backend151/902, frontend58files298tests, OpenAPI3suites5tests, PostgreSQL3suites6tests, Linux48 and typechecks PASS; broader evidence retained. Recovery exact1/1 and full2/2 PASS; six-spec preview17/18 remains explicit, while native Tab/Ctrl+Enter prove functional submit access. Delivered commit `4f9ad9bddf227f53b7c55db237cc4a9a8d716846` on `feature/automatic-assistant-tools`; root verified152 exact source paths plus32 safe snapshots, protected3-line delta, and preserved unrelated work. No push. No live provider/public HTTPS/scheduler proof claimed.

**Description:** Implement stored provider/context/tool policy and remove routine approval gates in both Home and workspace execution paths while retaining containment.

**Subtasks:**

- [x] Map every provider-consent/proposal/command gate; replace automatic-path transitions consistently in runtime, API, events, and UI.
- [x] Keep selected-context exclusions, protected paths, egress restrictions, sandbox command bounds, and promotion/hash/backup checks.
- [x] Show active provider and included scope; block unsupported/out-of-policy actions clearly rather than granting broad fallback access.

**Definition of Done:**

- [x] Authorized chat reads/writes run without approval clicks; excluded files, foreign workspaces, host paths, admin actions, and forbidden destinations remain blocked.
- [x] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [x] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [x] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 5.2, 12; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs.

---

### Task 4.2 â€” Execute Home task and workspace actions through canonical use cases

**Status:** `[x]`
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
- `Current status:` Developer Ready for independent QA: provenance DTO/OpenAPI/UI and architect-approved exact stale-version conflict result implemented. Focused Jest5suites31tests, bridgePython23tests, Vitest4files24tests, Playwright3tests, backend/frontend typechecks and preview build PASS. Initial browser2/3 drawer-after-reload assumption retained; corrected test reopens Ask and final3/3 passes. Canonical summary/self-review/exact manifest and safe synthetic PNG/JSON present. Independent QA PASS: reran31Jest/23Python/24Vitest, reviewed final3browser and unchanged prior guarded PG transaction/replay proof; Low live-status refinement logged. Delivered local commit `00e40200ad40ddda73605295b151f42e90466690`; root verified exact25source plus12safe docs=37paths, receipt-only OpenAPI hunk, correct feature branch, empty index and preserved protected/foreign changes. No push. No live provider claim.

**Description:** Replace routine proposal acceptance with direct typed tool execution for user-requested in-scope actions, preserving receipts and version checks. Architecture preflight is complete in `task-4-2-direct-home-actions/architecture-preflight.md`; developer contract/source-map and task-scoped receipt UI spec are complete, and developer_direct_actions_luna now owns the refreshed contract and application implementation. Tasks4.1,3.4,5.1 are delivered; memory prompt and demo cleanup files have separate owners. No runtime evidence claimed yet.

**Subtasks:**

- [x] Reuse task/workspace mutation handlers; derive principal on the server and require clear targets.
- [x] Add idempotent operation keys, actual assistant actor/source labels, conflict handling, and partial-failure receipts.
- [x] Keep Activity useful and require clarification only for ambiguous targets; deny showcase/admin policy changes.

**Definition of Done:**

- [x] Repeated tool delivery cannot duplicate mutations; automatic actions are not labeled accepted by user; every applied change has an accurate receipt.
- [x] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [x] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [x] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 5.2, 10; completed dependency outputs.

---

### Task 4.3 â€” Unify task deletion and remove archive behavior

**Status:** `[x]`
**Agents:** developer, tester
**Depends on:** 4.2
**Risk:** High: deletion, provenance, and historical data
**Contract:** `.codex/docs/hackathon-release/task-4-3-task-delete-migration/contract.md` (implemented; developer-owned)

**MCP Inputs & Required Evidence:**

- `Playwright MCP:` N/A
- `Chrome DevTools MCP:` N/A
- `Context7:` N/A

**Evidence Collected:**

- `Artifacts folder:` `.codex/docs/hackathon-release/task-4-3-task-delete-migration/artifacts/`
- `Current status:` Delivered at `9b4a05dbfbad66535695d6d4b70731c9a62c5c6d` after independent QA PASS. Focused backend/frontend units and guarded migration1/1, Home parity5/5, ownership2/2 evidence pass; replacement non-DB integration4suites14tests passes. Isolated staged backend and both frontend typechecks PASS after excluding an admin-only fixture hunk. Root verified exact85paths, branch, empty index, task-only shared hunks and preserved foreign/protected work. Original failed attempts remain documented. Accepted Low stale OpenAPI archived prose and seven pre-existing unrelated413 omissions remain logged.

**Delivered commit:** `9b4a05dbfbad66535695d6d4b70731c9a62c5c6d` (independent QA PASS; root verified85paths and isolated typechecks).

**Description:** Unify assigned/unassigned task deletion and remove archive across public schemas, tool commands, filters, and domain transitions.

**Subtasks:**

- [x] Preserve legacy archived tasks through documented done/todo conversion with rollback mapping.
- [x] Reconcile ordering, subtasks, suggestion references, action-ledger replay/undo, versions, and idempotent deletion.
- [x] Remove stale archive callers/fixtures/contracts and ensure undo cannot resurrect deleted tasks.

**Definition of Done:**

- [x] Existing archived task content survives migration; rootless/project tasks delete correctly; stale deletes conflict; no supported API/tool can archive or resurrect a deleted task.
- [x] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [x] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [x] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 4.2, 11; completed dependency outputs.

---

## Epic 5. Workspace-first UI and task editing

### Task 5.1 â€” Move Home assistant into a floating Ask panel

**Status:** `[x]`
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
- `Current status:` Developer Ready: persistent shell-mounted Home Ask with12-path exact manifest, self-review and dev-summary.md. Focused27/27 Vitest, frontend typecheck/build, and one synthetic desktop/mobile keyboard/history/draft/navigation journey PASS. Initial nested-menu focus bug fixed; minor mobile title wrapping accepted as Low debt. Canonical screenshots, browser JSON and honest first-failure note stored. Independent tester PASS in qa-report.md: rerun27/27 units and one active-run cancellation/status browser case1/1; reviewed developer final typecheck/build and desktop/mobile core journey. Two expected pre-auth401 resource messages explicitly recorded; no page errors/external calls. Internal-widget usage documentation exception and Low mobile title debt recorded. Delivered commit `1d22db9fe9f3fb67ac05eddf199952dadf2a5fb3` on `feature/automatic-assistant-tools`; root verified exactly12manifest source paths and13reviewed docs/tracker paths, zero unexpected/missing paths, empty index, and original protected paths still unstaged. No push. No live provider claim.

**Description:** Recompose existing home-chat/history features into a shell-mounted widget and remove the dominant Home chat block.

**Subtasks:**

- [x] Add bottom-right icon/Ask launcher, panel header history dropdown and New conversation.
- [x] Preserve drafts/active runs across close/reopen and navigation; show target workspace scope.
- [x] Implement desktop panel/mobile sheet, keyboard focus restoration, overflow and streaming states.

**Definition of Done:**

- [x] Workspaces/tasks remain primary; any conversation is reachable within two clicks from an open panel; closed helper does not obstruct controls.
- [x] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [x] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.

**Upstream Outputs Needed:** Architecture sections 4.1; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs.

---

### Task 5.2 â€” Replace Inbox emphasis with Add task and View all

**Status:** `[x]`
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
- `Current status:` Developer implementation/dev-summary/screenshots complete. Focused Vitest38/38, previewAPI26/26, frontend typecheck and7 Playwright preview journeys PASS. Independent tester PASS in qa-report.md; independent38unit/2browser checks reproduced,320px smoke. Delivered commit `fdb200dc23eb83a1047f138ccdd8f7316f3855b1`; identity-only helper lines excluded safely from index and preserved unstaged.

**Description:** Move compact task capture into Up next and make All tasks the destination for browsing/filtering, retaining unassigned tasks.

**Subtasks:**

- [x] Reuse task-capture/global-task-query slices and optional workspace selection.
- [x] Remove prominent Inbox block/navigation emphasis without deleting task records.
- [x] Cover empty, loading, error, and long-list states.

**Definition of Done:**

- [x] User can add assigned or unassigned tasks from Home and find existing Inbox tasks in All tasks.
- [x] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [x] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.

**Upstream Outputs Needed:** Architecture sections 4.2; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs.

---

### Task 5.3 â€” Open task details editable with Save and dirty-exit protection

**Status:** `[~]`
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
- `Current status:` Independent QA cycle2 PASS; QA1 pending-delete gap resolved/history retained. Tester independently reran15/15 focused route tests; both frontend types PASS. Previous2/2route-stub browser/build evidence is explicitly pre-repair. All requested editor behavior verified within documented scope. Scoped local commit/root audit pending; stop after delivery.

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

### Task 5.4 â€” Audit spacing, responsiveness, and accessibility across release screens

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

### Task 6.1 â€” Make memory and selected context visibly control future runs

**Status:** `[x]`
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
- `Current status:` Task-scoped UI specification complete at task-6-1-memory-context/ui-spec.md. Developer contract/source-map and surgical architecture-preflight.md complete. developer_memory_luna owns selected-fact/context UI/API and scoped Home memory reader/prompt implementation, including only the approved SubmitHomeTurnUseCase DI hunk in composition-root.ts. Global Home stays memory-free; selected facts for planning-only workspace conversations come from persisted owner/project scope. Focused backend26tests/typecheck and frontend15tests/typecheck PASS; one selected guarded PostgreSQL case PASS with fresh base/zero-target postguard in project-fact-storage-quota.integration.spec.ts. Synthetic planning-only Memory to fresh-context browser journey PASS. Independent tester PASS: backend3suites26tests plus existing file-backed4tests, frontend2files15tests and both typechecks; guarded PG and synthetic browser evidence reviewed. Accepted Low selector exception and wording debt are explicit in Tech Debt Log. Delivered local commit `633cbeecd934ddd0e1042441158f91ca5e98435e`; root verified exactly20 source plus11 reviewed docs paths, isolated callback composition hunk, correct feature branch, empty index and preserved protected/foreign work. No push; no live provider claim.

**Description:** Reuse project facts and context selection to expose remembered preferences, their source, and inclusion in future runs.

**Subtasks:**

- [x] Ensure new chats load permitted persisted facts and selected notes rather than relying on old transcript state.
- [x] Provide add/edit/delete/include controls and explain effects on future versus past/provider context.
- [x] Add concise storage/cloud-provider disclosure in account/workspace settings.

**Definition of Done:**

- [x] An edited preference changes a fresh chat's permitted context; deletion/exclusion prevents later inclusion; foreign facts never enter prompts.
- [x] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [x] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [x] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 8, 11, 12; Task 1.1 ui-spec.md and relevant task contracts; completed dependency outputs.

---

### Task 6.2 â€” Persist editable user skills with bounded invocation

**Status:** `[x]`
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
- `Current status:` Delivered at `ddc2a355f6f3886048433cea7a6a28de08891261` after independent QA PASS. All16selected Jest suites have passing evidence after a stale SQL expectation repair;2Vitest compatibility tests, backend and both frontend typechecks PASS. Guarded PostgreSQL skill suite2/2 and filtered pinned clone1PASS/4intentional skips, fresh guards clean; failed attempts remain in verification receipt. Isolated staged backend/frontend checks PASS. Root verified exact65paths, correct branch, empty index and preserved unrelated work. Existing0027 workspace purge semantics retained; surviving bound turns deny missing sources. Accepted Low UTF16 title-length friction logged. Visible editor/picker/public cards remain Task6.3; no live provider claim.

**Delivered commit:** `ddc2a355f6f3886048433cea7a6a28de08891261` (QA PASS; root verified exact65paths/branch/emptyindex/protectedwork; isolated backend and both frontend typechecks PASS).

**Description:** Add account/workspace skill definitions and versioned invocation while reusing bundled runtime skills and existing AI orchestration.

**Carry-forward integration:** Task3.4 intentionally omitted skills while no persisted user-skill source existed. Resolve its approved-skill snapshot/clone allowlist against this schema and track the corresponding read-only/publishing UI under Task6.3; do not silently copy source owner IDs, policies, or runtime-only SKILL.md files.

**Subtasks:**

- [x] Implement owned skill CRUD/enable/version semantics and seed Plan my day/Daily briefing templates.
- [x] Snapshot selected skill version/context; intersect declared tools with existing capabilities.
- [x] Account for instructions/results in storage and all model calls in usage.

**Definition of Done:**

- [x] Edited skills persist and run with recorded versions; malicious instructions cannot widen scope; disabling/deleting a referenced skill has defined scheduler behavior.
- [x] Relevant common DoD checks pass; developer self-review and tester verdict recorded.
- [x] Required evidence stored and linked, or tool unavailability plus equivalent evidence documented.
- [x] Developer-owned contract implemented and verified before task closure.

**Upstream Outputs Needed:** Architecture sections 8, 10; completed dependency outputs.

---

### Task 6.3 â€” Expose editable skills and a working Plan my day flow

**Status:** `[~]`
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
- `Current status:` Checkpointed for user-requested stop. UI spec/preflight/contract complete; four backend summary-projection files drafted. Home wiring and frontend skills/publisher/results remain unfinished. No6.3checks run; NOT Ready for QA. See dev-summary.md.

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

### Task 6.4 â€” Add bounded portable workspace export and usage settings

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

### Task 7.1 â€” Implement durable daily schedules and job claiming

**Status:** `[~]`
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
- `Current status:` Checkpointed for user-requested stop. Final scheduler PostgreSQL4/4 PASS includes fresh child-worker poll1/invoke0 reconciliation and repository-connection fencing. Filtered cleanup remains FAIL: cancelled occurrence but purging/storage barrier. Wrapper quoting failure and subsequent successful fresh independent postguard are recorded; fixture databases absent. NOT Ready for QA; remaining work preserved.

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

### Task 7.2 â€” Produce and persist useful daily briefings

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

### Task 7.3 â€” Add schedule controls, Run now, and run history

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

### Task 8.1 â€” Prepare persistent host, proxy, worker, and migration deployment

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

### Task 8.2 â€” Verify trusted HTTPS and real NVIDIA inference on public topology

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

### Task 9.1 â€” Validate security, concurrency, restart, and complete user journeys

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

### Task 9.2 â€” Package showcase, operator runbook, and judge walkthrough

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

**Upstream Outputs Needed:** Architecture sections 1, 12â€“14; completed dependency outputs.

---

## Progress Summary

| Task | Status | QA verdict |
| --- | --- | --- |
| 1.1 â€” Confirm baseline and define screen states | `[x]` | PASS; `721f0f26011147437f9d24c4749431169b309ad1` |
| 2.1 â€” Migrate local identity to regular, admin, and demo accounts | `[x]` | PASS; `d696550acddceac3a641584c1fe5f3fb52ad42bd` |
| 2.2 â€” Enforce ownership across APIs, tools, storage, and streams | `[x]` | PASS; `6fb7278bc680a0df11e3f6e6cb8bd03a0090cb7c` |
| 3.1 â€” Implement atomic credit reservations and runtime metering | `[x]` | PASS; `9b65d3c5b5906cb63033fed7bc2053e587d925b9` |
| 3.2 â€” Enforce account storage limits on every persistent write | `[x]` | PASS; `b5d40315680b73afac3e04c1a52b8ceaba83a1bf` |
| 3.3 â€” Provision private one-click demo identities | `[x]` | PASS; `3f4adabbe22a8303406cea9e4441b3e987f605d3` |
| 3.4 â€” Publish a protected showcase and open editable demo copies | `[x]` | PASS; `ae188ba9d39264ff4b981dc745b7a1daafd70c20` |
| 3.5 â€” Expire and clean up demos safely | `[x]` | PASS; `57a477f060e3c4a2ffb11fd01f3d6d4a983c4db1`; isolated types PASS |
| 3.6 â€” Build account, quota, and demo administration UI | `[x]` | PASS; `84b983b145eb2b9b9968e292360862d16f14c50d`; Low browser evidence debt |
| 4.1 â€” Replace per-turn consent with workspace-scoped automatic execution | `[x]` | PASS; `4f9ad9bddf227f53b7c55db237cc4a9a8d716846`; accepted Low viewport/test debt |
| 4.2 â€” Execute Home task and workspace actions through canonical use cases | `[x]` | PASS; `00e40200ad40ddda73605295b151f42e90466690`; Low live-status refinement logged |
| 4.3 â€” Unify task deletion and remove archive behavior | `[x]` | PASS; `9b4a05dbfbad66535695d6d4b70731c9a62c5c6d`; Low OpenAPI prose debt |
| 5.1 â€” Move Home assistant into a floating Ask panel | `[x]` | PASS; `1d22db9fe9f3fb67ac05eddf199952dadf2a5fb3` |
| 5.2 â€” Replace Inbox emphasis with Add task and View all | `[x]` | PASS; `fdb200dc23eb83a1047f138ccdd8f7316f3855b1` |
| 5.3 â€” Open task details editable with Save and dirty-exit protection | `[~]` | QA2 PASS; scoped local commit/root audit pending, then stop |
| 5.4 â€” Audit spacing, responsiveness, and accessibility across release screens | `[ ]` | Pending |
| 6.1 â€” Make memory and selected context visibly control future runs | `[x]` | PASS; `633cbeecd934ddd0e1042441158f91ca5e98435e`; accepted Low selector debt |
| 6.2 â€” Persist editable user skills with bounded invocation | `[x]` | PASS; `ddc2a355f6f3886048433cea7a6a28de08891261`; Low title-length debt |
| 6.3 â€” Expose editable skills and a working Plan my day flow | `[~]` | Checkpointed incomplete; contract and draft summary projection, no checks |
| 6.4 â€” Add bounded portable workspace export and usage settings | `[ ]` | Pending |
| 7.1 â€” Implement durable daily schedules and job claiming | `[~]` | Checkpointed incomplete; scheduler4/4 PASS, cleanup storage failure unresolved |
| 7.2 â€” Produce and persist useful daily briefings | `[ ]` | Pending |
| 7.3 â€” Add schedule controls, Run now, and run history | `[ ]` | Pending |
| 8.1 â€” Prepare persistent host, proxy, worker, and migration deployment | `[ ]` | Pending |
| 8.2 â€” Verify trusted HTTPS and real NVIDIA inference on public topology | `[ ]` | Pending |
| 9.1 â€” Validate security, concurrency, restart, and complete user journeys | `[ ]` | Pending |
| 9.2 â€” Package showcase, operator runbook, and judge walkthrough | `[ ]` | Pending |

## Blocked Items and implementation-time inputs

Sixteen tasks are delivered as listed in Plan Summary. Remaining through the review boundary: 5.3, 5.4, 6.3, 6.4, 7.1, 7.2, 7.3. Current subagents use GPT-6 Luna with maximum reasoning. Preserve existing work; finish functional scope with focused checks, then stop before deployment8.x and acceptance9.x for user review.

- Task 8.1/8.2 needs the real deployment host/domain and DNS/certificate access. Do not claim the local self-signed setup fixes public browser trust.
- Credit enforcement requires actual provider pricing and a way to bound/meter all Hermes calls. Public AI access stays disabled if that cannot be established.
- Operator must choose demo allowance, global daily/campaign budgets, regular-account defaults, and retention periods before launch. Implement configurable fields without silently selecting production spending.
- Showcase publication requires the operator's intended example content; build the sanitization/preview flow first and keep any development example clearly identified.
- Browser/provider validation needs working runtime and available test credentials; record missing evidence precisely, and do not mark acceptance tasks complete on source inspection.
- Existing repository Git status was unavailable under sandbox ownership checks during planning. No global Git configuration was changed; implementation should establish the current working-tree baseline using an appropriately scoped read.

## Tech Debt Log

- Task3.6 accepted Low evidence debt: mobile and keyboard-only admin/Usage browser journeys were not exercised. Desktop route-stub smoke, semantic source review, focused API/DB checks and typechecks passed; no claim of mobile/keyboard-only browser validation. Refine/check these later under the user priority for functional completion. Campaign identity High finding is repaired, not waived.

- Task4.3 accepted Low: `backend/openapi.json` project-task filter prose still mentions `archived`; schema and runtime accept only all/open/completed. Remove the stale description during later documentation refinement. No live archive path is enabled; independent QA PASS.

Accepted observations and follow-up work. The user priority update permits explicitly recorded Low visual/test debt; functional and security release gates remain required:

| Severity | Baseline finding | Required resolution / owner |
| --- | --- | --- |
| Medium | Workspace mutation filesystem test exceeded 5000ms during concurrent baseline run | Resolved evidence: tester serial rerun16/16 PASS, then Task2.1 full backend114 suites/685 tests PASS. Original timeout remains historical; normal integrated acceptance still applies. |
| Medium | Six guarded PostgreSQL suites / 16 tests skipped without isolated database URL | Resolved by Task2.1: isolated loopback55441 fixture, full PostgreSQL integration20 suites/81 tests PASS and final independent identity/migration2 suites/3 tests PASS. Baseline skips remain historical; future persistence tasks must run real PostgreSQL. |
| Medium | Default Compose boundary test expects NVIDIA key despite Hermes-default topology | Developer reconcile supported default/direct topologies and retain secret isolation in deployment tasks; resolve before release. |
| Medium | Task action rows touch metadata cards and mobile Back/action controls; editor title crowded by preview banner | Designer/developer address spacing under Tasks 5.3/5.4, verify desktop/mobile/keyboard. |
| Medium | Task5.2 QA preview-only smoke observed404 GET /api/v1/home/conversations?scope=home&limit=50 and saved-conversation error; cause unverified | Existing capture/All tasks journey unaffected. Reproduce/resolve preview history fixture under Task5.1 Ask/history; do not infer live API failure or whole-page console PASS. |
| Low | Task4.1 provider-permissions.preview.spec.ts initial disabled-Send viewport assertion fails at1280x720; six-spec run17/18, explicitly not green | User accepted minor visual/test debt on2026-10-19 to prioritize working flows. Normal fill+Tab reaches enabled Send at ratio1 desktop/mobile; Ctrl+Enter submits exactly once with no approval/decision calls. Optional initial-frame/test-scroll cleanup later by developer; no further pixel work blocks this task. Evidence: task-4-1-stored-tool-policy/artifacts/provider-submit-diagnosis/validation.md. |
| Low | Task5.1 mobile Ask title wraps across lines at narrow width | User accepted minor visual refinement later. Final390x844 sheet bounds and no-horizontal-overflow checks, keyboard/history/draft/navigation and focus restoration PASS. Optional frontend typography refinement after review; no core-flow blocker. Evidence: task-5-1-assistant-launcher/self-review.md and artifacts/home-ask-mobile-history-navigation.png. |
| Low | Task6.1 reused fact inclusion and selection reconciliation controls lack data-testid attributes | Accepted test-selector checklist exception: accessible labels/roles and focused unit/browser journeys verify operation. Optional selector additions later; no functional/accessibility claim waived. Controls: MemoryFactItem.tsx, ProjectMemoryManager.tsx and ProjectContextSettings.tsx. |
| Low | Task6.1 manifest describes a composition-root reader import although the remaining change is only the callback argument | Documentation wording only; no runtime defect. Resolved at commit preparation: canonical manifest/dev-summary and snapshots now correctly describe the callback argument only. |
| Low | Task4.2 receipt lookup says Checking receipt in a plain span without a polite live status | Accepted minor accessibility refinement: receipt fetching and final applied/source labels work; add role=status or aria-live=polite later so assistive technology announces the transient lookup state. No data, authorization or mutation gate is waived. |
| Low | Task4.3 focused storage-quota OpenAPI check finds seven Home/AI-run 413-response references already absent at baseline HEAD | Documentation/test drift outside task deletion; preserve the failing check and HEAD comparison in Task4.3 validation. Resolve retired-route expectations and active-route documentation during release validation. Task-owned project POST quota and canonical delete/archive schema checks must pass. |
| Low | Task6.2 skill title length uses UTF-16 code units while contract/database character limits count Unicode code points | Accepted edge-case input friction: titles containing astral characters can be rejected earlier than the documented120-character maximum. Validation remains safely bounded. Align code-point counting and add a boundary test during later refinement; no owner/capability/quota validation is waived. |

Do not defer account isolation, quota enforcement, expiry containment, trusted HTTPS, functional requested task/UX flows, or actual scheduled execution to meet a cosmetic launch date.

## Planning Deliverables

- [x] Architecture and requirement traceability written.
- [x] Dependency-ordered task list with ownership, contracts, evidence requirements, and acceptance checks written.
- [x] Task 1.1 implementation baseline and detailed UI specification (tester PASS; commit `721f0f26011147437f9d24c4749431169b309ad1`).
- [ ] All implementation and release verification tasks.



































