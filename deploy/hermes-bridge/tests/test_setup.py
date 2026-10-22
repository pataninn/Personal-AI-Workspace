import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE_ROOT))

import setup as hermes_setup


class ProviderCreditImageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.source = Path(self.temporary.name)
        runtime = self.source / 'runtime'
        runtime.mkdir()
        (runtime / 'acp_runner.py').write_text('current project runner', encoding='utf-8')
        (runtime / 'planning_acp_runner.py').write_text('current runner', encoding='utf-8')
        (runtime / 'provider_credit.py').write_text('current boundary', encoding='utf-8')

    def tearDown(self):
        self.temporary.cleanup()

    def image_output(self, runner=None, boundary=None):
        files = {
            '/opt/pai/acp_runner.py': (self.source / 'runtime' / 'acp_runner.py').read_bytes(),
            '/opt/pai/planning_acp_runner.py': runner if runner is not None else (self.source / 'runtime' / 'planning_acp_runner.py').read_bytes(),
            '/opt/pai/provider_credit.py': boundary if boundary is not None else (self.source / 'runtime' / 'provider_credit.py').read_bytes(),
        }
        return '\n'.join(
            hashlib.sha256(content).hexdigest() + '  ' + path for path, content in files.items()
        )

    def test_accepts_only_current_read_only_image_files(self):
        result = Mock(stdout=self.image_output())
        with patch.object(hermes_setup.subprocess, 'run', return_value=result) as run:
            hermes_setup.verify_provider_credit_image('sha256:' + ('a' * 64), self.source)

        args, kwargs = run.call_args
        command = args[0]
        self.assertIn('--network', command)
        self.assertIn('none', command)
        self.assertIn('--read-only', command)
        self.assertIn('--cap-drop', command)
        self.assertIn('ALL', command)
        self.assertIn('/opt/pai/planning_acp_runner.py', command)
        self.assertIn('/opt/pai/provider_credit.py', command)
        self.assertTrue(kwargs['check'])
        self.assertEqual(kwargs['stderr'], hermes_setup.subprocess.DEVNULL)

    def test_rejects_a_stale_runner_before_bridge_setup(self):
        result = Mock(stdout=self.image_output(runner=b'stale runner'))
        with patch.object(hermes_setup.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(RuntimeError, 'current Home provider receipt boundary'):
                hermes_setup.verify_provider_credit_image('sha256:' + ('a' * 64), self.source)

    def test_rejects_a_missing_provider_credit_hook(self):
        result = Mock(stdout='')
        with patch.object(hermes_setup.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(RuntimeError, 'current Home provider receipt boundary'):
                hermes_setup.verify_provider_credit_image('sha256:' + ('a' * 64), self.source)


if __name__ == '__main__':
    unittest.main()
