import { DataSource } from 'typeorm';
import { acquireApplicationLock } from '@/infrastructure/startup/application-lock';

const databaseUrl = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;
if (databaseUrl) {
  const target = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(target.hostname)
    || target.port !== '55441' || target.pathname !== '/home_history_test' || target.username !== 'home_test') {
    throw new Error('Application ownership tests require home_test/home_history_test on loopback port 55441.');
  }
}

(databaseUrl ? describe : describe.skip)('PostgreSQL application ownership', () => {
  it('excludes a second process and transfers ownership only after release', async () => {
    if (!databaseUrl) throw new Error('A disposable test database is required.');
    const first = new DataSource({ type: 'postgres', url: databaseUrl });
    const second = new DataSource({ type: 'postgres', url: databaseUrl });
    let ownership: Awaited<ReturnType<typeof acquireApplicationLock>> | undefined;
    try {
      await first.initialize();
      await second.initialize();
      ownership = await acquireApplicationLock(first, jest.fn());
      await expect(acquireApplicationLock(second, jest.fn())).rejects.toMatchObject({ code: 'APPLICATION_ALREADY_RUNNING' });
      await ownership.release();
      ownership = await acquireApplicationLock(second, jest.fn());
    } finally {
      await ownership?.release();
      if (first.isInitialized) await first.destroy();
      if (second.isInitialized) await second.destroy();
    }
  });
});
