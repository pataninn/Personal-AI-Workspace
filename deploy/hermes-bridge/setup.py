"""Provision the local, mutually authenticated bridge and supervised gateway."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from common import STATE, GATEWAY_PROFILE, active_gateway_profile, run_cli, write_private
from provider import settings, configure_provider


def openssl(*args):
    subprocess.run(['openssl', *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def verify_provider_credit_image(image, source):
    image_paths = {
        '/opt/pai/acp_runner.py': source / 'runtime' / 'acp_runner.py',
        '/opt/pai/planning_acp_runner.py': source / 'runtime' / 'planning_acp_runner.py',
        '/opt/pai/provider_credit.py': source / 'runtime' / 'provider_credit.py',
    }
    expected = {path: hashlib.sha256(file.read_bytes()).hexdigest() for path, file in image_paths.items()}
    result = subprocess.run(
        [
            'docker', 'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
            '--cap-drop', 'ALL', '--user', '65534:65534', '--entrypoint', '/usr/bin/sha256sum',
            image, *image_paths.keys()
        ],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True
    )
    actual = {}
    for line in result.stdout.splitlines():
        fields = line.split(maxsplit=1)
        if len(fields) == 2:
            actual[fields[1].lstrip('*')] = fields[0]
    if actual != expected:
        raise RuntimeError('The pinned Hermes image does not contain the current Home provider receipt boundary.')


def verify_policy_image(image):
    result = subprocess.run([
        'docker', 'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
        '--cap-drop', 'ALL', '--user', '65534:65534', '--memory', '256m', '--pids-limit', '64',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m', '--entrypoint', '/opt/hermes/.venv/bin/python',
        image, '-I', '-S', '/opt/pai/acp_runner.py', '--policy-self-test'
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=45)
    receipt = json.loads(result.stdout)
    if receipt.get('supported') is not True:
        raise RuntimeError('The pinned command policy could not be verified.')
    return receipt


def verify_gateway_binaries(gateway):
    try:
        cli_hash = hashlib.sha256(Path(gateway['cli']).read_bytes()).hexdigest()
    except OSError:
        raise RuntimeError('The pinned OpenShell CLI is unavailable.') from None
    if cli_hash != gateway['cliSha256']:
        raise RuntimeError('The OpenShell CLI differs from the pinned release.')
    hashes = {'openshellSha256': cli_hash}
    if gateway['gatewaySha256']:
        try:
            gateway_hash = hashlib.sha256(Path(gateway['gatewayBinary']).read_bytes()).hexdigest()
        except OSError:
            raise RuntimeError('The packaged OpenShell gateway binary is unavailable.') from None
        if gateway_hash != gateway['gatewaySha256']:
            raise RuntimeError('The packaged OpenShell gateway differs from the pinned release.')
        hashes['openshellGatewaySha256'] = gateway_hash
    return hashes


def verify_packaged_gateway_ready(gateway):
    if gateway['mode'] != 'packaged-linux':
        return
    result = subprocess.run(
        ['systemctl', '--user', 'is-active', '--quiet', gateway['serviceUnit']],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False
    )
    if result.returncode:
        raise RuntimeError('The packaged OpenShell gateway service must be active before setup.')
    run_cli(['whoami', '--output', 'json'])


def certificates(destination):
    tls = STATE / 'tls'
    tls.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not (tls / 'server.crt').exists():
        openssl('req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '365', '-subj', '/CN=Personal AI Hermes CA', '-keyout', str(tls / 'ca.key'), '-out', str(tls / 'ca.crt'))
        for role in ('server', 'client'):
            openssl('req', '-newkey', 'rsa:3072', '-nodes', '-subj', '/CN=personal-ai-' + role, '-keyout', str(tls / (role + '.key')), '-out', str(tls / (role + '.csr')))
            extensions = 'extendedKeyUsage=' + ('serverAuth\nsubjectAltName=DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1\n' if role == 'server' else 'clientAuth\n')
            write_private(tls / (role + '.ext'), extensions)
            openssl('x509', '-req', '-in', str(tls / (role + '.csr')), '-CA', str(tls / 'ca.crt'), '-CAkey', str(tls / 'ca.key'), '-CAcreateserial', '-days', '365', '-extfile', str(tls / (role + '.ext')), '-out', str(tls / (role + '.crt')))
        for item in tls.iterdir():
            item.chmod(0o600)
    destination.mkdir(parents=True, exist_ok=True)
    for name in ('ca.crt', 'client.crt', 'client.key'):
        (destination / name).write_bytes((tls / name).read_bytes())
        (destination / name).chmod(0o600)


def services(source, gateway=None):
    config = gateway or GATEWAY_PROFILE
    service_dir = Path.home() / '.config/systemd/user'
    gateway_state = Path.home() / '.local/state/nemoclaw/openshell-docker-gateway-18080'
    gateway_binary = Path.home() / '.local/bin/openshell-gateway'
    if config['mode'] == 'custom':
        if not (gateway_state / 'openshell-gateway.toml').is_file():
            raise RuntimeError('The selected existing gateway configuration is unavailable')
        unit = f'''[Unit]
Description=Personal AI isolated OpenShell gateway
After=default.target
[Service]
ExecStart={gateway_binary} --config {gateway_state}/openshell-gateway.toml --name {config['gateway']} --bind-address 0.0.0.0 --port 18080 --db-url sqlite:{gateway_state}/openshell.db
Environment=OPENSHELL_SSH_GATEWAY_HOST=127.0.0.1
Environment=OPENSHELL_SSH_GATEWAY_PORT=18080
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
'''
        write_private(service_dir / 'personal-ai-hermes-gateway.service', unit)
    bridge = f'''[Unit]
Description=Personal AI private Hermes bridge
After={config['serviceUnit']}
Requires={config['serviceUnit']}
[Service]
ExecStart=/usr/bin/python3 {source}/server.py
WorkingDirectory={source}
Environment=PAI_GATEWAY_MODE={config['mode']}
UMask=0077
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
'''
    write_private(service_dir / 'personal-ai-hermes-bridge.service', bridge)
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    services = ['personal-ai-hermes-bridge.service']
    if config['mode'] == 'custom':
        services.insert(0, 'personal-ai-hermes-gateway.service')
    subprocess.run(['systemctl', '--user', 'enable', '--now', *services], check=True)


def main():
    gateway = active_gateway_profile()
    image = sys.argv[2]
    if '@sha256:' not in image and not image.startswith('sha256:'):
        raise RuntimeError('A digest-pinned application Hermes image is required')
    binary_hashes = verify_gateway_binaries(gateway)
    verify_packaged_gateway_ready(gateway)
    route = settings(sys.argv[3])
    source = Path(__file__).resolve().parent
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    STATE.chmod(0o700)
    source_hash = hashlib.sha256()
    for file in sorted(source.rglob('*')):
        if file.is_file() and '__pycache__' not in file.parts:
            source_hash.update(str(file.relative_to(source)).encode())
            source_hash.update(file.read_bytes())
    previous = json.loads((STATE / 'profile.json').read_text()) if (STATE / 'profile.json').exists() else {}
    changed = (previous.get('bridgeSha256') != source_hash.hexdigest() or previous.get('image') != image
               or previous.get('gatewayMode') != gateway['mode'] or previous.get('gateway') != gateway['gateway']
               or any(previous.get(key) != value for key, value in route.items()))
    destination = Path(sys.argv[1]).resolve()
    verify_provider_credit_image(image, source)
    policy_receipt = verify_policy_image(image)
    policy = source / 'policy.json'
    if any((STATE / 'runs').glob('pai-*/ledger.json')):
        raise RuntimeError('Finish or cancel active Hermes runs before updating the bridge.')
    subprocess.run(['systemctl', '--user', 'stop', 'personal-ai-hermes-bridge.service'], check=True)
    deployed = STATE / 'bridge'
    shutil.copytree(source, deployed, dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__'))
    receipt = {'gateway': gateway['gateway'], 'gatewayMode': gateway['mode'], 'image': image, 'policySha256': hashlib.sha256(policy.read_bytes()).hexdigest(), **binary_hashes, 'hermesVersion': '0.20.6', 'bridgeSha256': source_hash.hexdigest()}
    receipt['policyCommand'] = policy_receipt
    receipt.update(route)
    write_private(STATE / 'profile.json', json.dumps(receipt))
    certificates(destination)
    services(deployed, gateway)
    configure_provider(sys.argv[3], route)
    if changed:
        subprocess.run(['systemctl', '--user', 'restart', 'personal-ai-hermes-bridge.service'], check=True)
    print(json.dumps(receipt))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Keep host credential paths and vendor response text out of the terminal.
        print('Hermes setup failed. Check the configured provider, key file, gateway, and active runs.', file=sys.stderr)
        sys.exit(1)
