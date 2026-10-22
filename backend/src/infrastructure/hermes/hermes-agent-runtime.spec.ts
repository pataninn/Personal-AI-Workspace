import { AiRunRuntimeUnavailableError } from '@/modules/ai-runs/domain/ai-run-errors';
import type { RuntimeRunInput } from '@/modules/ai-runs/repositories/agent-runtime';
import { ApprovedContextReader } from '@/infrastructure/hermes/approved-context-reader';
import { HermesBridgeClient } from '@/infrastructure/hermes/hermes-bridge-client';
import { HermesAgentRuntime } from '@/infrastructure/hermes/hermes-agent-runtime';
import { COMMAND_LIMITS } from '@/modules/ai-runs/domain/command-policy';
import { POLICY_COMMAND_VERSION, POLICY_COMMAND_PROFILE_HASH } from '@/infrastructure/hermes/hermes-policy-command';

describe('HermesAgentRuntime credit boundary', () => {
  it('denies availability and project start before bridge or context access until provider egress is metered', async () => {
    const bridgeCall = jest.fn();
    const read = jest.fn();
    const runtime = new HermesAgentRuntime(
      { call: bridgeCall } as unknown as HermesBridgeClient,
      { read } as unknown as ApprovedContextReader,
      {
        providerProfile: 'nvidia-hosted-nim',
        model: 'nvidia/nemotron-3-super-120b-a12b',
        endpoint: 'https://integrate.api.nvidia.com/v1'
      }
    );

    await expect(runtime.checkAvailability()).rejects.toBeInstanceOf(AiRunRuntimeUnavailableError);
    const events: unknown[] = [];
    for await (const event of runtime.startRun({} as RuntimeRunInput)) events.push(event);

    expect(events).toEqual([{
      type: 'failed',
      message: 'The selected inference runtime is unavailable until per-call usage controls are verified.'
    }]);
    expect(read).not.toHaveBeenCalled();
    expect(bridgeCall).not.toHaveBeenCalled();
  });
});

const profile = { providerProfile: 'nebius-token-factory', model: 'nvidia/nemotron-3-super-120b-a12b', endpoint: 'https://api.tokenfactory.nebius.com/v1' };
const input = { runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ownerId: 'owner', manifest: { ...profile }, beforeProviderAttempt: jest.fn() } as unknown as RuntimeRunInput;
const reserve = { operation: 'reserve', callId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', providerProfile: profile.providerProfile, model: profile.model, inputTokenUpperBound: 1024, inputBounderVersion: 'hermes-json-utf8-v1' };

function meteredFixture(malformed = false) {
  const credits = { handle: jest.fn().mockResolvedValue({ outcome: 'reserved', reservationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }), hasAdmittedCall: jest.fn().mockReturnValue(true), markInterrupted: jest.fn(), clearTurn: jest.fn() };
  let polls = 0;
  const call = jest.fn(async (operation: string): Promise<Record<string, unknown>> => {
    if (operation === 'probe') return { ready: true, providerReceiptVersion: 1, maxOutputTokens: 512, profile: { ...profile, hermesVersion: '0.20.6' }, policyCommand: { supported: true, profileVersion: POLICY_COMMAND_VERSION, profileHash: POLICY_COMMAND_PROFILE_HASH, limits: COMMAND_LIMITS, unavailableReasons: [] } };
    if (operation === 'poll') return polls++ === 0 ? { status: 'running', events: [{ sequence: 1, type: 'home-provider-credit-request', id: 'receipt_1', params: { request: malformed ? { ...reserve, inputTokenUpperBound: -1 } : reserve } }] } : { status: 'completed', events: [] };
    if (operation === 'files') return { files: [] };
    return { accepted: true };
  });
  const runtime = new HermesAgentRuntime({ call } as unknown as HermesBridgeClient, { read: async () => ({ files: [], prompt: 'Reply READY' }) } as unknown as ApprovedContextReader, { ...profile, providerEgressAdmissionEnforced: true, maxOutputTokens: 512, providerCredits: credits });
  return { runtime, call, credits };
}

describe('metered workspace Hermes', () => {
  it('advertises readiness only for the configured route with verified receipt and command capabilities', async () => {
    const { runtime } = meteredFixture();
    await expect(runtime.supportsPolicyExecution(profile)).resolves.toBe(true);
    await expect(runtime.supportsPolicyExecution({ ...profile, model: 'other' })).resolves.toBe(false);
  });

  it('rechecks policy before reserve, returns admission to the bridge, and reconciles terminal calls', async () => {
    const { runtime, call, credits } = meteredFixture();
    const events = [];
    for await (const event of runtime.startRun(input)) events.push(event);
    expect(input.beforeProviderAttempt).toHaveBeenCalledTimes(1);
    expect(credits.handle).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner', turnId: input.runId, request: reserve }));
    expect(call).toHaveBeenCalledWith('provider-credit-result', input.runId, expect.any(String), { requestId: 'receipt_1', result: { outcome: 'reserved', reservationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } });
    expect(events.at(-1)).toMatchObject({ type: 'completed' });
    expect(credits.markInterrupted).toHaveBeenCalledWith('owner', input.runId);
    expect(credits.clearTurn).toHaveBeenCalledWith(input.runId);
  });

  it('rejects malformed requests without admission or provider continuation', async () => {
    const { runtime, credits, call } = meteredFixture(true);
    const events = [];
    for await (const event of runtime.startRun(input)) events.push(event);
    expect(credits.handle).not.toHaveBeenCalled();
    expect(call.mock.calls.some(([operation]) => operation === 'provider-credit-result')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'needs_manual_review' });
  });

  it('keeps workspace chat unavailable when the bridge lacks provider receipts', async () => {
    const { runtime, call } = meteredFixture();
    call.mockResolvedValue({ ready: true, profile: { ...profile, hermesVersion: '0.20.6' } });
    await expect(runtime.supportsPolicyExecution(profile)).resolves.toBe(false);
  });
});
