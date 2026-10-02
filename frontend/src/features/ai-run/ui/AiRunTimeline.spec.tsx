import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiRunSnapshot } from '@/entities/ai-run';
import type { ConversationHistoryResponse } from '@/entities/conversation';
import { AiRunTimeline } from '@/features/ai-run/ui/AiRunTimeline';
import { useAiRunTimeline } from '@/features/ai-run/model/use-ai-run-timeline';

const { startAiRunMock, cancelAiRunMock, getAiRunMock, getConversationMock, eventsUrlMock } = vi.hoisted(() => ({
  startAiRunMock: vi.fn(),
  cancelAiRunMock: vi.fn(),
  getAiRunMock: vi.fn(),
  getConversationMock: vi.fn(),
  eventsUrlMock: vi.fn((runId: string) => `/api/v1/ai-runs/${runId}/events`)
}));

vi.mock('@/entities/ai-run/api/ai-run-api', () => ({
  startAiRun: startAiRunMock,
  cancelAiRun: cancelAiRunMock,
  getAiRun: getAiRunMock,
  aiRunEventsUrl: eventsUrlMock
}));

vi.mock('@/entities/conversation/api/conversation-api', () => ({
  getConversation: getConversationMock
}));

type EventListener = (event: Event | MessageEvent) => void;

class ControlledEventSource {
  public static readonly instances: ControlledEventSource[] = [];
  public readonly listeners = new Map<string, Set<EventListener>>();
  public closed = false;

  public constructor(public readonly url: string) {
    ControlledEventSource.instances.push(this);
  }

  public addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  public close(): void {
    this.closed = true;
  }

  public emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }));
    }
  }

  public emitError(): void {
    for (const listener of this.listeners.get('error') ?? []) {
      listener(new Event('error'));
    }
  }
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-000000000001';
const RUN_ID = '77777777-7777-4777-8777-000000000001';
const HASH = 'a'.repeat(64);

const ready: AiRunSnapshot = {
  runId: RUN_ID,
  projectId: PROJECT_ID,
  conversationId: CONVERSATION_ID,
  status: 'ready',
  phase: 'runtime',
  manifestHash: HASH,
  decision: 'approved',
  safeMessage: 'Private run environment ready.',
  cleanup: 'complete',
  providerTransmission: 'not_started_confirmed',
  stagingItemCount: 0,
  runtime: { kind: 'fake', sandboxReady: true }
};

const running: AiRunSnapshot = { ...ready, status: 'running', phase: 'inference', safeMessage: 'Assistant is working.' };
const succeeded: AiRunSnapshot = {
  ...ready,
  status: 'succeeded',
  phase: 'terminal',
  safeMessage: 'Assistant response complete.',
  assistant: { messageId: 'assistant-current', complete: true, contentLength: 18 }
};

const priorAssistant = {
  id: 'assistant-prior',
  conversationId: CONVERSATION_ID,
  role: 'assistant' as const,
  sequence: 2,
  content: 'An older run answer.',
  createdAt: '2026-09-16T00:00:02.000Z'
};
const currentAssistant = {
  id: 'assistant-current',
  conversationId: CONVERSATION_ID,
  role: 'assistant' as const,
  sequence: 4,
  content: 'The current run answer.',
  createdAt: '2026-09-16T00:00:04.000Z'
};
const history: ConversationHistoryResponse = {
  conversation: {
    id: CONVERSATION_ID,
    projectId: PROJECT_ID,
    title: 'Chat',
    status: 'active',
    lastActivityAt: '2026-09-16T00:00:04.000Z',
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:04.000Z'
  },
  messages: [priorAssistant, currentAssistant],
  nextBeforeSequence: null
};

function HookHarness({ initial = running, onHistory }: { readonly initial?: AiRunSnapshot; readonly onHistory?: (history: ConversationHistoryResponse) => void }): React.JSX.Element {
  const timeline = useAiRunTimeline({
    snapshot: initial,
    projectId: PROJECT_ID,
    conversationId: CONVERSATION_ID,
    csrfToken: 'csrf-token',
    enabled: true,
    onConversationReconciled: onHistory
  });
  return (
    <div>
      <p data-testid="hook-status">{timeline.snapshot.status}</p>
      <p data-testid="hook-connection">{timeline.connection}</p>
      <p data-testid="hook-output">{timeline.assistantText}</p>
      {timeline.conversation?.messages.map((message) => <p key={message.id} data-testid={`history-${message.id}`}>{message.content}</p>)}
      <button type="button" data-testid="hook-cancel" disabled={timeline.cancelPending} onClick={timeline.cancel}>Cancel</button>
      <button type="button" data-testid="hook-refresh" onClick={timeline.refresh}>Refresh</button>
    </div>
  );
}

function eventPayload(type: string, sequence: number, payload: Record<string, unknown>): string {
  return JSON.stringify({ runId: RUN_ID, type, sequence, occurredAt: '2026-09-16T00:00:05.000Z', payload });
}

beforeEach(() => {
  ControlledEventSource.instances.length = 0;
  startAiRunMock.mockReset();
  cancelAiRunMock.mockReset();
  getAiRunMock.mockReset();
  getConversationMock.mockReset();
  vi.stubGlobal('EventSource', ControlledEventSource);
  getConversationMock.mockResolvedValue(history);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AiRunTimeline lifecycle', () => {
  it('shows one actionable failure message without repeating the status text', async () => {
    const message = 'NVIDIA rate or quota limit reached (HTTP 429). Wait before trying again.';
    const failed: AiRunSnapshot = { ...ready, status: 'failed', phase: 'terminal', safeMessage: message };
    getAiRunMock.mockResolvedValue(failed);
    render(<AiRunTimeline compact snapshot={failed} projectId={PROJECT_ID} conversationId={CONVERSATION_ID} csrfToken="csrf-token" />);
    expect(screen.getByRole('heading', { name: 'Assistant run failed' })).toBeInTheDocument();
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.queryByTestId('run-connection-status')).not.toBeInTheDocument();
    await waitFor(() => expect(getAiRunMock).toHaveBeenCalled());
  });
  it('keeps a completed compact answer in conversation history without repeating the stream', async () => {
    getAiRunMock.mockResolvedValue(succeeded);
    const onHistory = vi.fn();
    render(<AiRunTimeline compact snapshot={succeeded} projectId={PROJECT_ID} conversationId={CONVERSATION_ID} csrfToken="csrf-token" onConversationReconciled={onHistory} />);
    await waitFor(() => expect(onHistory).toHaveBeenCalledWith(history));
    await waitFor(() => expect(screen.queryByTestId('ai-run-timeline')).not.toBeInTheDocument());
    expect(screen.queryByTestId('assistant-stream')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Assistant response complete.');
  });

  it('does not construct EventSource while ready and subscribes after start confirms queued', async () => {
    let resolveStart: (snapshot: AiRunSnapshot) => void = () => undefined;
    startAiRunMock.mockReturnValue(new Promise<AiRunSnapshot>((resolve) => { resolveStart = resolve; }));

    render(<HookHarness initial={ready} />);
    await waitFor(() => expect(startAiRunMock).toHaveBeenCalledTimes(1));
    expect(ControlledEventSource.instances).toHaveLength(0);

    resolveStart({ ...ready, status: 'queued', phase: 'inference', safeMessage: 'Starting assistant run.' });
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(1));
  });

  it('keeps a start failure visible when REST still reports a ready run', async () => {
    startAiRunMock.mockRejectedValue(new Error('provider request unavailable'));
    getAiRunMock.mockResolvedValue(ready);

    render(<AiRunTimeline snapshot={ready} projectId={PROJECT_ID} conversationId={CONVERSATION_ID} csrfToken="csrf-token" />);

    await waitFor(() => expect(screen.getByTestId('ai-run-timeline-error')).toHaveTextContent('The assistant run could not be started'));
    expect(screen.getByTestId('run-connection-status')).toHaveTextContent('Sending approved context to NVIDIA NIM...');
  });

  it('moves focus to the timeline heading once after start, without stealing focus for deltas', async () => {
    let resolveStart: (snapshot: AiRunSnapshot) => void = () => undefined;
    startAiRunMock.mockReturnValue(new Promise<AiRunSnapshot>((resolve) => { resolveStart = resolve; }));
    render(<AiRunTimeline snapshot={ready} projectId={PROJECT_ID} conversationId={CONVERSATION_ID} csrfToken="csrf-token" />);
    const heading = screen.getByTestId('ai-run-timeline-heading');
    resolveStart({ ...ready, status: 'queued', phase: 'inference', safeMessage: 'Starting assistant run.' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const beforeDelta = document.activeElement;
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(1));
    ControlledEventSource.instances[0].emit('assistant.delta', eventPayload('assistant.delta', 1, { text: 'delta' }));
    await waitFor(() => expect(screen.getByTestId('ai-run-assistant-output')).toBeInTheDocument());
    expect(document.activeElement).toBe(beforeDelta);
  });

  it('reconciles a disconnect to the run-linked assistant and leaves prior answers untouched', async () => {
    getAiRunMock.mockResolvedValue(succeeded);
    const onHistory = vi.fn();
    render(<HookHarness onHistory={onHistory} />);
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(1));
    const source = ControlledEventSource.instances[0];
    source.emit('assistant.delta', eventPayload('assistant.delta', 1, { text: 'partial answer' }));
    source.emitError();

    await waitFor(() => expect(screen.getByTestId('hook-output')).toHaveTextContent('The current run answer.'));
    expect(screen.getByTestId('hook-output')).not.toHaveTextContent('An older run answer.');
    expect(screen.getAllByTestId('history-assistant-current')).toHaveLength(1);
    expect(onHistory).toHaveBeenCalledWith(history);
  });

  it('states which REST reconciliation read failed after an SSE disconnect', async () => {
    getAiRunMock.mockResolvedValue(running);
    getConversationMock.mockRejectedValue(new Error('conversation temporarily unavailable'));
    render(<AiRunTimeline snapshot={running} projectId={PROJECT_ID} conversationId={CONVERSATION_ID} csrfToken="csrf-token" />);
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(1));

    ControlledEventSource.instances[0].emitError();

    await waitFor(() => expect(screen.getByTestId('ai-run-disconnected')).toHaveTextContent('The saved run was refreshed, but the conversation could not be loaded'));
  });

  it('does not reopen EventSource after disconnect reconciliation until an explicit refresh', async () => {
    getAiRunMock.mockResolvedValue(running);
    render(<HookHarness />);
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(1));

    ControlledEventSource.instances[0].emitError();
    await waitFor(() => expect(screen.getByTestId('hook-connection')).toHaveTextContent('disconnected'));
    expect(ControlledEventSource.instances).toHaveLength(1);

    await userEvent.setup().click(screen.getByTestId('hook-refresh'));
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(2));
  });

  it('clears provisional output when a successful run has no persisted assistant message', async () => {
    getAiRunMock.mockResolvedValue({ ...succeeded, assistant: undefined });
    const emptyHistory: ConversationHistoryResponse = { ...history, messages: [priorAssistant] };
    getConversationMock.mockResolvedValue(emptyHistory);
    render(<HookHarness />);
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(1));
    ControlledEventSource.instances[0].emit('assistant.delta', eventPayload('assistant.delta', 1, { text: 'provisional answer' }));
    ControlledEventSource.instances[0].emitError();

    await waitFor(() => expect(screen.getByTestId('hook-output')).not.toHaveTextContent('provisional answer'));
    expect(screen.getByTestId('hook-output')).toHaveTextContent('');
    expect(screen.getByTestId('hook-output')).not.toHaveTextContent('An older run answer.');
  });

  it('keeps a terminal success when a delayed cancel response returns cancelled', async () => {
    let resolveCancel: (snapshot: AiRunSnapshot) => void = () => undefined;
    cancelAiRunMock.mockReturnValue(new Promise<AiRunSnapshot>((resolve) => { resolveCancel = resolve; }));
    getAiRunMock.mockResolvedValue(succeeded);
    render(<HookHarness />);
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(1));
    await userEvent.setup().click(screen.getByTestId('hook-cancel'));
    await waitFor(() => expect(screen.getByTestId('hook-cancel')).toBeDisabled());
    ControlledEventSource.instances[0].emit('run.completed', eventPayload('run.completed', 1, { status: 'succeeded', safeMessage: 'Assistant response complete.' }));
    await waitFor(() => expect(screen.getByTestId('hook-status')).toHaveTextContent('succeeded'));
    resolveCancel({ ...running, status: 'cancelled', phase: 'terminal', safeMessage: 'Run cancelled.' });

    await waitFor(() => expect(screen.getByTestId('hook-cancel')).not.toBeDisabled());
    expect(screen.getByTestId('hook-status')).toHaveTextContent('succeeded');
  });

  it('closes the single source on unmount and keeps full output out of aria-live', async () => {
    const view = render(<AiRunTimeline snapshot={running} projectId={PROJECT_ID} conversationId={CONVERSATION_ID} csrfToken="csrf-token" />);
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(1));
    const source = ControlledEventSource.instances[0];
    source.emit('assistant.delta', eventPayload('assistant.delta', 1, { text: 'safe output' }));
    await waitFor(() => expect(screen.getByTestId('ai-run-assistant-output')).toBeInTheDocument());
    expect(screen.getByTestId('ai-run-assistant-output')).not.toHaveAttribute('aria-live');
    expect(screen.getByTestId('ai-run-timeline-status')).toHaveAttribute('aria-live', 'polite');
    view.unmount();
    expect(source.closed).toBe(true);
  });

  it('announces a disconnect once through an actionable alert', async () => {
    getAiRunMock.mockResolvedValue(running);
    render(<AiRunTimeline snapshot={running} projectId={PROJECT_ID} conversationId={CONVERSATION_ID} csrfToken="csrf-token" />);
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(1));

    ControlledEventSource.instances[0].emitError();

    await waitFor(() => expect(screen.getByTestId('ai-run-disconnected')).toBeInTheDocument());
    expect(screen.getByTestId('ai-run-disconnected')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('ai-run-disconnected')).toHaveTextContent('The saved run and conversation were refetched');
    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });

  it('keeps cancellation uncertainty visible when the cancel request fails', async () => {
    cancelAiRunMock.mockRejectedValue(new Error('provider cancellation unavailable'));
    getAiRunMock.mockResolvedValue(running);
    render(<AiRunTimeline snapshot={running} projectId={PROJECT_ID} conversationId={CONVERSATION_ID} csrfToken="csrf-token" />);

    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(1));
    await userEvent.setup().click(screen.getByTestId('ai-run-cancel'));

    await waitFor(() => expect(screen.getByTestId('run-cancel-error')).toHaveTextContent('Cancellation could not be confirmed'));
    expect(screen.getByTestId('run-cancel-error-refresh')).toBeInTheDocument();
  });
});
