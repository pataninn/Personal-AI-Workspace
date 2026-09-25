import { createHash } from 'node:crypto';

import {
  type OpenShellBridgeDeploymentProfile,
  OpenShellBridgeProfileError,
  sandboxNameForRun,
  validateDeploymentProfile
} from '@/infrastructure/sandbox/openshell-bridge-cli';

export const OPEN_SHELL_BRIDGE_PROFILE_VERSION = 1 as const;
export const OPEN_SHELL_BRIDGE_EXPECTED_GATEWAY = 'nemoclaw-18080' as const;
export const OPEN_SHELL_BRIDGE_EXPECTED_PROVIDER = 'compatible-endpoint' as const;
export const OPEN_SHELL_BRIDGE_EXPECTED_MODEL = 'nvidia/nemotron-3-super-120b-a12b' as const;
export const OPEN_SHELL_BRIDGE_EXPECTED_IMAGE =
  'ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:85b894ae84b7c13f9c5799394fb7ef8c753c883b23a380af47eac1e7a82f6dff' as const;
export const OPEN_SHELL_BRIDGE_EXPECTED_POLICY_SHA256 =
  '1e9674c371a3e3074d1e72131054e5dda64314d4accfbb18da9feeba43082901' as const;
export const OPEN_SHELL_BRIDGE_EXPECTED_EFFECTIVE_POLICY_SHA256 =
  '9f7f16d4da2edb4d5d9de1f008ae96fbf62573cecc540caf23bd96189a2ad06b' as const;
export const OPEN_SHELL_BRIDGE_EXPECTED_OPENSHELL_SHA256 =
  '24e85062073d512d1951c76cd3890b7bce1ab01cc36a08f88b3b43c067a402da' as const;
export const OPEN_SHELL_BRIDGE_EXPECTED_SSH_SHA256 =
  '27a7f5e86ed31efa1e758c7f955bdc016adf58bb326c68e217ab5bee311b46b' as const;
export const OPEN_SHELL_BRIDGE_SSH_CONFIG_MODE = 0o600 as const;
export const OPEN_SHELL_BRIDGE_SSH_IDENTITY_MODE = 0o600 as const;
export const OPEN_SHELL_BRIDGE_HERMES_COMMAND = '/usr/local/bin/hermes acp' as const;

export interface OpenShellBridgeReleaseProfile extends OpenShellBridgeDeploymentProfile {
  readonly profileVersion: typeof OPEN_SHELL_BRIDGE_PROFILE_VERSION;
  readonly effectivePolicySha256: string;
  readonly model: string;
  readonly sshConfigMode: typeof OPEN_SHELL_BRIDGE_SSH_CONFIG_MODE;
  readonly sshIdentityMode: typeof OPEN_SHELL_BRIDGE_SSH_IDENTITY_MODE;
}

export interface OpenShellBridgeBinaryReceipt {
  readonly path: string;
  readonly sha256: string;
}

export interface OpenShellBridgePolicyReceipt {
  readonly path: string;
  readonly sha256: string;
  readonly effectiveSha256: string;
}

export interface OpenShellBridgeSshConfigReceipt {
  readonly path: string;
  readonly mode: number;
  readonly ownerOnly: boolean;
  readonly hostAlias: string;
  readonly user: string;
  readonly destination: string;
  readonly identityFilePath: string;
  readonly identityFileMode: number;
  readonly strictHostKeyChecking: 'no';
  readonly userKnownHostsFile: '/dev/null';
  readonly globalKnownHostsFile: '/dev/null';
  readonly logLevel: 'ERROR';
  readonly serverAliveInterval: 15;
  readonly serverAliveCountMax: 3;
  readonly proxyCommand: readonly string[];
}

export interface OpenShellBridgePreflightObservation {
  readonly openshell: OpenShellBridgeBinaryReceipt;
  readonly ssh: OpenShellBridgeBinaryReceipt;
  readonly policy: OpenShellBridgePolicyReceipt;
  readonly imageReference: string;
  readonly providerName: string;
  readonly gatewayName: string;
  readonly model: string;
  readonly sshConfig: OpenShellBridgeSshConfigReceipt;
}

export interface OpenShellBridgePreflightReceipt {
  readonly profileDigest: string;
  readonly profileVersion: typeof OPEN_SHELL_BRIDGE_PROFILE_VERSION;
  readonly gatewayName: string;
  readonly providerName: string;
  readonly model: string;
  readonly imageReference: string;
  readonly policySha256: string;
  readonly effectivePolicySha256: string;
  readonly openshellSha256: string;
  readonly sshSha256: string;
  readonly sshConfigPath: string;
  readonly sshHostAlias: string;
}

const CANDIDATE_PROFILE_FIELDS = {
  lifecycleOwner: 'raw-openshell',
  profileVersion: OPEN_SHELL_BRIDGE_PROFILE_VERSION,
  openshellBinaryPath: '/home/patan/.local/bin/openshell',
  openshellSha256: OPEN_SHELL_BRIDGE_EXPECTED_OPENSHELL_SHA256,
  sshBinaryPath: '/usr/bin/ssh',
  sshSha256: OPEN_SHELL_BRIDGE_EXPECTED_SSH_SHA256,
  sshConfigRoot: '/run/personal-ai/openshell-bridge/ssh',
  gatewayName: OPEN_SHELL_BRIDGE_EXPECTED_GATEWAY,
  imageReference: OPEN_SHELL_BRIDGE_EXPECTED_IMAGE,
  policyPath: '/etc/personal-ai/openshell-bridge/policy.json',
  policySha256: OPEN_SHELL_BRIDGE_EXPECTED_POLICY_SHA256,
  effectivePolicySha256: OPEN_SHELL_BRIDGE_EXPECTED_EFFECTIVE_POLICY_SHA256,
  providerName: OPEN_SHELL_BRIDGE_EXPECTED_PROVIDER,
  model: OPEN_SHELL_BRIDGE_EXPECTED_MODEL,
  remoteStagingRoot: '/sandbox/pai-runs',
  cpuLimit: 1,
  memoryMiB: 2048,
  sshConfigMode: OPEN_SHELL_BRIDGE_SSH_CONFIG_MODE,
  sshIdentityMode: OPEN_SHELL_BRIDGE_SSH_IDENTITY_MODE
} as const;

export const OPEN_SHELL_BRIDGE_CANDIDATE_PROFILE: OpenShellBridgeReleaseProfile = Object.freeze({
  ...CANDIDATE_PROFILE_FIELDS,
  profileDigest: digestProfileFields(CANDIDATE_PROFILE_FIELDS)
});

export function validateReleaseProfile(profile: OpenShellBridgeReleaseProfile): void {
  validateDeploymentProfile(profile);
  if (profile.profileVersion !== OPEN_SHELL_BRIDGE_PROFILE_VERSION) {
    throw new OpenShellBridgeProfileError('The bridge profile version is unsupported.');
  }
  if (profile.profileDigest !== digestProfileFields(profileFieldsForDigest(profile))) {
    throw new OpenShellBridgeProfileError('The bridge profile digest does not match its immutable fields.');
  }
  if (profile.imageReference !== OPEN_SHELL_BRIDGE_EXPECTED_IMAGE) {
    throw new OpenShellBridgeProfileError('The bridge image reference is not the reviewed immutable image.');
  }
  if (profile.providerName !== OPEN_SHELL_BRIDGE_EXPECTED_PROVIDER || profile.model !== OPEN_SHELL_BRIDGE_EXPECTED_MODEL) {
    throw new OpenShellBridgeProfileError('The bridge provider or model is not the reviewed route.');
  }
  if (profile.policySha256 !== OPEN_SHELL_BRIDGE_EXPECTED_POLICY_SHA256 || profile.effectivePolicySha256 !== OPEN_SHELL_BRIDGE_EXPECTED_EFFECTIVE_POLICY_SHA256) {
    throw new OpenShellBridgeProfileError('The bridge policy hashes are not the reviewed policy.');
  }
  if (profile.gatewayName !== OPEN_SHELL_BRIDGE_EXPECTED_GATEWAY || profile.cpuLimit !== 1 || profile.memoryMiB !== 2048) {
    throw new OpenShellBridgeProfileError('The bridge gateway or resource bounds are not the reviewed profile.');
  }
  if (profile.openshellBinaryPath !== '/home/patan/.local/bin/openshell' || profile.openshellSha256 !== OPEN_SHELL_BRIDGE_EXPECTED_OPENSHELL_SHA256) {
    throw new OpenShellBridgeProfileError('The OpenShell binary pin is not the reviewed release.');
  }
  if (profile.sshBinaryPath !== '/usr/bin/ssh' || profile.sshSha256 !== OPEN_SHELL_BRIDGE_EXPECTED_SSH_SHA256) {
    throw new OpenShellBridgeProfileError('The SSH binary pin is not the reviewed release.');
  }
}

export function validateOpenShellBridgePreflight(
  profile: OpenShellBridgeReleaseProfile,
  observation: OpenShellBridgePreflightObservation,
  runId: string
): OpenShellBridgePreflightReceipt {
  validateReleaseProfile(profile);
  const sandboxName = sandboxNameForRun(runId);
  assertEqual(observation.openshell.path, profile.openshellBinaryPath, 'OpenShell binary path');
  assertEqual(observation.openshell.sha256, profile.openshellSha256, 'OpenShell binary digest');
  assertEqual(observation.ssh.path, profile.sshBinaryPath, 'SSH binary path');
  assertEqual(observation.ssh.sha256, profile.sshSha256, 'SSH binary digest');
  assertEqual(observation.policy.path, profile.policyPath, 'policy path');
  assertEqual(observation.policy.sha256, profile.policySha256, 'policy digest');
  assertEqual(observation.policy.effectiveSha256, profile.effectivePolicySha256, 'effective policy digest');
  assertEqual(observation.imageReference, profile.imageReference, 'image reference');
  assertEqual(observation.providerName, profile.providerName, 'provider name');
  assertEqual(observation.gatewayName, profile.gatewayName, 'gateway name');
  assertEqual(observation.model, profile.model, 'model');
  validateSshConfigReceipt(profile, observation.sshConfig, sandboxName);
  return {
    profileDigest: profile.profileDigest,
    profileVersion: profile.profileVersion,
    gatewayName: profile.gatewayName,
    providerName: profile.providerName,
    model: profile.model,
    imageReference: profile.imageReference,
    policySha256: profile.policySha256,
    effectivePolicySha256: profile.effectivePolicySha256,
    openshellSha256: profile.openshellSha256,
    sshSha256: profile.sshSha256,
    sshConfigPath: observation.sshConfig.path,
    sshHostAlias: observation.sshConfig.hostAlias
  };
}

export function validateSshConfigReceipt(
  profile: OpenShellBridgeReleaseProfile,
  receipt: OpenShellBridgeSshConfigReceipt,
  sandboxName: string
): void {
  const expectedPath = `${profile.sshConfigRoot}/${sandboxName}.conf`;
  const expectedHostAlias = `openshell-${sandboxName}.default`;
  if (receipt.path !== expectedPath || receipt.mode !== profile.sshConfigMode || !receipt.ownerOnly) {
    throw new OpenShellBridgeProfileError('The SSH config is not an owner-only file for this sandbox.');
  }
  if (receipt.hostAlias !== expectedHostAlias || receipt.destination !== expectedHostAlias) {
    throw new OpenShellBridgeProfileError('The SSH config identity does not target the requested sandbox.');
  }
  if (receipt.user !== 'sandbox') {
    throw new OpenShellBridgeProfileError('The SSH config user is not the sandbox user.');
  }
  if (!receipt.identityFilePath.startsWith(`${profile.sshConfigRoot}/`) || receipt.identityFileMode !== profile.sshIdentityMode) {
    throw new OpenShellBridgeProfileError('The SSH identity file is outside the owner-only bridge directory.');
  }
  if (
    receipt.strictHostKeyChecking !== 'no' || receipt.userKnownHostsFile !== '/dev/null' ||
    receipt.globalKnownHostsFile !== '/dev/null' || receipt.logLevel !== 'ERROR' ||
    receipt.serverAliveInterval !== 15 || receipt.serverAliveCountMax !== 3
  ) {
    throw new OpenShellBridgeProfileError('The SSH config safety directives are invalid.');
  }
  const expectedProxyCommand = [
    profile.openshellBinaryPath,
    'ssh-proxy', '--gateway-name', profile.gatewayName,
    '--name', sandboxName, '--workspace', 'default'
  ];
  if (!arraysEqual(receipt.proxyCommand, expectedProxyCommand)) {
    throw new OpenShellBridgeProfileError('The SSH proxy command is not pinned to this gateway and sandbox.');
  }
}

function profileFieldsForDigest(profile: OpenShellBridgeReleaseProfile): Omit<OpenShellBridgeReleaseProfile, 'profileDigest'> {
  const { profileDigest: _profileDigest, ...fields } = profile;
  return fields;
}

function digestProfileFields(fields: object): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(fields), 'utf8').digest('hex')}`;
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new OpenShellBridgeProfileError(`The ${label} does not match the reviewed deployment profile.`);
  }
}

function arraysEqual(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
