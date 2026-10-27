import json
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from copy import deepcopy
from unittest.mock import patch

from deploy.aws.preflight import (
    PreflightError,
    app_has_access,
    checked_directory,
    compose_mounts,
    ebs_device_verified,
    ensure_private_key_permissions,
    ensure_disjoint_roots,
    expected_compose_mounts,
    parse_fstab_mounts,
    parse_mountinfo,
    read_marker,
    verify_actual_mounts,
    verify_container_bindings,
    verify_ebs_mount,
    verify_migration_command,
)


class PreflightTests(unittest.TestCase):
    def test_parse_mountinfo_decodes_mountpoint_and_device(self):
        entries = parse_mountinfo(
            "36 25 259:1 / /mnt/pai\\040data rw,relatime shared:1 - ext4 /dev/nvme1n1p1 rw"
        )

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].mount_id, "36")
        self.assertEqual(entries[0].device, "259:1")
        self.assertEqual(entries[0].target, Path("/mnt/pai data"))
        self.assertEqual(entries[0].filesystem, "ext4")
        self.assertEqual(entries[0].options, frozenset({"rw", "relatime"}))
        self.assertEqual(entries[0].super_options, frozenset({"rw"}))

    def test_parse_fstab_mount_records_required_options(self):
        entries = parse_fstab_mounts(
            "# ignored\nUUID=1234 /mnt/pai\\040data ext4 defaults,noatime 0 2\n",
            Path("/mnt/pai data"),
        )

        self.assertEqual(entries, [("UUID=1234", "ext4", {"defaults", "noatime"})])

    def test_mount_check_fails_when_data_path_is_only_a_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            mount = Path(temporary) / "data"
            mount.mkdir()

            with self.assertRaisesRegex(PreflightError, "exact, currently mounted"):
                verify_ebs_mount(mount, "vol-0123456789abcdef0", "", "")

    def test_mount_check_rejects_fstab_mount_that_can_be_skipped(self):
        with tempfile.TemporaryDirectory() as temporary:
            mount = Path(temporary) / "data"
            mount.mkdir()
            mountinfo = f"25 1 259:0 / / rw - ext4 /dev/nvme0n1p1 rw\n36 25 259:1 / {mount} rw - ext4 /dev/nvme1n1p1 rw"
            fstab = f"UUID=1234 {mount} ext4 defaults,nofail 0 2"

            with self.assertRaisesRegex(PreflightError, "required during boot"):
                verify_ebs_mount(mount, "vol-0123456789abcdef0", mountinfo, fstab)

    def test_mount_check_rejects_live_read_only_mount(self):
        with tempfile.TemporaryDirectory() as temporary:
            mount = Path(temporary) / "data"
            mount.mkdir()
            mountinfo = f"25 1 259:0 / / rw - ext4 /dev/nvme0n1p1 rw\n36 25 259:1 / {mount} ro - ext4 /dev/nvme1n1p1 ro"
            fstab = f"UUID=1234 {mount} ext4 defaults 0 2"

            with self.assertRaisesRegex(PreflightError, "must be read-write"):
                verify_ebs_mount(mount, "vol-0123456789abcdef0", mountinfo, fstab)

    def test_mount_check_requires_fstab_type_to_match_live_mount(self):
        with tempfile.TemporaryDirectory() as temporary:
            mount = Path(temporary) / "data"
            mount.mkdir()
            mountinfo = f"25 1 259:0 / / rw - ext4 /dev/nvme0n1p1 rw\n36 25 259:1 / {mount} rw - ext4 /dev/nvme1n1p1 rw"
            fstab = f"UUID=1234 {mount} xfs defaults 0 2"

            with self.assertRaisesRegex(PreflightError, "filesystem type must match"):
                verify_ebs_mount(mount, "vol-0123456789abcdef0", mountinfo, fstab)

    def test_mount_check_rejects_fstab_ro_option(self):
        with tempfile.TemporaryDirectory() as temporary:
            mount = Path(temporary) / "data"
            mount.mkdir()
            mountinfo = f"25 1 259:0 / / rw - ext4 /dev/nvme0n1p1 rw\n36 25 259:1 / {mount} rw - ext4 /dev/nvme1n1p1 rw"
            fstab = f"UUID=1234 {mount} ext4 defaults,ro 0 2"

            with self.assertRaisesRegex(PreflightError, "UUID fstab entry required"):
                verify_ebs_mount(mount, "vol-0123456789abcdef0", mountinfo, fstab)

    def test_ebs_device_requires_aws_model_and_volume_serial(self):
        with tempfile.TemporaryDirectory() as temporary:
            device = Path(temporary) / "259_1"
            metadata = device / "device"
            metadata.mkdir(parents=True)
            (metadata / "model").write_text("Amazon Elastic Block Store\n", encoding="ascii")
            (metadata / "serial").write_text("vol0123456789abcdef0\n", encoding="ascii")

            self.assertTrue(ebs_device_verified("259_1", "vol-0123456789abcdef0", Path(temporary)))
            self.assertFalse(ebs_device_verified("259_1", "vol-0123456789abcdef1", Path(temporary)))
            self.assertFalse(ebs_device_verified("259_1", "invalid", Path(temporary)))

            (metadata / "model").write_text("Amazon EC2 NVMe Instance Storage\n", encoding="ascii")
            self.assertFalse(ebs_device_verified("259_1", "vol-0123456789abcdef0", Path(temporary)))

    def test_mount_check_rejects_the_root_filesystem_device(self):
        with tempfile.TemporaryDirectory() as temporary:
            mount = Path(temporary) / "data"
            mount.mkdir()
            mountinfo = f"25 1 259:1 / / rw - ext4 /dev/nvme0n1p1 rw\n36 25 259:1 / {mount} rw - ext4 /dev/nvme0n1p1 rw"
            fstab = f"UUID=1234 {mount} ext4 defaults 0 2"

            with self.assertRaisesRegex(PreflightError, "separate block device"):
                verify_ebs_mount(mount, "vol-0123456789abcdef0", mountinfo, fstab)

    def test_mount_check_requires_a_root_mount_entry(self):
        with tempfile.TemporaryDirectory() as temporary:
            mount = Path(temporary) / "data"
            mount.mkdir()
            mountinfo = f"36 25 259:1 / {mount} rw - ext4 /dev/nvme1n1p1 rw"
            fstab = f"UUID=1234 {mount} ext4 defaults 0 2"

            with self.assertRaisesRegex(PreflightError, "root filesystem mount"):
                verify_ebs_mount(mount, "vol-0123456789abcdef0", mountinfo, fstab)

    def test_checked_directory_rejects_symlink_component(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            link = root / "linked"
            link.mkdir()
            original_lstat = Path.lstat

            def report_link(path):
                if path == link:
                    return SimpleNamespace(st_mode=stat.S_IFLNK | 0o777)
                return original_lstat(path)

            with patch.object(Path, "lstat", report_link):
                with self.assertRaisesRegex(PreflightError, "symbolic link"):
                    checked_directory(link, "workspace root")

    def test_storage_roots_must_be_separate_and_non_nested(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            legacy = root / "legacy"
            managed = root / "managed"
            legacy.mkdir()
            managed.mkdir()

            ensure_disjoint_roots(legacy, managed)
            with self.assertRaisesRegex(PreflightError, "distinct and disjoint"):
                ensure_disjoint_roots(legacy, legacy)
            with self.assertRaisesRegex(PreflightError, "distinct and disjoint"):
                ensure_disjoint_roots(legacy, legacy / "nested")

    def test_identity_marker_must_match_without_including_value_in_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".personal-ai-workspace-identity").write_text("old-identity\n", encoding="utf-8")

            with self.assertRaises(PreflightError) as caught:
                read_marker(root, ".personal-ai-workspace-identity", "expected-secret-like-label", "Legacy marker")

            self.assertNotIn("old-identity", str(caught.exception))
            self.assertNotIn("expected-secret-like-label", str(caught.exception))

    def test_identity_marker_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = root / ".personal-ai-workspace-identity"
            marker.write_text("identity\n", encoding="utf-8")
            original_lstat = Path.lstat

            def report_link(path):
                if path == marker:
                    return SimpleNamespace(st_mode=stat.S_IFLNK | 0o777)
                return original_lstat(path)

            with patch.object(Path, "lstat", report_link):
                with self.assertRaisesRegex(PreflightError, "regular file"):
                    read_marker(root, marker.name, "identity", "Legacy marker")

    def test_app_access_uses_container_uid_and_gid_mode_bits(self):
        owned_directory = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=10001, st_gid=10001)
        other_owned_directory = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0, st_gid=0)

        self.assertTrue(app_has_access(owned_directory, 0b111))
        self.assertFalse(app_has_access(other_owned_directory, 0b111))

    def test_private_key_must_not_be_group_writable(self):
        group_readable_key = SimpleNamespace(st_mode=stat.S_IFREG | 0o640, st_gid=10001)
        group_writable_key = SimpleNamespace(st_mode=stat.S_IFREG | 0o660, st_gid=10001)

        ensure_private_key_permissions(group_readable_key, "TLS private key")
        with self.assertRaisesRegex(PreflightError, "group-writable"):
            ensure_private_key_permissions(group_writable_key, "TLS private key")

    def test_private_key_rejects_broad_group_read_and_group_execute(self):
        for mode, gid in ((0o640, 100), (0o610, 10001)):
            with self.subTest(mode=mode, gid=gid), self.assertRaises(PreflightError):
                ensure_private_key_permissions(SimpleNamespace(st_mode=stat.S_IFREG | mode, st_gid=gid), "TLS private key")

    def test_migration_command_must_be_the_exact_ordered_exec_pipeline(self):
        expected = [
            "sh",
            "-c",
            "node backend/dist/infrastructure/database/migrate.js && exec node backend/dist/server.js",
        ]
        verify_migration_command(expected)
        for entrypoint in ([], "", ["sh", "-c", "node backend/dist/server.js"]):
            with self.subTest(entrypoint=entrypoint), self.assertRaises(PreflightError):
                verify_migration_command(expected, entrypoint)
        for invalid in (
            ["sh", "-c", "node backend/dist/server.js && node backend/dist/infrastructure/database/migrate.js"],
            ["sh", "-c", "node backend/dist/infrastructure/database/migrate.js || true; exec node backend/dist/server.js"],
            ["node", "backend/dist/server.js"],
        ):
            with self.subTest(command=invalid), self.assertRaisesRegex(PreflightError, "migrations successfully"):
                verify_migration_command(invalid)

    def _compose_config(self, root: Path) -> tuple[dict[str, object], dict[str, Path], Path]:
        docker_root = root / "docker"
        paths = {
            "workspace": root / "workspace",
            "tls": root / "tls",
            "hermes": root / "hermes",
            "password": root / "password",
            "managed": root / "managed",
        }
        config: dict[str, object] = {
            "services": {
                "personal-ai-app": {
                    "volumes": [
                        {"type": "bind", "source": str(paths["workspace"]), "target": "/workspace"},
                        {"type": "volume", "source": "pai_recovery", "target": "/var/lib/personal-ai/recovery"},
                        {"type": "bind", "source": str(paths["hermes"]), "target": "/run/hermes", "read_only": True},
                        {"type": "bind", "source": str(paths["tls"]), "target": "/run/tls", "read_only": True},
                    ],
                    "secrets": [{"source": "local_user_password", "target": "local_user_password"}],
                    "tmpfs": ["/tmp:size=64m,noexec,nosuid,nodev"],
                },
                "postgres": {
                    "volumes": [{"type": "volume", "source": "pai_pg_data", "target": "/var/lib/postgresql/data"}],
                },
            },
            "volumes": {
                "pai_recovery": {"name": "pai_recovery"},
                "pai_pg_data": {"name": "pai_pg_data"},
            },
            "secrets": {"local_user_password": {"file": str(paths["password"])}},
        }
        return config, paths, docker_root

    def test_compose_mounts_resolve_bind_secret_volume_and_tmpfs_contract(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, paths, docker_root = self._compose_config(root)
            app_mounts = compose_mounts(config, "personal-ai-app", docker_root)
            postgres_mounts = compose_mounts(config, "postgres", docker_root)

            self.assertEqual(set(app_mounts), {
                "/workspace", "/var/lib/personal-ai/recovery", "/run/hermes", "/run/tls",
                "/run/secrets/local_user_password", "/tmp",
            })
            self.assertEqual(app_mounts["/var/lib/personal-ai/recovery"].name, "pai_recovery")
            self.assertEqual(app_mounts["/var/lib/personal-ai/recovery"].volume_key, "pai_recovery")
            self.assertEqual(app_mounts["/run/secrets/local_user_password"].source, Path(paths["password"]))
            self.assertEqual(app_mounts["/tmp"].kind, "tmpfs")
            self.assertEqual(postgres_mounts["/var/lib/postgresql/data"].name, "pai_pg_data")

    def test_compose_layout_rejects_unapproved_socket_or_root_bind(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, paths, docker_root = self._compose_config(root)
            for target, source in (
                ("/var/run/docker.sock", str(root / "docker.sock")),
                ("/host-root", str(root.anchor)),
            ):
                with self.subTest(target=target):
                    altered = deepcopy(config)
                    altered["services"]["personal-ai-app"]["volumes"].append({
                        "type": "bind", "source": source, "target": target,
                    })
                    with self.assertRaisesRegex(PreflightError, "approved staging layout"):
                        expected_compose_mounts(
                            altered,
                            docker_root,
                            workspace=paths["workspace"],
                            tls_dir=paths["tls"],
                            hermes_dir=paths["hermes"],
                            password_file=paths["password"],
                            managed_root=None,
                        )

    def test_actual_mounts_reject_extra_mount_and_wrong_named_volume(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, paths, docker_root = self._compose_config(root)
            expected = expected_compose_mounts(
                config,
                docker_root,
                workspace=paths["workspace"],
                tls_dir=paths["tls"],
                hermes_dir=paths["hermes"],
                password_file=paths["password"],
                managed_root=None,
            )["personal-ai-app"]
            actual = [
                {
                    "Destination": target,
                    "Type": item.kind,
                    "RW": item.read_write,
                    "Source": str(item.source) if item.source is not None else "",
                    "Name": item.name or "",
                }
                for target, item in expected.items()
            ]
            verify_actual_mounts(actual, expected, docker_root)

            with_extra = actual + [{
                "Destination": "/var/run/docker.sock",
                "Type": "bind", "RW": True, "Source": "/var/run/docker.sock", "Name": "",
            }]
            with self.assertRaisesRegex(PreflightError, "exactly match"):
                verify_actual_mounts(with_extra, expected, docker_root)

            wrong_source = deepcopy(actual)
            next(item for item in wrong_source if item["Destination"] == "/run/tls")["Source"] = str(root / "wrong-tls")
            with self.assertRaisesRegex(PreflightError, "resolved Compose source"):
                verify_actual_mounts(wrong_source, expected, docker_root)

            wrong_type = deepcopy(actual)
            next(item for item in wrong_type if item["Destination"] == "/workspace")["Type"] = "volume"
            with self.assertRaisesRegex(PreflightError, "wrong type or access mode"):
                verify_actual_mounts(wrong_type, expected, docker_root)

            wrong_volume = deepcopy(actual)
            next(item for item in wrong_volume if item["Destination"] == "/var/lib/personal-ai/recovery")["Name"] = "other_recovery"
            with self.assertRaisesRegex(PreflightError, "Compose named volume"):
                verify_actual_mounts(wrong_volume, expected, docker_root)

    def test_running_container_tmpfs_is_verified_from_inspect_and_mountinfo(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, paths, docker_root = self._compose_config(root)
            config["services"]["personal-ai-app"]["volumes"].append({
                "type": "bind", "source": str(paths["managed"]), "target": "/account-workspaces",
            })
            expected = expected_compose_mounts(
                config,
                docker_root,
                workspace=paths["workspace"],
                tls_dir=paths["tls"],
                hermes_dir=paths["hermes"],
                password_file=paths["password"],
                managed_root=paths["managed"],
            )["personal-ai-app"]
            # Docker inspect .Mounts reports the five binds and recovery volume, but not HostConfig.Tmpfs.
            inspected_mounts = [
                {
                    "Destination": target,
                    "Type": item.kind,
                    "RW": item.read_write,
                    "Source": str(item.source) if item.source is not None else "",
                    "Name": item.name or "",
                }
                for target, item in expected.items()
                if item.kind != "tmpfs"
            ]
            self.assertEqual(len(inspected_mounts), 6)
            self.assertNotIn("/tmp", {item["Destination"] for item in inspected_mounts})
            live_mountinfo = (
                "201 100 0:49 / /tmp rw,nosuid,nodev,noexec,relatime "
                "- tmpfs tmpfs rw,size=65536k,nr_inodes=16384"
            )

            with patch("deploy.aws.preflight.run_readonly", side_effect=[
                json.dumps("10001:10001"),
                json.dumps(inspected_mounts),
                json.dumps({"/tmp": "size=64m,noexec,nosuid,nodev"}),
                live_mountinfo,
            ]) as query:
                verify_container_bindings("app-container", expected, docker_root, app_container=True)

            self.assertEqual(query.call_count, 4)
            self.assertEqual(
                query.call_args_list[2].args[0],
                ["docker", "inspect", "--format", "{{json .HostConfig.Tmpfs}}", "app-container"],
            )
            self.assertEqual(
                query.call_args_list[-1].args[0][:5],
                ["docker", "exec", "--user", "10001:10001", "app-container"],
            )

    def test_running_container_tmpfs_rejects_missing_wrong_read_only_and_extra_mounts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, paths, docker_root = self._compose_config(root)
            config["services"]["personal-ai-app"]["volumes"].append({
                "type": "bind", "source": str(paths["managed"]), "target": "/account-workspaces",
            })
            expected = expected_compose_mounts(
                config,
                docker_root,
                workspace=paths["workspace"],
                tls_dir=paths["tls"],
                hermes_dir=paths["hermes"],
                password_file=paths["password"],
                managed_root=paths["managed"],
            )["personal-ai-app"]
            inspected_mounts = [
                {
                    "Destination": target,
                    "Type": item.kind,
                    "RW": item.read_write,
                    "Source": str(item.source) if item.source is not None else "",
                    "Name": item.name or "",
                }
                for target, item in expected.items()
                if item.kind != "tmpfs"
            ]
            tmpfs = {"/tmp": "size=64m,noexec,nosuid,nodev"}
            read_write_mountinfo = (
                "201 100 0:49 / /tmp rw,nosuid,nodev,noexec,relatime "
                "- tmpfs tmpfs rw,size=65536k,nr_inodes=16384"
            )
            cases = (
                ("missing inspect tmpfs", {}, read_write_mountinfo, inspected_mounts, "HostConfig.Tmpfs"),
                ("missing live tmpfs", tmpfs, "", inspected_mounts, "could not be identified"),
                (
                    "wrong live filesystem",
                    tmpfs,
                    "201 100 0:49 / /tmp rw,relatime - ext4 /dev/root rw",
                    inspected_mounts,
                    "must be tmpfs",
                ),
                (
                    "read-only HostConfig tmpfs",
                    {"/tmp": "ro,size=64m,noexec,nosuid,nodev"},
                    read_write_mountinfo,
                    inspected_mounts,
                    "configured container tmpfs.*read-write",
                ),
                (
                    "read-only live tmpfs",
                    tmpfs,
                    "201 100 0:49 / /tmp ro,nosuid,nodev,noexec - tmpfs tmpfs ro,size=65536k",
                    inspected_mounts,
                    "read-write",
                ),
                (
                    "unexpected host root bind",
                    tmpfs,
                    read_write_mountinfo,
                    inspected_mounts + [{
                        "Destination": "/host-root", "Type": "bind", "RW": True,
                        "Source": "/", "Name": "",
                    }],
                    "exactly match",
                ),
                (
                    "unexpected HostConfig tmpfs",
                    {**tmpfs, "/host-root": "size=64m"},
                    read_write_mountinfo,
                    inspected_mounts,
                    "HostConfig.Tmpfs",
                ),
            )
            for label, host_tmpfs, mountinfo, actual, error in cases:
                with self.subTest(case=label):
                    response = [json.dumps("10001:10001"), json.dumps(actual), json.dumps(host_tmpfs)]
                    if set(host_tmpfs) == {"/tmp"}:
                        response.append(mountinfo)
                    with patch("deploy.aws.preflight.run_readonly", side_effect=response):
                        with self.assertRaisesRegex(PreflightError, error):
                            verify_container_bindings("app-container", expected, docker_root, app_container=True)


if __name__ == "__main__":
    unittest.main()
