import { PhysicalStorageSpaceMonitor, type PhysicalStorageFileSystem, type PhysicalStorageMonitorLogger } from '@/infrastructure/startup/physical-storage-space-monitor';

describe('PhysicalStorageSpaceMonitor', () => {
  it('uses process-visible bigint capacity and logs only low-space state transitions', async () => {
    const { fileSystem, setCapacity } = createFileSystem();
    const logger = createLogger();
    const monitor = new PhysicalStorageSpaceMonitor({
      roots: [{ volume: 'legacy_workspace', path: '/workspace' }],
      warningFreeBytes: 500n,
      logger,
      fileSystem
    });

    setCapacity(4n, 100n);
    await monitor.observe();
    await monitor.observe();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith({ volume: 'legacy_workspace', availableBytes: '400', warningFreeBytes: '500' }, expect.any(String));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('/workspace');

    setCapacity(6n, 100n);
    await monitor.observe();
    expect(logger.info).toHaveBeenCalledWith({ volume: 'legacy_workspace', availableBytes: '600' }, expect.any(String));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('treats an untrusted mount as unknown and logs only its recovery transition', async () => {
    const { fileSystem } = createFileSystem();
    const logger = createLogger();
    let trusted = false;
    const monitor = new PhysicalStorageSpaceMonitor({
      roots: [{ volume: 'managed_workspaces', path: '/account-workspaces', isTrusted: async () => trusted }],
      warningFreeBytes: 10n,
      logger,
      fileSystem
    });

    await monitor.observe();
    await monitor.observe();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith({ volume: 'managed_workspaces', state: 'unavailable' }, expect.any(String));
    expect(fileSystem.lstat).not.toHaveBeenCalled();
    expect(fileSystem.statfs).not.toHaveBeenCalled();

    trusted = true;
    await monitor.observe();
    expect(logger.info).toHaveBeenCalledWith({ volume: 'managed_workspaces', state: 'available' }, expect.any(String));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not stat a reparse root and reports unavailable without disclosing its path', async () => {
    const { fileSystem } = createFileSystem({ symbolicLink: true });
    const logger = createLogger();
    const monitor = new PhysicalStorageSpaceMonitor({
      roots: [{ volume: 'recovery', path: 'C:\\private\\recovery' }],
      logger,
      fileSystem
    });

    await monitor.observe();
    expect(fileSystem.statfs).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('C:\\private\\recovery');
  });

  it('treats statfs failure as unknown and logs only the unavailable/recovered transitions', async () => {
    const { fileSystem } = createFileSystem();
    const logger = createLogger();
    const monitor = new PhysicalStorageSpaceMonitor({
      roots: [{ volume: 'recovery', path: '/recovery' }],
      warningFreeBytes: 100n,
      logger,
      fileSystem
    });
    fileSystem.statfs.mockRejectedValueOnce(new Error('private mount detail'));

    await monitor.observe();
    await monitor.observe();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith({ volume: 'recovery', state: 'unavailable' }, expect.any(String));
    expect(logger.info).toHaveBeenCalledWith({ volume: 'recovery', state: 'available' }, expect.any(String));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private mount detail');
  });

  it('observes capacity without raising low-space alerts when no threshold is configured', async () => {
    const { fileSystem, setCapacity } = createFileSystem();
    const logger = createLogger();
    const monitor = new PhysicalStorageSpaceMonitor({
      roots: [{ volume: 'recovery', path: '/recovery' }],
      logger,
      fileSystem
    });
    setCapacity(0n, 4096n);

    await monitor.observe();

    expect(fileSystem.statfs).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  function createLogger(): jest.Mocked<PhysicalStorageMonitorLogger> {
    return { warn: jest.fn(), info: jest.fn() };
  }

  function createFileSystem(input: { readonly symbolicLink?: boolean } = {}): {
    readonly fileSystem: jest.Mocked<PhysicalStorageFileSystem>;
    setCapacity(availableBlocks: bigint, blockSize: bigint): void;
  } {
    let bavail = 8n;
    let bsize = 1024n;
    const fileSystem: jest.Mocked<PhysicalStorageFileSystem> = {
      lstat: jest.fn().mockResolvedValue({
        isDirectory: () => !input.symbolicLink,
        isSymbolicLink: () => input.symbolicLink === true,
        isReparsePoint: () => input.symbolicLink === true
      }),
      realpath: jest.fn(async (filePath: string) => filePath),
      statfs: jest.fn(async (_filePath: string) => ({ bavail, bsize }))
    };
    return {
      fileSystem,
      setCapacity(availableBlocks, blockSize) { bavail = availableBlocks; bsize = blockSize; }
    };
  }
});
