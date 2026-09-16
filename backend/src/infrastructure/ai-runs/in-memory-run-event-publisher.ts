import { randomUUID } from 'node:crypto';

import type {
  IRunEventPublisher,
  PublishRunEventInput,
  RunEvent,
  RunEventListener
} from '@/modules/ai-runs/repositories/run-event-publisher';

export class InMemoryRunEventPublisher implements IRunEventPublisher {
  private readonly listeners = new Map<string, Set<RunEventListener>>();
  private readonly sequences = new Map<string, number>();

  public publish(input: PublishRunEventInput): RunEvent {
    const sequence = (this.sequences.get(input.runId) ?? 0) + 1;
    this.sequences.set(input.runId, sequence);
    const event: RunEvent = {
      runId: input.runId,
      type: input.type,
      sequence,
      occurredAt: new Date(),
      payload: { ...input.payload, eventId: randomUUID() }
    };
    for (const listener of this.listeners.get(input.runId) ?? []) {
      listener(event);
    }
    if (isTerminalEvent(input.type)) {
      // MVP1 has no durable replay. Once a terminal frame has been delivered,
      // release the process-local sequence/listener state instead of retaining
      // one entry for every completed run.
      this.sequences.delete(input.runId);
      this.listeners.delete(input.runId);
    }
    return event;
  }

  public subscribe(runId: string, listener: RunEventListener): () => void {
    const current = this.listeners.get(runId) ?? new Set<RunEventListener>();
    current.add(listener);
    this.listeners.set(runId, current);
    return () => {
      const listeners = this.listeners.get(runId);
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        this.listeners.delete(runId);
      }
    };
  }
}

function isTerminalEvent(type: PublishRunEventInput['type']): boolean {
  return type === 'run.completed'
    || type === 'run.failed'
    || type === 'run.blocked'
    || type === 'run.cancelled'
    || type === 'run.needs_manual_review';
}
