import { EventEmitter } from 'node:events';
import type { DataSource } from 'typeorm';
import { acquireApplicationLock } from '@/infrastructure/startup/application-lock';

function fixture(acquired: boolean) {
  const connection = new EventEmitter();
  const runner = { connect: jest.fn(async () => connection), query: jest.fn(async () => [{ acquired }]), release: jest.fn(async () => undefined) };
  const dataSource = { createQueryRunner: () => runner } as unknown as DataSource;
  return { connection, runner, dataSource };
}

describe('application ownership', () => {
  it('refuses a second process before it can recover live work', async () => {
    const { dataSource, runner } = fixture(false);
    await expect(acquireApplicationLock(dataSource, jest.fn())).rejects.toMatchObject({ code: 'APPLICATION_ALREADY_RUNNING' });
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('holds the connection until release and stops execution if ownership is lost', async () => {
    const { dataSource, runner, connection } = fixture(true);
    const lost = jest.fn();
    const lock = await acquireApplicationLock(dataSource, lost);
    expect(runner.release).not.toHaveBeenCalled();
    connection.emit('end');
    expect(lost).toHaveBeenCalledTimes(1);
    await lock.release();
    await lock.release();
    expect(runner.release).toHaveBeenCalledTimes(1);
    connection.emit('end');
    expect(lost).toHaveBeenCalledTimes(1);
  });
});
