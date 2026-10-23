import { EventEmitter } from 'node:events';
import type { DataSource } from 'typeorm';
import { AppError } from '@/shared/errors/app-error';

const APPLICATION_LOCK_KEY = 1_804_410;

/** Holds one database connection so only one process can recover and execute work. */
export async function acquireApplicationLock(
  dataSource: DataSource,
  onConnectionLost: () => void
): Promise<{ release(): Promise<void> }> {
  const runner = dataSource.createQueryRunner();
  let connection: unknown;
  let released = false;
  const lost = (): void => { if (!released) onConnectionLost(); };
  try {
    connection = await runner.connect();
    if (!(connection instanceof EventEmitter)) {
      throw new AppError('APPLICATION_LOCK_UNAVAILABLE', 503, 'Application ownership cannot be verified.');
    }
    connection.on('error', lost);
    connection.on('end', lost);
    const rows: readonly { acquired: boolean }[] = await runner.query(
      'SELECT pg_try_advisory_lock($1) AS acquired', [APPLICATION_LOCK_KEY]
    );
    if (rows[0]?.acquired !== true) {
      throw new AppError('APPLICATION_ALREADY_RUNNING', 503, 'Another application process is already using this database. Stop it before starting this one.');
    }
  } catch (error: unknown) {
    released = true;
    if (connection instanceof EventEmitter) {
      connection.removeListener('error', lost);
      connection.removeListener('end', lost);
    }
    await runner.release();
    throw error;
  }
  return {
    release: async () => {
      if (released) return;
      released = true;
      try { await runner.query('SELECT pg_advisory_unlock($1)', [APPLICATION_LOCK_KEY]); }
      finally {
        if (connection instanceof EventEmitter) {
          connection.removeListener('error', lost);
          connection.removeListener('end', lost);
        }
        await runner.release();
      }
    }
  };
}
