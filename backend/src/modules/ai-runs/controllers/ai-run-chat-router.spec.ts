import http from 'node:http';

import cookieParser from 'cookie-parser';
import express from 'express';

import { InMemoryRunEventPublisher } from '@/infrastructure/ai-runs/in-memory-run-event-publisher';
import type { AiRun } from '@/modules/ai-runs/domain/ai-run-types';
import { createAiRunChatRouter } from '@/modules/ai-runs/controllers/ai-run-chat-router';

const RUN_ID = '77777777-7777-4777-8777-000000000001';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

function run(): AiRun {
  const now = new Date('2026-09-16T00:00:00.000Z');
  return {
    id: RUN_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    conversationId: CONVERSATION_ID,
    request: 'Inspect',
    relativeRoot: '',
    storageKind: 'legacy',
    requestedPaths: [],
    manifest: {
      manifestHash: 'a'.repeat(64),
      provider: 'NVIDIA hosted NIM',
      providerProfile: 'nvidia-hosted-nim',
      model: 'nvidia/nemotron-3-super-120b-a12b',
      categories: ['Request'],
      files: [],
      requestBytes: 7,
      messageBytes: 0,
      messageCount: 0,
      messageHash: 'b'.repeat(64),
      byteEstimate: 7,
      tokenEstimate: 2,
      excludedItemCount: 0,
      omittedItemCount: 0,
      omissionSummary: 'No selected items were excluded.',
      bestEffortSecretDetection: true
    },
    manifestInvalidated: false,
    status: 'running',
    phase: 'inference',
    decision: 'approved',
    cleanup: 'not_started',
    providerTransmission: 'not_started_confirmed',
    stagingItemCount: 0,
    sandboxReady: true,
    safeMessage: 'Assistant is working.',
    createdAt: now,
    updatedAt: now
  };
}

describe('AI run chat SSE setup', () => {
  it('does not subscribe after the request closes while the run lookup is pending', async () => {
    let resolveRun: (value: AiRun) => void = () => undefined;
    const pendingRun = new Promise<AiRun>((resolve) => { resolveRun = resolve; });
    const events = new InMemoryRunEventPublisher();
    const subscribe = jest.spyOn(events, 'subscribe');
    const app = express();
    app.use(cookieParser());
    app.use('/api/v1', createAiRunChatRouter({
      getSession: { execute: jest.fn().mockResolvedValue({ sessionId: 'session', principal: { id: OWNER_ID, displayName: 'Local user' }, csrfToken: 'csrf-token', expiresAt: new Date(Date.now() + 60_000) }) } as never,
      getAiRun: { execute: jest.fn().mockReturnValue(pendingRun) } as never,
      principalAuthorization: { isActive: jest.fn().mockResolvedValue(true) } as never,
      startAiRun: {} as never,
      cancelAiRun: {} as never,
      events,
      appOrigin: 'https://127.0.0.1:8443',
      clearSessionCookie: () => undefined
    }));
    const server = await new Promise<http.Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Test server did not expose a port.');
    }

    const client = http.get({
      hostname: '127.0.0.1',
      port: address.port,
      path: `/api/v1/ai-runs/${RUN_ID}/events`,
      headers: { Cookie: '__Host-pa_session=test' }
    });
    client.on('error', () => undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    client.destroy();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    resolveRun(run());
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(subscribe).not.toHaveBeenCalled();
  });

  it.each(['account disabled', 'connected session revoked'])('stops a live stream before delivering another event after %s', async (revocation) => {
    let accountActive = true;
    let sessionActive = true;
    const events = new InMemoryRunEventPublisher();
    const app = express();
    app.use(cookieParser());
    app.use('/api/v1', createAiRunChatRouter({
      getSession: { execute: jest.fn().mockImplementation(async () => {
        if (!sessionActive) throw new Error('revoked');
        return { sessionId: 'session', principal: { id: OWNER_ID, displayName: 'Local user', accountKind: 'regular', role: 'admin' }, csrfToken: 'csrf-token', expiresAt: new Date(Date.now() + 60_000) };
      }) } as never,
      principalAuthorization: { isActive: jest.fn().mockImplementation(async () => accountActive) } as never,
      getAiRun: { execute: jest.fn().mockResolvedValue(run()) } as never,
      startAiRun: {} as never,
      cancelAiRun: {} as never,
      events,
      appOrigin: 'https://127.0.0.1:8443',
      clearSessionCookie: () => undefined
    }));
    const server = await new Promise<http.Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Test server did not expose a port.');
    }
    let body = '';
    let resolveSnapshot: () => void = () => undefined;
    const snapshotReceived = new Promise<void>((resolve) => { resolveSnapshot = resolve; });
    const client = http.get({
      hostname: '127.0.0.1',
      port: address.port,
      path: `/api/v1/ai-runs/${RUN_ID}/events`,
      headers: { Cookie: '__Host-pa_session=test' }
    });
    client.on('error', () => undefined);
    client.on('response', (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.includes('event: run.snapshot')) resolveSnapshot();
      });
    });
    await Promise.race([snapshotReceived, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
    expect(body).toContain('event: run.snapshot');

    if (revocation === 'account disabled') accountActive = false;
    else sessionActive = false;
    events.publish({ runId: RUN_ID, type: 'assistant.delta', payload: { text: 'private late text' } });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    events.publish({ runId: RUN_ID, type: 'run.completed', payload: { secret: 'late event' } });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(body).not.toContain('assistant.delta');
    expect(body).not.toContain('private late text');
    expect(body).not.toContain('late event');
  });
});
