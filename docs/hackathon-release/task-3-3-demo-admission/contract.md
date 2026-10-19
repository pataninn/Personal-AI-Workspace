# Contract: Private demo admission

## Change History

- 2026-10-19: Initial developer contract, based on `architecture-preflight.md` and the delivered identity, credit, and storage contracts. No app implementation is represented by this document alone.
- 2026-10-19: Clarified the run-start boundary after source precheck: validate permission, atomically transition ready to queued, then consume the per-owner demo start slot before publishing or dispatch. A refused slot conditionally aborts only the same queued start, restoring ready state and clearing its idempotency pair; a cancel/competing transition that wins first is not charged.

## Ownership

- `demo` owns anonymous admission, its fixed-window abuse counters, and the per-demo run-start rate port.
- `auth` remains the authority for opaque sessions, CSRF tokens, account status, and regular sign-in. Demo admission reuses the existing token provider, session cookie, session table, and session lookup.
- `storage-quotas` remains the authority for storage readiness. A newly created demo receives a session only after an owner-scoped empty-account check and successful `reconcileReferences(ownerId, [])`.
- `credits` remains the authority for AI spending, provider-call admission, reservations, and shared demo budgets. This task adds no balance and never unpauses inference.
- Task 3.4 owns protected showcase publication/copying and the gate that exposes an editable populated workspace. Task 3.5 owns expiry cleanup/removal. This contract defines only the identity/storage-ready state and does not claim either later workflow exists.

## Scope

- Add one passwordless demo principal per successful admission key, with a server-generated UUID and no login identifier, password, client-selected owner, expiry, credit, or path.
- Keep each admission for a fixed configurable lifetime (default 24 hours, maximum 24 hours). The database chooses the start timestamp; user, session, and cookie expiry are identical. A resume never renews it.
- Persist bounded, fixed-window global admission attempts, network admission counts, and demo run-start counts. The latter is keyed to the stable owner UUID, not a cookie or session.
- Trust `request.ip` only through Express's explicitly configured CIDR trust list. Do not parse forwarded headers in application code. Never store or log a raw IP, cookie, raw idempotency key, secret, or exception text.
- Keep non-AI account exploration independent from inference configuration. Missing, paused, or exhausted provider-credit settings do not block session admission; provider calls continue to fail closed under Task 3.1.

## Endpoints / Events

### `POST /api/v1/demo/session`

Exact same-origin `Origin` is required. A cookie-authenticated POST also requires the current `X-CSRF-Token`; the first anonymous POST has no CSRF token and relies on exact Origin validation plus the existing SameSite cookie policy. The route is mounted beside `/api/v1/auth` and uses the existing `{ data, error }` response envelope.

The request is a strict empty JSON object and requires `Idempotency-Key` for an anonymous admission. No other method or demo endpoint is added.

## Request Shapes

```http
POST /api/v1/demo/session
Origin: https://configured-app.example
Content-Type: application/json
Idempotency-Key: <43 base64url characters representing 32 random bytes>

{}
```

- Reject extra body fields. Validate the key against `^[A-Za-z0-9_-]{43}$`; hash it with SHA-256 before persistence. Never return or log the supplied value.
- If the existing cookie is a valid demo session, require CSRF and resume that exact session without counters, user/session creation, or expiry extension. The idempotency key is not needed on this path.
- If the existing cookie resolves to a valid regular account, require CSRF and return `409 DEMO_REGULAR_SESSION_ACTIVE` without clearing, replacing, or changing that cookie/session.
- An invalid, revoked, or expired cookie is not a credential; clear it only on the replacement response, then treat the request as anonymous. Do not clear a valid regular cookie on any conflict path.
- Anonymous admission requires all admission windows to be configured and valid, a valid dedicated `DEMO_NETWORK_HASH_SECRET`, and a valid IP from Express. A missing/invalid prerequisite fails closed for new admission but does not prevent valid existing demo-session resumption.

## Response Shapes

Successful first admission (`201`) and valid demo resume (`200`) return:

```json
{
  "data": {
    "state": "ready",
    "principal": { "id": "<uuid>", "displayName": "Demo workspace", "accountKind": "demo", "role": "user" },
    "csrfToken": "<derived token>",
    "expiresAt": "<database timestamp>"
  },
  "error": null
}
```

The response sets the existing `__Host-pa_session` cookie with HttpOnly, SameSite=Lax, path `/`, the configured Secure flag, and the exact persisted session expiry. No raw IP, network hash, request digest, counter, storage path, showcase identifier, or credit balance is returned. `state: ready` means identity/session/empty storage accounting are ready only; a showcase copy/editable workspace is not implied.

An unauthenticated retry with an existing idempotency record can receive only a generic status, never a session credential:

```json
{ "data": { "state": "pending" | "ready" }, "error": null }
```

`pending` uses `202`; cookie-less `ready` uses `200`. A bounded terminal failure returns `503 DEMO_PROVISIONING_FAILED` with a generic message and no owner ID, cookie, or exception detail. An idempotency key is not a bearer credential and never recovers a cookie.

## Validation and Error Cases

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Body or idempotency key is malformed. |
| 403 | `ORIGIN_FORBIDDEN` | Origin is absent or differs from configured `APP_ORIGIN`. |
| 403 | `CSRF_INVALID` | An authenticated POST omitted or failed the existing CSRF check. |
| 409 | `DEMO_REGULAR_SESSION_ACTIVE` | A valid regular session is present; its cookie is preserved. |
| 429 | `DEMO_ADMISSION_RATE_LIMITED` | Global or network admission window is at capacity. No new user, counter increment, or admission row commits. |
| 429 | `DEMO_RUN_START_RATE_LIMITED` | A demo owner exceeded the configured per-owner run-start window. Provider/runtime dispatch does not begin. |
| 503 | `DEMO_ADMISSION_UNAVAILABLE` | Required abuse configuration is absent/invalid, key rotation overlaps a live network window, IP is unavailable, or persistence is unavailable. |
| 503 | `DEMO_PROVISIONING_FAILED` | The owner-scoped empty-storage check/reconciliation failed through the bounded retry limit. No session is issued. |

All errors use the existing generic envelope. They do not contain database errors, key identifiers, raw IPs, counter values, secrets, or foreign/user data. Unknown errors remain generic 500s and are not logged with request headers or body.

## Versioning / Compatibility Notes

- Migration `1710000031000-create-demo-admission.ts` is additive. It creates idempotent admission rows, fixed-window counters, and bounded run-start deduplication events; it does not alter regular users or credit balances. Rollback refuses if demo admissions, counters, or demo accounts exist.
- `DEMO_SESSION_TTL_HOURS` defaults to `24`, accepts only integer `1..24`, and applies only when creating a demo. Existing session lifetime configuration remains unchanged.
- New-admission abuse configuration is all-or-none: `DEMO_GLOBAL_ADMISSION_MAX`, `DEMO_GLOBAL_ADMISSION_WINDOW_SECONDS`, `DEMO_NETWORK_ADMISSION_MAX`, `DEMO_NETWORK_ADMISSION_WINDOW_SECONDS`, `DEMO_RUN_START_MAX`, `DEMO_RUN_START_WINDOW_SECONDS`, and `DEMO_NETWORK_HASH_SECRET`. Limits are positive integers and windows are bounded positive seconds. Missing or invalid settings disable new admission and demo run starts, while valid current sessions can still resume and use non-AI routes. No numeric production values or secret are supplied by this task.
- `TRUSTED_PROXY_CIDRS` is optional. If absent, Express keeps `trust proxy` disabled and `request.ip` comes from the direct peer. If present, each comma-separated IPv4/IPv6 CIDR is validated before being passed to Express; `true`, hop counts, hostnames, and hand-parsed `X-Forwarded-For` are not accepted. A reverse proxy omitted from the list causes visitors to share its observed network bucket.
- `DEMO_NETWORK_HASH_SECRET` is a dedicated random operator secret of at least 32 bytes; it is not `SESSION_SECRET`. Persist `HMAC-SHA-256(secret, "demo-network:v1:" + request.ip)` plus a non-secret key identifier. If a different key identifier has any unexpired network window, new admissions fail closed until those windows have expired and been pruned. Rotation never resets live counts.
- Idempotency rows are globally unique by the request-key digest, independent of the current network. They retain the original network key ID/hash only as bounded abuse metadata; a retry from another IP sees the same generic state and cannot create a second owner or receive a cookie.
- The counter transaction locks the global window, then the globally keyed request-digest row, then the network window, then creates the demo user and `account_limits` row. Same-key requests create one owner and count once. Counters use PostgreSQL clock-based fixed windows and are pruned on bounded retention during admission; the global cap bounds per-network bucket cardinality. Run-start counters are separate from Task 3.1 credit usage and are keyed by owner/run identity so retries do not consume more than one slot.
- A created owner and `account_limits` row are committed as `pending` before storage bootstrap. Only that brand-new owner is checked for projects, mappings, content references, reservations, removal/recovery entries, then reconciled with an empty database/file inventory through the Task 3.2 quota repository. This is never used to reset an existing account. Final `pending -> ready` and one session insert commit atomically. No lock/transaction spans scanning or other I/O. The creating request makes at most three bootstrap attempts. Replays of an existing digest only return generic persisted status; they do not resume bootstrap or create a session. A crashed pending owner stays inaccessible until Task 3.5 removes expired pending/failed admissions and their data. Only the original request's completed ready response receives a cookie; no retry/failure response does.
- On a valid authenticated `POST`, the established opaque token and CSRF derivation are reused. A valid demo session does not create an account/session or change expiry. A valid regular session is never replaced. Deleting a demo cookie cannot reset owner/global credit ledgers; a new anonymous owner is still subject to global/network counters and shared Task 3.1 demo daily/campaign budgets.
- The run-start rate port is required by `StartAiRunUseCase` and is invoked only after provider-permission validation and the repository's first successful atomic `ready -> queued` transition, before status publication or runtime/provider dispatch. If the slot is refused, a conditional `abortStart` restores `ready` and clears the matching start idempotency pair; if cancellation or another state transition wins first, `beginStart` rejects before the rate port runs. Replayed starts do not consume another slot. Regular users bypass the demo counter. The seven abuse settings are one all-or-none configuration group: if any are missing or invalid, new anonymous admission and demo AI starts both fail closed. Valid existing demo sessions can still resume and use non-AI routes; same-key replay remains status-only. Task 3.1's global pause, missing price/bounds, and shared campaign exhaustion remain authoritative.
- `IDemoContentProvisioner`/the later workspace-ready state accepts only an admission/owner identity; it does not accept a path or showcase identifier. It is a future Task 3.4 integration seam only. Task 3.5 owns cleanup of expired pending/failed admissions, accounts, sessions, and data.

## Open Questions

- None blocking for implementation. Operators must supply abuse limits and the HMAC secret to enable anonymous admission, and must set trusted-proxy CIDRs when a reverse proxy is present. The managed storage mount is required for later showcase/file-backed behavior, while AI spending settings and verified provider bounds are required before AI can run. The current Compose setup does not establish those deployment values or prove a public reverse-proxy topology.
