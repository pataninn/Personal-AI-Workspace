import type { Message, MessagePage } from '@/modules/conversations/domain/conversation-types';
import type { IConversationRepository } from '@/modules/conversations/repositories/conversation-repository';
import type { AiRun, EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';
import { InMemoryAiRunRepository } from '@/infrastructure/ai-runs/in-memory-ai-run-repository';
import { InMemoryRunEventPublisher } from '@/infrastructure/ai-runs/in-memory-run-event-publisher';
import { FakeAgentRuntime } from '@/infrastructure/sandbox/fake-agent-runtime';
import { CancelAiRunUseCase } from '@/modules/ai-runs/use-cases/cancel-ai-run-use-case';
import { StartAiRunUseCase, type RuntimeCommandProposalPort } from '@/modules/ai-runs/use-cases/start-ai-run-use-case';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

function manifest(): EgressManifest {
  return {
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
  };
}

function conversationRepository(): IConversationRepository & { readonly assistantMessages: Message[] } {
  const now = new Date('2026-09-16T00:00:00.000Z');
  const assistantMessages: Message[] = [];
  return {
    assistantMessages,
    listByProjectForOwner: jest.fn(),
    findWithMessagesForOwner: jest.fn(async (): Promise<MessagePage> => ({
      conversation: { id: CONVERSATION_ID, ownerId: OWNER_ID, projectId: PROJECT_ID, title: 'Chat', status: 'active', lastActivityAt: now, createdAt: now, updatedAt: now },
      messages: [],
      nextBeforeSequence: null
    })),
    create: jest.fn(),
    addUserMessage: jest.fn(),
    addAssistantMessage: jest.fn(async (input) => {
      const message: Message = { id: `assistant-${assistantMessages.length + 1}`, conversationId: input.conversationId, role: 'assistant', sequence: assistantMessages.length + 1, content: input.content, createdAt: now };
      assistantMessages.push(message);
      return { resource: message, replayed: false };
    })
  };
}

async function readyRun(repository: InMemoryAiRunRepository): Promise<AiRun> {
  const created = await repository.create({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Inspect the project', relativeRoot: '', requestedPaths: [], manifest: manifest(), idempotencyKey: 'create-run-3-3', requestFingerprint: 'fingerprint' });
  const ready: AiRun = { ...created.resource, status: 'ready', phase: 'runtime', decision: 'approved', runtimeKind: 'fake', sandboxReady: true, runtimeReference: 'fake://staging/run', safeMessage: 'Private run environment ready.', updatedAt: new Date() };
  await repository.save(ready);
  return ready;
}

async function waitForStatus(repository: InMemoryAiRunRepository, runId: string, status: AiRun['status']): Promise<AiRun> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await repository.findByIdForOwner(OWNER_ID, runId);
    if (run?.status === status) {
      return run;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Run did not reach ${status}.`);
}

describe('StartAiRunUseCase', () => {
  it('starts one fake run per idempotency key and persists the bounded assistant result', async () => {
    const repository = new InMemoryAiRunRepository();
    const conversations = conversationRepository();
    const runtime = new FakeAgentRuntime();
    runtime.runOptions = { response: 'Answer with password=super-secret and a safe conclusion.', deltaSize: 9 };
    const events = new InMemoryRunEventPublisher();
    const received: string[] = [];
    events.subscribe('run-id-is-not-known-yet', (event) => { received.push(event.type); });
    const run = await readyRun(repository);
    events.subscribe(run.id, (event) => { received.push(event.type); });
    const start = new StartAiRunUseCase(repository, conversations, runtime, events);

    const first = await start.execute({ ownerId: OWNER_ID, runId: run.id, idempotencyKey: 'start-run-3-3' });
    const replay = await start.execute({ ownerId: OWNER_ID, runId: run.id, idempotencyKey: 'start-run-3-3' });
    const completed = await waitForStatus(repository, run.id, 'succeeded');

    expect(first.resource.status).toBe('queued');
    expect(replay.replayed).toBe(true);
    expect(runtime.startedRuns).toHaveLength(1);
    expect(completed.assistantComplete).toBe(true);
    expect(completed.assistantMessageId).toBe('assistant-1');
    expect(conversations.assistantMessages[0]?.content).toContain('[REDACTED]');
    expect(conversations.assistantMessages[0]?.content).not.toContain('super-secret');
    expect(received).toEqual(expect.arrayContaining(['run.status_changed', 'run.started', 'assistant.delta', 'run.completed']));
  });

  it('wins the cancellation race and never overwrites a cancelled run with a late result', async () => {
    const repository = new InMemoryAiRunRepository();
    const conversations = conversationRepository();
    const runtime = new FakeAgentRuntime();
    runtime.runOptions = { response: 'A long response', delayMs: 10 };
    const events = new InMemoryRunEventPublisher();
    const run = await readyRun(repository);
    const start = new StartAiRunUseCase(repository, conversations, runtime, events);
    const cancel = new CancelAiRunUseCase(repository, runtime, events);

    await start.execute({ ownerId: OWNER_ID, runId: run.id, idempotencyKey: 'start-cancel-3-3' });
    for (let attempt = 0; attempt < 100 && runtime.startedRuns.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    const cancellation = await cancel.execute({ ownerId: OWNER_ID, runId: run.id, idempotencyKey: 'cancel-run-3-3' });
    const cancelled = await waitForStatus(repository, run.id, 'cancelled');

    expect(cancellation.status).toBe('cancelled');
    expect(cancelled.assistantMessageId).toBeUndefined();
    expect(cancelled.status).toBe('cancelled');
  });

  it('does not project late assistant, tool, or approval events after cancellation wins a command proposal fence', async () => {
    const repository = new InMemoryAiRunRepository();
    const conversations = conversationRepository();
    const runtime = new FakeAgentRuntime();
    const run = await readyRun(repository);
    runtime.runOptions = {
      events: [{
        type: 'tool.proposed',
        proposal: { runId: run.id, commandId: 'runtime-command', command: 'echo', args: [], cwd: '' }
      }]
    };
    const events = new InMemoryRunEventPublisher();
    const received: string[] = [];
    events.subscribe(run.id, (event) => { received.push(event.type); });
    type ProposalResult = Awaited<ReturnType<RuntimeCommandProposalPort['execute']>>;
    let resolveProposal: (result: ProposalResult) => void = () => undefined;
    const executeProposal = jest.fn((_input: Parameters<RuntimeCommandProposalPort['execute']>[0]): Promise<ProposalResult> => new Promise((resolve) => {
      resolveProposal = resolve;
    }));
    const commandProposals: RuntimeCommandProposalPort = { execute: executeProposal };
    const start = new StartAiRunUseCase(repository, conversations, runtime, events, commandProposals);
    const cancel = new CancelAiRunUseCase(repository, runtime, events);

    await start.execute({ ownerId: OWNER_ID, runId: run.id, idempotencyKey: 'start-command-cancel-3-3' });
    for (let attempt = 0; attempt < 100 && executeProposal.mock.calls.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    expect(executeProposal).toHaveBeenCalledTimes(1);

    const cancelled = await cancel.execute({ ownerId: OWNER_ID, runId: run.id, idempotencyKey: 'cancel-command-3-3' });
    expect(cancelled.status).toBe('cancelled');
    resolveProposal({ resource: { id: 'late-command', status: 'pending_approval', safeMessage: 'Approve command.' }, replayed: false });
    await waitForStatus(repository, run.id, 'cancelled');

    expect(received).not.toEqual(expect.arrayContaining([
      'assistant.delta',
      'assistant.message.completed',
      'tool.proposed',
      'approval.required',
      'tool.started',
      'tool.completed',
      'tool.failed'
    ]));
  });

  it('surfaces a runtime manual-review event as a durable review_required state', async () => {
    const repository = new InMemoryAiRunRepository();
    const conversations = conversationRepository();
    const runtime = new FakeAgentRuntime();
    runtime.runOptions = { events: [{ type: 'started' }, { type: 'needs_manual_review', message: 'internal runtime detail' }] };
    const events = new InMemoryRunEventPublisher();
    const published: string[] = [];
    const run = await readyRun(repository);
    events.subscribe(run.id, (event) => { published.push(event.type); });
    const start = new StartAiRunUseCase(repository, conversations, runtime, events);

    await start.execute({ ownerId: OWNER_ID, runId: run.id, idempotencyKey: 'start-review-3-3' });
    const reviewed = await waitForStatus(repository, run.id, 'review_required');

    expect(reviewed.safeMessage).toContain('needs review');
    expect(published).toContain('run.needs_manual_review');
    expect(JSON.stringify(published)).not.toContain('internal runtime detail');
  });

  it('records confirmed provider transmission after the provider response is received', async () => {
    const repository = new InMemoryAiRunRepository();
    const conversations = conversationRepository();
    const runtime = new FakeAgentRuntime();
    runtime.runOptions = {
      events: [
        { type: 'started' },
        { type: 'provider.request_started' },
        { type: 'provider.response_received' },
        { type: 'completed', text: 'Provider response' }
      ]
    };
    const events = new InMemoryRunEventPublisher();
    const run = await readyRun(repository);
    const start = new StartAiRunUseCase(repository, conversations, runtime, events);

    await start.execute({ ownerId: OWNER_ID, runId: run.id, idempotencyKey: 'start-transmission-confirmed-3-3' });
    const completed = await waitForStatus(repository, run.id, 'succeeded');

    expect(completed.providerTransmission).toBe('transmitted_confirmed');
  });

  it('requires review when provider transmission starts without a response confirmation', async () => {
    const repository = new InMemoryAiRunRepository();
    const conversations = conversationRepository();
    const runtime = new FakeAgentRuntime();
    runtime.runOptions = {
      events: [
        { type: 'started' },
        { type: 'provider.request_started' },
        { type: 'failed', message: 'safe provider failure' }
      ]
    };
    const events = new InMemoryRunEventPublisher();
    const run = await readyRun(repository);
    const start = new StartAiRunUseCase(repository, conversations, runtime, events);

    await start.execute({ ownerId: OWNER_ID, runId: run.id, idempotencyKey: 'start-transmission-unknown-3-3' });
    const reviewed = await waitForStatus(repository, run.id, 'review_required');

    expect(reviewed.providerTransmission).toBe('unknown');
  });

  it('keeps confirmed transmission when the provider reports an error after HTTP response', async () => {
    const repository = new InMemoryAiRunRepository();
    const conversations = conversationRepository();
    const runtime = new FakeAgentRuntime();
    runtime.runOptions = {
      events: [
        { type: 'started' },
        { type: 'provider.request_started' },
        { type: 'provider.response_received' },
        { type: 'failed', message: 'safe provider failure' }
      ]
    };
    const events = new InMemoryRunEventPublisher();
    const run = await readyRun(repository);
    const start = new StartAiRunUseCase(repository, conversations, runtime, events);

    await start.execute({ ownerId: OWNER_ID, runId: run.id, idempotencyKey: 'start-transmission-error-3-3' });
    const failed = await waitForStatus(repository, run.id, 'failed');

    expect(failed.providerTransmission).toBe('transmitted_confirmed');
  });

  it('turns an oversized assistant delta into an explicit review outcome', async () => {
    const repository = new InMemoryAiRunRepository();
    const conversations = conversationRepository();
    const runtime = new FakeAgentRuntime();
    runtime.runOptions = { response: 'x'.repeat(70 * 1024), deltaSize: 70 * 1024 };
    const events = new InMemoryRunEventPublisher();
    const published: string[] = [];
    const run = await readyRun(repository);
    events.subscribe(run.id, (event) => { published.push(event.type); });
    const start = new StartAiRunUseCase(repository, conversations, runtime, events);

    await start.execute({ ownerId: OWNER_ID, runId: run.id, idempotencyKey: 'start-output-limit-3-3' });
    const reviewed = await waitForStatus(repository, run.id, 'review_required');

    expect(reviewed.assistantComplete).toBe(false);
    expect(reviewed.safeMessage).toContain('64 KiB safety limit');
    expect(published).toContain('run.needs_manual_review');
    expect(conversations.assistantMessages[0]?.content.length).toBeLessThanOrEqual(64 * 1024);
  });
});
