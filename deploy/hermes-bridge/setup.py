"""Provision the local, mutually authenticated bridge and supervised gateway."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from common import STATE, CLI, GATEWAY, write_private


def openssl(*args):
    subprocess.run(['openssl', *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


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


def services(source):
    service_dir = Path.home() / '.config/systemd/user'
    gateway_state = Path.home() / '.local/state/nemoclaw/openshell-docker-gateway-18080'
    gateway = Path.home() / '.local/bin/openshell-gateway'
    if not (gateway_state / 'openshell-gateway.toml').is_file():
        raise RuntimeError('The selected existing gateway configuration is unavailable')
    unit = f'''[Unit]
Description=Personal AI isolated OpenShell gateway
After=default.target
[Service]
ExecStart={gateway} --config {gateway_state}/openshell-gateway.toml --name {GATEWAY} --bind-address 0.0.0.0 --port 18080 --db-url sqlite:{gateway_state}/openshell.db
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
After=personal-ai-hermes-gateway.service
Requires=personal-ai-hermes-gateway.service
[Service]
ExecStart=/usr/bin/python3 {source}/server.py
WorkingDirectory={source}
UMask=0077
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
'''
    write_private(service_dir / 'personal-ai-hermes-bridge.service', bridge)
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', '--user', 'enable', '--now', 'personal-ai-hermes-gateway.service', 'personal-ai-hermes-bridge.service'], check=True)


def main():
    source = Path(__file__).resolve().parent
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    STATE.chmod(0o700)
    deployed = STATE / 'bridge'
    shutil.copytree(source, deployed, dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__'))
    destination = Path(sys.argv[1]).resolve()
    image = sys.argv[2]
    if '@sha256:' not in image and not image.startswith('sha256:'):
        raise RuntimeError('A digest-pinned application Hermes image is required')
    policy = source / 'policy.json'
    receipt = {'gateway': GATEWAY, 'image': image, 'policySha256': hashlib.sha256(policy.read_bytes()).hexdigest(), 'openshellSha256': hashlib.sha256(Path(CLI).read_bytes()).hexdigest(), 'hermesVersion': '0.20.6'}
    write_private(STATE / 'profile.json', json.dumps(receipt))
    certificates(destination)
    services(deployed)
    subprocess.run(['systemctl', '--user', 'restart', 'personal-ai-hermes-bridge.service'], check=True)
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
