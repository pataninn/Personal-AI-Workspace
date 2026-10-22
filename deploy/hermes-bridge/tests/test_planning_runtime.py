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
from runtime import home_tools as home_tool_transport
from runtime.home_tool_schemas import HOME_TOOL_DEFINITIONS, HOME_TOOL_NAMES


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
        self.home_tool_names = frozenset(HOME_TOOL_NAMES)
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
            'payload': payload if payload is not None else {
                'prompt': 'synthetic prompt', **PROVIDER, 'maxOutputTokens': 512, 'requiredProviderReceiptVersion': 1
            },
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

    def test_output_cap_is_required_at_capability_and_create_boundaries(self):
        with patch.object(server, 'profile', return_value={**PROVIDER, 'providerName': 'pai-nebius-token-factory'}):
            result = server.dispatch(self.body('planning-capabilities', payload={
                'providerProfile': PROVIDER['providerProfile'], 'model': PROVIDER['model'],
                'requiredProviderReceiptVersion': 1, 'requiredMaxOutputTokens': 64
            }))
        self.assertEqual(result['maxOutputTokens'], 512)
        with self.assertRaises(BridgeError):
            server.dispatch(self.body('planning-capabilities', payload={
                'providerProfile': PROVIDER['providerProfile'], 'model': PROVIDER['model'],
                'requiredProviderReceiptVersion': 1
            }))
        with self.assertRaises(BridgeError):
            self.create(self.body(payload={
                'prompt': 'synthetic prompt', **PROVIDER, 'requiredProviderReceiptVersion': 1
            }))

    def test_same_capability_and_payload_replay_create_without_starting_a_second_worker(self):
        self.create()
        self.assertEqual(self.create(), {'status': 'preparing'})
        self.assertEqual(len(FakeThread.created), 1)
        changed = self.body(payload={'prompt': 'different prompt', **PROVIDER, 'maxOutputTokens': 512, 'requiredProviderReceiptVersion': 1})
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
            self.create(self.body(payload={'prompt': 'x' * (planning_lifecycle.MAX_PLANNING_PROMPT + 1), **PROVIDER, 'maxOutputTokens': 512, 'requiredProviderReceiptVersion': 1}))
        with self.assertRaises(BridgeError):
            self.create(self.body(payload={'prompt': 'ok', **PROVIDER, 'maxOutputTokens': 512, 'requiredProviderReceiptVersion': 1, 'files': []}))
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
                run = planning_lifecycle.PlanningRun(TURN_ID, CAPABILITY, {'prompt': 'test', **PROVIDER, 'maxOutputTokens': 512})

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
        run = planning_lifecycle.PlanningRun(TURN_ID, CAPABILITY, {'prompt': 'synthetic prompt', **PROVIDER, 'maxOutputTokens': 512})
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

        run = planning_lifecycle.PlanningRun(TURN_ID, CAPABILITY, {'prompt': 'synthetic prompt', **PROVIDER, 'maxOutputTokens': 64})
        with patch.object(run, '_create'), patch.object(run, '_create_empty_workdir'), \
                patch.object(planning_lifecycle, 'AcpSession', FakeAcp):
            run.work()
        self.assertIn('PAI_PLANNING_MAX_TOKENS=64', captured['command'])

        invalid = planning_lifecycle.PlanningRun(TURN_ID, CAPABILITY, {'prompt': 'synthetic prompt', **PROVIDER, 'maxOutputTokens': 513})
        with patch.object(invalid, '_create') as create:
            invalid.work()
        create.assert_not_called()
        self.assertEqual(invalid.status, 'failed')


class PlanningRunnerPolicyTests(unittest.TestCase):
    def run_runner(self, project_root=False, nonempty=False, max_tokens='64'):
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
            home_tools.HOME_TOOL_NAMES = HOME_TOOL_NAMES
            home_tools.register_home_tools = home_tool_transport.register_home_tools
            provider_credit = types.ModuleType('provider_credit')
            provider_credit.install_httpx_boundary = lambda: None
            provider_credit.connect = lambda *_args, **_kwargs: None
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
                'provider_credit': provider_credit,
                'acp_adapter': acp_adapter,
                'acp_adapter.permissions': permissions,
                'acp_adapter.entry': entry,
                'agent': types.ModuleType('agent'),
                'agent.model_metadata': types.ModuleType('agent.model_metadata'),
                'agent.title_generator': types.ModuleType('agent.title_generator'),
            }
            environment = {
                'PAI_PLANNING_CWD': str(cwd),
                'PAI_MODEL': 'synthetic-model',
                'PAI_PLANNING_MAX_TOKENS': max_tokens,
            }
            if project_root:
                environment['PAI_PROJECT_ROOT'] = str(cwd)
            previous_path = list(sys.path)
            previous_cwd = os.getcwd()
            with patch.dict(os.environ, environment, clear=True), patch.dict(sys.modules, fake_modules), \
                    patch.dict('os.environ', {'HERMES_ACP_SKIP_CONFIGURED_MCP': ''}):
                os.environ.pop('PAI_PROJECT_ROOT', None) if not project_root else None
                try:
                    runpy.run_path(str(runner))
                    agent = Agent()
                    return {
                        'agent': agent.received,
                        'disable_streaming': agent._disable_streaming,
                        'registered': registry.registered,
                        'blocked_dispatch': registry.dispatch('terminal', {}),
                        'allowed_dispatch': registry.dispatch('home_list_tasks', {'limit': 10}),
                        'dispatch_calls': registry.called,
                    }
                finally:
                    os.chdir(previous_cwd)
                    sys.path[:] = previous_path

    def test_runner_registers_only_the_fixed_typed_home_tools_and_no_project_context(self):
        result = self.run_runner()
        self.assertEqual(result['agent']['enabled_toolsets'], ['home_planning'])
        self.assertEqual(result['agent']['api_mode'], 'chat_completions')
        self.assertEqual(result['agent']['max_tokens'], 64)
        self.assertTrue(result['agent']['skip_context_files'])
        self.assertTrue(result['agent']['skip_memory'])
        self.assertTrue(result['disable_streaming'])
        self.assertTrue(result['agent']['skip_background_review'])
        self.assertEqual(result['agent']['fallback_model'], [])
        self.assertEqual([tool['name'] for tool in result['registered']], list(HOME_TOOL_NAMES))
        self.assertEqual(result['dispatch_calls'], ['home_list_tasks'])
        self.assertIn('error', result['blocked_dispatch'])
        self.assertEqual(result['allowed_dispatch'], 'synthetic-dispatch')

    def test_fixed_schema_catalog_matches_lifecycle_allowlist_and_is_strict_at_every_object(self):
        self.assertEqual(tuple(tool['name'] for tool in HOME_TOOL_DEFINITIONS), HOME_TOOL_NAMES)
        self.assertEqual(planning_lifecycle.PLANNING_TOOL_NAMES, frozenset(HOME_TOOL_NAMES))

        def assert_strict(schema):
            if schema.get('type') == 'object':
                self.assertIs(schema.get('additionalProperties'), False)
                for nested in schema.get('properties', {}).values():
                    assert_strict(nested)
            for key in ('anyOf', 'oneOf', 'allOf'):
                for nested in schema.get(key, []):
                    assert_strict(nested)
            if 'items' in schema:
                assert_strict(schema['items'])

        for definition in HOME_TOOL_DEFINITIONS:
            assert_strict(definition['parameters'])
        self.assertNotIn('planning_fixture_read', HOME_TOOL_NAMES)
        direct_create = next(tool for tool in HOME_TOOL_DEFINITIONS if tool['name'] == 'home_create_task')['parameters']
        deadline = direct_create['properties']['deadline']
        self.assertEqual([branch['properties']['kind']['enum'][0] for branch in deadline['anyOf'][0]['anyOf']], ['date', 'days_from_today'])
        self.assertNotIn('workspaceRef', json.dumps(direct_create))

        bulk = next(tool for tool in HOME_TOOL_DEFINITIONS if tool['name'] == 'home_propose_bulk_changes')['parameters']
        item_schemas = bulk['properties']['items']['items']['anyOf']
        workspace_ref_actions = set()
        for schema in item_schemas:
            for branch in schema.get('anyOf', [schema]):
                action_schema = branch.get('properties', {}).get('action', {})
                action = (action_schema.get('enum') or [None])[0]
                target = branch.get('properties', {}).get('workspaceId', {})
                for target_branch in target.get('anyOf', []):
                    if 'workspaceRef' in target_branch.get('properties', {}):
                        workspace_ref_actions.add(action)
                        self.assertEqual(target_branch['properties']['workspaceRef']['maximum'], 20)
        self.assertEqual(workspace_ref_actions, {'task.create', 'task.move'})

    def test_runner_refuses_project_root_nonempty_cwd_and_unbounded_token_config(self):
        for kwargs in ({'project_root': True}, {'nonempty': True}, {'max_tokens': '513'}, {'max_tokens': 'invalid'}):
            with self.subTest(kwargs=kwargs), self.assertRaises(RuntimeError):
                self.run_runner(**kwargs)


class HomeToolRegistryTests(unittest.TestCase):
    def test_registers_exact_catalog_and_forwards_name_and_args_through_typed_acp(self):
        class Registry:
            def __init__(self):
                self.tools = []

            def register(self, **definition):
                self.tools.append(definition)

        registry = Registry()
        home_tool_transport.register_home_tools(registry)
        self.assertEqual([tool['name'] for tool in registry.tools], list(HOME_TOOL_NAMES))
        self.assertTrue(all(tool['toolset'] == 'home_planning' for tool in registry.tools))

        client = Mock()
        client.ext_method.return_value = object()
        future = Mock()
        future.result.return_value = {'outcome': 'shared', 'data': {'items': [], 'nextCursor': None}}
        with patch.object(home_tool_transport, 'CLIENT', client), \
                patch.object(home_tool_transport, 'LOOP', object()), \
                patch.object(home_tool_transport, 'SESSION', 'session-1'), \
                patch.object(home_tool_transport.asyncio, 'run_coroutine_threadsafe', return_value=future) as submit:
            result = registry.tools[0]['handler']({'limit': 10})

        self.assertEqual(json.loads(result), {'items': [], 'nextCursor': None})
        client.ext_method.assert_called_once_with('pai/home_tools', {
            'sessionId': 'session-1', 'name': 'home_list_tasks', 'args': {'limit': 10}
        })
        submit.assert_called_once()

    def test_denial_and_unavailable_transport_do_not_disclose_any_tool_result(self):
        future = Mock()
        future.result.return_value = {'outcome': 'denied', 'code': 'CONSENT_DENIED'}
        client = Mock()
        client.ext_method.return_value = object()
        with patch.object(home_tool_transport, 'CLIENT', client), \
                patch.object(home_tool_transport, 'LOOP', object()), \
                patch.object(home_tool_transport, 'SESSION', 'session-1'), \
                patch.object(home_tool_transport.asyncio, 'run_coroutine_threadsafe', return_value=future):
            self.assertEqual(
                json.loads(home_tool_transport.call_home_tool('home_get_task', {'taskId': '00000000-0000-0000-0000-000000000001'})),
                {'outcome': 'denied', 'code': 'CONSENT_DENIED'},
            )

            future.result.return_value = {'outcome': 'conflict', 'code': 'VERSION_CONFLICT'}
            self.assertEqual(
                json.loads(home_tool_transport.call_home_tool('home_update_task', {'taskId': '00000000-0000-0000-0000-000000000001', 'expectedVersion': 1, 'title': 'Updated'})),
                {'outcome': 'conflict', 'code': 'VERSION_CONFLICT'},
            )
            future.result.return_value = {'outcome': 'conflict', 'code': 'RAW_ERROR'}
            self.assertIn('error', json.loads(home_tool_transport.call_home_tool('home_update_task', {'taskId': '00000000-0000-0000-0000-000000000001', 'expectedVersion': 1, 'title': 'Updated'})))

        self.assertIn('error', json.loads(home_tool_transport.call_home_tool('terminal', {})))
        with patch.object(home_tool_transport, 'CLIENT', None):
            self.assertIn('error', json.loads(home_tool_transport.call_home_tool('home_list_tasks', {})))


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
            'params': {'sessionId': 'session-1', 'name': 'home_list_tasks', 'args': {'limit': 10}},
        })
        self.assertEqual(session.state.events[0]['type'], 'home-tool-request')
        self.assertEqual(session.state.events[0]['id'], '7')
        session.home_tool_result('7', {'outcome': 'shared', 'data': {'items': [], 'nextCursor': None}})
        session.send.assert_called_once_with({
            'jsonrpc': '2.0', 'id': 7,
            'result': {'outcome': 'shared', 'data': {'items': [], 'nextCursor': None}},
        })

    def test_unknown_tool_duplicate_late_and_cancelled_results_are_rejected(self):
        session = self.new_session()
        session._home_tool_request({'id': 1, 'method': '_pai/home_tools', 'params': {'sessionId': 'session-1', 'name': 'terminal', 'args': {}}})
        self.assertEqual(session.state.events, [])
        self.assertEqual(session.send.call_args.args[0]['result']['error'], 'The typed Home tool request is unavailable.')
        session.send.reset_mock()
        request = {'id': 2, 'method': '_pai/home_tools', 'params': {'sessionId': 'session-1', 'name': 'home_list_tasks', 'args': {'limit': 10}}}
        session._home_tool_request(request)
        session._home_tool_request(request)
        self.assertEqual(session.home_tool_request_count, 1)
        session.state.cancelled.set()
        with self.assertRaises(BridgeError):
            session.home_tool_result('2', {'outcome': 'denied', 'code': 'CONSENT_DENIED'})

    def test_denial_is_content_free_and_result_bound_is_enforced(self):
        session = self.new_session()
        session._home_tool_request({'id': 'req_1', 'method': '_pai/home_tools', 'params': {'sessionId': 'session-1', 'name': 'home_list_tasks', 'args': {'limit': 10}}})
        session.home_tool_result('req_1', {'outcome': 'denied', 'code': 'CONSENT_DENIED'})
        self.assertEqual(session.send.call_args.args[0]['result'], {'outcome': 'denied', 'code': 'CONSENT_DENIED'})
        self.assertEqual(
            acp.AcpSession._validate_home_tool_result({'outcome': 'conflict', 'code': 'VERSION_CONFLICT'}),
            {'outcome': 'conflict', 'code': 'VERSION_CONFLICT'},
        )
        with self.assertRaises(BridgeError):
            acp.AcpSession._validate_home_tool_result({'outcome': 'shared', 'data': {'value': 'x' * (256 * 1024)}})
        with self.assertRaises(BridgeError):
            acp.AcpSession._validate_home_tool_result({'outcome': 'denied', 'code': 'CONSENT_DENIED', 'data': 'secret'})
        with self.assertRaises(BridgeError):
            acp.AcpSession._validate_home_tool_result({'outcome': 'conflict', 'code': 'RAW_ERROR'})
        with self.assertRaises(BridgeError):
            acp.AcpSession._validate_home_tool_result({'outcome': 'conflict', 'code': 'VERSION_CONFLICT', 'message': 'raw exception'})
        deeply_nested = {}
        for _ in range(34):
            deeply_nested = {'nested': deeply_nested}
        with self.assertRaises(BridgeError):
            acp.AcpSession._validate_home_tool_result({'outcome': 'shared', 'data': deeply_nested})

    def test_version_conflict_result_round_trip_stays_bounded_and_code_only(self):
        session = self.new_session()
        session._home_tool_request({'id': 'req_conflict', 'method': '_pai/home_tools', 'params': {'sessionId': 'session-1', 'name': 'home_update_task', 'args': {'taskId': '00000000-0000-0000-0000-000000000001', 'expectedVersion': 1, 'title': 'Updated'}}})
        session.home_tool_result('req_conflict', {'outcome': 'conflict', 'code': 'VERSION_CONFLICT'})
        self.assertEqual(session.send.call_args.args[0]['result'], {'outcome': 'conflict', 'code': 'VERSION_CONFLICT'})

    def test_tool_request_event_and_request_count_are_bounded(self):
        session = self.new_session()
        session._home_tool_request({'id': 1, 'method': '_pai/home_tools', 'params': {'sessionId': 'session-1', 'name': 'home_list_tasks', 'args': {'q': 'x' * (256 * 1024)}}})
        self.assertEqual(session.state.events, [])
        self.assertEqual(session.home_tool_request_count, 0)
        for index in range(acp.MAX_HOME_TOOL_REQUESTS):
            session._home_tool_request({'id': index + 10, 'method': '_pai/home_tools', 'params': {'sessionId': 'session-1', 'name': 'home_list_tasks', 'args': {'limit': 10}}})
        session._home_tool_request({'id': 1000, 'method': '_pai/home_tools', 'params': {'sessionId': 'session-1', 'name': 'home_list_tasks', 'args': {'limit': 10}}})
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
