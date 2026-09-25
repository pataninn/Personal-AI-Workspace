import type { ModelProviderRequest } from '@/modules/ai-runs/repositories/model-provider';
import { NvidiaHostedNimProvider } from '@/infrastructure/ai-provider/nvidia-hosted-nim-provider';

const request: ModelProviderRequest = {
  runId: 'run-1',
  request: 'Inspect the project.',
  manifest: {
    manifestHash: 'a'.repeat(64),
    provider: 'NVIDIA hosted NIM',
    providerProfile: 'nvidia-hosted-nim',
    model: 'nvidia/nemotron-3-super-120b-a12b',
    categories: ['Request'],
    files: [],
    requestBytes: 20,
    messageBytes: 0,
    messageCount: 0,
    messageHash: 'b'.repeat(64),
    byteEstimate: 20,
    tokenEstimate: 5,
    excludedItemCount: 0,
    omittedItemCount: 0,
    omissionSummary: 'No selected items were excluded or omitted.',
    bestEffortSecretDetection: true
  },
  files: [],
  messages: []
};

describe('NvidiaHostedNimProvider', () => {
  it('sends the OpenAI-compatible request to the fixed chat completions endpoint and parses structured output', async () => {
    const fetchImplementation = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key', Accept: 'text/event-stream' });
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        stream: boolean;
        messages: readonly unknown[];
        temperature: number;
        top_p: number;
        max_tokens: number;
        reasoning_effort: string;
        chat_template_kwargs: { force_nonempty_content: boolean };
      };
      expect(body.model).toBe('nvidia/nemotron-3-super-120b-a12b');
      expect(body.stream).toBe(true);
      expect(body.messages.length).toBeGreaterThan(0);
      expect(body.temperature).toBe(1);
      expect(body.top_p).toBe(0.95);
      expect(body.max_tokens).toBe(4096);
      expect(body.reasoning_effort).toBe('none');
      expect(body.chat_template_kwargs.force_nonempty_content).toBe(true);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ message: 'Done', changes: [] }) } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    const provider = new NvidiaHostedNimProvider({ endpoint: 'https://example.test/v1', model: request.manifest.model, apiKey: 'test-key', fetchImplementation });

    const events = await collect(provider.stream(request));

    expect(fetchImplementation).toHaveBeenCalledWith('https://example.test/v1/chat/completions', expect.any(Object));
    expect(events).toEqual([
      { type: 'started' },
      { type: 'provider.request_started' },
      { type: 'provider.response_received' },
      { type: 'assistant.message.completed', text: 'Done' },
      { type: 'completed', text: 'Done' }
    ]);
  });

  it('maps streamed deltas and cancellation without exposing provider errors', async () => {
    const fetchImplementation = jest.fn(async (): Promise<Response> => new Response(
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    ));
    const provider = new NvidiaHostedNimProvider({ endpoint: 'https://example.test/v1', model: request.manifest.model, apiKey: 'test-key', fetchImplementation });

    const events = await collect(provider.stream(request));

    expect(events).toEqual([
      { type: 'started' },
      { type: 'provider.request_started' },
      { type: 'provider.response_received' },
      { type: 'assistant.delta', text: 'hello' },
      { type: 'assistant.delta', text: ' world' },
      { type: 'assistant.message.completed', text: 'hello world' },
      { type: 'completed', text: 'hello world' }
    ]);
  });

  it('fails closed when the provider rejects a request', async () => {
    const fetchImplementation = jest.fn(async (): Promise<Response> => new Response('provider detail with secret', { status: 422 }));
    const provider = new NvidiaHostedNimProvider({ endpoint: 'https://example.test/v1', model: request.manifest.model, apiKey: 'test-key', fetchImplementation });

    await expect(collect(provider.stream(request))).resolves.toEqual([
      { type: 'started' },
      { type: 'provider.request_started' },
      { type: 'provider.response_received' },
      { type: 'failed', message: 'The NVIDIA provider rejected the request.' }
    ]);
  });

  it('redacts secret-bearing streamed text before publishing deltas', async () => {
    const fetchImplementation = jest.fn(async (): Promise<Response> => new Response(
      'data: {"choices":[{"delta":{"content":"token=super-secret"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    ));
    const provider = new NvidiaHostedNimProvider({ endpoint: 'https://example.test/v1', model: request.manifest.model, apiKey: 'test-key', fetchImplementation });

    const events = await collect(provider.stream(request));

    expect(events).toEqual(expect.arrayContaining([
      { type: 'assistant.delta', text: 'token=[REDACTED]' },
      { type: 'assistant.message.completed', text: 'token=[REDACTED]' }
    ]));
    expect(JSON.stringify(events)).not.toContain('super-secret');
  });

  it('keeps a credential split across provider chunks out of published deltas', async () => {
    const fetchImplementation = jest.fn(async (): Promise<Response> => new Response(
      'data: {"choices":[{"delta":{"content":"token="}}]}\n\ndata: {"choices":[{"delta":{"content":"split-secret"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    ));
    const provider = new NvidiaHostedNimProvider({ endpoint: 'https://example.test/v1', model: request.manifest.model, apiKey: 'test-key', fetchImplementation });

    const events = await collect(provider.stream(request));

    expect(JSON.stringify(events)).not.toContain('split-secret');
    expect(events).toEqual(expect.arrayContaining([
      { type: 'assistant.delta', text: 'token=[REDACTED]' },
      { type: 'assistant.message.completed', text: 'token=[REDACTED]' }
    ]));
  });

  it('fails a completed SSE response that never sends the terminal marker', async () => {
    const fetchImplementation = jest.fn(async (): Promise<Response> => new Response(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    ));
    const provider = new NvidiaHostedNimProvider({ endpoint: 'https://example.test/v1', model: request.manifest.model, apiKey: 'test-key', fetchImplementation });

    await expect(collect(provider.stream(request))).resolves.toEqual([
      { type: 'started' },
      { type: 'provider.request_started' },
      { type: 'provider.response_received' },
      { type: 'failed', message: 'The NVIDIA provider returned an invalid response.' }
    ]);
  });

  it('fails malformed SSE data instead of silently accepting a partial output', async () => {
    const fetchImplementation = jest.fn(async (): Promise<Response> => new Response(
      'data: not-json\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    ));
    const provider = new NvidiaHostedNimProvider({ endpoint: 'https://example.test/v1', model: request.manifest.model, apiKey: 'test-key', fetchImplementation });

    await expect(collect(provider.stream(request))).resolves.toEqual([
      { type: 'started' },
      { type: 'provider.request_started' },
      { type: 'provider.response_received' },
      { type: 'failed', message: 'The NVIDIA provider returned an invalid response.' }
    ]);
  });

  it('requires manual review for an in-band provider error after HTTP 200', async () => {
    const fetchImplementation = jest.fn(async (): Promise<Response> => new Response(
      'data: {"error":{"message":"temporary unavailable"}}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    ));
    const provider = new NvidiaHostedNimProvider({ endpoint: 'https://example.test/v1', model: request.manifest.model, apiKey: 'test-key', fetchImplementation });

    const events = await collect(provider.stream(request));

    expect(events).toEqual([
      { type: 'started' },
      { type: 'provider.request_started' },
      { type: 'provider.response_received' },
      { type: 'needs_manual_review', message: 'The configured NVIDIA provider is unavailable.' }
    ]);
  });

  it('requires review when transport outcome is uncertain', async () => {
    const fetchImplementation = jest.fn(async (): Promise<Response> => {
      throw new Error('network failure');
    });
    const provider = new NvidiaHostedNimProvider({ endpoint: 'https://example.test/v1', model: request.manifest.model, apiKey: 'test-key', fetchImplementation });

    await expect(collect(provider.stream(request))).resolves.toEqual([
      { type: 'started' },
      { type: 'provider.request_started' },
      { type: 'needs_manual_review', message: 'The configured NVIDIA provider is unavailable.' }
    ]);
  });
});

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}
