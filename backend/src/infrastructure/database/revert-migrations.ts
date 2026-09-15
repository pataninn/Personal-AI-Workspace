import { loadDatabaseConfig } from '@/infrastructure/config/database-config';
import { createDataSource } from '@/infrastructure/database/data-source';
import { createLogger } from '@/shared/logging/logger';

export async function revertMigration(): Promise<void> {
  const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
  const dataSource = createDataSource(loadDatabaseConfig());

  try {
    await dataSource.initialize();
    await dataSource.undoLastMigration();
    logger.info('Last database migration reverted');
  } catch (error: unknown) {
    logger.error({ error }, 'Database migration revert failed');
    throw error;
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

void revertMigration().catch(() => {
  process.exitCode = 1;
});
