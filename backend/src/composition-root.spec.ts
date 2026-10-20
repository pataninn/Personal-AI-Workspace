import type { DataSource } from 'typeorm';

import { createApplication } from '@/composition-root';
import { loadConfig, type AppConfig } from '@/infrastructure/config/app-config';
import { createDataSource } from '@/infrastructure/database/data-source';
import { runStartupChecks } from '@/infrastructure/startup/startup-checks';

jest.mock('@/infrastructure/config/app-config', () => ({ loadConfig: jest.fn() }));
jest.mock('@/infrastructure/database/data-source', () => ({ createDataSource: jest.fn() }));
jest.mock('@/infrastructure/startup/startup-checks', () => ({ runStartupChecks: jest.fn() }));

describe('createApplication startup cleanup', () => {
  it('destroys an initialized database when startup validation fails', async () => {
    const failure = new Error('startup validation failed');
    let initialized = false;
    const dataSource = {
      get isInitialized(): boolean { return initialized; },
      initialize: jest.fn(async () => { initialized = true; return dataSource; }),
      destroy: jest.fn(async () => { initialized = false; })
    } as unknown as DataSource;
    const config = {
      logLevel: 'silent',
      database: {},
      agentRuntimeMode: 'fake',
      workspaceRoot: 'C:\\workspace',
      workspaceIdentityFile: 'C:\\workspace\\identity',
      workspaceIdentity: 'test-identity',
      nimProfile: 'test-provider',
      nimModel: 'test-model'
    } as unknown as AppConfig;

    jest.mocked(loadConfig).mockReturnValue(config);
    jest.mocked(createDataSource).mockReturnValue(dataSource);
    jest.mocked(runStartupChecks).mockRejectedValue(failure);

    await expect(createApplication({}, 'automation-worker')).rejects.toBe(failure);

    expect(dataSource.initialize).toHaveBeenCalledTimes(1);
    expect(dataSource.destroy).toHaveBeenCalledTimes(1);
    expect(dataSource.isInitialized).toBe(false);
  });
});
