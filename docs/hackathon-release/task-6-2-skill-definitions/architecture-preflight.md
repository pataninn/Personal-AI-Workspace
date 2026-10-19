# Task 6.2 Invocation Architecture Preflight

**Status:** Decision for the Task 6.2 backend implementation; source inspection only. This is not runtime or QA evidence.

## Scope and baseline

Task 6.2 adds persisted user skills and bounded invocation to the existing Home assistant. It is backend-only: no new frontend slice is part of this task. Apply Clean Architecture in `skills` and keep Home orchestration in its existing use cases. DDD and Hexagonal Architecture are excluded because this change fits the current modular monolith and ports. No new library or vendor API is needed; Context7 is not required.

This decision follows release architecture sections 8 and 9 and the Task 6.2 contract. Existing code establishes three relevant boundaries:

- `home-assistant/use-cases/submit-home-turn.ts` persists a Home message/turn, checks current policy and context, then calls the one runtime `start` boundary. It currently fingerprints the user message.
- `home-assistant/use-cases/get-home-turn.ts` polls runtime events and rechecks current Home/workspace policy around tool handling.
- `home-assistant/use-cases/home-planning-tool-request-handler.ts` maps registered tool names to the closed `AssistantToolCapability` set and executes the existing canonical use cases.

## Decision: bind invocation to the Home turn

Keep `POST /skills/:skillId/invocations` as an adapter into the existing Home turn path. The skills use case owns the invocation claim and immutable skill/context snapshot; `SubmitHomeTurn` remains the only start path. Do not build a second runtime or invocation framework.

Migration `1710000035000` adds the skill, immutable revision, and invocation records plus one nullable trusted `skill_invocation_id` binding on a Home turn. Make the binding unique so one invocation can bind to at most one turn. Ordinary Home turns keep it null. Persist the binding in the same Home-turn/message transaction that accepts the request, before `runtime.start`; also keep the invocation-to-turn lookup unique. This avoids the tool-event race that would occur if the link were written only after `SubmitHomeTurn` returns.

The client supplies the skill route, owned conversation, expected skill version, request, and idempotency key. The server loads the immutable revision and derives owner, workspace, declared capabilities, selected context, provider, and policy. The existing Home request fingerprint must include its current message identity plus the trusted invocation binding/revision/context snapshot. It must never include client-supplied policy or capabilities. Reuse the same `Idempotency-Key` for the invocation claim and Home submission.

## Claim, bind, and replay behavior

1. **Claim:** In a database transaction, create or retrieve the invocation by owner, conversation, and idempotency key. Store a canonical fingerprint, skill/revision IDs, and permitted context source IDs/revisions only. A matching retry gets the same claim; key reuse with a different fingerprint returns the existing conflict response (`409`).
2. **Bind:** For a new claim, recheck the current skill is enabled and still at the claimed version, the principal/workspace is active, and current Home/workspace policy permits execution. `SubmitHomeTurn` creates the message and a turn carrying `skill_invocation_id` atomically. A failure before `runtime.start` is a known no-send and records the existing safe failure outcome.
3. **Dispatch:** Immediately before `runtime.start`, recheck the current invocation binding, skill version/enabled state, policy, provider readiness, and permitted context snapshot. Context contents continue through the existing Home builder; the invocation retains only source IDs/revisions. Home scope stays memory-free; workspace facts remain governed by Task 6.1's selected-fact policy and fresh-snapshot check.
4. **Replay/recovery:** If no Home turn is bound, the exact claimed request may continue through the same Home idempotency key. If a turn is already bound, return/read that turn and never issue a second `runtime.start`. A crash after the bound turn is committed but before start/ack is ambiguous: existing interrupted-turn recovery/replay semantics resolve it conservatively as unknown. A possible-send `unknown` result stays unknown; a later skill edit, disable, or expiry must not relabel it known-no-send. A different request needs a new idempotency key.

The external start cannot be transactionally ordered with a later database edit. Treat the final current-state check as the admission point: a disable/edit/expiry committed before that check blocks dispatch; if the check passes first, later tool callbacks still recheck current state and deny further actions when it no longer permits them.

## Per-turn capability boundary

`GetHomeTurn` resolves the turn's persisted invocation binding and supplies its immutable declared capability ceiling to the existing Home tool handler. For each runtime tool request, the handler maps the tool name through its existing closed registry and allows execution only when all checks pass:

`registered tool capability ? invocation declaration n current persisted Home/workspace policy`

It also rechecks current principal/workspace eligibility and that the bound skill remains enabled at the invoked version. Unknown tools, unbound turns, mismatched/disabled skills, expired principals/workspaces, and disallowed capabilities fail closed. Model-visible global tools or skill/request text are untrusted and cannot widen this server-side gate. Keep existing canonical task/workspace use cases, policy expiry checks, exact conflict behavior, and stable action-ledger operation keys unchanged.

## Persistence and verification boundary

Count skill and immutable revision text through the existing logical storage accounting/projection path. Invocation metadata stores IDs, versions, revisions, status, and fingerprints only; user request and assistant output stay in existing Home message storage, and context values are not copied into invocation records. Keep Task 3.5 showcase/demo-copy ownership for publication and clone integration; Task 6.2 owns skill CRUD, migration 0035, invocation accounting, and the Home binding seam.

The minimal focused checks for the developer handoff are: an exact retry reuses the same claim/turn without a second runtime start; idempotency-key reuse with changed request or trusted invocation binding conflicts; a tool outside the declared/current-policy intersection is denied even if the model requests it; a pre-dispatch disable/version/expiry change produces known no-send; and a possibly-sent unknown remains unknown on retry. These are implementation checks, not evidence collected by this preflight.

**Relevant sources:** `.codex/docs/hackathon-release/architecture.md` sections 8–9; `.codex/docs/hackathon-release/task-6-2-skill-definitions/contract.md`; `Personal-AI-Workspace/backend/src/modules/home-assistant/use-cases/submit-home-turn.ts`; `.../get-home-turn.ts`; `.../home-planning-tool-request-handler.ts`; `.../repositories/home-conversation-repository.ts`; `Personal-AI-Workspace/backend/src/infrastructure/database/storage-content-accounting.ts` and `storage-content-projections.ts`.

## Migration 0035 foreign-key and retention decision

Drop only `FK_skill_invocations_owner_skill` and `FK_skill_invocations_skill_revision`; retain `skill_id`, `skill_revision_id`, and `skill_version` as immutable scalar references in invocation metadata. Add a direct `skill_invocations.owner_id -> users.id ON DELETE CASCADE` foreign key to preserve owner purge, and keep the existing conversation foreign key with `ON DELETE CASCADE`. Keep the Home-turn `skill_invocation_id` foreign key and unique index. Do not change workspace-to-skill or skill-to-revision cascades: hard workspace deletion must still remove the skill's revision text and must not wait on invocation history.

This separates invocation provenance from retained skill content. Soft deletion only sets `skills.deleted_at`, so revisions and invocation history remain joinable; the invocation is non-current and the tool gate denies further calls. An edit keeps prior immutable revisions, while their invocations become non-current. Hard workspace deletion follows the delivered 0027 ownership boundary: `FK_home_conversations_workspace_owner` cascades the workspace-scoped Home conversation, which purges its turns and skill invocations along with the skill/revision content. The skill revision bytes counted by `storage-content-accounting.ts` and `storage-content-projections.ts` are released, and no invocation payload duplicates instructions or results. Do not retain Home history or invocation metadata after a whole-workspace purge. Owner deletion and conversation deletion continue to cascade invocation metadata.

A non-null `skill_invocation_id` distinguishes a skill-bound turn from an ordinary Home turn only while that turn exists. After a normal whole-workspace purge, there is no surviving turn to reinterpret. If a non-null bound turn does survive while its invocation, skill, or revision is missing (for example, a partial/manual cleanup path), `findForTurn` must return no usable invocation and the existing tool gate must deny it; it must never become an ordinary unbound turn. Keep `ON DELETE SET NULL` on the Home-turn reference for existing invocation-only deletion behavior. Do not add a standalone invocation-delete path. A replay whose source rows are gone returns unavailable/denied rather than creating a fresh claim or redispatching under the occupied idempotency key.

This is the smallest change that preserves fail-closed handling for any surviving claimed turn while preserving delivered whole-workspace purge behavior, retaining version/context IDs only as operational metadata when their conversation still exists, and freeing deleted skill text from storage accounting. Migration rollback may continue refusing while invocation history remains; that is a rollback data-preservation guard, not a workspace-deletion blocker.

Quota treatment follows Task 3.2's existing content/metadata boundary; this decision creates no blanket quota exemption. Invocation fields remain bounded operational metadata (scalar IDs, hashes, status/timestamps, and at most 33 context revision references) and do not duplicate instructions, prompts, or results. Skill revision text and Home messages/results remain accounted by the existing content projection. If invocation records later gain variable content, that content must use the existing accounting path.

## Correction: delivered workspace purge semantics

The delivered migration `1710000027000-enforce-project-ownership-boundaries` adds `FK_home_conversations_workspace_owner` on `(owner_id, workspace_id)` to `projects` with `ON DELETE CASCADE`. Therefore the real project-delete path removes the workspace conversation, turns, and invocation rows together. The earlier assumption that a bound turn marker should survive whole-workspace deletion was incorrect and is superseded above. Preserve migration 0027 and normal purge semantics; do not add a history-retention feature or assert a marker remains after deleting the workspace.

Focused deletion coverage should assert the real project-delete path removes the workspace conversation, Home turns, and invocation metadata, releases accounted skill content, and leaves no orphan rows. Separately, ordinary turns with a null invocation binding retain normal Home behavior. The missing-source fail-closed rule applies only when a non-null bound turn actually survives; do not require a new framework or a fake delete API to exercise it.