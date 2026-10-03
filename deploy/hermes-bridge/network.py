"""Named registry grants scoped to one explicitly approved package command."""
import json
import shlex
import re
from pathlib import Path

from common import BridgeError, run_cli, write_private


def registry_grant(command):
    if not re.match(r'^\s*(?:(?:npm|pnpm)\s+(?:install|add|ci)|(?:pip|pip3)\s+install)\b', command):
        return None
    if any(c in command for c in '\n;&|><`$'):
        return None
    try:
        parts = shlex.split(command)
    except ValueError:
        return None
    if len(parts) < 2:
        return None
    if parts[0] in ('npm', 'pnpm') and parts[1] in ('install', 'add', 'ci'):
        hosts, binaries = ['registry.npmjs.org'], ['/usr/bin/node', '/usr/local/bin/node']
    elif parts[0] in ('pip', 'pip3') and parts[1] == 'install':
        hosts, binaries = ['pypi.org', 'files.pythonhosted.org'], ['/usr/bin/python3.11', '/opt/hermes/.venv/bin/python']
    else:
        return None
    return {'name': 'approved_package_command', 'binaries': [{'path': p} for p in binaries], 'endpoints': [{'host': host, 'port': 443, 'protocol': 'rest', 'enforcement': 'enforce', 'rules': [{'allow': {'method': 'GET', 'path': '/**'}}]} for host in hosts]}


def set_registry_grant(run, grant):
    run.assert_owned()
    policy = json.loads((Path(__file__).parent / 'policy.json').read_text())
    if grant:
        policy['network_policies']['approved_package_command'] = grant
    destination = run.local / 'command-policy.json'
    write_private(destination, json.dumps(policy))
    run_cli(['policy', 'set', run.name, '--policy', str(destination), '--wait', '--timeout', '20'], timeout=30)
    receipt = json.loads(run_cli(['policy', 'get', run.name, '--full', '--output', 'json']))
    if receipt.get('policy') != policy or receipt.get('status') != 'effective':
        raise BridgeError('Approved command network policy could not be confirmed')
