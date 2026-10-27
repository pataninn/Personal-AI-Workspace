"""Per-HTTP-attempt Credits receipts for the pinned Home Hermes runner."""
import asyncio
import json
import os
import threading
import uuid

CLIENT = None
LOOP = None
SESSION = None
BLOCKED = False
INSTALLED = False
LOCK = threading.Lock()
MAX_REQUEST_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
BOUND_OVERHEAD_TOKENS = 512
MAX_PLANNING_OUTPUT_TOKENS = 512
# OpenShell rewrites the configured public provider URL to its managed sandbox endpoint.
MANAGED_INFERENCE_ENDPOINT = 'https://inference.local/v1/chat/completions'


class ProviderBoundaryError(RuntimeError):
    """The Home provider call could not be admitted or its usage is uncertain."""


def _configured_output_tokens():
    try:
        value = int(os.environ.get('PAI_PLANNING_MAX_TOKENS', ''))
    except ValueError:
        return None
    return value if 1 <= value <= MAX_PLANNING_OUTPUT_TOKENS else None


def _request_output_tokens_within(value, maximum):
    keys = [key for key in ('max_tokens', 'max_completion_tokens') if key in value]
    return bool(keys) and all(
        type(value[key]) is int and 1 <= value[key] <= maximum
        for key in keys
    )


def connect(client, loop, session):
    global CLIENT, LOOP, SESSION
    CLIENT, LOOP, SESSION = client, loop, session


def _receipt(request):
    global BLOCKED
    with LOCK:
        if BLOCKED:
            raise ProviderBoundaryError('A prior Home provider receipt is unresolved.')
    if CLIENT is None or LOOP is None or SESSION is None:
        with LOCK:
            BLOCKED = True
        raise ProviderBoundaryError('The Home provider receipt transport is unavailable.')
    future = asyncio.run_coroutine_threadsafe(
        CLIENT.ext_method('pai/provider_credit', {'sessionId': SESSION, 'request': request}),
        LOOP,
    )
    try:
        result = future.result(timeout=900)
    except Exception:
        future.cancel()
        with LOCK:
            BLOCKED = True
        raise ProviderBoundaryError('The Home provider receipt could not be confirmed.') from None
    if not isinstance(result, dict):
        with LOCK:
            BLOCKED = True
        raise ProviderBoundaryError('The Home provider receipt could not be validated.')
    operation = request.get('operation')
    if operation == 'reserve':
        if result.get('outcome') == 'reserved' and isinstance(result.get('reservationId'), str):
            return result['reservationId']
        with LOCK:
            BLOCKED = True
        if result == {'outcome': 'denied', 'code': 'BUDGET_EXHAUSTED'}:
            raise ProviderBoundaryError('The Home provider budget is exhausted.')
        raise ProviderBoundaryError('The Home provider call was not admitted.')
    if operation in ('settle', 'unknown') and result.get('outcome') == 'settled' and result.get('status') in ('settled', 'over_bound'):
        if result['status'] == 'over_bound':
            with LOCK:
                BLOCKED = True
            raise ProviderBoundaryError('The Home provider usage exceeded its admitted bound.')
        return None
    if operation == 'release' and result == {'outcome': 'released'}:
        return None
    with LOCK:
        BLOCKED = True
    raise ProviderBoundaryError('The Home provider usage remains unknown.')


def _usage_from_payload(value):
    if not isinstance(value, dict) or not isinstance(value.get('usage'), dict):
        return None
    usage = value['usage']
    prompt = usage.get('prompt_tokens')
    completion = usage.get('completion_tokens')
    total = usage.get('total_tokens')
    if (type(prompt) is not int or prompt < 0 or type(completion) is not int or completion < 0
            or type(total) is not int or total != prompt + completion):
        return None
    return {'promptTokens': prompt, 'completionTokens': completion, 'totalTokens': total}


def _usage_from_stream(body):
    usage = None
    try:
        text = body.decode('utf-8', errors='strict')
        for line in text.splitlines():
            if not line.startswith('data:'):
                continue
            data = line[5:].strip()
            if data == '[DONE]' or not data:
                continue
            value = json.loads(data)
            candidate = _usage_from_payload(value)
            if candidate is not None:
                usage = candidate
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return usage


class _ReceiptStream:
    def __init__(self, stream, reservation_id, call_id, attempt_id):
        self.stream = stream
        self.reservation_id = reservation_id
        self.call_id = call_id
        self.attempt_id = attempt_id
        self.completed = False
        self.bytes = bytearray()
        self.overflow = False

    def __iter__(self):
        try:
            for chunk in self.stream:
                if not self.overflow:
                    if len(self.bytes) + len(chunk) > MAX_RESPONSE_BYTES:
                        self.overflow = True
                        self.bytes.clear()
                    else:
                        self.bytes.extend(chunk)
                # OpenAI stops at [DONE] and closes without exhausting the HTTP iterator.
                if not self.completed and any(line.strip() == b'data: [DONE]' for line in self.bytes.splitlines()):
                    self._settle()
                yield chunk
            if not self.completed:
                self._settle()
        except Exception:
            if not self.completed:
                try:
                    _receipt({'operation': 'unknown', 'callId': self.call_id, 'attemptId': self.attempt_id,
                              'reservationId': self.reservation_id, 'reason': 'provider_stream_incomplete'})
                except Exception:
                    pass
            raise

    def _settle(self):
        self.completed = True
        usage = None if self.overflow else _usage_from_stream(self.bytes)
        if usage is None:
            _receipt({'operation': 'unknown', 'callId': self.call_id, 'attemptId': self.attempt_id,
                      'reservationId': self.reservation_id, 'reason': 'provider_usage_missing'})
            return
        _receipt({'operation': 'settle', 'callId': self.call_id, 'attemptId': self.attempt_id,
                  'reservationId': self.reservation_id, 'usage': usage})

    def close(self):
        try:
            self.stream.close()
        finally:
            if not self.completed:
                try:
                    _receipt({'operation': 'unknown', 'callId': self.call_id, 'attemptId': self.attempt_id,
                              'reservationId': self.reservation_id, 'reason': 'provider_stream_incomplete'})
                except Exception:
                    pass


def _response_usage(response, call_id, attempt_id, reservation_id):
    try:
        response.read()
        value = json.loads(response.content.decode('utf-8', errors='strict'))
        usage = _usage_from_payload(value)
    except Exception:
        usage = None
    if usage is None:
        _receipt({'operation': 'unknown', 'callId': call_id, 'attemptId': attempt_id,
                  'reservationId': reservation_id, 'reason': 'provider_usage_missing'})
        return
    _receipt({'operation': 'settle', 'callId': call_id, 'attemptId': attempt_id,
              'reservationId': reservation_id, 'usage': usage})


def install_httpx_boundary():
    """Wrap every sync HTTP request in Hermes; async HTTP is blocked before egress."""
    global INSTALLED
    if INSTALLED:
        return
    import httpx

    original_send = httpx.Client.send

    def guarded_send(client, request, *args, **kwargs):
        url = str(request.url).split('?', 1)[0]
        try:
            body = request.content
            value = json.loads(body.decode('utf-8', errors='strict'))
        except Exception:
            with LOCK:
                global BLOCKED
                BLOCKED = True
            raise ProviderBoundaryError('The Home provider request could not be bounded.') from None
        if (request.method != 'POST' or url != MANAGED_INFERENCE_ENDPOINT or len(body) > MAX_REQUEST_BYTES
                or not isinstance(value, dict) or value.get('model') != os.environ.get('PAI_MODEL')):
            with LOCK:
                BLOCKED = True
            raise ProviderBoundaryError('The Home provider route or request shape is unavailable.')
        max_output_tokens = _configured_output_tokens()
        if max_output_tokens is None or not _request_output_tokens_within(value, max_output_tokens):
            with LOCK:
                BLOCKED = True
            raise ProviderBoundaryError('The Home provider output limit exceeds its admitted bound.')
        streaming = kwargs.get('stream', False) is True or value.get('stream') is True
        if streaming and not (isinstance(value.get('stream_options'), dict) and value['stream_options'].get('include_usage') is True):
            with LOCK:
                BLOCKED = True
            raise ProviderBoundaryError('Streaming provider usage is not enabled.')
        call_id = str(uuid.uuid4())
        attempt_id = str(uuid.uuid4())
        input_bound = len(body) + BOUND_OVERHEAD_TOKENS
        reservation_id = _receipt({
            'operation': 'reserve', 'callId': call_id, 'attemptId': attempt_id,
            'providerProfile': os.environ.get('PAI_PROVIDER_PROFILE', ''),
            'model': os.environ.get('PAI_MODEL', ''),
            'inputTokenUpperBound': input_bound,
            'inputBounderVersion': 'hermes-json-utf8-v1'
        })
        try:
            response = original_send(client, request, *args, **kwargs)
        except Exception:
            try:
                _receipt({'operation': 'unknown', 'callId': call_id, 'attemptId': attempt_id,
                          'reservationId': reservation_id, 'reason': 'provider_transport_unknown'})
            except Exception:
                pass
            raise ProviderBoundaryError('The Home provider send outcome is unknown.') from None
        if streaming:
            response.stream = HttpxReceiptStream(response.stream, reservation_id, call_id, attempt_id)
        else:
            _response_usage(response, call_id, attempt_id, reservation_id)
        return response

    httpx.Client.send = guarded_send
    original_async_send = httpx.AsyncClient.send

    async def reject_async_send(client, request, *args, **kwargs):
        with LOCK:
            global BLOCKED
            BLOCKED = True
        raise ProviderBoundaryError('The Home runtime does not admit asynchronous provider sends.')

    httpx.AsyncClient.send = reject_async_send
    class HttpxReceiptStream(_ReceiptStream, httpx.SyncByteStream):
        def __init__(self, stream, reservation_id, call_id, attempt_id):
            _ReceiptStream.__init__(self, stream, reservation_id, call_id, attempt_id)

    INSTALLED = True
