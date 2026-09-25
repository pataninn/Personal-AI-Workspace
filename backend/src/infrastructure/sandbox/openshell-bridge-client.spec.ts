import type { BridgeResponseFrame } from '@/infrastructure/sandbox/openshell-bridge-protocol';
import {
  OpenShellBridgeClient,
  OpenShellBridgeClientError,
  type BridgeTlsCredentials,
  type BridgeTransport
} from '@/infrastructure/sandbox/openshell-bridge-client';

const digest = `sha256:${'e'.repeat(64)}`;
const credentials: BridgeTlsCredentials = { ca: Buffer.from('ca'), cert: Buffer.from('cert'), key: Buffer.from('key') };
const operations = ['probe', 'create', 'upload', 'exec', 'acp.open', 'acp.send', 'acp.cancel', 'status', 'delete'] as const;

function response(overrides: Partial<BridgeResponseFrame> = {}): BridgeResponseFrame {
  return {
    kind: 'response',
    protocolVersion: 1,
    operation: 'probe',
    runId: 'run-probe',
    requestId: 1,
    bridgeSequence: 1,
    outcome: 'ok',
    receiptDigest: digest,
    payload: { profileDigest: digest, operations },
    ...overrides
  };
}

describe('OpenShellBridgeClient', () => {
  it('probes through injected mTLS transport and checks the profile receipt', async () => {
    const transport: jest.MockedFunction<BridgeTransport> = jest.fn().mockResolvedValue(response());
    const credentialsLoader = jest.fn().mockResolvedValue(credentials);
    const client = new OpenShellBridgeClient({
      endpoint: 'https://host.docker.internal:17871',
      caFile: '/run/secrets/bridge-ca',
      clientCertFile: '/run/secrets/bridge-client-cert',
      clientKeyFile: '/run/secrets/bridge-client-key',
      profileDigest: digest,
      requestTimeoutMs: 5_000,
      transport,
      credentialsLoader
    });

    await expect(client.probe()).resolves.toEqual({ protocolVersion: 1, profileDigest: digest, operations, receiptDigest: digest });
    expect(credentialsLoader).toHaveBeenCalledWith({ caFile: '/run/secrets/bridge-ca', clientCertFile: '/run/secrets/bridge-client-cert', clientKeyFile: '/run/secrets/bridge-client-key' });
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ endpoint: new URL('https://host.docker.internal:17871'), credentials, timeoutMs: 5_000 }));
  });

  it('fails closed on profile mismatch or non-success bridge outcomes', async () => {
    const transport: jest.MockedFunction<BridgeTransport> = jest.fn().mockResolvedValue(response({ payload: { profileDigest: `sha256:${'f'.repeat(64)}`, operations } }));
    const client = new OpenShellBridgeClient({
      endpoint: 'https://host.docker.internal:17871',
      caFile: '/run/secrets/bridge-ca',
      clientCertFile: '/run/secrets/bridge-client-cert',
      clientKeyFile: '/run/secrets/bridge-client-key',
      profileDigest: digest,
      requestTimeoutMs: 5_000,
      transport,
      credentialsLoader: async () => credentials
    });

    await expect(client.probe()).rejects.toBeInstanceOf(OpenShellBridgeClientError);
  });

  it('rejects plaintext endpoints and incomplete secret paths before transport', () => {
    expect(() => new OpenShellBridgeClient({ endpoint: 'http://host.docker.internal:17871', caFile: '/run/secrets/ca', clientCertFile: '/run/secrets/cert', clientKeyFile: '/run/secrets/key', profileDigest: digest, requestTimeoutMs: 5_000 })).toThrow(OpenShellBridgeClientError);
    expect(() => new OpenShellBridgeClient({ endpoint: 'https://host.docker.internal:17871', caFile: 'relative-ca', clientCertFile: '/run/secrets/cert', clientKeyFile: '/run/secrets/key', profileDigest: digest, requestTimeoutMs: 5_000 })).toThrow(OpenShellBridgeClientError);
  });
});
