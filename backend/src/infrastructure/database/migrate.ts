import { loadDatabaseConfig } from '@/infrastructure/config/database-config';
import { createDataSource } from '@/infrastructure/database/data-source';
import { createLogger } from '@/shared/logging/logger';

export async function runMigrations(): Promise<void> {
  const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
  const dataSource = createDataSource(loadDatabaseConfig());

  try {
    await dataSource.initialize();
    const migrations = await dataSource.runMigrations({ transaction: 'all' });
    logger.info({ migrationCount: migrations.length }, 'Database migrations completed');
  } catch (error: unknown) {
    logger.error({ error }, 'Database migrations failed');
    throw error;
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

void runMigrations().catch(() => {
  process.exitCode = 1;
});
