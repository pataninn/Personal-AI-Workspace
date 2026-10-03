"""Scoped lifecycle and approved snapshot transfer through the vendor CLI."""
import base64
import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

from acp import AcpSession
from common import BridgeError, CLI, GATEWAY, MAX_BODY, MAX_FILE, MAX_TOTAL, STATE, inventory, profile, run_cli, safe_path, sandbox_name, write_private


class Run:
    def __init__(self, identity, capability, payload):
        self.identity = identity
        self.capability = capability
        self.name = sandbox_name(identity)
        self.local = STATE / 'runs' / self.name
        self.remote = '/sandbox/pai-runs/' + self.name
        self.sandbox_id = None
        self.status = 'preparing'
        self.error = None
        self.stop_reason = None
        self.acp = None
        self.cancelled = threading.Event()
        self.events = []
        self.sequence = 0
        self.event_bytes = 0
        self.lock = threading.Lock()
        self.cleanup_lock = threading.Lock()
        self.finished = threading.Event()
        self.payload = payload

    def push(self, event):
        size = len(json.dumps(event).encode())
        with self.lock:
            self.event_bytes += size
            if self.event_bytes > 4 * MAX_BODY or len(self.events) >= 2000:
                raise BridgeError('Hermes event history exceeds its bound')
            self.sequence += 1
            self.events.append({'sequence': self.sequence, **event})

    def poll(self, cursor):
        with self.lock:
            events = [e for e in self.events if e['sequence'] > cursor]
            selected = []
            size = 0
            for event in events:
                size += len(json.dumps(event).encode())
                if size > 256 * 1024:
                    break
                selected.append(event)
        return {'status': self.status, 'error': self.error, 'events': selected, 'stopReason': self.stop_reason}

    def work(self):
        try:
            self._create()
            if self.cancelled.is_set():
                return
            self._upload()
            self.acp = AcpSession(self.ssh_command('/usr/bin/env', 'PAI_PROJECT_ROOT=' + self.remote + '/project', '/opt/hermes/.venv/bin/python', '/opt/pai/acp_runner.py'), self)
            self.acp.open(self.remote + '/project')
            self.status = 'running'
            self.push({'type': 'started'})
            self.acp.prompt(self.payload['prompt'])
            self.status = 'cancelled' if self.cancelled.is_set() else 'completed'
        except Exception as error:
            self.error = str(error) if isinstance(error, BridgeError) else 'The isolated Hermes run could not be completed.'
            self.status = 'cancelled' if self.cancelled.is_set() else 'failed'
        finally:
            self.finished.set()
            if self.cancelled.is_set() and self.sandbox_id:
                try:
                    self._cleanup()
                except Exception:
                    self.error = 'Cancelled sandbox cleanup needs manual review.'

    def _create(self):
        if any(row.get('name') == self.name for row in inventory()):
            raise BridgeError('A sandbox already exists for this run; manual review is required')
        self.local.mkdir(parents=True, mode=0o700)
        p = profile()
        policy = Path(__file__).resolve().parent / 'policy.json'
        if hashlib.sha256(policy.read_bytes()).hexdigest() != p['policySha256']:
            raise BridgeError('The pinned sandbox policy changed')
        run_cli(['sandbox', 'create', '--name', self.name, '--from', p['image'], '--provider', 'compatible-endpoint', '--no-auto-providers', '--policy', str(policy), '--cpu', '1', '--memory', '2048Mi', '--detach', '--output', 'json'], timeout=120)
        for _ in range(60):
            row = next((r for r in inventory() if r.get('name') == self.name), None)
            if row:
                self.sandbox_id = row.get('id')
                write_private(self.local / 'ledger.json', json.dumps({'runId': self.identity, 'capability': self.capability, 'sandboxId': self.sandbox_id, 'sandboxName': self.name}))
                if str(row.get('phase', '')).lower() == 'ready':
                    break
            time.sleep(1)
        else:
            raise BridgeError('The isolated sandbox did not become ready')
        config = run_cli(['sandbox', 'ssh-config', self.name])
        if self.name not in config or 'ProxyCommand' not in config or CLI not in config:
            raise BridgeError('The scoped SSH config did not match the sandbox')
        write_private(self.local / 'ssh.conf', config)
        effective = json.loads(run_cli(['policy', 'get', self.name, '--full', '--output', 'json']))
        expected = json.loads(policy.read_text())
        if effective.get('status') != 'effective' or effective.get('policy') != expected:
            raise BridgeError('The effective sandbox policy differs from the pinned policy')

    def _upload(self):
        project = self.local / 'snapshot' / 'project'
        project.mkdir(parents=True, mode=0o700)
        total = 0
        seen = set()
        for file in self.payload.get('files', []):
            relative = safe_path(file['path'])
            if relative in seen:
                raise BridgeError('Duplicate snapshot path')
            seen.add(relative)
            content = base64.b64decode(file['content'], validate=True)
            content.decode('utf-8', errors='strict')
            total += len(content)
            if len(content) > MAX_FILE or total > MAX_TOTAL or len(seen) > 100:
                raise BridgeError('The snapshot exceeds its bound')
            if hashlib.sha256(content).hexdigest() != file['sha256']:
                raise BridgeError('The snapshot hash does not match')
            destination = project / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        run_cli(['sandbox', 'upload', self.name, str(project), self.remote, '--no-git-ignore'], timeout=90)
        exported = self.files()
        received = {f['path']: f['sha256'] for f in exported}
        expected = {f['path']: f['sha256'] for f in self.payload.get('files', [])}
        if received != expected:
            raise BridgeError('The uploaded snapshot could not be verified')

    def ssh_command(self, *command):
        return ['/usr/bin/ssh', '-F', str(self.local / 'ssh.conf'), '-T', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10', 'openshell-' + self.name + '.default', *command]

    def files(self):
        self.assert_owned()
        result = subprocess.run(self.ssh_command('/opt/hermes/.venv/bin/python', '/opt/pai/export_files.py', self.remote + '/project'), capture_output=True, timeout=30)
        if result.returncode or len(result.stdout) > MAX_BODY:
            raise BridgeError('The generated project could not be exported safely')
        value = json.loads(result.stdout)
        if not isinstance(value, list):
            raise BridgeError('Invalid project export')
        return value

    def permission(self, identity, approved):
        self.assert_owned()
        if self.status != 'running' or not self.acp or self.cancelled.is_set():
            raise BridgeError('The run cannot accept a command decision')
        self.acp.permission(identity, approved)

    def close(self):
        self.cancelled.set()
        if self.acp:
            self.acp.close()
        if not self.finished.wait(timeout=120):
            raise BridgeError('Run shutdown needs manual review')
        self._cleanup()

    def assert_owned(self):
        row = next((r for r in inventory() if r.get('name') == self.name), None)
        if not row or not self.sandbox_id or row.get('id') != self.sandbox_id:
            raise BridgeError('Sandbox ownership could not be confirmed')

    def _cleanup(self):
        with self.cleanup_lock:
            self._cleanup_owned()

    def _cleanup_owned(self):
        row = next((r for r in inventory() if r.get('name') == self.name), None)
        if row:
            if not self.sandbox_id or row.get('id') != self.sandbox_id:
                raise BridgeError('Sandbox ownership could not be confirmed; manual cleanup required')
            run_cli(['sandbox', 'delete', self.name])
        if any(r.get('name') == self.name for r in inventory()):
            raise BridgeError('Sandbox deletion could not be confirmed')
        if self.local.exists():
            if self.local.resolve().parent != (STATE / 'runs').resolve():
                raise BridgeError('Local cleanup boundary mismatch')
            shutil.rmtree(self.local)
        self.status = 'cancelled'
