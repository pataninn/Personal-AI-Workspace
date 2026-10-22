"""Local control-flow proof; mocked subprocess checks are not Linux enforcement proof."""
import hashlib
import io
import json
import os
import runpy
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE_ROOT))
import acp
import lifecycle
import server
from common import BridgeError
from runtime import acp_runner as runner

RUN_ID = 'run-policy-test'
MANIFEST = 'a' * 64
REQUEST = 'b' * 32
COMMAND_ID = 'c' * 32
FILE_HASH = hashlib.sha256(b'selected').hexdigest()
FILES = [{'path': 'readme.txt', 'sha256': FILE_HASH, 'content': 'c2VsZWN0ZWQ='}]
SNAPSHOT = runner.digest([{'path': 'readme.txt', 'sha256': FILE_HASH}])


def payload():
    return {'commandProfileVersion': runner.PROFILE_VERSION, 'manifestHash': MANIFEST,
            'snapshotHash': SNAPSHOT, 'files': FILES}


def proposal(raw='cat readme.txt'):
    return {'runId': RUN_ID, 'requestId': REQUEST, 'command': raw,
            'commandHash': runner.command_hash(raw, MANIFEST), 'profileVersion': runner.PROFILE_VERSION,
            'profileHash': runner.PROFILE_HASH, 'manifestHash': MANIFEST}


def permission():
    return {k: v for k, v in {**proposal(), 'commandId': COMMAND_ID}.items() if k not in ('command', 'runId')}


def command_result():
    return {'exitCode': 0, 'stdout': 'selected', 'stderr': '', 'timedOut': False,
            'outputTruncated': False, 'durationMs': 1}


class ParserTests(unittest.TestCase):
    def test_fixed_commands_and_explicit_rg_selected_operands(self):
        for raw in ('pwd', 'ls', 'ls readme.txt', 'cat readme.txt', 'head readme.txt', 'tail readme.txt'):
            self.assertEqual(runner.parse_policy_command(raw, {'readme.txt'})[0], '/usr/bin/' + raw.split()[0])
        self.assertEqual(runner.parse_policy_command('rg selected', {'readme.txt'}),
                         ['/usr/bin/rg', '--threads', '1', '--fixed-strings', '--', 'selected', 'readme.txt'])

    def test_rejects_shell_options_protected_and_unselected_operands(self):
        for raw in ('cat', 'head', 'tail', 'rg', 'pwd readme.txt', 'cat /etc/passwd',
                    'cat ../readme.txt', 'cat ./readme.txt', 'cat missing.txt', 'ls -a',
                    'cat "readme.txt"', 'cat readme.txt;pwd', 'cat readme.txt\npwd',
                    'cat  readme.txt', ' cat readme.txt', 'rg -x readme.txt',
                    'cat config', 'cat secret.txt', 'cat .env', 'npm run build', 'wc readme.txt'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                runner.parse_policy_command(raw, {'readme.txt', 'config', 'secret.txt', '.env'})

    def test_fixed_hash_matches_independent_serialized_contract(self):
        canonical = '{"version":"bounded-read-v1","command":"hermes-terminal","args":["cat readme.txt"],"cwd":".","classification":"safe","limits":{"wallTimeMs":10000,"idleTimeMs":5000,"maxOutputBytes":32768,"maxProcesses":4,"memoryBytes":134217728,"cpuTimeMs":5000,"network":"denied"},"manifestHash":"' + MANIFEST + '"}'
        self.assertEqual(runner.command_hash('cat readme.txt', MANIFEST), hashlib.sha256(canonical.encode()).hexdigest())
        self.assertNotEqual(runner.command_hash('cat readme.txt', 'f' * 64), proposal()['commandHash'])

    def test_argument_bound(self):
        with self.assertRaises(ValueError):
            runner.parse_policy_command('cat ' + 'x' * 253, {'x' * 253})


class SnapshotTests(unittest.TestCase):
    def test_binding_digest_and_profile_cannot_be_overridden(self):
        self.assertEqual(lifecycle.validate_policy_snapshot(RUN_ID, payload())['files'], {'readme.txt': FILE_HASH})
        for changed in ({'snapshotHash': 'f' * 64}, {'commandProfileVersion': 'v2'},
                        {'limits': {}}, {'policyEnabled': True}, {'files': FILES * 2}):
            with self.subTest(changed=changed), self.assertRaises(BridgeError):
                lifecycle.validate_policy_snapshot(RUN_ID, {**payload(), **changed})

    def test_snapshot_rejects_changes_extra_files_and_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / 'readme.txt'
            target.write_bytes(b'selected')
            policy = runner.PolicyCommands(root, lifecycle.validate_policy_snapshot(RUN_ID, payload()))
            self.assertEqual(policy.verify_snapshot(), {'readme.txt': FILE_HASH})
            target.write_bytes(b'changed')
            with self.assertRaises(RuntimeError):
                policy.verify_snapshot()
            target.write_bytes(b'selected')
            (root / 'metadata').mkdir()
            with self.assertRaises(RuntimeError):
                policy.verify_snapshot()
            (root / 'metadata').rmdir()
            (root / 'unselected.txt').write_bytes(b'selected')
            with self.assertRaises(RuntimeError):
                policy.verify_snapshot()

    def test_symlink_containment(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            policy = runner.PolicyCommands(root, lifecycle.validate_policy_snapshot(RUN_ID, payload()))
            fake = Mock()
            fake.is_symlink.return_value = True
            with patch.object(Path, 'rglob', return_value=[fake]), self.assertRaises(RuntimeError):
                policy.verify_snapshot()


class AcpPolicyTests(unittest.TestCase):
    def setUp(self):
        self.session = object.__new__(acp.AcpSession)
        self.session.state = types.SimpleNamespace(is_policy=True, identity=RUN_ID,
            policy_binding=lifecycle.validate_policy_snapshot(RUN_ID, payload()),
            cancelled=threading.Event(), push=Mock())
        self.session.session_id = 'session-test'
        self.session.policy_requests = {}
        self.session.policy_lock = threading.Lock()
        self.session.send = Mock()

    def request(self, params=None, result=False):
        params = params or proposal()
        frame = {'id': 'rpc-result' if result else 'rpc-proposal',
                 'method': '_pai/policy_command_result' if result else '_pai/policy_command',
                 'params': {'sessionId': 'session-test', **params}}
        self.session._policy_command_request(frame)

    def test_proposal_precedes_one_shot_permission_and_result_ack(self):
        self.request()
        self.assertEqual(self.session.state.push.call_args.args[0]['type'], 'policy-command-proposed')
        self.session.send.assert_not_called()
        self.session.policy_permission(permission())
        self.assertEqual(self.session.send.call_args.args[0]['result'], {'accepted': True, 'commandId': COMMAND_ID})
        with self.assertRaises(BridgeError):
            self.session.policy_permission(permission())
        result_params = {k: v for k, v in {**proposal(), 'commandId': COMMAND_ID, 'result': command_result()}.items() if k != 'command'}
        self.request(result_params, result=True)
        self.assertEqual(self.session.state.push.call_args.args[0]['type'], 'policy-command-result')
        self.session.policy_permission(permission(), result=True)
        self.assertEqual(self.session.send.call_args.args[0]['result'], {'accepted': True})
        with self.assertRaises(BridgeError):
            self.session.policy_permission(permission(), result=True)

    def test_unknown_mismatch_expired_and_cancelled_permission_fail_closed(self):
        with self.assertRaises(BridgeError):
            self.session.policy_permission(permission())
        self.request()
        for field in ('requestId', 'commandHash', 'profileVersion', 'profileHash', 'manifestHash'):
            with self.subTest(field=field), self.assertRaises(BridgeError):
                self.session.policy_permission({**permission(), field: 'mismatch'})
        self.session.send.assert_not_called()
        self.session.policy_requests[REQUEST]['expires'] = 0
        with self.assertRaises(BridgeError):
            self.session.policy_permission(permission())
        self.session.policy_requests[REQUEST]['expires'] = float('inf')
        self.session.state.cancelled.set()
        with self.assertRaises(BridgeError):
            self.session.policy_permission(permission())

    def test_generic_permission_is_forbidden(self):
        with self.assertRaises(BridgeError):
            self.session.permission('legacy', True)

    def test_duplicate_malformed_and_unbound_proposals_rejected(self):
        for changed in ({'commandHash': 'f' * 64}, {'manifestHash': 'f' * 64},
                        {'profileHash': 'f' * 64}, {'runId': 'run-foreign'}, {'command': 'cat ../x'}):
            with self.subTest(changed=changed), self.assertRaises(BridgeError):
                self.request({**proposal(), **changed})
        self.request()
        with self.assertRaises(BridgeError):
            self.request()

    def test_result_bounds_checked_before_output_event(self):
        for changed in ({'stdout': 'x' * 32769}, {'stdout': '\ufffd' * 32768}, {'durationMs': 12001},
                        {'exitCode': True}, {'timedOut': 1}, {'extra': True}):
            with self.subTest(changed=changed), self.assertRaises(BridgeError):
                acp.AcpSession._validate_policy_result({**command_result(), **changed})


class RunnerPolicyTests(unittest.TestCase):
    def make_policy(self, root):
        (root / 'readme.txt').write_bytes(b'selected')
        return runner.PolicyCommands(root, lifecycle.validate_policy_snapshot(RUN_ID, payload()))

    def test_proposal_then_execution_then_result_ack_before_model_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            policy = self.make_policy(Path(tmp))
            order = []
            def request(_transport, method, params):
                order.append(method)
                return {'accepted': True, 'commandId': COMMAND_ID} if method == 'pai/policy_command' else {'accepted': True}
            def execute(*args):
                order.append('spawn')
                return command_result()
            with patch.object(runner, 'enforcement_available', return_value=True), \
                    patch.object(policy, 'request', side_effect=request), patch.object(runner, 'execute_bounded', side_effect=execute):
                self.assertEqual(json.loads(policy.dispatch({'command': 'cat readme.txt'}, None)), command_result())
            self.assertEqual(order, ['pai/policy_command', 'spawn', 'pai/policy_command_result'])

    def test_missing_permission_never_spawns_and_failed_result_ack_withholds_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            policy = self.make_policy(Path(tmp))
            with patch.object(runner, 'enforcement_available', return_value=True), \
                    patch.object(policy, 'request', return_value={}), patch.object(runner, 'execute_bounded') as execute:
                with self.assertRaises(RuntimeError):
                    policy.dispatch({'command': 'cat readme.txt'}, None)
                execute.assert_not_called()
            with patch.object(runner, 'enforcement_available', return_value=True), \
                    patch.object(policy, 'request', side_effect=[{'accepted': True, 'commandId': COMMAND_ID}, {}]), \
                    patch.object(runner, 'execute_bounded', return_value=command_result()):
                with self.assertRaises(RuntimeError):
                    policy.dispatch({'command': 'cat readme.txt'}, None)

    def test_pwd_returns_virtual_location(self):
        with tempfile.TemporaryDirectory() as tmp:
            policy = self.make_policy(Path(tmp))
            with patch.object(runner, 'enforcement_available', return_value=True), \
                    patch.object(policy, 'request', side_effect=[{'accepted': True, 'commandId': COMMAND_ID}, {'accepted': True}]), \
                    patch.object(runner, 'execute_bounded', return_value={**command_result(), 'stdout': tmp}):
                self.assertEqual(json.loads(policy.dispatch({'command': 'pwd'}, None))['stdout'], '.\n')

    def test_missing_enforcement_or_cancellation_never_spawns(self):
        with tempfile.TemporaryDirectory() as tmp:
            policy = self.make_policy(Path(tmp))
            with patch.object(runner, 'enforcement_available', return_value=False), patch.object(runner, 'execute_bounded') as execute:
                with self.assertRaises(RuntimeError):
                    policy.dispatch({'command': 'cat readme.txt'}, None)
                execute.assert_not_called()
            policy.cancelled.set()
            with patch.object(runner, 'subprocess') as subprocess_mock, self.assertRaises(RuntimeError):
                runner.execute_bounded(['/usr/bin/pwd'], policy.root, policy.cancelled)
            subprocess_mock.Popen.assert_not_called()

    def test_real_entrypoint_intercepts_terminal_before_legacy_dispatch_or_guards(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            registry = types.SimpleNamespace(dispatch=Mock())
            terminal = types.ModuleType('tools.terminal_tool')
            terminal._check_all_guards = Mock()
            terminal._get_approval_callback = Mock()
            modules = {
                'provider_credit': types.SimpleNamespace(install_httpx_boundary=Mock(), connect=Mock()),
                'agent': types.ModuleType('agent'),
                'agent.model_metadata': types.ModuleType('agent.model_metadata'),
                'agent.title_generator': types.ModuleType('agent.title_generator'),
                'model_tools': types.ModuleType('model_tools'),
                'tools': types.ModuleType('tools'), 'tools.terminal_tool': terminal,
                'tools.registry': types.SimpleNamespace(registry=registry),
                'run_agent': types.SimpleNamespace(AIAgent=type('AIAgent', (), {'__init__': lambda self: None})),
                'project_tasks': types.SimpleNamespace(connect=Mock()),
                'acp_adapter': types.ModuleType('acp_adapter'),
                'acp_adapter.events': types.SimpleNamespace(build_tool_complete=Mock(), build_tool_start=Mock()),
                'acp_adapter.permissions': types.SimpleNamespace(make_approval_callback=Mock()),
                'acp_adapter.entry': types.SimpleNamespace(main=Mock()),
            }
            import base64
            binding = lifecycle.validate_policy_snapshot(RUN_ID, payload())
            with patch.dict(sys.modules, modules), patch.dict(os.environ, {
                    'PAI_PROJECT_ROOT': str(root), 'PAI_PLANNING_MAX_TOKENS': '512', 'PAI_POLICY_BINDING': ''}), \
                    patch.object(os, 'chdir'), patch.object(runner.signal, 'signal'), patch.object(sys, 'argv', ['acp_runner.py']):
                namespace = runpy.run_path(str(BRIDGE_ROOT / 'runtime' / 'acp_runner.py'), run_name='__main__')
            # Windows checks dispatch; the actual pinned-image self-test verifies kernel enforcement.
            namespace['dispatch'].__globals__['POLICY'] = runner.PolicyCommands(root, binding)
            namespace['POLICY'] = namespace['dispatch'].__globals__['POLICY']
            with patch.object(namespace['POLICY'], 'dispatch', return_value='policy-result') as dispatch:
                self.assertEqual(registry.dispatch('terminal', {'command': 'pwd'}), 'policy-result')
                dispatch.assert_called_once()
            terminal._get_approval_callback.assert_not_called()
            with self.assertRaises(RuntimeError):
                namespace['command_guards']('pwd', 'local')

    def test_probe_never_claims_unverified_pinned_enforcement(self):
        receipt = lifecycle.policy_capability()
        self.assertFalse(receipt['supported'])
        self.assertEqual(receipt['profileHash'], runner.PROFILE_HASH)
        self.assertEqual(receipt['limits']['maxProcesses'], 4)
        self.assertTrue(receipt['unavailableReasons'])

    def test_probe_accepts_only_a_current_runner_enforcement_receipt(self):
        receipt = {'supported': True, 'profileVersion': runner.PROFILE_VERSION,
                   'profileHash': runner.PROFILE_HASH, 'limits': runner.COMMAND_LIMITS,
                   'unavailableReasons': [], 'runnerSha256': hashlib.sha256((BRIDGE_ROOT / 'runtime' / 'acp_runner.py').read_bytes()).hexdigest()}
        with patch.object(lifecycle, 'profile', return_value={'policyCommand': receipt}):
            self.assertTrue(lifecycle.policy_capability()['supported'])
        with patch.object(lifecycle, 'profile', return_value={'policyCommand': {**receipt, 'runnerSha256': 'f' * 64}}):
            self.assertFalse(lifecycle.policy_capability()['supported'])


class BoundedExecutorTests(unittest.TestCase):
    def child(self):
        child = Mock()
        child.returncode = 0
        child.poll.return_value = 0
        child.stdout.fileno.return_value = 10
        child.stderr.fileno.return_value = 11
        return child

    def test_combined_output_cap_and_sanitized_process_inheritance(self):
        child = self.child()
        selector = Mock()
        selector.get_map.return_value = {10: True}
        selector.select.return_value = [(types.SimpleNamespace(fileobj=child.stdout, data='stdout'), 1)]
        with patch.object(runner, 'enforcement_available', return_value=True), \
                patch.object(runner, 'kill_command', side_effect=lambda item: item.kill()), \
                patch.object(runner.subprocess, 'Popen', return_value=child) as spawn, \
                patch.object(runner.selectors, 'DefaultSelector', return_value=selector), \
                patch.object(runner.os, 'read', side_effect=[b'x' * 4096] * 8 + [b'y']), \
                patch.object(runner.time, 'monotonic', return_value=0):
            result = runner.execute_bounded(['/usr/bin/cat', 'readme.txt'], '.', threading.Event())
        self.assertEqual(len(result['stdout'].encode()) + len(result['stderr'].encode()), 32768)
        self.assertTrue(result['outputTruncated'])
        child.kill.assert_called_once()
        self.assertIs(spawn.call_args.kwargs['shell'], False)
        self.assertIs(spawn.call_args.kwargs['close_fds'], True)
        self.assertEqual(spawn.call_args.kwargs['env'], {'PATH': '/usr/bin', 'LC_ALL': 'C', 'HOME': '/nonexistent'})
        self.assertNotIn('preexec_fn', spawn.call_args.kwargs)

    def test_wall_and_idle_deadlines_kill_child(self):
        for elapsed in (6, 11):
            with self.subTest(elapsed=elapsed):
                child = self.child()
                selector = Mock()
                selector.get_map.return_value = {10: True}
                with patch.object(runner, 'enforcement_available', return_value=True), \
                        patch.object(runner, 'kill_command', side_effect=lambda item: item.kill()), \
                        patch.object(runner.subprocess, 'Popen', return_value=child), \
                        patch.object(runner.selectors, 'DefaultSelector', return_value=selector), \
                        patch.object(runner.time, 'monotonic', side_effect=[0, elapsed, elapsed]):
                    result = runner.execute_bounded(['/usr/bin/pwd'], '.', threading.Event())
                self.assertTrue(result['timedOut'])
                child.kill.assert_called_once()
                selector.select.assert_not_called()

    def test_cancellation_after_spawn_kills_and_suppresses_output(self):
        child = self.child()
        selector = Mock()
        selector.get_map.return_value = {10: True}
        cancelled = threading.Event()
        def spawn(*_args, **_kwargs):
            cancelled.set()
            return child
        with patch.object(runner, 'enforcement_available', return_value=True), \
                patch.object(runner, 'kill_command', side_effect=lambda item: item.kill()), \
                patch.object(runner.subprocess, 'Popen', side_effect=spawn), \
                patch.object(runner.selectors, 'DefaultSelector', return_value=selector), self.assertRaises(RuntimeError):
            runner.execute_bounded(['/usr/bin/pwd'], '.', cancelled)
        child.kill.assert_called_once()

    def test_invalid_utf8_never_expands_combined_output_after_decode(self):
        child = self.child()
        selector = Mock()
        selector.get_map.return_value = {10: True}
        selector.select.return_value = [(types.SimpleNamespace(fileobj=child.stdout, data='stdout'), 1)]
        for chunk in (b'\xff' * 4096, ('\u20ac' * 1365).encode() + b'\xff'):
            with self.subTest(chunk_prefix=chunk[:3]), \
                    patch.object(runner, 'enforcement_available', return_value=True), \
                    patch.object(runner, 'kill_command', side_effect=lambda item: item.kill()), \
                    patch.object(runner.subprocess, 'Popen', return_value=child), \
                    patch.object(runner.selectors, 'DefaultSelector', return_value=selector), \
                    patch.object(runner.os, 'read', side_effect=[chunk] * 8 + [b'x']), \
                    patch.object(runner.time, 'monotonic', return_value=0):
                result = runner.execute_bounded(['/usr/bin/cat', 'readme.txt'], '.', threading.Event())
            self.assertLessEqual(len((result['stdout'] + result['stderr']).encode()), 32768)
            self.assertTrue(result['outputTruncated'])

    def test_linux_termination_targets_the_entire_process_group(self):
        child = self.child()
        child.pid = 12345
        with patch.object(runner.os, 'killpg', create=True) as killpg, patch.object(runner.signal, 'SIGKILL', 9, create=True):
            runner.kill_command(child)
        killpg.assert_called_once_with(12345, runner.signal.SIGKILL if hasattr(runner.signal, 'SIGKILL') else 9)
        child.kill.assert_not_called()

    @unittest.skipUnless(runner.enforcement_available(), 'Actual Linux x86_64 kernel unavailable; not enforcement proof')
    def test_actual_linux_child_has_network_fork_memory_and_cpu_limits(self):
        code = '''import os, socket, resource
assert resource.getrlimit(resource.RLIMIT_CPU) == (5, 5)
assert resource.getrlimit(resource.RLIMIT_AS) == (134217728, 134217728)
for action in (lambda: socket.socket(), lambda: os.fork()):
    try: action()
    except PermissionError: pass
    else: raise AssertionError('kernel restriction missing')
try: bytearray(200 * 1024 * 1024)
except MemoryError: pass
else: raise AssertionError('memory restriction missing')
print('kernel restrictions verified')
'''
        result = runner.execute_bounded([sys.executable, '-c', code], '.', threading.Event())
        self.assertEqual(result['exitCode'], 0)
        self.assertEqual(result['stdout'], 'kernel restrictions verified\n')

    @unittest.skipUnless(runner.enforcement_available(), 'Actual Linux x86_64 kernel unavailable; not enforcement proof')
    def test_actual_linux_output_is_bounded_before_decoding(self):
        result = runner.execute_bounded([sys.executable, '-I', '-S', '-c',
            "import os; os.write(1, b'\\xff' * 100000)"], '.', threading.Event())
        self.assertTrue(result['outputTruncated'])
        self.assertLessEqual(len((result['stdout'] + result['stderr']).encode()), 32768)

    @unittest.skipUnless(runner.enforcement_available(), 'Actual Linux x86_64 kernel unavailable; not enforcement proof')
    def test_actual_linux_idle_and_wall_deadlines_reap_child(self):
        idle = runner.execute_bounded([sys.executable, '-I', '-S', '-c',
            'import time; time.sleep(20)'], '.', threading.Event())
        self.assertTrue(idle['timedOut'])
        self.assertLess(idle['exitCode'], 0)
        self.assertLess(idle['durationMs'], 10000)
        wall = runner.execute_bounded([sys.executable, '-I', '-S', '-c',
            "import time\nwhile True:\n print('.', flush=True)\n time.sleep(0.05)"], '.', threading.Event())
        self.assertTrue(wall['timedOut'])
        self.assertLess(wall['exitCode'], 0)
        self.assertGreaterEqual(wall['durationMs'], 10000)
        self.assertLess(wall['durationMs'], 12000)


if __name__ == '__main__':
    unittest.main()
