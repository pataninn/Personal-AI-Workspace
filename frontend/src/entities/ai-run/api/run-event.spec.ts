import { describe, expect, it } from 'vitest';

import { parseAiRunEvent } from '@/entities/ai-run/api/run-event';

const snapshot = {
  runId: '77777777-7777-4777-8777-000000000001',
  projectId: '11111111-1111-4111-8111-111111111111',
  conversationId: '44444444-4444-4444-8444-000000000001',
  status: 'running',
  phase: 'inference',
  manifestHash: 'a'.repeat(64),
  decision: 'approved',
  safeMessage: 'Assistant is working.',
  cleanup: 'not_started',
  providerTransmission: 'not_started_confirmed',
  stagingItemCount: 0,
  runtime: { kind: 'fake', sandboxReady: true }
};

describe('parseAiRunEvent', () => {
  it('keeps only bounded safe event fields and accepts a complete snapshot', () => {
    const event = parseAiRunEvent(JSON.stringify({ runId: snapshot.runId, type: 'run.snapshot', sequence: 1, payload: snapshot }));

    expect(event?.payload).toMatchObject({ runId: snapshot.runId, status: 'running', phase: 'inference', runtime: { kind: 'fake', sandboxReady: true } });
  });

  it('truncates oversized deltas and rejects malformed or unknown events', () => {
    const event = parseAiRunEvent(JSON.stringify({ runId: snapshot.runId, type: 'assistant.delta', sequence: 2, payload: { text: 'x'.repeat(20_000), secret: 'do not expose' } }));

    expect(event?.payload.text).toHaveLength(4096);
    expect(event?.payload).not.toHaveProperty('secret');
    expect(parseAiRunEvent('{bad')).toBeNull();
    expect(parseAiRunEvent(JSON.stringify({ runId: snapshot.runId, type: 'internal.error', sequence: 3, payload: {} }))).toBeNull();
  });
});
