#!/usr/bin/env bash
set -Eeuo pipefail

readonly DATA_MOUNT=/mnt/pai-data
readonly OPEN_SHELL_VERSION=v0.0.116
readonly OPEN_SHELL_INSTALLER="https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.0.116/install.sh"
readonly OPEN_SHELL_SHA256=24e85062073d512d1951c76cd3890b7bce1ab01cc36a08f88b3b43c067a402da
readonly OPEN_SHELL_GATEWAY_SHA256=780fc7ad871e2163f3fb866a2d0254ee682fc0d83e6261a84b350c8dcdd9f47b

fail() {
  printf 'FAIL  %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command is unavailable: $1."
}

trim_whitespace() {
  local value=$1
  value=${value#"${value%%[![:space:]]*}"}
  value=${value%"${value##*[![:space:]]}"}
  printf '%s' "$value"
}

readonly RUNTIME_USER=${PAI_RUNTIME_USER:-pai-runtime}
[[ "$RUNTIME_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail "PAI_RUNTIME_USER must be a simple Linux service-account name."
readonly RUNTIME_HOME="$DATA_MOUNT/runtime/$RUNTIME_USER"

run_runtime() {
  runuser -u "$RUNTIME_USER" -- env -i \
    HOME="$RUNTIME_HOME" \
    XDG_RUNTIME_DIR="/run/user/$RUNTIME_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$RUNTIME_UID/bus" \
    LANG=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$@"
}

prepare_runtime_parent() {
  if [[ ! -e "$DATA_MOUNT/runtime" && ! -L "$DATA_MOUNT/runtime" ]]; then
    getent passwd "$RUNTIME_USER" >/dev/null && fail "The runtime account exists but its durable parent is missing."
    install -d -o root -g root -m 0755 "$DATA_MOUNT/runtime"
    return
  fi
  [[ -d "$DATA_MOUNT/runtime" && ! -L "$DATA_MOUNT/runtime" && $(readlink -f -- "$DATA_MOUNT/runtime") == "$DATA_MOUNT/runtime" ]] || fail "The durable runtime parent must be a real canonical directory."
  [[ $(stat -c '%u' -- "$DATA_MOUNT/runtime") == 0 ]] || fail "The durable runtime parent must be owned by root."
  runtime_parent_mode=$(stat -c '%a' -- "$DATA_MOUNT/runtime") || fail "Cannot inspect the durable runtime parent permissions."
  (( (8#$runtime_parent_mode & 0022) == 0 )) || fail "The durable runtime parent must not be group- or world-writable."
  (( (8#$runtime_parent_mode & 0001) == 0001 )) || fail "The runtime parent must permit the service account to traverse it."
}

verify_ebs_identity() {
  local data_device_raw root_device_raw data_device root_device device_path candidate model serial expected
  data_device_raw=$(findmnt -n -o MAJ:MIN --target "$DATA_MOUNT") || fail "Cannot identify the data mount device."
  root_device_raw=$(findmnt -n -o MAJ:MIN --target /) || fail "Cannot identify the root filesystem device."
  data_device=$(trim_whitespace "$data_device_raw")
  root_device=$(trim_whitespace "$root_device_raw")
  [[ "$data_device" =~ ^[0-9]+:[0-9]+$ ]] || fail "The data mount returned an invalid block-device identity."
  [[ "$root_device" =~ ^[0-9]+:[0-9]+$ ]] || fail "The root filesystem returned an invalid block-device identity."
  [[ -n "$data_device" && "$data_device" != "$root_device" ]] || fail "The data mount must use a block device separate from /."

  device_path=$(readlink -e -- "/sys/dev/block/$data_device") || fail "Cannot resolve the data block device in sysfs."
  expected=${PAI_EBS_VOLUME_ID//-/}
  expected=${expected,,}
  candidate=$device_path
  while [[ "$candidate" != / ]]; do
    if [[ -r "$candidate/device/model" && -r "$candidate/device/serial" ]]; then
      model=$(trim_whitespace "$(tr -d '\r\n' < "$candidate/device/model")")
      serial=$(trim_whitespace "$(tr -d '\r\n' < "$candidate/device/serial")")
      serial=${serial,,}
      if [[ "$model" == "Amazon Elastic Block Store" && "$serial" == "$expected" ]]; then
        return 0
      fi
    fi
    candidate=$(dirname -- "$candidate")
  done
  fail "The mounted data device does not match PAI_EBS_VOLUME_ID in Nitro metadata."
}

verify_data_mount() {
  local filesystem options live_uuid
  [[ ! -L /mnt && ! -L "$DATA_MOUNT" && -d "$DATA_MOUNT" ]] || fail "$DATA_MOUNT and its /mnt parent must be real directories."
  [[ $(readlink -f -- "$DATA_MOUNT") == "$DATA_MOUNT" ]] || fail "$DATA_MOUNT must be a canonical mount path."
  mountpoint -q -- "$DATA_MOUNT" || fail "$DATA_MOUNT is not an exact mounted filesystem."
  filesystem=$(findmnt -n -o FSTYPE --mountpoint "$DATA_MOUNT") || fail "Cannot read the data filesystem type."
  options=$(findmnt -n -o OPTIONS --mountpoint "$DATA_MOUNT") || fail "Cannot read the live data mount options."
  [[ "$filesystem" == ext4 || "$filesystem" == xfs ]] || fail "The data filesystem must be ext4 or xfs."
  case ",$options," in
    *,rw,* ) ;;
    *) fail "The live data filesystem must be mounted read-write." ;;
  esac
  case ",$options," in
    *,ro,* ) fail "The live data filesystem is read-only." ;;
  esac

  local -a entries=()
  mapfile -t entries < <(awk -v target="$DATA_MOUNT" '$0 !~ /^[[:space:]]*#/ && NF >= 4 && $2 == target { printf "%s\t%s\t%s\n", $1, $3, $4 }' /etc/fstab)
  [[ ${#entries[@]} -eq 1 ]] || fail "/etc/fstab must have exactly one required entry for $DATA_MOUNT."
  local source fstab_filesystem fstab_options
  IFS=$'\t' read -r source fstab_filesystem fstab_options <<< "${entries[0]}"
  [[ "$source" == UUID=* && -n "${source#UUID=}" ]] || fail "The data fstab entry must use its filesystem UUID."
  [[ "$fstab_filesystem" == "$filesystem" ]] || fail "The fstab filesystem type must match the live mount."
  case ",$fstab_options," in
    *,ro,*|*,noauto,*|*,nofail,*|*,x-systemd.automount,* ) fail "The data fstab entry must be writable and required during boot." ;;
  esac
  live_uuid=$(findmnt -n -o UUID --mountpoint "$DATA_MOUNT") || fail "Cannot read the mounted filesystem UUID."
  [[ -n "$live_uuid" && "${source#UUID=}" == "$live_uuid" ]] || fail "The fstab UUID does not identify the mounted data filesystem."
  verify_ebs_identity
}

verify_docker() {
  local server_version docker_root root_device data_device version_core major
  server_version=$(docker version --format '{{.Server.Version}}') || fail "Docker Engine is not available."
  version_core=${server_version%%[-+~]*}
  [[ "$version_core" =~ ^([0-9]+)\.([0-9]+)(\.([0-9]+))?$ ]] || fail "Cannot parse the Docker Engine server version."
  major=${BASH_REMATCH[1]}
  (( 10#$major >= 28 )) || fail "OpenShell 0.0.116 requires Docker Engine 28.0 or later."
  docker_root=$(docker info --format '{{.DockerRootDir}}') || fail "Cannot inspect the Docker data root."
  docker_root=$(readlink -f -- "$docker_root") || fail "The Docker data root is not an existing path."
  [[ "$docker_root" == "$DATA_MOUNT/"* ]] || fail "DockerRootDir must be beneath $DATA_MOUNT."
  root_device=$(stat -c '%d' -- "$docker_root") || fail "Cannot inspect DockerRootDir device."
  data_device=$(stat -c '%d' -- "$DATA_MOUNT") || fail "Cannot inspect data filesystem device."
  [[ "$root_device" == "$data_device" ]] || fail "DockerRootDir must remain on the mounted EBS filesystem."
}

verify_binary_hash() {
  local path=$1 expected=$2 actual
  [[ -x "$path" ]] || fail "Pinned OpenShell binary is missing: $path."
  actual=$(sha256sum -- "$path" | awk '{ print $1 }') || fail "Cannot verify a pinned OpenShell binary."
  [[ "$actual" == "$expected" ]] || fail "OpenShell binary hash does not match the reviewed 0.0.116 release: $path."
}

[[ $(id -u) -eq 0 ]] || fail "Run this installer as root through the host operator session."
[[ -n "${PAI_EBS_VOLUME_ID:-}" && "$PAI_EBS_VOLUME_ID" =~ ^vol-[[:xdigit:]]{17}$ ]] || fail "Set PAI_EBS_VOLUME_ID to the exact CloudFormation DataVolumeId."

source /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || fail "This installer supports the reviewed Ubuntu 24.04 host only."
[[ $(dpkg --print-architecture) == amd64 ]] || fail "This installer supports the reviewed Ubuntu amd64 package only."

for command_name in awk chown curl dpkg env find findmnt getent grep id install loginctl mountpoint mktemp readlink runuser sha256sum stat systemctl tr useradd usermod; do
  require_command "$command_name"
done

verify_data_mount
verify_docker
prepare_runtime_parent

if ! getent passwd "$RUNTIME_USER" >/dev/null; then
  getent group docker >/dev/null || fail "Install Docker Engine with its docker group before creating the runtime account."
  if [[ -e "$RUNTIME_HOME" || -L "$RUNTIME_HOME" ]]; then
    [[ -d "$RUNTIME_HOME" && ! -L "$RUNTIME_HOME" && $(readlink -f -- "$RUNTIME_HOME") == "$RUNTIME_HOME" ]] || fail "A pre-existing runtime home must be a real canonical directory."
    [[ $(stat -c '%u' -- "$RUNTIME_HOME") == 0 ]] || fail "A pre-existing runtime home without its service account must be root-owned."
    [[ $(find "$RUNTIME_HOME" -mindepth 1 -maxdepth 1 -print -quit) == "" ]] || fail "A nonempty runtime home exists without its service account; inspect it before continuing."
    [[ $(stat -c '%d' -- "$RUNTIME_HOME") == $(stat -c '%d' -- "$DATA_MOUNT") ]] || fail "A pre-existing runtime home must be on the durable EBS filesystem."
    useradd --system --no-create-home --home-dir "$RUNTIME_HOME" --shell /usr/sbin/nologin --user-group "$RUNTIME_USER"
    chown "$RUNTIME_USER:$RUNTIME_USER" "$RUNTIME_HOME"
  else
    useradd --system --create-home --home-dir "$RUNTIME_HOME" --shell /usr/sbin/nologin --user-group "$RUNTIME_USER"
  fi
  usermod -aG docker "$RUNTIME_USER"
  chmod 0700 "$RUNTIME_HOME"
else
  IFS=: read -r _ _ RUNTIME_UID _ _ existing_home existing_shell < <(getent passwd "$RUNTIME_USER")
  [[ "$existing_home" == "$RUNTIME_HOME" ]] || fail "The existing runtime account home must be exactly $RUNTIME_HOME."
  [[ "$existing_shell" == /usr/sbin/nologin ]] || fail "The runtime account must have the non-login shell /usr/sbin/nologin."
  id -nG "$RUNTIME_USER" | tr ' ' '\n' | grep -qx docker || fail "Add the existing runtime account to the docker group, then rerun."
fi

IFS=: read -r _ _ RUNTIME_UID _ _ existing_home existing_shell < <(getent passwd "$RUNTIME_USER")
[[ -d "$RUNTIME_HOME" && ! -L "$RUNTIME_HOME" ]] || fail "The runtime account home is missing or is a symlink."
[[ $(readlink -f -- "$RUNTIME_HOME") == "$RUNTIME_HOME" ]] || fail "The runtime account home must be canonical."
[[ $(stat -c '%u' -- "$RUNTIME_HOME") == "$RUNTIME_UID" ]] || fail "The runtime account must own its durable home."
[[ $(stat -c '%d' -- "$RUNTIME_HOME") == $(stat -c '%d' -- "$DATA_MOUNT") ]] || fail "The runtime account home must be on the durable EBS filesystem."
runtime_home_mode=$(stat -c '%a' -- "$RUNTIME_HOME") || fail "Cannot inspect the runtime account home permissions."
(( (8#$runtime_home_mode & 0077) == 0 )) || fail "The runtime account home must not be accessible to its group or other users."
if [[ -e /usr/bin/openshell || -e /usr/bin/openshell-gateway ]]; then
  [[ -x /usr/bin/openshell && -x /usr/bin/openshell-gateway ]] || fail "A partial OpenShell package exists; inspect it before changing the host."
else
  for old_binary in "$RUNTIME_HOME/.local/bin/openshell" "$RUNTIME_HOME/.local/bin/openshell-gateway" /usr/local/bin/openshell /usr/local/bin/openshell-gateway; do
    [[ ! -e "$old_binary" ]] || fail "An existing custom OpenShell binary needs operator review before package installation."
  done
  for old_state in "$RUNTIME_HOME/.config/openshell" "$RUNTIME_HOME/.local/state/personal-ai-hermes"; do
    [[ ! -e "$old_state" ]] || fail "Existing runtime state needs an explicit backup/recovery decision before installation."
  done
fi

RUNTIME_UID=$(id -u "$RUNTIME_USER")
loginctl enable-linger "$RUNTIME_USER"
if ! systemctl is-active --quiet "user@$RUNTIME_UID.service"; then
  systemctl start "user@$RUNTIME_UID.service"
fi
for _ in {1..30}; do
  [[ -S "/run/user/$RUNTIME_UID/bus" ]] && break
  sleep 1
done
[[ -S "/run/user/$RUNTIME_UID/bus" ]] || fail "The persistent systemd user manager did not start for $RUNTIME_USER."

if [[ ! -x /usr/bin/openshell ]]; then
  temporary=$(mktemp -d)
  trap 'rm -f -- "$temporary/install.sh" "$temporary/install.log"; rmdir -- "$temporary" 2>/dev/null || true' EXIT
  curl --fail --location --silent --show-error --output "$temporary/install.sh" "$OPEN_SHELL_INSTALLER" || fail "Cannot download the pinned OpenShell installer."
  if ! env -i \
    HOME=/root \
    LANG=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    SUDO_USER="$RUNTIME_USER" \
    OPENSHELL_VERSION="$OPEN_SHELL_VERSION" \
    sh "$temporary/install.sh" >"$temporary/install.log" 2>&1; then
    fail "The OpenShell v0.0.116 package installation failed; inspect the host package-manager logs."
  fi
fi

version=$(run_runtime /usr/bin/openshell --version 2>/dev/null) || fail "The installed OpenShell CLI cannot report its version."
[[ "$version" =~ (^|[^0-9])v?0\.0\.116($|[^0-9]) ]] || fail "The installed OpenShell CLI is not version 0.0.116."
verify_binary_hash /usr/bin/openshell "$OPEN_SHELL_SHA256"
verify_binary_hash /usr/bin/openshell-gateway "$OPEN_SHELL_GATEWAY_SHA256"
run_runtime systemctl --user enable --now openshell-gateway.service >/dev/null 2>&1 || fail "The OpenShell gateway user service could not be enabled."
run_runtime systemctl --user is-active --quiet openshell-gateway.service || fail "The OpenShell gateway user service is not active."
run_runtime /usr/bin/openshell whoami --output json -g openshell >/dev/null 2>&1 || fail "The local OpenShell gateway is not registered and ready."

printf 'PASS  OpenShell %s is hash-verified and active for %s; no provider route or inference was configured.\n' "$OPEN_SHELL_VERSION" "$RUNTIME_USER"
