import type { HomeTurn } from '@/modules/home-assistant/domain/home-conversation-types';
import type { CancelHomeTurnUseCase } from '@/modules/home-assistant/use-cases/cancel-home-turn';
import { HomeTurnExecutor } from '@/modules/home-assistant/use-cases/home-turn-executor';

const input = { ownerId: 'owner', conversationId: 'conversation', turnId: 'turn' };

describe('Home turn execution', () => {
  it('advances and completes an accepted turn without any browser status reads', async () => {
    let finish: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    let calls = 0;
    const process = { execute: jest.fn(async () => {
      calls += 1;
      if (calls === 2) finish?.();
      return { status: calls === 1 ? 'running' : 'completed' } as HomeTurn;
    }) };
    const cancel = { execute: jest.fn() } as unknown as Pick<CancelHomeTurnUseCase, 'execute'>;
    const executor = new HomeTurnExecutor({ process, cancel, onError: jest.fn() });
    executor.start(input);
    executor.start(input);
    await completed;
    await new Promise((resolve) => setImmediate(resolve));
    await executor.stop();
    expect(process.execute).toHaveBeenCalledTimes(2);
    expect(cancel.execute).not.toHaveBeenCalled();
  });

  it('cancels owned work on shutdown and refuses new work', async () => {
    const process = { execute: jest.fn(async () => ({ status: 'running' } as HomeTurn)) };
    const cancel = { execute: jest.fn(async () => undefined) } as unknown as Pick<CancelHomeTurnUseCase, 'execute'>;
    const executor = new HomeTurnExecutor({ process, cancel, onError: jest.fn() });
    executor.start(input);
    await executor.stop();
    executor.start({ ...input, turnId: 'later' });
    expect(cancel.execute).toHaveBeenCalledWith(input);
    expect(process.execute).toHaveBeenCalledTimes(2);
  });

  it('records processing failures and attempts cancellation rather than abandoning a live run', async () => {
    const process = { execute: jest.fn().mockRejectedValue(new Error('bridge failed')) };
    const cancel = { execute: jest.fn(async () => undefined) } as unknown as Pick<CancelHomeTurnUseCase, 'execute'>;
    const onError = jest.fn();
    const executor = new HomeTurnExecutor({ process, cancel, onError });
    executor.start(input);
    await new Promise((resolve) => setImmediate(resolve));
    await executor.stop();
    expect(onError).toHaveBeenCalledWith(input.turnId);
    expect(cancel.execute).toHaveBeenCalledTimes(1);
  });
});
