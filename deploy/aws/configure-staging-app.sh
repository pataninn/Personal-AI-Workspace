#!/usr/bin/env bash
set +x
set -Eeuo pipefail
umask 077

readonly DATA_MOUNT=/mnt/pai-data
readonly APP_ROOT=/mnt/pai-data/app
readonly RUNTIME_USER=pai-runtime
readonly RUNTIME_HOME=/mnt/pai-data/runtime/pai-runtime
readonly RUNTIME_STATE="$RUNTIME_HOME/.local/state/personal-ai-hermes"
readonly TLS_DIR="$APP_ROOT/private/tls"
readonly APP_CA_DIR="$APP_ROOT/private/app-ca"
readonly APP_CA_ETC_DIR=/etc/personal-ai-workspace/tls
readonly APP_CA_ETC_FILE="$APP_CA_ETC_DIR/app-ca.pem"
readonly HERMES_CERT_DIR="$APP_ROOT/secrets/hermes-bridge"
readonly APP_IMAGE_SOURCE=personal-ai-workspace-public-rehearsal:20261025-patched
readonly APP_IMAGE_TARGET=personal-ai-workspace-personal-ai-app:latest
readonly PROJECT_NAME=personal-ai-workspace
readonly LOCK_FILE=/run/lock/pai-configure-staging-app.lock

WORK_DIR=

fail() {
  printf 'FAIL  %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Usage:
  sudo bash configure-staging-app.sh prepare <validated-public-ipv4> <DataVolumeId>

Prepares a fresh /mnt/pai-data/app checkout. It does not start a container or send inference.
USAGE
  exit 2
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -f -- "$WORK_DIR"/*
    rmdir -- "$WORK_DIR" 2>/dev/null || true
  fi
  exit "$status"
}

verify_public_ip() {
  python3 - "$PUBLIC_IP" <<'PY' >/dev/null 2>&1 || fail 'The supplied application origin must be a globally routable IPv4 address.'
import ipaddress
import sys

try:
    address = ipaddress.ip_address(sys.argv[1])
except ValueError:
    raise SystemExit(1)
if address.version != 4 or not address.is_global:
    raise SystemExit(1)
PY
}

verify_expected_mount() {
  env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8 PYTHONPATH="$APP_ROOT" python3 - "$EBS_VOLUME_ID" <<'PY' \
    || fail 'The exact mounted EBS volume failed the read-only staging preflight.'
import sys
from pathlib import Path

from deploy.aws.preflight import checked_absolute_path, checked_directory, verify_ebs_mount

try:
    mount = Path('/mnt/pai-data')
    checked_absolute_path(str(mount), '--data-mount')
    checked_directory(mount, '--data-mount')
    verify_ebs_mount(
        mount,
        sys.argv[1],
        Path('/proc/self/mountinfo').read_text(),
        Path('/etc/fstab').read_text(),
    )
except Exception:
    raise SystemExit(1)
PY
}

ensure_safe_system_dir() {
  local directory=$1 mode
  if [[ -L "$directory" ]]; then
    fail "Refusing a symlink in the application CA path: $directory."
  fi
  if [[ ! -e "$directory" ]]; then
    install -o root -g root -m 0755 -d -- "$directory" || fail "Cannot create the application CA directory: $directory."
  fi
  [[ -d "$directory" && "$(stat -c '%u' -- "$directory")" == 0 ]] || fail "The application CA path must be a root-owned directory: $directory."
  mode=$(stat -c '%a' -- "$directory") || fail 'Cannot inspect application CA directory permissions.'
  (( (8#$mode & 0022) == 0 && (8#$mode & 0001) == 0001 )) || fail 'The application CA directory must be traversable and not group- or world-writable.'
}

write_new_file() {
  local destination=$1 value=$2
  [[ ! -e "$destination" && ! -L "$destination" ]] || fail "Refusing to overwrite an existing staging file: $destination."
  ( set -o noclobber; printf '%s\n' "$value" > "$destination" ) || fail "Cannot create a fresh staging file: $destination."
}

make_app_tls() {
  cat >"$WORK_DIR/leaf.ext" <<'EOF'
[server_cert]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF

  openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
    -subj '/CN=Personal AI Staging App CA' \
    -addext 'basicConstraints=critical,CA:TRUE' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -addext 'subjectKeyIdentifier=hash' \
    -keyout "$WORK_DIR/app-ca.key" -out "$WORK_DIR/app-ca.pem" >/dev/null 2>&1 \
    || fail 'Could not generate the private app TLS CA.'
  openssl req -new -newkey rsa:3072 -nodes -sha256 \
    -subj '/CN=localhost' \
    -keyout "$WORK_DIR/tls.key" -out "$WORK_DIR/tls.csr" >/dev/null 2>&1 \
    || fail 'Could not generate the localhost app TLS key and request.'
  openssl x509 -req -sha256 -days 365 \
    -in "$WORK_DIR/tls.csr" \
    -CA "$WORK_DIR/app-ca.pem" -CAkey "$WORK_DIR/app-ca.key" \
    -CAserial "$WORK_DIR/app-ca.srl" -CAcreateserial \
    -extfile "$WORK_DIR/leaf.ext" -extensions server_cert \
    -out "$WORK_DIR/tls.crt" >/dev/null 2>&1 \
    || fail 'Could not sign the localhost app TLS certificate.'
  openssl verify -CAfile "$WORK_DIR/app-ca.pem" -verify_hostname localhost "$WORK_DIR/tls.crt" >/dev/null 2>&1 \
    || fail 'The app TLS leaf did not verify against its CA for localhost.'

  install -o root -g root -m 0600 -- "$WORK_DIR/app-ca.key" "$APP_CA_DIR/app-ca.key" || fail 'Could not install the private app TLS CA key.'
  install -o root -g root -m 0644 -- "$WORK_DIR/app-ca.pem" "$APP_CA_DIR/app-ca.pem" || fail 'Could not install the app TLS CA certificate.'
  install -o root -g 10001 -m 0640 -- "$WORK_DIR/tls.key" "$TLS_DIR/tls.key" || fail 'Could not install the app TLS private key.'
  install -o root -g 10001 -m 0640 -- "$WORK_DIR/tls.crt" "$TLS_DIR/tls.crt" || fail 'Could not install the app TLS leaf certificate.'
  install -o root -g root -m 0644 -- "$WORK_DIR/app-ca.pem" "$APP_CA_ETC_FILE" || fail 'Could not install the app CA certificate for Nginx verification.'
}

prepare_bridge_client_certificates() {
  runuser -u "$RUNTIME_USER" -- env -i \
    HOME="$RUNTIME_HOME" \
    LANG=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PAI_GATEWAY_MODE=packaged-linux \
    PYTHONPATH="$APP_ROOT/deploy/hermes-bridge" \
    python3 - "$HERMES_CERT_DIR" <<'PY' >/dev/null 2>&1 || fail 'Could not generate the bridge mTLS client files with the existing certificate helper.'
import sys
from pathlib import Path

from setup import certificates

certificates(Path(sys.argv[1]))
PY
  chown -R "$RUNTIME_USER:10001" "$HERMES_CERT_DIR" || fail 'Could not assign bridge certificate ownership.'
  chmod 0710 "$HERMES_CERT_DIR" || fail 'Could not set the bridge certificate directory permissions.'
  chmod 0640 "$HERMES_CERT_DIR/ca.crt" "$HERMES_CERT_DIR/client.crt" "$HERMES_CERT_DIR/client.key" \
    || fail 'Could not set bridge certificate permissions for app UID/GID 10001.'
}

[[ "$EUID" -eq 0 ]] || fail 'Run as root through the already-authorized SSM session.'
[[ $# -eq 3 && "$1" == prepare ]] || usage
PUBLIC_IP=$2
EBS_VOLUME_ID=$3
[[ "$EBS_VOLUME_ID" =~ ^vol-[[:xdigit:]]{17}$ ]] || fail 'Supply the exact CloudFormation DataVolumeId.'
verify_public_ip

for command in chmod chown cmp docker env flock getent grep id install mktemp mountpoint openssl python3 readlink rm rmdir runuser stat tr dirname cat; do
  command -v "$command" >/dev/null 2>&1 || fail "Required staging utility is unavailable: $command."
done

SCRIPT_PATH=$(readlink -e -- "${BASH_SOURCE[0]}") || fail 'Cannot resolve the staging script path.'
PROJECT_ROOT=$(cd -- "$(dirname -- "$SCRIPT_PATH")/../.." && pwd -P) || fail 'Cannot resolve the application source directory.'
[[ "$SCRIPT_PATH" == "$APP_ROOT/deploy/aws/configure-staging-app.sh" && "$PROJECT_ROOT" == "$APP_ROOT" ]] \
  || fail 'Run this script from the verified fresh checkout at /mnt/pai-data/app.'
[[ -d "$DATA_MOUNT" && ! -L /mnt && ! -L "$DATA_MOUNT" && "$(readlink -e -- "$DATA_MOUNT")" == "$DATA_MOUNT" ]] \
  || fail '/mnt/pai-data must be a real canonical mounted directory.'
for required_source in compose.yaml compose.managed-storage.yaml deploy/aws/preflight.py deploy/hermes-bridge/setup.py backend/src/infrastructure/database/migrations/1710000028000-create-credit-ledger.ts; do
  [[ -f "$APP_ROOT/$required_source" && ! -L "$APP_ROOT/$required_source" ]] || fail "The transferred application source is incomplete: $required_source."
done

exec {lock_fd}>"$LOCK_FILE"
flock -n "$lock_fd" || fail 'Another staging preparation is already running.'
verify_expected_mount

docker_root=$(docker info --format '{{.DockerRootDir}}') || fail 'Docker Engine is not ready.'
docker_root=$(readlink -e -- "$docker_root") || fail 'DockerRootDir is not an existing canonical path.'
case "$docker_root/" in "$DATA_MOUNT/"*) ;; *) fail 'DockerRootDir must be beneath the verified EBS mount.' ;; esac
[[ $(stat -c '%d' -- "$docker_root") == $(stat -c '%d' -- "$DATA_MOUNT") ]] || fail 'DockerRootDir is not on the verified EBS filesystem.'

existing_project_containers=$(docker ps --all --quiet --filter "label=com.docker.compose.project=$PROJECT_NAME") \
  || fail 'Cannot safely check for existing application containers.'
[[ -z "$existing_project_containers" ]] || fail 'Existing Compose project containers were found; refusing to touch prior application state.'
existing_volumes=$(docker volume ls --format '{{.Name}}') || fail 'Cannot safely inspect Docker volumes.'
for expected_volume in pai_pg_data pai_recovery; do
  if grep -Fxq "$expected_volume" <<< "$existing_volumes"; then
    fail "The expected fresh database/recovery volume already exists: $expected_volume."
  fi
done

source_image_id=$(docker image inspect --format '{{.Id}}' "$APP_IMAGE_SOURCE" 2>/dev/null) \
  || fail 'The preloaded patched application image is missing; do not build it on this host.'
[[ "$source_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'The preloaded application image has an invalid local image identity.'
target_image_id=$(docker image inspect --format '{{.Id}}' "$APP_IMAGE_TARGET" 2>/dev/null || true)
[[ -z "$target_image_id" || "$target_image_id" == "$source_image_id" ]] || fail 'The Compose default application image tag points to a different image.'

runtime_record=$(getent passwd "$RUNTIME_USER") || fail 'The persistent pai-runtime service account is missing.'
IFS=: read -r _ _ runtime_uid runtime_gid _ runtime_home runtime_shell <<< "$runtime_record"
[[ "$runtime_home" == "$RUNTIME_HOME" && "$runtime_shell" == /usr/sbin/nologin ]] \
  || fail 'The pai-runtime account must have the reviewed durable home and non-login shell.'
[[ -d "$RUNTIME_HOME" && ! -L "$RUNTIME_HOME" && "$(readlink -e -- "$RUNTIME_HOME")" == "$RUNTIME_HOME" ]] \
  || fail 'The persistent pai-runtime home is missing or noncanonical.'
[[ $(stat -c '%u' -- "$RUNTIME_HOME") == "$runtime_uid" && $(stat -c '%d' -- "$RUNTIME_HOME") == $(stat -c '%d' -- "$DATA_MOUNT") ]] \
  || fail 'The pai-runtime home must be service-user-owned on the verified EBS filesystem.'
[[ ! -e "$RUNTIME_STATE" && ! -L "$RUNTIME_STATE" ]] || fail 'Existing Hermes bridge state needs operator review before fresh preparation.'

for path in \
  "$APP_ROOT/.env" "$APP_ROOT/workspace" "$APP_ROOT/account-workspaces" \
  "$APP_ROOT/secrets" "$APP_ROOT/private" "$APP_CA_ETC_FILE"; do
  [[ ! -e "$path" && ! -L "$path" ]] || fail "A staging destination already exists; refusing to overwrite it: $path."
done
ensure_safe_system_dir /etc/personal-ai-workspace
ensure_safe_system_dir "$APP_CA_ETC_DIR"
[[ ! -e "$APP_CA_ETC_FILE" && ! -L "$APP_CA_ETC_FILE" ]] || fail 'An application CA file already exists; refusing to replace it.'

[[ -f "$APP_ROOT/deploy/aws/preflight.py" ]] || fail 'The read-only EBS/Compose preflight is missing.'
grep -Fq '"inference_paused" boolean NOT NULL DEFAULT true' \
  "$APP_ROOT/backend/src/infrastructure/database/migrations/1710000028000-create-credit-ledger.ts" \
  || fail 'The transferred source does not define a paused-by-default credit policy.'
grep -Fq 'VALUES (1, true)' \
  "$APP_ROOT/backend/src/infrastructure/database/migrations/1710000028000-create-credit-ledger.ts" \
  || fail 'The transferred source does not seed global inference as paused.'

WORK_DIR=$(mktemp -d /run/pai-configure-staging-app.XXXXXX) || fail 'Cannot create a private temporary TLS workspace.'
trap cleanup EXIT

POSTGRES_PASSWORD=$(openssl rand -hex 32) || fail 'Could not generate the fresh database credential.'
SESSION_SECRET=$(openssl rand -hex 32) || fail 'Could not generate the fresh session secret.'
DEMO_NETWORK_HASH_SECRET=$(openssl rand -hex 32) || fail 'Could not generate the fresh demo network secret.'
LOCAL_USER_PASSWORD=$(openssl rand -base64 32 | tr -d '\r\n') || fail 'Could not generate the fresh local admin password.'
WORKSPACE_IDENTITY=$(openssl rand -hex 32) || fail 'Could not generate the workspace identity marker.'
ACCOUNT_WORKSPACES_IDENTITY=$(openssl rand -hex 32) || fail 'Could not generate the managed-workspace identity marker.'
[[ ${#POSTGRES_PASSWORD} -eq 64 && ${#SESSION_SECRET} -eq 64 && ${#DEMO_NETWORK_HASH_SECRET} -eq 64 ]] \
  || fail 'A staging secret generator returned an invalid value.'
[[ ${#LOCAL_USER_PASSWORD} -ge 40 && ${#LOCAL_USER_PASSWORD} -le 72 ]] || fail 'The fresh local admin password has an invalid length.'

install -o 10001 -g 10001 -m 0700 -d -- "$APP_ROOT/workspace" "$APP_ROOT/account-workspaces" \
  || fail 'Could not create fresh disjoint workspace roots for app UID/GID 10001.'
install -o root -g "$runtime_gid" -m 0710 -d -- "$APP_ROOT/secrets" \
  || fail 'Could not create the protected app secrets directory.'
install -o root -g root -m 0700 -d -- "$APP_ROOT/private" "$APP_CA_DIR" \
  || fail 'Could not create private app TLS storage.'
install -o root -g 10001 -m 0750 -d -- "$TLS_DIR" \
  || fail 'Could not create the app TLS mount directory.'
install -o "$RUNTIME_USER" -g 10001 -m 2710 -d -- "$HERMES_CERT_DIR" \
  || fail 'Could not create the fresh bridge mTLS destination.'

write_new_file "$APP_ROOT/workspace/.personal-ai-workspace-identity" "$WORKSPACE_IDENTITY"
write_new_file "$APP_ROOT/account-workspaces/.personal-ai-managed-storage-identity" "$ACCOUNT_WORKSPACES_IDENTITY"
chown 10001:10001 "$APP_ROOT/workspace/.personal-ai-workspace-identity" "$APP_ROOT/account-workspaces/.personal-ai-managed-storage-identity" \
  || fail 'Could not assign workspace marker ownership.'
chmod 0600 "$APP_ROOT/workspace/.personal-ai-workspace-identity" "$APP_ROOT/account-workspaces/.personal-ai-managed-storage-identity" \
  || fail 'Could not set workspace marker permissions.'

make_app_tls

write_new_file "$APP_ROOT/secrets/local_user_password" "$LOCAL_USER_PASSWORD"
chown root:10001 "$APP_ROOT/secrets/local_user_password" || fail 'Could not assign the local admin password file group.'
chmod 0440 "$APP_ROOT/secrets/local_user_password" || fail 'Could not set the local admin password file permissions.'

APP_ORIGIN="https://$PUBLIC_IP"
if ! (set -o noclobber; cat > "$APP_ROOT/.env" <<EOF
WORKSPACE_HOST_ROOT=$APP_ROOT/workspace
WORKSPACE_IDENTITY=$WORKSPACE_IDENTITY
WORKSPACE_IDENTITY_FILE=/workspace/.personal-ai-workspace-identity
ACCOUNT_WORKSPACES_HOST_ROOT=$APP_ROOT/account-workspaces
ACCOUNT_WORKSPACES_IDENTITY=$ACCOUNT_WORKSPACES_IDENTITY
APP_PORT=8443
APP_PROTOCOL=https
APP_ORIGIN=$APP_ORIGIN
TLS_CERT_DIR=$TLS_DIR
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
SESSION_SECRET=$SESSION_SECRET
DEMO_NETWORK_HASH_SECRET=$DEMO_NETWORK_HASH_SECRET
LOCAL_USER_PASSWORD_FILE=./secrets/local_user_password
POSTGRES_VOLUME_NAME=pai_pg_data
RECOVERY_VOLUME_NAME=pai_recovery
TRUSTED_PROXY_CIDRS=
NIM_PROFILE=nebius-token-factory
NIM_ENDPOINT=https://api.tokenfactory.nebius.com/v1
NIM_MODEL=nvidia/nemotron-3-super-120b-a12b
NIM_CREDIT_PRICE_VERSION=
NIM_INPUT_CREDIT_UNITS_PER_MILLION_TOKENS=
NIM_OUTPUT_CREDIT_UNITS_PER_MILLION_TOKENS=
NIM_MAX_INPUT_TOKENS=
NIM_MAX_OUTPUT_TOKENS=
NIM_MAX_PROVIDER_CALLS_PER_RUN=
NIM_ALLOW_ESTIMATED_HOME_USAGE=false
AGENT_RUNTIME_MODE=hermes
HERMES_BRIDGE_ENDPOINT=https://host.docker.internal:17871
LOG_LEVEL=info
EOF
); then
  fail 'Could not create a new private Compose environment file.'
fi
chown root:root "$APP_ROOT/.env" || fail 'Could not assign private Compose environment ownership.'
chmod 0600 "$APP_ROOT/.env" || fail 'Could not set private Compose environment permissions.'

prepare_bridge_client_certificates

env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 \
  python3 "$APP_ROOT/deploy/aws/preflight.py" --data-mount "$DATA_MOUNT" --ebs-volume-id "$EBS_VOLUME_ID" \
  || fail 'The read-only staging preflight did not pass; do not start the application.'

if [[ -z "$target_image_id" ]]; then
  docker image tag "$APP_IMAGE_SOURCE" "$APP_IMAGE_TARGET" >/dev/null \
    || fail 'Could not tag the preloaded image for the existing Compose service; no host build was attempted.'
fi
verified_target_image_id=$(docker image inspect --format '{{.Id}}' "$APP_IMAGE_TARGET" 2>/dev/null) \
  || fail 'The Compose default application image tag is unavailable.'
[[ "$verified_target_image_id" == "$source_image_id" ]] || fail 'The Compose default image tag does not match the preloaded patched image.'

printf 'PASS  Fresh app secrets, empty legacy/managed workspace roots, TLS, and bridge client certificates are prepared on the verified EBS volume.\n'
printf 'PASS  The preloaded patched app image is tagged for the existing Compose service; no image build or container start was attempted.\n'
printf 'PENDING  TRUSTED_PROXY_CIDRS is empty until the host observes and verifies the app container socket peer; then set only that /32 and recreate the app before public Nginx startup.\n'
printf 'PENDING  The bridge client PKI exists, but no provider key or route was configured; do not run full Hermes setup until key approval.\n'
printf 'PENDING  The app is not started. On first start, the verified migration-first command must seed global inference paused before the server process.\n'
printf 'PENDING  The generated initial admin password is stored in the local secret file; this script never prints it. Deliver it through the operator-approved secure channel.\n'
