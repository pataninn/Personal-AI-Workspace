# Contract: Migrate local identity to regular, admin, and demo accounts

## Change History

- 2026-10-19: Initial Task 2.1 contract. Defines identifier-based regular sign-in, legacy owner migration, account/session state, and last-admin protection.

## Ownership

- Authentication authority comes only from the opaque server session cookie. Request bodies, query strings, headers other than the session/CSRF/origin headers, and model output cannot select a principal, role, or account kind.
- Regular identities carry `accountKind: "regular"`, role `"user"` or `"admin"`, a normalized unique `identifier`, and a password hash.
- Demo identities carry `accountKind: "demo"`, role `"user"`, no identifier, no password hash, and a fixed `expiresAt`. This task establishes storage/session checks only; demo-session creation is owned by a later task.
- The migrated existing local owner is the initial admin with identifier `owner`. Its UUID, display name, password hash, user-owned data, existing session rows, and session-cookie mechanism are preserved.

## Scope

- Replace single-local-user password lookup with regular-account identifier lookup.
- Extend user persistence for account kind, role, regular-account identifier, account activity, and optional account expiry. Preserve existing `is_active` as the active/disabled source of truth.
- Permit passwordless demo rows while requiring passwords and identifiers for regular rows.
- Keep opaque HttpOnly session cookies, same-origin login/logout, Origin validation, CSRF validation, cookie attributes, and logout revocation.
- Reject disabled accounts, expired principals, revoked sessions, expired sessions, and demo accounts presented to password login.
- Provide a protected account-disable repository/use-case operation that revokes the target's sessions and cannot disable the last active admin. Account management HTTP endpoints and demo creation are out of scope for this task.

## Endpoints / Events

### `POST /api/v1/auth/login`

Requires the configured `Origin` and the existing login rate limiter.

### `GET /api/v1/auth/session`

Requires the opaque session cookie. Disabled, expired, revoked, unknown, and expired-principal sessions return the existing unauthenticated error envelope.

### `POST /api/v1/auth/logout`

Requires the configured `Origin`, opaque session cookie, and valid `X-CSRF-Token`; revokes only the authenticated session and clears the cookie.

### Account disable operation

An internal application/repository operation for later admin API wiring. It accepts trusted actor and target account IDs from the caller, verifies an active admin actor, returns not-found for an unknown target, and returns a conflict for the last active admin. A successful disable marks the account inactive and revokes its sessions atomically.

## Request Shapes

### `POST /api/v1/auth/login`

```json
{
  "identifier": "owner",
  "password": "existing password"
}
```

- `identifier`: required string, trimmed and normalized to ASCII lowercase before lookup. Valid identifiers match `^[a-z0-9][a-z0-9._-]{2,63}$` after normalization. Lookup is case-insensitive; stored identifiers are lowercase.
- `password`: required string, 1–1024 characters, with at least one non-whitespace character. Password contents are not trimmed or normalized before verification.
- Unknown keys are rejected. Password-only legacy login requests are no longer accepted; the existing owner's compatible sign-in uses identifier `owner` with the unchanged password.

## Response Shapes

Successful login and session responses keep the existing envelope and CSRF/session fields:

```json
{
  "data": {
    "principal": {
      "id": "uuid",
      "displayName": "Local user",
      "accountKind": "regular",
      "role": "admin"
    },
    "csrfToken": "derived csrf token",
    "expiresAt": "RFC 3339 timestamp"
  },
  "error": null
}
```

- Session token material is only set in the existing host-only `HttpOnly; Secure; SameSite=Lax; Path=/` cookie and is never returned in JSON.
- `principal.id` remains the existing account UUID and therefore continues to identify the owner of existing rows.
- Logout remains `204 No Content` and clears the session cookie.

## Validation and Error Cases

| Condition | HTTP | Error code |
| --- | ---: | --- |
| Invalid request shape or identifier | 400 | `VALIDATION_ERROR` |
| Unknown identifier, wrong password, disabled account, or demo account used for password login | 401 | `INVALID_CREDENTIALS` |
| No regular account has been bootstrapped | 503 | `SETUP_REQUIRED` |
| Login rate limit exceeded | 429 | `AUTH_RATE_LIMITED` |
| Missing, unknown, revoked, expired, disabled, or expired-principal session | 401 | `SESSION_UNAUTHENTICATED` |
| Missing or invalid Origin | 403 | `ORIGIN_FORBIDDEN` |
| Missing or invalid CSRF token | 403 | `CSRF_INVALID` |
| Attempt to disable the final active admin | Internal account-disable result | `last-active-admin` (admin endpoint and HTTP mapping are deferred) |

Credential errors use the same generic client message regardless of whether an identifier exists. No API error includes passwords, password hashes, session tokens, or account secret data.

## Versioning / Compatibility Notes

- Existing account UUIDs and owner data remain unchanged. The migration preserves the existing password hash byte-for-byte and assigns `owner` / `admin` to the row whose legacy `scope_key` is `local`.
- Any other pre-existing rows receive deterministic `legacy-<uuid-without-hyphens>` identifiers and the `user` role so the migration can backfill before enforcing identity constraints.
- Fresh bootstrap creates `owner` / `admin` exactly once; reruns do not replace credentials, promote another user, or recreate a disabled owner.
- Existing signed session tokens remain valid for the same configured lifetime after migration. Sessions stop working immediately when revoked, when the account is disabled, or when the account expiry is reached.
- The request body changes from `{ "password": ... }` to `{ "identifier": ..., "password": ... }`; the bundled frontend is updated in the same task. Cookie, CSRF, Origin, envelope, route, and logout semantics remain stable.
- `scope_key` remains as a legacy compatibility column and unique storage key, but is no longer used as sign-in authority. New regular rows receive a distinct `account:<uuid>` scope key. `is_active` remains the active/disabled field.

## Open Questions

- None for Task 2.1. Demo-session creation, account creation/reset HTTP endpoints, and admin UI remain explicitly assigned to later tasks.
