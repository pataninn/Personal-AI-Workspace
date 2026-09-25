# Personal AI Workspace

This repository contains the MVP1 local Personal AI Workspace. Projects,
conversations, per-run provider consent, bounded inspection, live SSE, and
reviewed change application are implemented. The MVP1 runtime is a direct
server-side NVIDIA NIM adapter. OpenShell, Hermes, disposable sandboxes, and
arbitrary command execution remain deferred runtime options.

## Local prerequisites

- Node.js 22.20 or newer in the 22.x line
- pnpm 11.8 or newer
- Docker Desktop with WSL2/Ubuntu 22.04 or newer
- A dedicated Windows workspace directory and its preflight identity marker
- An NVIDIA hosted NIM credential
- A private local-login password stored in `secrets/local_user_password`

Copy `.env.example` to `.env`, replace every placeholder, create the directory in
`NVIDIA_API_KEY_FILE`, and put the key in that file. Compose mounts that file as a
read-only Docker secret at `/run/secrets/nvidia_api_key` for `personal-ai-app`.
The browser, database, workspace, logs, and frontend bundle never receive the key.

Create the local-login password without printing it or placing it in `.env` or git:

```powershell
$secretPath = Join-Path (Get-Location) 'secrets/local_user_password'
New-Item -ItemType Directory -Force (Split-Path $secretPath) | Out-Null
$randomBytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($randomBytes)
[System.IO.File]::WriteAllText($secretPath, [Convert]::ToBase64String($randomBytes), [System.Text.UTF8Encoding]::new($false))
```

Compose defaults the host secret source to `./secrets/local_user_password` and
mounts it read-only at `/run/secrets/local_user_password` in `personal-ai-app`.
On the first boot with an empty users table, the app hashes this value and creates
the single local user. Use the same value at the login screen. Later boots keep the
existing account; replacing the secret file does not replace its password. The
secret path is ignored by git, and the password must never be printed or committed.

The Compose file deliberately requires the TLS certificate directory, dedicated
workspace root, identity marker, session secret, and provider secret path. Missing
values fail before services are created. Only `personal-ai-app` publishes a
loopback HTTPS port. PostgreSQL stays on the private `app-data` network; only the
app joins `provider-egress` for its fixed NVIDIA endpoint.

Create a dedicated workspace directory and its marker before starting Compose.
Put the marker value in `.env` as `WORKSPACE_IDENTITY`; set `WORKSPACE_HOST_ROOT`
to that exact directory. Do not use a drive root, home directory, OneDrive root,
or the repository parent.

```powershell
$workspaceRoot = 'C:\PersonalAIWorkspace'
New-Item -ItemType Directory -Force -Path $workspaceRoot | Out-Null
$workspaceIdentity = [guid]::NewGuid().ToString('D')
[System.IO.File]::WriteAllText((Join-Path $workspaceRoot '.personal-ai-workspace-identity'), $workspaceIdentity)
```

Place a loopback TLS certificate and key in `docker/certs/tls.crt` and
`docker/certs/tls.key`. For a temporary local certificate with OpenSSL:

```powershell
New-Item -ItemType Directory -Force docker/certs | Out-Null
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 30 `
  -keyout docker/certs/tls.key -out docker/certs/tls.crt `
  -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
```

After filling the remaining `.env` values, run `docker compose up --build -d`,
then open `https://127.0.0.1:8443/`. A temporary self-signed certificate needs
local browser trust or a one-time browser exception. `docker compose ps` should
show both services healthy; `curl.exe -k https://127.0.0.1:8443/ready` checks
the backend. The initial login uses the password in the local secret file.

The app runs ordered TypeORM migrations before starting Express. It keeps private
file recovery snapshots in the app-only `pai_recovery` volume at
`/var/lib/personal-ai/recovery`. Keep recovery data outside the authoritative
workspace and retain the volume when inspecting an ambiguous apply result.
For a manual backup, stop `personal-ai-app`, copy the dedicated workspace to a
separate location, and export PostgreSQL with
`docker compose exec -T postgres pg_dump -U pai_app -d personal_ai > backup.sql`.
Keep that SQL file private. Retain the `pai_recovery` volume with the backup.
If an apply reports a stale or uncertain result, leave the app stopped, inspect
the affected file and recovery snapshot, and restore from the saved workspace
copy only after choosing the intended version. Start the app again after the
files and database are consistent.

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

The live Compose/NIM check needs Docker Desktop, operator-provisioned TLS files,
the dedicated workspace marker, and a valid NVIDIA credential. Application
startup fails closed until PostgreSQL, the workspace identity, the fixed endpoint,
and the read-only provider secret are available.

For deterministic local/CI consent tests without a credential, set
`NODE_ENV=development` or `test` and `AGENT_RUNTIME_MODE=fake`. Production rejects
fake mode. The fake adapter never calls NVIDIA and still requires the durable
PostgreSQL consent checkpoint before provider execution. Fake runs and proposed
changes are development/test evidence, not proof of a live provider call.

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
