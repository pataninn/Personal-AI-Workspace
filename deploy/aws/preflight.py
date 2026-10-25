#!/usr/bin/env python3
"""Read-only Linux checks for the AWS staging host before Compose startup."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


PROJECT_ROOT = Path(__file__).resolve().parents[2]
APP_UID = 10001
APP_GID = 10001
EXPECTED_SERVICES = {"postgres", "personal-ai-app"}
LEGACY_MARKER = ".personal-ai-workspace-identity"
MANAGED_MARKER = ".personal-ai-managed-storage-identity"


class PreflightError(Exception):
    """A safe, actionable preflight failure without secret values."""


@dataclass(frozen=True)
class MountEntry:
    mount_id: str
    device: str
    target: Path
    filesystem: str
    source: str
    options: frozenset[str]
    super_options: frozenset[str]


@dataclass(frozen=True)
class ExpectedContainerMount:
    kind: str
    source: Path | None
    read_write: bool
    name: str | None = None
    volume_key: str | None = None


def unescape_mount_field(value: str) -> str:
    return value.replace("\\040", " ").replace("\\011", "\t").replace("\\012", "\n").replace("\\134", "\\")


def parse_mountinfo(contents: str) -> list[MountEntry]:
    entries: list[MountEntry] = []
    for line in contents.splitlines():
        left, separator, right = line.partition(" - ")
        fields = left.split()
        details = right.split()
        if not separator or len(fields) < 6 or len(details) < 3:
            continue
        entries.append(MountEntry(
            fields[0], fields[2], Path(unescape_mount_field(fields[4])), details[0],
            unescape_mount_field(details[1]), frozenset(fields[5].split(",")),
            frozenset(details[2].split(",")),
        ))
    return entries


def parse_fstab_mounts(contents: str, target: Path) -> list[tuple[str, str, set[str]]]:
    matches: list[tuple[str, str, set[str]]] = []
    for line in contents.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        fields = line.split()
        if len(fields) >= 4 and Path(unescape_mount_field(fields[1])) == target:
            matches.append((fields[0], fields[2], set(fields[3].split(","))))
    return matches


def checked_absolute_path(raw: str, label: str) -> Path:
    path = Path(raw)
    if not path.is_absolute() or ".." in path.parts:
        raise PreflightError(f"{label} must be an absolute canonical Linux path.")
    if path == Path(path.anchor):
        raise PreflightError(f"{label} cannot be the filesystem root.")
    return Path(os.path.normpath(str(path)))


def checked_directory(path: Path, label: str) -> os.stat_result:
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        try:
            item = current.lstat()
        except OSError as error:
            raise PreflightError(f"{label} or one of its parent directories is missing.") from error
        if stat.S_ISLNK(item.st_mode):
            raise PreflightError(f"{label} contains a symbolic link in its path.")
        if not stat.S_ISDIR(item.st_mode):
            raise PreflightError(f"{label} and its parent path must contain only directories.")
    try:
        item = path.lstat()
    except OSError as error:
        raise PreflightError(f"{label} does not exist.") from error
    if not stat.S_ISDIR(item.st_mode):
        raise PreflightError(f"{label} must be an ordinary directory.")
    if path.resolve(strict=True) != path:
        raise PreflightError(f"{label} does not resolve to its configured path.")
    return item


def checked_file(path: Path, label: str) -> os.stat_result:
    checked_directory(path.parent, label)
    try:
        item = path.lstat()
    except OSError as error:
        raise PreflightError(f"{label} is missing.") from error
    if stat.S_ISLNK(item.st_mode) or not stat.S_ISREG(item.st_mode):
        raise PreflightError(f"{label} must be a regular file, not a link or special file.")
    if item.st_size == 0:
        raise PreflightError(f"{label} must not be empty.")
    return item


def is_beneath(path: Path, root: Path, *, strict: bool = False) -> bool:
    try:
        relative = path.relative_to(root)
    except ValueError:
        return False
    return bool(relative.parts) if strict else True


def mount_for(path: Path, entries: Iterable[MountEntry]) -> MountEntry | None:
    matching = [entry for entry in entries if is_beneath(path, entry.target)]
    return max(matching, key=lambda entry: len(entry.target.parts), default=None)


def require_same_mount(path: Path, root_mount: MountEntry, entries: list[MountEntry], label: str) -> None:
    selected = mount_for(path, entries)
    if selected is None or selected.mount_id != root_mount.mount_id:
        raise PreflightError(f"{label} is not on the verified EBS filesystem; move it beneath --data-mount.")


def ebs_device_verified(device: str, expected_volume_id: str, sysfs_block_root: Path = Path("/sys/dev/block")) -> bool:
    if not re.fullmatch(r"vol-[0-9a-f]+", expected_volume_id, flags=re.IGNORECASE):
        return False
    expected_serial = expected_volume_id.lower().replace("-", "")
    try:
        device_path = (sysfs_block_root / device).resolve(strict=True)
    except OSError:
        return False
    for candidate in (device_path, *device_path.parents):
        model_path = candidate / "device" / "model"
        serial_path = candidate / "device" / "serial"
        try:
            model = model_path.read_text(encoding="ascii").strip()
            serial = serial_path.read_text(encoding="ascii").strip().lower()
        except OSError:
            continue
        if model == "Amazon Elastic Block Store" and serial == expected_serial:
            return True
    return False


def verify_ebs_mount(data_mount: Path, expected_volume_id: str, mountinfo: str, fstab: str, sysfs_block_root: Path = Path("/sys/dev/block"), uuid_root: Path = Path("/dev/disk/by-uuid")) -> MountEntry:
    if not re.fullmatch(r"vol-[0-9a-f]+", expected_volume_id, flags=re.IGNORECASE):
        raise PreflightError("--ebs-volume-id must be the expected vol-... value from the infrastructure output.")
    entries = parse_mountinfo(mountinfo)
    exact = [entry for entry in entries if entry.target == data_mount]
    if len(exact) != 1:
        raise PreflightError("--data-mount must be an exact, currently mounted filesystem mountpoint.")
    mount = exact[0]
    root_entries = [entry for entry in entries if entry.target == Path("/")]
    if len(root_entries) != 1:
        raise PreflightError("The root filesystem mount could not be identified safely.")
    if mount.device == root_entries[0].device:
        raise PreflightError("--data-mount must use a separate block device from the root filesystem.")
    if mount.filesystem not in {"ext4", "xfs"}:
        raise PreflightError("--data-mount must use an EBS data filesystem formatted as ext4 or xfs.")
    if "rw" not in mount.options or "ro" in mount.options or "rw" not in mount.super_options or "ro" in mount.super_options:
        raise PreflightError("The live EBS data mount must be read-write; remount it rw before staging.")
    configured = parse_fstab_mounts(fstab, data_mount)
    if len(configured) != 1:
        raise PreflightError("/etc/fstab must contain exactly one required entry for --data-mount.")
    source, fstab_filesystem, options = configured[0]
    if fstab_filesystem != mount.filesystem:
        raise PreflightError("The /etc/fstab filesystem type must match the live EBS data mount.")
    if not source.startswith("UUID=") or not source[5:] or options.intersection({"noauto", "nofail", "ro", "x-systemd.automount"}):
        raise PreflightError("The data filesystem must use a UUID fstab entry required during boot.")
    try:
        uuid_device = os.stat(uuid_root / source[5:])
    except OSError as error:
        raise PreflightError("The fstab UUID does not resolve to the mounted data device.") from error
    if not stat.S_ISBLK(uuid_device.st_mode) or f"{os.major(uuid_device.st_rdev)}:{os.minor(uuid_device.st_rdev)}" != mount.device:
        raise PreflightError("The fstab UUID does not identify the currently mounted data device.")
    if not ebs_device_verified(mount.device, expected_volume_id, sysfs_block_root):
        raise PreflightError("The mounted block device does not match the expected Amazon EBS volume ID in Nitro metadata.")
    return mount


def app_has_access(item: os.stat_result, required: int, uid: int = APP_UID, gid: int = APP_GID) -> bool:
    mode = stat.S_IMODE(item.st_mode)
    if item.st_uid == uid:
        available = (mode >> 6) & 0b111
    elif item.st_gid == gid:
        available = (mode >> 3) & 0b111
    else:
        available = mode & 0b111
    return available & required == required


def ensure_app_access(item: os.stat_result, required: int, label: str) -> None:
    if not app_has_access(item, required):
        raise PreflightError(f"{label} must grant the container user 10001:10001 the required host mode-bit access.")


def ensure_private_key_permissions(item: os.stat_result, label: str) -> None:
    mode = stat.S_IMODE(item.st_mode)
    if mode & 0o037 or (mode & 0o040 and item.st_gid != APP_GID):
        raise PreflightError(f"{label} must not be group-writable or accessible outside the dedicated application group.")


def read_marker(root: Path, filename: str, expected: str, label: str) -> None:
    marker = root / filename
    item = checked_file(marker, label)
    ensure_app_access(item, 0b100, label)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(marker, flags)
        with os.fdopen(descriptor, "rb") as content_file:
            content = content_file.read(4097)
    except OSError as error:
        raise PreflightError(f"{label} cannot be read safely.") from error
    if len(content) > 4096 or content.decode("utf-8", errors="replace").strip() != expected:
        raise PreflightError(f"{label} does not match its configured identity.")


def ensure_disjoint_roots(legacy: Path, managed: Path) -> None:
    if is_beneath(legacy, managed) or is_beneath(managed, legacy):
        raise PreflightError("Legacy and managed storage roots must be distinct and disjoint.")


def resolve_compose_path(value: str, project_root: Path, label: str) -> Path:
    if not value or "${" in value or "\x00" in value:
        raise PreflightError(f"{label} must be explicitly configured without unresolved interpolation.")
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = project_root / candidate
    return checked_absolute_path(str(candidate), label)


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        contents = path.read_text(encoding="utf-8-sig")
    except OSError as error:
        raise PreflightError("The Compose .env file cannot be read.") from error
    for line in contents.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            values[key] = value
    return values


def configured_value(key: str, values: dict[str, str], default: str | None = None) -> str | None:
    return os.environ.get(key, values.get(key, default))


def require_data_child(path: Path, label: str, data_mount: Path, data_entry: MountEntry, mounts: list[MountEntry], *, directory: bool) -> os.stat_result:
    if not is_beneath(path, data_mount, strict=True):
        raise PreflightError(f"{label} must be a dedicated path beneath --data-mount.")
    item = checked_directory(path, label) if directory else checked_file(path, label)
    require_same_mount(path, data_entry, mounts, label)
    return item


def run_readonly(command: list[str], *, service_label: str) -> str:
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PreflightError(f"{service_label} could not be queried; install or check the Linux Docker Compose tools.") from error
    if result.returncode != 0:
        raise PreflightError(f"{service_label} query failed; inspect it locally without printing resolved Compose settings.")
    return result.stdout.strip()


def compose_base(project_root: Path, env_file: Path, managed: bool) -> list[str]:
    command = ["docker", "compose", "--project-name", "personal-ai-workspace", "--project-directory", str(project_root), "--env-file", str(env_file), "-f", str(project_root / "compose.yaml")]
    if managed:
        command.extend(["-f", str(project_root / "compose.managed-storage.yaml")])
    return command


def inspect_mounts(container_id: str) -> tuple[str, list[dict[str, object]], dict[str, str]]:
    user = run_readonly(["docker", "inspect", "--format", "{{json .Config.User}}", container_id], service_label="Docker container inspection")
    mounts = run_readonly(["docker", "inspect", "--format", "{{json .Mounts}}", container_id], service_label="Docker container mount inspection")
    tmpfs = run_readonly(["docker", "inspect", "--format", "{{json .HostConfig.Tmpfs}}", container_id], service_label="Docker container tmpfs configuration inspection")
    try:
        parsed_user = json.loads(user)
        parsed_mounts = json.loads(mounts)
        parsed_tmpfs = json.loads(tmpfs)
    except (json.JSONDecodeError, TypeError) as error:
        raise PreflightError("Docker returned an unreadable container configuration.") from error
    if parsed_tmpfs is None:
        parsed_tmpfs = {}
    if not isinstance(parsed_user, str) or not isinstance(parsed_mounts, list) or any(not isinstance(item, dict) for item in parsed_mounts):
        raise PreflightError("Docker returned an invalid container mount list.")
    if not isinstance(parsed_tmpfs, dict) or any(
        not isinstance(target, str) or not target.startswith("/") or not isinstance(options, str)
        for target, options in parsed_tmpfs.items()
    ):
        raise PreflightError("Docker returned an invalid tmpfs configuration.")
    return parsed_user, parsed_mounts, parsed_tmpfs


def compose_mounts(config: dict[str, object], service_name: str, docker_root: Path) -> dict[str, ExpectedContainerMount]:
    services = config.get("services")
    service = services.get(service_name) if isinstance(services, dict) else None
    volumes = config.get("volumes")
    secrets = config.get("secrets")
    if not isinstance(service, dict) or not isinstance(volumes, dict) or not isinstance(secrets, dict):
        raise PreflightError("Compose mount configuration is incomplete.")
    expected: dict[str, ExpectedContainerMount] = {}

    def add(target: object, mount: ExpectedContainerMount) -> None:
        if not isinstance(target, str) or not target.startswith("/") or target in expected:
            raise PreflightError(f"Compose defines an invalid or duplicate mount target for {service_name}.")
        expected[target] = mount

    raw_mounts = service.get("volumes", [])
    if not isinstance(raw_mounts, list):
        raise PreflightError(f"Compose volume definitions for {service_name} are invalid.")
    for item in raw_mounts:
        if not isinstance(item, dict):
            raise PreflightError(f"Compose volume definitions for {service_name} must use resolved long syntax.")
        kind = item.get("type")
        target = item.get("target")
        read_only = item.get("read_only", False)
        source = item.get("source")
        if not isinstance(read_only, bool):
            raise PreflightError(f"Compose access mode for {service_name} is invalid.")
        if kind == "bind":
            if not isinstance(source, str) or not Path(source).is_absolute():
                raise PreflightError(f"Compose bind source for {service_name} is not an absolute host path.")
            add(target, ExpectedContainerMount("bind", Path(os.path.realpath(source)), not read_only))
        elif kind == "volume":
            volume_definition = volumes.get(source) if isinstance(source, str) else None
            if not isinstance(volume_definition, dict):
                raise PreflightError(f"Compose volume source for {service_name} is not a declared named volume.")
            driver = volume_definition.get("driver", "local")
            driver_options = volume_definition.get("driver_opts") or {}
            volume_name = volume_definition.get("name", source)
            if volume_definition.get("external") or driver != "local" or driver_options or not isinstance(volume_name, str) or not volume_name:
                raise PreflightError("Persistent PostgreSQL and recovery volumes must be named local Docker volumes.")
            volume_source = docker_root / "volumes" / volume_name / "_data"
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", volume_name) or not is_beneath(volume_source, docker_root, strict=True):
                raise PreflightError("A Compose volume name resolves outside the Docker data root.")
            add(target, ExpectedContainerMount("volume", volume_source, not read_only, volume_name, source))
        else:
            raise PreflightError(f"Compose mount type for {service_name} is unsupported.")

    raw_secrets = service.get("secrets", [])
    if not isinstance(raw_secrets, list):
        raise PreflightError(f"Compose secrets for {service_name} are invalid.")
    for item in raw_secrets:
        if isinstance(item, str):
            source_name = item
            target_name = item
        elif isinstance(item, dict):
            source_name = item.get("source")
            target_name = item.get("target", source_name)
        else:
            raise PreflightError(f"Compose secret reference for {service_name} is invalid.")
        secret_definition = secrets.get(source_name) if isinstance(source_name, str) else None
        secret_file = secret_definition.get("file") if isinstance(secret_definition, dict) else None
        if not isinstance(secret_file, str) or not Path(secret_file).is_absolute():
            raise PreflightError("The local login secret must resolve to an absolute file path.")
        if not isinstance(target_name, str) or not target_name:
            target_name = source_name
        target = target_name if target_name.startswith("/") else f"/run/secrets/{target_name}"
        add(target, ExpectedContainerMount("bind", Path(os.path.realpath(secret_file)), False))

    raw_tmpfs = service.get("tmpfs", [])
    if isinstance(raw_tmpfs, str):
        raw_tmpfs = [raw_tmpfs]
    if not isinstance(raw_tmpfs, list):
        raise PreflightError(f"Compose tmpfs definitions for {service_name} are invalid.")
    for item in raw_tmpfs:
        if isinstance(item, str):
            target = item.split(":", 1)[0]
        elif isinstance(item, dict):
            target = item.get("target")
        else:
            raise PreflightError(f"Compose tmpfs target for {service_name} is invalid.")
        add(target, ExpectedContainerMount("tmpfs", None, True))
    return expected


def verify_actual_mounts(actual_mounts: list[dict[str, object]], expected: dict[str, ExpectedContainerMount], docker_root: Path) -> None:
    by_target: dict[str, dict[str, object]] = {}
    for item in actual_mounts:
        target = item.get("Destination")
        if not isinstance(target, str) or target in by_target:
            raise PreflightError("The actual container mount list has a missing or duplicate target.")
        by_target[target] = item
    if set(by_target) != set(expected):
        raise PreflightError("Actual container mount targets must exactly match the reviewed Compose mounts; remove unexpected mounts.")

    for target, wanted in expected.items():
        actual = by_target[target]
        if actual.get("Type") != wanted.kind or actual.get("RW") is not wanted.read_write:
            raise PreflightError(f"The actual container mount at {target} has the wrong type or access mode.")
        actual_name = actual.get("Name")
        if wanted.name is None:
            if actual_name not in (None, ""):
                raise PreflightError(f"The actual container mount at {target} has an unexpected volume name.")
        elif actual_name != wanted.name:
            raise PreflightError(f"The actual Docker volume at {target} does not match the Compose named volume.")

        actual_source = actual.get("Source")
        if wanted.kind in {"bind", "volume"}:
            if wanted.source is None:
                raise PreflightError(f"The expected mount at {target} has no resolved source.")
            if not isinstance(actual_source, str) or Path(os.path.realpath(actual_source)) != Path(os.path.realpath(wanted.source)):
                raise PreflightError(f"The actual container source at {target} does not match the resolved Compose source.")
        elif actual_source not in (None, "", "tmpfs"):
            raise PreflightError(f"The tmpfs mount at {target} unexpectedly has a host source.")

        if wanted.kind == "volume":
            source_path = Path(os.path.realpath(str(actual_source)))
            if not is_beneath(source_path, docker_root, strict=True):
                raise PreflightError(f"The persistent Docker volume at {target} is outside the verified Docker data root.")


def actual_mounts_with_tmpfs(
    container_id: str,
    mounts: list[dict[str, object]],
    host_tmpfs: dict[str, str],
    expected: dict[str, ExpectedContainerMount],
) -> list[dict[str, object]]:
    expected_tmpfs = {target: item for target, item in expected.items() if item.kind == "tmpfs"}
    if set(host_tmpfs) != set(expected_tmpfs):
        raise PreflightError("Docker HostConfig.Tmpfs targets must exactly match the reviewed Compose tmpfs mounts.")
    if not expected_tmpfs:
        return mounts

    for target, options in host_tmpfs.items():
        flags = {option.strip().lower().partition("=")[0] for option in options.split(",") if option.strip()}
        if "ro" in flags:
            raise PreflightError(f"The configured container tmpfs at {target} must be read-write.")

    mountinfo = run_readonly(
        [
            "docker", "exec", "--user", "10001:10001", container_id, "node", "-e",
            "process.stdout.write(require('node:fs').readFileSync('/proc/self/mountinfo','utf8'))",
        ],
        service_label="Docker container mount namespace inspection",
    )
    entries = parse_mountinfo(mountinfo)
    normalized = list(mounts)
    for target in expected_tmpfs:
        if any(item.get("Destination") == target for item in normalized):
            raise PreflightError(f"The actual container mount at {target} was reported more than once.")
        matches = [entry for entry in entries if entry.target == Path(target)]
        if len(matches) != 1:
            raise PreflightError(f"The actual container tmpfs mount at {target} could not be identified safely.")
        entry = matches[0]
        if entry.filesystem != "tmpfs":
            raise PreflightError(f"The actual container mount at {target} must be tmpfs.")
        if "rw" not in entry.options or "ro" in entry.options or "ro" in entry.super_options:
            raise PreflightError(f"The actual container tmpfs at {target} must be read-write.")
        normalized.append({"Destination": target, "Type": "tmpfs", "RW": True, "Source": "tmpfs", "Name": ""})
    return normalized


def verify_container_bindings(container_id: str, expected: dict[str, ExpectedContainerMount], docker_root: Path, *, app_container: bool) -> None:
    user, mounts, host_tmpfs = inspect_mounts(container_id)
    if app_container and user != "10001:10001":
        raise PreflightError("The application container must run as UID:GID 10001:10001.")
    verify_actual_mounts(actual_mounts_with_tmpfs(container_id, mounts, host_tmpfs, expected), expected, docker_root)


def verify_migration_command(command: object, entrypoint: object = None) -> None:
    expected = [
        "sh",
        "-c",
        "node backend/dist/infrastructure/database/migrate.js && exec node backend/dist/server.js",
    ]
    if command != expected or entrypoint is not None:
        raise PreflightError("The application command must run migrations successfully before exec-starting one server process.")


def expected_compose_mounts(
    config: dict[str, object],
    docker_root: Path,
    *,
    workspace: Path,
    tls_dir: Path,
    hermes_dir: Path,
    password_file: Path,
    managed_root: Path | None,
) -> dict[str, dict[str, ExpectedContainerMount]]:
    bindings: dict[str, dict[str, tuple[Path, bool]]] = {
        "personal-ai-app": {
            "/workspace": (workspace, True),
            "/run/tls": (tls_dir, False),
            "/run/hermes": (hermes_dir, False),
            "/run/secrets/local_user_password": (password_file, False),
        },
        "postgres": {},
    }
    if managed_root is not None:
        bindings["personal-ai-app"]["/account-workspaces"] = (managed_root, True)

    volume_keys = {
        "personal-ai-app": {"/var/lib/personal-ai/recovery": "pai_recovery"},
        "postgres": {"/var/lib/postgresql/data": "pai_pg_data"},
    }
    result: dict[str, dict[str, ExpectedContainerMount]] = {}
    for service_name in EXPECTED_SERVICES:
        mounts = compose_mounts(config, service_name, docker_root)
        allowed_targets = set(bindings[service_name]) | set(volume_keys[service_name])
        if service_name == "personal-ai-app":
            allowed_targets.add("/tmp")
        if set(mounts) != allowed_targets:
            raise PreflightError(f"Compose mounts for {service_name} do not match the approved staging layout.")

        for target, (source, read_write) in bindings[service_name].items():
            actual = mounts[target]
            if actual.kind != "bind" or actual.read_write is not read_write or actual.source != Path(os.path.realpath(source)):
                raise PreflightError(f"The resolved Compose bind at {target} does not match the preflight-verified host path and access mode.")
        for target, volume_key in volume_keys[service_name].items():
            actual = mounts[target]
            if actual.kind != "volume" or actual.volume_key != volume_key or not actual.read_write:
                raise PreflightError(f"The resolved Compose volume at {target} must use the expected writable named volume.")
        if service_name == "personal-ai-app" and (mounts["/tmp"].kind != "tmpfs" or not mounts["/tmp"].read_write):
            raise PreflightError("The application /tmp mount must remain a writable tmpfs.")
        result[service_name] = mounts
    return result


def verify_compose(project_root: Path, env_file: Path, managed: bool, tls_dir: Path, password_file: Path, hermes_dir: Path, workspace: Path, managed_root: Path | None, docker_root: Path) -> bool:
    base = compose_base(project_root, env_file, managed)
    raw_config = run_readonly([*base, "config", "--format", "json"], service_label="Compose configuration validation")
    try:
        config = json.loads(raw_config)
    except json.JSONDecodeError as error:
        raise PreflightError("Compose returned an unreadable resolved configuration.") from error
    services = config.get("services") if isinstance(config, dict) else None
    if not isinstance(services, dict):
        raise PreflightError("Compose did not return a valid service configuration.")
    if set(services) != EXPECTED_SERVICES:
        raise PreflightError("Compose must define exactly postgres and one personal-ai-app service; remove extra workers.")
    for name, service_config in services.items():
        if not isinstance(service_config, dict):
            raise PreflightError("Compose returned an invalid service definition.")
        deploy = service_config.get("deploy") or {}
        if not isinstance(deploy, dict) or deploy.get("replicas", 1) != 1:
            raise PreflightError(f"Compose service {name} must have exactly one replica.")
    verify_migration_command(services["personal-ai-app"].get("command"), services["personal-ai-app"].get("entrypoint"))

    pending = False
    expected_by_service = expected_compose_mounts(
        config,
        docker_root,
        workspace=workspace,
        tls_dir=tls_dir,
        hermes_dir=hermes_dir,
        password_file=password_file,
        managed_root=managed_root,
    )
    for service, expected in expected_by_service.items():
        ids = run_readonly([*base, "ps", "--all", "--quiet", service], service_label=f"Compose {service} container inspection").splitlines()
        if len(ids) > 1:
            raise PreflightError(f"More than one {service} container exists; keep a single deployment owner.")
        if not ids:
            pending = True
            continue
        verify_container_bindings(ids[0], expected, docker_root, app_container=service == "personal-ai-app")
    return pending


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only AWS Linux staging preflight; does not create or modify host paths.")
    parser.add_argument("--data-mount", required=True, help="Exact EBS filesystem mountpoint backed by a required UUID fstab entry")
    parser.add_argument("--ebs-volume-id", required=True, help="Expected vol-... ID from the infrastructure output DataVolumeId")
    args = parser.parse_args()
    if sys.platform != "linux":
        print("FAIL  Linux host checks require Linux; this command is not a Windows preflight.")
        return 2
    try:
        data_mount = checked_absolute_path(args.data_mount, "--data-mount")
        checked_directory(data_mount, "--data-mount")
        mountinfo = Path("/proc/self/mountinfo").read_text()
        data_entry = verify_ebs_mount(data_mount, args.ebs_volume_id, mountinfo, Path("/etc/fstab").read_text())
        mounts = parse_mountinfo(Path("/proc/self/mountinfo").read_text())
        print("PASS  data mount is the expected EBS volume on a filesystem separate from / and required by its UUID fstab entry")

        env_file = PROJECT_ROOT / ".env"
        env_stats = require_data_child(env_file, "Compose .env", data_mount, data_entry, mounts, directory=False)
        if stat.S_IMODE(env_stats.st_mode) & 0o077:
            raise PreflightError("Compose .env must be private to its owner (chmod 600); it contains deployment credentials.")
        values = read_env_file(env_file)
        get = lambda key, default=None: configured_value(key, values, default)

        workspace_value = get("WORKSPACE_HOST_ROOT")
        identity = get("WORKSPACE_IDENTITY")
        tls_value = get("TLS_CERT_DIR")
        if not workspace_value or not identity or not tls_value:
            raise PreflightError("Set WORKSPACE_HOST_ROOT, WORKSPACE_IDENTITY, and TLS_CERT_DIR in the private .env file.")
        if any(value.lower().startswith("replace-with") for value in (workspace_value, identity, tls_value)):
            raise PreflightError("Replace the sample WORKSPACE_HOST_ROOT, WORKSPACE_IDENTITY, and TLS_CERT_DIR values before staging.")
        if get("WORKSPACE_IDENTITY_FILE", "/workspace/.personal-ai-workspace-identity") != f"/workspace/{LEGACY_MARKER}":
            raise PreflightError("WORKSPACE_IDENTITY_FILE must match the Compose marker at the root of /workspace.")

        workspace = checked_absolute_path(workspace_value, "WORKSPACE_HOST_ROOT")
        workspace_stats = require_data_child(workspace, "WORKSPACE_HOST_ROOT", data_mount, data_entry, mounts, directory=True)
        ensure_app_access(workspace_stats, 0b111, "WORKSPACE_HOST_ROOT")
        read_marker(workspace, LEGACY_MARKER, identity, "Legacy workspace identity marker")

        managed_value = get("ACCOUNT_WORKSPACES_HOST_ROOT")
        managed_identity = get("ACCOUNT_WORKSPACES_IDENTITY")
        if bool(managed_value) != bool(managed_identity):
            raise PreflightError("Configure both ACCOUNT_WORKSPACES_HOST_ROOT and ACCOUNT_WORKSPACES_IDENTITY, or leave both unset.")
        managed_root = None
        if managed_value and managed_identity:
            if managed_value.lower().startswith("replace-with") or managed_identity.lower().startswith("replace-with"):
                raise PreflightError("Replace the sample managed-storage path and identity before enabling the overlay.")
            managed_root = checked_absolute_path(managed_value, "ACCOUNT_WORKSPACES_HOST_ROOT")
            managed_stats = require_data_child(managed_root, "ACCOUNT_WORKSPACES_HOST_ROOT", data_mount, data_entry, mounts, directory=True)
            ensure_app_access(managed_stats, 0b111, "ACCOUNT_WORKSPACES_HOST_ROOT")
            ensure_disjoint_roots(workspace, managed_root)
            read_marker(managed_root, MANAGED_MARKER, managed_identity, "Managed-storage identity marker")
        print("PASS  legacy and managed roots are ordinary disjoint directories on the EBS filesystem; identity markers match")

        tls_dir = resolve_compose_path(tls_value, PROJECT_ROOT, "TLS_CERT_DIR")
        tls_stats = require_data_child(tls_dir, "TLS_CERT_DIR", data_mount, data_entry, mounts, directory=True)
        ensure_app_access(tls_stats, 0b001, "TLS_CERT_DIR")
        for filename, label in (("tls.crt", "TLS certificate"), ("tls.key", "TLS private key")):
            file_stats = require_data_child(tls_dir / filename, label, data_mount, data_entry, mounts, directory=False)
            ensure_app_access(file_stats, 0b100, label)
            if filename.endswith(".key"):
                ensure_private_key_permissions(file_stats, label)

        password_value = get("LOCAL_USER_PASSWORD_FILE", "./secrets/local_user_password") or "./secrets/local_user_password"
        password_file = resolve_compose_path(password_value, PROJECT_ROOT, "LOCAL_USER_PASSWORD_FILE")
        password_stats = require_data_child(password_file, "Local login password file", data_mount, data_entry, mounts, directory=False)
        ensure_app_access(password_stats, 0b100, "Local login password file")
        if stat.S_IMODE(password_stats.st_mode) & 0o007:
            raise PreflightError("Local login password file must not be readable or writable by other host users.")

        hermes_dir = PROJECT_ROOT / "secrets" / "hermes-bridge"
        hermes_stats = require_data_child(hermes_dir, "Hermes mTLS directory", data_mount, data_entry, mounts, directory=True)
        ensure_app_access(hermes_stats, 0b001, "Hermes mTLS directory")
        for filename in ("ca.crt", "client.crt", "client.key"):
            file_stats = require_data_child(hermes_dir / filename, f"Hermes mTLS {filename}", data_mount, data_entry, mounts, directory=False)
            ensure_app_access(file_stats, 0b100, f"Hermes mTLS {filename}")
            if filename.endswith(".key"):
                ensure_private_key_permissions(file_stats, "Hermes client private key")
        print("PASS  private .env and login secret, TLS pair, and Hermes mTLS files exist on EBS; credentials were not printed and TLS/key contents were not read")
        print("PASS  workspace and bind-mounted runtime files grant UID 10001 the required mode-bit access")

        docker_root_raw = run_readonly(["docker", "info", "--format", "{{.DockerRootDir}}"], service_label="Docker data-root inspection")
        docker_root = checked_absolute_path(docker_root_raw, "Docker data root")
        docker_stats = checked_directory(docker_root, "Docker data root")
        require_data_child(docker_root, "Docker data root", data_mount, data_entry, mounts, directory=True)
        if docker_stats.st_dev != workspace_stats.st_dev:
            raise PreflightError("Docker data root and workspace must remain on the verified EBS filesystem.")
        print("PASS  Docker data root is a real directory on the EBS filesystem")

        session_secret = get("SESSION_SECRET", "") or ""
        if len(session_secret) < 32 or session_secret.lower().startswith("replace-with"):
            raise PreflightError("SESSION_SECRET must be a non-placeholder value of at least 32 characters.")
        postgres_password = get("POSTGRES_PASSWORD", "") or ""
        if not postgres_password or postgres_password.lower().startswith("replace-with"):
            raise PreflightError("POSTGRES_PASSWORD must be set to a non-placeholder value in .env.")
        nim_model = get("NIM_MODEL", "") or ""
        if not nim_model or nim_model.lower().startswith("replace-with"):
            raise PreflightError("NIM_MODEL must be set to a non-placeholder value in .env.")
        if get("APP_PROTOCOL", "https") != "https":
            raise PreflightError("AWS staging Compose must use HTTPS with the checked TLS files.")
        env_file_checked = env_file
        pending = verify_compose(PROJECT_ROOT, env_file_checked, managed_root is not None, tls_dir, password_file, hermes_dir, workspace, managed_root, docker_root)
        print("PASS  Compose validates with exactly one application service and one PostgreSQL service; no extra worker is configured")
        if pending:
            print("PENDING  No current service container exists to inspect; rerun after startup to verify actual mounts, volume paths, and UID 10001.")
        print("PENDING  UID 10001 access is checked from host mode bits; verify container access if Docker user namespaces or ACLs are enabled.")
        print("PENDING  Startup readiness, scheduler ownership, SSM access, restart persistence, and backup/restore rehearsal remain staging acceptance gates.")
        return 0
    except PreflightError as error:
        print(f"FAIL  {error}")
        return 1
    except OSError:
        print("FAIL  A Linux mount, fstab, sysfs, or host path could not be inspected safely.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
