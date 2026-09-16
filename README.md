# Personal AI Workspace

This repository contains the MVP1 local Personal AI Workspace through the Task 4.1
fake/code gate. Projects, conversations, per-run consent, fake sandbox commands,
live SSE from the fake runtime, and reviewed change application are implemented.
Real OpenShell/Hermes/NIM integration and the live MVP1 acceptance gate remain open.

## Local prerequisites

- Node.js 22.20 or newer in the 22.x line
- pnpm 11.8 or newer
- Docker Desktop with WSL2/Ubuntu 22.04 or newer
- A dedicated Windows workspace directory and its preflight identity marker
- A reviewed OpenShell gateway image and NVIDIA hosted NIM credential

Copy `.env.example` to `.env`, replace every placeholder, create the directory in
`NVIDIA_API_KEY_FILE`, and put the key in that file. The key is mounted only into
the OpenShell gateway. The application and browser never receive it.

The Compose file deliberately requires the TLS certificate directory, workspace
root, gateway image, and provider secret path. Missing values fail before services
are created. Only `personal-ai-app` publishes a loopback port; PostgreSQL and the
gateway are private services.

The app keeps disposable staging at `STAGING_ROOT` and private file recovery
snapshots at `RECOVERY_ROOT` (Compose defaults to
`/var/lib/personal-ai/recovery`). Keep both outside the authoritative workspace
and retain the recovery volume when inspecting an ambiguous apply result.

## Checks

```text
pnpm install
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:boundaries
docker compose config
docker compose up --build
```

The live Compose/OpenShell/NIM checks require the unavailable local OpenShell and
NVIDIA credentials in this delivery environment. The application startup checks
therefore fail closed until those values and services are configured.

For deterministic local/CI consent and staging tests without a credential, set
`NODE_ENV=development` or `test` and `AGENT_RUNTIME_MODE=fake`. Production rejects
fake mode. The fake adapter never calls OpenShell or NVIDIA and still requires the
durable PostgreSQL consent checkpoint before staging.
Fake runs and proposed changes are development/test evidence, not proof of a
live sandbox or provider.

## Frontend-only review preview

To click through the completed UI without Docker, PostgreSQL, OpenShell, or NIM:

```powershell
pnpm.cmd --filter personal-ai-workspace-frontend preview:dev
```

Open `http://127.0.0.1:5173/`. Enter any **made-up, non-empty** password at
the preview login; never use your real password. The yellow notice identifies
the in-memory mock mode. It starts with a sample active project, archived
project, conversation, and message. You can create projects/conversations,
save messages, and archive/restore projects. Data resets when Vite restarts.
No real workspace file, PostgreSQL record, or AI provider is touched. This
command is development-only and is not used by production builds. Use
`Ctrl+C` to stop it.

The normal frontend `pnpm dev` command still needs the real backend API;
the mock is enabled only by `preview:dev`.
