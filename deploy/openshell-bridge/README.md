# OpenShell WSL bridge deployment seam

This directory documents the app-side configuration for the private Docker Desktop to Ubuntu WSL bridge. The repository does not install a host service, copy the OpenShell credential store, generate provider credentials, or enable live runtime mode.

The backend bridge client expects these values together:

```text
OPEN_SHELL_BRIDGE_ENDPOINT=https://host.docker.internal:17871
OPEN_SHELL_BRIDGE_CA_FILE=/run/secrets/bridge-ca
OPEN_SHELL_BRIDGE_CLIENT_CERT_FILE=/run/secrets/bridge-client-cert
OPEN_SHELL_BRIDGE_CLIENT_KEY_FILE=/run/secrets/bridge-client-key
OPEN_SHELL_BRIDGE_PROFILE_DIGEST=sha256:<reviewed-profile-digest>
```

The WSL process owns its TLS server key, bridge CA, `openshell` and `ssh` paths/digests, isolated gateway name, immutable image/policy/provider profile, and owner-only temporary state. Raw OpenShell is the sole owner of disposable app sandboxes. Direct `/usr/local/bin/hermes acp` runs over a validated per-sandbox OpenShell SSH config; `nemoclaw-acp` and NemoHermes registry/destroy commands are reserved for the separate operator fixture. None of those values belongs in the app image or browser configuration. The provider key stays in the OpenShell gateway and is never sent through this protocol.

The current app-side seam enforces TLS 1.3, client-certificate configuration, bounded length-delimited JSON control frames, run-bound capabilities, fixed operation names, and profile-digest matching. A future bridge must additionally enforce fixed CLI argv, archive validation, child deadlines, stderr isolation, ACP framing, and confirmed deletion before advertising all required operations.

`policy.json` is the candidate create-time sandbox policy tested on the isolated gateway. Its SHA-256 is `1e9674c371a3e3074d1e72131054e5dda64314d4accfbb18da9feeba43082901`; it runs as `sandbox`, writes only to sandbox-local paths, and permits only `inference.local` in its network policy. The bridge must verify those exact bytes and the gateway's effective policy hash for each created sandbox before starting ACP. The fixture evidence is in `.codex/docs/personal-ai-workspace-mvp/task-3-1-live-integration/artifacts/raw-openshell-foundation.md` at the workspace root.

Provisioning, supervision, firewall scope, Docker `host.docker.internal` reachability, reviewed create-time policy/image references, exact binary hashes, transfer verification, and the two-run app fixture remain deployment inputs. A keyless raw OpenShell create/ACP/cancel/delete probe passed on the isolated gateway; it does not enable live app mode. Do not point the app at the OpenShell gateway port or reuse `pai-hermes`.
