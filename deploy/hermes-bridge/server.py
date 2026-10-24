"""Private mTLS bridge. This API is application-owned, not a vendor gateway API."""
import hashlib
import hmac
import json
import re
import secrets
import uuid
import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from common import BridgeError, CLI, MAX_BODY, STATE, active_gateway_profile, profile, run_cli, run_id, sandbox_name
from lifecycle import Run, policy_capability
from planning_lifecycle import MAX_PLANNING_PROMPT, PlanningRun
from provider import assert_route

RUNS = {}
PLANNING_RUNS = {}
PLANNING_ALIASES = {}
WARM_PLANNING_ID = None
LOCK = threading.Lock()


def recover_runs():
    for ledger in (STATE / 'runs').glob('pai-*/ledger.json'):
        value = json.loads(ledger.read_text())
        identity = run_id(value['runId'])
        if ledger.parent.name != sandbox_name(identity) or value['sandboxName'] != ledger.parent.name:
            raise BridgeError('Persisted sandbox ownership needs manual review')
        run = Run(identity, value['capability'], {})
        run.sandbox_id = value['sandboxId']
        run.status = 'failed'
        run.error = 'The bridge restarted. This run was interrupted; no changes can be exported.'
        run.finished.set()
        RUNS[identity] = run
    for ledger in (STATE / 'planning-runs').glob('pai-h-*/ledger.json'):
        run = PlanningRun.recover(ledger)
        if run.awaiting_prompt:
            run.delete()
            continue
        PLANNING_RUNS[run.identity] = run
        if run.assigned_identity:
            if run.assigned_identity in PLANNING_ALIASES or run.assigned_identity in PLANNING_RUNS or run.assigned_identity in RUNS:
                raise BridgeError('Persisted planning assignment needs manual review')
            PLANNING_ALIASES[run.assigned_identity] = run.identity


def home_warm_ready():
    with LOCK:
        run = PLANNING_RUNS.get(WARM_PLANNING_ID)
        return bool(run and run.awaiting_prompt and run.prepared.is_set() and not run.finished.is_set())


def prepare_home_runtime():
    """Keep one context-free runtime ready; a claimed runtime is never pooled again."""
    global WARM_PLANNING_ID
    try:
        route = profile()
        with LOCK:
            if WARM_PLANNING_ID in PLANNING_RUNS or len(RUNS) + len(PLANNING_RUNS) >= 4:
                return
            identity = str(uuid.uuid4())
            payload = {key: route[key] for key in ('providerProfile', 'model', 'endpoint')}
            payload.update({'maxOutputTokens': 512, 'requiredProviderReceiptVersion': 1})
            run = PlanningRun(identity, secrets.token_urlsafe(32), payload, prepare_only=True)
            PLANNING_RUNS[identity] = run
            WARM_PLANNING_ID = identity
        threading.Thread(target=run.work, daemon=True).start()
    except Exception:
        # Warming is optional; a normal fresh run remains available.
        return


def dispatch(body):
    operation = body.get('operation')
    if operation == 'probe':
        p = profile()
        if hashlib.sha256(Path(CLI).read_bytes()).hexdigest() != p['openshellSha256']:
            raise BridgeError('The OpenShell binary changed')
        run_cli(['whoami', '--output', 'json'])
        assert_route(p, body.get('payload', {}))
        return {'ready': True, 'homeWarmReady': home_warm_ready(), 'profile': p, 'policyCommand': policy_capability(), 'providerReceiptVersion': 1, 'maxOutputTokens': 512}
    if isinstance(operation, str) and operation.startswith('planning-'):
        return dispatch_planning(operation, body)
    identity = run_id(body.get('runId'))
    capability = body.get('capability', '')
    if not isinstance(capability, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', capability):
        raise BridgeError('Invalid run capability')
    payload = body.get('payload', {})
    with LOCK:
        run = RUNS.get(identity)
        if operation == 'create':
            if (not isinstance(payload, dict) or set(payload) - {
                    'prompt', 'model', 'providerProfile', 'endpoint', 'files',
                    'commandProfileVersion', 'manifestHash', 'snapshotHash', 'requiredProviderReceiptVersion', 'maxOutputTokens'}
                    or (('manifestHash' in payload or 'snapshotHash' in payload) and 'commandProfileVersion' not in payload)):
                raise BridgeError('Invalid run create payload')
            if payload.get('requiredProviderReceiptVersion') != 1 or type(payload.get('maxOutputTokens')) is not int or not 1 <= payload['maxOutputTokens'] <= 512:
                raise BridgeError('The bounded provider receipt protocol is required')
            if run or identity in PLANNING_RUNS:
                raise BridgeError('This run was already created')
            if len(RUNS) + len(PLANNING_RUNS) >= 4:
                raise BridgeError('The local Hermes concurrency limit was reached')
            assert_route(profile(), payload)
            if not isinstance(payload.get('prompt'), str) or len(payload['prompt'].encode()) > 256 * 1024:
                raise BridgeError('Invalid run prompt')
            if not re.fullmatch(r'[a-zA-Z0-9_./:-]{1,200}', payload.get('model', 'nvidia/nemotron-3-super-120b-a12b')):
                raise BridgeError('Invalid model identifier')
            run = Run(identity, capability, payload)
            RUNS[identity] = run
            threading.Thread(target=run.work, daemon=True).start()
            return {'status': 'preparing'}
    if not run or not hmac.compare_digest(run.capability, capability):
        raise BridgeError('The run capability does not match')
    if operation == 'poll':
        return run.poll(int(payload.get('cursor', 0)))
    if operation == 'provider-credit-result':
        if not isinstance(payload, dict) or set(payload) != {'requestId', 'result'} or not run.acp or run.cancelled.is_set():
            raise BridgeError('The run cannot accept this provider receipt')
        run.acp.provider_credit_result(payload['requestId'], payload['result'])
        return {'accepted': True}
    if operation == 'files':
        if run.status != 'completed' or run.cancelled.is_set():
            raise BridgeError('Only completed runs can export changes')
        return {'files': run.files()}
    if operation == 'permission':
        if not isinstance(payload.get('approved'), bool):
            raise BridgeError('Invalid command decision')
        run.permission(payload['permissionId'], payload['approved'])
        return {'accepted': True}
    if operation in ('policy-command-permission', 'policy-command-result-permission'):
        run.policy_permission(payload, result=operation == 'policy-command-result-permission')
        return {'accepted': True}
    if operation == 'project-task-result':
        if run.status != 'running' or not run.acp or run.cancelled.is_set():
            raise BridgeError('The run cannot accept a project task result')
        run.acp.task_result(payload.get('requestId'), payload.get('result'))
        return {'accepted': True}
    if operation in ('cancel', 'delete'):
        run.close()
        with LOCK:
            RUNS.pop(identity, None)
        return {'deleted': True}
    raise BridgeError('Unsupported bridge operation')


def dispatch_planning(operation, body):
    identity = run_id(body.get('runId'))
    capability = body.get('capability', '')
    if not isinstance(capability, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', capability):
        raise BridgeError('Invalid planning run capability')
    payload = body.get('payload', {})
    if not isinstance(payload, dict):
        raise BridgeError('Invalid planning operation payload')
    if operation == 'planning-capabilities':
        required_output = payload.get('requiredMaxOutputTokens')
        if (set(payload) != {'providerProfile', 'model', 'requiredProviderReceiptVersion', 'requiredMaxOutputTokens'}
                or payload.get('requiredProviderReceiptVersion') != 1
                or type(required_output) is not int or not 1 <= required_output <= 512):
            raise BridgeError('Invalid planning capability request')
        route = profile()
        if payload['providerProfile'] != route['providerProfile'] or payload['model'] != route['model']:
            raise BridgeError('The requested Home provider route is unavailable')
        return {'providerReceiptVersion': 1, 'providerProfile': route['providerProfile'], 'model': route['model'], 'maxOutputTokens': 512}
    global WARM_PLANNING_ID
    with LOCK:
        run = PLANNING_RUNS.get(PLANNING_ALIASES.get(identity, identity))
        if operation == 'planning-create':
            if run:
                if not hmac.compare_digest(run.capability, capability):
                    raise BridgeError('The planning run capability does not match')
                if run.status == 'unknown':
                    return {'status': 'unknown', 'code': 'PLANNING_RUNTIME_OUTCOME_UNKNOWN'}
                if operation == 'planning-create' and run.payload != payload:
                    raise BridgeError('This planning run identity already has a different request')
                return {'status': run.status}
            if identity in RUNS:
                raise BridgeError('This identity already belongs to a project run')
            output_tokens = payload.get('maxOutputTokens')
            if (set(payload) != {'prompt', 'providerProfile', 'model', 'endpoint', 'maxOutputTokens', 'requiredProviderReceiptVersion'}
                    or payload.get('requiredProviderReceiptVersion') != 1
                    or type(output_tokens) is not int or not 1 <= output_tokens <= 512):
                raise BridgeError('Invalid planning create payload')
            prompt = payload.get('prompt')
            if not isinstance(prompt, str):
                raise BridgeError('Invalid planning prompt')
            try:
                prompt_size = len(prompt.encode('utf-8', errors='strict'))
            except UnicodeEncodeError:
                raise BridgeError('Invalid planning prompt') from None
            if not prompt or prompt_size > MAX_PLANNING_PROMPT:
                raise BridgeError('Invalid planning prompt')
            assert_route(profile(), payload)
            warm = PLANNING_RUNS.get(WARM_PLANNING_ID)
            if (warm and warm.awaiting_prompt and warm.status == 'preparing' and not warm.finished.is_set()
                    and all(warm.payload.get(key) == value for key, value in payload.items() if key != 'prompt')):
                with warm.assignment_lock:
                    warm.capability = capability
                    warm.payload = payload
                    warm.awaiting_prompt = False
                    warm.assigned_identity = identity
                    if warm.local.exists():
                        warm._write_ledger(warm.sandbox_id)
                PLANNING_ALIASES[identity] = warm.identity
                WARM_PLANNING_ID = None
                warm.prompt_ready.set()
                threading.Thread(target=prepare_home_runtime, daemon=True).start()
                return {'status': 'preparing'}
            if len(RUNS) + len(PLANNING_RUNS) >= 4:
                raise BridgeError('The local Hermes concurrency limit was reached')
            run = PlanningRun(identity, capability, payload)
            PLANNING_RUNS[identity] = run
            try:
                threading.Thread(target=run.work, daemon=True).start()
            except Exception:
                PLANNING_RUNS.pop(run.identity, None)
                PLANNING_ALIASES.pop(run.assigned_identity or identity, None)
                raise BridgeError('The planning run could not be started') from None
            return {'status': 'preparing'}
        if run and not hmac.compare_digest(run.capability, capability):
            raise BridgeError('The planning run capability does not match')
    if not run:
        if operation == 'planning-poll':
            if (set(payload) not in ({'cursor'}, {'cursor', 'waitMs'})
                    or type(payload.get('waitMs', 0)) is not int or not 0 <= payload.get('waitMs', 0) <= 1000):
                raise BridgeError('Invalid planning event cursor')
            cursor = payload.get('cursor')
            if isinstance(cursor, bool) or not isinstance(cursor, int) or cursor < 0:
                raise BridgeError('Invalid planning event cursor')
            return {'status': 'unknown', 'code': 'PLANNING_RUNTIME_OUTCOME_UNKNOWN', 'events': [], 'hasMore': False, 'stopReason': None}
        if operation == 'planning-delete':
            if payload:
                raise BridgeError('Invalid planning delete payload')
            return {'deleted': True}
        if operation == 'planning-cancel':
            if payload:
                raise BridgeError('Invalid planning cancel payload')
            return {'outcome': 'unknown'}
        raise BridgeError('The planning run is not available')
    if operation == 'planning-poll':
        if (set(payload) not in ({'cursor'}, {'cursor', 'waitMs'})
                    or type(payload.get('waitMs', 0)) is not int or not 0 <= payload.get('waitMs', 0) <= 1000):
            raise BridgeError('Invalid planning event cursor')
        return run.poll(payload.get('cursor', 0), payload.get('waitMs', 0))
    if operation == 'planning-home-tool-result':
        if (set(payload) != {'requestId', 'result'} or not isinstance(payload.get('requestId'), str)
                or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', payload['requestId'])):
            raise BridgeError('Invalid planning tool result request')
        if len(payload['requestId']) > 128 or run.status != 'running' or not run.acp or run.cancelled.is_set():
            raise BridgeError('The planning run cannot accept this tool result')
        run.acp.home_tool_result(payload['requestId'], payload['result'])
        return {'accepted': True}
    if operation == 'planning-provider-credit-result':
        if (set(payload) != {'requestId', 'result'} or not isinstance(payload.get('requestId'), str)
                or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', payload['requestId'])):
            raise BridgeError('Invalid planning provider receipt request')
        if run.status != 'running' or not run.acp or run.cancelled.is_set():
            raise BridgeError('The planning run cannot accept this provider receipt')
        run.acp.provider_credit_result(payload['requestId'], payload['result'])
        return {'accepted': True}
    if operation == 'planning-cancel':
        if payload:
            raise BridgeError('Invalid planning cancel payload')
        run.close()
        with LOCK:
            if PLANNING_RUNS.get(run.identity) is run:
                PLANNING_RUNS.pop(run.identity, None)
            PLANNING_ALIASES.pop(run.assigned_identity or identity, None)
        return {'outcome': 'confirmed'}
    if operation == 'planning-delete':
        if payload:
            raise BridgeError('Invalid planning delete payload')
        run.delete()
        with LOCK:
            if PLANNING_RUNS.get(run.identity) is run:
                PLANNING_RUNS.pop(run.identity, None)
            PLANNING_ALIASES.pop(run.assigned_identity or identity, None)
        return {'deleted': True}
    raise BridgeError('Unsupported planning bridge operation')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def do_POST(self):
        try:
            self.connection.settimeout(150)
            length = int(self.headers.get('Content-Length', '0'))
            if self.path != '/v1/runtime' or length < 1 or length > MAX_BODY:
                raise BridgeError('Invalid bridge request size or path')
            result = dispatch(json.loads(self.rfile.read(length)))
            self.reply(200, {'data': result})
        except Exception as error:
            message = str(error) if isinstance(error, BridgeError) else 'The private bridge operation failed.'
            self.reply(503, {'error': message})

    def reply(self, status, payload):
        encoded = json.dumps(payload, separators=(',', ':')).encode()
        if len(encoded) > MAX_BODY:
            status = 503
            encoded = b'{"error":"Bridge response exceeds its limit"}'
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_):
        pass


def main():
    active_gateway_profile()
    recover_runs()
    tls = STATE / 'tls'
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.load_cert_chain(tls / 'server.crt', tls / 'server.key')
    context.load_verify_locations(tls / 'ca.crt')
    context.verify_mode = ssl.CERT_REQUIRED
    server = ThreadingHTTPServer(('0.0.0.0', 17871), Handler)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=prepare_home_runtime, daemon=True).start()
    server.serve_forever()


if __name__ == '__main__':
    main()
