import {
  BridgeFrameDecoder,
  OpenShellBridgeProtocolError,
  decodeBridgeFrame,
  encodeBridgeFrame
} from '@/infrastructure/sandbox/openshell-bridge-protocol';

const digest = `sha256:${'a'.repeat(64)}`;

function requestFrame() {
  return {
    kind: 'request' as const,
    protocolVersion: 1,
    operation: 'probe' as const,
    runId: 'run-probe',
    requestId: 1,
    deadlineEpochMs: Date.now() + 5_000,
    capability: 'capability-token-012345678901234567890123',
    payload: { profileDigest: digest }
  };
}

describe('OpenShell bridge protocol', () => {
  it('round trips a length-delimited request across fragmented input', () => {
    const encoded = encodeBridgeFrame(requestFrame());
    const decoder = new BridgeFrameDecoder();

    const first = decoder.push(encoded.subarray(0, 3));
    const second = decoder.push(encoded.subarray(3));

    expect(first).toEqual([]);
    expect(second).toEqual([expect.objectContaining({ operation: 'probe', runId: 'run-probe' })]);
    decoder.assertComplete();
  });

  it('rejects an expired deadline, unknown operation, and traversal destination', () => {
    expect(() => decodeBridgeFrame(Buffer.from(JSON.stringify({ ...requestFrame(), deadlineEpochMs: Date.now() - 1 })))).toThrow(OpenShellBridgeProtocolError);
    expect(() => decodeBridgeFrame(Buffer.from(JSON.stringify({ ...requestFrame(), operation: 'shell' })))).toThrow(OpenShellBridgeProtocolError);
    expect(() => decodeBridgeFrame(Buffer.from(JSON.stringify({ ...requestFrame(), operation: 'upload', payload: { manifestDigest: digest, archiveBytes: 10, remoteDestination: '../outside' } })))).toThrow(OpenShellBridgeProtocolError);
  });

  it('validates response receipts and bounded frames', () => {
    const response = {
      kind: 'response' as const,
      protocolVersion: 1,
      operation: 'probe' as const,
      runId: 'run-probe',
      requestId: 1,
      bridgeSequence: 1,
      outcome: 'ok' as const,
      receiptDigest: digest,
      payload: { profileDigest: digest, operations: ['probe'] }
    };
    expect(decodeBridgeFrame(encodeBridgeFrame(response).subarray(4))).toEqual(response);
    expect(() => encodeBridgeFrame({ ...requestFrame(), payload: { profileDigest: digest, oversized: 'x'.repeat(70_000) } })).toThrow(OpenShellBridgeProtocolError);
  });
});
