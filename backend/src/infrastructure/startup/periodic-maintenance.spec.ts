import { startPeriodicMaintenance } from '@/infrastructure/startup/periodic-maintenance';

describe('startPeriodicMaintenance', () => {
  afterEach(() => jest.useRealTimers());

  it('runs immediately and periodically without overlapping passes, then stops cleanly', async () => {
    jest.useFakeTimers();
    let releaseSecond: (() => void) | undefined;
    const task = { run: jest.fn()
      .mockResolvedValueOnce(0)
      .mockImplementationOnce(() => new Promise<number>((resolve) => { releaseSecond = () => resolve(0); }))
      .mockResolvedValue(0) };
    const logger = { warn: jest.fn() };

    const handle = await startPeriodicMaintenance({ task, logger, intervalMs: 1000, operationName: 'test sweep' });
    expect(task.run).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1000);
    expect(task.run).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1000);
    expect(task.run).toHaveBeenCalledTimes(2);

    const stopping = handle.stop();
    releaseSecond?.();
    await stopping;
    await jest.advanceTimersByTimeAsync(5000);
    expect(task.run).toHaveBeenCalledTimes(2);
  });

  it('logs failures without preventing the next sweep', async () => {
    jest.useFakeTimers();
    const task = { run: jest.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(0) };
    const logger = { warn: jest.fn() };

    const handle = await startPeriodicMaintenance({ task, logger, intervalMs: 1000, operationName: 'test sweep' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(task.run).toHaveBeenCalledTimes(2);
    await handle.stop();
  });
});
