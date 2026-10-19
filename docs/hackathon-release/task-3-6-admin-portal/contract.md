# Contract: Account, Quota, and Demo Administration (Task 3.6)

## Change History

- 2026-10-19: Reconciled with architecture preflight and implemented the account, owner usage, demo settings, and AI availability flows. Post-QA-cycle-1 repair makes configured campaign identity immutable through ordinary settings edits.

## Ownership

- Actor and owner come only from the authenticated opaque session. Admin routes require an active regular admin; request bodies never select actor, owner, or role.
- Auth owns password hashing, user identity and session revocation. Credits owns provider admission and shared credit policy. Storage quotas owns logical byte accounting. The admin module coordinates through these ports and its own repository.
- Cross-account reads expose only identity/status, aggregate quotas/usage, and bounded audit metadata. They never expose projects, files, conversations, prompts, password hashes, session tokens, network keys/hashes, provider keys, or content.

## Scope

- `/admin` supports account search/list/create, enable/disable, session revocation, password reset, limit editing, persisted demo settings, and safe recent changes. New accounts are regular users only; role promotion is unavailable.
- `/usage` and the private-demo banner use one owner-scoped authoritative snapshot. Credit failures and missing demo allowance configuration yield unknown/unavailable and disable AI controls. This reports budget admission only and does not claim provider readiness.
- Credit/storage limits are exact non-negative integer strings. `null` is unlimited; `"0"` is no AI spending. Existing use/reservations remain when limits are lowered; future positive storage writes or AI reservations are blocked when over limit. Existing reservations settle against their original cap.
- Existing demo account values are preserved, including the documented `null` semantics. New-demo defaults are copied into `account_limits` during admission and apply only to newly created demo identities. If defaults are missing, a new demo gets `demo_credit_limits_configured=false`, remains usable for manual edits where current storage rules allow, and cannot make an AI reservation.
- Extend the existing `credit_runtime_policy` singleton with `demo_default_daily_limit_units`, `demo_default_lifetime_limit_units`, `demo_session_ttl_hours`, `demo_global_admission_max`, `demo_global_admission_window_seconds`, `demo_network_admission_max`, `demo_network_admission_window_seconds`, `demo_run_start_max`, `demo_run_start_window_seconds`, and `demo_settings_bootstrapped`. Preserve its existing pause, shared daily/campaign caps and ID, concurrent-call limit, and revision. Extend `account_limits` with `limits_revision` and `demo_credit_limits_configured`.
- On first startup after the migration, lock the policy singleton and mark it bootstrapped after copying only the validated TTL and six admission values from existing environment configuration. Incomplete environment values remain unconfigured. Do not seed credit allowances, pause, budgets, campaign identity, or counters. Later process starts never overwrite the database.
- Demo settings writes replace the validated settings with compare-and-swap against the submitted policy revision. Per-account limit writes compare-and-swap against `limits_revision`. Both write safe audit metadata atomically with the changed values.
- Policy, pause, global-budget, concurrency and per-account changes serialize before provider reservations. Changes affect later admission only; already admitted work keeps its reservation. Demo defaults affect only new identities. TTL affects new identities only and never rewrites an issued expiry. Admission threshold changes preserve stored windows/counters; old live windows may fail closed until their recorded expiry. A campaign ID may be initialized only while the stored ID is null. After initialization, ordinary settings edits must retain that ID; changing or clearing it returns 409 DEMO_CAMPAIGN_ID_IMMUTABLE. Cap edits keep using the same campaign ledger and do not reset counters.

## Endpoints / Events

All routes use the existing `{ data, error }` envelope and `/api/v1` mounting.

- `GET /api/v1/admin/accounts?search=` — admin-only bounded account search with status, role/kind, limit revision, daily/lifetime credit totals and reservations, and logical storage totals/limit.
- `POST /api/v1/admin/accounts` — create a regular user from display name, identifier, and initial password; server hashes the password and creates required account-limit rows.
- `PATCH /api/v1/admin/accounts/{accountId}/limits` — compare-and-swap replacement of daily credit, lifetime credit, and storage limits.
- `PATCH /api/v1/admin/accounts/{accountId}/status` — enable/disable. Disable revokes sessions and preserves the existing atomic last-active-admin protection.
- `POST /api/v1/admin/accounts/{accountId}/password-resets` — accepts a new password only, hashes it, and revokes all target sessions atomically.
- `POST /api/v1/admin/accounts/{accountId}/session-revocations` — revoke all target sessions.
- `GET /api/v1/admin/demo-settings` — read persisted settings, policy revision, and current shared demo daily/campaign settled+reserved totals without exposing other users.
- `PUT /api/v1/admin/demo-settings` — replace validated defaults, TTL/admission thresholds, existing global caps/concurrency, and pause using expected policy revision; no counter reset/rotation.
- `GET /api/v1/admin/audit?limit=` — return a bounded recent list of safe metadata changes.
- `GET /api/v1/account/usage` — session owner only; return account daily/lifetime credit usage, existing storage snapshot, reset metadata and budget admission state.

All admin writes require same-origin and the existing CSRF token. GET routes require a session but no CSRF token. Usage has no owner ID parameter. The UI hides admin navigation from regular users, and server routes independently enforce admin role.

## Request Shapes

- Create: `{ "displayName": string, "identifier": string, "password": string }`; role is always `user`.
- Limits: `{ "expectedRevision": number, "dailyCreditLimitUnits": decimalString|null, "lifetimeCreditLimitUnits": decimalString|null, "storageLimitBytes": decimalString|null }`.
- Status: `{ "enabled": boolean }`.
- Password reset: `{ "password": string }`; never echoed, logged, or audited.
- Demo settings: `{ "expectedRevision": number, "defaultDailyLimitUnits": decimalString|null, "defaultLifetimeLimitUnits": decimalString|null, "sessionTtlHours": integer|null, "globalAdmissionMax": integer|null, "globalAdmissionWindowSeconds": integer|null, "networkAdmissionMax": integer|null, "networkAdmissionWindowSeconds": integer|null, "runStartMax": integer|null, "runStartWindowSeconds": integer|null, "maxConcurrentCalls": integer, "globalDailyLimitUnits": decimalString|null, "campaignId": string|null, "campaignLimitUnits": decimalString|null, "inferencePaused": boolean }`.

Bodies are strict. Bigint values are decimal strings. Admission values are all-or-none, positive and bounded; TTL is 1–24 hours. Campaign ID and campaign limit must be both set or both null. A non-null stored campaign ID is immutable through this endpoint; null-to-configured initialization is allowed. Admin must keep at least one of the two demo per-identity defaults finite before marking future demos configured; a null field means that one allowance is unlimited.

## Response Shapes

- `GET /admin/accounts` returns `{ accounts: AccountSummary[] }`. Each summary contains opaque account ID, display name, identifier or null, account kind/role/status, `limitsRevision`, daily/lifetime `{ limitUnits, settledUnits, reservedUnits, remainingUnits }`, storage `{ state, usedBytes, reservedBytes, limitBytes, overLimit, asOf }`, and `canDisable` with an optional safe reason.
- Demo settings return the full persisted settings, `revision`, `demoSettingsBootstrapped`, reset timezone (`UTC` for shared demo daily budget), and current shared settled/reserved usage. Unconfigured values are null and labeled unconfigured; they are never replaced with sample values.
- Owner usage returns owner daily/lifetime `{ limitUnits, settledUnits, reservedUnits, remainingUnits, resetAt, timeZone }`, existing storage DTO, expiry when applicable, and `{ status: available|exhausted|paused|unknown, reason, canSubmit }`. `canSubmit` is false for paused, exhausted, missing demo credit configuration, or unavailable accounting.
- Account/audit/usage payloads include no credentials, secret request data, provider readiness claim, filesystem path, or cross-owner resource content.

## Validation and Error Cases

- `400 VALIDATION_ERROR` for invalid identifiers, labels, passwords, integer strings, bounds, partial admission fields, campaign pairing, unknown fields, or malformed revisions.
- `401 SESSION_UNAUTHENTICATED` for missing/expired/revoked sessions; `403 ADMIN_REQUIRED` for non-admin sessions.
- 404 ACCOUNT_NOT_FOUND for an unknown target; 409 ACCOUNT_IDENTIFIER_CONFLICT for a duplicate identifier; 409 LAST_ACTIVE_ADMIN for disabling the final active admin; 409 ADMIN_REVISION_CONFLICT for stale settings or account-limit revisions; 409 DEMO_CAMPAIGN_ID_IMMUTABLE when an ordinary demo-settings update changes or clears an already configured campaign ID.
- `503` generic policy/usage unavailable errors fail closed. Client treats failed usage reads as unknown and disables AI submission.
- Disabled accounts cannot authenticate or reserve new provider calls. External calls already dispatched may finish; subsequent dispatch/output boundaries keep using existing persisted active-principal checks.

## Versioning / Compatibility Notes

- Additive `/api/v1` API. Existing auth, storage, credit, and demo endpoints retain their request/response shapes. `backend/openapi.json` records the Task 3.6 routes, DTOs, auth/CSRF requirements, and documented error cases; `backend/src/openapi/admin-portal-openapi.spec.ts` checks route presence and referenced shapes.
- Migration `1710000037000` adds the policy and account-limit fields plus the secret-free audit table. The working tree registers it after migrations `0035` and `0036`; the shared registry hunks remain separately owned for staging.
- Migration marks existing demo credit limits configured without changing their stored values; regular rows preserve existing unlimited semantics. New demo admission copies configured defaults and marks the new account configured, or sets marker false when defaults are absent.
- Policy bootstrap is one-time and persistent. No process-local runtime policy cache; each admission reads the current database row under the prescribed lock order.
- Frontend route guards only control navigation. Server-side session/role checks remain mandatory. Manual edits stay governed by existing storage limits while AI submission reflects owner usage status.

## Open Questions

- None. Lock order, bootstrap inputs, existing/new account effects and window compatibility follow `.codex/docs/hackathon-release/task-3-6-admin-portal/architecture-preflight.md`.
