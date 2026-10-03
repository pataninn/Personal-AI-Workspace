"""Pinned host bridge configuration; no provider credentials cross this boundary."""
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

STATE = Path.home() / '.local/state/personal-ai-hermes'
GATEWAY = 'nemoclaw-18080'
CLI = str(Path.home() / '.local/bin/openshell')
BASE_IMAGE = 'ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:85b894ae84b7c13f9c5799394fb7ef8c753c883b23a380af47eac1e7a82f6dff'
MAX_FILE = 256 * 1024
MAX_TOTAL = 512 * 1024
MAX_BODY = 1024 * 1024


class BridgeError(Exception):
    """A safe error category, never a child-process stderr dump."""


def run_cli(args, timeout=60):
    result = subprocess.run([CLI, *args, '-g', GATEWAY], capture_output=True, timeout=timeout)
    if result.returncode:
        raise BridgeError('OpenShell operation failed: ' + args[1])
    if len(result.stdout) > 4 * MAX_BODY:
        raise BridgeError('OpenShell output exceeded its limit')
    return result.stdout.decode('utf-8')


def run_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'(?:run-[A-Za-z0-9_-]{1,64}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})', value):
        raise BridgeError('Invalid run identity')
    return value


def sandbox_name(value):
    return 'pai-' + hashlib.sha256(run_id(value).encode()).hexdigest()[:15]


def safe_path(value):
    if not isinstance(value, str) or len(value) > 1024 or '\\' in value or '\x00' in value:
        raise BridgeError('Invalid relative file path')
    parts = value.split('/')
    if any(not p or p in ('.', '..') for p in parts) or ':' in value:
        raise BridgeError('Invalid relative file path')
    if any(p.startswith('.') or p in ('node_modules', 'secrets', 'dist', 'coverage') for p in parts):
        raise BridgeError('Protected or generated file path')
    return value


def write_private(path, content):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(content, encoding='utf-8')
    path.chmod(0o600)


def profile():
    return json.loads((STATE / 'profile.json').read_text())


def inventory():
    value = json.loads(run_cli(['sandbox', 'list', '--output', 'json']))
    return value if isinstance(value, list) else value.get('sandboxes', [])
