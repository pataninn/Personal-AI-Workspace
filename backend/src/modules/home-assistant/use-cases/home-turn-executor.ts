import { setTimeout as delay } from 'node:timers/promises';
import type { ProcessHomeTurnUseCase } from '@/modules/home-assistant/use-cases/process-home-turn';
import type { CancelHomeTurnUseCase } from '@/modules/home-assistant/use-cases/cancel-home-turn';

export interface HomeTurnIdentity {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly turnId: string;
}

/** Owns interactive turns independently of browser polling; scheduled turns use the scheduler. */
export class HomeTurnExecutor {
  private readonly active = new Map<string, { input: HomeTurnIdentity; abort: AbortController; task: Promise<void> }>();
  private stopped = false;

  public constructor(private readonly dependencies: {
    readonly process: Pick<ProcessHomeTurnUseCase, 'execute'>;
    readonly cancel: Pick<CancelHomeTurnUseCase, 'execute'>;
    readonly onError: (turnId: string) => void;
  }) {}

  public start(input: HomeTurnIdentity): void {
    if (this.stopped || this.active.has(input.turnId)) return;
    const abort = new AbortController();
    const task = this.run(input, abort.signal).catch(async () => {
      this.dependencies.onError(input.turnId);
      try {
        await this.dependencies.cancel.execute(input);
        await this.dependencies.process.execute(input);
      }
      catch { this.dependencies.onError(input.turnId); }
    }).finally(() => { this.active.delete(input.turnId); });
    this.active.set(input.turnId, { input, abort, task });
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    const active = [...this.active.values()];
    for (const item of active) item.abort.abort();
    await Promise.all(active.map(async (item) => {
      try { await this.dependencies.cancel.execute(item.input); }
      catch { this.dependencies.onError(item.input.turnId); }
      await item.task;
      try { await this.dependencies.process.execute(item.input); }
      catch { this.dependencies.onError(item.input.turnId); }
    }));
  }

  private async run(input: HomeTurnIdentity, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const turn = await this.dependencies.process.execute(input);
      if (turn.status !== 'running') return;
      try { await delay(100, undefined, { signal }); }
      catch (error: unknown) { if (!signal.aborted) throw error; }
    }
  }
}
