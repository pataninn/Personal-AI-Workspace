"""Bounded ACP JSON-RPC stdio transport for one disposable sandbox."""
import json
import math
import queue
import re
import subprocess
import threading
import time

from common import BridgeError, MAX_BODY

MAX_HOME_TOOL_RESULT = 256 * 1024
MAX_HOME_TOOL_EVENT = 256 * 1024
MAX_HOME_TOOL_REQUESTS = 50


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
        self.home_tool_requests = {}
        self.home_tool_request_count = 0
        self.home_tool_lock = threading.Lock()
        self.close_lock = threading.Lock()
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

    def prompt(self, text, timeout=900):
        result = self.call('session/prompt', {'sessionId': self.session_id, 'prompt': [{'type': 'text', 'text': text}]}, timeout=timeout)
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

    def home_tool_result(self, identity, result):
        key = str(identity)
        with self.home_tool_lock:
            request = self.home_tool_requests.get(key)
            if not request or self.state.cancelled.is_set():
                raise BridgeError('The Home tool request is no longer pending')
            value = self._validate_home_tool_result(result)
            self.home_tool_requests.pop(key, None)
            self.send({'jsonrpc': '2.0', 'id': request['id'], 'result': value})

    @staticmethod
    def _validate_home_tool_result(result):
        if not isinstance(result, dict):
            raise BridgeError('Invalid Home tool result')
        if (result.get('outcome') == 'shared' and set(result) == {'outcome', 'data'}
                and isinstance(result.get('data'), dict) and _is_json_value(result['data'])):
            value = result
        elif result.get('outcome') == 'denied' and set(result) == {'outcome', 'code'} and result.get('code') == 'CONSENT_DENIED':
            value = result
        else:
            raise BridgeError('Invalid Home tool result')
        try:
            encoded = json.dumps(value, separators=(',', ':'), allow_nan=False).encode('utf-8')
        except (TypeError, ValueError, UnicodeEncodeError):
            raise BridgeError('Invalid Home tool result') from None
        if len(encoded) > MAX_HOME_TOOL_RESULT:
            raise BridgeError('Home tool result exceeds its limit')
        return value

    def close(self):
        with self.close_lock:
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
                    elif frame['method'] == '_pai/home_tools' and 'id' in frame:
                        self._home_tool_request(frame)
                    elif frame['method'] == 'session/request_permission':
                        self.permissions[str(frame['id'])] = frame
                        self.state.push({'type': 'permission', 'id': str(frame['id']), 'params': frame['params']})
                    elif frame['method'] == 'session/update':
                        update = frame.get('params', {}).get('update', {})
                        is_planning = getattr(self.state, 'is_planning', False)
                        if is_planning:
                            if update.get('sessionUpdate') == 'agent_message_chunk':
                                self.state.push({'type': 'update', 'update': update})
                        elif update.get('sessionUpdate') != 'agent_thought_chunk':
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

    def _home_tool_request(self, frame):
        request_id = frame.get('id')
        params = frame.get('params')
        if isinstance(request_id, bool) or not isinstance(request_id, (str, int)) or (isinstance(request_id, int) and request_id < 0):
            return
        key = str(request_id)
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', key) or not isinstance(params, dict):
            self._reject_home_tool_request(request_id)
            return
        session_id = params.get('sessionId')
        name = params.get('name')
        args = params.get('args')
        allowed = getattr(self.state, 'home_tool_names', frozenset())
        if (session_id != self.session_id or not isinstance(session_id, str) or not 1 <= len(session_id) <= 128
                or not isinstance(name, str) or name not in allowed
                or not isinstance(args, dict) or not _is_json_value(args) or key in self.home_tool_requests
                or self.state.cancelled.is_set()):
            self._reject_home_tool_request(request_id)
            return
        event = {'type': 'home-tool-request', 'id': key,
                 'params': {'sessionId': session_id, 'name': name, 'args': args}}
        try:
            encoded = json.dumps(event, separators=(',', ':'), allow_nan=False).encode('utf-8')
        except (TypeError, ValueError, UnicodeEncodeError):
            self._reject_home_tool_request(request_id)
            return
        if len(encoded) > MAX_HOME_TOOL_EVENT:
            self._reject_home_tool_request(request_id)
            return
        with self.home_tool_lock:
            if key in self.home_tool_requests or self.state.cancelled.is_set():
                self._reject_home_tool_request(request_id)
                return
            if self.home_tool_request_count >= MAX_HOME_TOOL_REQUESTS:
                self._reject_home_tool_request(request_id)
                return
            self.home_tool_request_count += 1
            self.home_tool_requests[key] = frame
        self.state.push(event)

    def _reject_home_tool_request(self, request_id):
        try:
            self.send({'jsonrpc': '2.0', 'id': request_id,
                       'result': {'error': 'The typed Home tool request is unavailable.'}})
        except (BrokenPipeError, OSError, BridgeError):
            pass


def _is_json_value(value, depth=0):
    if depth > 32:
        return False
    if value is None or isinstance(value, (str, bool, int)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_is_json_value(item, depth + 1) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and _is_json_value(item, depth + 1) for key, item in value.items())
    return False
