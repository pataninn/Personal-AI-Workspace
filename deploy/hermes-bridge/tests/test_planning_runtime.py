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
import planning_lifecycle
import server
from common import BridgeError


TURN_ID = 'c38135b6-f877-4e9c-899a-4c0e53864854'
CAPABILITY = 'a' * 43
PROVIDER = {
    'providerProfile': 'nebius-token-factory',
    'model': 'nvidia/nemotron-3-super-120b-a12b',
    'endpoint': 'https://api.tokenfactory.nebius.com/v1',
}


class FakeThread:
    created = []

    def __init__(self, target, daemon=False):
        self.target = target
        self.daemon = daemon
        self.started = False
        self.created.append(self)

    def start(self):
        self.started = True


class FakeState:
    def __init__(self):
        self.events = []
        self.cancelled = threading.Event()
        self.home_tool_names = frozenset({'planning_fixture_read'})
        self.is_planning = True

    def push(self, event):
        self.events.append(event)


class PlanningDispatchTests(unittest.TestCase):
    def setUp(self):
        server.RUNS.clear()
        server.PLANNING_RUNS.clear()
        FakeThread.created.clear()

    def tearDown(self):
        server.RUNS.clear()
        server.PLANNING_RUNS.clear()

    def body(self, operation='planning-create', identity=TURN_ID, capability=CAPABILITY, payload=None):
        return {
            'operation': operation,
            'runId': identity,
            'capability': capability,
            'payload': payload if payload is not None else {'prompt': 'synthetic prompt', **PROVIDER},
        }

    def create(self, body=None):
        with patch.object(server, 'profile', return_value={**PROVIDER, 'providerName': 'pai-nebius-token-factory'}), \
                patch.object(server, 'assert_route'), patch.object(server.threading, 'Thread', FakeThread):
            return server.dispatch(body or self.body())

    def test_create_accepts_only_bounded_home_payload_and_registers_separate_run(self):
        self.assertEqual(self.create(), {'status': 'preparing'})
        self.assertIn(TURN_ID, server.PLANNING_RUNS)
        self.assertEqual(server.RUNS, {})
        self.assertTrue(FakeThread.created[0].started)
        self.assertEqual(FakeThread.created[0].daemon, True)

    def test_same_capability_and_payload_replay_create_without_starting_a_second_worker(self):
        self.create()
        self.assertEqual(self.create(), {'status': 'preparing'})
        self.assertEqual(len(FakeThread.created), 1)
        changed = self.body(payload={'prompt': 'different prompt', **PROVIDER})
        with self.assertRaises(BridgeError):
            self.create(changed)

    def test_cross_registry_identity_and_shared_four_run_cap_are_rejected(self):
        server.RUNS[TURN_ID] = object()
        with self.assertRaises(BridgeError):
            self.create()
        server.RUNS.clear()
        for index in range(3):
            server.RUNS['run-project-' + str(index)] = object()
        server.PLANNING_RUNS['run-home-existing'] = object()
        with self.assertRaises(BridgeError):
            self.create()

    def test_invalid_capability_prompt_shape_route_and_prompt_bound_fail_closed(self):
        with self.assertRaises(BridgeError):
            self.create(self.body(capability='short'))
        with self.assertRaises(BridgeError):
            self.create(self.body(payload={'prompt': 'x' * (planning_lifecycle.MAX_PLANNING_PROMPT + 1), **PROVIDER}))
        with self.assertRaises(BridgeError):
            self.create(self.body(payload={'prompt': 'ok', **PROVIDER, 'files': []}))
        with patch.object(server, 'profile', return_value={**PROVIDER}), \
                patch.object(server, 'assert_route', side_effect=BridgeError('route mismatch')):
            with self.assertRaises(BridgeError):
                server.dispatch(self.body())
        self.assertEqual(server.PLANNING_RUNS, {})

    def test_missing_run_polls_unknown_and_cancel_does_not_claim_confirmation(self):
        self.assertEqual(server.dispatch(self.body('planning-poll', payload={'cursor': 0}))['status'], 'unknown')
        self.assertEqual(server.dispatch(self.body('planning-cancel', payload={}) )['outcome'], 'unknown')

    def test_recovered_unknown_create_stays_unknown_instead_of_becoming_unavailable(self):
        recovered = Mock()
        recovered.capability = CAPABILITY
        recovered.payload = {}
        recovered.status = 'unknown'
        server.PLANNING_RUNS[TURN_ID] = recovered

        self.assertEqual(self.create(), {'status': 'unknown', 'code': 'PLANNING_RUNTIME_OUTCOME_UNKNOWN'})
        self.assertEqual(len(FakeThread.created), 0)

    def test_recover_runs_discovers_current_planning_sandbox_name_and_marks_it_unknown(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            name = planning_lifecycle.planning_sandbox_name(TURN_ID)
            directory = state / 'planning-runs' / name
            directory.mkdir(parents=True)
            (directory / 'ledger.json').write_text(json.dumps({
                'runId': TURN_ID,
                'capability': CAPABILITY,
                'sandboxId': 'sandbox-1',
                'sandboxName': name,
            }), encoding='utf-8')
            with patch.object(server, 'STATE', state), patch.object(planning_lifecycle, 'STATE', state):
                server.recover_runs()

            recovered = server.PLANNING_RUNS[TURN_ID]
            self.assertEqual(recovered.name, name)
            self.assertEqual(recovered.status, 'unknown')
            self.assertTrue(recovered.finished.is_set())
            self.assertEqual(server.RUNS, {})


class PlanningLifecycleTests(unittest.TestCase):
    def test_planning_sandbox_names_fit_openshell_limit_and_remain_turn_scoped(self):
        first = planning_lifecycle.planning_sandbox_name(TURN_ID)
        second = planning_lifecycle.planning_sandbox_name('b5f9b759-f2b9-4949-a98d-20697e01acb2')

        self.assertEqual(len(first), 19)
        self.assertEqual(first, planning_lifecycle.planning_sandbox_name(TURN_ID))
        self.assertNotEqual(first, second)
        self.assertRegex(first, r'^pai-h-[0-9a-f]{13}$')

    def test_recovered_run_is_unknown_and_never_resumed(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            name = planning_lifecycle.planning_sandbox_name(TURN_ID)
            directory = state / 'planning-runs' / name
            directory.mkdir(parents=True)
            (directory / 'ledger.json').write_text(json.dumps({
                'runId': TURN_ID,
                'capability': CAPABILITY,
                'sandboxId': 'sandbox-1',
                'sandboxName': name,
            }), encoding='utf-8')
            with patch.object(planning_lifecycle, 'STATE', state):
                recovered = planning_lifecycle.PlanningRun.recover(directory / 'ledger.json')
            self.assertEqual(recovered.status, 'unknown')
            self.assertEqual(recovered.poll(0)['status'], 'unknown')
            self.assertTrue(recovered.finished.is_set())

    def test_sandbox_creation_is_digest_pinned_uses_gateway_route_and_never_uploads(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            policy = Path(planning_lifecycle.__file__).resolve().parent / 'policy.json'
            policy_value = json.loads(policy.read_text(encoding='utf-8'))
            image = 'ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:' + ('b' * 64)
            route = {**PROVIDER, 'providerName': 'pai-nebius-token-factory', 'image': image,
                     'policySha256': hashlib.sha256(policy.read_bytes()).hexdigest()}
            commands = []
            rows = [[], []]

            with patch.object(planning_lifecycle, 'STATE', state):
                run = planning_lifecycle.PlanningRun(TURN_ID, CAPABILITY, {'prompt': 'test', **PROVIDER})

                def fake_cli(args, timeout=60):
                    commands.append(args)
                    if args[1] == 'create':
                        rows[1] = [{'name': run.name, 'id': 'sandbox-1', 'phase': 'ready'}]
                    if args[1] == 'ssh-config':
                        return f'Host openshell-{run.name}.default\n  ProxyCommand {planning_lifecycle.CLI}'
                    if args[1] == 'get':
                        return json.dumps({'status': 'effective', 'policy': policy_value})
                    return '{}'

                with patch.object(planning_lifecycle, 'profile', return_value=route), \
                        patch.object(planning_lifecycle, 'assert_route'), \
                        patch.object(planning_lifecycle, 'inventory', side_effect=lambda: rows[1] if rows[1] else rows[0]), \
                        patch.object(planning_lifecycle, 'run_cli', side_effect=fake_cli):
                    run._create()
                    with patch.object(planning_lifecycle.subprocess, 'run', return_value=Mock(returncode=0)) as ssh:
                        run._create_empty_workdir()
            create = next(command for command in commands if command[1] == 'create')
            self.assertIn('--no-auto-providers', create)
            self.assertIn(image, create)
            self.assertFalse(any(command[1] == 'upload' for command in commands))
            self.assertNotIn('PAI_PROJECT_ROOT', ' '.join(ssh.call_args.args[0]))
            self.assertIn(run.remote_work, ssh.call_args.args[0])

    def test_runner_command_uses_empty_home_cwd_and_never_sets_project_root(self):
        run = planning_lifecycle.PlanningRun(TURN_ID, CAPABILITY, {'prompt': 'synthetic prompt', **PROVIDER})
        captured = {}

        class FakeAcp:
            def __init__(self, command, state):
                captured['command'] = command

            def open(self, cwd):
                captured['cwd'] = cwd

            def prompt(self, prompt, timeout=900):
                captured['prompt'] = prompt
                captured['timeout'] = timeout

        with patch.object(run, '_create'), patch.object(run, '_create_empty_workdir'), \
                patch.object(planning_lifecycle, 'AcpSession', FakeAcp):
            run.work()
        self.assertEqual(run.status, 'completed')
        self.assertEqual(captured['cwd'], run.remote_work)
        self.assertEqual(captured['timeout'], planning_lifecycle.INFERENCE_TIMEOUT_SECONDS)
        self.assertNotIn('PAI_PROJECT_ROOT', ' '.join(captured['command']))
        self.assertIn('PAI_PLANNING_CWD=' + run.remote_work, captured['command'])
        self.assertIn('PAI_PLANNING_MAX_TOKENS=512', captured['command'])

    def test_runner_output_token_bound_is_passed_and_invalid_config_fails_before_sandbox_creation(self):
        captured = {}

        class FakeAcp:
            def __init__(self, command, state):
                captured['command'] = command

            def open(self, cwd):
                pass

            def prompt(self, prompt, timeout=900):
                pass

        run = planning_lifecycle.PlanningRun(TURN_ID, CAPABILITY, {'prompt': 'synthetic prompt', **PROVIDER})
        with patch.dict(os.environ, {'PAI_PLANNING_MAX_TOKENS': '64'}), \
                patch.object(run, '_create'), patch.object(run, '_create_empty_workdir'), \
                patch.object(planning_lifecycle, 'AcpSession', FakeAcp):
            run.work()
        self.assertIn('PAI_PLANNING_MAX_TOKENS=64', captured['command'])

        invalid = planning_lifecycle.PlanningRun(TURN_ID, CAPABILITY, {'prompt': 'synthetic prompt', **PROVIDER})
        with patch.dict(os.environ, {'PAI_PLANNING_MAX_TOKENS': '513'}), \
                patch.object(invalid, '_create') as create:
            invalid.work()
        create.assert_not_called()
        self.assertEqual(invalid.status, 'failed')


class PlanningRunnerPolicyTests(unittest.TestCase):
    def run_runner(self, fixture=False, project_root=False, nonempty=False, max_tokens='64'):
        runtime_root = BRIDGE_ROOT / 'runtime'
        runner = runtime_root / 'planning_acp_runner.py'
        with tempfile.TemporaryDirectory() as temporary:
            cwd = Path(temporary)
            if nonempty:
                (cwd / 'unexpected.txt').write_text('synthetic', encoding='utf-8')

            class Registry:
                def __init__(self):
                    self.registered = []
                    self.called = []
                    self.dispatch = self.base_dispatch

                def register(self, **kwargs):
                    self.registered.append(kwargs)

                def base_dispatch(self, name, args, **kwargs):
                    self.called.append(name)
                    return 'synthetic-dispatch'

            registry = Registry()

            class Agent:
                def __init__(self, *args, **kwargs):
                    self.received = kwargs

            model_tools = types.ModuleType('model_tools')
            tools = types.ModuleType('tools')
            tools.__path__ = []
            tools_registry = types.ModuleType('tools.registry')
            tools_registry.registry = registry
            run_agent = types.ModuleType('run_agent')
            run_agent.AIAgent = Agent
            home_tools = types.ModuleType('home_tools')
            home_tools.FIXTURE_NAME = 'planning_fixture_read'
            home_tools.register_synthetic_read_only_fixture = lambda target: target.register(
                name=home_tools.FIXTURE_NAME,
                toolset='home_planning',
                schema={'name': home_tools.FIXTURE_NAME, 'parameters': {'type': 'object', 'additionalProperties': False}},
                handler=lambda *_args, **_kwargs: 'synthetic-result',
                check_fn=lambda: True,
            )
            acp_adapter = types.ModuleType('acp_adapter')
            acp_adapter.__path__ = []
            permissions = types.ModuleType('acp_adapter.permissions')
            permissions.make_approval_callback = lambda *_args, **_kwargs: None
            entry = types.ModuleType('acp_adapter.entry')
            entry.main = lambda: None
            acp_adapter.permissions = permissions
            fake_modules = {
                'model_tools': model_tools,
                'tools': tools,
                'tools.registry': tools_registry,
                'run_agent': run_agent,
                'home_tools': home_tools,
                'acp_adapter': acp_adapter,
                'acp_adapter.permissions': permissions,
                'acp_adapter.entry': entry,
            }
            environment = {
                'PAI_PLANNING_CWD': str(cwd),
                'PAI_MODEL': 'synthetic-model',
                'PAI_PLANNING_MAX_TOKENS': max_tokens,
            }
            if fixture:
                environment['PAI_PLANNING_FIXTURE'] = '1'
            if project_root:
                environment['PAI_PROJECT_ROOT'] = str(cwd)
            previous_path = list(sys.path)
            previous_cwd = os.getcwd()
            with patch.dict(os.environ, environment, clear=True), patch.dict(sys.modules, fake_modules), \
                    patch.dict('os.environ', {'HERMES_ACP_SKIP_CONFIGURED_MCP': ''}):
                os.environ.pop('PAI_PROJECT_ROOT', None) if not project_root else None
                if not fixture:
                    os.environ.pop('PAI_PLANNING_FIXTURE', None)
                try:
                    runpy.run_path(str(runner))
                    agent = Agent()
                    return {
                        'agent': agent.received,
                        'registered': registry.registered,
                        'blocked_dispatch': registry.dispatch('terminal', {}),
                        'allowed_dispatch': registry.dispatch('planning_fixture_read', {}),
                        'dispatch_calls': registry.called,
                    }
                finally:
                    os.chdir(previous_cwd)
                    sys.path[:] = previous_path

    def test_runner_has_no_tools_or_project_context_by_default(self):
        result = self.run_runner()
        self.assertEqual(result['agent']['enabled_toolsets'], [])
        self.assertEqual(result['agent']['api_mode'], 'chat_completions')
        self.assertEqual(result['agent']['max_tokens'], 64)
        self.assertTrue(result['agent']['skip_context_files'])
        self.assertTrue(result['agent']['skip_memory'])
        self.assertTrue(result['agent']['skip_background_review'])
        self.assertEqual(result['agent']['fallback_model'], [])
        self.assertEqual(result['registered'], [])
        self.assertEqual(result['dispatch_calls'], [])
        self.assertIn('error', result['blocked_dispatch'])

    def test_fixture_mode_registers_only_the_synthetic_home_tool(self):
        result = self.run_runner(fixture=True)
        self.assertEqual(result['agent']['enabled_toolsets'], ['home_planning'])
        self.assertEqual([tool['name'] for tool in result['registered']], ['planning_fixture_read'])
        self.assertEqual(result['agent']['api_mode'], 'chat_completions')
        self.assertEqual(result['agent']['max_tokens'], 64)
        self.assertIn('error', result['blocked_dispatch'])
        self.assertEqual(result['allowed_dispatch'], 'synthetic-dispatch')
        self.assertEqual(result['dispatch_calls'], ['planning_fixture_read'])

    def test_runner_refuses_project_root_nonempty_cwd_and_unbounded_token_config(self):
        for kwargs in ({'project_root': True}, {'nonempty': True}, {'max_tokens': '513'}, {'max_tokens': 'invalid'}):
            with self.subTest(kwargs=kwargs), self.assertRaises(RuntimeError):
                self.run_runner(**kwargs)


class AcpHomeToolTransportTests(unittest.TestCase):
    def new_session(self):
        session = acp.AcpSession.__new__(acp.AcpSession)
        session.state = FakeState()
        session.session_id = 'session-1'
        session.home_tool_requests = {}
        session.home_tool_request_count = 0
        session.home_tool_lock = threading.Lock()
        session.send = Mock()
        return session

    def test_typed_request_and_shared_result_round_trip(self):
        session = self.new_session()
        session._home_tool_request({
            'jsonrpc': '2.0', 'id': 7, 'method': '_pai/home_tools',
            'params': {'sessionId': 'session-1', 'name': 'planning_fixture_read', 'args': {}},
        })
        self.assertEqual(session.state.events[0]['type'], 'home-tool-request')
        self.assertEqual(session.state.events[0]['id'], '7')
        session.home_tool_result('7', {'outcome': 'shared', 'data': {'fixture': 'synthetic-read-only'}})
        session.send.assert_called_once_with({
            'jsonrpc': '2.0', 'id': 7,
            'result': {'outcome': 'shared', 'data': {'fixture': 'synthetic-read-only'}},
        })

    def test_unknown_tool_duplicate_late_and_cancelled_results_are_rejected(self):
        session = self.new_session()
        session._home_tool_request({'id': 1, 'method': '_pai/home_tools', 'params': {'sessionId': 'session-1', 'name': 'terminal', 'args': {}}})
        self.assertEqual(session.state.events, [])
        self.assertEqual(session.send.call_args.args[0]['result']['error'], 'The typed Home tool request is unavailable.')
        session.send.reset_mock()
        request = {'id': 2, 'method': '_pai/home_tools', 'params': {'sessionId': 'session-1', 'name': 'planning_fixture_read', 'args': {}}}
        session._home_tool_request(request)
        session._home_tool_request(request)
        self.assertEqual(session.home_tool_request_count, 1)
        session.state.cancelled.set()
        with self.assertRaises(BridgeError):
            session.home_tool_result('2', {'outcome': 'denied', 'code': 'CONSENT_DENIED'})

    def test_denial_is_content_free_and_result_bound_is_enforced(self):
        session = self.new_session()
        session._home_tool_request({'id': 'req_1', 'method': '_pai/home_tools', 'params': {'sessionId': 'session-1', 'name': 'planning_fixture_read', 'args': {}}})
        session.home_tool_result('req_1', {'outcome': 'denied', 'code': 'CONSENT_DENIED'})
        self.assertEqual(session.send.call_args.args[0]['result'], {'outcome': 'denied', 'code': 'CONSENT_DENIED'})
        with self.assertRaises(BridgeError):
            acp.AcpSession._validate_home_tool_result({'outcome': 'shared', 'data': {'value': 'x' * (256 * 1024)}})
        with self.assertRaises(BridgeError):
            acp.AcpSession._validate_home_tool_result({'outcome': 'denied', 'code': 'CONSENT_DENIED', 'data': 'secret'})
        deeply_nested = {}
        for _ in range(34):
            deeply_nested = {'nested': deeply_nested}
        with self.assertRaises(BridgeError):
            acp.AcpSession._validate_home_tool_result({'outcome': 'shared', 'data': deeply_nested})

    def test_tool_request_event_and_request_count_are_bounded(self):
        session = self.new_session()
        session._home_tool_request({'id': 1, 'method': '_pai/home_tools', 'params': {'sessionId': 'session-1', 'name': 'planning_fixture_read', 'args': {'value': 'x' * (256 * 1024)}}})
        self.assertEqual(session.state.events, [])
        self.assertEqual(session.home_tool_request_count, 0)
        for index in range(acp.MAX_HOME_TOOL_REQUESTS):
            session._home_tool_request({'id': index + 10, 'method': '_pai/home_tools', 'params': {'sessionId': 'session-1', 'name': 'planning_fixture_read', 'args': {}}})
        session._home_tool_request({'id': 1000, 'method': '_pai/home_tools', 'params': {'sessionId': 'session-1', 'name': 'planning_fixture_read', 'args': {}}})
        self.assertEqual(session.home_tool_request_count, acp.MAX_HOME_TOOL_REQUESTS)
        self.assertEqual(len(session.state.events), acp.MAX_HOME_TOOL_REQUESTS)


class AcpProjectCompatibilityTests(unittest.TestCase):
    def test_project_task_and_assistant_update_events_keep_existing_shape(self):
        state = FakeState()
        state.is_planning = False
        session = acp.AcpSession.__new__(acp.AcpSession)
        session.state = state
        session.session_id = 'project-session'
        session.responses = {}
        session.task_requests = {}
        session.task_request_count = 0
        session.done = threading.Event()
        session.send = Mock()
        session.child = Mock(stdout=io.BytesIO(b''.join([
            json.dumps({'id': 1, 'method': '_pai/project_tasks', 'params': {'sessionId': 'project-session', 'name': 'project_tasks_list', 'args': {}}}).encode() + b'\n',
            json.dumps({'method': 'session/update', 'params': {'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'text': 'project reply'}}}}).encode() + b'\n',
            json.dumps({'method': 'session/update', 'params': {'update': {'sessionUpdate': 'agent_thought_chunk', 'content': {'text': 'private thought'}}}}).encode() + b'\n',
        ])))

        session._read()

        self.assertEqual([event['type'] for event in state.events], ['project-task-request', 'update'])
        self.assertEqual(state.events[0]['id'], '1')
        self.assertEqual(state.events[1]['update']['content']['text'], 'project reply')
        self.assertEqual(session.task_requests['1']['method'], '_pai/project_tasks')


if __name__ == '__main__':
    unittest.main()
