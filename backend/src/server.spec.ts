import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createApplication, type Application } from '@/composition-root';
import { startServer } from '@/server';

jest.mock('node:http', () => ({ createServer: jest.fn() }));
jest.mock('@/composition-root', () => ({ createApplication: jest.fn() }));

describe('application listener lifecycle', () => {
  const signalListeners = new Map<string, () => void>();
  let order: string[];
  let application: Application;

  beforeEach(() => {
    order = [];
    signalListeners.clear();
    application = {
      app: jest.fn(),
      config: { protocol: 'http', allowInsecureHttp: true, port: 1234, host: '127.0.0.1' },
      stopMaintenance: jest.fn(async () => { order.push('drain'); }),
      dataSource: { isInitialized: true, destroy: jest.fn(async () => { order.push('database'); }) },
      logger: { info: jest.fn(), error: jest.fn() }
    } as unknown as Application;
    jest.mocked(createApplication).mockResolvedValue(application);
    jest.spyOn(process, 'once').mockImplementation((event, listener) => {
      signalListeners.set(String(event), listener);
      return process;
    });
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('releases background ownership and the database when the port is occupied', async () => {
    const server = Object.assign(new EventEmitter(), {
      listen: jest.fn(() => { server.emit('error', new Error('address in use')); })
    });
    jest.mocked(createServer).mockReturnValue(server as unknown as ReturnType<typeof createServer>);
    await expect(startServer()).rejects.toThrow('address in use');
    expect(order).toEqual(['drain', 'database']);
  });

  it('cleans up when listener configuration fails after application startup', async () => {
    jest.mocked(createApplication).mockResolvedValue({ ...application,
      config: { ...application.config, protocol: 'https' }
    });
    await expect(startServer()).rejects.toThrow('HTTPS certificate configuration is missing');
    expect(order).toEqual(['drain', 'database']);
  });

  it('closes requests before draining execution and handles repeated shutdown signals once', async () => {
    const server = Object.assign(new EventEmitter(), {
      listen: jest.fn((_port: number, _host: string, ready: () => void) => { ready(); }),
      close: jest.fn((closed: () => void) => { order.push('http'); closed(); })
    });
    jest.mocked(createServer).mockReturnValue(server as unknown as ReturnType<typeof createServer>);
    await startServer();
    signalListeners.get('SIGTERM')?.();
    signalListeners.get('SIGINT')?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['http', 'drain', 'database']);
  });
});
