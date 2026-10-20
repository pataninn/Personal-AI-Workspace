import { EventEmitter } from 'node:events';

import { startAutomationWorker, waitForShutdownSignal } from '@/automations-worker';
import type { ApplicationLifecycleMode } from '@/infrastructure/startup/application-lifecycle';
import type { AppLogger } from '@/shared/logging/logger';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('startAutomationWorker', () => {
  it('accepts one shutdown signal and removes both listeners', async () => {
    const signals = new EventEmitter();
    const shutdown = waitForShutdownSignal(signals);

    signals.emit('SIGTERM');

    await expect(shutdown).resolves.toBe('SIGTERM');
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('uses worker-only composition and drains before closing the database', async () => {
    const stopStarted = deferred<void>();
    const releaseStop = deferred<void>();
    const dataSource = { isInitialized: true, destroy: jest.fn().mockResolvedValue(undefined) };
    const application = {
      logger: { info: jest.fn() } as Pick<AppLogger, 'info'>,
      dataSource,
      stopMaintenance: jest.fn(() => {
        stopStarted.resolve();
        return releaseStop.promise;
      })
    };
    const factory = jest.fn(async (_environment: NodeJS.ProcessEnv, _mode: ApplicationLifecycleMode) => application);

    const stopping = startAutomationWorker(factory, async () => 'SIGTERM');
    await stopStarted.promise;

    expect(factory).toHaveBeenCalledWith(process.env, 'automation-worker');
    expect(dataSource.destroy).not.toHaveBeenCalled();
    expect(application.logger.info).toHaveBeenCalledWith({ signal: 'SIGTERM' }, 'Shutting down automation worker');

    releaseStop.resolve();
    await stopping;

    expect(dataSource.destroy).toHaveBeenCalledTimes(1);
  });

  it('closes an initialized database if waiting for shutdown fails', async () => {
    const dataSource = { isInitialized: true, destroy: jest.fn().mockResolvedValue(undefined) };
    const application = {
      logger: { info: jest.fn() } as Pick<AppLogger, 'info'>,
      dataSource,
      stopMaintenance: jest.fn().mockResolvedValue(undefined)
    };
    const factory = jest.fn(async (_environment: NodeJS.ProcessEnv, _mode: ApplicationLifecycleMode) => application);

    await expect(startAutomationWorker(factory, async () => { throw new Error('signal wait failed'); }))
      .rejects.toThrow('signal wait failed');

    expect(application.stopMaintenance).toHaveBeenCalledTimes(1);
    expect(dataSource.destroy).toHaveBeenCalledTimes(1);
  });
});
