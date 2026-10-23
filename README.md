# Personal AI Workspace

This repository contains the local Personal AI Workspace with projects,
conversations, selected context, memory, tasks, live updates, and file history.
The supported setup is one owner account and an anonymous demo. Visitors choose
**Try demo** without creating an account; each visitor receives an isolated,
expiring copy of the content you publish. Extra named-account creation is retired.
Existing accounts and saved data are preserved.

One backend process runs the HTTP API, Home chat execution, scheduled jobs, and
cleanup. A database ownership lock prevents another process from recovering or
executing its live work. Home turns continue when you leave the page; status GETs
only read saved progress. Local pages, tasks, and files remain available when the
AI bridge is offline. Inference still requires a configured, healthy Hermes bridge
and the existing policy and credit checks.

## Prepare the Hermes provider route

This machine uses the installed WSL Ubuntu OpenShell 0.0.116 gateway
`nemoclaw-18080` and digest-pinned Hermes 0.20.6 base image. The gateway's
named `pai-nebius-token-factory` provider is configured by the startup helper.
This helper does not install Hermes or provision a fresh gateway on another machine.

From this repository, with Docker Desktop running:

Save just your Nebius API key in ignored `secrets/nebius_api_key`. Configure root
`.env` with the following (the legacy `NIM_` setting names also select the Hermes provider):

```dotenv
NEBIUS_API_KEY_FILE=./secrets/nebius_api_key
NIM_PROFILE=nebius-token-factory
NIM_ENDPOINT=https://api.tokenfactory.nebius.com/v1
NIM_MODEL=nvidia/nemotron-3-super-120b-a12b
AGENT_RUNTIME_MODE=hermes
```

This model ID was confirmed in the authenticated Nebius catalog. The key is read
locally and passed to OpenShell through the CLI's environment credential lookup;
it is never included in command arguments or bridge payloads. Startup can prepare
the provider route without generating a model response or spending inference
tokens. Inference requires the credit configuration described below.
Provider consent remains separate by provider; existing NVIDIA permissions do
not authorize Nebius requests.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-hermes.ps1
```

After a successful build, use `-SkipBuild` for a normal restart. Open
`https://127.0.0.1:8443/` and refresh the browser after an update.

The helper starts supervised WSL services, generates dedicated bridge TLS
credentials under ignored `secrets/hermes-bridge`, sets `AGENT_RUNTIME_MODE=hermes`
in root `.env`, and starts Compose with the existing volumes. Hermes never mounts
the authoritative workspace or receives the Nebius key. It gets only approved,
bounded, redacted selected files, facts, and chat references.

Supported project files are selected automatically in **Context**, including new
files on the next chat request. Deselect files you do not want included and click
**Apply to all chats**; those exclusions persist across chats and refreshes.
Protected files, binary files (including PDFs), and unreadable or oversized files
are excluded. Discovery is bounded to 500 candidates at depth 6; each run includes
at most 100 selected files within its existing context size limit. Context shows
when discovery or selection reaches a limit. You can refresh the list or add a
relative path when a file falls outside discovery. Standard
`SKILL.md` files guide frontend design, editing existing projects, and planning.
Tool activity and command approvals appear in the chat. Routine checks run
automatically; installs, destructive actions, and other commands ask first.
Approved npm/pnpm package commands can read `registry.npmjs.org`; approved pip
commands can read `pypi.org` and `files.pythonhosted.org`. Other extra destinations
remain blocked. Registry grants are removed after the command finishes; cancelling
a command stops the whole Hermes run. Installed packages and build artifacts stay
in the disposable copy; only bounded source files are promoted.

Successful generated edits pass the existing validation and source-hash checks
before application, with backups and File history. Incomplete runs apply no
generated changes. An interrupted bridge run remains failed and cannot export
files; its saved ownership ledger permits scoped cleanup. Durable restart/resume,
broader network approval, and production runtime hardening remain future work.

Generated file proposals use a limited credential check: private-key headers,
recognizable access-key formats, and literal values of at least 12 characters
assigned to explicit credential names (such as `api_key` or `password`) are blocked.
Ordinary uppercase assignments, generic `token`/`secret`/`credential` fields,
placeholders, and code references are allowed. This intentionally favors fewer
false alarms and does not detect every secret. Context sent to the provider still
uses the separate egress redaction policy.

Hermes is the production runtime. The unsupported direct NVIDIA adapter and its
Compose overlay have been removed; `fake` is reserved for development and tests.
The WSL OpenShell gateway used by Hermes remains part of this deployment.

### Credit admission and paid inference status

The credit ledger migration starts with global inference paused, and this release
does not choose provider prices, account budgets, or demo campaign limits. Regular
account daily and lifetime limits default to `null` (unlimited), while missing
demo campaign configuration denies demo sends. Do not infer that a provider key
or provider profile enables inference.

Before a paid Hermes send can be enabled, configure the
following six configuration values together, using verified prices and bounds:

- `NIM_CREDIT_PRICE_VERSION`
- `NIM_INPUT_CREDIT_UNITS_PER_MILLION_TOKENS`
- `NIM_OUTPUT_CREDIT_UNITS_PER_MILLION_TOKENS`
- `NIM_MAX_INPUT_TOKENS`
- `NIM_MAX_OUTPUT_TOKENS` (at most 16,384)
- `NIM_MAX_PROVIDER_CALLS_PER_RUN` (1–32)

Rates are positive integer credit units per 1,000,000 tokens; one displayed
credit equals 1,000,000 integer credit units. Prices and request limits have no
application defaults. Partial configuration is rejected. These values alone
still do not bypass the global pause, account limits, or demo shared budgets.
The supported Nebius/Nemotron path reserves the full 262,144-token input bound;
`NIM_MAX_INPUT_TOKENS` must cover that bound. The bridge enforces admission and
records usage at provider calls. Requests fail closed when the required policy,
credit configuration, or bridge enforcement is unavailable. No provider prices,
spending limits, or automatic unpause are supplied by this cleanup.

## Local prerequisites

- Node.js 22.20 or newer in the 22.x line
- pnpm 11.8 or newer
- Docker Desktop with WSL2/Ubuntu 22.04 or newer
- A Nebius Token Factory credential for paid AI use

Keep the active <code>.env</code> in this application repository. Copy
<code>.env.example</code> to <code>.env</code> if needed, then fill in the settings.
Compose reads it automatically when run from this directory. Git and the Docker
build context ignore <code>.env</code>.

<code>WORKSPACE_HOST_ROOT</code> selects the legacy folder mounted as <code>/workspace</code>.
Its identity marker must match <code>WORKSPACE_IDENTITY</code>. Existing legacy-owner
projects continue to use their recorded relative roots there. New file-backed projects
never select a host path in the browser and are allocated under the separate managed
storage mount described below. Planning-only projects remain usable without that mount.

### Private demo admission

For a small demo:

1. Copy `.env.example`, fill your owner password and separate random secrets, and
   complete the existing workspace/managed-storage setup below.
2. Start the normal application. In **Admin > Demo content**, select only content
   intended for visitors and publish it. Nothing is published automatically.
3. Review **Admin > Demo settings**. Visitor limits have a starter preset;
   advanced limits are collapsed. The emergency AI pause remains visible.
4. Open the login page in a private browser window and choose **Try demo**.
   Configure provider prices and explicit demo AI budgets only if you want paid AI.

The demo still needs isolated records, expiry cleanup, and a published snapshot.
File-backed demo workspaces also need the managed-storage mount.
Those protect your owner workspace and other visitors. Snapshot history is retained
so active demos can finish copying the version they were issued.

The passwordless demo endpoint is `POST /api/v1/demo/session`. It accepts an empty
request body, an exact configured `Origin`, and a high-entropy `Idempotency-Key`.
The key is stored as a one-way digest, is globally unique across network changes,
and is not a session credential. A cookie-less replay receives only the persisted
pending/ready status; it cannot recover or mint a session cookie. A valid demo cookie
resumes the same account without extending its expiry, while a valid regular-account
cookie is preserved on conflict.

New anonymous admission remains disabled until all six `DEMO_GLOBAL_ADMISSION_MAX`,
`DEMO_GLOBAL_ADMISSION_WINDOW_SECONDS`, `DEMO_NETWORK_ADMISSION_MAX`,
`DEMO_NETWORK_ADMISSION_WINDOW_SECONDS`, `DEMO_RUN_START_MAX`, and
`DEMO_RUN_START_WINDOW_SECONDS` values and `DEMO_NETWORK_HASH_SECRET` are configured
together. Compose and `.env.example` now provide modest visitor limits (40/hour
globally, 5/hour per network, 10 run starts/hour per demo). These are capacity
limits, not permission to spend money. Existing persisted demo settings are not
overwritten; use **Admin > Fill missing demo limits**, review, and save if needed. `DEMO_NETWORK_HASH_SECRET` must be a dedicated random
secret of at least 32 bytes, kept private and separate from `SESSION_SECRET`. Rotating
it while an old network window is still active temporarily blocks new admissions
rather than resetting the existing counter. `DEMO_SESSION_TTL_HOURS` is optional,
defaults to 24, and accepts only 1 through 24 hours.

`TRUSTED_PROXY_CIDRS` is optional and must list the exact trusted proxy CIDRs. If it
is unset, forwarded headers are ignored and visitors are grouped by the direct peer
address. When configured, only validated CIDRs are passed to Express; the app does
not parse `X-Forwarded-For` itself. Network limits identify a shared network bucket,
not an individual person. Raw addresses are not persisted or included in request logs.

A new demo account receives storage-ready status only after the server verifies its
new database account is empty and initializes its storage accounting. A separate
showcase configuration controls whether new demos can be admitted. Configure all six
settings together: `SHOWCASE_MAX_SNAPSHOT_BYTES`, `SHOWCASE_MAX_FILE_BYTES`,
`SHOWCASE_MAX_ITEMS`, `SHOWCASE_MAX_FILES`, `SHOWCASE_MAX_RETAINED_VERSIONS`, and
`DEMO_SHOWCASE_COPY_MAX_ATTEMPTS`. Values must be finite positive integers;
per-file bytes cannot exceed total snapshot bytes, and file count cannot exceed the
item count. No defaults or production limits are supplied. Missing, partial, or
invalid values keep new admissions unavailable. An administrator must select content
in the private preview and publish it explicitly; the application starts unpublished
and does not create sample content or publish automatically. `Try demo` creates a
private copy only from a currently published version. Expired demo data cleanup is
also a separate later task.

Non-AI exploration does not require provider-spending configuration. AI remains
subject to the shared credit pause, configured budgets, verified request bounds, and
provider-call admission; demo admission itself never enables or spends on a provider
request.

Keep the credential and TLS files at the paths named in <code>.env</code>. The
default template places these files under
<code>%LOCALAPPDATA%\Personal-AI-Workspace\private</code>:

- <code>LOCAL_USER_PASSWORD_FILE</code> points to <code>secrets/local_user_password</code>
- <code>NEBIUS_API_KEY_FILE</code> points to ignored <code>./secrets/nebius_api_key</code>
- Optional <code>NVIDIA_API_KEY_FILE</code> points to <code>secrets/nvidia_api_key</code> for direct fallback
- <code>TLS_CERT_DIR</code> points to <code>tls</code>

The Nebius key is stored by the WSL OpenShell gateway and is not mounted in
<code>personal-ai-app</code> or the disposable sandbox. The optional direct override
mounts its NVIDIA key at <code>/run/secrets/nvidia_api_key</code>. The browser, database,
logs, and frontend bundle never receive either key. The login password is mounted read-only at
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

The ignored local <code>secrets/</code> directory is protected from project context,
file tools, and Docker builds. Put the Nebius provider key in
<code>secrets/nebius_api_key</code> using a secure local editor or credential tool.
Put a loopback TLS certificate and key in <code>tls/tls.crt</code> and
<code>tls/tls.key</code>. For a temporary local certificate with OpenSSL:

```powershell
$privateRoot = Join-Path $env:LOCALAPPDATA 'Personal-AI-Workspace\private'
$tlsDirectory = Join-Path $privateRoot 'tls'
New-Item -ItemType Directory -Force $tlsDirectory | Out-Null
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 30 `
  -keyout (Join-Path $tlsDirectory 'tls.key') -out (Join-Path $tlsDirectory 'tls.crt') `
  -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
```

Start Compose from the application repository:

```powershell
docker compose --project-name personal-ai-workspace config --quiet
docker compose --project-name personal-ai-workspace up --build -d
```

Open <code>https://127.0.0.1:8443/</code>. A temporary self-signed certificate needs local
browser trust or a one-time browser exception. Check service health and the
backend readiness endpoint without printing the resolved Compose configuration:

```powershell
docker compose --project-name personal-ai-workspace ps
curl.exe -k https://127.0.0.1:8443/ready
```

Workspace inspection still blocks <code>.git</code>, <code>.env*</code>,
<code>secrets</code>, backup/audit/internal paths, private keys, links, and other protected
paths. File changes require validation, current hashes, pre-destructive backups,
and atomic promotion. The configured file approval mode controls review versus
automatic application.

### Optional managed file storage

The base Compose stack does not mount managed account storage. Without the overlay,
existing verified legacy projects still work, planning-only projects remain available,
and new file-backed project creation reports that managed storage is unavailable.
To enable new isolated file-backed projects, provision an existing persistent host
directory dedicated to account workspaces. Keep it physically separate from
<code>WORKSPACE_HOST_ROOT</code>; do not use a symlink, junction, nested directory, or
the application repository. Do not create this mount source through Docker Compose.

Create a stable, non-secret marker value, put that exact value in
<code>ACCOUNT_WORKSPACES_IDENTITY</code> in the private root <code>.env</code>, and
write it to <code>.personal-ai-managed-storage-identity</code> at the root of the
provisioned directory. Set <code>ACCOUNT_WORKSPACES_HOST_ROOT</code> to its absolute
host path. For example, replace these illustrative values with the existing
operator-provisioned directory and its marker value:

```dotenv
ACCOUNT_WORKSPACES_HOST_ROOT=D:/personal-ai-managed-storage
ACCOUNT_WORKSPACES_IDENTITY=managed-storage-local-01
```

The override binds that existing directory to the fixed app path
<code>/account-workspaces</code> and sets <code>bind.create_host_path: false</code>.

Before enabling it, verify both host roots exist, are ordinary directories rather
than links/reparse points, and are not the same path or nested inside each other.
Confirm the marker file is a regular file and its trimmed contents exactly match
<code>ACCOUNT_WORKSPACES_IDENTITY</code>. For example, enter the actual paths and
marker value in a local PowerShell session (the marker is an identity label, not a
credential):

```powershell
$legacyRoot = Read-Host 'Absolute WORKSPACE_HOST_ROOT path'
$managedRoot = Read-Host 'Absolute ACCOUNT_WORKSPACES_HOST_ROOT path'
$managedIdentity = Read-Host 'ACCOUNT_WORKSPACES_IDENTITY marker value'
$legacyItem = Get-Item -LiteralPath $legacyRoot -Force
$legacy = (Resolve-Path -LiteralPath $legacyRoot).Path.TrimEnd('\', '/')
$managedItem = Get-Item -LiteralPath $managedRoot -Force
$managed = (Resolve-Path -LiteralPath $managedRoot).Path.TrimEnd('\', '/')
$reparse = [IO.FileAttributes]::ReparsePoint
if (-not $legacyItem.PSIsContainer -or ($legacyItem.Attributes -band $reparse) -ne 0) { throw 'Legacy root must be an ordinary directory.' }
if (-not $managedItem.PSIsContainer -or ($managedItem.Attributes -band $reparse) -ne 0) { throw 'Managed root must be an ordinary directory.' }
$separator = [IO.Path]::DirectorySeparatorChar
if ($legacy.Equals($managed, [StringComparison]::OrdinalIgnoreCase) -or
    $legacy.StartsWith($managed + $separator, [StringComparison]::OrdinalIgnoreCase) -or
    $managed.StartsWith($legacy + $separator, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Legacy and managed roots must be disjoint.'
}
$marker = Get-Item -LiteralPath (Join-Path $managed '.personal-ai-managed-storage-identity') -Force
if ($marker.PSIsContainer -or ($marker.Attributes -band $reparse) -ne 0) { throw 'Marker must be a regular file.' }
if ((Get-Content -LiteralPath $marker.FullName -Raw).Trim() -cne $managedIdentity) { throw 'Managed marker identity does not match.' }
```

Then validate and start with the explicit overlay:

```powershell
docker compose --project-name personal-ai-workspace -f compose.yaml -f compose.managed-storage.yaml config --quiet
docker compose --project-name personal-ai-workspace -f compose.yaml -f compose.managed-storage.yaml up --build -d
```

The backend also checks the fixed in-container mount, marker identity, and filesystem
identity. This host preflight and Compose wiring do not prove Docker's resolved physical
source or mount persistence; complete that deployment check before relying on a
production host. Never point the managed mount at the legacy root or rely on an inferred
default. New projects use server-generated account/project directories below the
managed mount; clients never submit a path.

### Physical storage observation

The backend samples process-visible free capacity with Node's `statfs` at startup
and during the existing hourly maintenance pass. It checks only the verified
legacy workspace, the managed mount when configured, and the canonical recovery
directory. `STORAGE_DISK_WARNING_FREE_BYTES` is an optional positive decimal byte
threshold. When configured, the backend emits path-free structured warnings when
an observed root crosses below it, and records when observation becomes unavailable
or recovers. With no threshold, there is no low-space warning. This observation
does not change account quotas, readiness, or write admission, and it does not
prove the host bind source or persistent-volume capacity. Task 8.1 must verify the
actual mounts and select an operational threshold before deployment.

When preparing an AI run, use <strong>Choose context</strong> to browse or search project
files. Search ranks phrase and term matches deterministically, reports when its bounded
scan may be incomplete, and never selects results automatically. Search snippets are
redacted locally; only files you select appear in the separate provider consent review.

## Rollback

Keep Compose stopped while changing the workspace root. To return to a
previous fixture, update <code>WORKSPACE_HOST_ROOT</code> and
<code>WORKSPACE_IDENTITY</code> in the repository's <code>.env</code> to match that
fixture and its marker. Set <code>POSTGRES_VOLUME_NAME=pai_pg_data</code> and
<code>RECOVERY_VOLUME_NAME=pai_recovery</code> to use the original fixture data and
recovery volume. Keep the credential and TLS paths pointing to their actual files.

After changing these settings, start the fixture:

```powershell
docker compose --project-name personal-ai-workspace up -d
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
$databaseBackup = Join-Path $privateRoot 'database-backup.sql'
docker compose --project-name personal-ai-workspace exec -T postgres pg_dump -U pai_app -d personal_ai > $databaseBackup
docker compose --project-name personal-ai-workspace down
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
docker compose --project-name personal-ai-workspace config --quiet
docker compose --project-name personal-ai-workspace-mvp2 up --build
```

<code>docker compose --project-name personal-ai-workspace config --quiet</code> uses the repository's <code>.env</code> and validates
Compose without printing resolved settings. The live Compose/Hermes startup needs
Docker Desktop, operator-provisioned TLS files, the workspace identity marker,
and the configured gateway provider credential. Application startup fails closed until
PostgreSQL, the workspace identity, the authenticated bridge, and the selected
gateway route are available. Startup checks route configuration; it is not proof of
paid inference. In this release, a paid chat remains blocked before provider
execution until the credit prerequisites above are verified and enforced.

The app image installs MarkItDown for converting uploaded PDF, DOCX, PPTX, XLSX,
XLS, and EPUB documents into adjacent Markdown files. Local backend runs need
Python 3.10–3.14 with `markitdown[pdf,docx,pptx,xlsx,xls]==0.1.8` installed; set
`MARKITDOWN_PYTHON` to that environment's Python executable when it is not at
`/opt/markitdown/bin/python`. Conversion accepts local uploaded files only and
limits extracted Markdown to 512 KB.

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

## Execution and shutdown

Start the normal backend or Compose app; scheduled jobs start automatically.
There is no separate `start:worker` process. A second application instance using
the same database fails before recovery. Do not scale this personal deployment
to multiple API replicas.

Accepted Home turns run on the server without browser polling. Shutdown drains
requests, cancels active work, and waits for cleanup before releasing ownership.
If shutdown cannot finish within 30 seconds, the process exits and the next start
recovers saved interrupted outcomes; it does not automatically replay paid work.

Frontend pages load on demand. `vite.config.mjs`, `vitest.config.mjs`, and
`src/app/styles/globals.css` are the authoritative configuration/style files.
See `dev-summary.md` for verification results and remaining environment limits.
