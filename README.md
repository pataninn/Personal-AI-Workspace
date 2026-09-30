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
- An NVIDIA hosted NIM credential

The direct-project setup mounts this application repository as <code>/workspace</code>.
The server accepts project root <code>.</code> only after it verifies the workspace
identity marker. Keep the repository's <code>.personal-ai-workspace-identity</code> marker
in place; it is ignored by git and protected from project file tools.

Before mounting the repository, move the current local environment, provider
and login credentials, and TLS pair to the user-private Windows location
<code>%LOCALAPPDATA%\Personal-AI-Workspace\private</code>. Stop Compose, then run the
one-time helper from the application repository:

```powershell
$privateRoot = Join-Path $env:LOCALAPPDATA 'Personal-AI-Workspace\private'
$privateEnv = Join-Path $privateRoot '.env'
docker compose --project-name personal-ai-workspace --env-file .env down
.\scripts\move-local-private-files.ps1 -Preflight
.\scripts\move-local-private-files.ps1
```

The stop command targets the existing <code>personal-ai-workspace</code> stack and retains its volumes. Confirm it has stopped before running the relocation helper. The new direct-repository stack uses <code>personal-ai-workspace-mvp2</code> and separate PostgreSQL and recovery volumes.
The Compose password-file default supports stopping the existing stack when its
older <code>.env</code> omits <code>LOCAL_USER_PASSWORD_FILE</code>. The relocation helper always
writes the direct-run setting as an absolute path under the external private
directory and verifies it stays outside the repository. The preflight checks source
and destination paths without reading file contents.
The move helper copies each file, verifies the copies, restricts the private
directory ACL to the current Windows user, updates path settings in the external
<code>.env</code>, and only then removes the in-repository copies. It creates the ignored
identity marker when needed. It retains the verified pre-move <code>.env</code>
snapshot under
<code>%LOCALAPPDATA%\Personal-AI-Workspace\private\rollback\before-direct-workspace</code>.
The helper does not print credential values or Compose's resolved configuration.
The live environment also selects <code>pai_mvp2_pg_data</code> and
<code>pai_mvp2_recovery</code>, keeping the existing MVP1 PostgreSQL and recovery
volumes untouched. The Compose project is named <code>personal-ai-workspace-mvp2</code>.

The external <code>.env</code> must keep these host paths under the private directory:

- <code>LOCAL_USER_PASSWORD_FILE</code> points to <code>secrets/local_user_password</code>
- <code>NVIDIA_API_KEY_FILE</code> points to <code>secrets/nvidia_api_key</code>
- <code>TLS_CERT_DIR</code> points to <code>tls</code>

The NVIDIA key is mounted read-only at <code>/run/secrets/nvidia_api_key</code> for
<code>personal-ai-app</code>. The browser, database, workspace, logs, and frontend bundle
never receive the key. The login password is mounted read-only at
<code>/run/secrets/local_user_password</code>; on first boot with an empty users table, the
app hashes this value to create its single local user. Use the same value at the
login screen. Replacing the secret file later does not replace the existing
password.

For a new local login password, write a random value directly to the private
file without displaying it:

```powershell
$privateRoot = Join-Path $env:LOCALAPPDATA 'Personal-AI-Workspace\private'
$secretPath = Join-Path $privateRoot 'secrets/local_user_password'
New-Item -ItemType Directory -Force (Split-Path $secretPath) | Out-Null
$randomBytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($randomBytes)
[System.IO.File]::WriteAllText($secretPath, [Convert]::ToBase64String($randomBytes), [System.Text.UTF8Encoding]::new($false))
```

Keep the credential files outside the mounted repository. Put the provider key
in the private <code>secrets/nvidia_api_key</code> file using a secure local editor or
credential tool. Put a loopback TLS certificate and key in <code>tls/tls.crt</code> and
<code>tls/tls.key</code>. For a temporary local certificate with OpenSSL:

```powershell
$privateRoot = Join-Path $env:LOCALAPPDATA 'Personal-AI-Workspace\private'
$tlsDirectory = Join-Path $privateRoot 'tls'
New-Item -ItemType Directory -Force $tlsDirectory | Out-Null
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 30 `
  -keyout (Join-Path $tlsDirectory 'tls.key') -out (Join-Path $tlsDirectory 'tls.crt') `
  -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
```

Start Compose with the external environment file explicitly:

```powershell
$privateRoot = Join-Path $env:LOCALAPPDATA 'Personal-AI-Workspace\private'
$privateEnv = Join-Path $privateRoot '.env'
pnpm compose:config
docker compose --project-name personal-ai-workspace-mvp2 --env-file $privateEnv up --build -d
```

Open <code>https://127.0.0.1:8443/</code>. A temporary self-signed certificate needs local
browser trust or a one-time browser exception. Check service health and the
backend readiness endpoint without printing the resolved Compose configuration:

```powershell
docker compose --project-name personal-ai-workspace-mvp2 --env-file $privateEnv ps
curl.exe -k https://127.0.0.1:8443/ready
```

Create the project in the UI with relative root <code>.</code> to use the complete
application repository. Workspace inspection still blocks <code>.git</code>, <code>.env*</code>,
<code>secrets</code>, backup/audit/internal paths, private keys, links, and other protected
paths. File changes continue to require normal proposal review, current hashes,
pre-destructive backups, and atomic promotion.

When preparing an AI run, use <strong>Choose context</strong> to browse or search project
files. Search ranks phrase and term matches deterministically, reports when its bounded
scan may be incomplete, and never selects results automatically. Search snippets are
redacted locally; only files you select appear in the separate provider consent review.

## Rollback

Keep Compose stopped while changing the workspace root. To return to the
previous fixture, open the active private <code>.env</code> and the saved
<code>rollback\before-direct-workspace\.env</code> side by side. Restore only the original
<code>WORKSPACE_HOST_ROOT</code> and <code>WORKSPACE_IDENTITY</code> entries in the active private
file. Set <code>POSTGRES_VOLUME_NAME=pai_pg_data</code> and
<code>RECOVERY_VOLUME_NAME=pai_recovery</code> to use the original fixture data and
recovery volume. Leave the three external credential/TLS paths pointing to the private
directory. The saved values target the existing fixture and its marker; the
helper does not rewrite that marker. Do not restore the saved <code>.env</code> into
the application repository; keep using the private active file so secret paths
remain external.

After changing these settings, start the fixture with the same explicit
private environment path:

```powershell
$privateRoot = Join-Path $env:LOCALAPPDATA 'Personal-AI-Workspace\private'
$privateEnv = Join-Path $privateRoot '.env'
docker compose --project-name personal-ai-workspace --env-file $privateEnv up -d
```

## Backups and recovery

The app runs ordered TypeORM migrations before starting Express. It keeps
private file recovery snapshots in the app-only <code>pai_mvp2_recovery</code> volume at
<code>/var/lib/personal-ai/recovery</code>. Keep recovery data outside the authoritative
workspace and retain the volume when inspecting an ambiguous apply result. For
a manual backup, stop the stack and copy the configured workspace to a separate
location, then export PostgreSQL:

```powershell
$privateRoot = Join-Path $env:LOCALAPPDATA 'Personal-AI-Workspace\private'
$privateEnv = Join-Path $privateRoot '.env'
$databaseBackup = Join-Path $privateRoot 'database-backup.sql'
docker compose --project-name personal-ai-workspace-mvp2 --env-file $privateEnv down
docker compose --project-name personal-ai-workspace-mvp2 --env-file $privateEnv exec -T postgres pg_dump -U pai_app -d personal_ai > $databaseBackup
```

Keep the SQL file private and retain the <code>pai_mvp2_recovery</code> volume with the backup.
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
pnpm compose:config
docker compose --project-name personal-ai-workspace-mvp2 --env-file $privateEnv up --build
```

<code>pnpm compose:config</code> uses the private environment-file path and validates
Compose without printing resolved settings. The live Compose/NIM check needs
Docker Desktop, operator-provisioned TLS files, the repository identity marker,
and a valid NVIDIA credential. Application startup fails closed until
PostgreSQL, the workspace identity, the fixed endpoint, and the read-only
provider secret are available.

For deterministic local/CI consent tests without a credential, set
<code>NODE_ENV=development</code> or <code>test</code> and <code>AGENT_RUNTIME_MODE=fake</code>. Production
rejects fake mode. The fake adapter never calls NVIDIA and still requires the
durable PostgreSQL consent checkpoint before provider execution. Fake runs and
proposed changes are development/test evidence, not proof of a live provider
call.

## Frontend-only review preview

To click through the completed UI without Docker, PostgreSQL, OpenShell, or NIM:

```powershell
pnpm.cmd --filter personal-ai-workspace-frontend preview:dev
```

Open <code>http://127.0.0.1:5173/</code>. Enter any <strong>made-up, non-empty</strong> password at
the preview login; never use your real password. The yellow notice identifies
the in-memory mock mode. It starts with a sample active project, archived
project, conversation, and message. You can create projects/conversations,
save messages, and archive/restore projects. Data resets when Vite restarts.
No real workspace file, PostgreSQL record, or AI provider is touched. This
command is development-only and is not used by production builds. Use
<code>Ctrl+C</code> to stop it.

The normal frontend <code>pnpm dev</code> command still needs the real backend API; the
mock is enabled only by <code>preview:dev</code>.
