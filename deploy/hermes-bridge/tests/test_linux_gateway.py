import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE_ROOT))

import common
import setup as hermes_setup


class LinuxGatewayProfileTests(unittest.TestCase):
    def test_default_and_packaged_profiles_are_fixed_and_unknown_modes_fail(self):
        default = common.gateway_profile('custom')
        packaged = common.gateway_profile('packaged-linux')

        self.assertEqual(default['gateway'], 'nemoclaw-18080')
        self.assertEqual(default['mode'], 'custom')
        self.assertTrue(default['cli'].replace('\\', '/').endswith('/.local/bin/openshell'))
        self.assertEqual(packaged['cli'], '/usr/bin/openshell')
        self.assertEqual(packaged['gatewayBinary'], '/usr/bin/openshell-gateway')
        self.assertEqual(packaged['gateway'], 'openshell')
        self.assertEqual(packaged['cliSha256'], '24e85062073d512d1951c76cd3890b7bce1ab01cc36a08f88b3b43c067a402da')
        self.assertEqual(packaged['gatewaySha256'], '780fc7ad871e2163f3fb866a2d0254ee682fc0d83e6261a84b350c8dcdd9f47b')
        with self.assertRaisesRegex(common.BridgeError, 'Unsupported PAI_GATEWAY_MODE'):
            common.gateway_profile('other')

    def test_packaged_profile_verifies_both_binary_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            cli = Path(temporary) / 'openshell'
            gateway_binary = Path(temporary) / 'openshell-gateway'
            cli.write_bytes(b'pinned CLI fixture')
            gateway_binary.write_bytes(b'pinned gateway fixture')
            config = common.gateway_profile('packaged-linux')
            config.update({
                'cli': str(cli),
                'cliSha256': hashlib.sha256(cli.read_bytes()).hexdigest(),
                'gatewayBinary': str(gateway_binary),
                'gatewaySha256': hashlib.sha256(gateway_binary.read_bytes()).hexdigest(),
            })

            hashes = hermes_setup.verify_gateway_binaries(config)

            self.assertEqual(hashes, {
                'openshellSha256': config['cliSha256'],
                'openshellGatewaySha256': config['gatewaySha256'],
            })
            gateway_binary.write_bytes(b'changed gateway fixture')
            with self.assertRaisesRegex(RuntimeError, 'gateway differs from the pinned release'):
                hermes_setup.verify_gateway_binaries(config)

    def test_packaged_profile_requires_active_vendor_service_and_cli_readiness(self):
        config = common.gateway_profile('packaged-linux')
        with patch.object(hermes_setup.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run, \
                patch.object(hermes_setup, 'run_cli') as cli:
            hermes_setup.verify_packaged_gateway_ready(config)

        run.assert_called_once_with(
            ['systemctl', '--user', 'is-active', '--quiet', 'openshell-gateway.service'],
            stdout=hermes_setup.subprocess.DEVNULL,
            stderr=hermes_setup.subprocess.DEVNULL,
            check=False,
        )
        cli.assert_called_once_with(['whoami', '--output', 'json'])

        with patch.object(hermes_setup.subprocess, 'run', return_value=SimpleNamespace(returncode=3)), \
                patch.object(hermes_setup, 'run_cli') as cli:
            with self.assertRaisesRegex(RuntimeError, 'must be active before setup'):
                hermes_setup.verify_packaged_gateway_ready(config)
        cli.assert_not_called()

    def test_packaged_service_uses_vendor_unit_and_persists_mode_without_creating_gateway(self):
        config = common.gateway_profile('packaged-linux')
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with patch.object(hermes_setup.Path, 'home', return_value=home), \
                    patch.object(hermes_setup.subprocess, 'run') as run:
                hermes_setup.services(Path('/opt/pai/bridge'), config)

            service_dir = home / '.config/systemd/user'
            bridge_unit = (service_dir / 'personal-ai-hermes-bridge.service').read_text(encoding='utf-8')
            after = next(line.removeprefix('After=').split() for line in bridge_unit.splitlines() if line.startswith('After='))
            self.assertIn('default.target', after)
            self.assertIn('openshell-gateway.service', after)
            self.assertIn('Requires=openshell-gateway.service', bridge_unit)
            self.assertIn('Environment=PAI_GATEWAY_MODE=packaged-linux', bridge_unit)
            self.assertFalse((service_dir / 'personal-ai-hermes-gateway.service').exists())
            self.assertEqual(
                run.call_args_list[-1].args[0],
                ['systemctl', '--user', 'enable', '--now', 'personal-ai-hermes-bridge.service'],
            )

    def test_default_service_still_installs_custom_gateway_and_bridge(self):
        config = common.gateway_profile('custom')
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            gateway_state = home / '.local/state/nemoclaw/openshell-docker-gateway-18080'
            gateway_state.mkdir(parents=True)
            (gateway_state / 'openshell-gateway.toml').write_text('fixture', encoding='utf-8')
            with patch.object(hermes_setup.Path, 'home', return_value=home), \
                    patch.object(hermes_setup.subprocess, 'run') as run:
                hermes_setup.services(Path('/opt/pai/bridge'), config)

            service_dir = home / '.config/systemd/user'
            gateway_unit = (service_dir / 'personal-ai-hermes-gateway.service').read_text(encoding='utf-8')
            bridge_unit = (service_dir / 'personal-ai-hermes-bridge.service').read_text(encoding='utf-8')
            self.assertIn('--name nemoclaw-18080', gateway_unit)
            after = next(line.removeprefix('After=').split() for line in bridge_unit.splitlines() if line.startswith('After='))
            self.assertIn('default.target', after)
            self.assertIn('personal-ai-hermes-gateway.service', after)
            self.assertIn('Environment=PAI_GATEWAY_MODE=custom', bridge_unit)
            self.assertEqual(
                run.call_args_list[-1].args[0],
                ['systemctl', '--user', 'enable', '--now', 'personal-ai-hermes-gateway.service', 'personal-ai-hermes-bridge.service'],
            )

    def test_unready_packaged_service_fails_before_state_or_provider_mutation(self):
        config = common.gateway_profile('packaged-linux')
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / 'state'
            with patch.object(hermes_setup, 'STATE', state), \
                    patch.object(hermes_setup, 'active_gateway_profile', return_value=config), \
                    patch.object(hermes_setup, 'verify_gateway_binaries', return_value={}), \
                    patch.object(hermes_setup, 'verify_packaged_gateway_ready', side_effect=RuntimeError('not ready')), \
                    patch.object(hermes_setup, 'settings') as settings, \
                    patch.object(hermes_setup, 'certificates') as certificates, \
                    patch.object(hermes_setup, 'services') as services, \
                    patch.object(hermes_setup, 'configure_provider') as configure_provider, \
                    patch.object(hermes_setup.sys, 'argv', ['setup.py', '/tmp/certs', 'image@sha256:abc', '/tmp/provider.env']):
                with self.assertRaisesRegex(RuntimeError, 'not ready'):
                    hermes_setup.main()

            self.assertFalse(state.exists())
            settings.assert_not_called()
            certificates.assert_not_called()
            services.assert_not_called()
            configure_provider.assert_not_called()

    def test_gateway_hash_mismatch_fails_before_state_or_provider_mutation(self):
        config = common.gateway_profile('packaged-linux')
        with tempfile.TemporaryDirectory() as temporary:
            cli = Path(temporary) / 'openshell'
            gateway_binary = Path(temporary) / 'openshell-gateway'
            cli.write_bytes(b'pinned CLI fixture')
            gateway_binary.write_bytes(b'changed gateway fixture')
            config.update({
                'cli': str(cli),
                'cliSha256': hashlib.sha256(cli.read_bytes()).hexdigest(),
                'gatewayBinary': str(gateway_binary),
                'gatewaySha256': '0' * 64,
            })
            state = Path(temporary) / 'state'
            with patch.object(hermes_setup, 'STATE', state), \
                    patch.object(hermes_setup, 'active_gateway_profile', return_value=config), \
                    patch.object(hermes_setup, 'verify_packaged_gateway_ready') as ready, \
                    patch.object(hermes_setup, 'settings') as settings, \
                    patch.object(hermes_setup, 'certificates') as certificates, \
                    patch.object(hermes_setup, 'services') as services, \
                    patch.object(hermes_setup, 'configure_provider') as configure_provider, \
                    patch.object(hermes_setup.sys, 'argv', ['setup.py', '/tmp/certs', 'image@sha256:abc', '/tmp/provider.env']):
                with self.assertRaisesRegex(RuntimeError, 'gateway differs from the pinned release'):
                    hermes_setup.main()

            self.assertFalse(state.exists())
            ready.assert_not_called()
            settings.assert_not_called()
            certificates.assert_not_called()
            services.assert_not_called()
            configure_provider.assert_not_called()


if __name__ == '__main__':
    unittest.main()
