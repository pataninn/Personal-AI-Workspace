import os
import re
import shutil
import subprocess
import textwrap
import unittest
from pathlib import Path


INSTALLER = Path(__file__).resolve().parents[1] / "install-linux-runtime.sh"


def bash_executable():
    if os.name == "nt":
        candidates = [
            Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe",
            Path(os.environ.get("ProgramW6432", "C:/Program Files")) / "Git/bin/bash.exe",
        ]
        for candidate in candidates:
            if candidate.is_file():
                return str(candidate)
    return shutil.which("bash")


class RuntimeInstallerWhitespaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bash = bash_executable()
        if not cls.bash:
            raise unittest.SkipTest("Bash is required to exercise the installer's trim helper.")
        cls.source = INSTALLER.read_text(encoding="utf-8")
        match = re.search(r"(?ms)^trim_whitespace\(\) \{\n.*?^\}", cls.source)
        if not match:
            raise AssertionError("The installer trim helper is missing.")
        cls.trim_function = match.group(0)
        match = re.search(r"(?ms)^verify_ebs_identity\(\) \{\n.*?^\}", cls.source)
        if not match:
            raise AssertionError("The installer's EBS identity guard is missing.")
        cls.identity_function = match.group(0)

    def trim(self, value):
        result = subprocess.run(
            [self.bash, "-c", self.trim_function + '\ntrim_whitespace "$1"', "--", value],
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout

    def test_trims_sysfs_padding_without_changing_the_exact_model(self):
        padded_model = "Amazon Elastic Block Store              "
        self.assertEqual(self.trim(padded_model), "Amazon Elastic Block Store")
        self.assertIn('model=$(trim_whitespace "$(tr -d', self.source)
        self.assertIn('if [[ "$model" == "Amazon Elastic Block Store" && "$serial" == "$expected" ]]', self.source)

    def test_trims_serial_edges_and_preserves_interior_whitespace(self):
        self.assertEqual(self.trim(" \tvol0fc3269a1806be09e\r\n"), "vol0fc3269a1806be09e")
        self.assertEqual(self.trim("  Amazon  Elastic Block Store  "), "Amazon  Elastic Block Store")
        self.assertIn('serial=$(trim_whitespace "$(tr -d', self.source)

    def test_all_whitespace_trims_to_empty(self):
        self.assertEqual(self.trim(" \t\r\n"), "")

    def run_identity_guard(self, model, serial):
        program = "\n".join((
            "set -euo pipefail",
            self.trim_function,
            self.identity_function,
            "fail() { printf 'FAIL %s\\n' \"$1\" >&2; exit 1; }",
            textwrap.dedent("""\
                findmnt() {
                  local target="${@: -1}"
                  case "$target" in
                    /mnt/pai-data) printf '259:5  \\n' ;;
                    /) printf '259:0 \\t\\n' ;;
                    *) return 2 ;;
                  esac
                }
                readlink() {
                  [[ "$1" == -e && "$2" == -- ]] || return 2
                  [[ "$3" == /sys/dev/block/259:5 ]] || return 1
                  printf '%s\\n' "$TEST_DEVICE"
                }
                temporary=$(mktemp -d)
                trap 'rm -rf -- "$temporary"' EXIT
                mkdir -p "$temporary/nvme1n1/nvme1n1p1" "$temporary/nvme1n1/device"
                printf '%s\\n' "$TEST_MODEL" > "$temporary/nvme1n1/device/model"
                printf '%s\\n' "$TEST_SERIAL" > "$temporary/nvme1n1/device/serial"
                TEST_DEVICE="$temporary/nvme1n1/nvme1n1p1"
                DATA_MOUNT=/mnt/pai-data
                PAI_EBS_VOLUME_ID=vol-0fc3269a1806be09e
                verify_ebs_identity
            """),
        ))
        environment = os.environ.copy()
        environment.update({"TEST_MODEL": model, "TEST_SERIAL": serial})
        return subprocess.run(
            [self.bash, "-c", program],
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )

    def test_ebs_identity_guard_accepts_padded_findmnt_fields_and_sysfs_model(self):
        result = self.run_identity_guard(
            "Amazon Elastic Block Store              ",
            "vol0fc3269a1806be09e",
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_ebs_identity_guard_still_rejects_wrong_model_or_serial(self):
        for model, serial in (
            ("Amazon EC2 NVMe Instance Storage", "vol0fc3269a1806be09e"),
            ("Amazon Elastic Block Store              ", "vol0fc3269a1806be09f"),
        ):
            with self.subTest(model=model, serial=serial):
                result = self.run_identity_guard(model, serial)
                self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
