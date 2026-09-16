import { InMemoryRunEventPublisher } from '@/infrastructure/ai-runs/in-memory-run-event-publisher';

describe('InMemoryRunEventPublisher', () => {
  it('evicts terminal sequence and listener state after delivery', () => {
    const publisher = new InMemoryRunEventPublisher();
    const received: number[] = [];
    publisher.subscribe('run-1', (event) => { received.push(event.sequence); });

    publisher.publish({ runId: 'run-1', type: 'run.started', payload: { status: 'running' } });
    publisher.publish({ runId: 'run-1', type: 'run.completed', payload: { status: 'succeeded' } });

    expect(received).toEqual([1, 2]);
    expect((publisher as unknown as { sequences: Map<string, number> }).sequences.has('run-1')).toBe(false);
    expect((publisher as unknown as { listeners: Map<string, Set<unknown>> }).listeners.has('run-1')).toBe(false);
  });
});
