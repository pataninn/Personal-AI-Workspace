"""Isolated Home planning runs. These runs never upload or export project files."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

from acp import AcpSession
from common import BridgeError, CLI, GATEWAY, MAX_BODY, STATE, inventory, profile, run_cli, run_id, write_private
from provider import assert_route
from runtime.home_tool_schemas import HOME_TOOL_NAMES

MAX_PLANNING_PROMPT = 256 * 1024
MAX_POLL_PAGE = 256 * 1024
MAX_EVENT_HISTORY = 4 * MAX_BODY
MAX_EVENT_COUNT = 2000
INFERENCE_TIMEOUT_SECONDS = 15 * 60
MAX_PLANNING_OUTPUT_TOKENS = 512
PLANNING_TOOL_NAMES = frozenset(HOME_TOOL_NAMES)


def planning_sandbox_name(identity):
    return 'pai-h-' + hashlib.sha256(run_id(identity).encode()).hexdigest()[:13]


class PlanningRun:
    def __init__(self, identity, capability, payload, prepare_only=False):
        self.identity = run_id(identity)
        self.capability = capability
        self.name = planning_sandbox_name(identity)
        self.local = STATE / 'planning-runs' / self.name
        self.remote_work = '/sandbox/' + self.name + '-work'
        self.sandbox_id = None
        self.status = 'preparing'
        self.code = None
        self.acp = None
        self.cancelled = threading.Event()
        self.finished = threading.Event()
        self.lock = threading.Lock()
        self.changed = threading.Condition(self.lock)
        self.cleanup_lock = threading.Lock()
        self.events = []
        self.sequence = 0
        self.event_bytes = 0
        self.payload = payload
        self.home_tool_names = PLANNING_TOOL_NAMES
        self.is_planning = True
        self.awaiting_prompt = prepare_only
        self.assigned_identity = None
        self.assignment_lock = threading.RLock()
        self.prepared = threading.Event()
        self.prompt_ready = threading.Event()
        if not prepare_only:
            self.prompt_ready.set()

    @classmethod
    def recover(cls, ledger):
        value = json.loads(ledger.read_text(encoding='utf-8'))
        identity = run_id(value.get('runId'))
        name = planning_sandbox_name(identity)
        expected_parent = (STATE / 'planning-runs' / name).resolve()
        if (ledger.parent.resolve() != expected_parent or ledger.parent.name != name
                or value.get('sandboxName') != name or value.get('runId') != identity
                or not isinstance(value.get('capability'), str)
                or not re.fullmatch(r'[A-Za-z0-9_-]{43}', value['capability'])):
            raise BridgeError('Persisted planning sandbox ownership needs manual review')
        run = cls(identity, value['capability'], {})
        sandbox_id = value.get('sandboxId')
        if sandbox_id is not None and not isinstance(sandbox_id, str):
            raise BridgeError('Persisted planning sandbox ownership needs manual review')
        run.sandbox_id = sandbox_id
        if value.get('unclaimed') is True and 'assignedRunId' in value:
            raise BridgeError('Persisted planning assignment needs manual review')
        run.awaiting_prompt = value.get('unclaimed') is True
        run.assigned_identity = run_id(value['assignedRunId']) if 'assignedRunId' in value else None
        run.status = 'unknown'
        run.code = 'PLANNING_RUNTIME_OUTCOME_UNKNOWN'
        run.finished.set()
        return run

    def push(self, event):
        with self.lock:
            entry = {'sequence': self.sequence + 1, **event}
            try:
                size = len(json.dumps(entry, separators=(',', ':'), allow_nan=False).encode('utf-8'))
            except (TypeError, ValueError, UnicodeEncodeError):
                raise BridgeError('Hermes event history could not be validated') from None
            if self.event_bytes + size > MAX_EVENT_HISTORY or len(self.events) >= MAX_EVENT_COUNT:
                raise BridgeError('Hermes event history exceeds its bound')
            self.event_bytes += size
            self.sequence += 1
            self.events.append(entry)
            self.changed.notify_all()

    def poll(self, cursor, wait_ms=0):
        if isinstance(cursor, bool) or not isinstance(cursor, int) or cursor < 0:
            raise BridgeError('Invalid planning event cursor')
        if type(wait_ms) is not int or not 0 <= wait_ms <= 1000:
            raise BridgeError('Invalid planning wait duration')
        deadline = time.monotonic() + wait_ms / 1000
        with self.changed:
            while (self.sequence <= cursor and self.status in ('preparing', 'running')
                   and not self.cancelled.is_set() and time.monotonic() < deadline):
                self.changed.wait(timeout=max(0, deadline - time.monotonic()))
            status = self.status
            events = [event for event in self.events if event['sequence'] > cursor]
            selected = []
            size = 0
            for event in events:
                event_size = len(json.dumps(event, separators=(',', ':')).encode('utf-8'))
                if size + event_size > MAX_POLL_PAGE:
                    break
                size += event_size
                selected.append(event)
        return {
            'status': status,
            'code': self.code,
            'events': selected,
            'hasMore': len(selected) < len(events),
            'stopReason': None,
        }

    def work(self):
        try:
            max_tokens = self.payload.get('maxOutputTokens')
            if type(max_tokens) is not int or not 1 <= max_tokens <= MAX_PLANNING_OUTPUT_TOKENS:
                raise BridgeError('The planning output token limit is outside its bound')
            self._create()
            if self.cancelled.is_set():
                return
            self._create_empty_workdir()
            if self.cancelled.is_set():
                return
            command = self.ssh_command(
                '/usr/bin/env',
                'PAI_PLANNING_CWD=' + self.remote_work,
                'PAI_MODEL=' + self.payload['model'],
                'PAI_PROVIDER_PROFILE=' + self.payload['providerProfile'],
                'PAI_PROVIDER_ENDPOINT=' + self.payload['endpoint'],
                'PAI_PLANNING_MAX_TOKENS=' + str(max_tokens),
                '/opt/hermes/.venv/bin/python',
                '/opt/pai/planning_acp_runner.py',
            )
            self.acp = AcpSession(command, self)
            self.acp.open(self.remote_work)
            if self.cancelled.is_set():
                return
            self.prepared.set()
            self.prompt_ready.wait()
            if self.cancelled.is_set():
                return
            with self.lock:
                self.status = 'running'
            self.push({'type': 'started'})
            self.acp.prompt(self.payload['prompt'], timeout=INFERENCE_TIMEOUT_SECONDS)
            with self.lock:
                self.status = 'cancelled' if self.cancelled.is_set() else 'completed'
        except Exception:
            with self.lock:
                self.code = 'PLANNING_RUNTIME_FAILED'
                self.status = 'cancelled' if self.cancelled.is_set() else 'failed'
        finally:
            self.finished.set()
            with self.changed:
                self.changed.notify_all()
            if (self.cancelled.is_set() or self.awaiting_prompt) and self.sandbox_id:
                try:
                    if self.awaiting_prompt and self.acp:
                        self.acp.close()
                    self._cleanup()
                except Exception:
                    self.code = 'PLANNING_RUNTIME_OUTCOME_UNKNOWN'

    def _create(self):
        if any(row.get('name') == self.name for row in inventory()):
            raise BridgeError('A planning sandbox already exists for this turn; manual review is required')
        with self.assignment_lock:
            self.local.mkdir(parents=True, mode=0o700)
            self._write_ledger(None)
        route = profile()
        assert_route(route, self.payload)
        image = route.get('image')
        if not isinstance(image, str) or not (
            re.search(r'@sha256:[0-9a-f]{64}$', image)
            or re.fullmatch(r'sha256:[0-9a-f]{64}', image)
        ):
            raise BridgeError('The planning sandbox image is not digest-pinned')
        policy = Path(__file__).resolve().parent / 'policy.json'
        policy_hash = hashlib.sha256(policy.read_bytes()).hexdigest()
        if policy_hash != route['policySha256']:
            raise BridgeError('The pinned sandbox policy changed')
        run_cli([
            'sandbox', 'create', '--name', self.name, '--from', image,
            '--provider', route['providerName'], '--no-auto-providers', '--policy', str(policy),
            '--cpu', '1', '--memory', '2048Mi', '--detach', '--output', 'json',
        ], timeout=120)
        for _ in range(60):
            row = next((item for item in inventory() if item.get('name') == self.name), None)
            if row:
                self.sandbox_id = row.get('id')
                if not isinstance(self.sandbox_id, str) or not self.sandbox_id:
                    raise BridgeError('The planning sandbox identity could not be confirmed')
                self._write_ledger(self.sandbox_id)
                if str(row.get('phase', '')).lower() == 'ready':
                    break
            time.sleep(1)
        else:
            raise BridgeError('The isolated planning sandbox did not become ready')
        config = run_cli(['sandbox', 'ssh-config', self.name])
        if self.name not in config or 'ProxyCommand' not in config or CLI not in config:
            raise BridgeError('The scoped planning SSH config did not match its sandbox')
        write_private(self.local / 'ssh.conf', config)
        effective = json.loads(run_cli(['policy', 'get', self.name, '--full', '--output', 'json']))
        expected = json.loads(policy.read_text(encoding='utf-8'))
        if effective.get('status') != 'effective' or effective.get('policy') != expected:
            raise BridgeError('The effective planning sandbox policy differs from the pinned policy')
        assert_route(route, self.payload)

    def _write_ledger(self, sandbox_id):
        with self.assignment_lock:
            write_private(self.local / 'ledger.json', json.dumps({
                'runId': self.identity,
                'capability': self.capability,
                'sandboxId': sandbox_id,
                'sandboxName': self.name,
                'unclaimed': self.awaiting_prompt,
                **({'assignedRunId': self.assigned_identity} if self.assigned_identity else {}),
            }, separators=(',', ':')))

    def _create_empty_workdir(self):
        result = subprocess.run(
            self.ssh_command('/usr/bin/mkdir', '-m', '700', '--', self.remote_work),
            capture_output=True, timeout=30,
        )
        if result.returncode != 0:
            raise BridgeError('The empty planning working directory could not be created')

    def ssh_command(self, *command):
        return [
            '/usr/bin/ssh', '-F', str(self.local / 'ssh.conf'), '-T',
            '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10',
            'openshell-' + self.name + '.default', *command,
        ]

    def close(self):
        self.cancelled.set()
        self.prompt_ready.set()
        acp = self.acp
        if acp:
            with acp.home_tool_lock:
                self.cancelled.set()
            acp.close()
        else:
            self.cancelled.set()
        if not self.finished.wait(timeout=120):
            raise BridgeError('Planning run shutdown needs manual review')
        self._cleanup()
        with self.lock:
            self.status = 'cancelled'

    def delete(self):
        if self.status not in ('completed', 'failed', 'cancelled', 'unknown'):
            raise BridgeError('Only a terminal planning run can be deleted')
        if self.acp:
            self.acp.close()
        self._cleanup()

    def assert_owned(self):
        row = next((item for item in inventory() if item.get('name') == self.name), None)
        if not row or not self.sandbox_id or row.get('id') != self.sandbox_id:
            raise BridgeError('Planning sandbox ownership could not be confirmed')

    def _cleanup(self):
        with self.cleanup_lock:
            self._cleanup_owned()

    def _cleanup_owned(self):
        row = next((item for item in inventory() if item.get('name') == self.name), None)
        if row:
            if not self.sandbox_id or row.get('id') != self.sandbox_id:
                raise BridgeError('Planning sandbox ownership could not be confirmed; manual cleanup required')
            run_cli(['sandbox', 'delete', self.name])
        deadline = time.monotonic() + 30
        while any(item.get('name') == self.name for item in inventory()) and time.monotonic() < deadline:
            time.sleep(0.5)
        if any(item.get('name') == self.name for item in inventory()):
            raise BridgeError('Planning sandbox deletion could not be confirmed')
        if self.local.exists():
            if self.local.resolve().parent != (STATE / 'planning-runs').resolve():
                raise BridgeError('Planning local cleanup boundary mismatch')
            shutil.rmtree(self.local)
