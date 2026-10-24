"""Pinned host bridge configuration; no provider credentials cross this boundary."""
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

STATE = Path.home() / '.local/state/personal-ai-hermes'
OPEN_SHELL_SHA256 = '24e85062073d512d1951c76cd3890b7bce1ab01cc36a08f88b3b43c067a402da'
OPEN_SHELL_GATEWAY_SHA256 = '780fc7ad871e2163f3fb866a2d0254ee682fc0d83e6261a84b350c8dcdd9f47b'
BASE_IMAGE = 'ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:85b894ae84b7c13f9c5799394fb7ef8c753c883b23a380af47eac1e7a82f6dff'
MAX_FILE = 256 * 1024
MAX_TOTAL = 512 * 1024
MAX_BODY = 1024 * 1024


class BridgeError(Exception):
    """A safe error category, never a child-process stderr dump."""


def gateway_profile(mode=None):
    selected = os.environ.get('PAI_GATEWAY_MODE', 'custom') if mode is None else mode
    if selected == 'custom':
        return {
            'mode': selected,
            'cli': str(Path.home() / '.local/bin/openshell'),
            'cliSha256': OPEN_SHELL_SHA256,
            'gateway': 'nemoclaw-18080',
            'gatewayBinary': str(Path.home() / '.local/bin/openshell-gateway'),
            'gatewaySha256': None,
            'serviceUnit': 'personal-ai-hermes-gateway.service',
        }
    if selected == 'packaged-linux':
        return {
            'mode': selected,
            'cli': '/usr/bin/openshell',
            'cliSha256': OPEN_SHELL_SHA256,
            'gateway': 'openshell',
            'gatewayBinary': '/usr/bin/openshell-gateway',
            'gatewaySha256': OPEN_SHELL_GATEWAY_SHA256,
            'serviceUnit': 'openshell-gateway.service',
        }
    raise BridgeError('Unsupported PAI_GATEWAY_MODE.')


try:
    GATEWAY_PROFILE = gateway_profile()
except BridgeError:
    GATEWAY_PROFILE = None

GATEWAY = GATEWAY_PROFILE['gateway'] if GATEWAY_PROFILE else 'nemoclaw-18080'
CLI = GATEWAY_PROFILE['cli'] if GATEWAY_PROFILE else str(Path.home() / '.local/bin/openshell')


def active_gateway_profile():
    if GATEWAY_PROFILE is None:
        raise BridgeError('Unsupported PAI_GATEWAY_MODE.')
    return GATEWAY_PROFILE


def run_cli(args, timeout=60):
    active_gateway_profile()
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
