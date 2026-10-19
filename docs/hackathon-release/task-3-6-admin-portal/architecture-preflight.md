# Task 3.6 — Persisted admin settings authority preflight

## Change History

- 2026-10-19: Source-based decision for Task 3.6. Reuses the existing credit policy and account-limit rows; no runtime, migration, API, browser, or database validation was performed.

## Scope and decisions

Task 3.6 crosses the existing React app and backend. Frontend composition follows FSD; backend work stays in the current Clean Architecture modules. DDD and Hexagonal Architecture are excluded. No new framework or external library is needed, so Context7 was not consulted.

PostgreSQL is the only runtime authority for mutable demo settings. Migration 0037 should extend the existing singleton credit_runtime_policy row, not introduce a second settings table. The row already owns the global AI pause, demo daily and campaign budgets, campaign ID, demo concurrency cap, and shared revision. Add demo_default_daily_limit_units, demo_default_lifetime_limit_units, demo_session_ttl_hours, demo_global_admission_max/window_seconds, demo_network_admission_max/window_seconds, demo_run_start_max/window_seconds, and a demo_settings_bootstrapped marker there. Extend account_limits with limits_revision and demo_credit_limits_configured for compare-and-swap edits and fail-closed new accounts. Validate ranges and all-or-none admission fields in the application and database.

Canonical Task3.6 contract.md and artifacts/source-map.md are present under the workspace .codex/docs root; the initial app-local inspection did not locate them. This decision is based on the current Task3.1/3.2/3.3/3.5 contracts and source. The implementation developer must reconcile the canonical Task3.6 contract with this decision before code.

## Defaults and already-issued accounts

- A configured per-demo daily/lifetime allowance is a default for newly admitted demo accounts. Admission copies it into that account's existing account_limits row. Later changes to the default affect future demo accounts only.
- An admin edit to an existing account changes that account's account_limits values and is enforced by the next provider-call reservation. Keep null = unlimited and 0 = no AI spending. Add an explicit configured marker for new demo accounts so missing defaults fail closed instead of being interpreted as unlimited. Existing demo rows retain their current stored limits, including the existing documented meaning of null.
- Demo defaults, global spend caps, and admission limits are distinct settings. If a required setting is unconfigured or invalid, AI/admission fails closed as applicable; do not invent a numeric budget or silently convert missing data to unlimited. Demo browsing and manual edits remain available where current account rules permit.
- Session TTL applies only to newly created demo principals. Persist the exact expiry in the user, session, and admission rows. A settings update never extends or rewrites an issued expiry. Idempotency replay remains status-only and keeps the original admission, counters, allowance, and expiry.

## Bootstrap and runtime reads

On first startup after migration, a short transaction locks credit_runtime_policy with FOR UPDATE, checks the bootstrap marker, and seeds only the TTL and the six abuse-window values from the already-validated application configuration. If the six fields are absent or incomplete, store them as unconfigured; mark bootstrap complete either way so a later environment change cannot silently replace a database-admin decision. Preserve existing global spend limits, pause, campaign identity, usage, and counters. Persist no network hash secret; it remains a server credential and the current key-ID overlap check stays in force.

After that one-time bootstrap, session creation, demo run-start admission, and provider-call reservation read current values from PostgreSQL on every transaction. Do not keep mutable settings in a process cache or inject environment values as runtime policy.

## Transactions and lock order

Reuse the established runtime order: credit_runtime_policy → users → account_limits → usage/window counters → reservation rows. Credit reservations already lock the singleton policy FOR UPDATE before the user and account limits; this is the serialization point for pause, global budget, concurrency, and per-account limit changes.

For new anonymous admission, preserve the current global/key advisory-lock and idempotency lookup order. After returning an existing-key status, read the current singleton policy under a short shared lock before touching admission counters or creating the new user. Use that same snapshot for the admission windows, TTL, and inserted account defaults. Keep the current global/network counters and window mismatch checks.

For per-demo run-start admission, read the policy row before locking the owner row, then take the per-owner advisory lock and update the existing run-start event rows. This makes configuration live across processes and avoids a users → credit_runtime_policy inversion against credit reservations.

Account-limit edits lock the policy row first, then the target user and account_limits; update only limit fields and the account revision, then append the audit record in the same transaction. Lowering a limit below current usage is allowed. Do not rewrite settled or reserved totals, daily windows, storage references, or reservations. A lower limit blocks new positive storage growth or new AI reservations when current usage plus reservations is already at/over the limit; existing work settles under its original reservation.

Demo-settings writes lock credit_runtime_policy FOR UPDATE, compare the submitted expected revision with the current revision, validate the whole update, write the fields together, increment the existing revision, and append a secret-free audit record atomically. Return the committed persisted snapshot. A stale revision returns a conflict and must not overwrite another admin's update.

Keep Task 3.5 cleanup ordering (demo_admissions → users → demo_showcase_copies) unchanged. Cleanup must never acquire credit_runtime_policy after admission/user locks; its existing user-row serialization is sufficient for reservation finalization. No transaction or row lock spans provider, filesystem, or other external I/O.

## Window, budget, and audit semantics

- A pause or budget edit serializes with provider reservation admission. Calls reserved before the settings transaction commits are already admitted; later reservations use the new policy. Do not claim an atomic relationship with a network send that occurs after reservation commit.
- Global demo daily usage remains in credit_demo_daily_windows on UTC boundaries. Campaign usage remains in credit_demo_campaign_usage. Editing a numeric cap checks the existing settled plus reserved amount; it never zeroes or recreates a window. Keep the active campaign ID stable during a budget edit. Any future campaign rotation must retain the old ledger and be an explicit audited operation.
- Admission max/window changes retain existing admission and run-start rows. The current live-window mismatch checks may temporarily fail closed until windows created under the old settings expire. Never delete, rewrite, or restart an active global/network/owner window to make a new value take effect sooner.
- Existing admin settings reads return persisted values and the policy revision. Admin account reads join current user status, account limits, credit settled/reserved totals, current daily usage, and storage totals. /usage and the demo banner consume one owner-scoped snapshot; it never accepts an owner ID from the client. Displayed availability is informational only: provider admission still checks the current database state.
- Use a small append-only admin audit table if no suitable one exists. Record actor, time, action, target, and whitelisted old/new limit fields. Passwords, provider keys, network secrets/hashes, request bodies, and user content never enter audit rows. Limit/policy mutation and its audit row commit or roll back together.

## Module boundaries

Frontend adds route-level page compositions for Admin and Usage, with account administration and demo settings kept in their owning feature slices. The Usage entity/read-model API is shared by the Usage page and existing demo banner. Keep the route guard as navigation only; the server enforces the persisted active admin role. Reuse the shared API client and current UI primitives; do not add a second global settings store.

Backend keeps controllers thin and places orchestration in use cases. A focused admin module may coordinate account actions and settings reads/writes through repository ports; the TypeORM adapter updates existing users, sessions, account_limits, credit_runtime_policy, credit/storage counters, and the new audit table. Credits remains the runtime admission authority, auth remains the session/password authority, and storage quotas remains the storage-accounting authority. Reuse the existing password hasher and opaque-session revocation behavior; do not introduce a new authentication framework.

For concurrent account changes, protect last-active-admin checks with one transaction-scoped admin-account mutation lock, then follow policy → user → account-limits ordering. Create regular accounts only; never expose admin promotion through this portal. Password reset stores only the established password hash and revokes sessions in the same transaction.

## Risks and limits

The one-time bootstrap intentionally stops environment variables from overriding database edits after first start. Deployment operators must configure missing admission windows through the admin settings surface or a controlled initial database bootstrap before new admissions are enabled. DEMO_NETWORK_HASH_SECRET remains deployment-managed and secret.

This is source inspection, not runtime proof. No PostgreSQL migration, cross-process race, API authorization, browser flow, or provider-send behavior was exercised here.
