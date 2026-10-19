import type { IHomePlanningRuntime, HomePlanningProvider } from '@/modules/home-assistant/repositories/home-planning-runtime';
import { AiRunRuntimeUnavailableError } from '@/modules/ai-runs/domain/ai-run-errors';

import { HermesBridgeCallError, HermesBridgeClient } from '@/infrastructure/hermes/hermes-bridge-client';
import {
  HermesHomePlanningRuntime,
  HOME_PLANNING_TOOL_NAMES,
  type HomePlanningToolName
} from '@/infrastructure/hermes/hermes-home-planning-runtime';

const turnId = 'c38135b6-f877-4e9c-899a-4c0e53864854';
const provider: HomePlanningProvider = {
  profile: 'nebius-token-factory',
  model: 'nvidia/nemotron-3-super-120b-a12b',
  endpoint: 'https://api.tokenfactory.nebius.com/v1'
};

function runtimeWith(bridgeCall: jest.Mock, registeredToolNames: readonly HomePlanningToolName[] = []): IHomePlanningRuntime {
  return new HermesHomePlanningRuntime(
    { call: bridgeCall } as unknown as HermesBridgeClient,
    provider,
    { registeredToolNames, providerEgressAdmissionEnforced: true }
  );
}

describe('HermesHomePlanningRuntime', () => {
  it('fails closed before planning-create unless the bridge egress gate is explicitly verified', async () => {
    const call = jest.fn();
    const runtime = new HermesHomePlanningRuntime({ call } as unknown as HermesBridgeClient, provider);

    await expect(runtime.start({ turnId, prompt: 'Plan a synthetic test.', provider }))
      .resolves.toEqual({ outcome: 'unavailable', code: 'PLANNING_RUNTIME_UNAVAILABLE' });
    expect(call).not.toHaveBeenCalled();
  });

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

  it('rejects changed retries, unsupported profiles, and oversized prompts without bridge egress', async () => {
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

  it('normalizes bounded assistant and registered typed Home tool events with ascending cursors', async () => {
    const call = jest.fn()
      .mockResolvedValueOnce({ status: 'preparing' })
      .mockResolvedValueOnce({
        status: 'running', hasMore: false, code: 'PLANNING_RUNTIME_FAILED',
        events: [
          { sequence: 1, type: 'started' },
          { sequence: 2, type: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello.' } } },
          { sequence: 3, type: 'home-tool-request', id: '17', params: { sessionId: 'session-1', name: 'home_list_tasks', args: { limit: 10 } } }
        ]
      });
    const runtime = runtimeWith(call, ['home_list_tasks']);
    await runtime.start({ turnId, prompt: 'Synthetic prompt.', provider });

    await expect(runtime.poll({ turnId, cursor: 0 })).resolves.toEqual({
      status: 'running',
      events: [
        { sequence: 2, type: 'assistant.delta', text: 'Hello.' },
        { sequence: 3, type: 'home.tool.requested', requestId: '17', sessionId: 'session-1', name: 'home_list_tasks', args: { limit: 10 } }
      ],
      nextCursor: 3,
      hasMore: false,
      code: 'PLANNING_RUNTIME_FAILED'
    });
  });

  it('defaults to deny-all, bounds registration to the fixed twelve names, and rejects unregistered events', async () => {
    expect(HOME_PLANNING_TOOL_NAMES).toHaveLength(12);
    expect(() => new HermesHomePlanningRuntime(
      {} as HermesBridgeClient,
      provider,
      { registeredToolNames: ['terminal'] as never }
    )).toThrow(TypeError);

    const makeCall = () => jest.fn()
      .mockResolvedValueOnce({ status: 'preparing' })
      .mockResolvedValueOnce({ status: 'running', hasMore: false, events: [{
        sequence: 1, type: 'home-tool-request', id: '17',
        params: { sessionId: 'session-1', name: 'home_list_tasks', args: { limit: 10 } }
      }] });
    const denied = runtimeWith(makeCall());
    await denied.start({ turnId, prompt: 'Synthetic prompt.', provider });
    await expect(denied.poll({ turnId, cursor: 0 })).resolves.toMatchObject({ status: 'unknown', events: [] });

    const enabled = runtimeWith(makeCall(), ['home_list_tasks']);
    const enabledTurnId = 'a02c3482-76b2-41f8-82b8-8879ef27c460';
    await enabled.start({ turnId: enabledTurnId, prompt: 'Synthetic prompt.', provider });
    await expect(enabled.poll({ turnId: enabledTurnId, cursor: 0 }))
      .resolves.toMatchObject({ status: 'running', events: [{ name: 'home_list_tasks', args: { limit: 10 } }] });

    const wrongNameCall = jest.fn()
      .mockResolvedValueOnce({ status: 'preparing' })
      .mockResolvedValueOnce({ status: 'running', hasMore: false, events: [{
        sequence: 1, type: 'home-tool-request', id: '18',
        params: { sessionId: 'session-1', name: 'home_get_task', args: { taskId: 'x' } }
      }] });
    const onlyList = runtimeWith(wrongNameCall, ['home_list_tasks']);
    const otherTurnId = 'b4bef17e-e3fc-4d0c-a3e8-a48f71091a42';
    await onlyList.start({ turnId: otherTurnId, prompt: 'Synthetic prompt.', provider });
    await expect(onlyList.poll({ turnId: otherTurnId, cursor: 0 })).resolves.toMatchObject({ status: 'unknown', events: [] });
  });

  it('maps malformed or oversized event pages to unknown without exposing raw content', async () => {
    const call = jest.fn()
      .mockResolvedValueOnce({ status: 'preparing' })
      .mockResolvedValueOnce({ status: 'running', hasMore: false, events: [{ sequence: 1, type: 'home-tool-request', id: '1', params: { sessionId: 's', name: 'terminal', args: {} } }] });
    const runtime = runtimeWith(call, ['home_list_tasks']);
    await runtime.start({ turnId, prompt: 'Synthetic prompt.', provider });
    await expect(runtime.poll({ turnId, cursor: 0 })).resolves.toMatchObject({ status: 'unknown', events: [], code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' });
  });

  it('sends bounded typed results and keeps denial content-free', async () => {
    const call = jest.fn().mockResolvedValueOnce({ status: 'preparing' }).mockResolvedValue({ accepted: true });
    const runtime = runtimeWith(call);
    await runtime.start({ turnId, prompt: 'Synthetic prompt.', provider });

    await expect(runtime.sendToolResult({ turnId, requestId: '17', result: { outcome: 'shared', data: { items: [], nextCursor: null } } }))
      .resolves.toEqual({ accepted: true });
    await expect(runtime.sendToolResult({ turnId, requestId: '18', result: { outcome: 'denied', code: 'CONSENT_DENIED' } }))
      .resolves.toEqual({ accepted: true });
    await expect(runtime.sendToolResult({ turnId, requestId: '19', result: { outcome: 'conflict', code: 'VERSION_CONFLICT' } }))
      .resolves.toEqual({ accepted: true });
    expect(call.mock.calls[1][0]).toBe('planning-home-tool-result');
    expect(call.mock.calls[2][3]).toEqual({ requestId: '18', result: { outcome: 'denied', code: 'CONSENT_DENIED' } });
    expect(call.mock.calls[3][3]).toEqual({ requestId: '19', result: { outcome: 'conflict', code: 'VERSION_CONFLICT' } });
    await expect(runtime.sendToolResult({ turnId, requestId: '20', result: { outcome: 'shared', data: { value: 'x'.repeat(256 * 1024) } } }))
      .rejects.toBeInstanceOf(AiRunRuntimeUnavailableError);
    await expect(runtime.sendToolResult({ turnId, requestId: '21', result: { outcome: 'conflict', code: 'OTHER', data: { secret: true } } as never }))
      .rejects.toBeInstanceOf(AiRunRuntimeUnavailableError);
    await expect(runtime.sendToolResult({ turnId, requestId: '22', result: { outcome: 'denied', code: 'CONSENT_DENIED', data: { secret: true } } as never }))
      .rejects.toBeInstanceOf(AiRunRuntimeUnavailableError);
    expect(call).toHaveBeenCalledTimes(4);
  });

  it('confirms cancellation only when the bridge does and rejects results after cancellation', async () => {
    const call = jest.fn().mockResolvedValueOnce({ status: 'preparing' }).mockResolvedValueOnce({ outcome: 'confirmed' });
    const runtime = runtimeWith(call);
    await runtime.start({ turnId, prompt: 'Synthetic prompt.', provider });
    await expect(runtime.cancel(turnId)).resolves.toEqual({ outcome: 'confirmed' });
    await expect(runtime.sendToolResult({ turnId, requestId: '17', result: { outcome: 'denied', code: 'CONSENT_DENIED' } }))
      .rejects.toBeInstanceOf(AiRunRuntimeUnavailableError);
  });

  it('keeps cancellation unknown when unconfirmed and makes delete idempotent for absent runs', async () => {
    const call = jest.fn().mockResolvedValueOnce({ status: 'preparing' }).mockResolvedValueOnce({ outcome: 'unknown' });
    const runtime = runtimeWith(call);
    await runtime.start({ turnId, prompt: 'Synthetic prompt.', provider });
    await expect(runtime.cancel(turnId)).resolves.toEqual({ outcome: 'unknown' });
    await expect(runtime.delete('f5e0b769-2c75-4c0b-9c48-ae93f993c987')).resolves.toBeUndefined();
  });
});
