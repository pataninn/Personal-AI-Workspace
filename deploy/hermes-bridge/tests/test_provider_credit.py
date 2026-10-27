import asyncio
import json
import os
import runpy
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

BRIDGE_ROOT = __import__('pathlib').Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE_ROOT))

import acp
from runtime import home_tools as home_tool_transport
from runtime import provider_credit


RESERVATION_ID = '11111111-1111-4111-8111-111111111111'
CALL_ID = '22222222-2222-4222-8222-222222222222'
ATTEMPT_ID = '33333333-3333-4333-8333-333333333333'


class CompletedFuture:
    def __init__(self, result):
        self.value = result

    def result(self, timeout=None):
        return self.value

    def cancel(self):
        return False


class StubStream:
    def __init__(self, chunks):
        self.chunks = chunks
        self.closed = False

    def __iter__(self):
        return iter(self.chunks)

    def close(self):
        self.closed = True


class HttpxSyncByteStream:
    def __iter__(self):
        raise NotImplementedError('Subclasses must implement iteration.')

    def close(self):
        pass


class StubResponse:
    def __init__(self, body=None, stream=None):
        self.content = body or b''
        self.stream = stream or StubStream([])

    def read(self):
        return self.content


class ProviderCreditBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.allow_estimates = False
        self.response = StubResponse(body=json.dumps({
            'usage': {'prompt_tokens': 8, 'completion_tokens': 2, 'total_tokens': 10}
        }).encode())

        class Client:
            def send(_client, _request, *args, **kwargs):
                self.events.append('send')
                return self.response

        class AsyncClient:
            async def send(_client, _request, *args, **kwargs):
                self.events.append('async-send')

        fake_httpx = types.ModuleType('httpx')
        fake_httpx.Client = Client
        fake_httpx.AsyncClient = AsyncClient
        fake_httpx.SyncByteStream = HttpxSyncByteStream
        self.fake_httpx = fake_httpx
        self.httpx_modules = patch.dict(sys.modules, {'httpx': fake_httpx})
        self.httpx_modules.start()
        self.previous_installed = provider_credit.INSTALLED
        self.previous_blocked = provider_credit.BLOCKED
        provider_credit.INSTALLED = False
        provider_credit.BLOCKED = False
        provider_credit.install_httpx_boundary()

        async def ext_method(method, params):
            request = params['request']
            operation = request['operation']
            self.events.append('receipt-' + operation)
            if operation == 'reserve':
                return {'outcome': 'reserved', 'reservationId': RESERVATION_ID}
            if operation == 'settle':
                return {'outcome': 'settled', 'status': 'settled'}
            if operation == 'unknown' and self.allow_estimates:
                return {'outcome': 'settled', 'status': 'settled'}
            return {'outcome': 'unknown'}

        class ReceiptClient:
            async def ext_method(_client, method, params):
                return await ext_method(method, params)

        def submit(coroutine, _loop):
            return CompletedFuture(asyncio.run(coroutine))

        provider_credit.connect(ReceiptClient(), object(), 'session-1')
        self.submit_patch = patch.object(provider_credit.asyncio, 'run_coroutine_threadsafe', side_effect=submit)
        self.submit_patch.start()
        self.environment = patch.dict('os.environ', {
            'PAI_PROVIDER_ENDPOINT': 'https://api.tokenfactory.nebius.com/v1',
            'PAI_PROVIDER_PROFILE': 'test-profile',
            'PAI_MODEL': 'test-model',
            'PAI_PLANNING_MAX_TOKENS': '512',
        })
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.submit_patch.stop()
        provider_credit.connect(None, None, None)
        provider_credit.INSTALLED = self.previous_installed
        provider_credit.BLOCKED = self.previous_blocked
        self.httpx_modules.stop()

    @staticmethod
    def request(stream=False, max_tokens=512, output_field='max_tokens', url='https://inference.local/v1/chat/completions'):
        value = {'model': 'test-model', 'messages': [{'role': 'user', 'content': 'hello'}]}
        if output_field:
            value[output_field] = max_tokens
        if stream:
            value.update({'stream': True, 'stream_options': {'include_usage': True}})
        request = types.SimpleNamespace(
            method='POST',
            url=url,
            content=json.dumps(value).encode(),
        )
        return request

    def test_nonstream_send_is_admitted_before_egress_and_settled_before_return(self):
        client = self.fake_httpx.Client()
        response = client.send(self.request())

        self.assertIs(response, self.response)
        self.assertEqual(self.events, ['receipt-reserve', 'send', 'receipt-settle'])

    def test_public_upstream_endpoint_is_rejected_before_receipt_or_egress(self):
        client = self.fake_httpx.Client()

        with self.assertRaises(provider_credit.ProviderBoundaryError):
            client.send(self.request(url='https://api.tokenfactory.nebius.com/v1/chat/completions'))

        self.assertEqual(self.events, [])

    def test_arbitrary_host_is_rejected_before_receipt_or_egress(self):
        client = self.fake_httpx.Client()

        with self.assertRaises(provider_credit.ProviderBoundaryError):
            client.send(self.request(url='https://provider.example/v1/chat/completions'))

        self.assertEqual(self.events, [])

    def test_missing_callback_capability_denies_before_provider_egress(self):
        provider_credit.connect(None, None, None)
        client = self.fake_httpx.Client()

        with self.assertRaises(provider_credit.ProviderBoundaryError):
            client.send(self.request())

        self.assertEqual(self.events, [])

    def test_request_above_a_sub_512_admitted_output_cap_is_rejected_before_egress(self):
        client = self.fake_httpx.Client()
        with patch.dict(os.environ, {'PAI_PLANNING_MAX_TOKENS': '64'}):
            with self.assertRaises(provider_credit.ProviderBoundaryError):
                client.send(self.request(max_tokens=512))

        self.assertEqual(self.events, [])

    def test_explicit_output_cap_at_configured_bound_is_admitted(self):
        client = self.fake_httpx.Client()
        with patch.dict(os.environ, {'PAI_PLANNING_MAX_TOKENS': '64'}):
            client.send(self.request(max_tokens=64, output_field='max_completion_tokens'))

        self.assertEqual(self.events, ['receipt-reserve', 'send', 'receipt-settle'])

    def test_missing_explicit_output_cap_is_rejected_before_egress(self):
        client = self.fake_httpx.Client()
        with self.assertRaises(provider_credit.ProviderBoundaryError):
            client.send(self.request(output_field=None))

        self.assertEqual(self.events, [])

    def test_missing_usage_retains_unknown_and_never_returns_a_successful_response(self):
        self.response.content = b'{"choices":[]}'
        client = self.fake_httpx.Client()

        with self.assertRaises(provider_credit.ProviderBoundaryError):
            client.send(self.request())

        self.assertEqual(self.events, ['receipt-reserve', 'send', 'receipt-unknown'])

    def test_missing_usage_returns_response_when_app_confirms_estimated_settlement(self):
        self.allow_estimates = True
        self.response = StubResponse(body=b'{"choices":[{"message":{"content":"READY"}}]}')
        response = self.fake_httpx.Client().send(self.request())
        self.assertIs(response, self.response)
        self.assertFalse(provider_credit.BLOCKED)
        self.assertEqual(self.events, ['receipt-reserve', 'send', 'receipt-unknown'])

    def test_missing_stream_usage_can_be_estimated_without_blocking(self):
        self.allow_estimates = True
        chunks = [b'data: {"choices":[{"delta":{"content":"READY"}}]}\n\n', b'data: [DONE]\n\n']
        self.response = StubResponse(stream=StubStream(chunks))
        response = self.fake_httpx.Client().send(self.request(stream=True), stream=True)
        self.assertEqual(list(response.stream), chunks)
        self.assertFalse(provider_credit.BLOCKED)
        self.assertEqual(self.events, ['receipt-reserve', 'send', 'receipt-unknown'])

    def test_stream_usage_is_settled_only_after_the_stream_is_consumed(self):
        chunks = [
            b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
            b'data: {"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\n',
            b'data: [DONE]\n\n',
        ]
        self.response = StubResponse(stream=StubStream(chunks))
        response = self.fake_httpx.Client().send(self.request(stream=True), stream=True)

        self.assertEqual(self.events, ['receipt-reserve', 'send'])
        self.assertEqual(list(response.stream), chunks)
        self.assertEqual(self.events, ['receipt-reserve', 'send', 'receipt-settle'])

    def test_async_httpx_send_is_blocked_before_egress(self):
        client = self.fake_httpx.AsyncClient()

        with self.assertRaises(provider_credit.ProviderBoundaryError):
            asyncio.run(client.send(self.request()))

        self.assertEqual(self.events, [])

    def test_closing_an_unconsumed_stream_closes_transport_and_retains_unknown_usage(self):
        stream = StubStream([b'data: [DONE]\n\n'])
        self.response = StubResponse(stream=stream)
        response = self.fake_httpx.Client().send(self.request(stream=True), stream=True)

        response.stream.close()

        self.assertTrue(stream.closed)
        self.assertEqual(self.events, ['receipt-reserve', 'send', 'receipt-unknown'])

    def test_sdk_can_stop_at_done_without_exhausting_the_http_iterator(self):
        chunks = [b'data: {"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\n',
                  b'data: [DO', b'NE]\n\n']
        stream = StubStream(chunks)
        self.response = StubResponse(stream=stream)
        response = self.fake_httpx.Client().send(self.request(stream=True), stream=True)
        iterator = iter(response.stream)
        for chunk in chunks:
            self.assertEqual(next(iterator), chunk)
        response.stream.close()
        self.assertTrue(stream.closed)
        self.assertEqual(self.events, ['receipt-reserve', 'send', 'receipt-settle'])


class RealHttpxProviderCreditTests(unittest.TestCase):
    def test_real_httpx_stream_is_consumed_closed_and_settled_without_network(self):
        try:
            import httpx
        except ImportError:
            self.skipTest('Run in the pinned Hermes image with its installed HTTPX.')
        events = []
        chunks = b'data: {"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\ndata: [DONE]\n\n'

        def handle(request):
            events.append('send')
            return httpx.Response(200, stream=httpx.ByteStream(chunks))

        def receipt(request):
            events.append(request['operation'])
            return RESERVATION_ID if request['operation'] == 'reserve' else None

        with patch.object(httpx.Client, 'send', httpx.Client.send), \
                patch.object(httpx.AsyncClient, 'send', httpx.AsyncClient.send), \
                patch.object(provider_credit, 'INSTALLED', False), \
                patch.object(provider_credit, 'BLOCKED', False), \
                patch.object(provider_credit, '_receipt', side_effect=receipt), \
                patch.dict(os.environ, {'PAI_MODEL': 'test-model', 'PAI_PLANNING_MAX_TOKENS': '512'}):
            provider_credit.install_httpx_boundary()
            with httpx.Client(transport=httpx.MockTransport(handle)) as client:
                request = client.build_request('POST', provider_credit.MANAGED_INFERENCE_ENDPOINT, json={
                    'model': 'test-model', 'max_tokens': 512, 'messages': [],
                    'stream': True, 'stream_options': {'include_usage': True},
                })
                response = client.send(request, stream=True)
                self.assertIsInstance(response.stream, httpx.SyncByteStream)
                self.assertEqual(response.read(), chunks)
                self.assertTrue(response.is_closed)
                self.assertEqual(events, ['reserve', 'send', 'settle'])
                from openai import OpenAI
                events.clear()
                sdk = OpenAI(api_key='offline-synthetic-key', base_url='https://inference.local/v1', http_client=client, max_retries=0)
                stream = sdk.chat.completions.create(model='test-model', max_tokens=512, messages=[],
                                                     stream=True, stream_options={'include_usage': True})
                list(stream)
                stream.close()
                self.assertEqual(events, ['reserve', 'send', 'settle'])


class ProjectProviderCreditProtocolTests(unittest.TestCase):
    def test_project_create_requires_receipts_and_a_bounded_output_cap(self):
        import server
        for fields in ({}, {'requiredProviderReceiptVersion': 1, 'maxOutputTokens': 513},
                       {'requiredProviderReceiptVersion': 2, 'maxOutputTokens': 512}):
            with self.subTest(fields=fields), self.assertRaises(acp.BridgeError):
                server.dispatch({'operation': 'create', 'runId': CALL_ID, 'capability': 'a' * 43,
                                 'payload': {'prompt': 'Reply READY', 'files': [], **fields}})


class AcpProviderCreditTransportTests(unittest.TestCase):
    def test_unknown_receipt_can_confirm_an_estimated_settlement(self):
        result = {'outcome': 'settled', 'status': 'settled'}
        self.assertEqual(acp.AcpSession._validate_provider_credit_result('unknown', result), result)
        with self.assertRaises(acp.BridgeError):
            acp.AcpSession._validate_provider_credit_result('release', result)

    def setUp(self):
        class State:
            def __init__(state):
                state.events = []
                state.cancelled = __import__('threading').Event()

            def push(state, event):
                state.events.append(event)

        self.state = State()
        self.session = acp.AcpSession.__new__(acp.AcpSession)
        self.session.state = self.state
        self.session.session_id = 'session-1'
        self.session.provider_credit_requests = {}
        self.session.provider_credit_request_count = 0
        self.session.provider_credit_lock = __import__('threading').Lock()
        self.session.send = Mock()

    def test_reserve_callback_is_bounded_and_round_trips_the_typed_result(self):
        frame = {
            'jsonrpc': '2.0', 'id': 'receipt_1', 'method': '_pai/provider_credit',
            'params': {'sessionId': 'session-1', 'request': {
                'operation': 'reserve', 'callId': CALL_ID, 'attemptId': ATTEMPT_ID,
                'providerProfile': 'test-profile', 'model': 'test-model',
                'inputTokenUpperBound': 1024, 'inputBounderVersion': 'hermes-json-utf8-v1',
            }},
        }

        self.session._provider_credit_request(frame)
        self.assertEqual(self.state.events[0]['type'], 'home-provider-credit-request')
        self.assertEqual(self.state.events[0]['params']['request']['operation'], 'reserve')
        self.session.provider_credit_result('receipt_1', {'outcome': 'reserved', 'reservationId': RESERVATION_ID})
        self.session.send.assert_called_once_with({
            'jsonrpc': '2.0', 'id': 'receipt_1',
            'result': {'outcome': 'reserved', 'reservationId': RESERVATION_ID},
        })

    def test_rejected_continuation_cannot_finish_as_a_successful_reply(self):
        self.session.provider_credit_requests['denied'] = {'operation': 'reserve', 'frame': {'id': 'denied'}}
        self.session.provider_credit_result('denied', {'outcome': 'denied', 'code': 'ADMISSION_UNAVAILABLE'})
        self.assertTrue(self.session.provider_failed)
        self.session.call = Mock(return_value={'stopReason': 'end_turn'})
        with self.assertRaisesRegex(acp.BridgeError, 'provider call'):
            self.session.prompt('synthetic')

    def test_sdk_retry_error_after_rejection_is_not_forwarded_as_assistant_text(self):
        self.session.provider_failed = True
        self.session.state.is_planning = True
        self.session.responses = {}
        self.session.done = __import__('threading').Event()
        frame = {'method': 'session/update', 'params': {'update': {
            'sessionUpdate': 'agent_message_chunk', 'content': {'text': 'API call failed after 3 retries: Connection error.'}
        }}}
        self.session.child = Mock(stdout=__import__('io').BytesIO(json.dumps(frame).encode() + b'\n'))
        self.session._read()
        self.assertEqual(self.state.events, [])

    def test_confirmed_estimate_does_not_fail_a_successful_reply(self):
        self.session.provider_credit_requests['estimate'] = {'operation': 'unknown', 'frame': {'id': 'estimate'}}
        self.session.provider_credit_result('estimate', {'outcome': 'settled', 'status': 'settled'})
        self.session.call = Mock(return_value={'stopReason': 'end_turn'})
        self.session.prompt('synthetic')
        self.assertFalse(getattr(self.session, 'provider_failed', False))

    def test_missing_or_malformed_capability_callback_is_denied(self):
        malformed = {
            'jsonrpc': '2.0', 'id': 'receipt_2', 'method': '_pai/provider_credit',
            'params': {'sessionId': 'session-1', 'request': {
                'operation': 'reserve', 'callId': CALL_ID, 'attemptId': ATTEMPT_ID,
                'providerProfile': 'test-profile', 'model': 'test-model',
                'inputTokenUpperBound': True, 'inputBounderVersion': 'hermes-json-utf8-v1',
            }},
        }

        self.session._provider_credit_request(malformed)

        self.assertEqual(self.state.events, [])
        self.assertIn('error', self.session.send.call_args.args[0])
        with self.assertRaises(acp.BridgeError):
            self.session.provider_credit_result('missing', {'outcome': 'reserved', 'reservationId': RESERVATION_ID})


class PlanningRunnerProviderPathTests(unittest.TestCase):
    def test_runner_installs_the_receipt_hook_and_sync_hermes_path_uses_local_transport(self):
        events = []
        response_body = json.dumps({'usage': {
            'prompt_tokens': 8, 'completion_tokens': 2, 'total_tokens': 10
        }}).encode()

        class Request:
            method = 'POST'
            url = 'https://inference.local/v1/chat/completions'
            content = json.dumps({
                'model': 'test-model', 'messages': [{'role': 'user', 'content': 'synthetic'}], 'max_tokens': 64
            }).encode()

        response = StubResponse(body=response_body)

        class HttpxClient:
            def send(_client, _request, *args, **kwargs):
                events.append('local-provider-send')
                return response

        class HttpxAsyncClient:
            async def send(_client, _request, *args, **kwargs):
                events.append('unexpected-async-send')

        fake_httpx = types.ModuleType('httpx')
        fake_httpx.Client = HttpxClient
        fake_httpx.AsyncClient = HttpxAsyncClient
        fake_httpx.SyncByteStream = type('SyncByteStream', (), {})

        async def receipt(method, params):
            operation = params['request']['operation']
            events.append('receipt-' + operation)
            if operation == 'reserve':
                return {'outcome': 'reserved', 'reservationId': RESERVATION_ID}
            return {'outcome': 'settled', 'status': 'settled'}

        class AcpClient:
            async def ext_method(self, method, params):
                return await receipt(method, params)

        def submit(coroutine, _loop):
            return CompletedFuture(asyncio.run(coroutine))

        class Registry:
            dispatch = staticmethod(lambda *_args, **_kwargs: 'unused')

            @staticmethod
            def register(**_kwargs):
                pass

        class Agent:
            def __init__(self, *args, **kwargs):
                self.settings = kwargs

            def create_completion(self):
                return fake_httpx.Client().send(Request())

        fake_modules = {
            'httpx': fake_httpx,
            'model_tools': types.ModuleType('model_tools'),
            'provider_credit': provider_credit,
            'run_agent': types.ModuleType('run_agent'),
            'home_tools': home_tool_transport,
            'tools': types.ModuleType('tools'),
            'tools.registry': types.ModuleType('tools.registry'),
            'acp_adapter': types.ModuleType('acp_adapter'),
            'acp_adapter.permissions': types.ModuleType('acp_adapter.permissions'),
            'acp_adapter.entry': types.ModuleType('acp_adapter.entry'),
            'agent': types.ModuleType('agent'),
            'agent.model_metadata': types.ModuleType('agent.model_metadata'),
            'agent.title_generator': types.ModuleType('agent.title_generator'),
        }
        fake_modules['tools'].__path__ = []
        fake_modules['tools.registry'].registry = Registry()
        fake_modules['run_agent'].AIAgent = Agent
        fake_modules['acp_adapter'].__path__ = []
        fake_modules['agent'].__path__ = []
        fake_modules['acp_adapter.permissions'].make_approval_callback = lambda *_args, **_kwargs: 'approved'
        fake_modules['acp_adapter.entry'].main = lambda: None

        previous_installed = provider_credit.INSTALLED
        previous_blocked = provider_credit.BLOCKED
        previous_cwd = os.getcwd()
        provider_credit.INSTALLED = False
        provider_credit.BLOCKED = False
        with tempfile.TemporaryDirectory() as temporary, \
                patch.dict(sys.modules, fake_modules), \
                patch.dict(os.environ, {
                    'PAI_PLANNING_CWD': temporary,
                    'PAI_MODEL': 'test-model',
                    'PAI_PROVIDER_ENDPOINT': 'https://api.tokenfactory.nebius.com/v1',
                    'PAI_PROVIDER_PROFILE': 'test-profile',
                    'PAI_PLANNING_MAX_TOKENS': '64',
                    'HERMES_ACP_SKIP_CONFIGURED_MCP': '1',
                }, clear=False), \
                patch.object(provider_credit.asyncio, 'run_coroutine_threadsafe', side_effect=submit):
            try:
                runner = runpy.run_path(str(BRIDGE_ROOT / 'runtime' / 'planning_acp_runner.py'))
                acp_client = AcpClient()
                runner['approval'](acp_client.ext_method, object(), 'session-1')
                reply = runner['AIAgent']().create_completion()
            finally:
                os.chdir(previous_cwd)
                provider_credit.connect(None, None, None)
                provider_credit.INSTALLED = previous_installed
                provider_credit.BLOCKED = previous_blocked

        self.assertIs(reply, response)
        self.assertEqual(events, ['receipt-reserve', 'local-provider-send', 'receipt-settle'])
        self.assertFalse(fake_modules['agent.title_generator']._auto_title_enabled())
        self.assertIsNone(fake_modules['agent.model_metadata']._query_ollama_api_show('test-model', 'https://inference.local/v1'))
        self.assertIsNone(fake_modules['agent.model_metadata'].query_ollama_num_ctx('test-model', 'https://inference.local/v1'))


if __name__ == '__main__':
    unittest.main()
