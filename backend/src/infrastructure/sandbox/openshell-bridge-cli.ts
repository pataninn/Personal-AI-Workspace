import { createHash } from 'node:crypto';

import { AppError } from '@/shared/errors/app-error';

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REMOTE_ROOT_PATTERN = /^\/sandbox(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})+$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PROFILE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/** Prevent a deployment profile from mixing lifecycle owners. */
export const OPEN_SHELL_BRIDGE_LIFECYCLE_OWNER = 'raw-openshell' as const;

export interface OpenShellBridgeDeploymentProfile {
  readonly lifecycleOwner: typeof OPEN_SHELL_BRIDGE_LIFECYCLE_OWNER;
  readonly profileDigest: string;
  readonly openshellBinaryPath: string;
  readonly openshellSha256: string;
  readonly sshBinaryPath: string;
  readonly sshSha256: string;
  readonly sshConfigRoot: string;
  readonly gatewayName: string;
  readonly imageReference: string;
  readonly policyPath: string;
  readonly policySha256: string;
  readonly providerName: string;
  readonly remoteStagingRoot: string;
  readonly cpuLimit: number;
  readonly memoryMiB: number;
}

export interface BridgeCliInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly operation: 'status' | 'identity' | 'inventory' | 'create' | 'upload' | 'exec' | 'ssh-config' | 'acp' | 'delete';
  readonly timeoutSeconds?: number;
}

export class OpenShellBridgeProfileError extends AppError {
  public constructor(message: string) {
    super('OPEN_SHELL_BRIDGE_PROFILE_INVALID', 503, message);
    this.name = 'OpenShellBridgeProfileError';
  }
}

export function validateDeploymentProfile(profile: OpenShellBridgeDeploymentProfile): void {
  if (profile.lifecycleOwner !== OPEN_SHELL_BRIDGE_LIFECYCLE_OWNER) {
    throw new OpenShellBridgeProfileError('The bridge profile must select raw OpenShell ownership.');
  }
  validateDigest(profile.profileDigest, PROFILE_DIGEST_PATTERN, 'profile digest');
  validateDigest(profile.openshellSha256, SHA256_PATTERN, 'OpenShell digest');
  validateDigest(profile.sshSha256, SHA256_PATTERN, 'SSH digest');
  validateDigest(profile.policySha256, SHA256_PATTERN, 'policy digest');
  validateAbsolutePath(profile.openshellBinaryPath, 'OpenShell binary path');
  validateAbsolutePath(profile.sshBinaryPath, 'SSH binary path');
  validateAbsolutePath(profile.sshConfigRoot, 'SSH config root');
  validateName(profile.gatewayName, 'gateway name');
  if (!/@sha256:[0-9a-f]{64}$/u.test(profile.imageReference)) {
    throw new OpenShellBridgeProfileError('The image reference must be digest-pinned.');
  }
  validateAbsolutePath(profile.policyPath, 'policy path');
  if (!PROVIDER_PATTERN.test(profile.providerName)) {
    throw new OpenShellBridgeProfileError('The provider name is invalid.');
  }
  if (!REMOTE_ROOT_PATTERN.test(profile.remoteStagingRoot)) {
    throw new OpenShellBridgeProfileError('The remote staging root is invalid.');
  }
  if (!Number.isSafeInteger(profile.cpuLimit) || profile.cpuLimit < 1 || profile.cpuLimit > 4) {
    throw new OpenShellBridgeProfileError('The CPU limit is invalid.');
  }
  if (!Number.isSafeInteger(profile.memoryMiB) || profile.memoryMiB < 512 || profile.memoryMiB > 4096) {
    throw new OpenShellBridgeProfileError('The memory limit is invalid.');
  }
}

export function sandboxNameForRun(runId: string): string {
  if (!/^run-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(runId)) {
    throw new OpenShellBridgeProfileError('The run id is invalid.');
  }
  const sandboxName = `pai-${createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 15)}`;
  validateName(sandboxName, 'sandbox name');
  return sandboxName;
}

export function buildProbeInvocations(profile: OpenShellBridgeDeploymentProfile): readonly BridgeCliInvocation[] {
  validateDeploymentProfile(profile);
  return [
    // The installed v0.0.116 help surface does not make JSON output a
    // supported status flag. The bridge uses the exit receipt for status.
    { executable: profile.openshellBinaryPath, args: ['--gateway', profile.gatewayName, 'status'], operation: 'status' },
    { executable: profile.openshellBinaryPath, args: ['--gateway', profile.gatewayName, 'whoami', '--output', 'json'], operation: 'identity' },
    { executable: profile.openshellBinaryPath, args: ['sandbox', 'list', '-g', profile.gatewayName, '--output', 'json'], operation: 'inventory' }
  ];
}

export function buildCreateInvocation(profile: OpenShellBridgeDeploymentProfile, runId: string): BridgeCliInvocation {
  validateDeploymentProfile(profile);
  const sandboxName = sandboxNameForRun(runId);
  return {
    executable: profile.openshellBinaryPath,
    operation: 'create',
    args: [
      'sandbox', 'create', '--name', sandboxName,
      '--from', profile.imageReference,
      '--provider', profile.providerName, '--no-auto-providers',
      '--policy', profile.policyPath,
      '--cpu', String(profile.cpuLimit), '--memory', `${profile.memoryMiB}Mi`,
      '--detach', '-g', profile.gatewayName, '--output', 'json'
    ]
  };
}

export function buildUploadInvocation(profile: OpenShellBridgeDeploymentProfile, runId: string, archivePath: string): BridgeCliInvocation {
  validateDeploymentProfile(profile);
  const sandboxName = sandboxNameForRun(runId);
  validateAbsolutePath(archivePath, 'archive path');
  return {
    executable: profile.openshellBinaryPath,
    operation: 'upload',
    args: [
      'sandbox', 'upload', sandboxName, archivePath,
      `${profile.remoteStagingRoot}/${sandboxName}/snapshot.tar`, '-g', profile.gatewayName
    ]
  };
}

export function buildExecInvocation(profile: OpenShellBridgeDeploymentProfile, runId: string, command: readonly string[], timeoutSeconds: number): BridgeCliInvocation {
  validateDeploymentProfile(profile);
  const sandboxName = sandboxNameForRun(runId);
  validateCommand(command);
  validateTimeout(timeoutSeconds);
  return {
    executable: profile.openshellBinaryPath,
    operation: 'exec',
    args: [
      'sandbox', 'exec', '--name', sandboxName, '--timeout', String(timeoutSeconds),
      '--no-tty', '-g', profile.gatewayName, '--', ...command
    ]
  };
}

/** Generate a per-run OpenShell SSH config for owner-only bridge storage. */
export function buildSshConfigInvocation(profile: OpenShellBridgeDeploymentProfile, runId: string): BridgeCliInvocation {
  validateDeploymentProfile(profile);
  return {
    executable: profile.openshellBinaryPath,
    operation: 'ssh-config',
    args: ['sandbox', 'ssh-config', sandboxNameForRun(runId), '-g', profile.gatewayName]
  };
}

export function buildAcpInvocation(profile: OpenShellBridgeDeploymentProfile, runId: string, timeoutSeconds: number): BridgeCliInvocation {
  validateDeploymentProfile(profile);
  const sandboxName = sandboxNameForRun(runId);
  validateTimeout(timeoutSeconds);
  return {
    executable: profile.sshBinaryPath,
    operation: 'acp',
    timeoutSeconds,
    args: [
      '-F', `${profile.sshConfigRoot}/${sandboxName}.conf`, '-T',
      '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes',
      '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR',
      `openshell-${sandboxName}.default`, '/usr/local/bin/hermes acp'
    ]
  };
}

export function buildDeleteInvocation(profile: OpenShellBridgeDeploymentProfile, runId: string): BridgeCliInvocation {
  validateDeploymentProfile(profile);
  return {
    executable: profile.openshellBinaryPath,
    operation: 'delete',
    args: ['sandbox', 'delete', sandboxNameForRun(runId), '-g', profile.gatewayName]
  };
}

function validateDigest(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) {
    throw new OpenShellBridgeProfileError(`The ${label} is invalid.`);
  }
}

function validateAbsolutePath(value: string, label: string): void {
  const segments = value.split('/');
  if (
    !value.startsWith('/') || value.includes('\0') || value.includes('\r') || value.includes('\n') ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new OpenShellBridgeProfileError(`The ${label} must be an absolute bridge-local path.`);
  }
}

function validateName(value: string, label: string): void {
  if (!NAME_PATTERN.test(value)) {
    throw new OpenShellBridgeProfileError(`The ${label} is invalid.`);
  }
}

function validateCommand(command: readonly string[]): void {
  if (command.length === 0 || command.length > 32 || command.some((part) => part.length === 0 || part.includes('\0'))) {
    throw new OpenShellBridgeProfileError('The server-owned command argv is invalid.');
  }
  const executable = command[0];
  if (executable === undefined || /^(?:sh|bash|dash|zsh|fish|cmd|powershell|pwsh)$/u.test(executable)) {
    throw new OpenShellBridgeProfileError('Shell commands are not allowed through the bridge.');
  }
}

function validateTimeout(timeoutSeconds: number): void {
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) {
    throw new OpenShellBridgeProfileError('The bridge timeout is invalid.');
  }
}
