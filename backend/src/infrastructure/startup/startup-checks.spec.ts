import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DataSource } from 'typeorm';

import { runStartupChecks, type StartupCheckOptions } from '@/infrastructure/startup/startup-checks';
import { StartupChecksError } from '@/shared/errors/app-error';

describe('runStartupChecks', () => {
  let workspaceDirectory: string;
  let dataSource: DataSource;

  beforeEach(async () => {
    workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), 'pai-startup-'));
    await writeFile(path.join(workspaceDirectory, 'identity'), 'fixture-identity\n', 'utf8');
    dataSource = {
      query: jest.fn().mockResolvedValue([{ result: 1 }]),
      showMigrations: jest.fn().mockResolvedValue(false)
    } as unknown as DataSource;

  });

  afterEach(async () => {
    await rm(workspaceDirectory, { recursive: true, force: true });
  });

  function options(overrides: Partial<StartupCheckOptions> = {}): StartupCheckOptions {
    return {
      dataSource,
      workspaceRoot: workspaceDirectory,
      workspaceIdentityFile: path.join(workspaceDirectory, 'identity'),
      workspaceIdentity: 'fixture-identity',
      ...overrides
    };
  }

  it('starts local features with only the database and verified workspace, without an AI probe', async () => {
    await expect(runStartupChecks(options())).resolves.toBeUndefined();
    expect(dataSource.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('fails closed on a workspace identity mismatch', async () => {
    await expect(runStartupChecks(options({ workspaceIdentity: 'different' }))).rejects.toMatchObject({
      failures: expect.arrayContaining([
        expect.objectContaining({ check: 'workspace', code: 'WORKSPACE_IDENTITY_MISMATCH' })
      ])
    });
  });

  it('still refuses startup with pending database migrations', async () => {
    (dataSource.showMigrations as jest.Mock).mockResolvedValue(true);
    await expect(runStartupChecks(options())).rejects.toMatchObject({
      failures: [expect.objectContaining({ check: 'database', code: 'DATABASE_MIGRATIONS_PENDING' })]
    });
  });

  it('fails closed when the marker cannot be read', async () => {
    await rm(path.join(workspaceDirectory, 'identity'));
    await expect(runStartupChecks(options())).rejects.toMatchObject({
      failures: expect.arrayContaining([
        expect.objectContaining({ check: 'workspace', code: 'WORKSPACE_IDENTITY_UNAVAILABLE' })
      ])
    });
  });
});
