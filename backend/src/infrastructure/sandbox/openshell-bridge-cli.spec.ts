import {
  OpenShellBridgeProfileError,
  OPEN_SHELL_BRIDGE_LIFECYCLE_OWNER,
  buildAcpInvocation,
  buildCreateInvocation,
  buildDeleteInvocation,
  buildExecInvocation,
  buildProbeInvocations,
  buildSshConfigInvocation,
  buildUploadInvocation,
  sandboxNameForRun
} from '@/infrastructure/sandbox/openshell-bridge-cli';

const profile = {
  lifecycleOwner: OPEN_SHELL_BRIDGE_LIFECYCLE_OWNER,
  profileDigest: `sha256:${'b'.repeat(64)}`,
  openshellBinaryPath: '/opt/openshell/bin/openshell',
  openshellSha256: 'c'.repeat(64),
  sshBinaryPath: '/usr/bin/ssh',
  sshSha256: 'f'.repeat(64),
  sshConfigRoot: '/run/bridge/ssh',
  gatewayName: 'nemoclaw-18080',
  imageReference: `registry.example/hermes@sha256:${'a'.repeat(64)}`,
  policyPath: '/etc/personal-ai/openshell-policy.yaml',
  policySha256: 'e'.repeat(64),
  providerName: 'compatible-endpoint',
  remoteStagingRoot: '/sandbox/pai-runs',
  cpuLimit: 1,
  memoryMiB: 2048
} as const;

const runSandbox = 'pai-272812a7ae467f0';

describe('OpenShell bridge CLI contract', () => {
  it('builds only the fixed probe and lifecycle argv', () => {
    expect(buildProbeInvocations(profile).map((item) => item.args)).toEqual([
      ['--gateway', 'nemoclaw-18080', 'status'],
      ['--gateway', 'nemoclaw-18080', 'whoami', '--output', 'json'],
      ['sandbox', 'list', '-g', 'nemoclaw-18080', '--output', 'json']
    ]);
    expect(buildCreateInvocation(profile, 'run-123')).toEqual({
      executable: '/opt/openshell/bin/openshell',
      operation: 'create',
      args: [
        'sandbox', 'create', '--name', runSandbox,
        '--from', `registry.example/hermes@sha256:${'a'.repeat(64)}`,
        '--provider', 'compatible-endpoint', '--no-auto-providers',
        '--policy', '/etc/personal-ai/openshell-policy.yaml',
        '--cpu', '1', '--memory', '2048Mi', '--detach',
        '-g', 'nemoclaw-18080', '--output', 'json'
      ]
    });
    expect(buildUploadInvocation(profile, 'run-123', '/run/bridge/archive.tar').args).toEqual([
      'sandbox', 'upload', runSandbox,
      '/run/bridge/archive.tar',
      `/sandbox/pai-runs/${runSandbox}/snapshot.tar`, '-g', 'nemoclaw-18080'
    ]);
    expect(buildSshConfigInvocation(profile, 'run-123').args).toEqual([
      'sandbox', 'ssh-config', runSandbox, '-g', 'nemoclaw-18080'
    ]);
    expect(buildAcpInvocation(profile, 'run-123', 60)).toEqual({
      executable: '/usr/bin/ssh', operation: 'acp', timeoutSeconds: 60,
      args: [
        '-F', `/run/bridge/ssh/${runSandbox}.conf`, '-T',
        '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes',
        '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR',
        `openshell-${runSandbox}.default`, '/usr/local/bin/hermes acp'
      ]
    });
    expect(buildDeleteInvocation(profile, 'run-123').args).toEqual([
      'sandbox', 'delete', runSandbox, '-g', 'nemoclaw-18080'
    ]);
  });

  it('keeps command execution argv-only and bounded', () => {
    expect(buildExecInvocation(profile, 'run-123', ['python', '-c', 'print(1)'], 30).args).toEqual([
      'sandbox', 'exec', '--name', runSandbox, '--timeout', '30',
      '--no-tty', '-g', 'nemoclaw-18080', '--', 'python', '-c', 'print(1)'
    ]);
    expect(() => buildExecInvocation(profile, 'run-123', ['bash'], 30)).toThrow(OpenShellBridgeProfileError);
    expect(() => buildUploadInvocation(profile, 'run-123', 'relative/archive.tar')).toThrow(OpenShellBridgeProfileError);
  });

  it('rejects mutable or unsafe profile and run values', () => {
    expect(sandboxNameForRun('run-123')).toBe(runSandbox);
    expect(sandboxNameForRun('run-123')).toHaveLength(19);
    expect(sandboxNameForRun(`run-${'a'.repeat(64)}`)).toHaveLength(19);
    expect(() => sandboxNameForRun('../run-123')).toThrow(OpenShellBridgeProfileError);
    expect(() => buildCreateInvocation({ ...profile, policyPath: 'policy.yaml' }, 'run-123')).toThrow(OpenShellBridgeProfileError);
    expect(() => buildAcpInvocation({ ...profile, sshConfigRoot: '/run/../etc' }, 'run-123', 30)).toThrow(OpenShellBridgeProfileError);
    expect(() => buildCreateInvocation({ ...profile, providerName: '--auto-providers' }, 'run-123')).toThrow(OpenShellBridgeProfileError);
    expect(() => buildCreateInvocation({ ...profile, lifecycleOwner: 'managed-nemohermes' as never }, 'run-123')).toThrow(OpenShellBridgeProfileError);
    expect(() => buildCreateInvocation({ ...profile, memoryMiB: 10_000 }, 'run-123')).toThrow(OpenShellBridgeProfileError);
  });
});
