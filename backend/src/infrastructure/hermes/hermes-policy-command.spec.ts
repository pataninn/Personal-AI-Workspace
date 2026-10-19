import { AiRunRuntimeUnavailableError } from '@/modules/ai-runs/domain/ai-run-errors';
import { COMMAND_LIMITS, normalizePolicyHermesPermission } from '@/modules/ai-runs/domain/command-policy';
import type { RuntimeRunInput } from '@/modules/ai-runs/repositories/agent-runtime';
import { HermesPolicyCommand, POLICY_COMMAND_PROFILE_HASH, POLICY_COMMAND_VERSION, policyCommandReceiptAvailable, policySnapshotHash } from '@/infrastructure/hermes/hermes-policy-command';
import { HermesAgentRuntime } from '@/infrastructure/hermes/hermes-agent-runtime';
import type { HermesBridgeClient } from '@/infrastructure/hermes/hermes-bridge-client';
import type { ApprovedContextReader } from '@/infrastructure/hermes/approved-context-reader';

const run: RuntimeRunInput = {
  runId: 'run-policy', ownerId: 'owner', projectId: 'project', conversationId: 'conversation', storageKind: 'managed', relativeRoot: 'projects/project', request: 'Read README.', policyRevision: '1',
  manifest: { manifestHash: 'a'.repeat(64), files: [{ relativePath: 'README.md', sourceHash: 'c'.repeat(64), sizeBytes: 10 }], provider: 'NVIDIA hosted NIM', providerProfile: 'fixture', model: 'fixture',
    categories: ['project_files'], requestBytes: 12, messageBytes: 0, messageCount: 0, messageHash: 'd'.repeat(64), messages: [], byteEstimate: 22, tokenEstimate: 10,
    excludedItemCount: 0, omittedItemCount: 0, omissionSummary: '', bestEffortSecretDetection: true }
};
const requestId = 'b'.repeat(32);
const commandHash = normalizePolicyHermesPermission({ command: 'hermes-terminal', args: ['cat README.md'] }, ['README.md'], run.manifest.manifestHash).proposalHash;
const binding = { runId: run.runId, requestId, commandHash, profileVersion: POLICY_COMMAND_VERSION, profileHash: POLICY_COMMAND_PROFILE_HASH, manifestHash: run.manifest.manifestHash };
const result = { exitCode: 0, stdout: 'bounded fixture output\n', stderr: '', timedOut: false, outputTruncated: false, durationMs: 10 };

function fixture(): { readonly policy: HermesPolicyCommand; readonly call: jest.Mock; cancel(): void } {
  let cancelled = false;
  const call = jest.fn().mockResolvedValue({ accepted: true });
  const policy = new HermesPolicyCommand({ run, call, cancelled: () => cancelled });
  const proposal = policy.propose({ id: requestId, params: { ...binding, command: 'cat README.md' } });
  policy.bind({ ...proposal, commandId: 'command-policy' });
  return { policy, call, cancel: () => { cancelled = true; } };
}

describe('private Hermes policy command protocol', () => {
  it('dispatches one exact permission and holds output until an explicit post-persistence release', async () => {
    const { policy, call } = fixture();
    const execution = policy.execute({ runId: run.runId, commandId: 'command-policy', command: 'hermes-terminal', args: ['cat README.md'], cwd: '.', limits: COMMAND_LIMITS });
    await Promise.resolve();
    expect(call).toHaveBeenCalledTimes(1);
    const { runId: _runId, ...permissionBinding } = binding;
    expect(call).toHaveBeenCalledWith('policy-command-permission', { ...permissionBinding, commandId: 'command-policy' });
    policy.receive({ id: requestId, params: { ...binding, commandId: 'command-policy', result } });
    await expect(execution).resolves.toMatchObject({ termination: 'completed', outputPreview: result.stdout });
    expect(call).toHaveBeenCalledTimes(1);
    await policy.complete('command-policy');
    expect(call.mock.calls[1]?.[0]).toBe('policy-command-result-permission');
    await expect(policy.complete('command-policy')).rejects.toBeInstanceOf(AiRunRuntimeUnavailableError);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('rejects changed command, duplicate request and cross-manifest result without continuation', async () => {
    const { policy, call } = fixture();
    expect(() => policy.propose({ id: requestId, params: { ...binding, command: 'cat README.md' } })).toThrow(AiRunRuntimeUnavailableError);
    await expect(policy.execute({ runId: run.runId, commandId: 'command-policy', command: 'hermes-terminal', args: ['ls'], cwd: '.', limits: COMMAND_LIMITS })).rejects.toBeInstanceOf(AiRunRuntimeUnavailableError);
    expect(() => policy.receive({ id: requestId, params: { ...binding, manifestHash: 'c'.repeat(64), commandId: 'command-policy', result } })).toThrow(AiRunRuntimeUnavailableError);
    expect(call).not.toHaveBeenCalled();
  });

  it('suppresses results and release after cancellation', async () => {
    const { policy, call, cancel } = fixture();
    const execution = policy.execute({ runId: run.runId, commandId: 'command-policy', command: 'hermes-terminal', args: ['cat README.md'], cwd: '.', limits: COMMAND_LIMITS });
    cancel();
    expect(() => policy.receive({ id: requestId, params: { ...binding, commandId: 'command-policy', result } })).toThrow(AiRunRuntimeUnavailableError);
    await expect(execution).rejects.toBeInstanceOf(AiRunRuntimeUnavailableError);
    await expect(policy.complete('command-policy')).rejects.toBeInstanceOf(AiRunRuntimeUnavailableError);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('does not retry a result acknowledgment after uncertain delivery', async () => {
    const { policy, call } = fixture();
    const execution = policy.execute({ runId: run.runId, commandId: 'command-policy', command: 'hermes-terminal', args: ['cat README.md'], cwd: '.', limits: COMMAND_LIMITS });
    policy.receive({ id: requestId, params: { ...binding, commandId: 'command-policy', result } });
    await execution;
    call.mockRejectedValueOnce(new AiRunRuntimeUnavailableError());
    await expect(policy.complete('command-policy')).rejects.toBeInstanceOf(AiRunRuntimeUnavailableError);
    await expect(policy.complete('command-policy')).rejects.toBeInstanceOf(AiRunRuntimeUnavailableError);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized raw output before preview or model continuation', async () => {
    const { policy, call, cancel } = fixture();
    const execution = policy.execute({ runId: run.runId, commandId: 'command-policy', command: 'hermes-terminal', args: ['cat README.md'], cwd: '.', limits: COMMAND_LIMITS });
    expect(() => policy.receive({ id: requestId, params: { ...binding, commandId: 'command-policy', result: { ...result, stdout: 'x'.repeat(COMMAND_LIMITS.maxOutputBytes + 1) } } })).toThrow(AiRunRuntimeUnavailableError);
    cancel();
    await expect(execution).rejects.toBeInstanceOf(AiRunRuntimeUnavailableError);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('accepts capability receipts only when every fixed limit is attested', () => {
    expect(POLICY_COMMAND_PROFILE_HASH).toBe('fc2417963b2800fda4ee202b94678f380d5b6f45fea54d75325c8bbffe2ec8b7');
    expect(normalizePolicyHermesPermission({ command: 'hermes-terminal', args: ['cat readme.txt'] }, ['readme.txt'], 'a'.repeat(64)).proposalHash)
      .toBe('00c2dadf7ecd4d0ad5295789fd941958180ff936cef94da377a652abbbf5b1ef');
    const receipt = { supported: true, profileVersion: POLICY_COMMAND_VERSION, profileHash: POLICY_COMMAND_PROFILE_HASH, limits: COMMAND_LIMITS, unavailableReasons: [] };
    expect(policyCommandReceiptAvailable(receipt)).toBe(true);
    expect(policyCommandReceiptAvailable({ ...receipt, supported: false })).toBe(false);
    expect(policyCommandReceiptAvailable({ ...receipt, limits: { ...COMMAND_LIMITS, network: 'allowed' } })).toBe(false);
    expect(policyCommandReceiptAvailable({ ...receipt, unavailableReasons: ['missing enforcement'] })).toBe(false);
    expect(policySnapshotHash([{ path: 'b', sha256: '2', content: '', sourceHash: '' }, { path: 'a', sha256: '1', content: '', sourceHash: '' }]))
      .toBe(policySnapshotHash([{ path: 'a', sha256: '1', content: '', sourceHash: '' }, { path: 'b', sha256: '2', content: '', sourceHash: '' }]));
  });

  it('consumes the real adapter iterator while private execution awaits its result, then releases it', async () => {
    let stage = 0;
    let released = false;
    const call = jest.fn(async (operation: string): Promise<Record<string, unknown>> => {
      if (operation === 'probe') return { ready: true, profile: { hermesVersion: '0.20.6', providerProfile: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid' },
        policyCommand: { supported: true, profileVersion: POLICY_COMMAND_VERSION, profileHash: POLICY_COMMAND_PROFILE_HASH, limits: COMMAND_LIMITS, unavailableReasons: [] } };
      if (operation === 'poll') {
        if (stage++ === 0) return { status: 'running', events: [{ sequence: 1, type: 'policy-command-proposed', id: requestId, params: { ...binding, command: 'cat README.md' } }] };
        if (stage === 2) return { status: 'running', events: [{ sequence: 2, type: 'policy-command-result', id: requestId, params: { ...binding, commandId: 'command-policy', result } }] };
        return { status: released ? 'completed' : 'running', events: [] };
      }
      if (operation === 'policy-command-result-permission') released = true;
      if (operation === 'files') return { files: [] };
      return { accepted: true };
    });
    const runtime = new HermesAgentRuntime({ call } as unknown as HermesBridgeClient,
      { read: async () => ({ files: [], prompt: 'synthetic fixture' }) } as unknown as ApprovedContextReader,
      { providerProfile: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid', providerEgressAdmissionEnforced: true });
    const iterator = runtime.startRun(run)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'started' });
    expect((await iterator.next()).value).toMatchObject({ type: 'provider.request_started' });
    const proposed = (await iterator.next()).value;
    if (proposed?.type !== 'tool.proposed') throw new Error('Missing fixture proposal');
    await runtime.proposeCommand({ ...proposed.proposal, commandId: 'command-policy' });
    expect((await iterator.next()).value).toMatchObject({ type: 'approval.required', commandId: 'command-policy' });
    const executing = runtime.executePolicyCommand({ runId: run.runId, commandId: 'command-policy', command: 'hermes-terminal', args: ['cat README.md'], cwd: '.', limits: COMMAND_LIMITS });
    const continuing = iterator.next();
    await expect(executing).resolves.toMatchObject({ termination: 'completed' });
    expect(released).toBe(false);
    await runtime.completePolicyCommand({ runId: run.runId, commandId: 'command-policy' });
    expect((await continuing).value).toMatchObject({ type: 'completed' });
    expect(call.mock.calls.some(([operation]) => operation === 'permission')).toBe(false);
    const create = call.mock.calls.find(([operation]) => operation === 'create');
    expect(create).toBeDefined();
    await iterator.return?.();
  });
});
