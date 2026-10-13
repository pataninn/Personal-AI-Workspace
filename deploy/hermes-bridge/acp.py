"""Bounded ACP JSON-RPC stdio transport for one disposable sandbox."""
import json
import queue
import subprocess
import threading
import time

from common import BridgeError, MAX_BODY


class AcpSession:
    def __init__(self, command, state):
        self.state = state
        self.child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.lock = threading.Lock()
        self.responses = {}
        self.counter = 0
        self.session_id = None
        self.permissions = {}
        self.task_requests = {}
        self.task_request_count = 0
        self.done = threading.Event()
        threading.Thread(target=self._read, daemon=True).start()

    def send(self, frame):
        encoded = json.dumps(frame, separators=(',', ':')).encode() + b'\n'
        if len(encoded) > MAX_BODY:
            raise BridgeError('ACP input exceeds its limit')
        with self.lock:
            self.child.stdin.write(encoded)
            self.child.stdin.flush()

    def call(self, method, params, timeout=60):
        with self.lock:
            self.counter += 1
            identity = self.counter
            target = queue.Queue(maxsize=1)
            self.responses[identity] = target
        self.send({'jsonrpc': '2.0', 'id': identity, 'method': method, 'params': params})
        try:
            frame = target.get(timeout=timeout)
        except queue.Empty:
            raise BridgeError('Hermes ACP did not confirm the operation')
        finally:
            self.responses.pop(identity, None)
        if 'error' in frame:
            raise BridgeError('Hermes ACP rejected the operation')
        return frame.get('result', {})

    def open(self, cwd):
        receipt = self.call('initialize', {'protocolVersion': 1, 'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False}, 'terminal': False}, 'clientInfo': {'name': 'personal-ai-workspace', 'version': '1'}})
        if receipt.get('agentInfo', {}).get('version') != '0.20.6':
            raise BridgeError('The Hermes release differs from the pinned release')
        result = self.call('session/new', {'cwd': cwd, 'mcpServers': []})
        self.session_id = result['sessionId']
        self.call('session/set_mode', {'sessionId': self.session_id, 'modeId': 'accept_edits'})

    def prompt(self, text):
        result = self.call('session/prompt', {'sessionId': self.session_id, 'prompt': [{'type': 'text', 'text': text}]}, timeout=900)
        self.state.stop_reason = result.get('stopReason')
        if self.state.stop_reason != 'end_turn':
            raise BridgeError('Hermes stopped without a confirmed complete result')

    def permission(self, identity, approved):
        request = self.permissions.pop(str(identity), None)
        if not request:
            raise BridgeError('The command permission is no longer pending')
        choices = request['params'].get('options', [])
        kind = 'allow_once' if approved else 'reject_once'
        choice = next((x for x in choices if x.get('kind') == kind), None)
        outcome = {'outcome': 'selected', 'optionId': choice['optionId']} if choice else {'outcome': 'cancelled'}
        self.send({'jsonrpc': '2.0', 'id': request['id'], 'result': {'outcome': outcome}})

    def cancel(self):
        if self.session_id and self.child.poll() is None:
            self.send({'jsonrpc': '2.0', 'method': 'session/cancel', 'params': {'sessionId': self.session_id}})

    def task_result(self, identity, result):
        request = self.task_requests.pop(str(identity), None)
        if not request or not isinstance(result, dict):
            raise BridgeError('The project task request is no longer pending')
        self.send({'jsonrpc': '2.0', 'id': request['id'], 'result': result})

    def close(self):
        try:
            self.cancel()
        except (BrokenPipeError, OSError):
            pass
        if self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait(timeout=5)

    def _read(self):
        try:
            while True:
                raw = self.child.stdout.readline(MAX_BODY + 1)
                if not raw:
                    break
                if len(raw) > MAX_BODY:
                    raise BridgeError('ACP output exceeds its limit')
                frame = json.loads(raw)
                if 'method' in frame:
                    if frame['method'] == '_pai/project_tasks' and 'id' in frame:
                        params = frame.get('params', {})
                        self.task_request_count += 1
                        if not isinstance(params, dict) or params.get('sessionId') != self.session_id or self.task_request_count > 50:
                            self.send({'jsonrpc': '2.0', 'id': frame['id'], 'result': {'error': 'Invalid or excessive project task request.'}})
                            continue
                        self.task_requests[str(frame['id'])] = frame
                        self.state.push({'type': 'project-task-request', 'id': str(frame['id']), 'params': params})
                    elif frame['method'] == 'session/request_permission':
                        self.permissions[str(frame['id'])] = frame
                        self.state.push({'type': 'permission', 'id': str(frame['id']), 'params': frame['params']})
                    elif frame['method'] == 'session/update':
                        update = frame.get('params', {}).get('update', {})
                        if update.get('sessionUpdate') != 'agent_thought_chunk':
                            self.state.push({'type': 'update', 'update': update})
                    elif 'id' in frame:
                        self.send({'jsonrpc': '2.0', 'id': frame['id'], 'error': {'code': -32601, 'message': 'Client capability unavailable'}})
                elif frame.get('id') in self.responses:
                    self.responses[frame['id']].put(frame)
        except Exception:
            self.state.error = 'The Hermes event stream could not be validated.'
        finally:
            self.done.set()
            for target in list(self.responses.values()):
                try:
                    target.put_nowait({'error': {'message': 'ACP stream ended'}})
                except queue.Full:
                    pass
