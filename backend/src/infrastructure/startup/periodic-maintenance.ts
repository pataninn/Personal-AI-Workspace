export interface PeriodicMaintenanceTask {
  run(): Promise<number>;
}

export interface PeriodicMaintenanceLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface PeriodicMaintenanceHandle {
  stop(): Promise<void>;
}

/** Runs a cleanup once at startup and then periodically without overlapping sweeps. */
export async function startPeriodicMaintenance(options: {
  readonly task: PeriodicMaintenanceTask;
  readonly logger: PeriodicMaintenanceLogger;
  readonly intervalMs: number;
  readonly operationName: string;
}): Promise<PeriodicMaintenanceHandle> {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new TypeError('A maintenance interval must be a positive safe integer.');
  }

  let stopped = false;
  let running: Promise<void> | null = null;

  const execute = async (): Promise<void> => {
    if (stopped || running) return running ?? Promise.resolve();
    running = (async () => {
      try {
        await options.task.run();
      } catch (error: unknown) {
        options.logger.warn({ error, operation: options.operationName }, 'A background maintenance pass failed; it will retry on the next interval.');
      }
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  };

  await execute();
  const timer = setInterval(() => { void execute(); }, options.intervalMs);
  timer.unref?.();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (running) await running;
    }
  };
}
