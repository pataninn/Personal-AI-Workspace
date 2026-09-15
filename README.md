# Personal AI Workspace

This repository contains the MVP1 local foundation for the Personal AI Workspace.
Task 1.1 provides strict TypeScript packages, a production-style Compose topology,
startup checks, and health/readiness endpoints. Product features are intentionally
added in later tasks.

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
