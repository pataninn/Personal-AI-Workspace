"""Private mTLS bridge. This API is application-owned, not a vendor gateway API."""
import hashlib
import hmac
import json
import re
import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from common import BridgeError, CLI, MAX_BODY, STATE, profile, run_cli, run_id, sandbox_name
from lifecycle import Run

RUNS = {}
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


def dispatch(body):
    operation = body.get('operation')
    if operation == 'probe':
        p = profile()
        if hashlib.sha256(Path(CLI).read_bytes()).hexdigest() != p['openshellSha256']:
            raise BridgeError('The OpenShell binary changed')
        run_cli(['whoami', '--output', 'json'])
        return {'ready': True, 'profile': p}
    identity = run_id(body.get('runId'))
    capability = body.get('capability', '')
    if not isinstance(capability, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', capability):
        raise BridgeError('Invalid run capability')
    payload = body.get('payload', {})
    with LOCK:
        run = RUNS.get(identity)
        if operation == 'create':
            if run:
                raise BridgeError('This run was already created')
            if len(RUNS) >= 4:
                raise BridgeError('The local Hermes concurrency limit was reached')
            if not isinstance(payload.get('prompt'), str) or len(payload['prompt'].encode()) > 256 * 1024:
                raise BridgeError('Invalid run prompt')
            run = Run(identity, capability, payload)
            RUNS[identity] = run
            threading.Thread(target=run.work, daemon=True).start()
            return {'status': 'preparing'}
    if not run or not hmac.compare_digest(run.capability, capability):
        raise BridgeError('The run capability does not match')
    if operation == 'poll':
        return run.poll(int(payload.get('cursor', 0)))
    if operation == 'files':
        if run.status != 'completed' or run.cancelled.is_set():
            raise BridgeError('Only completed runs can export changes')
        return {'files': run.files()}
    if operation == 'permission':
        if not isinstance(payload.get('approved'), bool):
            raise BridgeError('Invalid command decision')
        run.permission(payload['permissionId'], payload['approved'])
        return {'accepted': True}
    if operation in ('cancel', 'delete'):
        run.close()
        with LOCK:
            RUNS.pop(identity, None)
        return {'deleted': True}
    raise BridgeError('Unsupported bridge operation')


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
    recover_runs()
    tls = STATE / 'tls'
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.load_cert_chain(tls / 'server.crt', tls / 'server.key')
    context.load_verify_locations(tls / 'ca.crt')
    context.verify_mode = ssl.CERT_REQUIRED
    server = ThreadingHTTPServer(('0.0.0.0', 17871), Handler)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
