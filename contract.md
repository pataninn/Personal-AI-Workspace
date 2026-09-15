# Contract: Docker Compose and Backend Foundation

## Change History

| Version | Date | Change |
| --- | --- | --- |
| 0.1 | 2026-09-12 | Defined the foundation health/readiness contract and fail-closed startup boundary. |

## Ownership

- Backend owns configuration validation, startup checks, health/readiness response mapping, and migration execution.
- Compose owns service dependency ordering, private networks, named volumes, and mount boundaries.
- The frontend owns only the production bundle scaffold in this task; no product workflow is introduced.

## Scope

Task 1.1 establishes the local application foundation. It does not implement authentication, projects, chat, AI runs, file operations, or user-facing workspace flows from later tasks.

## Endpoints / Events

### `GET /health`

Public liveness endpoint. It does not access the database, workspace, gateway, or NIM provider and is safe for Compose health checks.

### `GET /ready`

Public readiness endpoint. It reports `200` only after database migration state, workspace identity, authenticated OpenShell reachability, and configured NVIDIA NIM profile checks have passed. It reports `503` with a safe error code while startup is incomplete or failed.

## Request Shapes

Both endpoints have no request body, query parameters, or authentication requirement.

## Response Shapes

Successful responses use the shared envelope:

```json
{ "data": { "status": "ok" }, "error": null }
```

`GET /health` returns `status: "ok"`. `GET /ready` returns `status: "ready"` and a version string when ready, or `status: "not_ready"` and safe check names when unavailable.

## Validation and Error Cases

- Invalid or missing startup configuration prevents the process from listening.
- Database, migration, workspace marker, gateway, or NIM profile failures prevent readiness and process startup in the production composition root.
- Unknown HTTP routes return the standard `NOT_FOUND` envelope without stack traces.
- Startup errors never include credentials, raw provider responses, SQL, or host directory listings.

## Versioning / Compatibility Notes

- The API is mounted under `/api/v1` for future product routes; foundation endpoints remain at `/health` and `/ready` for container probes.
- Provider credentials stay gateway-only. The app checks the gateway's provider readiness profile and never calls NIM with a key.
- The architecture's opaque-cookie authentication contract is reserved for later tasks; no protected endpoint is added here.

## Open Questions

- The exact reviewed OpenShell gateway image, blueprint digest, and readiness payload are deployment inputs and remain unset until OpenShell is available.
- Local TLS certificate issuance/renewal is an operator setup step; the Compose topology requires the certificate directory rather than generating credentials.
