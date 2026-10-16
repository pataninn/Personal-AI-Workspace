import type { IHomePlanningRuntime, HomePlanningProvider } from '@/modules/home-assistant/repositories/home-planning-runtime';
import { AiRunRuntimeUnavailableError } from '@/modules/ai-runs/domain/ai-run-errors';

import { HermesBridgeCallError, HermesBridgeClient } from '@/infrastructure/hermes/hermes-bridge-client';
import { HermesHomePlanningRuntime } from '@/infrastructure/hermes/hermes-home-planning-runtime';

const turnId = 'c38135b6-f877-4e9c-899a-4c0e53864854';
const provider: HomePlanningProvider = {
  profile: 'nebius-token-factory',
  model: 'nvidia/nemotron-3-super-120b-a12b',
  endpoint: 'https://api.tokenfactory.nebius.com/v1'
};

function runtimeWith(bridgeCall: jest.Mock, enableSyntheticFixture = false): IHomePlanningRuntime {
  return new HermesHomePlanningRuntime(
    { call: bridgeCall } as unknown as HermesBridgeClient,
    provider,
    { testOnlyEnableSyntheticFixture: enableSyntheticFixture }
  );
}

describe('HermesHomePlanningRuntime', () => {
  it('accepts a bounded planning create once with only prompt and configured provider metadata', async () => {
    const call = jest.fn().mockResolvedValue({ status: 'preparing' });
    const runtime = runtimeWith(call);

    await expect(runtime.start({ turnId, prompt: 'Plan a synthetic test.', provider })).resolves.toEqual({ outcome: 'accepted' });
    await expect(runtime.start({ turnId, prompt: 'Plan a synthetic test.', provider })).resolves.toEqual({ outcome: 'accepted' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]).toEqual([
      'planning-create', turnId, expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      { prompt: 'Plan a synthetic test.', providerProfile: provider.profile, model: provider.model, endpoint: provider.endpoint }
    ]);
  });

  it('rejects a changed retry, unsupported profile, or oversized prompt without bridge egress', async () => {
    const call = jest.fn().mockResolvedValue({ status: 'preparing' });
    const runtime = runtimeWith(call);
    const initial = { turnId, prompt: 'First prompt.', provider };

    await expect(runtime.start(initial)).resolves.toEqual({ outcome: 'accepted' });
    await expect(runtime.start({ ...initial, prompt: 'Changed prompt.' })).resolves.toEqual({ outcome: 'unavailable', code: 'PLANNING_RUNTIME_UNAVAILABLE' });
    await expect(runtime.start({ turnId: 'a02c3482-76b2-41f8-82b8-8879ef27c460', prompt: 'x', provider: { ...provider, endpoint: 'https://other.example/v1' } }))
      .resolves.toEqual({ outcome: 'unavailable', code: 'PLANNING_RUNTIME_UNAVAILABLE' });
    await expect(runtime.start({ turnId: 'b4bef17e-e3fc-4d0c-a3e8-a48f71091a42', prompt: 'x'.repeat(256 * 1024 + 1), provider }))
      .resolves.toEqual({ outcome: 'unavailable', code: 'PLANNING_RUNTIME_UNAVAILABLE' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a definite bridge rejection from uncertain create acceptance', async () => {
    const rejected = runtimeWith(jest.fn().mockRejectedValue(new HermesBridgeCallError('rejected')));
    await expect(rejected.start({ turnId, prompt: 'Synthetic prompt.', provider })).resolves.toEqual({ outcome: 'unavailable', code: 'PLANNING_RUNTIME_UNAVAILABLE' });

    const uncertain = runtimeWith(jest.fn().mockRejectedValue(new HermesBridgeCallError('unknown')));
    await expect(uncertain.start({ turnId, prompt: 'Synthetic prompt.', provider })).resolves.toEqual({ outcome: 'unknown', code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' });
    await expect(uncertain.poll({ turnId, cursor: 0 })).resolves.toMatchObject({ status: 'unknown' });
  });

  it('normalizes bounded assistant and typed Home tool events with ascending cursors', async () => {
    const call = jest.fn()
      .mockResolvedValueOnce({ status: 'preparing' })
      .mockResolvedValueOnce({
        status: 'running', hasMore: false, code: 'PLANNING_RUNTIME_FAILED',
        events: [
          { sequence: 1, type: 'started' },
          { sequence: 2, type: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello.' } } },
          { sequence: 3, type: 'home-tool-request', id: '17', params: { sessionId: 'session-1', name: 'planning_fixture_read', args: {} } }
        ]
      });
    const runtime = runtimeWith(call, true);
    await runtime.start({ turnId, prompt: 'Synthetic prompt.', provider });

    await expect(runtime.poll({ turnId, cursor: 0 })).resolves.toEqual({
      status: 'running',
      events: [
        { sequence: 2, type: 'assistant.delta', text: 'Hello.' },
        { sequence: 3, type: 'home.tool.requested', requestId: '17', sessionId: 'session-1', name: 'planning_fixture_read', args: {} }
      ],
      nextCursor: 3,
      hasMore: false,
      code: 'PLANNING_RUNTIME_FAILED'
    });
  });

  it('maps malformed or oversized event pages to unknown without exposing raw content', async () => {
    const call = jest.fn()
      .mockResolvedValueOnce({ status: 'preparing' })
      .mockResolvedValueOnce({ status: 'running', hasMore: false, events: [{ sequence: 1, type: 'home-tool-request', id: '1', params: { sessionId: 's', name: 'terminal', args: {} } }] });
    const runtime = runtimeWith(call);
    await runtime.start({ turnId, prompt: 'Synthetic prompt.', provider });
    await expect(runtime.poll({ turnId, cursor: 0 })).resolves.toMatchObject({ status: 'unknown', events: [], code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' });
  });

  it('keeps the synthetic fixture disabled unless a server-side test explicitly enables it', async () => {
    const call = jest.fn()
      .mockResolvedValueOnce({ status: 'preparing' })
      .mockResolvedValueOnce({ status: 'running', hasMore: false, events: [{
        sequence: 1, type: 'home-tool-request', id: '17',
        params: { sessionId: 'session-1', name: 'planning_fixture_read', args: {} }
      }] });
    const runtime = runtimeWith(call);
    await runtime.start({ turnId, prompt: 'Synthetic prompt.', provider });

    await expect(runtime.poll({ turnId, cursor: 0 })).resolves.toMatchObject({
      status: 'unknown', events: [], code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN'
    });
  });

  it('sends only bounded typed results and keeps denial content-free', async () => {
    const call = jest.fn().mockResolvedValueOnce({ status: 'preparing' }).mockResolvedValue({ accepted: true });
    const runtime = runtimeWith(call);
    await runtime.start({ turnId, prompt: 'Synthetic prompt.', provider });

    await expect(runtime.sendToolResult({ turnId, requestId: '17', result: { outcome: 'shared', data: { fixture: 'synthetic-read-only' } } }))
      .resolves.toEqual({ accepted: true });
    await expect(runtime.sendToolResult({ turnId, requestId: '18', result: { outcome: 'denied', code: 'CONSENT_DENIED' } }))
      .resolves.toEqual({ accepted: true });
    expect(call.mock.calls[1][0]).toBe('planning-home-tool-result');
    expect(call.mock.calls[2][3]).toEqual({ requestId: '18', result: { outcome: 'denied', code: 'CONSENT_DENIED' } });
    await expect(runtime.sendToolResult({ turnId, requestId: '19', result: { outcome: 'shared', data: { value: 'x'.repeat(256 * 1024) } } }))
      .rejects.toBeInstanceOf(AiRunRuntimeUnavailableError);
    await expect(runtime.sendToolResult({ turnId, requestId: '20', result: { outcome: 'denied', code: 'CONSENT_DENIED', data: { secret: true } } as never }))
      .rejects.toBeInstanceOf(AiRunRuntimeUnavailableError);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('confirms cancellation only when the bridge does and rejects results after cancellation', async () => {
    const call = jest.fn().mockResolvedValueOnce({ status: 'preparing' }).mockResolvedValueOnce({ outcome: 'confirmed' });
    const runtime = runtimeWith(call);
    await runtime.start({ turnId, prompt: 'Synthetic prompt.', provider });
    await expect(runtime.cancel(turnId)).resolves.toEqual({ outcome: 'confirmed' });
    await expect(runtime.sendToolResult({ turnId, requestId: '17', result: { outcome: 'denied', code: 'CONSENT_DENIED' } }))
      .rejects.toBeInstanceOf(AiRunRuntimeUnavailableError);
  });

  it('keeps cancellation unknown when the bridge does not confirm and makes delete idempotent for absent runs', async () => {
    const call = jest.fn().mockResolvedValueOnce({ status: 'preparing' }).mockResolvedValueOnce({ outcome: 'unknown' });
    const runtime = runtimeWith(call);
    await runtime.start({ turnId, prompt: 'Synthetic prompt.', provider });
    await expect(runtime.cancel(turnId)).resolves.toEqual({ outcome: 'unknown' });
    await expect(runtime.delete('f5e0b769-2c75-4c0b-9c48-ae93f993c987')).resolves.toBeUndefined();
  });
});
