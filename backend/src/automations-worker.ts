import { EventEmitter } from 'node:events';
import type { DataSource } from 'typeorm';

import { createApplication } from '@/composition-root';
import type { ApplicationLifecycleMode } from '@/infrastructure/startup/application-lifecycle';
import { createLogger, type AppLogger } from '@/shared/logging/logger';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

interface AutomationWorkerApplication {
  readonly logger: Pick<AppLogger, 'info'>;
  readonly dataSource: Pick<DataSource, 'isInitialized' | 'destroy'>;
  stopMaintenance(): Promise<void>;
}

type ApplicationFactory = (
  environment: NodeJS.ProcessEnv,
  lifecycle: ApplicationLifecycleMode
) => Promise<AutomationWorkerApplication>;

export async function startAutomationWorker(
  applicationFactory: ApplicationFactory = createApplication,
  waitForSignal: () => Promise<ShutdownSignal> = waitForShutdownSignal
): Promise<void> {
  const application = await applicationFactory(process.env, 'automation-worker');
  try {
    const signal = await waitForSignal();
    application.logger.info({ signal }, 'Shutting down automation worker');
  } finally {
    try {
      await application.stopMaintenance();
    } finally {
      if (application.dataSource.isInitialized) {
        await application.dataSource.destroy();
      }
    }
  }
}

export function waitForShutdownSignal(signalSource: EventEmitter = process): Promise<ShutdownSignal> {
  return new Promise((resolve) => {
    const finish = (signal: ShutdownSignal): void => {
      signalSource.removeListener('SIGINT', onSigint);
      signalSource.removeListener('SIGTERM', onSigterm);
      resolve(signal);
    };
    const onSigint = (): void => finish('SIGINT');
    const onSigterm = (): void => finish('SIGTERM');
    signalSource.once('SIGINT', onSigint);
    signalSource.once('SIGTERM', onSigterm);
  });
}

if (require.main === module) {
  const logger = createLogger(process.env.LOG_LEVEL ?? 'error');
  void startAutomationWorker().catch((error: unknown) => {
    logger.error({ error }, 'Automation worker failed');
    process.exitCode = 1;
  });
}
