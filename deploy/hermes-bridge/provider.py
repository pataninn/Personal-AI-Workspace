"""Configure the application inference route; credentials remain in the gateway."""
import os
import re
import subprocess
from pathlib import Path

from common import BridgeError, CLI, GATEWAY, run_cli

MODEL = 'nvidia/nemotron-3-super-120b-a12b'
ROUTES = {
    'nvidia-hosted-nim': ('compatible-endpoint', 'https://integrate.api.nvidia.com/v1'),
    'nebius-token-factory': ('pai-nebius-token-factory', 'https://api.tokenfactory.nebius.com/v1'),
}


def environment_file(path):
    values = {}
    for line in Path(path).read_text(encoding='utf-8-sig').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        name, separator, value = line.partition('=')
        if separator:
            values[name.strip()] = value.strip().strip('"').strip("'")
    return values


def settings(path):
    values = environment_file(path)
    profile = values.get('NIM_PROFILE', 'nvidia-hosted-nim')
    if profile not in ROUTES:
        raise BridgeError('Select nvidia-hosted-nim or nebius-token-factory in NIM_PROFILE.')
    name, endpoint = ROUTES[profile]
    if values.get('NIM_ENDPOINT', endpoint) != endpoint or values.get('NIM_MODEL', MODEL) != MODEL:
        raise BridgeError('The selected provider endpoint or Nemotron model does not match the application route.')
    return {'providerProfile': profile, 'providerName': name, 'endpoint': endpoint, 'model': MODEL}


def provider_command(args, key):
    environment = dict(os.environ, OPENAI_API_KEY=key)
    result = subprocess.run([CLI, 'provider', *args, '-g', GATEWAY], env=environment, capture_output=True, timeout=60)
    if result.returncode:
        # Vendor errors can contain credentials: never forward stdout/stderr.
        raise BridgeError('The Nebius gateway credential could not be configured.')


def secret_path(value, environment_path):
    drive = re.match(r'^([A-Za-z]):[\\/](.*)$', value)
    if drive:
        return Path('/mnt') / drive[1].lower() / drive[2].replace('\\', '/')
    path = Path(value)
    return path if path.is_absolute() else Path(environment_path).resolve().parent / path


def configure_provider(path, route):
    if route['providerProfile'] == 'nebius-token-factory':
        values = environment_file(path)
        key_path = secret_path(values.get('NEBIUS_API_KEY_FILE', './secrets/nebius_api_key'), path)
        try:
            key = key_path.read_text(encoding='utf-8-sig').strip()
        except OSError:
            raise BridgeError('Save your Nebius key in the file configured by NEBIUS_API_KEY_FILE.') from None
        if not key or len(key) > 4096 or any(c.isspace() for c in key):
            raise BridgeError('The Nebius key file must contain just a nonempty API key.')
        names = run_cli(['provider', 'list', '--names']).splitlines()
        args = ['update', route['providerName']] if route['providerName'] in names else ['create', '--name', route['providerName'], '--type', 'openai']
        provider_command([*args, '--credential', 'OPENAI_API_KEY', '--config', 'OPENAI_BASE_URL=' + route['endpoint']], key)
    run_cli(['inference', 'set', '--provider', route['providerName'], '--model', route['model'], '--timeout', '180', '--no-verify'])
    assert_route(route)


def assert_route(route, request=None):
    if request is not None and any(request.get(key) != route.get(key) for key in ('providerProfile', 'model', 'endpoint')):
        raise BridgeError('The approved provider disclosure does not match this Hermes gateway route.')
    result = re.sub(r'\x1b\[[0-9;]*m', '', run_cli(['inference', 'get'])).split('System inference:')[0]
    provider = re.search(r'Provider:\s*(\S+)', result)
    model = re.search(r'Model:\s*(\S+)', result)
    if not provider or not model or provider.group(1) != route['providerName'] or model.group(1) != route['model']:
        raise BridgeError('The Hermes inference route changed. Restart the app helper before sending context.')
