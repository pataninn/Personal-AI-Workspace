import { AiRunRuntimeUnavailableError } from '@/modules/ai-runs/domain/ai-run-errors';
import type { RuntimeRunInput } from '@/modules/ai-runs/repositories/agent-runtime';
import { ApprovedContextReader } from '@/infrastructure/hermes/approved-context-reader';
import { HermesBridgeClient } from '@/infrastructure/hermes/hermes-bridge-client';
import { HermesAgentRuntime } from '@/infrastructure/hermes/hermes-agent-runtime';

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
